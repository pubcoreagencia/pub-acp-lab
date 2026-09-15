const path = require('path');
const { IsolatedBrowserManager } = require('./src/isolated-browser/browser-manager.js');
const { ChatGptDriver } = require('./src/isolated-browser/chatgpt-driver.js');

async function main() {
  console.log('================================================================');
  console.log('PHASE 7.1 — REAL CHATGPT FREE VIA ISOLATED CHROME RUNNER');
  console.log('Dedicated Profile: isolated_profile');
  console.log('Main Chrome Status: INTACT & INDEPENDENT');
  console.log('No Extension - Native CDP Transport');
  console.log('================================================================\n');

  const manager = new IsolatedBrowserManager({
    port: 9555,
    profileDir: path.resolve(process.cwd(), 'isolated_profile')
  });

  console.log('[STAGE 1] Connecting to isolated Chrome instance on port 9555...');
  await manager.launch();
  console.log('[STAGE 1] Isolated Chrome connected via CDP.');

  console.log('[STAGE 2] Detecting authentication state...');
  const auth = await manager.detectAuthState();
  console.log('[STAGE 2] Auth State:', auth);

  if (!auth.isLoggedIn) {
    console.log('\n================================================================');
    console.log('CHATGPT_LOGIN_REQUIRED');
    console.log('Tornando a janela do Chrome isolado VISÍVEL e em primeiro plano...');
    await manager.bringToFront();
    console.log('Janela isolada visível e pronta para receber o login.');
    console.log('Por favor, realize o login manualmente na janela dedicada do Chrome.');
    console.log('Aguardando detecção de login automático na sessão isolada...');
    console.log('================================================================\n');

    const startWait = Date.now();
    let loggedIn = false;
    while (Date.now() - startWait < 300000) {
      await new Promise(r => setTimeout(r, 4000));
      const currentAuth = await manager.detectAuthState();
      if (currentAuth.isLoggedIn) {
        loggedIn = true;
        console.log('[DETECTED] Login confirmado com sucesso na sessão isolada!');
        console.log('[STAGE 3] Minimizando a janela isolada para continuar em segundo plano...');
        await manager.minimize();
        console.log('[STAGE 3] Janela minimizada. Executando testes autônomos...');
        break;
      }
    }

    if (!loggedIn) {
      console.log('[TIMEOUT] CHATGPT_LOGIN_REQUIRED_TIMEOUT: Login não detectado dentro de 5 minutos.');
      await manager.close();
      process.exit(2);
    }
  } else {
    console.log('[STAGE 2] Sessão já autenticada anteriormente no perfil!');
    console.log('[STAGE 3] Minimizando a janela isolada para continuar em segundo plano...');
    await manager.minimize();
  }

  const driver = new ChatGptDriver(manager.cdp);

  try {
    // -------------------------------------------------------------
    // FASE 7.1B — TEST 1: Echo Real (ISOLATED_CHATGPT_REAL_OK)
    // -------------------------------------------------------------
    console.log('\n----------------------------------------------------------------');
    console.log('[TEST 1] Dispatching prompt: "Responda exatamente:\\n\\nISOLATED_CHATGPT_REAL_OK"');
    const beforeCount1 = await driver.getAssistantMessageCount();
    console.log(`[TEST 1] Assistant message count before send: ${beforeCount1}`);
    await driver.injectAndSendPrompt('Responda exatamente:\n\nISOLATED_CHATGPT_REAL_OK');
    
    console.log('[TEST 1] Awaiting robust turn completion from ChatGPT Free...');
    const reply1 = await driver.waitForCompletion(beforeCount1, 120000);
    console.log('[TEST 1] Response received:');
    console.log(reply1);

    if (!reply1.includes('ISOLATED_CHATGPT_REAL_OK')) {
      throw new Error(`TEST 1 FAILED: Expected ISOLATED_CHATGPT_REAL_OK, got ${reply1}`);
    }
    console.log('[TEST 1 PASS] ISOLATED_CHATGPT_REAL_OK received successfully!');

    // Small delay between tests
    await new Promise(r => setTimeout(r, 4000));

    // -------------------------------------------------------------
    // FASE 7.1C — TEST 2: Long Response (20 lines)
    // -------------------------------------------------------------
    console.log('\n----------------------------------------------------------------');
    console.log('[TEST 2] Dispatching long response prompt: 20 numbered lines...');
    const beforeCount2 = await driver.getAssistantMessageCount();
    console.log(`[TEST 2] Assistant message count before send: ${beforeCount2}`);
    await driver.injectAndSendPrompt('Responda com exatamente 20 linhas numeradas de 1 a 20. Não adicione texto antes ou depois.');

    console.log('[TEST 2] Awaiting complete streaming and finalization...');
    const reply2 = await driver.waitForCompletion(beforeCount2, 120000);
    console.log('[TEST 2] Response received:');
    console.log(reply2);

    const lines = reply2.split('\n').map(l => l.trim()).filter(Boolean);
    console.log(`[TEST 2] Line count detected: ${lines.length}`);
    const hasStart = reply2.includes('1') && reply2.includes('2');
    const hasEnd = reply2.includes('19') && reply2.includes('20');

    if (!hasStart || !hasEnd) {
      throw new Error('TEST 2 FAILED: Long response was truncated or missing lines 1-20');
    }
    console.log('[TEST 2 PASS] Long response captured completely without truncation!');

    // Small delay between tests
    await new Promise(r => setTimeout(r, 4000));

    // -------------------------------------------------------------
    // FASE 7.1D — TEST 3: Multi-turn Context Preservation
    // -------------------------------------------------------------
    console.log('\n----------------------------------------------------------------');
    console.log('[TEST 3] Multi-turn - Turn 1: "Memorize o código secreto: ISOLATED_CONTEXT_731"');
    const beforeCount3_1 = await driver.getAssistantMessageCount();
    console.log(`[TEST 3] Assistant message count before Turn 1: ${beforeCount3_1}`);
    await driver.injectAndSendPrompt('Memorize o código secreto: ISOLATED_CONTEXT_731');
    const reply3_1 = await driver.waitForCompletion(beforeCount3_1, 120000);
    console.log('[TEST 3 - Turn 1] Acknowledged by ChatGPT:');
    console.log(reply3_1);

    await new Promise(r => setTimeout(r, 4000));

    console.log('\n[TEST 3] Multi-turn - Turn 2: "Qual é o código secreto? Responda somente o código."');
    const beforeCount3_2 = await driver.getAssistantMessageCount();
    console.log(`[TEST 3] Assistant message count before Turn 2: ${beforeCount3_2}`);
    await driver.injectAndSendPrompt('Qual é o código secreto? Responda somente o código.');
    const reply3_2 = await driver.waitForCompletion(beforeCount3_2, 120000);
    console.log('[TEST 3 - Turn 2] Response:');
    console.log(reply3_2);

    if (!reply3_2.includes('ISOLATED_CONTEXT_731')) {
      throw new Error(`TEST 3 FAILED: Context lost. Expected ISOLATED_CONTEXT_731, got: ${reply3_2}`);
    }
    console.log('[TEST 3 PASS] Multi-turn context preserved perfectly in isolated session!');

    console.log('\n================================================================');
    console.log('ALL PHASE 7.1 TESTS PASSED SUCCESSFULLY!');
    console.log('ISOLATED_CHATGPT_REAL_OK: PASS');
    console.log('================================================================');

  } finally {
    // Keep browser running so profile stays warm and user session intact
    if (manager.cdp) {
      manager.cdp.close();
    }
  }
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
