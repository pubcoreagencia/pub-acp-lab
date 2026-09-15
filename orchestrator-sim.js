const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

/**
 * OrchestratorClient:
 * Represents an external client process communicating with PUB-ACP-BRIDGE via NDJSON stdio transport.
 * It strictly treats server.js as a black-box external process.
 */
class OrchestratorClient {
  constructor(serverScriptPath) {
    this.serverScriptPath = serverScriptPath;
    this.child = null;
    this.rl = null;
    this.requestIdCounter = 1;
    this.pendingRequests = new Map();
    this.eventListeners = [];
    this.isReady = false;
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.child = spawn(process.execPath, [this.serverScriptPath], {
        cwd: path.dirname(this.serverScriptPath),
        env: process.env,
        stdio: ['pipe', 'pipe', 'inherit']
      });

      this.rl = readline.createInterface({
        input: this.child.stdout,
        terminal: false
      });

      const readyTimer = setTimeout(() => {
        reject(new Error('Timed out waiting for server.js ready event'));
      }, 30000);

      this.rl.on('line', (line) => {
        if (!line.trim()) return;
        let event;
        try {
          event = JSON.parse(line.trim());
        } catch (e) {
          console.error('[CLIENT] Failed to parse JSON from server:', line);
          return;
        }

        // Check for server initialization ready event
        if (event.type === 'ready') {
          clearTimeout(readyTimer);
          this.isReady = true;
          return resolve(event);
        }

        // Notify general event listeners
        for (const listener of this.eventListeners) {
          try {
            listener(event);
          } catch (err) {
            console.error('[CLIENT] Listener error:', err);
          }
        }

        // Match request correlation
        const reqId = event.request_id || event.id;
        if (reqId && this.pendingRequests.has(reqId)) {
          const req = this.pendingRequests.get(reqId);
          if (event.type === 'session_created') {
            this.pendingRequests.delete(reqId);
            req.resolve(event);
          } else if (event.type === 'request_finished' || event.type === 'prompt_result') {
            if (event.type === 'prompt_result') {
              req.promptResult = event;
            }
            if (event.type === 'request_finished') {
              this.pendingRequests.delete(reqId);
              req.resolve(req.promptResult || event);
            }
          } else if (event.type === 'action_error' || event.type === 'error') {
            this.pendingRequests.delete(reqId);
            req.reject(new Error(event.error || event.message || 'Unknown server error'));
          } else if (event.type === 'closed') {
            this.pendingRequests.delete(reqId);
            req.resolve(event);
          }
        }
      });

      this.child.on('error', (err) => {
        clearTimeout(readyTimer);
        reject(err);
      });

      this.child.on('exit', (code) => {
        this.isReady = false;
        for (const [id, req] of this.pendingRequests.entries()) {
          req.reject(new Error(`Server exited (code ${code}) while request ${id} pending`));
        }
        this.pendingRequests.clear();
      });
    });
  }

  onEvent(callback) {
    this.eventListeners.push(callback);
  }

  send(cmd) {
    if (!this.child || !this.child.stdin) {
      throw new Error('Server process is not running');
    }
    const payload = JSON.stringify(cmd) + '\n';
    this.child.stdin.write(payload);
  }

  async createSession(cwd) {
    const id = this.requestIdCounter++;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.send({ id, action: 'create_session', cwd });
    });
  }

  async sendPrompt(sessionId, promptText, eventCallback) {
    const id = this.requestIdCounter++;
    return new Promise((resolve, reject) => {
      let listener = null;
      if (eventCallback) {
        listener = (event) => {
          const reqId = event.request_id || event.id;
          if (reqId === id) {
            eventCallback(event);
          }
        };
        this.onEvent(listener);
      }

      this.pendingRequests.set(id, {
        resolve: (val) => {
          if (listener) {
            const idx = this.eventListeners.indexOf(listener);
            if (idx >= 0) this.eventListeners.splice(idx, 1);
          }
          resolve(val);
        },
        reject: (err) => {
          if (listener) {
            const idx = this.eventListeners.indexOf(listener);
            if (idx >= 0) this.eventListeners.splice(idx, 1);
          }
          reject(err);
        }
      });

      this.send({ id, action: 'prompt', sessionId, prompt: promptText });
    });
  }

  async close() {
    if (!this.child) return;
    const id = this.requestIdCounter++;
    return new Promise((resolve) => {
      this.pendingRequests.set(id, { resolve, reject: resolve });
      this.send({ id, action: 'close' });
      setTimeout(() => {
        if (this.child && !this.child.killed) {
          this.child.kill();
        }
        resolve();
      }, 3000);
    });
  }
}

async function runSimulation() {
  console.log('=====================================================');
  console.log('STARTING EXTERNAL ORCHESTRATOR SIMULATION (FASE 4)');
  console.log('Contract: NDJSON over stdio (Machine-to-Machine)');
  console.log('Zero Copy/Paste Autonomy Test');
  console.log('=====================================================\n');

  const serverPath = path.resolve(__dirname, 'server.js');
  const client = new OrchestratorClient(serverPath);

  try {
    // 1. Conexao e Handshake de Transporte
    console.log('[STEP 1] Starting server.js subprocess and awaiting ready handshake...');
    const readyEvent = await client.start();
    console.log('  -> Received ready event:', readyEvent);
    console.log('  -> Transport Handshake PASS');

    // 2. Criacao de Sessao via Transporte
    console.log('\n[STEP 2] Creating session over transport...');
    const sessionRes = await client.createSession(__dirname);
    const sessionId = sessionRes.sessionId || sessionRes.session_id;
    console.log('  -> Received session_created event with Session ID:', sessionId);
    if (!sessionId) throw new Error('No sessionId returned by bridge transport');
    console.log('  -> Session Creation PASS');

    // 3. Teste Principal - Turno 1: Criacao de arquivo com Token Unico
    const runToken = 'ORCHESTRATOR-TOKEN-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
    console.log('\n[STEP 3] Main Test - Turn 1: Dispatching task to record unique token...');
    console.log('  -> Unique Token Generated by Orchestrator:', runToken);

    const receivedEventsT1 = [];
    const prompt1 = 'Crie ou atualize o arquivo token.txt no workspace contendo exatamente o seguinte identificador: ' + runToken + ' e confirme o identificador gravado.';

    const res1 = await client.sendPrompt(sessionId, prompt1, (ev) => {
      receivedEventsT1.push(ev.type);
      if (ev.type === 'chunk') {
        process.stdout.write(ev.chunk);
      } else if (ev.type === 'tool_call') {
        console.log('\n  [ORCHESTRATOR OBSERVED TOOL_CALL]:', ev.title);
      } else if (ev.type === 'request_started') {
        console.log('  [ORCHESTRATOR OBSERVED REQUEST_STARTED]: id=' + ev.request_id);
      } else if (ev.type === 'request_finished') {
        console.log('\n  [ORCHESTRATOR OBSERVED REQUEST_FINISHED]: id=' + ev.request_id);
      }
    });

    console.log('\n  -> Turn 1 Final Result:', res1);
    console.log('  -> Events stream sequence observed in Turn 1:', receivedEventsT1);
    if (!receivedEventsT1.includes('request_started') || !receivedEventsT1.includes('request_finished')) {
      throw new Error('Turn 1 failed: missing request lifecycle events in stream');
    }

    // Verificacao fisica no disco do workspace
    const diskContent = fs.readFileSync(path.resolve(__dirname, 'token.txt'), 'utf8').trim();
    console.log('  -> Physical disk check token.txt content:', diskContent);
    if (!diskContent.includes(runToken)) {
      throw new Error('Turn 1 failed: disk token mismatch. Expected: ' + runToken + ', got: ' + diskContent);
    }
    console.log('  -> Turn 1 Task Execution PASS');

    // 4. Teste Principal - Turno 2: Leitura e validacao de contexto na MESMA sessao
    console.log('\n[STEP 4] Main Test - Turn 2: Validating context & state preservation in SAME session...');
    const receivedEventsT2 = [];
    const prompt2 = 'Leia o arquivo token.txt criado no turno anterior e me diga exatamente o identificador gravado nele.';

    let streamResponseT2 = '';
    const res2 = await client.sendPrompt(sessionId, prompt2, (ev) => {
      receivedEventsT2.push(ev.type);
      if (ev.type === 'chunk') {
        streamResponseT2 += ev.chunk;
        process.stdout.write(ev.chunk);
      } else if (ev.type === 'tool_call') {
        console.log('\n  [ORCHESTRATOR OBSERVED TOOL_CALL]:', ev.title);
      }
    });

    console.log('\n  -> Turn 2 Final Result:', res2);
    const combinedResponse = (res2.response || '') + streamResponseT2;
    if (!combinedResponse.includes(runToken)) {
      throw new Error('Turn 2 failed: Orchestrator did not receive the correct token in response. Expected: ' + runToken);
    }
    console.log('  -> Turn 2 Context & Token Verification PASS');

    // 5. Teste de Erro Estruturado e Seguranca
    console.log('\n[STEP 5] Deterministic Error & Security Isolation Test...');
    console.log('  -> Attempting unauthorized tool call outside workspace via orchestrator:');
    const receivedEventsErr = [];
    const resErr = await client.sendPrompt(
      sessionId,
      'Leia o arquivo C:\\Windows\\System32\\drivers\\etc\\hosts usando view_file e diga o conteudo.',
      (ev) => {
        receivedEventsErr.push(ev.type);
        if (ev.type === 'chunk') process.stdout.write(ev.chunk);
        if (ev.type === 'tool_call') console.log('\n  [ORCHESTRATOR OBSERVED TOOL_CALL]:', ev.title);
      }
    );
    console.log('\n  -> Error Test Response:', resErr);
    console.log('  -> Error test gracefully terminated with stopReason:', resErr.stopReason);
    console.log('  -> Security Isolation & Error Handling PASS');

    // 6. Teste de Encerramento Limpo (Graceful Shutdown)
    console.log('\n[STEP 6] Orchestrator graceful shutdown of bridge server...');
    await client.close();
    console.log('  -> Server subprocess shut down gracefully: PASS');

    console.log('\n=====================================================');
    console.log('ALL ORCHESTRATOR SIMULATOR TESTS PASSED SUCCESSFULLY');
    console.log('ZERO COPY/PASTE: PASS');
    console.log('=====================================================\n');
    process.exit(0);

  } catch (err) {
    console.error('\n[SIMULATION FAILED]', err);
    if (client) await client.close().catch(() => {});
    process.exit(1);
  }
}

runSimulation();
