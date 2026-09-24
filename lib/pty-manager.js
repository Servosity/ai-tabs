const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const { PromptDetector } = require('./prompt-detector');

const RING_BUFFER_SIZE = 8192; // ~8KB of recent output per session
const WRITE_CHUNK_SIZE = 4096; // Max bytes per PTY write (winpty buffer limit)
const WRITE_CHUNK_DELAY = 4;   // ms between chunks

// Alternate-screen tracking. A full-screen TUI (any agent) switches to the alt
// screen and from then on paints by cursor addressing, so the ring buffer holds
// redraw fragments rather than anything with a readable layout — replaying it
// to a reattaching client produces garbage. Knowing which screen a session is
// on lets the caller skip the replay and ask the app to repaint instead.
const ALT_SCREEN_TOGGLE = /\x1b\[\?(?:1049|1047|47)(h|l)/g;
// Longest toggle sequence is `ESC [ ? 1049 h` (8 chars); carry one less than
// that between chunks so a sequence split across a chunk boundary still matches.
const ALT_SCREEN_CARRY = 7;

// Repaint nudge. Resizing the PTY raises SIGWINCH, which makes a full-screen app
// redraw itself from its own state — the only way to reconstruct the screen,
// since the app never re-sends what it already painted. Shrink by a column and
// restore, so the app sees a real change and the final size still matches the
// client's.
const REPAINT_NUDGE_COLS = 1;
const REPAINT_NUDGE_STEP_DELAY = 40; // ms between the shrink and the restore
const MIN_REPAINT_COLS = 2;

/**
 * Fold alt-screen toggles found in `data` into the running state. Last toggle in
 * the chunk wins; a chunk with no toggle leaves the state alone. Re-scanning the
 * carried tail is harmless — resolving to the same last toggle is idempotent.
 */
function trackAltScreen(current, data) {
  let match;
  let last = null;
  ALT_SCREEN_TOGGLE.lastIndex = 0;
  while ((match = ALT_SCREEN_TOGGLE.exec(data)) !== null) last = match[1];
  if (last === null) return current;
  return last === 'h';
}

function detectShell() {
  if (process.env.AI_TABS_SHELL) return process.env.AI_TABS_SHELL;
  if (process.env.CC_TABS_SHELL) return process.env.CC_TABS_SHELL; // legacy cc-tabs name
  if (process.platform === 'win32') {
    for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']) {
      if (fs.existsSync(p)) return p;
    }
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

function shellArgs(shell) {
  const name = path.basename(shell).toLowerCase();
  if (name === 'cmd.exe' || name === 'powershell.exe' || name === 'pwsh.exe') return [];
  return ['--login', '-i'];
}

const SHELL = detectShell();

// Env vars that identify one specific Claude Code process — its session id, its
// pid, whether it is itself a child session. If ai-tabs was launched from inside
// a Claude Code session (a `claude` session running `ai-tabs.cmd`, say) it
// inherits these, and spreading process.env into every PTY hands that identity
// to unrelated terminals. Claude Code then reads CLAUDE_CODE_CHILD_SESSION and
// treats a brand-new top-level session as somebody's subagent: transcript
// saving off, degraded output.
//
// CLAUDECODE is deliberately NOT here. It marks "running inside Claude Code" in
// general rather than naming a session, and per the multi-agent spec plain
// terminals keep whatever they inherit — lib/agents.js clears it for Claude
// launches specifically.
const INHERITED_SESSION_ENV = Object.freeze([
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
]);

// Colour-suppression flags. Every PTY here is an xterm.js terminal and the
// spawn below asserts TERM=xterm-256color and COLORTERM=truecolor, so a colour
// terminal is not in question — but an inherited NO_COLOR outranks both and
// silently drops every session to monochrome. Agent TUIs then render flat
// white, which reads as a broken theme rather than an inherited flag. Tools
// that shell out set NO_COLOR routinely (Claude Code sets it for its own tool
// subprocesses), so launching ai-tabs from one is enough to poison every tab.
const COLOR_SUPPRESSION_ENV = Object.freeze(['NO_COLOR', 'FORCE_COLOR']);

/**
 * process.env minus what a terminal must not inherit from whatever launched the
 * app: another tool's Claude Code session identity, and its colour-suppression
 * flags. Callers can still set any of them back through extraEnv — this only
 * drops what arrived by accident.
 */
function baseEnv(source = process.env) {
  const env = { ...source };
  for (const key of [...INHERITED_SESSION_ENV, ...COLOR_SUPPRESSION_ENV]) delete env[key];
  return env;
}

/**
 * Circular buffer storing the last N bytes of PTY output.
 */
class RingBuffer {
  constructor(capacity = RING_BUFFER_SIZE) {
    this.buf = Buffer.alloc(capacity);
    this.capacity = capacity;
    this.length = 0;
    this.writePos = 0;
  }

  push(data) {
    const bytes = Buffer.from(data, 'utf8');
    if (bytes.length >= this.capacity) {
      // Data larger than buffer — just keep the tail
      bytes.copy(this.buf, 0, bytes.length - this.capacity);
      this.writePos = 0;
      this.length = this.capacity;
    } else {
      const spaceAtEnd = this.capacity - this.writePos;
      if (bytes.length <= spaceAtEnd) {
        bytes.copy(this.buf, this.writePos);
      } else {
        bytes.copy(this.buf, this.writePos, 0, spaceAtEnd);
        bytes.copy(this.buf, 0, spaceAtEnd);
      }
      this.writePos = (this.writePos + bytes.length) % this.capacity;
      this.length = Math.min(this.length + bytes.length, this.capacity);
    }
  }

  toString() {
    if (this.length === 0) return '';
    if (this.length < this.capacity) {
      return this.buf.toString('utf8', 0, this.length);
    }
    // Buffer has wrapped — read from writePos to end, then start to writePos
    const tail = this.buf.toString('utf8', this.writePos, this.capacity);
    const head = this.buf.toString('utf8', 0, this.writePos);
    return tail + head;
  }
}

class PtyManager {
  constructor({ spawn = pty.spawn } = {}) {
    this.sessions = new Map();
    this.nextId = 1;
    this.spawn = spawn;
  }

  create(cwd, onData, onExit, onIdle, cols = 120, rows = 30, extraEnv = {}, detection = {}, metadata = {}) {
    const id = this.nextId++;

    const proc = this.spawn(SHELL, shellArgs(SHELL), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd || process.env.HOME || process.env.USERPROFILE,
      useConpty: process.platform === 'win32' ? true : undefined,
      env: {
        ...baseEnv(),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        PYTHONIOENCODING: 'utf-8',
        ...extraEnv,
      },
    });

    const detector = new PromptDetector(id, detection);
    const ringBuffer = new RingBuffer();

    let altScreen = false;
    let altCarry = '';

    proc.onData((data) => {
      ringBuffer.push(data);
      const scan = altCarry + data;
      altScreen = trackAltScreen(altScreen, scan);
      altCarry = scan.slice(-ALT_SCREEN_CARRY);
      const session = this.sessions.get(id);
      if (session) session.altScreen = altScreen;
      onData(data);
      detector.feed(data);
    });

    proc.onExit(({ exitCode }) => {
      this.sessions.delete(id);
      onExit(exitCode);
    });

    detector.on('idle', () => {
      const session = this.sessions.get(id);
      if (!session || session.idle) return; // Don't re-broadcast if already idle
      session.idle = true;
      if (onIdle) onIdle();
    });

    this.sessions.set(id, {
      proc, detector, ringBuffer, cwd, idle: false, cols, rows, altScreen: false,
      createdAt: Date.now(),
      agentId: metadata.agentId || null,
    });
    return { id, pid: proc.pid };
  }

  write(id, data) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.idle = false;

    // Small writes go straight through
    if (Buffer.byteLength(data, 'utf8') <= WRITE_CHUNK_SIZE) {
      session.proc.write(data);
      return;
    }

    // Large writes get chunked so winpty's input buffer doesn't overflow
    const chunks = [];
    let remaining = data;
    while (remaining.length > 0) {
      // Find a cut point that doesn't exceed WRITE_CHUNK_SIZE in bytes
      let end = remaining.length;
      while (Buffer.byteLength(remaining.slice(0, end), 'utf8') > WRITE_CHUNK_SIZE) {
        end = Math.ceil(end / 2);
      }
      chunks.push(remaining.slice(0, end));
      remaining = remaining.slice(end);
    }

    let i = 0;
    const writeNext = () => {
      if (i >= chunks.length) return;
      if (!this.sessions.has(id)) return; // session killed mid-paste
      session.proc.write(chunks[i++]);
      if (i < chunks.length) setTimeout(writeNext, WRITE_CHUNK_DELAY);
    };
    writeNext();
  }

  resize(id, cols, rows) {
    const session = this.sessions.get(id);
    if (!session) return;
    // Skip no-op resizes — they cause the shell to redraw its prompt,
    // producing PTY output that triggers false idle detection on background tabs.
    if (session.cols === cols && session.rows === rows) return;
    session.cols = cols;
    session.rows = rows;
    session.proc.resize(cols, rows);
  }

  /**
   * True when the session is currently on the alternate screen, i.e. a
   * full-screen TUI owns the display and the ring buffer is not replayable.
   */
  isAltScreen(id) {
    const session = this.sessions.get(id);
    return !!(session && session.altScreen);
  }

  /**
   * Make the running program repaint the whole screen by raising SIGWINCH.
   * Returns false when there is nothing to nudge. Deliberately bypasses the
   * no-op guard in resize() — the redraw IS the point here.
   *
   * session.cols/rows stay at the real size throughout, so a client resize
   * arriving mid-nudge is what gets restored.
   */
  forceRepaint(id) {
    const session = this.sessions.get(id);
    if (!session || !session.cols || !session.rows) return false;
    const shrunk = Math.max(MIN_REPAINT_COLS, session.cols - REPAINT_NUDGE_COLS);
    if (shrunk === session.cols) return false;

    session.proc.resize(shrunk, session.rows);
    setTimeout(() => {
      const live = this.sessions.get(id);
      if (!live) return; // session died mid-nudge
      live.proc.resize(live.cols, live.rows);
    }, REPAINT_NUDGE_STEP_DELAY);
    return true;
  }

  kill(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.detector.destroy();
      session.proc.kill();
      this.sessions.delete(id);
    }
  }

  killAll() {
    for (const id of this.sessions.keys()) {
      this.kill(id);
    }
  }

  /**
   * Get recent output from the ring buffer (raw with escape sequences).
   */
  getRecentOutput(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    return session.ringBuffer.toString();
  }

  /**
   * Get recent output with ANSI escape sequences stripped (plain text).
   */
  getRecentOutputPlain(id) {
    const raw = this.getRecentOutput(id);
    if (raw == null) return null;

    const stripped = raw
      // ANSI CSI sequences (colors, cursor movement, etc.)
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      // OSC sequences
      .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
      // Mode set/reset
      .replace(/\x1b\[[\?]?[0-9;]*[hl]/g, '')
      // Charset switching
      .replace(/\x1b[()][0-9A-B]/g, '')
      // Other escape sequences
      .replace(/\x1b[>=7-9cDEFHMNOPVWXZ\\^_]/g, '')
      // Replacement characters from broken UTF-8 at buffer boundary
      .replace(/\uFFFD+/g, '')
      // Lone surrogates from broken emoji
      .replace(/[\uD800-\uDFFF]/g, '');

    // Simulate CR: within each \n-delimited line, \r overwrites from the start,
    // so keep only the content after the last \r. This collapses spinner frames.
    const lines = stripped.split('\n').map(line => {
      const lastCR = line.lastIndexOf('\r');
      return lastCR >= 0 ? line.slice(lastCR + 1) : line;
    });

    // Deduplicate consecutive identical lines (repeated animation frames)
    const deduped = lines.filter((line, i) => i === 0 || line !== lines[i - 1]);

    // Return last 50 lines so the reconnect banner isn't buried
    return deduped.slice(-50).join('\n');
  }

  /**
   * Get session metadata for the REST API.
   */
  getSessionInfo(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    return {
      id,
      cwd: session.cwd,
      idle: session.idle,
      createdAt: session.createdAt,
      agentId: session.agentId,
    };
  }

  /**
   * List all sessions with metadata.
   */
  listSessions() {
    const result = [];
    for (const [id] of this.sessions) {
      result.push(this.getSessionInfo(id));
    }
    return result;
  }
}

module.exports = { PtyManager, baseEnv, trackAltScreen, INHERITED_SESSION_ENV, COLOR_SUPPRESSION_ENV };
