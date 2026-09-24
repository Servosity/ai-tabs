const EventEmitter = require('events');

const OSC_9_PREFIX = '\x1b]9;';
const MAX_OSC_TAIL = 32;

/**
 * Watches PTY output for signs that an agent CLI is waiting for input.
 *
 * Detection channels:
 * 1. OSC 9 escape sequences — emitted for notifications (Claude Code does this)
 * 2. Output quiescence — no data for quiescenceMs after a burst = likely at prompt
 *
 * Emits 'idle' when the agent appears to be waiting for user input.
 * `opts` comes from the agent registry's `detection` block.
 */
class PromptDetector extends EventEmitter {
  constructor(sessionId, opts = {}) {
    super();
    this.sessionId = sessionId;
    this.quiescenceTimer = null;
    this.quiescenceMs = opts.quiescenceMs || 500;
    this.oscNotificationCodes = Array.isArray(opts.oscNotificationCodes)
      ? new Set(opts.oscNotificationCodes.map(String))
      : null;
    this.oscTail = '';
    this.quiescence = opts.quiescence !== false;
    this.lastBurstSize = 0;
    this.burstThreshold = opts.burstThreshold || 1;
    this.destroyed = false;
  }

  feed(data) {
    if (this.destroyed) return;

    // Channel 1: OSC 9 sequences. By default any OSC 9 is accepted for
    // backward compatibility; agents may restrict this to notification codes.
    const oscData = this.oscTail + data;
    this.oscTail = '';
    const oscPattern = /\x1b\]9;([^;\x07\x1b]*)(?=[;\x07\x1b])/g;
    for (const match of oscData.matchAll(oscPattern)) {
      if (!this.oscNotificationCodes || this.oscNotificationCodes.has(match[1])) {
        this.emit('idle');
        return;
      }
    }

    const lastPrefix = oscData.lastIndexOf(OSC_9_PREFIX);
    if (lastPrefix !== -1) {
      const candidate = oscData.slice(lastPrefix);
      const codeFragment = candidate.slice(OSC_9_PREFIX.length);
      if (!/[;\x07\x1b]/.test(codeFragment) && candidate.length <= MAX_OSC_TAIL) {
        this.oscTail = candidate;
      }
    }

    if (!this.oscTail) {
      const maxLength = Math.min(OSC_9_PREFIX.length - 1, oscData.length);
      for (let length = maxLength; length > 0; length -= 1) {
        if (oscData.endsWith(OSC_9_PREFIX.slice(0, length))) {
          this.oscTail = oscData.slice(-length);
          break;
        }
      }
    }

    // Channel 2: Quiescence detection may be disabled for agents with a reliable
    // explicit attention signal.
    if (!this.quiescence) return;

    // Track burst size — we only want to signal idle after substantial output
    this.lastBurstSize += data.length;

    if (this.quiescenceTimer) clearTimeout(this.quiescenceTimer);

    this.quiescenceTimer = setTimeout(() => {
      if (this.lastBurstSize >= this.burstThreshold) {
        this.emit('idle');
      }
      this.lastBurstSize = 0;
    }, this.quiescenceMs);
  }

  destroy() {
    this.destroyed = true;
    this.oscTail = '';
    if (this.quiescenceTimer) clearTimeout(this.quiescenceTimer);
    this.removeAllListeners();
  }
}

module.exports = { PromptDetector };
