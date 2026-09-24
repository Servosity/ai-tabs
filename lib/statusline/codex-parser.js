const fs = require('fs');
const os = require('os');
const path = require('path');
const { TailReader } = require('./tail-reader');

/**
 * Codex CLI rollout parser. Codex writes one JSONL "rollout" per session
 * under ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Lines look like:
 *   { timestamp, type: 'session_meta'|'turn_context'|'event_msg'|..., payload }
 * Token accounting arrives as event_msg payloads of type 'token_count':
 *   payload.info = { total_token_usage, last_token_usage, model_context_window }
 * We match the session to this tab by cwd (from session_meta/turn_context)
 * and by mtime >= PTY start. Written defensively — unknown line shapes are
 * skipped so format drift degrades to "no data", not a crash.
 */

const RESCAN_INTERVAL_MS = 10_000;
const MTIME_SLACK_MS = 60_000;
const PEEK_BYTES = 16 * 1024; // head of a rollout is enough to find its cwd

function lower(s) { return String(s || '').toLowerCase(); }

/** Extract current-context tokens from a codex TokenUsage-shaped object. */
function contextFromUsage(u) {
  if (!u || typeof u !== 'object') return null;
  if (typeof u.total_tokens === 'number') {
    // Reasoning output leaves the context between turns.
    return Math.max(0, u.total_tokens - (u.reasoning_output_tokens || 0));
  }
  if (typeof u.input_tokens === 'number') {
    // input_tokens already includes cached_input_tokens in codex.
    return (u.input_tokens || 0) + (u.output_tokens || 0);
  }
  return null;
}

class CodexParser {
  constructor({ cwd, startTime, root }) {
    this.root = root || path.join(os.homedir(), '.codex', 'sessions');
    this.cwd = path.resolve(cwd || os.homedir());
    this.startTime = startTime || Date.now();
    this.reader = null;
    this.lastScanAt = 0;
    this._resetState();
  }

  _resetState() {
    this.model = null;
    this.window = null;
    this.tokensIn = 0;
    this.tokensOut = 0;
    this.contextUsed = null;
    this.activeMs = 0;
    this.taskStartTs = null;
  }

  /** All rollout files recently written, newest first. The dir tree is
   *  sessions/YYYY/MM/DD/ — walk only date dirs, skip anything odd. */
  _candidateFiles() {
    const out = [];
    const walk = (dir, depth) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 3 && /^\d+$/.test(e.name)) walk(full, depth + 1);
        } else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
          let st;
          try {
            st = fs.statSync(full);
          } catch {
            continue;
          }
          if (st.mtimeMs >= this.startTime - MTIME_SLACK_MS) {
            out.push({ file: full, mtime: st.mtimeMs });
          }
        }
      }
    };
    walk(this.root, 0);
    out.sort((a, b) => b.mtime - a.mtime);
    return out;
  }

  /** Read the head of a rollout and pull the session's cwd out of
   *  session_meta / turn_context, if present. */
  _peekCwd(file) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return null;
    }
    let text;
    try {
      const buf = Buffer.alloc(PEEK_BYTES);
      const got = fs.readSync(fd, buf, 0, PEEK_BYTES, 0);
      text = buf.toString('utf8', 0, got);
    } finally {
      fs.closeSync(fd);
    }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let j;
      try {
        j = JSON.parse(t);
      } catch {
        continue;
      }
      const p = j && j.payload;
      const cwd = (p && typeof p.cwd === 'string' && p.cwd)
        || (typeof j.cwd === 'string' && j.cwd) || null;
      if (cwd) return cwd;
    }
    return null;
  }

  _pickFile() {
    for (const { file } of this._candidateFiles()) {
      const cwd = this._peekCwd(file);
      // A rollout that names a different cwd belongs to another tab; one with
      // no discoverable cwd is only taken as a last resort (older formats).
      if (cwd == null || path.resolve(cwd) === this.cwd) return file;
    }
    return null;
  }

  _processLine(j) {
    if (!j || typeof j !== 'object') return;
    const p = (j.payload && typeof j.payload === 'object') ? j.payload : {};
    const type = j.type || p.record_type;

    if (type === 'turn_context') {
      if (typeof p.model === 'string' && p.model) this.model = p.model;
      return;
    }
    if (type === 'session_meta') {
      if (typeof p.model === 'string' && p.model) this.model = p.model;
      return;
    }
    // Active time: sum of task_started → task_complete spans. That's the
    // stretch codex is generating/running tools; the gaps between tasks are
    // the user typing. An aborted task (no task_complete) is dropped.
    if (type === 'event_msg' && (p.type === 'task_started' || p.type === 'task_complete')) {
      const ts = Date.parse(j.timestamp || '');
      if (!Number.isNaN(ts)) {
        if (p.type === 'task_started') {
          this.taskStartTs = ts;
        } else if (this.taskStartTs != null && ts > this.taskStartTs) {
          this.activeMs += ts - this.taskStartTs;
          this.taskStartTs = null;
        }
      }
      return;
    }
    if (type === 'event_msg' && p.type === 'token_count') {
      // Newer format nests usage under info; older put it on the payload.
      const info = (p.info && typeof p.info === 'object') ? p.info : p;
      const total = info.total_token_usage;
      const last = info.last_token_usage;
      if (total && typeof total === 'object') {
        this.tokensIn = total.input_tokens || 0;
        this.tokensOut = total.output_tokens || 0;
      } else if (typeof info.input_tokens === 'number') {
        this.tokensIn = info.input_tokens || 0;
        this.tokensOut = info.output_tokens || 0;
      }
      if (typeof info.model_context_window === 'number' && info.model_context_window > 0) {
        this.window = info.model_context_window;
      }
      const ctx = contextFromUsage(last) ?? contextFromUsage(total)
        ?? contextFromUsage(typeof info.input_tokens === 'number' ? info : null);
      if (ctx != null) this.contextUsed = ctx;
    }
  }

  poll() {
    const now = Date.now();
    let consumed = 0;
    if (this.reader) {
      consumed = this.reader.readNew((j) => this._processLine(j));
    }

    const quiet = !this.reader || consumed <= 0;
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

    return {
      model: this.model,
      contextUsed: this.contextUsed,
      contextWindow: this.window, // null when codex hasn't reported one — bar hidden
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      activeMs: this.activeMs > 0 ? this.activeMs : null,
      costUsd: null,
    };
  }
}

module.exports = { CodexParser, contextFromUsage };
