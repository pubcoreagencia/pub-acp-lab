const readline = require('readline');
const { PubAcpBridge } = require('./bridge.js');
	async function main() {
  const bridge = new PubAcpBridge();

  function sendOut(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }

  bridge.on('log', (data) => {
    sendOut({ type: 'log', data });
  });

  bridge.on('error', (err) => {
    sendOut({ type: 'error', error: err });
  });

  try {
    await bridge.start();
    sendOut({ type: 'ready', status: 'OK', protocol: 'PUB-ACP-BRIDGE/1.0' });
  } catch (err) {
    sendOut({ type: 'fatal', message: err.message });
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let cmd;
    try {
      cmd = JSON.parse(line.trim());
    } catch (e) {
      sendOut({ type: 'error', error: 'INVALID_JSON', raw: line });
      return;
    }

    const { id, action, sessionId, prompt: promptText, cwd } = cmd;

    try {
      if (action === 'create_session') {
        const sid = await bridge.createSession(cwd);
        sendOut({ id, type: 'session_created', sessionId: sid });
      } else if (action === 'prompt') {
        if (!sessionId || !promptText) {
          sendOut({ id, type: 'error', error: 'MISSING_PARAMS', message: 'sessionId and prompt are required' });
          return;
        }

        const res = await bridge.prompt(
          sessionId,
          promptText,
          (chunk) => {
            sendOut({ id, type: 'chunk ', sessionId, chunk });
          },
          (title, toolInput) => {
            sendOut({ id, type: 'tool_call', sessionId, title, toolInput });
          }
        );

        sendOut({
          id,
          type: 'prompt_result',
          sessionId,
          stopReason: res.stopReason,
          response: res.response
        });
      } else if (action === 'close') {
        await bridge.close();
        sendOut({ id, type: 'closed' });
        process.exit(0);
      } else {
        sendOut({ id, type: 'error', error: 'UNKNOWN_ACTION', action });
      }
    } catch (err) {
      sendOut({ id, type: 'action_error', error: err.message });
    }
  });

  process.on('SIGTERM', async () => {
    await bridge.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[BRIDGE_FATAL]', err);
  process.exit(1);
});