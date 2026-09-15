const http = require('http');
const crypto = require('crypto');
const EventEmitter = require('events');

class CdpClient extends EventEmitter {
  constructor(wsUrl) {
    super();
    this.wsUrl = wsUrl;
    this.socket = null;
    this.idCounter = 1;
    this.pending = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const parsed = new URL(this.wsUrl);
      const req = http.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        headers: {
          'Connection': 'Upgrade',
          'Upgrade': 'websocket',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          'Sec-WebSocket-Version': '13'
        }
      });

      req.on('upgrade', (res, socket) => {
        this.socket = socket;
        this._setupSocket();
        resolve();
      });

      req.on('error', reject);
      req.end();
    });
  }

  _setupSocket() {
    let buffer = Buffer.alloc(0);

    this.socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 2) {
        const firstByte = buffer[0];
        const secondByte = buffer[1];
        const opcode = firstByte & 0x0f;
        const isMasked = (secondByte & 0x80) !== 0;
        let payloadLen = secondByte & 0x7f;
        let headerLen = 2;

        if (payloadLen === 126) {
          if (buffer.length < 4) break;
          payloadLen = buffer.readUInt16BE(2);
          headerLen = 4;
        } else if (payloadLen === 127) {
          if (buffer.length < 10) break;
          payloadLen = Number(buffer.readBigUInt64BE(2));
          headerLen = 10;
        }

        if (isMasked) headerLen += 4;
        if (buffer.length < headerLen + payloadLen) break;

        let payload = buffer.slice(headerLen, headerLen + payloadLen);
        if (isMasked) {
          const mask = buffer.slice(headerLen - 4, headerLen);
          for (let i = 0; i < payload.length; i++) {
            payload[i] = payload[i] ^ mask[i % 4];
          }
        }

        buffer = buffer.slice(headerLen + payloadLen);

        if (opcode === 1) { // text frame
          try {
            const msg = JSON.parse(payload.toString('utf8'));
            if (msg.id && this.pending.has(msg.id)) {
              const req = this.pending.get(msg.id);
              this.pending.delete(msg.id);
              if (msg.error) req.reject(new Error(msg.error.message || 'CDP Error'));
              else req.resolve(msg.result);
            }
            if (msg.method) {
              this.emit('event', msg);
              this.emit(msg.method, msg.params);
            }
          } catch (e) {}
        }
      }
    });

    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.on('close', () => this.emit('close'));
  }

  async send(method, params = {}) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('CDP socket not connected');
    }

    const id = this.idCounter++;
    const payload = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');

    let header;
    if (payload.length < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x81;
      header[1] = 0x80 | payload.length;
      const mask = crypto.randomBytes(4);
      mask.copy(header, 2);
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i] ^ mask[i % 4];
    } else if (payload.length < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
      const mask = crypto.randomBytes(4);
      mask.copy(header, 4);
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i] ^ mask[i % 4];
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
      const mask = crypto.randomBytes(4);
      mask.copy(header, 10);
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i] ^ mask[i % 4];
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(Buffer.concat([header, payload]));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    return res?.result?.value;
  }

  close() {
    if (this.socket) {
      try { this.socket.destroy(); } catch {}
      this.socket = null;
    }
  }
}

module.exports = { CdpClient };
