/**
 * Idempotency Manager for ChatGpt Transport
 * Phase 7.3
 */

const OperationState = {
  IN_FLIGHT: 'IN_FLIGHT',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
};

class IdempotencyManager {
  constructor(options = {}) {
    this.ttlMs = options.ttlMs || 300000; // 5 min TTL
    this.records = new Map();
  }

  /**
   * Checks if an operation is already registered.
   * Returns { status: 'NEW' | 'IN_FLIGHT' | 'COMPLETED' | 'FAILED', record }
   */
  check(requestId) {
    if (!requestId) return { status: 'NEW' };
    this._cleanup();

    const record = this.records.get(requestId);
    if (!record) return { status: 'NEW' };

    return {
      status: record.state,
      record: record.response || null,
      error: record.error || null
    };
  }

  registerInFlight(requestId, metadata = {}) {
    if (!requestId) return;
    this.records.set(requestId, {
      state: OperationState.IN_FLIGHT,
      startTime: Date.now(),
      metadata
    });
  }

  registerCompleted(requestId, response) {
    if (!requestId) return;
    this.records.set(requestId, {
      state: OperationState.COMPLETED,
      completedAt: Date.now(),
      response
    });
  }

  registerFailed(requestId, error) {
    if (!requestId) return;
    this.records.set(requestId, {
      state: OperationState.FAILED,
      failedAt: Date.now(),
      error: (error && error.toJSON) ? error.toJSON() : { message: String(error) }
    });
  }

  _cleanup() {
    const now = Date.now();
    for (const [id, rec] of this.records.entries()) {
      const time = rec.completedAt || rec.failedAt || rec.startTime;
      if (time && now - time > this.ttlMs) {
        this.records.delete(id);
      }
    }
  }

  clear() {
    this.records.clear();
  }
}

module.exports = {
  OperationState,
  IdempotencyManager
};
