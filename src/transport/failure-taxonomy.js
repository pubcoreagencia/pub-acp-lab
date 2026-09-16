/**
 * Failure Taxonomy & Error Classification for ChatGpt Transport
 * Phase 7.3
 */

const ErrorCategory = {
  CLIENT: 'CLIENT',               // Malformed requests, bad parameters (non-retryable, non-recoverable)
  TRANSIENT: 'TRANSIENT',         // Network glitch, temporary busy, timeout (retryable)
  OPERATIONAL: 'OPERATIONAL',     // CDP drop, Chrome crash, target detach (recoverable via transport recovery)
  FATAL: 'FATAL'                  // Auth expired, blocked account, non-recoverable environment failure
};

const ErrorCodes = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  BROWSER_UNAVAILABLE: 'BROWSER_UNAVAILABLE',
  CHATGPT_UNAVAILABLE: 'CHATGPT_UNAVAILABLE',
  SESSION_BUSY: 'SESSION_BUSY',
  SESSION_UNAVAILABLE: 'SESSION_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  GENERATION_FAILED: 'GENERATION_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  // Operational additions in Phase 7.3
  CDP_DISCONNECTED: 'CDP_DISCONNECTED',
  BROWSER_CRASHED: 'BROWSER_CRASHED',
  RECOVERY_FAILED: 'RECOVERY_FAILED',
  REQUEST_IN_FLIGHT: 'REQUEST_IN_FLIGHT'
};

const CodeClassification = {
  [ErrorCodes.INVALID_REQUEST]: {
    category: ErrorCategory.CLIENT,
    retryable: false,
    recoverable: false
  },
  [ErrorCodes.SESSION_UNAVAILABLE]: {
    category: ErrorCategory.CLIENT,
    retryable: false,
    recoverable: false
  },
  [ErrorCodes.REQUEST_IN_FLIGHT]: {
    category: ErrorCategory.CLIENT,
    retryable: false,
    recoverable: false
  },
  [ErrorCodes.SESSION_BUSY]: {
    category: ErrorCategory.TRANSIENT,
    retryable: true,
    recoverable: false
  },
  [ErrorCodes.TIMEOUT]: {
    category: ErrorCategory.TRANSIENT,
    retryable: true,
    recoverable: true
  },
  [ErrorCodes.GENERATION_FAILED]: {
    category: ErrorCategory.TRANSIENT,
    retryable: true,
    recoverable: true
  },
  [ErrorCodes.CDP_DISCONNECTED]: {
    category: ErrorCategory.OPERATIONAL,
    retryable: true,
    recoverable: true
  },
  [ErrorCodes.BROWSER_CRASHED]: {
    category: ErrorCategory.OPERATIONAL,
    retryable: true,
    recoverable: true
  },
  [ErrorCodes.BROWSER_UNAVAILABLE]: {
    category: ErrorCategory.OPERATIONAL,
    retryable: false,
    recoverable: true
  },
  [ErrorCodes.RECOVERY_FAILED]: {
    category: ErrorCategory.OPERATIONAL,
    retryable: false,
    recoverable: false
  },
  [ErrorCodes.CHATGPT_UNAVAILABLE]: {
    category: ErrorCategory.FATAL,
    retryable: false,
    recoverable: false
  },
  [ErrorCodes.INTERNAL_ERROR]: {
    category: ErrorCategory.OPERATIONAL,
    retryable: false,
    recoverable: true
  }
};

class TransportError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'TransportError';
    this.code = code || ErrorCodes.INTERNAL_ERROR;
    this.details = details;

    const classification = CodeClassification[this.code] || {
      category: ErrorCategory.OPERATIONAL,
      retryable: false,
      recoverable: false
    };

    this.category = classification.category;
    this.retryable = classification.retryable;
    this.recoverable = classification.recoverable;
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      category: this.category,
      retryable: this.retryable,
      recoverable: this.recoverable,
      details: this.details
    };
  }
}

function classifyError(err) {
  if (err instanceof TransportError) return err;

  const msg = (err && err.message) ? err.message.toLowerCase() : '';
  if (msg.includes('timeout')) {
    return new TransportError(ErrorCodes.TIMEOUT, err.message);
  }
  if (msg.includes('socket') || msg.includes('websocket') || msg.includes('econnrefused') || msg.includes('cdp')) {
    return new TransportError(ErrorCodes.CDP_DISCONNECTED, err.message);
  }
  return new TransportError(ErrorCodes.INTERNAL_ERROR, err ? err.message : 'Unknown error');
}

module.exports = {
  ErrorCategory,
  ErrorCodes,
  CodeClassification,
  TransportError,
  classifyError
};
