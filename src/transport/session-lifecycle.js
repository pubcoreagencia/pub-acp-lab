/**
 * Session Lifecycle & State Machine for ChatGpt Transport
 * Phase 7.3
 */

const SessionState = {
  INITIALIZING: 'INITIALIZING',
  READY: 'READY',
  PROCESSING: 'PROCESSING',
  INTERRUPTED: 'INTERRUPTED',
  FAILED: 'FAILED',
  CLOSED: 'CLOSED'
};

const ValidTransitions = {
  [SessionState.INITIALIZING]: [SessionState.READY, SessionState.FAILED, SessionState.CLOSED],
  [SessionState.READY]: [SessionState.PROCESSING, SessionState.INTERRUPTED, SessionState.FAILED, SessionState.CLOSED],
  [SessionState.PROCESSING]: [SessionState.READY, SessionState.INTERRUPTED, SessionState.FAILED, SessionState.CLOSED],
  [SessionState.INTERRUPTED]: [SessionState.READY, SessionState.PROCESSING, SessionState.FAILED, SessionState.CLOSED],
  [SessionState.FAILED]: [SessionState.READY, SessionState.CLOSED],
  [SessionState.CLOSED]: []
};

class SessionRecord {
  constructor(sessionId) {
    this.id = sessionId;
    this.state = SessionState.INITIALIZING;
    this.createdAt = Date.now();
    this.lastActive = Date.now();
    this.turnCount = 0;
    this.stateHistory = [
      { from: null, to: SessionState.INITIALIZING, timestamp: this.createdAt, reason: 'created' }
    ];
    this.lastError = null;
  }

  transitionTo(nextState, reason = '') {
    if (this.state === nextState) return;

    const allowed = ValidTransitions[this.state] || [];
    if (!allowed.includes(nextState)) {
      throw new Error(`Invalid session state transition from ${this.state} to ${nextState} (session: ${this.id})`);
    }

    const previousState = this.state;
    this.state = nextState;
    this.lastActive = Date.now();

    this.stateHistory.push({
      from: previousState,
      to: nextState,
      timestamp: this.lastActive,
      reason
    });
  }

  markProcessing() {
    this.transitionTo(SessionState.PROCESSING, 'prompt_dispatch');
  }

  markReady(incrementTurn = true) {
    if (incrementTurn) {
      this.turnCount++;
    }
    this.transitionTo(SessionState.READY, 'turn_completed');
  }

  markInterrupted(reason) {
    this.transitionTo(SessionState.INTERRUPTED, reason);
  }

  markFailed(error) {
    this.lastError = error;
    this.transitionTo(SessionState.FAILED, error ? (error.message || String(error)) : 'failure');
  }

  markClosed(reason = 'closed_by_user') {
    this.transitionTo(SessionState.CLOSED, reason);
  }

  toJSON() {
    return {
      id: this.id,
      state: this.state,
      turnCount: this.turnCount,
      createdAt: this.createdAt,
      lastActive: this.lastActive,
      stateHistory: this.stateHistory,
      lastError: this.lastError ? (this.lastError.message || String(this.lastError)) : null
    };
  }
}

module.exports = {
  SessionState,
  SessionRecord
};
