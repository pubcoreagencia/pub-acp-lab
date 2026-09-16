/**
 * Centralized Timeout Policy for ChatGpt Transport
 * Phase 7.3
 */

const TimeoutPolicy = {
  MIN_TIMEOUT_MS: 50, // Permite testes rápidos e determinísticos
  DEFAULT_TIMEOUT_MS: 120000,
  MAX_TIMEOUT_MS: 300000, // 5 minutos teto operacional
  CDP_CONNECT_TIMEOUT_MS: 15000,
  INPUT_READY_TIMEOUT_MS: 15000,
  RECOVERY_TIMEOUT_MS: 30000,

  resolveTimeout(requestedTimeout) {
    if (requestedTimeout === undefined || requestedTimeout === null) {
      return this.DEFAULT_TIMEOUT_MS;
    }
    const parsed = Number(requestedTimeout);
    if (isNaN(parsed) || parsed <= 0) {
      return this.DEFAULT_TIMEOUT_MS;
    }
    if (parsed < this.MIN_TIMEOUT_MS) {
      return this.MIN_TIMEOUT_MS;
    }
    if (parsed > this.MAX_TIMEOUT_MS) {
      return this.MAX_TIMEOUT_MS;
    }
    return parsed;
  }
};

module.exports = { TimeoutPolicy };
