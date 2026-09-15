const http = require('http');

/**
 * BrowserBridgeClient:
 * Emulates the Chrome extension side or allows a test / real harness to connect
 * to BrowserBridgeServer over SSE and complete jobs.
 */
class BrowserBridgeClient {
  constructor(options = {}) {
    this.serverUrl = options.serverUrl || 'http://127.0.0.1:5000';
    this.sseReq = null;
    this.isConnected = false;
    this.handlers = new Map();
  }

  on(event, handler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event).push(handler);
  }

  emit(event, data) {
    const list = this.handlers.get(event) || [];
    for (const h of list) {
      try { h(data); } catch (e) { console.error('BrowserBridgeClient handler error:', e); }
    }
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.serverUrl}/browser/events`);
      this.sseReq = http.request(url, {
        headers: {
          'Accept': 'text/event-stream',
          'Cache-Control': 'no-cache'
        }
      }, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`SSE failed with status: ${res.statusCode}`));
        }

        this.isConnected = true;
        this.emit('connected');
        resolve();

        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n\n');
          buffer = lines.pop(); // keep last incomplete chunk

          for (const block of lines) {
            if (!block.trim() || block.startsWith(':')) continue;
            let event = 'message';
            let data = '';

            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) {
                event = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                data = line.slice(5).trim();
              }
            }

            if (event === 'job' && data) {
              try {
                const job = JSON.parse(data);
                this.emit('job', job);
              } catch (err) {
                console.error('Invalid SSE job JSON:', err);
              }
            }
          }
        });

        res.on('end', () => {
          this.isConnected = false;
          this.emit('disconnected');
        });
      });

      this.sseReq.on('error', (err) => {
        this.isConnected = false;
        this.emit('error', err);
        reject(err);
      });

      this.sseReq.end();
    });
  }

  async claimJob(sessionId) {
    return this._postJson('/browser/claim', { sessionId });
  }

  async sendChunk(sessionId, text) {
    return this._postJson('/browser/chunk', { sessionId, text });
  }

  async sendResponse(sessionId, text, error = null) {
    const payload = { sessionId };
    if (error) {
      payload.error = error;
    } else {
      payload.text = text;
    }
    return this._postJson('/browser/response', payload);
  }

  async _postJson(pathName, data) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.serverUrl}${pathName}`);
      const body = JSON.stringify(data);
      const req = http.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let raw = '';
        res.on('data', (c) => raw += c);
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw || '{}'));
          } catch (e) {
            resolve(raw);
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  disconnect() {
    if (this.sseReq) {
      try { this.sseReq.destroy(); } catch {}
      this.sseReq = null;
    }
    this.isConnected = false;
  }
}

module.exports = { BrowserBridgeClient };
