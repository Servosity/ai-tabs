const fs = require('fs');
const path = require('path');
const { ClaudeParser } = require('./claude-parser');
const { CodexParser } = require('./codex-parser');
const { getBranch } = require('./git-branch');
const { parseRateLimits } = require('./rate-limits');
const { buildAttentionHooks } = require('../attention-hook');
const { buildMediaHooks } = require('../media/hooks');
const { parseTabSessionId } = require('../command-launch');

/**
 * StatuslineManager — computes per-session status stats (model, context
 * usage, tokens, active time, git branch) and pushes them to the session's
 * WebSocket clients. Provider-aware: agents whose transcripts we can read
 * (claude, codex) get full stats; everything else gets the generic set
 * (agent, cwd, branch, elapsed). An agent entry may set `statusline` to a
 * parser id ('claude' | 'codex') to opt a fork/wrapper into a parser.
 */

const POLL_MS = 3000;

function createParser(agent, cwd, startTime) {
  const kind = agent ? (agent.statusline || agent.id) : null;
  if (kind === 'claude') return new ClaudeParser({ cwd, startTime });
  if (kind === 'codex') return new CodexParser({ cwd, startTime });
  return null; // generic — no transcript source
}

/**
 * Write (idempotently) the settings file that ai-tabs passes to Claude Code
 * via `--settings` when launching a tab, wiring CC's statusLine hook, its
 * attention hooks (turn finished / waiting on the user) and the media panel's
 * PostToolUse hook (image Reads, screenshots) to the bundled forwarders.
 * Per-launch injection means the user's global
 * ~/.claude/settings.json is never modified, and claude outside ai-tabs
 * keeps whatever statusline the user configured.
 * Returns the settings file path.
 */
function ensureHookSettingsFile(dataDir) {
  const scripts = path.join(__dirname, '..', '..', 'scripts');
  const forwarder = path.join(scripts, 'statusline-forward.js');
  const file = path.join(dataDir, 'statusline-hook-settings.json');
  const content = JSON.stringify({
    statusLine: { type: 'command', command: `node "${forwarder}"` },
    hooks: {
      ...buildAttentionHooks(path.join(scripts, 'attention-forward.js')),
      ...buildMediaHooks(path.join(scripts, 'media-forward.js')),
    },
  }, null, 2);
  try {
    if (fs.readFileSync(file, 'utf8') === content) return file;
  } catch {}
  fs.writeFileSync(file, content);
  return file;
}

class StatuslineManager {
  /**
   * opts:
   *   isLive(id)      → session still exists in the PtyManager
   *   hasClients(id)  → session has at least one attached WS client
   *   isEnabled()     → settings.statusline.enabled
   *   broadcast(id, stats) → deliver to the session's clients
   */
  constructor(opts) {
    this.opts = opts;
    this.sessions = new Map(); // id → { agent, cwd, startTime, parser, lastJson }
    this.timer = null;
  }

  register(id, { agent, cwd }) {
    const startTime = Date.now();
    const resolvedCwd = cwd ? path.resolve(cwd) : null;
    let parser = null;
    try {
      parser = createParser(agent, resolvedCwd, startTime);
    } catch {}
    this.sessions.set(id, {
      agent: agent ? { id: agent.id, name: agent.name, color: agent.color, statusline: agent.statusline } : null,
      cwd: resolvedCwd,
      startTime,
      parser,
      lastJson: null,
    });
    this._ensureTimer();
  }

  unregister(id) {
    this.sessions.delete(id);
    if (this.sessions.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Push fresh stats to a session shortly (new client attached / created). */
  pushSoon(id, delayMs = 1200) {
    const t = setTimeout(() => this._tickOne(id, true), delayMs);
    if (t.unref) t.unref();
  }

  /**
   * Ingest a Claude Code statusLine-hook payload (forwarded by
   * scripts/statusline-forward.js). This carries data the transcript alone
   * can't provide: client-computed session cost, the exact context-window
   * size, the model display name, and the exact transcript path.
   *
   * tabSessionId (from the AI_TABS_TAB_ID env var the hook inherits)
   * addresses the session directly; otherwise fall back to matching the
   * payload's workspace cwd against registered sessions.
   * Returns the matched session id, or null.
   */
  applyHook(tabSessionId, payload) {
    if (!payload || typeof payload !== 'object') return null;
    let id = parseTabSessionId(tabSessionId);
    if (!this.sessions.has(id)) {
      id = this._matchByCwd(payload);
      if (id == null) return null;
    }
    const entry = this.sessions.get(id);
    const cost = payload.cost || {};
    const cw = payload.context_window || {};
    const model = payload.model || {};
    entry.hook = {
      at: Date.now(),
      costUsd: typeof cost.total_cost_usd === 'number' ? cost.total_cost_usd : null,
      contextWindow: (typeof cw.context_window_size === 'number' && cw.context_window_size > 0)
        ? cw.context_window_size : null,
      modelDisplay: typeof model.display_name === 'string' && model.display_name ? model.display_name : null,
      transcriptPath: typeof payload.transcript_path === 'string' && payload.transcript_path
        ? payload.transcript_path : null,
      // Subscription (Pro/Max) usage windows; null for API-key users.
      rateLimits: parseRateLimits(payload),
    };
    if (entry.hook.transcriptPath && entry.parser && typeof entry.parser.pinFile === 'function') {
      try {
        entry.parser.pinFile(entry.hook.transcriptPath);
      } catch {}
    }
    this.pushSoon(id, 200);
    return id;
  }

  _matchByCwd(payload) {
    const ws = payload.workspace || {};
    const cwd = ws.current_dir || ws.project_dir || payload.cwd;
    if (typeof cwd !== 'string' || !cwd) return null;
    const resolved = path.resolve(cwd);
    let best = null;
    for (const [id, entry] of this.sessions) {
      if (entry.cwd === resolved && (best == null || entry.startTime > this.sessions.get(best).startTime)) {
        best = id;
      }
    }
    return best;
  }

  _ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), POLL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  _tick() {
    for (const id of [...this.sessions.keys()]) {
      this._tickOne(id, false);
    }
  }

  _tickOne(id, force) {
    const entry = this.sessions.get(id);
    if (!entry) return;
    if (!this.opts.isLive(id)) {
      this.unregister(id);
      return;
    }
    if (!this.opts.hasClients(id)) return;
    if (!this.opts.isEnabled()) return;

    let provider = null;
    if (entry.parser) {
      try {
        provider = entry.parser.poll();
      } catch {}
    }

    // Hook overlay: values from Claude Code's own statusLine JSON are
    // authoritative where they overlap with transcript-derived ones.
    if (entry.hook) {
      provider = provider || {
        model: null, contextUsed: null, contextWindow: null,
        tokensIn: 0, tokensOut: 0, activeMs: null, costUsd: null,
      };
      if (entry.hook.costUsd != null) provider.costUsd = entry.hook.costUsd;
      if (entry.hook.contextWindow != null) provider.contextWindow = entry.hook.contextWindow;
      if (entry.hook.modelDisplay) provider.model = entry.hook.modelDisplay;
      if (entry.hook.rateLimits) provider.rateLimits = entry.hook.rateLimits;
    }

    const stats = {
      sessionId: id,
      agent: entry.agent ? { id: entry.agent.id, name: entry.agent.name, color: entry.agent.color } : null,
      cwd: entry.cwd,
      dirName: entry.cwd ? path.basename(entry.cwd) : null,
      branch: getBranch(entry.cwd),
      elapsedMs: Date.now() - entry.startTime,
      provider,
    };

    // elapsedMs always moves, so compare everything else to skip noise-only
    // rebroadcasts when a tab is sitting idle with no transcript activity.
    const { elapsedMs, ...rest } = stats;
    const json = JSON.stringify(rest);
    const timeShown = provider && provider.activeMs ? provider.activeMs : elapsedMs;
    const secondsChanged = Math.floor(timeShown / 1000) !== entry.lastSeconds;
    if (force || json !== entry.lastJson || secondsChanged) {
      entry.lastJson = json;
      entry.lastSeconds = Math.floor(timeShown / 1000);
      this.opts.broadcast(id, stats);
    }
  }
}

module.exports = { StatuslineManager, createParser, ensureHookSettingsFile };
