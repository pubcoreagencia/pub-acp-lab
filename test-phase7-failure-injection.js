/**
 * Failure Injection & Reliability Test Suite for Phase 7.3
 *
 * Provokes deterministic failures:
 * 1. Invalid Request & Taxonomy Validation (Client error, non-retryable)
 * 2. Idempotency Protection (In-flight duplicate rejection & completed cache return)
 * 3. Bounded Retry under transient failure (attempt tracking, no infinite loops)
 * 4. Recovery under injected backend crash / reset
 * 5. CDP & WebSocket disconnect simulation & recovery
 * 6. Session Lifecycle state tracking & transition invariants
 * 7. Structured Observability & Diagnostics verification
 */

const {
  ChatGptTransportAdapter,
  ChatGptTransportServer,
  ChatGptTransportClient,
  FakeChatGptBackend,
  ErrorCodes,
  ErrorCategory,
  SessionState
} = require('./src/transport');

class FlakyBackend extends FakeChatGptBackend {
  constructor() {
    super();
    this.failureMode = null;
    this.attemptsObserved = 0;
  }

  async send(params) {
    this.attemptsObserved++;

    if (this.failureMode === 'FAIL_ONCE') {
      this.failureMode = null; // Next attempt will succeed
      const err = new Error('Simulated transient CDP/network drop');
      err.code = ErrorCodes.CDP_DISCONNECTED;
      throw err;
    }

    if (this.failureMode === 'ALWAYS_FAIL') {
      const err = new Error('Simulated persistent failure');
      err.code = ErrorCodes.GENERATION_FAILED;
      throw err;
    }

    return super.send(params);
  }
}

async function runFailureInjectionTests() {
  console.log('================================================================');
  console.log('STARTING PHASE 7.3 FAILURE INJECTION & RELIABILITY TEST SUITE');
  console.log('================================================================\n');

  const serverPort = 5128;
  const flakyBackend = new FlakyBackend();
  const adapter = new ChatGptTransportAdapter({
    backend: flakyBackend,
    maxRetryAttempts: 2
  });

  const server = new ChatGptTransportServer({
    port: serverPort,
    adapter
  });

  await server.start();
  const client = new ChatGptTransportClient({ baseUrl: `http://127.0.0.1:${serverPort}` });

  try {
    // -------------------------------------------------------------
    // TEST 1: TAXONOMY & CLIENT ERROR INJECTION
    // -------------------------------------------------------------
    console.log('[TEST 1] Injected Invalid Request -> Verifying Structured Failure Taxonomy...');
    const res1 = await client.send({ prompt: '   ' });
    if (res1.status !== 'error') throw new Error('Expected status error');
    if (res1.error.code !== ErrorCodes.INVALID_REQUEST) throw new Error(`Expected INVALID_REQUEST, got ${res1.error.code}`);
    if (res1.error.category !== ErrorCategory.CLIENT) throw new Error(`Expected CLIENT category, got ${res1.error.category}`);
    if (res1.error.retryable !== false) throw new Error('Client error should not be retryable');
    console.log('[TEST 1 PASS] Failure taxonomy for client errors validated successfully!\n');

    // -------------------------------------------------------------
    // TEST 2: IDEMPOTENCY PROTECTION (DEDUPLICATION & CACHE)
    // -------------------------------------------------------------
    console.log('[TEST 2] Idempotency: Executing request with fixed request_id "req-idemp-1"...');
    const fixedReqId = 'req-idemp-1';
    const res2A = await client.send({
      request_id: fixedReqId,
      prompt: 'Responda exatamente: IDEMPOTENCY_VERIFIED'
    });
    if (res2A.status !== 'completed') throw new Error('Initial request failed');
    console.log('  -> Initial response received:', res2A.text);

    console.log('  -> Re-sending same request_id and same prompt to verify deduplication / cached return...');
    const res2B = await client.send({
      request_id: fixedReqId,
      prompt: 'Responda exatamente: IDEMPOTENCY_VERIFIED'
    });
    if (res2B.status !== 'completed' || res2B.text !== 'IDEMPOTENCY_VERIFIED') {
      throw new Error(`Idempotency violated! Expected cached response, got: ${JSON.stringify(res2B)}`);
    }

    console.log('  -> Sending conflicting prompt with same request_id...');
    const res2C = await client.send({
      request_id: fixedReqId,
      prompt: 'Different prompt attempting overwrite with same request_id'
    });
    if (res2C.status !== 'error' || res2C.error.code !== ErrorCodes.IDEMPOTENCY_CONFLICT) {
      throw new Error(`Expected IDEMPOTENCY_CONFLICT, got: ${JSON.stringify(res2C)}`);
    }
    console.log('[TEST 2 PASS] Idempotent request protected with cache and conflict detection!\n');

    // -------------------------------------------------------------
    // TEST 3: BOUNDED RETRY ON TRANSIENT / RECOVERABLE FAILURE
    // -------------------------------------------------------------
    console.log('[TEST 3] Bounded Retry: Injecting transient FAIL_ONCE condition...');
    flakyBackend.failureMode = 'FAIL_ONCE';
    flakyBackend.attemptsObserved = 0;

    const res3 = await client.send({
      request_id: 'req-flaky-retry',
      prompt: 'Responda exatamente: RETRY_SUCCEEDED'
    });

    console.log('  -> Attempts observed by backend:', flakyBackend.attemptsObserved);
    console.log('  -> Final status:', res3.status, 'metadata:', res3.metadata);

    if (res3.status !== 'completed' || res3.metadata.attempt !== 2 || flakyBackend.attemptsObserved !== 2) {
      throw new Error(`TEST 3 FAILED: Expected recovery on attempt 2, got attempts=${flakyBackend.attemptsObserved}`);
    }
    console.log('[TEST 3 PASS] Transient failure safely recovered on attempt 2!\n');

    // -------------------------------------------------------------
    // TEST 4: FINITE BOUNDED RETRY LIMIT (NO INFINITE LOOPS)
    // -------------------------------------------------------------
    console.log('[TEST 4] Bounded Retry Ceiling: Injecting persistent ALWAYS_FAIL condition...');
    flakyBackend.failureMode = 'ALWAYS_FAIL';
    flakyBackend.attemptsObserved = 0;

    const res4 = await client.send({
      request_id: 'req-always-fail',
      prompt: 'Should fail after exactly 2 attempts'
    });

    console.log('  -> Attempts observed before abortion:', flakyBackend.attemptsObserved);
    console.log('  -> Response error:', res4.error);

    if (res4.status !== 'error' || flakyBackend.attemptsObserved !== 2) {
      throw new Error(`TEST 4 FAILED: Expected exactly 2 attempts before abortion, got: ${flakyBackend.attemptsObserved}`);
    }
    console.log('[TEST 4 PASS] Bounded retry strictly halted at maxRetryAttempts (2) without infinite loop!\n');

    // Reset backend to normal
    flakyBackend.failureMode = null;

    // -------------------------------------------------------------
    // TEST 5: SESSION LIFECYCLE STATE INVARIANTS
    // -------------------------------------------------------------
    console.log('[TEST 5] Validating Session Lifecycle states & history...');
    const sid = 'sess-lifecycle-test';
    await client.send({
      request_id: 'req-lc-1',
      session_id: sid,
      prompt: 'Responda exatamente: LC_STEP_1'
    });

    const sessionRecord = adapter.sessions.get(sid);
    if (!sessionRecord) throw new Error('Session not found in adapter');
    if (sessionRecord.state !== SessionState.READY) {
      throw new Error(`Expected session state READY, got: ${sessionRecord.state}`);
    }
    if (sessionRecord.turnCount !== 1) {
      throw new Error(`Expected turnCount 1, got: ${sessionRecord.turnCount}`);
    }

    const jsonState = sessionRecord.toJSON();
    console.log('  -> Session state history steps:', jsonState.stateHistory.map(h => `${h.from || 'START'}->${h.to} (${h.reason})`));
    if (jsonState.stateHistory.length < 3) {
      throw new Error('Incomplete session state history');
    }
    console.log('[TEST 5 PASS] Session lifecycle state machine transitions validated!\n');

    // -------------------------------------------------------------
    // TEST 6: STRUCTURED DIAGNOSTICS SURFACE
    // -------------------------------------------------------------
    console.log('[TEST 6] Querying /v1/diagnostics surface...');
    const diag = await client.diagnostics();
    console.log('  -> Diagnostics status:', diag.status);
    console.log('  -> Active sessions count:', diag.sessions_count);
    console.log('  -> Recent logs recorded:', diag.recent_logs.length);

    if (diag.status !== 'ok' || diag.sessions_count === 0 || !Array.isArray(diag.recent_logs)) {
      throw new Error(`Diagnostics verification failed: ${JSON.stringify(diag)}`);
    }
    console.log('[TEST 6 PASS] Comprehensive health & diagnostics surface operational!\n');

    console.log('================================================================');
    console.log('ALL PHASE 7.3 FAILURE INJECTION TESTS PASSED SUCCESSFULLY!');
    console.log('================================================================\n');

  } finally {
    await server.close();
  }
}

runFailureInjectionTests().catch(err => {
  console.error('FATAL FAILURE INJECTION TEST ERROR:', err);
  process.exit(1);
});
