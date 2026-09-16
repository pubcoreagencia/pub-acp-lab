/**
 * Recovery Manager for ChatGpt Transport
 * Phase 7.3
 *
 * Handles deterministic recovery for:
 * - Chrome terminated / crashed
 * - Page closed or detached
 * - CDP / WebSocket disconnected
 * - Logical session detached from browser
 * - Interrupted execution reset
 */

const { ErrorCodes, TransportError } = require('./failure-taxonomy.js');

class RecoveryManager {
  constructor(adapter) {
    this.adapter = adapter;
    this.recoveryHistory = [];
    this.isRecovering = false;
  }

  /**
   * Evaluates whether the transport connection / browser is healthy
   */
  async checkHealth() {
    if (this.adapter.backend) {
      return {
        transport_healthy: true,
        browser_healthy: true,
        cdp_connected: true,
        backend_type: 'injected_fake'
      };
    }

    const bm = this.adapter.browserManager;
    if (!bm) {
      return {
        transport_healthy: false,
        browser_healthy: false,
        cdp_connected: false,
        reason: 'browser_manager_null'
      };
    }

    let cdpConnected = false;
    let browserHealthy = false;
    let pageResponsive = false;

    try {
      if (bm.cdp && bm.cdp.socket && !bm.cdp.socket.destroyed) {
        cdpConnected = true;
        // Test lightweight evaluate call to verify target responsiveness
        const res = await Promise.race([
          bm.cdp.eval('1 + 1'),
          new Promise((_, rej) => setTimeout(() => rej(new Error('cdp_health_timeout')), 2000))
        ]);
        if (res === 2) {
          pageResponsive = true;
          browserHealthy = true;
        }
      }
    } catch (e) {
      cdpConnected = false;
      browserHealthy = false;
    }

    return {
      transport_healthy: cdpConnected && pageResponsive,
      browser_healthy: browserHealthy,
      cdp_connected: cdpConnected,
      page_responsive: pageResponsive
    };
  }

  /**
   * Executes deterministic recovery
   */
  async recover(cause = 'unknown') {
    if (this.isRecovering) {
      return { status: 'recovery_already_in_progress' };
    }

    this.isRecovering = true;
    const startTime = Date.now();
    const record = {
      timestamp: new Date().toISOString(),
      cause,
      actions: []
    };

    try {
      this.adapter.observability.emitEvent('RECOVERY_STARTED', {
        recoveryAction: 'full_stack_audit',
        details: { cause }
      });

      if (this.adapter.backend) {
        if (typeof this.adapter.backend.initialize === 'function') {
          await this.adapter.backend.initialize();
        }
        record.actions.push('backend_reinitialized');
        record.success = true;
        return record;
      }

      const bm = this.adapter.browserManager;
      if (!bm) {
        throw new TransportError(ErrorCodes.RECOVERY_FAILED, 'BrowserManager not configured on adapter');
      }

      // Step 1: Ensure browser process and CDP socket are operational
      const health = await this.checkHealth();
      if (!health.cdp_connected || !health.browser_healthy) {
        this.adapter.observability.emitEvent('RECOVERY_ACTION', {
          recoveryAction: 'relaunch_and_reconnect',
          details: { priorHealth: health }
        });

        // Close old CDP if dangling
        if (bm.cdp) {
          bm.cdp.close();
        }

        // Re-launch / re-attach browser
        await bm.launch();
        record.actions.push('cdp_reconnected');

        // Step 2: Ensure target is on ChatGPT page
        const targets = await bm._getTargets();
        let pageTarget = targets.find(t => t.type === 'page' && t.url.includes('chatgpt.com'));
        if (!pageTarget) {
          pageTarget = targets.find(t => t.type === 'page');
        }

        if (!pageTarget) {
          throw new TransportError(ErrorCodes.RECOVERY_FAILED, 'No available page target found after relaunch');
        }

        bm.pageTarget = pageTarget;
        if (!pageTarget.url.includes('chatgpt.com')) {
          await bm.navigate('https://chatgpt.com');
          record.actions.push('navigated_to_chatgpt');
        }

        // Reconnect CDP client to page target
        const { CdpClient } = require('../isolated-browser/cdp-client.js');
        bm.cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
        await bm.cdp.connect();
        await bm.cdp.send('Runtime.enable');
        await bm.cdp.send('Page.enable');
        record.actions.push('cdp_page_domains_enabled');

        // Re-instantiate driver with new CDP client
        const { ChatGptDriver } = require('../isolated-browser/chatgpt-driver.js');
        this.adapter.driver = new ChatGptDriver(bm.cdp);
        record.actions.push('driver_reinstantiated');
      }

      // Step 3: Check and reset input state
      if (this.adapter.driver) {
        try {
          await this.adapter.driver._waitForInput(5000);
          record.actions.push('input_ready_verified');
        } catch {
          record.actions.push('input_ready_pending');
        }
      }

      // Step 4: Restore logical session states from INTERRUPTED back to READY
      for (const [sid, session] of this.adapter.sessions.entries()) {
        if (session.state === 'INTERRUPTED' || session.state === 'FAILED') {
          session.transitionTo('READY', 'recovered_by_manager');
          record.actions.push(`session_${sid}_restored_to_ready`);
        }
      }

      record.success = true;
      record.durationMs = Date.now() - startTime;
      this.recoveryHistory.push(record);

      this.adapter.observability.emitEvent('RECOVERY_COMPLETED', {
        recoveryAction: 'restored',
        durationMs: record.durationMs,
        details: record
      });

      return record;

    } catch (err) {
      record.success = false;
      record.error = err.message;
      record.durationMs = Date.now() - startTime;
      this.recoveryHistory.push(record);

      this.adapter.observability.emitEvent('RECOVERY_FAILED', {
        recoveryAction: 'abort',
        durationMs: record.durationMs,
        errorClassification: err.code || ErrorCodes.RECOVERY_FAILED,
        details: record
      });

      throw err;
    } finally {
      this.isRecovering = false;
    }
  }

  getLastRecovery() {
    return this.recoveryHistory.length > 0 ? this.recoveryHistory[this.recoveryHistory.length - 1] : null;
  }
}

module.exports = { RecoveryManager };
