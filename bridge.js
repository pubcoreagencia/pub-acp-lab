const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const EventEmitter = require('events');

class PubAcpBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.agyBin = options.agyBin || 'C:\\\\Users\\\\Matheus Paes\\\\AppData\\\\Local\\\\agy\\\\bin\\\\agy.exe';
    this.adapterDistPath = options.adapterDistPath || path.resolve(this.workspaceDir, 'agy-agent-acp', 'dist', 'index.js');
    this.timeoutMs = options.timeoutMs || 240000;
    this.child = null;
    this.rl = null;
    this.reqId = 1;
    this.pending = new Map();
    this.sessions = new Set();
    this.isReady = false;
  }

  async start() {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(this.adapterDistPath)) {
        return reject(new Error(`Adapter not found at: ${this.adapterDistPath}`));
      }
      if (!fs.existsSync(this.agyBin)) {
        return reject(new Error(`AGY binary not found at: ${this.agyBin}`));
      }

      const env = {
        ...process.env,
        PATH: path.dirname(this.agyBin) + ';' + (process.env.PATH || '')
      };

      this.child = spawn(process.execPath, [this.adapterDistPath], {
        cwd: this.workspaceDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.child.on('error', (err) => {
        this.emit('error', { type: 'SPAWN_ERROR', message: err.message });
      });

      this.child.on('exit', (code, signal) => {
        this.isReady = false;
        this.emit('exit', { code, signal });
        for (const [id, req] of this.pending.entries()) {
          req.reject(new Error(`Adapter process exited (code: ${code}) while request ${id} was pending`));
        }
        this.pending.clear();
      });

      this.rl = readline.createInterface({
        input: this.child.stdout,
        terminal: false
      });

      this.rl.on('line', (line) => {
        this._handleLine(line);
      });

      this.child.stderr.on('data', (data) => {
        this.emit('log', data.toString());
      });

      this._call('initialize', {
        protocolVersion: 2,
        clientInfo: { name: 'pub-acp-bridge', version: '1.0.0' }
      })
      .then((res) => {
        this.isReady = true;
        resolve(res);
      })
      .catch(reject);
    });
  }

  _call(method, params, customTimeout) {
    if (!this.child || this.child.killed) {
      return Promise.reject(new Error('Bridge is not running'));
    }

    const id = this.reqId++;
    const timeout = customTimeout || this.timeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request ${method} (id ${id}) timed out after ${timeout}ms`));
        }
      }, timeout);

      this.pending.set(id, {
        method,
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });

      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      this.child.stdin.write(payload);
    });
  }

  _handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line.trim());
    } catch (e) {
      this.emit('error', { type: 'INVALID_JSON', line, error: e.message });
      return;
    }

    if (msg.id && this.pending.has(msg.id)) {
      const req = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        req.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        req.resolve(msg.result);
      }
      return;
    }

    if (msg.method === 'session/update' && msg.params) {
      const update = msg.params.update;
      const sessionId = msg.params.sessionId;

      if (update.sessionUpdate === 'agent_message_chunk' && update.content && update.content.text) {
        this.emit('chunk', { sessionId, text: update.content.text });
      } else if (update.sessionUpdate === 'tool_call') {
        this.emit('tool_call', {
          sessionId,
          title: update.title,
          toolInput: update.toolInput
        });
      } else if (update.sessionUpdate === 'usage_update') {
        this.emit('usage', { sessionId, usage: update.usage });
      }
    }
  }

  async createSession(cwd) {
    const targetCwd = cwd || this.workspaceDir;
    const res = await this._call('session/new', { cwd: targetCwd, mcpServers: [] });
    if (!res || !res.sessionId) {
      throw new Error('Failed to create session: no sessionId returned');
    }
    this.sessions.add(res.sessionId);
    return res.sessionId;
  }

  async prompt(sessionId, text, onChunk, onTool) {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} does not exist`);
    }

    let chunkHandler, toolHandler;
    let fullResponse = '';

    if (onChunk || onTool) {
      chunkHandler = (data) => {
        if (data.sessionId === sessionId) {
          fullResponse += data.text;
          if (onChunk) onChunk(data.text);
        }
      };
      toolHandler = (data) => {
        if (data.sessionId === sessionId && onTool) {
          onTool(data.title, data.toolInput);
        }
      };
      this.on('chunk', chunkHandler);
      this.on('tool_call', toolHandler);
    }

    try {
      const res = await this._call('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }]
      });

      return {
        sessionId,
        stopReason: (res && res.stopReason) || 'end_turn',
        response: fullResponse
      };
    } finally {
      if (chunkHandler) this.off('chunk', chunkHandler);
      if (toolHandler) this.off('tool_call', toolHandler);
    }
  }

  async close() {
    if (!this.child) return;
    return new Promise((resolve) => {
      this.child.on('exit', () => resolve());
      this.child.kill('SIGTERM');
      setTimeout(() => {
        if (this.child && !this.child.killed) {
          this.child.kill('SIGKML');
        }
        resolve();
      }, 3000);
    });
  }
}

module.exports = { PubAcpBridge };