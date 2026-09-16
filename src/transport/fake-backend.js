/**
 * FakeChatGptBackend:
 * Simulates ChatGPT behavior purely in-memory for fast, deterministic contract tests.
 * Zero Chrome, zero CDP, zero DOM, zero network dependency.
 */
class FakeChatGptBackend {
  constructor() {
    this.sessionStores = new Map();
  }

  async send({ requestId, sessionId, prompt, timeoutMs, isNewSession }) {
    if (!this.sessionStores.has(sessionId)) {
      this.sessionStores.set(sessionId, {
        history: [],
        memory: {}
      });
    }

    const store = this.sessionStores.get(sessionId);
    store.history.push(prompt);

    // Timeout simulation: if timeoutMs is ultra-short (< 500ms) or prompt asks to hang
    if (timeoutMs && timeoutMs <= 300) {
      await new Promise(r => setTimeout(r, 400));
      throw new Error(`Timeout waiting for response (${timeoutMs}ms)`);
    }

    // 1. Secret token storage & query
    if (prompt.includes('Memorize o seguinte token de transporte:')) {
      const match = prompt.match(/TRANSPORT_SECRET_\w+/);
      if (match) {
        store.memory.token = match[0];
      }
      return 'Token memorizado com sucesso.';
    }

    if (prompt.includes('Qual foi o token de transporte')) {
      if (store.memory.token) {
        return store.memory.token;
      }
      return 'Nenhum token encontrado na sessão.';
    }

    // 2. Favorite number storage & isolation check
    if (prompt.includes('Meu número favorito é')) {
      const match = prompt.match(/(\d+)/);
      if (match) {
        store.memory.favNumber = match[1];
      }
      return 'OK';
    }

    if (prompt.includes('Qual é o meu número favorito?')) {
      if (store.memory.favNumber) {
        return `Seu número favorito é ${store.memory.favNumber}`;
      }
      return 'NAO_SEI';
    }

    // 3. Long numbered response (20 lines)
    if (prompt.includes('20 linhas numeradas')) {
      const lines = [];
      for (let i = 1; i <= 20; i++) {
        lines.push(`${i}. Linha de teste de transporte ${i}`);
      }
      return lines.join('\n');
    }

    // 4. Exact echo requirement
    if (prompt.startsWith('Responda exatamente:')) {
      return prompt.replace('Responda exatamente:', '').trim();
    }

    return `Simulated response to: ${prompt}`;
  }

  async close() {
    this.sessionStores.clear();
  }
}

module.exports = { FakeChatGptBackend };
