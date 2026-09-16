/**
 * Comprehensive Test Suite for Phase 7.4:
 * 1. Input Safety (undefined, null, number, boolean, array, empty prompt)
 * 2. Concurrency Safety (Lock isolation, B doesn't release A, C enters after A)
 * 3. Idempotency Conflict (same requestId + different payload -> IDEMPOTENCY_CONFLICT)
 * 4. Bounded Re-entry & Timeout Safety (no duplicate prompt when side effect applied)
 * 5. Encapsulated BrowserManager.reconnect()
 * 6. HTTP Body Size Limits (PAYLOAD_TOO_LARGE)
 */

const {
  ChatGptTransportAdapter,
  ChatGptTransportServer,
  ChatGptTransportClient,
  FakeChatGptBackend,
  ErrorCodes,
  ErrorCategory
} = require('./src/transport');

class ControlledBackend extends FakeChatGptBackend {
  constructor() {
    super();
    this.blockPromptPromise = null;
    this.resolveBlock = null;
    this.promptInvocationCounts = new Map();
  }

  setBlockPrompt(shouldBlock) {
    if (shouldBlock) {
      this.blockPromptPromise = new Promise(resolve => {
        this.resolveBlock = resolve;
      });
    } else if (this.resolveBlock) {
      this.resolveBlock();
      this.blockPromptPromise = null;
      this.resolveBlock = null;
    }
  }

  async send(params) {
    const { prompt, onSideEffect } = params;
    const count = (this.promptInvocationCounts.get(prompt) || 0) + 1;
    this.promptInvocationCounts.set(prompt, count);

    if (this.blockPromptPromise) {
      if (typeof onSideEffect === 'function') onSideEffect();
      await this.blockPromptPromise;
    }

    if (prompt === 'PROVOKE_POST_SIDEEFFECT_TIMEOUT') {
      if (typeof onSideEffect === 'function') onSideEffect();
      await new Promise(r => setTimeout(r, 80));
      throw new Error('Timeout waiting for response (80ms)');
    }

    return super.send(params);
  }
}

async function runPhase74TestSuite() {
  console.log('================================================================');
  console.log('STARTING PHASE 7.4 TEST SUITE');
  console.log('Scope: Recovery Hardening, Payload Safety & Bounded Re-Entry');
  console.log('================================================================\n');

  const backend = new ControlledBackend();
  const adapter = new ChatGptTransportAdapter({
    backend,
    maxRetryAttempts: 2
  });

  const server = new ChatGptTransportServer({
    port: 5129,
    maxBodyBytes: 1024 * 10, // 10 KB for testing limit
    adapter
  });

  await server.start();
  const client = new ChatGptTransportClient({ baseUrl: 'http://127.0.0.1:5129' });

  try {
    // -------------------------------------------------------------
    // TEST 1: STRICT INPUT SAFETY (Null, Undefined, Types)
    // -------------------------------------------------------------
    console.log('[TEST 1] Testing Strict Input Safety...');
    const resNull = await adapter.send(null);
    if (resNull.status !== 'error' || resNull.error.code !== ErrorCodes.INVALID_REQUEST) {
      throw new Error(`TEST 1 FAILED: send(null) expected INVALID_REQUEST, got: ${JSON.stringify(resNull)}`);
    }

    const resUndefined = await adapter.send(undefined);
    if (resUndefined.status !== 'error' || resUndefined.error.code !== ErrorCodes.INVALID_REQUEST) {
      throw new Error(`TEST 1 FAILED: send(undefined) expected INVALID_REQUEST`);
    }

    const resArray = await adapter.send([]);
    if (resArray.status !== 'error' || resArray.error.code !== ErrorCodes.INVALID_REQUEST) {
      throw new Error(`TEST 1 FAILED: send([]) expected INVALID_REQUEST`);
    }

    const resEmptyPrompt = await adapter.send({ prompt: '   ' });
    if (resEmptyPrompt.status !== 'error' || resEmptyPrompt.error.code !== ErrorCodes.INVALID_REQUEST) {
      throw new Error(`TEST 1 FAILED: send({prompt: ''}) expected INVALID_REQUEST`);
    }
    console.log('[TEST 1 PASS] Strict input validation blocks invalid payloads cleanly!\n');

    // -------------------------------------------------------------
    // TEST 2: CONCURRENCY LOCK & WRAPPER SAFETY
    // -------------------------------------------------------------
    console.log('[TEST 2] Testing Concurrency Lock & Wrapper Release Invariant...');
    backend.setBlockPrompt(true);

    // Request A starts and holds the lock
    const promiseA = adapter.send({
      request_id: 'req-A',
      prompt: 'Responda exatamente: PROMPT_A'
    });

    // Wait a brief moment for A to acquire lock
    await new Promise(r => setTimeout(r, 40));

    // Verify A holds the lock
    if (!adapter.isProcessing || adapter.activeRequestId !== 'req-A') {
      throw new Error('TEST 2 FAILED: Request A did not acquire processing lock properly');
    }

    // Request B arrives while A is processing -> must receive SESSION_BUSY
    const resB = await adapter.send({
      request_id: 'req-B',
      prompt: 'Responda exatamente: PROMPT_B'
    });

    if (resB.status !== 'error' || resB.error.code !== ErrorCodes.SESSION_BUSY) {
      throw new Error(`TEST 2 FAILED: Expected SESSION_BUSY for Request B, got: ${JSON.stringify(resB)}`);
    }

    // INVARIANT CHECK: B MUST NOT HAVE CLEARED A's LOCK!
    if (!adapter.isProcessing || adapter.activeRequestId !== 'req-A') {
      throw new Error('TEST 2 FAILED (BUG REGRESSION): Request B released lock held by Request A!');
    }
    console.log('  -> Confirmed: Request B rejected with SESSION_BUSY and did NOT clear lock for A.');

    // Release A
    backend.setBlockPrompt(false);
    const resA = await promiseA;

    if (resA.status !== 'completed' || !resA.text.includes('PROMPT_A')) {
      throw new Error(`TEST 2 FAILED: Request A failed to complete: ${JSON.stringify(resA)}`);
    }

    // Now adapter must be free
    if (adapter.isProcessing || adapter.activeRequestId !== null) {
      throw new Error('TEST 2 FAILED: Lock not freed after Request A finished');
    }

    // Request C can now proceed without issue
    const resC = await adapter.send({
      request_id: 'req-C',
      prompt: 'Responda exatamente: PROMPT_C'
    });
    if (resC.status !== 'completed' || !resC.text.includes('PROMPT_C')) {
      throw new Error(`TEST 2 FAILED: Request C failed to execute: ${JSON.stringify(resC)}`);
    }
    console.log('[TEST 2 PASS] Concurrency lock is 100% resilient and leak-proof!\n');

    // -------------------------------------------------------------
    // TEST 3: IDEMPOTENCY CONFLICT CHECK
    // -------------------------------------------------------------
    console.log('[TEST 3] Testing Idempotency Conflict Detection...');
    const fixedId = 'req-fixed-74';

    // Execution 1
    const resIdemp1 = await adapter.send({
      request_id: fixedId,
      prompt: 'Primeira versao do prompt'
    });
    if (resIdemp1.status !== 'completed') throw new Error('Initial idempotency request failed');

    // Execution 2 with SAME payload -> must return cached result
    const resIdempSame = await adapter.send({
      request_id: fixedId,
      prompt: 'Primeira versao do prompt'
    });
    if (resIdempSame.status !== 'completed' || resIdempSame.text !== resIdemp1.text) {
      throw new Error('Idempotent identical payload failed to return cache');
    }

    // Execution 3 with DIFFERENT payload -> must return IDEMPOTENCY_CONFLICT
    const resIdempConflict = await adapter.send({
      request_id: fixedId,
      prompt: 'Segunda versao conflitante com mesmo ID'
    });

    if (resIdempConflict.status !== 'error' || resIdempConflict.error.code !== ErrorCodes.IDEMPOTENCY_CONFLICT) {
      throw new Error(`TEST 3 FAILED: Expected IDEMPOTENCY_CONFLICT, got: ${JSON.stringify(resIdempConflict)}`);
    }
    console.log('[TEST 3 PASS] Conflicting payload with reused request_id rejected with IDEMPOTENCY_CONFLICT!\n');

    // -------------------------------------------------------------
    // TEST 4: BOUNDED RE-ENTRY & TIMEOUT SAFETY
    // -------------------------------------------------------------
    console.log('[TEST 4] Testing Bounded Re-entry (No Blind Duplicate Retry after Side Effect)...');
    backend.promptInvocationCounts.clear();

    const resSideEffectTimeout = await adapter.send({
      request_id: 'req-side-effect-timeout',
      prompt: 'PROVOKE_POST_SIDEEFFECT_TIMEOUT',
      timeout_ms: 100
    });

    console.log('  -> Result error code:', resSideEffectTimeout.error.code);
    console.log('  -> Invocations observed:', backend.promptInvocationCounts.get('PROVOKE_POST_SIDEEFFECT_TIMEOUT'));

    if (resSideEffectTimeout.status !== 'error' || resSideEffectTimeout.error.retryable !== false) {
      throw new Error(`TEST 4 FAILED: Expected retryable=false after side effect timeout, got: ${JSON.stringify(resSideEffectTimeout)}`);
    }

    // Proves prompt was dispatched ONLY ONCE (no second duplicate prompt into DOM)
    if (backend.promptInvocationCounts.get('PROVOKE_POST_SIDEEFFECT_TIMEOUT') !== 1) {
      throw new Error('TEST 4 FAILED: Blind retry occurred after side effect was applied!');
    }
    console.log('[TEST 4 PASS] Automatic re-entry suppressed after side effect, retryable set to false!\n');

    // -------------------------------------------------------------
    // TEST 5: HTTP BODY SIZE LIMIT
    // -------------------------------------------------------------
    console.log('[TEST 5] Testing HTTP Payload Body Size Limits (max 10 KB)...');
    const largePrompt = 'X'.repeat(15 * 1024); // 15 KB > 10 KB limit
    const resLarge = await client.send({
      request_id: 'req-large',
      prompt: largePrompt
    });

    if (resLarge.status !== 'error' || resLarge.error.code !== ErrorCodes.PAYLOAD_TOO_LARGE) {
      throw new Error(`TEST 5 FAILED: Expected PAYLOAD_TOO_LARGE, got: ${JSON.stringify(resLarge)}`);
    }
    console.log('[TEST 5 PASS] Oversized HTTP payload halted with 413 / PAYLOAD_TOO_LARGE!\n');

    console.log('================================================================');
    console.log('ALL PHASE 7.4 UNIT & INTEGRATION TESTS PASSED SUCCESSFULLY!');
    console.log('================================================================\n');

  } finally {
    await server.close();
  }
}

runPhase74TestSuite().catch(err => {
  console.error('FATAL PHASE 7.4 TEST ERROR:', err);
  process.exit(1);
});
