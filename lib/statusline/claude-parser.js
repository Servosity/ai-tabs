const fs = require('fs');
const os = require('os');
const path = require('path');
const { TailReader } = require('./tail-reader');

/**
 * Claude Code transcript parser. Locates the session's transcript under
 * ~/.claude/projects/<slug>/ and incrementally derives:
 *   - contextUsed:  newest real main-context assistant usage (bar numerator)
 *   - tokensIn/Out: cumulative session tokens, deduped by API message id
 *                   (streaming logs the same response on multiple lines)
 *   - activeMs:     wall-clock minus the gaps where Claude sat waiting on the
 *                   user (tool/agent time inside a turn IS counted)
 * Port of servosity/claude-code-statusline's scan_transcript, restructured
 * to stream so each poll only processes newly appended lines.
 */

const DEFAULT_CONTEXT_WINDOW = 200_000;
const RESCAN_INTERVAL_MS = 10_000;
// A transcript counts as "this session's" if modified after the PTY started
// (small slack for clock/fs timestamp skew).
const MTIME_SLACK_MS = 60_000;

function slugForCwd(cwd) {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

function usedTotal(usage) {
  if (!usage) return 0;
  // Current context = non-cached input + cached input (read + created).
  // output_tokens are generated, not context.
  return (usage.input_tokens || 0)
    + (usage.cache_read_input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0);
}

function isToolResultMsg(msg) {
  // A user-role message carrying tool_result blocks is a tool RETURN, not a
  // human turn — the gap before it was tool execution, so it stays "active".
  const content = msg && msg.content;
  if (!Array.isArray(content)) return false;
  return content.some((i) => i && i.type === 'tool_result');
}

function hasNoResponseContent(msg) {
  const content = msg && msg.content;
  if (!Array.isArray(content)) return false;
  return content.some((i) => i && i.type === 'text'
    && String(i.text || '').toLowerCase().includes('no response requested'));
}

function parseTs(j) {
  const t = Date.parse(j.timestamp || '');
  return Number.isNaN(t) ? null : t;
}

class ClaudeParser {
  constructor({ cwd, startTime, dir }) {
    this.dir = dir || path.join(os.homedir(), '.claude', 'projects', slugForCwd(cwd || os.homedir()));
    this.startTime = startTime || Date.now();
    this.reader = null;
    this.lastScanAt = 0;
    this._resetState();
  }

  _resetState() {
    this.seenIds = new Set();
    this.tokensIn = 0;
    this.tokensOut = 0;
    this.costUsd = null;
    this.latestTs = -Infinity;
    this.latestUsage = null;
    this.model = null;
    this.prevMain = null; // { ts, role } of the last main-thread message
    this.activeMs = 0;
  }

  /**
   * Pin the parser to an exact transcript file (from the statusline hook's
   * transcript_path). Beats the newest-mtime heuristic: with two tabs in the
   * same cwd each pin tracks its own session, and a /clear re-pins to the new
   * transcript on the next hook invocation.
   */
  pinFile(filePath) {
    if (!filePath || typeof filePath !== 'string') return;
    const resolved = path.resolve(filePath);
    if (this.pinned === resolved && this.reader) return;
    this.pinned = resolved;
    this.reader = new TailReader(resolved);
    this._resetState();
  }

  /** Newest transcript in the project dir that's been written since session start. */
  _pickFile() {
    let entries;
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return null;
    }
    let best = null;
    let bestMtime = 0;
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(this.dir, name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (st.mtimeMs < this.startTime - MTIME_SLACK_MS) continue;
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = full;
      }
    }
    return best;
  }

  _processLine(j) {
    if (!j || typeof j !== 'object') return;
    const msg = (j.message && typeof j.message === 'object') ? j.message : {};
    const usage = msg.usage;
    const sidechain = j.isSidechain === true;
    const ts = parseTs(j);

    // Active time: main-thread messages only. Subagent wall-time is already
    // captured as the main-thread gap between Task tool_use and tool_result.
    if (!sidechain && ts != null) {
      if (this.prevMain) {
        const waitingOnUser = this.prevMain.role === 'assistant'
          && msg.role === 'user' && !isToolResultMsg(msg);
        const dt = ts - this.prevMain.ts;
        if (!waitingOnUser && dt > 0) this.activeMs += dt;
      }
      this.prevMain = { ts, role: msg.role };
    }

    // Cumulative in/out: every usage (incl. sidechains) once, deduped by API
    // message id so streaming partials of one response don't multiply totals.
    if (usage) {
      const mid = msg.id || j.uuid;
      if (mid && !this.seenIds.has(mid)) {
        this.seenIds.add(mid);
        this.tokensIn += usedTotal(usage);
        this.tokensOut += usage.output_tokens || 0;
      }
    }

    // Older Claude Code versions logged per-message cost; sum when present.
    if (typeof j.costUSD === 'number') {
      this.costUsd = (this.costUsd || 0) + j.costUSD;
    }

    // Bar numerator: newest real main-context assistant usage only.
    const model = String(msg.model || '').toLowerCase();
    if (sidechain
      || msg.role !== 'assistant'
      || model.includes('synthetic')
      || j.isApiErrorMessage === true
      || usedTotal(usage) === 0
      || hasNoResponseContent(msg)) {
      return;
    }
    if (ts != null && ts > this.latestTs) {
      this.latestTs = ts;
      this.latestUsage = usage;
      if (msg.model) this.model = msg.model;
    } else if (ts === this.latestTs && usedTotal(usage) > usedTotal(this.latestUsage)) {
      this.latestUsage = usage;
    }
  }

  poll() {
    const now = Date.now();
    let consumed = 0;
    if (this.reader) {
      consumed = this.reader.readNew((j) => this._processLine(j));
    }

    // Rescan when we have no file, the file vanished, or it's gone quiet —
    // a /clear or relaunch inside the tab starts a NEW transcript file.
    // A pinned parser never rescans: the hook is the authority on which file.
    const quiet = !this.pinned && (!this.reader || consumed <= 0);
    if (quiet && now - this.lastScanAt >= RESCAN_INTERVAL_MS) {
      this.lastScanAt = now;
      const file = this._pickFile();
      if (file && (!this.reader || this.reader.filePath !== file)) {
        this.reader = new TailReader(file);
        this._resetState();
        this.reader.readNew((j) => this._processLine(j));
      } else if (!file && consumed === -1) {
        this.reader = null;
        this._resetState();
      }
    }

    if (!this.reader) return null;

    const modelId = String(this.model || '').toLowerCase();
    const contextWindow = modelId.includes('1m') ? 1_000_000 : DEFAULT_CONTEXT_WINDOW;
    return {
      model: this.model,
      contextUsed: this.latestUsage ? usedTotal(this.latestUsage) : null,
      contextWindow,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      activeMs: this.activeMs > 0 ? Math.round(this.activeMs) : null,
      costUsd: this.costUsd,
    };
  }
}

module.exports = { ClaudeParser, slugForCwd, usedTotal };
