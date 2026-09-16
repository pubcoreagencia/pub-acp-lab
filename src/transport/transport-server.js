const http = require('http');
const { ChatGptTransportAdapter, ErrorCodes } = require('./transport-adapter.js');

const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024; // 2 MB limit for prompts

/**
 * ChatGptTransportServer (Phase 7.4):
 * Exposes ChatGptTransportAdapter over a localhost-only HTTP JSON endpoint
 * with explicit body size limit enforcement.
 *
 * Supported Endpoints:
 * - POST /v1/chat/completions (Standard RPC format)
 * - POST /v1/transport/prompt
 * - GET  /v1/health
 * - GET  /v1/diagnostics
 */
class ChatGptTransportServer {
  constructor(options = {}) {
    this.port = options.port || 5125;
    this.host = options.host || '127.0.0.1';
    this.maxBodyBytes = options.maxBodyBytes || MAX_HTTP_BODY_BYTES;
    this.adapter = options.adapter || new ChatGptTransportAdapter(options);
    this.server = null;

    // Prevent unhandled error event from throwing if not listened externally
    if (this.adapter && typeof this.adapter.on === 'function') {
      this.adapter.on('error', () => {});
    }
  }

  async start() {
    await this.adapter.initialize();

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        // Enforce localhost-only security
        const clientIp = req.socket.remoteAddress;
        if (clientIp !== '127.0.0.1' && clientIp !== '::1' && clientIp !== '::ffff:127.0.0.1') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'FORBIDDEN', message: 'Localhost access only' }));
          return;
        }

        this._setCORSHeaders(res, req);
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = new URL(req.url, `http://${this.host}:${this.port}`);

        if (req.method === 'GET' && url.pathname === '/v1/health') {
          const diagnostics = await this.adapter.getDiagnostics();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            status: diagnostics.status,
            initialized: this.adapter.isInitialized,
            isProcessing: this.adapter.isProcessing,
            sessionsCount: this.adapter.sessions.size,
            health: diagnostics.health
          }));
          return;
        }

        if (req.method === 'GET' && url.pathname === '/v1/diagnostics') {
          const diagnostics = await this.adapter.getDiagnostics();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(diagnostics));
          return;
        }

        if (req.method === 'POST' && (url.pathname === '/v1/transport/prompt' || url.pathname === '/v1/chat/completions')) {
          let body = '';
          let receivedBytes = 0;
          let aborted = false;

          req.on('data', chunk => {
            if (aborted) return;
            receivedBytes += chunk.length;
            if (receivedBytes > this.maxBodyBytes) {
              aborted = true;
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                status: 'error',
                error: {
                  code: ErrorCodes.PAYLOAD_TOO_LARGE,
                  message: `Payload size exceeded limit of ${this.maxBodyBytes} bytes`
                }
              }));
              req.destroy();
              return;
            }
            body += chunk;
          });

          req.on('end', async () => {
            if (aborted) return;

            let parsed;
            try {
              parsed = JSON.parse(body || '{}');
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                status: 'error',
                error: {
                  code: ErrorCodes.INVALID_REQUEST,
                  message: `Invalid JSON payload: ${err.message}`
                }
              }));
              return;
            }

            try {
              const response = await this.adapter.send(parsed);
              const httpStatus = response.status === 'completed' ? 200 : 400;
              res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(response));
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                status: 'error',
                error: {
                  code: ErrorCodes.INTERNAL_ERROR,
                  message: err.message
                }
              }));
            }
          });
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Route ${req.method} ${url.pathname} not found` }));
      });

      this.server.on('error', reject);

      this.server.listen(this.port, this.host, () => {
        resolve({ host: this.host, port: this.port });
      });
    });
  }

  _setCORSHeaders(res, req) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID');
  }

  async close() {
    if (this.server) {
      await new Promise(r => this.server.close(r));
      this.server = null;
    }
    if (this.adapter) {
      await this.adapter.close();
    }
  }
}

module.exports = { ChatGptTransportServer };
