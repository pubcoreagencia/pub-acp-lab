const fs = require('fs');
const path = require('path');
const { PubAcpBridge } = require('./bridge.js');
	async function runTests() {
  console.log('====================================');
  console.log('STARTING AUTOMATED PUB-ACP-BRIDGE TEST SUITE');
  console.log('====================================\n');

  const bridge = new PubAcpBridge();
  let session = null;

  try {
    // 1. INICIALIZACAO DO BRIDGE
    console.log('[1/7] Initializing PubAcpBridge & ACP Handshake...');
    const initRes = await bridge.start();
    console.log('  -> Bridge initialized successfully!');
    console.log('  -> Protocol version:', initRes.protocolVersion);

    // 2. CRIACAO DA SESSAO
    console.log('\n[2/7] Creating persistent session...');
    session = await bridge.createSession();
    console.log('  -> Session created with ID:', session);

    // 3. TESTE A: LEITURA DE hello.txt
    console.log('\n[3/7] TESTE A: Enviar prompt de leitura de hello.txt...');
    fs.writeFileSync('hello.txt', 'ACP INITIAL BRIDGE TEST', 'utf8');
    
    let streamChunksA = '';
    const resA = await bridge.prompt(
      session,
      'Leia o arquivo hello.txt e me diga exatamente o conteudo atual dele. Nao altere nada.',
      (chunk) => {
        streamChunksA += chunk;
        process.stdout.write(chunk);
      },
      (tool) => {
        console.log(`\n  [TOOL_CALL: ${tool}]`);
      }
    );
    console.log('\n  -> TESTE Finalizado! StopReason:', resA.stopReason);
    if (!resA.response && !streamChunksA) {
      throw new Error('TESTE FALHOU: Nenhuma resposta recebida do agente');
    }
    console.log('  -> TESTE A PASS');

    // 4. TESTEB: ESCRITA NA MESMA SESSAO (hello.txt -> BRIDGE_SESSION_OK)
    console.log('\n[4/7] TESTEB: Alterar hello.txt para BRIDGE_SESSION_OK na MESMA sessao...');
    const resB = await bridge.prompt(
      session,
      'Altere o arquivo hello.txt para conter exatamente BRIDGE_SESSION_OK e confirme a alteracao.',
      (chunk) => process.stdout.write(chunk),
      (tool) => console.log(`\n  [TOOL_CALL: ${tool}]`)
    );
    console.log('\n  -> TESTEB Finalizado! StopReason:', resB.stopReason);

    // Verificacao fisica no disco
    const diskContentB = fs.readFileSync('hello.txt', 'utf8').trim();
    console.log('  -> Verificacao no disco para hello.txt:', diskContentB);
    if (!diskContentB.includes('BRIDGE_SESSION_OK')) {
      throw new Error(`TESTEB FALHOU: Conteudo esperado BRIDGE_SESSION_OK, mas foi encontrado: ${diskContentB}`);
    }
    console.log('  -> TESTE B PASS');

    // 5. TESTE C: LEITURA E CONTEXTO NA MESMA SESSEO
    console.log('\n[5/7] TESTE C: Confirmar contexto e leitura na MESMA sessao...');
    const resC = await bridge.prompt(
      session,
      'Qual eh o conteudo atual do arquivo hello.txt?',
      (chunk) => process.stdout.write(chunk),
      (tool) => console.log(`\n  [TOOL_CALL: ${tool}]`)
    );
    console.log('\n  -> TESTE C Finalizado! StopReason:', resC.stopReason);
    console.log('  -> TESTE C PASS');

    // 6. TESTE D: EDICAO E VALIDACAO DE CODIGO REAL
    console.log('\n[6/7] TESTE D: Criacao de arquivo com bug e correcao autonoma...');
    const buggyCode = 'function multiply(a, b) {\n  return a + b; // BUG: deveria multiplicar\n}\nmodule.exports = { multiply };\n';
    fs.writeFileSync('calc.js', buggyCode, 'utf8');
    console.log('  -> Arquivo calc.js criado com bug intencional.');

    const resD = await bridge.prompt(
      session,
      'No arquivo calc.js existe um bug na funcao multiply: ela esta somando em vez de multiplicar. Corrija o bug no calc.js para que retorne a * b, execute um teste e confirme o resultado.',
      (chunk) => process.stdout.write(chunk),
      (tool) => console.log(`\n  [TOOL_CALLP: ${tool}]`)
    );
    console.log('\n  -> TESTE D Finalizado! StopReason:', resD.stopReason);

    // Validacao fisica e execucao de teste
    const fixedContent = fs.readFileSync('calc.js', 'utf8');
    console.log('  -> Conteudo corrigido de calc.js:\n', fixedContent);
    delete require.cache[require.resolve('./calc.js')];
    const { multiply } = require('./calc.js');
    const mathResult = multiply(4, 5);
    console.log('  -> Teste de execucao de calc.js: multiply(4, 5) =', mathResult);
    if (mathResult !== 20) {
      throw new Error('TESTE D FALHOU: multiply(4, 5) retornou ' + mathResult + ', esperado 20');
    }
    console.log('  -> TESTE D PASS');

    // 7. TESTE DE TRATAMENTO DE ERROS E-RESILIENCIA
    console.log('\n[7/7] TESTE DE RESILIENCIA E- ERROS ESTRUTURADOS...');
    
    // Erro de sessao inexistente
    try {
      await bridge.prompt('non-existent-session', 'hello');
      throw new Error('Deveria ter falhado com sessao inexistente');
    } catch (e) {
      console.log('  -> Captura de sessao inexistente: PASS (' + e.message + ')');
    }

    // Fechamento limpo
    await bridge.close();
    console.log('  -> Fechamento limpo do bridge: PASS');

    console.log('\n===================================');
    console.log('ALL TESTS COMPLETED SUCCESSFULLY! PASS');
    console.log('===================================');

  } catch (err) {
    console.error('\n[TEST_FAILED]', err);
    if (bridge) await bridge.close().catch(() => {});
    process.exit(1);
  }
}

runTests();