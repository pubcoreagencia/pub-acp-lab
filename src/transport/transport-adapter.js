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
 * ChatGptTransportAdapter (Phase 7.4):
 * Provides a reliable, observable, idempotent and auto-recovering local transport
 * to real ChatGPT Free with bounded re-entry, input safety and concurrency locking.
 */
class ChatGptTransportAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 9555;
    this.profileDir = options.profileDir || path.resolve(process.cwd(), 'isolated_profile');
    this.chromePath = options.chromePath || null;
    this.defaultTimeoutMs = options.defaultTimeoutMs || TimeoutPolicy.DEFAULT_TIMEOUT_MS;
    this.backend = options.backend || null;
    this.browserManager = options.browserManager || null;
    this.driver = null;
    this.isInitialized = !!this.backend;

    // Session Management & Concurrency Lock
    this.sessions = new Map(); // sessionId -> SessionRecord
    this.activeSessionId = null;
    this.isProcessing = false;
    this.activeRequestId = null; // Identifier of request currently holding the lock
    this.maxRetryAttempts = options.maxRetryAttempts !== undefined ? options.maxRetryAttempts : 2;

    this.idempotency = new IdempotencyManager();
    this.observability = new TransportObservability(this);
    this.recovery = new RecoveryManager(this);
  }

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
   * Main programmatic dispatch method.
   * Hardened against null/invalid input, concurrency leaks and prompt duplication.
   */
  async send(req) {
    const startTime = Date.now();

    // 1. Strict Input Validation (P0)
    if (!req || typeof req !== 'object' || Array.isArray(req)) {
      return this._formatError(
        `req-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        null,
        ErrorCodes.INVALID_REQUEST,
        'Request payload must be a non-null object'
      );
    }

    const requestId = req.request_id || req.requestId || `req-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const timeoutMs = TimeoutPolicy.resolveTimeout(req.timeout_ms || req.timeoutMs || this.defaultTimeoutMs);
    const promptText = req.prompt;

    if (!promptText || typeof promptText !== 'string' || !promptText.trim()) {
      return this._formatError(
        requestId,
        req.session_id || req.sessionId || null,
        ErrorCodes.INVALID_REQUEST,
        'Prompt text is required and cannot be empty'
      );
    }

    // 2. Idempotency & Payload Conflict Check (P1)
    const idempStatus = this.idempotency.check(requestId, promptText);
    if (idempStatus.conflict) {
      return this._formatError(
        requestId,
        req.session_id || req.sessionId || null,
        ErrorCodes.IDEMPOTENCY_CONFLICT,
        `Request ID ${requestId} was already executed with a different payload`
      );
    }

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
        req.session_id || req.sessionId || null,
        ErrorCodes.REQUEST_IN_FLIGHT,
        `Request ${requestId} is already currently executing in-flight.`
      );
    }

    // 3. Concurrency Lock Check (P0)
    if (this.isProcessing) {
      return this._formatError(
        requestId,
        req.session_id || req.sessionId || null,
        ErrorCodes.SESSION_BUSY,
        `Transport is currently processing another request (${this.activeSessionId || this.activeRequestId}). Concurrent execution is restricted for session safety.`
      );
    }

    // Acquire lock exclusively for this requestId
    this.isProcessing = true;
    this.activeRequestId = requestId;
    let lockAcquired = true;

    try {
      // Register in-flight idempotency with payload fingerprint
      this.idempotency.registerInFlight(requestId, promptText, { prompt: promptText.slice(0, 50) });

      // Ensure transport is initialized
      if (!this.isInitialized) {
        try {
          await this.initialize();
        } catch (initErr) {
          const errObj = this._formatError(requestId, null, initErr.code || ErrorCodes.BROWSER_UNAVAILABLE, initErr.message);
          this.idempotency.registerFailed(requestId, initErr);
          return errObj;
        }
      }

      let sessionId = req.session_id || req.sessionId;
      let sessionRecord = null;

      // Session Record Resolution & Lifecycle Transition
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

      // Bounded Execution Loop with Side-Effect Aware Re-Entry (P0)
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

        let sideEffectApplied = false;

        try {
          const result = await this._executePromptAttempt({
            requestId,
            sessionId,
            promptText,
            timeoutMs,
            isNewSession,
            sessionRecord,
            attempt,
            onSideEffect: () => {
              sideEffectApplied = true;
            }
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
            details: {
              message: lastError.message,
              retryable: lastError.retryable,
              recoverable: lastError.recoverable,
              sideEffectApplied
            }
          });

          // BOUNDED RE-ENTRY SAFETY RULE (Phase 7.4):
          // If prompt was already injected/applied, NEVER retry blindly to prevent duplicate execution
          if (sideEffectApplied) {
            this.observability.emitEvent('RETRY_SUPPRESSED_SIDE_EFFECT', {
              requestId,
              sessionId,
              attempt,
              details: { reason: 'prompt_already_injected', originalError: lastError.code }
            });

            // Suppress retry: do not loop again on operation that already produced a side-effect
            lastError.retryable = false;
            break;
          }

          // Safe Retry only when NO side-effects were applied and error is recoverable
          if (lastError.recoverable && attempt < this.maxRetryAttempts) {
            this.observability.emitEvent('TRIGGERING_RECOVERY', {
              requestId,
              sessionId,
              attempt,
              recoveryAction: 'attempt_auto_recover'
            });

            try {
              await this.recovery.recover(lastError.code);
              continue; // Safe to retry attempt
            } catch (recErr) {
              this.observability.emitEvent('RECOVERY_FAILED_ABORT', {
                requestId,
                sessionId,
                details: { message: recErr.message }
              });
              break;
            }
          } else {
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
        lastError || ErrorCodes.INTERNAL_ERROR,
        lastError ? lastError.message : 'Execution failed'
      );

    } finally {
      // ONLY release the lock if THIS invocation was the one that acquired it (P0)
      if (lockAcquired && this.activeRequestId === requestId) {
        this.isProcessing = false;
        this.activeRequestId = null;
        this.activeSessionId = null;
      }
    }
  }

  async _executePromptAttempt({ requestId, sessionId, promptText, timeoutMs, isNewSession, attempt, onSideEffect }) {
    if (this.backend) {
      try {
        const backendResult = await this.backend.send({
          requestId,
          sessionId,
          prompt: promptText,
          timeoutMs,
          isNewSession,
          onSideEffect
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

    // 1. Input readiness check (before side effect)
    if (isNewSession) {
      const inputReady = await this.driver._waitForInput(15000);
      if (!inputReady) {
        throw new TransportError(ErrorCodes.CHATGPT_UNAVAILABLE, 'Input box not ready on active ChatGPT page');
      }
    }

    // 2. Query assistant message baseline count
    const beforeCount = await this.driver.getAssistantMessageCount();

    // 3. Side-effect marker: injecting and clicking send
    if (typeof onSideEffect === 'function') {
      onSideEffect();
    }
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

  _formatError(requestId, sessionId, codeOrError, message) {
    let code = codeOrError;
    let classification;

    if (codeOrError instanceof TransportError || (codeOrError && codeOrError.name === 'TransportError')) {
      code = codeOrError.code;
      message = message || codeOrError.message;
      classification = codeOrError.toJSON();
    } else {
      classification = (new TransportError(code, message)).toJSON();
    }

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
      active_request_id: this.activeRequestId,
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

module.exports = {
  ChatGptTransportAdapter,
  TransportError,
  ErrorCodes,
  ErrorCategory
};
