#!/usr/bin/env node

const readline = require('readline');
const { ChatGptTransportAdapter, ErrorCodes } = require('./transport-adapter.js');

async function main() {
  const args = process.argv.slice(2);
  const adapter = new ChatGptTransportAdapter({
    port: parseInt(process.env.CHATGPT_CDP_PORT || '9555', 10)
  });

  // Mode 1: Single command-line invocation: node transport-cli.js --prompt "..." [--session "id"]
  let promptArg = null;
  let sessionArg = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prompt' && args[i + 1]) promptArg = args[++i];
    else if (args[i] === '--session' && args[i + 1]) sessionArg = args[++i];
  }

  if (promptArg) {
    try {
      await adapter.initialize();
      const res = await adapter.send({
        prompt: promptArg,
        session_id: sessionArg
      });
      process.stdout.write(JSON.stringify(res) + '\n');
      await adapter.close();
      process.exit(res.status === 'completed' ? 0 : 1);
    } catch (err) {
      process.stderr.write(JSON.stringify({ error: ErrorCodes.INTERNAL_ERROR, message: err.message }) + '\n');
      await adapter.close();
      process.exit(1);
    }
  }

  // Mode 2: Interactive NDJSON on stdin/stdout
  try {
    await adapter.initialize();
    process.stdout.write(JSON.stringify({ type: 'ready', status: 'OK', protocol: 'PUB-TRANSPORT/1.0' }) + '\n');
  } catch (err) {
    process.stderr.write(JSON.stringify({ type: 'fatal', error: err.message }) + '\n');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let payload;
    try {
      payload = JSON.parse(line.trim());
    } catch (e) {
      process.stdout.write(JSON.stringify({
        status: 'error',
        error: { code: ErrorCodes.INVALID_REQUEST, message: 'Invalid JSON payload' }
      }) + '\n');
      return;
    }

    try {
      const res = await adapter.send(payload);
      process.stdout.write(JSON.stringify(res) + '\n');
    } catch (err) {
      process.stdout.write(JSON.stringify({
        status: 'error',
        error: { code: ErrorCodes.INTERNAL_ERROR, message: err.message }
      }) + '\n');
    }
  });

  rl.on('close', async () => {
    await adapter.close();
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal CLI error:', err);
    process.exit(1);
  });
}

module.exports = { main };
