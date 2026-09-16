const { EventEmitter } = require('events');
const path = require('path');
const { IsolatedBrowserManager } = require('../isolated-browser/browser-manager.js');
const { ChatGptDriver } = require('../isolated-browser/chatgpt-driver.js');

/**
 * Standard Error Codes for Local Transport
 */
const ErrorCodes = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  BROWSER_UNAVAILABLE: 'BROWSER_UNAVAILABLE',
  CHATGPT_UNAVAILABLE: 'CHATGPT_UNAVAILABLE',
  SESSION_BUSY: 'SESSION_BUSY',
  SESSION_UNAVAILABLE: 'SESSION_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  GENERATION_FAILED: 'GENERATION_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

class TransportError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      details: this.details
    };
  }
}

/**
 * ChatGptTransportAdapter:
 * Provides a reusable, headless, programmatic local transport to real ChatGPT Free
 * via an isolated Chrome profile and native WebSocket CDP.
 *
 * Exposes a clean request/response contract:
 * send({ request_id, session_id, prompt, timeout_ms })
 * -> { request_id, session_id, status: 'completed', text, metadata }
 */
class ChatGptTransportAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 9555;
    this.profileDir = options.profileDir || path.resolve(process.cwd(), 'isolated_profile');
    this.chromePath = options.chromePath || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    this.defaultTimeoutMs = options.defaultTimeoutMs || 120000;
    this.backend = options.backend || null;
    this.browserManager = options.browserManager || null;
    this.driver = null;
    this.isInitialized = !!this.backend;

    // Session management: maps sessionId -> { turnCount, lastActive, url }
    this.sessions = new Map();
    this.activeSessionId = null; // currently processing session
    this.isProcessing = false;
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
      return { status: 'ready', type: 'injected_backend' };
    }

    if (this.isInitialized && this.browserManager && this.driver) {
      return { status: 'ready', port: this.port };
    }

    try {
      if (!this.browserManager) {
        this.browserManager = options.browserManager || new IsolatedBrowserManager({
          port: this.port,
          profileDir: this.profileDir,
          chromePath: this.chromePath
        });
      }

      this.emit('log', `Connecting to isolated browser on port ${this.port}...`);
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

      this.emit('log', 'ChatGptTransportAdapter initialized and ready.');
      return { status: 'ready', port: this.port };
    } catch (err) {
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
   *
   * @param {Object} req
   * @param {string} req.prompt - The prompt string to execute (required)
   * @param {string} [req.request_id] - Unique request identifier
   * @param {string} [req.session_id] - Session ID. If omitted, a new conversation is started.
   * @param {number} [req.timeout_ms] - Max timeout in milliseconds
   * @returns {Promise<Object>} Response object conforming to standard contract
   */
  async send(req = {}) {
    const startTime = Date.now();
    const requestId = req.request_id || req.requestId || `req-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const timeoutMs = req.timeout_ms || req.timeoutMs || this.defaultTimeoutMs;

    // 1. Validation
    if (!req || typeof req !== 'object') {
      return this._formatError(requestId, null, ErrorCodes.INVALID_REQUEST, 'Request payload must be an object');
    }

    const promptText = req.prompt;
    if (!promptText || typeof promptText !== 'string' || !promptText.trim()) {
      return this._formatError(requestId, null, ErrorCodes.INVALID_REQUEST, 'Prompt text is required and cannot be empty');
    }

    // 2. Ensure transport is initialized
    if (!this.isInitialized) {
      try {
        await this.initialize();
      } catch (initErr) {
        return this._formatError(requestId, null, initErr.code || ErrorCodes.BROWSER_UNAVAILABLE, initErr.message);
      }
    }

    // 3. Concurrency check: prevent simultaneous prompts clashing in the DOM
    if (this.isProcessing) {
      return this._formatError(
        requestId,
        req.session_id || null,
        ErrorCodes.SESSION_BUSY,
        `Transport is currently processing another request (${this.activeSessionId}). Concurrent execution is restricted for session safety.`
      );
    }

    this.isProcessing = true;
    let sessionId = req.session_id || req.sessionId;

    try {
      // 4. Session Handling: New session vs Continuation
      const isNewSession = !sessionId || !this.sessions.has(sessionId);
      if (isNewSession) {
        sessionId = sessionId || `session-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        this.activeSessionId = sessionId;

        this.emit('log', `[${requestId}] Starting fresh conversation for session: ${sessionId}`);
        if (!this.backend) {
          const inputReady = await this.driver._waitForInput(15000);
          if (!inputReady) {
            throw new TransportError(ErrorCodes.CHATGPT_UNAVAILABLE, 'Input box not ready on active ChatGPT page');
          }
        }

        this.sessions.set(sessionId, {
          id: sessionId,
          createdAt: Date.now(),
          lastActive: Date.now(),
          turnCount: 0
        });
      } else {
        this.activeSessionId = sessionId;
        this.emit('log', `[${requestId}] Continuing existing session: ${sessionId}`);
      }

      const sessionData = this.sessions.get(sessionId);
      let finalText;

      if (this.backend) {
        // Direct execution via injected backend
        this.emit('log', `[${requestId}] Dispatching to injected backend...`);
        try {
          const backendResult = await this.backend.send({
            requestId,
            sessionId,
            prompt: promptText,
            timeoutMs,
            isNewSession
          });
          if (typeof backendResult === 'string') {
            finalText = backendResult;
          } else if (backendResult && backendResult.text) {
            finalText = backendResult.text;
          } else {
            throw new TransportError(ErrorCodes.GENERATION_FAILED, 'Backend returned empty or invalid response');
          }
        } catch (backendErr) {
          if (backendErr instanceof TransportError) throw backendErr;
          if (backendErr.message && backendErr.message.includes('Timeout')) {
            throw new TransportError(ErrorCodes.TIMEOUT, backendErr.message);
          }
          throw new TransportError(backendErr.code || ErrorCodes.GENERATION_FAILED, backendErr.message);
        }
      } else {
        // 5. Query assistant message baseline count before sending
        const beforeCount = await this.driver.getAssistantMessageCount();

        // 6. Inject and click send
        this.emit('log', `[${requestId}] Injecting prompt (len: ${promptText.length})...`);
        await this.driver.injectAndSendPrompt(promptText);

        // 7. Deterministic completion wait with specified timeout
        this.emit('log', `[${requestId}] Waiting for completion (timeout: ${timeoutMs}ms)...`);
        try {
          finalText = await this.driver.waitForCompletion(beforeCount, timeoutMs);
        } catch (waitErr) {
          if (waitErr.message.includes('Timeout')) {
            throw new TransportError(ErrorCodes.TIMEOUT, `Timeout waiting for ChatGPT response (${timeoutMs}ms)`);
          }
          throw new TransportError(ErrorCodes.GENERATION_FAILED, waitErr.message);
        }
      }

      if (!finalText || typeof finalText !== 'string' || !finalText.trim()) {
        throw new TransportError(ErrorCodes.GENERATION_FAILED, 'Empty response captured from ChatGPT Free');
      }

      // 8. Update session metadata
      sessionData.turnCount++;
      sessionData.lastActive = Date.now();

      const durationMs = Date.now() - startTime;
      this.emit('log', `[${requestId}] Request completed in ${durationMs}ms (session: ${sessionId}, turn: ${sessionData.turnCount})`);

      return {
        request_id: requestId,
        session_id: sessionId,
        status: 'completed',
        text: finalText,
        metadata: {
          turn: sessionData.turnCount,
          duration_ms: durationMs,
          timestamp: new Date().toISOString()
        }
      };

    } catch (err) {
      this.emit('error', err);
      const code = err.code || ErrorCodes.INTERNAL_ERROR;
      return this._formatError(requestId, sessionId, code, err.message);
    } finally {
      this.isProcessing = false;
      this.activeSessionId = null;
    }
  }

  _formatError(requestId, sessionId, code, message) {
    return {
      request_id: requestId,
      session_id: sessionId || null,
      status: 'error',
      error: {
        code,
        message
      }
    };
  }

  /**
   * Resets or closes an existing session
   */
  async closeSession(sessionId) {
    if (this.sessions.has(sessionId)) {
      this.sessions.delete(sessionId);
      return true;
    }
    return false;
  }

  /**
   * Closes CDP connection and detaches from browser
   */
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
    this.sessions.clear();
  }
}

module.exports = {
  ChatGptTransportAdapter,
  TransportError,
  ErrorCodes
};
