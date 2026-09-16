/**
 * Phase 7.2 Physical E2E Test
 *
 * Validates the single real physical circuit:
 * CLIENT -> TRANSPORT SERVER -> TRANSPORT ADAPTER -> REAL BROWSER BACKEND
 * -> ISOLATED CHROME -> CDP (9555) -> CHATGPT FREE -> RESPONSE -> CLIENT
 */
const { ChatGptTransportAdapter, ChatGptTransportServer, ChatGptTransportClient } = require('./src/transport');

async function runPhysicalE2E() {
  console.log('================================================================');
  console.log('STARTING PHASE 7.2 PHYSICAL E2E INTEGRATION TEST');
  console.log('Target: Isolated Chrome CDP (127.0.0.1:9555) -> Real ChatGPT Free');
  console.log('================================================================\n');

  const serverPort = 5127;
  const { IsolatedBrowserManager } = require('./src/isolated-browser/browser-manager.js');
  const path = require('path');
  const browserManager = new IsolatedBrowserManager({
    port: 9555,
    profileDir: path.resolve(process.cwd(), 'isolated_profile')
  });

  console.log('  -> Ensuring isolated Chrome is launched on port 9555...');
  await browserManager.launch();
  if (!browserManager.pageTarget.url.includes('chatgpt.com')) {
    console.log('  -> Navigating explicitly to https://chatgpt.com...');
    await browserManager.navigate('https://chatgpt.com');
  }
  const auth = await browserManager.detectAuthState();
  console.log('  -> Auth State detected:', auth);
  if (!auth.isLoggedIn) {
    console.error('CHATGPT_LOGIN_REQUIRED');
    process.exit(2);
  }

  const { ChatGptDriver } = require('./src/isolated-browser/chatgpt-driver.js');
  const driver = new ChatGptDriver(browserManager.cdp);
  console.log('  -> Aguardando prontidao deterministica do editor (#prompt-textarea)...');
  const inputReady = await driver._waitForInput(20000);
  if (!inputReady) {
    throw new Error('Timeout: #prompt-textarea nao ficou disponivel na pagina do ChatGPT');
  }
  console.log('  -> Editor estabilizado e disponivel no DOM.');

  // Manter janela isolada ativa e em primeiro plano durante o envio fisico
  console.log('  -> Garantindo janela isolada ativa e em primeiro plano...');
  await browserManager.bringToFront();

  const transportAdapter = new ChatGptTransportAdapter({
    port: 9555,
    browserManager
  });
  transportAdapter.on('log', msg => console.log('  [TRANSPORT]', msg));

  const transportServer = new ChatGptTransportServer({
    port: serverPort,
    adapter: transportAdapter
  });

  console.log('[1/4] Starting Transport Server on port', serverPort);
  await transportServer.start();
  console.log('  -> Transport server running on http://127.0.0.1:' + serverPort);

  // Garantir que a janela isolada esteja ativa/foreground durante o envio fisico
  console.log('  -> Mantendo janela isolada ativa e em primeiro plano para submissao fisica...');
  await browserManager.bringToFront();

  const client = new ChatGptTransportClient({ baseUrl: `http://127.0.0.1:${serverPort}` });

  try {
    console.log('[2/4] Checking Transport Health...');
    const health = await client.health();
    console.log('  -> Health status:', health);
    if (health.status !== 'ok' || !health.initialized) {
      throw new Error(`Transport not healthy: ${JSON.stringify(health)}`);
    }

    console.log('[3/4] Sending short deterministic physical prompt to real ChatGPT Free...');
    const targetToken = 'PHASE7_2_PHYSICAL_OK';
    const res = await client.send({
      request_id: 'req-physical-e2e',
      prompt: `Responda exatamente: ${targetToken}`,
      timeout_ms: 120000
    });

    console.log('[4/4] Verifying physical response received from real ChatGPT Free:');
    console.log('  -> Response payload:', res);

    if (res.status !== 'completed') {
      throw new Error(`Physical test failed with status ${res.status}: ${JSON.stringify(res.error)}`);
    }

    if (!res.text || !res.text.includes(targetToken)) {
      throw new Error(`Physical response mismatch! Expected to contain "${targetToken}", got: "${res.text}"`);
    }

    console.log('\n================================================================');
    console.log('PHASE 7.2 PHYSICAL E2E TEST: PASS');
    console.log(`Verified output token: ${targetToken}`);
    console.log('REAL CHATGPT FREE -> CDP -> TRANSPORT ADAPTER -> TRANSPORT SERVER -> CLIENT');
    console.log('================================================================\n');

  } finally {
    console.log('[CLEANUP] Shutting down transport server...');
    await transportServer.close();
  }
}

runPhysicalE2E().catch(err => {
  console.error('\nFATAL PHYSICAL E2E ERROR:', err);
  process.exit(1);
});
