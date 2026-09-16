const path = require('path');
const { IsolatedBrowserManager } = require('./src/isolated-browser/browser-manager.js');
const { ChatGptDriver } = require('./src/isolated-browser/chatgpt-driver.js');
const { ChatGptTransportAdapter, ErrorCodes } = require('./src/transport');

async function runPhysicalRecoveryTest() {
  console.log('================================================================');
  console.log('STARTING PHASE 7.4 PHYSICAL CDP RECOVERY TEST');
  console.log('Target: Real Isolated Chrome CDP (127.0.0.1:9555) -> ChatGPT Free');
  console.log('================================================================\n');

  const browserManager = new IsolatedBrowserManager({
    port: 9555,
    profileDir: path.resolve(process.cwd(), 'isolated_profile')
  });

  console.log('[STAGE 1] Ensuring isolated Chrome is launched on port 9555...');
  await browserManager.launch();

  if (!browserManager.pageTarget.url.includes('chatgpt.com')) {
    await browserManager.navigate('https://chatgpt.com');
  }

  const auth = await browserManager.detectAuthState();
  if (!auth.isLoggedIn) {
    console.error('CHATGPT_LOGIN_REQUIRED');
    process.exit(2);
  }

  const driver = new ChatGptDriver(browserManager.cdp);
  console.log('  -> Verificando prontidão do editor (#prompt-textarea)...');
  await driver._waitForInput(20000);

  console.log('  -> Mantendo janela isolada ativa e em primeiro plano...');
  await browserManager.bringToFront();

  console.log('[STAGE 1] Isolated Chrome ready and authenticated.');

  const adapter = new ChatGptTransportAdapter({
    port: 9555,
    browserManager,
    maxRetryAttempts: 2
  });
  adapter.on('log', msg => console.log('  [ADAPTER LOG]', msg));

  await adapter.initialize();
  await browserManager.bringToFront();

  try {
    // 1. Initial baseline request
    console.log('\n[STAGE 2] Executing baseline request before simulated disconnect...');
    const res1 = await adapter.send({
      request_id: 'req-recovery-baseline',
      prompt: 'Responda exatamente: RECOVERY_BASELINE_OK',
      timeout_ms: 120000
    });
    console.log('[STAGE 2] Baseline response received:', res1);
    if (res1.status !== 'completed' || !res1.text.includes('RECOVERY_BASELINE_OK')) {
      throw new Error(`Baseline physical request failed: ${JSON.stringify(res1)}`);
    }
    console.log('[STAGE 2 PASS] Baseline request passed!');

    // 2. Deliberately sever the physical CDP WebSocket connection
    console.log('\n[STAGE 3] Deliberately terminating active CDP socket connection...');
    if (browserManager.cdp && browserManager.cdp.socket) {
      browserManager.cdp.socket.destroy(); // Hard destroy of physical socket
      console.log('  -> CDP socket destroyed explicitly!');
    }

    // Small delay to let OS socket close register
    await new Promise(r => setTimeout(r, 600));

    // Verify socket is closed
    const healthAfterSever = await adapter.recovery.checkHealth();
    console.log('  -> Health status immediately after severed socket:', healthAfterSever);
    if (healthAfterSever.cdp_connected) {
      throw new Error('CDP socket still reported connected after hard destroy');
    }

    // Ensure window active for the second submission
    await browserManager.bringToFront();

    // 3. Trigger auto-recovery via next request
    console.log('\n[STAGE 4] Sending subsequent request to trigger auto-recovery...');
    const res2 = await adapter.send({
      request_id: 'req-recovery-restored',
      prompt: 'Responda exatamente: RECOVERY_SUCCESS_OK',
      timeout_ms: 120000
    });

    console.log('[STAGE 4] Response received after recovery:');
    console.log(res2);

    if (res2.status !== 'completed' || !res2.text.includes('RECOVERY_SUCCESS_OK')) {
      throw new Error(`Physical recovery failed: ${JSON.stringify(res2)}`);
    }

    const lastRec = adapter.recovery.getLastRecovery();
    console.log('  -> Verified recovery record:', lastRec ? lastRec.actions : 'No record');

    console.log('\n================================================================');
    console.log('PHASE 7.4 PHYSICAL RECOVERY TEST: PASS');
    console.log('Socket severed -> Auto-recovered via bm.reconnect() -> Prompt succeeded!');
    console.log('================================================================\n');

  } finally {
    if (browserManager.cdp) {
      browserManager.cdp.close();
    }
  }
}

runPhysicalRecoveryTest().catch(err => {
  console.error('\nFATAL PHYSICAL RECOVERY ERROR:', err);
  process.exit(1);
});
