class ChatGptDriver {
  constructor(cdpClient) {
    this.cdp = cdpClient;
  }

  async dismissModals() {
    try {
      await this.cdp.eval(`
        (function() {
          // 1. Close buttons on modals / dialogs
          const closeButtons = Array.from(document.querySelectorAll(
            'button[aria-label="Close"], button[aria-label="Fechar"], button[data-testid*="close"]'
          ));
          for (const btn of closeButtons) {
            if (btn.offsetWidth > 0 && btn.offsetHeight > 0) {
              btn.click();
            }
          }

          // 2. Feedback / rating popups ("Esta conversa foi útil até agora?")
          const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], [data-testid*="modal"]'));
          for (const d of dialogs) {
            const text = d.innerText || '';
            if (text.includes('Esta conversa foi útil') || text.includes('feedback') || text.includes('Pesquisa')) {
              const dismissBtn = d.querySelector('button[aria-label*="Fechar"]') ||
                                 d.querySelector('button[aria-label*="Close"]') ||
                                 d.querySelector('button');
              if (dismissBtn) dismissBtn.click();
            }
          }
        })()
      `);
    } catch {}
  }

  async injectAndSendPrompt(promptText) {
    await this.dismissModals();

    const inputReady = await this._waitForInput(15000);
    if (!inputReady) {
      throw new Error('ChatGPT input box (#prompt-textarea) not available.');
    }

    // Set text via document.execCommand('insertText') and trigger synthetic input events
    await this.cdp.eval(`
      (function() {
        const input = document.querySelector('#prompt-textarea') || 
                      document.querySelector('div[contenteditable="true"][role="textbox"]') ||
                      document.querySelector('div[contenteditable="true"]');
        if (!input) return false;
        input.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, ${JSON.stringify(promptText)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()
    `);

    await new Promise(r => setTimeout(r, 400));

    // Verify if send button is enabled; if not, trigger a CDP Input event to sync React state
    let sendBtnState = await this.cdp.eval(`
      (function() {
        const sendBtn = document.querySelector('button[data-testid="send-button"]') ||
                        document.querySelector('button[aria-label*="Enviar"]') ||
                        document.querySelector('button[aria-label*="Send"]');
        return sendBtn ? { present: true, disabled: sendBtn.disabled } : { present: false, disabled: true };
      })()
    `);

    if (!sendBtnState.present || sendBtnState.disabled) {
      // Fallback to sync React state via CDP Input
      await this.cdp.eval(`
        (function() {
          const input = document.querySelector('#prompt-textarea') || document.querySelector('div[contenteditable="true"]');
          if (input) input.focus();
        })()
      `);
      await this.cdp.send('Input.insertText', { text: ' ' });
      await new Promise(r => setTimeout(r, 200));
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        windowsVirtualKeyCode: 8,
        code: 'Backspace',
        key: 'Backspace'
      });
      await this.cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        windowsVirtualKeyCode: 8,
        code: 'Backspace',
        key: 'Backspace'
      });
      await new Promise(r => setTimeout(r, 300));
    }

    // Click the send button (preferred)
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
      await this.dismissModals();
      const ready = await this.cdp.eval(`
        !!document.querySelector('#prompt-textarea') ||
        !!document.querySelector('div[contenteditable="true"][role="textbox"]') ||
        !!document.querySelector('div[contenteditable="true"]')
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
   * 2. No active stop button is present (button[data-testid="stop-button"]).
   * 3. No busy/streaming indicators exist (.result-streaming, [aria-busy="true"], [data-is-streaming="true"]).
   * 4. Multi-layer completion check:
   *    - The turn action copy button exists on the latest assistant turn, OR
   *    - The response text is stable across multiple consecutive inspection samples with streaming stopped.
   * 5. The text content is non-empty and stabilized.
   */
  async waitForCompletion(beforeCount = 0, timeoutMs = 120000) {
    const start = Date.now();
    let lastSeenText = '';
    let stableTextSamples = 0;

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
            null;

          return {
            count: currentCount,
            hasStopButton,
            isStreamingBusy,
            hasCopyBtn: !!copyBtn,
            text: nodeText
          };
        })()
      `);

      if (state && state.count > beforeCount && !state.hasStopButton && !state.isStreamingBusy && state.text && state.text.length > 0) {
        if (state.hasCopyBtn) {
          // If copy button is present and not streaming, ensure stability on text
          if (state.text === lastSeenText) {
            return state.text;
          }
        }

        // Stability counter fallback if copy button selector is delayed/missing in DOM
        if (state.text === lastSeenText) {
          stableTextSamples++;
          if (stableTextSamples >= 2) {
            return state.text;
          }
        } else {
          stableTextSamples = 0;
          lastSeenText = state.text;
        }
      } else {
        stableTextSamples = 0;
      }

      // STALL RECOVERY: If a new turn was created, stop button is gone, but streaming pulse remains empty for > 15s,
      // ChatGPT Free backend has finalized server-side but React UI stream stalled. Reloading page retrieves full turn.
      if (state && state.count > beforeCount && !state.hasStopButton && (!state.text || state.text.length === 0) && (Date.now() - start > 15000)) {
        try {
          await this.cdp.send('Page.reload');
          await new Promise(r => setTimeout(r, 4000));
          const reloadedText = await this.cdp.eval(`
            (function() {
              const nodes = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
              const last = nodes[nodes.length - 1];
              return last ? (last.innerText || '').trim() : '';
            })()
          `);
          if (reloadedText && reloadedText.length > 0) {
            return reloadedText;
          }
        } catch {}
      }

      await new Promise(r => setTimeout(r, 600));
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
