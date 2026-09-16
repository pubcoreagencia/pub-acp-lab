/**
 * Idempotency Manager for ChatGpt Transport
 * Phase 7.3 & Phase 7.4
 *
 * Enforces payload fingerprinting to prevent IDEMPOTENCY_CONFLICT
 * when different payloads reuse the same request_id.
 */

const crypto = require('crypto');

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
   * Computes deterministic fingerprint for payload check
   */
  computeFingerprint(payload) {
    if (typeof payload === 'string') {
      return crypto.createHash('sha256').update(payload).digest('hex');
    }
    const str = JSON.stringify(payload || {});
    return crypto.createHash('sha256').update(str).digest('hex');
  }

  /**
   * Checks if an operation is already registered.
   * Returns { status: 'NEW' | 'IN_FLIGHT' | 'COMPLETED' | 'FAILED', record, conflict: boolean }
   */
  check(requestId, currentPayload = null) {
    if (!requestId) return { status: 'NEW', conflict: false };
    this._cleanup();

    const record = this.records.get(requestId);
    if (!record) return { status: 'NEW', conflict: false };

    // Check payload fingerprint conflict
    if (currentPayload !== null && currentPayload !== undefined && record.fingerprint) {
      const currentFp = this.computeFingerprint(currentPayload);
      if (currentFp !== record.fingerprint) {
        return {
          status: record.state,
          conflict: true,
          record: record.response || null,
          error: record.error || null
        };
      }
    }

    return {
      status: record.state,
      conflict: false,
      record: record.response || null,
      error: record.error || null
    };
  }

  registerInFlight(requestId, payload = null, metadata = {}) {
    if (!requestId) return;
    const fingerprint = payload !== null ? this.computeFingerprint(payload) : null;
    this.records.set(requestId, {
      state: OperationState.IN_FLIGHT,
      startTime: Date.now(),
      fingerprint,
      metadata
    });
  }

  registerCompleted(requestId, response) {
    if (!requestId) return;
    const existing = this.records.get(requestId) || {};
    this.records.set(requestId, {
      ...existing,
      state: OperationState.COMPLETED,
      completedAt: Date.now(),
      response
    });
  }

  registerFailed(requestId, error) {
    if (!requestId) return;
    const existing = this.records.get(requestId) || {};
    this.records.set(requestId, {
      ...existing,
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
