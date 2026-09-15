class ChatGptDriver {
  constructor(cdpClient) {
    this.cdp = cdpClient;
  }

  async injectAndSendPrompt(promptText) {
    const inputReady = await this._waitForInput(15000);
    if (!inputReady) {
      throw new Error('ChatGPT input box (#prompt-textarea) not available.');
    }

    // Set text via document.execCommand('insertText')
    await this.cdp.eval(`
      (function() {
        const input = document.querySelector('#prompt-textarea') || 
                      document.querySelector('div[contenteditable="true"][role="textbox"]');
        if (!input) return false;
        input.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, ${JSON.stringify(promptText)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);

    await new Promise(r => setTimeout(r, 600));

    // Click the send button (proven to dispatch immediately)
    const clicked = await this.cdp.eval(`
      (function() {
        const sendBtn = document.querySelector('button[data-testid="send-button"]') ||
                        document.querySelector('button[aria-label*="Enviar"]') ||
                        document.querySelector('button[aria-label*="Send"]');
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
          return true;
        }
        return false;
      })()
    `);

    if (!clicked) {
      // Fallback: Dispatch Enter key via CDP Input domain
      await this.cdp.eval(`
        (function() {
          const input = document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]');
          if (input) input.focus();
        })()
      `);
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        windowsVirtualKeyCode: 13,
        code: 'Enter',
        key: 'Enter',
        text: '\r',
        unmodifiedText: '\r'
      });
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        windowsVirtualKeyCode: 13,
        code: 'Enter',
        key: 'Enter'
      });
    }

    return true;
  }

  async _waitForInput(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ready = await this.cdp.eval(`
        !!document.querySelector('#prompt-textarea') ||
        !!document.querySelector('div[contenteditable="true"][role="textbox"]')
      `);
      if (ready) return true;
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  /**
   * Waits deterministically for the assistant response to finalize.
   * Empirically validated DOM signals:
   * 1. A new assistant node/turn exists (beyond beforeCount).
   * 2. No global stop button is present (button[data-testid="stop-button"]).
   * 3. No busy/streaming indicators exist in the turn (.result-streaming, [aria-busy="true"]).
   * 4. The turn action buttons (copy-turn-action-button for response) are rendered.
   * 5. The innerText is non-empty and has completed streaming.
   */
  async waitForCompletion(beforeCount = 0, timeoutMs = 120000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const state = await this.cdp.eval(`
        (function() {
          const turns = Array.from(document.querySelectorAll('section[data-testid^="conversation-turn-"]'));
          const assistantTurns = turns.filter(t => !!t.querySelector('[data-message-author-role="assistant"]'));
          const directAssistantNodes = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
          
          const currentCount = Math.max(assistantTurns.length, directAssistantNodes.length);
          if (currentCount <= ${beforeCount}) {
            return { stage: 'waiting_for_turn', count: currentCount };
          }

          const latestTurn = assistantTurns.length > 0 ? assistantTurns[assistantTurns.length - 1] : null;
          const latestNode = directAssistantNodes[directAssistantNodes.length - 1];
          
          const nodeText = latestNode ? (latestNode.innerText || '').trim() : '';
          
          const hasStopButton = !!document.querySelector('button[data-testid="stop-button"]') ||
                                !!document.querySelector('button[aria-label*="Stop"]') ||
                                !!document.querySelector('button[aria-label*="Parar"]');

          const isStreamingBusy = !!document.querySelector('.result-streaming') ||
                                  !!document.querySelector('[aria-busy="true"]') ||
                                  !!document.querySelector('[data-is-streaming="true"]');

          const copyBtn = latestTurn ? 
            latestTurn.querySelector('button[data-testid="copy-turn-action-button"]') : 
            document.querySelector('button[data-testid="copy-turn-action-button"][aria-label*="resposta"], button[data-testid="copy-turn-action-button"][aria-label*="response"]');

          const isFinalized = !hasStopButton && !isStreamingBusy && !!copyBtn && nodeText.length > 0;

          return {
            stage: isFinalized ? 'done' : 'streaming',
            count: currentCount,
            hasStopButton,
            isStreamingBusy,
            hasCopyBtn: !!copyBtn,
            text: nodeText
          };
        })()
      `);

      if (state && state.stage === 'done' && state.text.length > 0) {
        return state.text;
      }

      await new Promise(r => setTimeout(r, 500));
    }

    throw new Error(`Timeout waiting for ChatGPT response (${timeoutMs}ms)`);
  }

  async getAssistantMessageCount() {
    return this.cdp.eval(`
      (function() {
        const turns = Array.from(document.querySelectorAll('section[data-testid^="conversation-turn-"]'));
        const assistantTurns = turns.filter(t => !!t.querySelector('[data-message-author-role="assistant"]'));
        const directNodes = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
        return Math.max(assistantTurns.length, directNodes.length);
      })()
    `);
  }
}

module.exports = { ChatGptDriver };
