const path = require('path');
const { ChatGptTransportAdapter, ChatGptTransportServer, ChatGptTransportClient, FakeChatGptBackend, ErrorCodes } = require('./src/transport');

async function runTransportTestSuite() {
  console.log('================================================================');
  console.log('STARTING PHASE 7.2 TRANSPORT REUSABILITY TEST SUITE (DETERMINISTIC)');
  console.log('Scope: Reusable Local Programmatic Transport Contract (Injected Fake Backend)');
  console.log('================================================================\n');

  const serverPort = 5126;
  const fakeBackend = new FakeChatGptBackend();
  const transportServer = new ChatGptTransportServer({
    port: serverPort,
    adapter: new ChatGptTransportAdapter({ backend: fakeBackend })
  });

  console.log('[SETUP] Starting ChatGptTransportServer with FakeChatGptBackend on port', serverPort);
  await transportServer.start();
  console.log('[SETUP] Transport server ready on http://127.0.0.1:' + serverPort);

  const client = new ChatGptTransportClient({ baseUrl: `http://127.0.0.1:${serverPort}` });

  // Verify health endpoint
  const health = await client.health();
  console.log('[SETUP] Health status:', health);
  if (health.status !== 'ok') throw new Error('Health check failed');

  try {
    // ------------------------------------------------------------------
    // TEST 4: Invalid Request Handling (Contract & Error Structure)
    // ------------------------------------------------------------------
    console.log('\n----------------------------------------------------------------');
    console.log('[TEST 4] Invalid Request handling (Empty prompt)...');
    const resInvalid = await client.send({ prompt: '' });
    console.log('[TEST 4] Result:', resInvalid);
    if (resInvalid.status !== 'error' || resInvalid.error.code !== ErrorCodes.INVALID_REQUEST) {
      throw new Error(`TEST 4 FAILED: Expected INVALID_REQUEST error, got: ${JSON.stringify(resInvalid)}`);
    }
    console.log('[TEST 4 PASS] Structured INVALID_REQUEST returned cleanly!');

    // ------------------------------------------------------------------
    // TEST 1: Simple Request / New Session
    // ------------------------------------------------------------------
    console.log('\n----------------------------------------------------------------');
    console.log('[TEST 1] New Simple Request: "Responda exatamente: TRANSPORT_TEST_1_OK"');
    const res1 = await client.send({
      request_id: 'req-t1',
      prompt: 'Responda exatamente: TRANSPORT_TEST_1_OK'
    });
    console.log('[TEST 1] Response received:');
    console.log(res1);

    if (res1.status !== 'completed' || !res1.text.includes('TRANSPORT_TEST_1_OK')) {
      throw new Error(`TEST 1 FAILED: Expected status completed with text TRANSPORT_TEST_1_OK, got: ${JSON.stringify(res1)}`);
    }
    if (!res1.session_id) {
      throw new Error('TEST 1 FAILED: No session_id returned in completed response');
    }
    const session1Id = res1.session_id;
    console.log(`[TEST 1 PASS] Response completed! Created session: ${session1Id}`);

    // ------------------------------------------------------------------
    // TEST 2: Continuation in Same Session (Context Preservation)
    // ------------------------------------------------------------------
    console.log('\n----------------------------------------------------------------');
    console.log(`[TEST 2] Continuing Session ${session1Id} - Storing secret code...`);
    const res2_1 = await client.send({
      request_id: 'req-t2-store',
      session_id: session1Id,
      prompt: 'Memorize o seguinte token de transporte: TRANSPORT_SECRET_981'
    });
    console.log('[TEST 2 - Step 1] Response:', res2_1.text);
    if (res2_1.status !== 'completed') {
      throw new Error(`TEST 2 Step 1 FAILED: ${JSON.stringify(res2_1)}`);
    }

    console.log(`[TEST 2] Continuing Session ${session1Id} - Querying stored code...`);
    const res2_2 = await client.send({
      request_id: 'req-t2-query',
      session_id: session1Id,
      prompt: 'Qual foi o token de transporte que você acabou de memorizar? Responda somente o token.'
    });
    console.log('[TEST 2 - Step 2] Response:', res2_2.text);
    if (res2_2.status !== 'completed' || !res2_2.text.includes('TRANSPORT_SECRET_981')) {
      throw new Error(`TEST 2 FAILED: Expected context TRANSPORT_SECRET_981, got: ${res2_2.text}`);
    }
    console.log('[TEST 2 PASS] Multi-turn session continuation preserved context perfectly!');

    // ------------------------------------------------------------------
    // TEST 3: Long Response (No Truncation)
    // ------------------------------------------------------------------
    console.log('\n----------------------------------------------------------------');
    console.log(`[TEST 3] Long response in Session ${session1Id} (20 numbered lines)...`);
    const res3 = await client.send({
      request_id: 'req-t3',
      session_id: session1Id,
      prompt: 'Responda com exatamente 20 linhas numeradas de 1 a 20. Não adicione texto antes ou depois.'
    });
    console.log('[TEST 3] Response received:');
    console.log(res3.text);

    const lines3 = res3.text.split('\n').map(l => l.trim()).filter(Boolean);
    console.log(`[TEST 3] Lines detected: ${lines3.length}`);
    if (lines3.length < 20 || !res3.text.includes('1') || !res3.text.includes('20')) {
      throw new Error(`TEST 3 FAILED: Long response truncated or incomplete (${lines3.length} lines)`);
    }
    console.log('[TEST 3 PASS] Full 20 lines captured without truncation!');

    // ------------------------------------------------------------------
    // TEST 5: Session Concurrency Conflict / Busy Guard
    // ------------------------------------------------------------------
    console.log('\n----------------------------------------------------------------');
    console.log('[TEST 5] Concurrency safety guard test...');
    // Manually trigger a concurrent request while another is active
    transportServer.adapter.isProcessing = true;
    const resBusy = await client.send({
      request_id: 'req-busy',
      prompt: 'Simulated concurrent request'
    });
    transportServer.adapter.isProcessing = false;
    console.log('[TEST 5] Result:', resBusy);
    if (resBusy.status !== 'error' || resBusy.error.code !== ErrorCodes.SESSION_BUSY) {
      throw new Error(`TEST 5 FAILED: Expected SESSION_BUSY error, got: ${JSON.stringify(resBusy)}`);
    }
    console.log('[TEST 5 PASS] Concurrent access blocked safely with deterministic SESSION_BUSY error!');

    // ------------------------------------------------------------------
    // TEST 6: Explicit Timeout Handling
    // ------------------------------------------------------------------
    console.log('\n----------------------------------------------------------------');
    console.log('[TEST 6] Timeout handling with ultra-short limit (100ms)...');
    const resTimeout = await client.send({
      request_id: 'req-timeout',
      prompt: 'Responda algo longo',
      timeout_ms: 100 // artificially short to trigger timeout safely
    });
    console.log('[TEST 6] Result:', resTimeout);
    if (resTimeout.status !== 'error' || resTimeout.error.code !== ErrorCodes.TIMEOUT) {
      throw new Error(`TEST 6 FAILED: Expected TIMEOUT error, got: ${JSON.stringify(resTimeout)}`);
    }
    console.log('[TEST 6 PASS] Deterministic clean TIMEOUT error returned without crashing!');

    // ------------------------------------------------------------------
    // TEST 7: Multiple Sequential Sessions (Context Isolation)
    // ------------------------------------------------------------------
    console.log('\n----------------------------------------------------------------');
    console.log('[TEST 7] Multiple sequential fresh sessions (isolation test)...');
    const resSessionA = await client.send({
      request_id: 'req-sess-a',
      prompt: 'Meu número favorito é 441122. Responda OK.'
    });
    const sidA = resSessionA.session_id;

    const resSessionB = await client.send({
      request_id: 'req-sess-b',
      prompt: 'Qual é o meu número favorito? Se não sabe, responda NAO_SEI.'
    });
    const sidB = resSessionB.session_id;

    console.log(`[TEST 7] Session A (${sidA}) vs Session B (${sidB})`);
    console.log('[TEST 7] Session B response:', resSessionB.text);
    if (sidA === sidB) {
      throw new Error('TEST 7 FAILED: Two fresh requests shared the same session_id');
    }
    if (resSessionB.text.includes('441122')) {
      throw new Error('TEST 7 FAILED: Context leaked across separate sessions');
    }
    console.log('[TEST 7 PASS] Multiple sequential sessions are completely isolated!');

    console.log('\n================================================================');
    console.log('ALL PHASE 7.2 TRANSPORT TESTS (TEST 1 to 7) PASSED SUCCESSFULLY!');
    console.log('================================================================\n');

  } finally {
    await transportServer.close();
  }
}

runTransportTestSuite().catch(err => {
  console.error('FATAL TEST ERROR:', err);
  process.exit(1);
});
