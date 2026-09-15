const { EventEmitter } = require('events');
const { PubAcpBridge } = require('../../bridge.js');
const { BrowserBridgeServer } = require('./bridge-server.js');

/**
 * BrowserOrchestrator:
 * Implements the end-to-end bridge coordinating between ChatGPT Free on Chrome
 * and AGY via PUB-ACP-BRIDGE.
 * 
 * Pipeline:
 * ChatGPT Free Tab -> Browser Extension -> BrowserBridgeServer (5000) ->
 * BrowserOrchestrator -> PUB-ACP-BRIDGE (ACP) -> Antigravity (AGY) -> Response -> ChatGPT Free
 */
class BrowserOrchestrator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 5000;
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.browserServer = new BrowserBridgeServer({ port: this.port });
    this.acpBridge = new PubAcpBridge({ workspaceDir: this.workspaceDir });
    this.activeAcpSessionId = null;
    this.isStarted = false;
  }

  async start() {
    // 1. Start browser HTTP/SSE bridge server
    await this.browserServer.start();
    this.emit('log', `[BrowserOrchestrator] Browser bridge server listening on port ${this.port}`);

    // 2. Start ACP bridge to AGY
    this.acpBridge.on('log', (log) => this.emit('acp_log', log));
    this.acpBridge.on('error', (err) => this.emit('acp_error', err));
    await this.acpBridge.start();
    this.emit('log', '[BrowserOrchestrator] ACP Bridge connected to AGY successfully');

    // 3. Create persistent ACP session for this orchestrator
    this.activeAcpSessionId = await this.acpBridge.createSession(this.workspaceDir);
    this.emit('log', `[BrowserOrchestrator] Active ACP session initialized: ${this.activeAcpSessionId}`);

    this.isStarted = true;
    return {
      status: 'OK',
      port: this.port,
      acpSessionId: this.activeAcpSessionId
    };
  }

  /**
   * Dispatches a prompt to ChatGPT Free via the Browser Extension,
   * captures the generated instruction/plan, and forwards it to AGY via ACP.
   */
  async executeBrowserPrompt(promptText, options = {}) {
    if (!this.isStarted) {
      throw new Error('BrowserOrchestrator is not running');
    }

    const sessionId = options.sessionId || `turn-${Date.now()}-${Math.floor(Math.random()*10000)}`;
    this.emit('log', `[BrowserOrchestrator] Dispatching prompt to ChatGPT Free (Session: ${sessionId})`);

    // Step 1: Send prompt to browser extension
    const browserJob = await this.browserServer.submitPromptJob({
      sessionId,
      prompt: promptText,
      mode: 'ask'
    }, options.browserTimeoutMs || 120000);

    const chatGptReply = browserJob.text;
    this.emit('log', `[BrowserOrchestrator] Received response from ChatGPT Free (${chatGptReply.length} chars)`);

    // Step 2: Forward to AGY via ACP
    this.emit('log', '[BrowserOrchestrator] Forwarding instruction to Antigravity via ACP Bridge...');
    const chunks = [];
    const toolCalls = [];

    const acpResult = await this.acpBridge.prompt(
      this.activeAcpSessionId,
      chatGptReply,
      (chunk) => {
        chunks.push(chunk);
        this.emit('acp_chunk', chunk);
      },
      (title, toolInput) => {
        toolCalls.push({ title, toolInput });
        this.emit('acp_tool_call', { title, toolInput });
      }
    );

    this.emit('log', `[BrowserOrchestrator] AGY execution complete (Stop reason: ${acpResult.stopReason})`);

    return {
      sessionId,
      chatGptReply,
      acpResult,
      toolCalls,
      chunks: chunks.join('')
    };
  }

  async close() {
    if (this.browserServer) {
      await this.browserServer.close();
    }
    if (this.acpBridge) {
      await this.acpBridge.close();
    }
    this.isStarted = false;
  }
}

module.exports = { BrowserOrchestrator };
