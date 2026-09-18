const { ChatGptTransportServer } = require('../src/transport/transport-server.js');
const { resolveChromePath } = require('../src/isolated-browser/browser-manager.js');
const path = require('path');

const port = Number(process.env.ACP_LAB_PORT || 5125);
const profileDir = process.env.ACP_LAB_PROFILE || path.resolve(process.cwd(), 'isolated_profile');
const chromePath = process.env.CHROME_PATH || undefined;

const server = new ChatGptTransportServer({
  port,
  host: '127.0.0.1',
  profileDir,
  chromePath,
  defaultTimeoutMs: Number(process.env.ACP_LAB_TIMEOUT_MS || 120000)
});

async function main() {
  console.log('[ACP-LAB] platform:', process.platform);
  console.log('[ACP-LAB] chrome:', chromePath || resolveChromePath());
  console.log('[ACP-LAB] profile:', profileDir);
  console.log('[ACP-LAB] endpoint: http://127.0.0.1:' + port);
  await server.start();
  console.log('[ACP-LAB] READY');
}

async function shutdown(signal) {
  console.log('[ACP-LAB] shutting down:', signal);
  await server.close();
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });

main().catch(err => {
  console.error('[ACP-LAB] FATAL:', err);
  process.exit(1);
});
