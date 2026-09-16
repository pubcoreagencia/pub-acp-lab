const http = require('http');

/**
 * ChatGptTransportClient:
 * Thin client wrapper that allows any local application/script to communicate
 * with ChatGptTransportServer over standard HTTP JSON requests.
 */
class ChatGptTransportClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'http://127.0.0.1:5125';
  }

  async send(params = {}) {
    const url = new URL(`${this.baseUrl}/v1/transport/prompt`);
    const payload = JSON.stringify(params);

    return new Promise((resolve, reject) => {
      const req = http.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Failed to parse transport response: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  async health() {
    const url = new URL(`${this.baseUrl}/v1/health`);
    return new Promise((resolve, reject) => {
      http.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
  }
}

module.exports = { ChatGptTransportClient };
