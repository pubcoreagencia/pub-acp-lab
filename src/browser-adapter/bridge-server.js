const http = require('http');
const EventEmitter = require('events');

class BrowserBridgeServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 5000;
    this.host = options.host || '127.0.0.1';
    this.server = null;
    this.browserClients = new Set();
    this.pendingJobs = new Map();
    this.claimedJobs = new Map();
    this.heartbeatInterval = null;
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this._handleRequest(req, res);
      });

      this.server.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this.server.listen(this.port, this.host, () => {
        this.emit('listening', { host: this.host, port: this.port });

        this.heartbeatInterval = setInterval(() => {
          this._broadcastHeartbeat();
        }, 15000);

        resolve({ host: this.host, port: this.port });
      });
    });
  }

  _setCORSHeaders(res, req) {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }

  _broadcastHeartbeat() {
    for (const client of this.browserClients) {
      try {
        client.write(': heartbeat\n\n');
      } catch {
        this.browserClients.delete(client);
      }
    }
  }

  _handleRequest(req, res) {
    this._setCORSHeaders(res, req);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || this.host}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        connected_browsers: this.browserClients.size,
        pending_jobs: this.pendingJobs.size
      }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/browser/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(': connected\n\n');

      this.browserClients.add(res);
      this.emit('browser_connected', { clients: this.browserClients.size });

      for (const [sessionId, entry] of this.pendingJobs.entries()) {
        if (!this.claimedJobs.has(sessionId)) {
          this._sendSseJob(res, entry.job);
        }
      }

      req.on('close', () => {
        this.browserClients.delete(res);
        this.emit('browser_disconnected', { clients: this.browserClients.size });
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/browser/claim') {
      this._readJsonBody(req, (err, body) => {
        if (err || !body || !body.sessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sessionId required' }));
          return;
        }

        const sessionId = body.sessionId;
        const entry = this.pendingJobs.get(sessionId);

        if (!entry) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ claimed: false, reason: 'Job not found or already completed' }));
          return;
        }

        this.claimedJobs.set(sessionId, entry.job);
        this.emit('job_claimed', { sessionId, job: entry.job });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          claimed: true,
          job: entry.job
        }));
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/browser/chunk') {
      this._readJsonBody(req, (err, body) => {
        if (err || !body || !body.sessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sessionId required' }));
          return;
        }

        this.emit('chunk', { sessionId: body.sessionId, text: body.text });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true }));
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/browser/response') {
      this._readJsonBody(req, (err, body) => {
        if (err || !body || !body.sessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sessionId required' }));
          return;
        }

        const { sessionId, text, error } = body;
        const entry = this.pendingJobs.get(sessionId);

        if (!entry) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No pending job for sessionId' }));
          return;
        }

        clearTimeout(entry.timer);
        this.pendingJobs.delete(sessionId);
        this.claimedJobs.delete(sessionId);

        if (error) {
          entry.reject(new Error(`Browser extension error: ${error}`));
          this.emit('job_failed', { sessionId, error });
        } else {
          entry.resolve({ sessionId, text });
          this.emit('job_completed', { sessionId, text });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true, status: error ? 'error' : 'complete' }));
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', path: url.pathname }));
  }

  _readJsonBody(req, callback) {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10 * 1024 * 1024) {
        req.destroy();
        callback(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(raw || '{}');
        callback(null, parsed);
      } catch (e) {
        callback(e);
      }
    });
  }

  _sendSseJob(client, job) {
    try {
      client.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
    } catch (e) {
      this.browserClients.delete(client);
    }
  }

  async submitPromptJob(jobData, timeoutMs = 180000) {
    const sessionId = jobData.sessionId || `sess-${Date.now()}-${Math.floor(Math.random()*10000)}`;
    const job = {
      sessionId,
      mode: jobData.mode || 'ask',
      message: jobData.message || jobData.prompt,
      composerMessage: jobData.message || jobData.prompt,
      systemPrompt: jobData.systemPrompt || '',
      conversationId: jobData.conversationId || sessionId,
      delivery: 'text'
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingJobs.delete(sessionId);
        this.claimedJobs.delete(sessionId);
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for ChatGPT browser response for sessionId ${sessionId}`));
      }, timeoutMs);

      this.pendingJobs.set(sessionId, { job, resolve, reject, timer });

      for (const client of this.browserClients) {
        this._sendSseJob(client, job);
      }

      this.emit('job_queued', { sessionId, job, connected_clients: this.browserClients.size });
    });
  }

  async close() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    for (const client of this.browserClients) {
      try { client.end(); } catch {}
    }
    this.browserClients.clear();

    for (const [sessionId, entry] of this.pendingJobs.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('BrowserBridgeServer closed'));
    }
    this.pendingJobs.clear();
    this.claimedJobs.clear();

    if (this.server) {
      await new Promise((res) => this.server.close(res));
      this.server = null;
    }
  }
}

module.exports = { BrowserBridgeServer };
