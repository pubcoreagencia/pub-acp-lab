const { EventEmitter } = require('events');
const path = require('path');
const { IsolatedBrowserManager } = require('../isolated-browser/browser-manager.js');
const { ChatGptDriver } = require('../isolated-browser/chatgpt-driver.js');

const { SessionState, SessionRecord } = require('./session-lifecycle.js');
const { ErrorCodes, ErrorCategory, TransportError, classifyError } = require('./failure-taxonomy.js');
const { TimeoutPolicy } = require('./timeout-policy.js');
const { IdempotencyManager } = require('./idempotency-manager.js');
const { TransportObservability } = require('./observability.js');
const { RecoveryManager } = require('./recovery-manager.js');

/**
 * ChatGptTransportAdapter (Phase 7.3):
 * Provides a reliable, observable, idempotent and auto-recovering local transport
 * to real ChatGPT Free via an isolated Chrome profile and native WebSocket CDP.
 */
class ChatGptTransportAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 9555;
    this.profileDir = options.profileDir || path.resolve(process.cwd(), 'isolated_profile');
    this.chromePath = options.chromePath || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    this.defaultTimeoutMs = options.defaultTimeoutMs || TimeoutPolicy.DEFAULT_TIMEOUT_MS;
    this.backend = options.backend || null;
    this.browserManager = options.browserManager || null;
    this.driver = null;
    this.isInitialized = !!this.backend;

    // Phase 7.3 Core Subsystems
    this.sessions = new Map(); // sessionId -> SessionRecord
    this.activeSessionId = null;
    this.isProcessing = false;
    this.maxRetryAttempts = options.maxRetryAttempts !== undefined ? options.maxRetryAttempts : 2;

    this.idempotency = new IdempotencyManager();
    this.observability = new TransportObservability(this);
    this.recovery = new RecoveryManager(this);
  }

  /**
   * Initializes the browser manager, establishes CDP connection,
   * verifies authentication, and ensures the window stays minimized.
   */
  async initialize() {
    if (this.backend) {
      if (typeof this.backend.initialize === 'function') {
        await this.backend.initialize();
      }
      this.isInitialized = true;
      this.observability.emitEvent('TRANSPORT_INITIALIZED', {
        state: 'READY',
        details: { type: 'injected_backend' }
      });
      return { status: 'ready', type: 'injected_backend' };
    }

    if (this.isInitialized && this.browserManager && this.driver) {
      return { status: 'ready', port: this.port };
    }

    try {
      if (!this.browserManager) {
        this.browserManager = new IsolatedBrowserManager({
          port: this.port,
          profileDir: this.profileDir,
          chromePath: this.chromePath
        });
      }

      this.observability.emitEvent('CONNECTING_BROWSER', {
        details: { port: this.port }
      });

      await this.browserManager.launch();

      // If browser is already connected and authenticated, reuse directly
      const currentUrl = (this.browserManager && this.browserManager.pageTarget) ? this.browserManager.pageTarget.url : '';
      let auth = null;
      if (currentUrl.includes('chatgpt.com')) {
        auth = await this.browserManager.detectAuthState();
      }

      if (!auth || !auth.isLoggedIn) {
        if (!currentUrl.includes('chatgpt.com') || currentUrl === 'about:blank') {
          await this.browserManager.navigate('https://chatgpt.com');
          await new Promise(r => setTimeout(r, 2000));
        }
        auth = await this.browserManager.detectAuthState();
      }

      if (!auth || !auth.isLoggedIn) {
        throw new TransportError(
          ErrorCodes.CHATGPT_UNAVAILABLE,
          'ChatGPT session is not authenticated. Please log in first in the dedicated profile.'
        );
      }

      await this.browserManager.minimize();
      this.driver = new ChatGptDriver(this.browserManager.cdp);
      this.isInitialized = true;

      this.observability.emitEvent('TRANSPORT_INITIALIZED', {
        state: 'READY',
        details: { port: this.port }
      });

      return { status: 'ready', port: this.port };
    } catch (err) {
      this.observability.emitEvent('TRANSPORT_INIT_FAILED', {
        errorClassification: err.code || ErrorCodes.BROWSER_UNAVAILABLE,
        details: { message: err.message }
      });
      this.emit('error', err);
      if (err instanceof TransportError) throw err;
      throw new TransportError(
        ErrorCodes.BROWSER_UNAVAILABLE,
        `Failed to initialize isolated browser: ${err.message}`
      );
    }
  }

  /**
   * Main programmatic dispatch method with Bounded Retry, Idempotency & Auto-Recovery.
   */
  async send(req = {}) {
    const startTime = Date.now();
    const requestId = req.request_id || req.requestId || `req-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const timeoutMs = TimeoutPolicy.resolveTimeout(req.timeout_ms || req.timeoutMs || this.defaultTimeoutMs);

    // 1. Validation
    if (!req || typeof req !== 'object') {
      return this._formatError(requestId, null, ErrorCodes.INVALID_REQUEST, 'Request payload must be an object');
    }

    const promptText = req.prompt;
    if (!promptText || typeof promptText !== 'string' || !promptText.trim()) {
      return this._formatError(requestId, null, ErrorCodes.INVALID_REQUEST, 'Prompt text is required and cannot be empty');
    }

    // 2. Idempotency Check
    const idempStatus = this.idempotency.check(requestId);
    if (idempStatus.status === 'COMPLETED' && idempStatus.record) {
      this.observability.emitEvent('IDEMPOTENT_CACHE_HIT', {
        requestId,
        sessionId: idempStatus.record.session_id,
        durationMs: 0,
        result: 'cached_completed'
      });
      return idempStatus.record;
    }

    if (idempStatus.status === 'IN_FLIGHT') {
      return this._formatError(
        requestId,
        req.session_id || null,
        ErrorCodes.REQUEST_IN_FLIGHT,
        `Request ${requestId} is already currently executing in-flight.`
      );
    }

    // Register in-flight idempotency
    this.idempotency.registerInFlight(requestId, { prompt: promptText.slice(0, 50) });

    // 3. Ensure transport is initialized
    if (!this.isInitialized) {
      try {
        await this.initialize();
      } catch (initErr) {
        const errObj = this._formatError(requestId, null, initErr.code || ErrorCodes.BROWSER_UNAVAILABLE, initErr.message);
        this.idempotency.registerFailed(requestId, initErr);
        return errObj;
      }
    }

    // 4. Concurrency check: prevent simultaneous prompts clashing
    if (this.isProcessing) {
      const errObj = this._formatError(
        requestId,
        req.session_id || null,
        ErrorCodes.SESSION_BUSY,
        `Transport is currently processing another request (${this.activeSessionId}). Concurrent execution is restricted for session safety.`
      );
      this.idempotency.registerFailed(requestId, new TransportError(ErrorCodes.SESSION_BUSY, 'Transport is busy'));
      return errObj;
    }

    this.isProcessing = true;
    let sessionId = req.session_id || req.sessionId;
    let sessionRecord = null;

    // 5. Session Record Resolution & Lifecycle Transition
    const isNewSession = !sessionId || !this.sessions.has(sessionId);
    if (isNewSession) {
      sessionId = sessionId || `session-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      sessionRecord = new SessionRecord(sessionId);
      sessionRecord.transitionTo(SessionState.READY, 'created_ready');
      this.sessions.set(sessionId, sessionRecord);
    } else {
      sessionRecord = this.sessions.get(sessionId);
    }

    this.activeSessionId = sessionId;
    sessionRecord.markProcessing();

    // 6. Bounded Execution Loop with Safe Retry
    let attempt = 0;
    let lastError = null;

    while (attempt < this.maxRetryAttempts) {
      attempt++;

      this.observability.emitEvent('OPERATION_ATTEMPT', {
        requestId,
        sessionId,
        attempt,
        state: sessionRecord.state,
        details: { isNewSession }
      });

      try {
        const result = await this._executePromptAttempt({
          requestId,
          sessionId,
          promptText,
          timeoutMs,
          isNewSession,
          sessionRecord,
          attempt
        });

        // Success! Mark ready and record idempotency
        sessionRecord.markReady(true);
        const durationMs = Date.now() - startTime;

        const responseObj = {
          request_id: requestId,
          session_id: sessionId,
          status: 'completed',
          text: result,
          metadata: {
            turn: sessionRecord.turnCount,
            duration_ms: durationMs,
            attempt,
            timestamp: new Date().toISOString()
          }
        };

        this.idempotency.registerCompleted(requestId, responseObj);

        this.observability.emitEvent('OPERATION_COMPLETED', {
          requestId,
          sessionId,
          attempt,
          durationMs,
          state: sessionRecord.state,
          result: 'completed'
        });

        return responseObj;

      } catch (err) {
        lastError = classifyError(err);
        sessionRecord.markInterrupted(lastError.message);

        this.observability.emitEvent('OPERATION_FAILED', {
          requestId,
          sessionId,
          attempt,
          errorClassification: lastError.code,
          details: { message: lastError.message, retryable: lastError.retryable, recoverable: lastError.recoverable }
        });

        // Evaluate if recovery & retry is permitted
        if (lastError.recoverable && attempt < this.maxRetryAttempts) {
          this.observability.emitEvent('TRIGGERING_RECOVERY', {
            requestId,
            sessionId,
            attempt,
            recoveryAction: 'attempt_auto_recover'
          });

          try {
            await this.recovery.recover(lastError.code);
            // If recovery succeeded, continue loop for next attempt
            continue;
          } catch (recErr) {
            this.observability.emitEvent('RECOVERY_FAILED_ABORT', {
              requestId,
              sessionId,
              details: { message: recErr.message }
            });
            break;
          }
        } else {
          // Non-retryable or non-recoverable error
          break;
        }
      }
    }

    // Execution failed after bounded attempts
    sessionRecord.markFailed(lastError);
    this.idempotency.registerFailed(requestId, lastError);

    return this._formatError(
      requestId,
      sessionId,
      lastError ? lastError.code : ErrorCodes.INTERNAL_ERROR,
      lastError ? lastError.message : 'Execution failed'
    );
  }

  async _executePromptAttempt({ requestId, sessionId, promptText, timeoutMs, isNewSession, attempt }) {
    if (this.backend) {
      try {
        const backendResult = await this.backend.send({
          requestId,
          sessionId,
          prompt: promptText,
          timeoutMs,
          isNewSession
        });

        if (typeof backendResult === 'string') return backendResult;
        if (backendResult && backendResult.text) return backendResult.text;
        throw new TransportError(ErrorCodes.GENERATION_FAILED, 'Backend returned empty or invalid response');
      } catch (backendErr) {
        if (backendErr instanceof TransportError) throw backendErr;
        if (backendErr.message && backendErr.message.includes('Timeout')) {
          throw new TransportError(ErrorCodes.TIMEOUT, backendErr.message);
        }
        throw new TransportError(backendErr.code || ErrorCodes.GENERATION_FAILED, backendErr.message);
      }
    }

    // Real Browser / CDP path
    if (!this.driver) {
      throw new TransportError(ErrorCodes.BROWSER_UNAVAILABLE, 'Driver not available on active transport');
    }

    // 1. Input readiness check
    if (isNewSession) {
      const inputReady = await this.driver._waitForInput(15000);
      if (!inputReady) {
        throw new TransportError(ErrorCodes.CHATGPT_UNAVAILABLE, 'Input box not ready on active ChatGPT page');
      }
    }

    // 2. Query assistant message baseline count
    const beforeCount = await this.driver.getAssistantMessageCount();

    // 3. Inject and click send
    await this.driver.injectAndSendPrompt(promptText);

    // 4. Deterministic completion wait
    let finalText;
    try {
      finalText = await this.driver.waitForCompletion(beforeCount, timeoutMs);
    } catch (waitErr) {
      if (waitErr.message.includes('Timeout')) {
        throw new TransportError(ErrorCodes.TIMEOUT, `Timeout waiting for ChatGPT response (${timeoutMs}ms)`);
      }
      throw new TransportError(ErrorCodes.GENERATION_FAILED, waitErr.message);
    }

    if (!finalText || typeof finalText !== 'string' || !finalText.trim()) {
      throw new TransportError(ErrorCodes.GENERATION_FAILED, 'Empty response captured from ChatGPT Free');
    }

    return finalText;
  }

  _formatError(requestId, sessionId, code, message) {
    const classification = (new TransportError(code, message)).toJSON();
    return {
      request_id: requestId,
      session_id: sessionId || null,
      status: 'error',
      error: {
        code,
        message,
        category: classification.category,
        retryable: classification.retryable,
        recoverable: classification.recoverable
      }
    };
  }

  async closeSession(sessionId) {
    if (this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId);
      session.markClosed('requested_close');
      this.sessions.delete(sessionId);
      return true;
    }
    return false;
  }

  async getDiagnostics() {
    const health = await this.recovery.checkHealth();
    const sessionSummaries = Array.from(this.sessions.values()).map(s => s.toJSON());

    return {
      status: health.transport_healthy ? 'ok' : 'degraded',
      health,
      active_session_id: this.activeSessionId,
      is_processing: this.isProcessing,
      sessions_count: this.sessions.size,
      sessions: sessionSummaries,
      last_recovery: this.recovery.getLastRecovery(),
      recent_logs: this.observability.getRecentLogs(20)
    };
  }

  async close() {
    if (this.backend && typeof this.backend.close === 'function') {
      await this.backend.close();
    }
    if (this.browserManager) {
      await this.browserManager.close();
      this.browserManager = null;
      this.driver = null;
    }
    this.isInitialized = false;
    for (const session of this.sessions.values()) {
      session.markClosed('transport_shutdown');
    }
    this.sessions.clear();
    this.idempotency.clear();
  }
}

// Ensure cleanup on send completion
const origSend = ChatGptTransportAdapter.prototype.send;
ChatGptTransportAdapter.prototype.send = async function(req) {
  try {
    return await origSend.call(this, req);
  } finally {
    this.isProcessing = false;
    this.activeSessionId = null;
  }
};

module.exports = {
  ChatGptTransportAdapter,
  TransportError,
  ErrorCodes,
  ErrorCategory
};
