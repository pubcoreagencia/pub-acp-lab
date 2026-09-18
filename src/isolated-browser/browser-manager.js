const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { CdpClient } = require('./cdp-client.js');

function resolveChromePath(explicitPath) {
  if (explicitPath) return explicitPath;
  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
      ]
    : process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser'
        ];
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

class IsolatedBrowserManager {
  constructor(options = {}) {
    this.port = options.port || 9555;
    this.profileDir = options.profileDir || path.resolve(process.cwd(), 'isolated_profile');
    this.chromePath = resolveChromePath(options.chromePath);
    this.proc = null;
    this.cdp = null;
    this.pageTarget = null;
  }

  async launch() {
    // Check if Chrome is already running on the port
    let alreadyRunning = false;
    try {
      await this._waitForPort(this.port, 1500);
      alreadyRunning = true;
    } catch {
      alreadyRunning = false;
    }

    if (!alreadyRunning) {
      if (!fs.existsSync(this.profileDir)) {
        fs.mkdirSync(this.profileDir, { recursive: true });
      }
      if (!fs.existsSync(this.chromePath)) {
        throw new Error(`Chrome executable not found for platform ${process.platform}: ${this.chromePath}. Set CHROME_PATH or pass chromePath explicitly.`);
      }

      this.proc = spawn(this.chromePath, [
        `--user-data-dir=${this.profileDir}`,
        `--remote-debugging-port=${this.port}`,
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-default-browser-check',
        'about:blank'
      ], { stdio: 'ignore' });

      this.proc.on('error', (err) => {
        console.error('[IsolatedBrowser] Process error:', err);
      });

      // Wait for CDP port to accept connections
      await this._waitForPort(this.port, 15000);
    }

    // Get list of targets and connect to the primary page
    const targets = await this._getTargets();
    let pageTarget = targets.find(t => t.type === 'page');
    if (!pageTarget) {
      pageTarget = targets[0];
    }
    if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
      throw new Error('No Chrome CDP page target available');
    }
    this.pageTarget = pageTarget;

    this.cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await this.cdp.connect();

    // Enable Runtime and Page domains
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Page.enable');

    return {
      port: this.port,
      profileDir: this.profileDir,
      targetId: pageTarget.id
    };
  }

  /**
   * Encapsulated reconnection and target re-attachment (Phase 7.4).
   * Restores CDP socket, page targets and domains cleanly without exposing internals.
   */
  async reconnect() {
    if (this.cdp) {
      try { this.cdp.close(); } catch {}
      this.cdp = null;
    }

    // Ensure browser process is listening
    await this.launch();

    const targets = await this._getTargets();
    let pageTarget = targets.find(t => t.type === 'page' && t.url && t.url.includes('chatgpt.com'));
    if (!pageTarget) {
      pageTarget = targets.find(t => t.type === 'page');
    }

    if (!pageTarget) {
      throw new Error('No valid page target found during browser reconnection');
    }

    this.pageTarget = pageTarget;
    if (!pageTarget.url.includes('chatgpt.com')) {
      await this.navigate('https://chatgpt.com');
    }

    this.cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await this.cdp.connect();
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Page.enable');

    return {
      port: this.port,
      targetId: pageTarget.id,
      url: pageTarget.url
    };
  }

  async _waitForPort(port, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await new Promise((res) => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, (r) => {
          res(r.statusCode === 200);
        });
        req.on('error', () => res(false));
      });
      if (ok) return true;
      await new Promise(r => setTimeout(r, 400));
    }
    throw new Error(`Timeout waiting for Chrome CDP port ${port}`);
  }

  async _getTargets() {
    return new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${this.port}/json`, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }

  async navigate(url) {
    await this.cdp.send('Page.navigate', { url });
    if (this.pageTarget) {
      this.pageTarget.url = url;
    }
    await this.waitForPageLoad();
    try {
      const currentUrl = await this.cdp.eval('window.location.href');
      if (currentUrl && this.pageTarget) {
        this.pageTarget.url = currentUrl;
      }
    } catch {}
  }

  async waitForPageLoad(timeoutMs = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const readyState = await this.cdp.eval('document.readyState');
      if (readyState === 'complete' || readyState === 'interactive') {
        await new Promise(r => setTimeout(r, 1000));
        return true;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }

  async getWindowId() {
    const res = await this.cdp.send('Browser.getWindowForTarget');
    return res.windowId;
  }

  async setWindowState(state = 'normal') {
    try {
      const windowId = await this.getWindowId();
      await this.cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: state }
      });
      return true;
    } catch (err) {
      console.warn('[IsolatedBrowser] setWindowState error:', err.message);
      return false;
    }
  }

  async bringToFront() {
    try {
      await this.cdp.send('Page.bringToFront');
      await this.setWindowState('normal');
      return true;
    } catch (err) {
      console.warn('[IsolatedBrowser] bringToFront error:', err.message);
      return false;
    }
  }

  async minimize() {
    return this.setWindowState('minimized');
  }

  async detectAuthState() {
    return this.cdp.eval(`
      (function() {
        const url = window.location.href;
        const text = document.body ? document.body.innerText : '';
        const hasInput = !!document.querySelector('#prompt-textarea') || 
                         !!document.querySelector('div[contenteditable="true"][role="textbox"]');
        
        const loginButtons = Array.from(document.querySelectorAll('button, a')).filter(el => {
          const t = (el.innerText || el.textContent || '').trim().toLowerCase();
          const tid = el.getAttribute('data-testid') || '';
          return tid.includes('login') || t === 'log in' || t === 'entrar' || t === 'fazer login' || t.startsWith('log in');
        });

        const hasLoginBtn = loginButtons.length > 0;
        const isAuthDomain = url.includes('auth.openai.com') || url.includes('auth0') || url.includes('/auth/');
        const isLoggedIn = hasInput && !hasLoginBtn && !isAuthDomain;

        return {
          url,
          hasInput,
          hasLoginBtn,
          isAuthDomain,
          isLoggedIn
        };
      })()
    `);
  }

  async close() {
    if (this.cdp) {
      this.cdp.close();
      this.cdp = null;
    }
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
  }
}

module.exports = { IsolatedBrowserManager, resolveChromePath };
