/**
 * Structured Observability Logger for ChatGpt Transport
 * Phase 7.3
 */

class TransportObservability {
  constructor(adapter) {
    this.adapter = adapter;
    this.logs = [];
    this.maxLogs = 200;
  }

  emitEvent(eventType, payload = {}) {
    const eventRecord = {
      event: eventType,
      timestamp: new Date().toISOString(),
      session_id: payload.sessionId || null,
      request_id: payload.requestId || null,
      state: payload.state || null,
      attempt: payload.attempt || 1,
      duration_ms: payload.durationMs !== undefined ? payload.durationMs : null,
      error_classification: payload.errorClassification || null,
      recovery_action: payload.recoveryAction || null,
      result: payload.result || null,
      details: payload.details || null
    };

    this.logs.push(eventRecord);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    if (this.adapter && typeof this.adapter.emit === 'function') {
      this.adapter.emit('telemetry', eventRecord);
      this.adapter.emit('log', `[${eventRecord.event}] req:${eventRecord.request_id || '-'} sess:${eventRecord.session_id || '-'} att:${eventRecord.attempt} ${payload.message || ''}`);
    }

    return eventRecord;
  }

  getRecentLogs(limit = 50) {
    return this.logs.slice(-limit);
  }

  clear() {
    this.logs = [];
  }
}

module.exports = { TransportObservability };
