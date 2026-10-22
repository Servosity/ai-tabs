const crypto = require('crypto');

/**
 * Copy snippets — the fenced code blocks and block quotes in the agent's
 * replies, taken from the raw markdown in the transcript. Copying them out of
 * the terminal drags along the renderer's indentation, quote bars and the
 * hard breaks of soft-wrapped lines; the transcript text has none of that.
 *
 * Held in memory only: a server restart re-learns the transcript from the
 * next statusline payload and the backfill rebuilds the list.
 */

const KIND_CODE = 'code';
const KIND_QUOTE = 'quote';
const MAX_SNIPPETS = 200;
const FENCE_RE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;

/**
 * Pull code blocks and block quotes out of one markdown string, in order.
 * An unclosed fence runs to the end of the text, as markdown renders it.
 * @returns {{kind:string, lang:string|null, text:string}[]}
 */
function extractSnippets(markdown) {
  if (typeof markdown !== 'string' || !markdown) return [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const fence = FENCE_RE.exec(lines[i]);
    if (fence) {
      const [, indent, marker, lang] = fence;
      const body = [];
      i++;
      while (i < lines.length && !isClosingFence(lines[i], marker)) {
        body.push(stripIndent(lines[i], indent.length));
        i++;
      }
      i++; // closing fence
      const text = body.join('\n');
      if (text.trim()) out.push({ kind: KIND_CODE, lang: lang || null, text });
      continue;
    }
    if (QUOTE_RE.test(lines[i])) {
      const body = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        body.push(QUOTE_RE.exec(lines[i])[1]);
        i++;
      }
      const text = body.join('\n').trim();
      if (text) out.push({ kind: KIND_QUOTE, lang: null, text });
      continue;
    }
    i++;
  }
  return out;
}

function isClosingFence(line, marker) {
  const t = line.trim();
  return t.length >= marker.length && t[0] === marker[0] && /^(`+|~+)$/.test(t);
}

/** Drop up to `n` leading spaces: the fence's own indent inside a list item. */
function stripIndent(line, n) {
  let k = 0;
  while (k < n && line[k] === ' ') k++;
  return line.slice(k);
}

/**
 * Per-session, newest-first snippet lists. Same text twice in one session is
 * one snippet (a backfill re-scan must not double the list).
 */
class SnippetStore {
  constructor(opts = {}) {
    this.max = opts.max || MAX_SNIPPETS;
    this.sessions = new Map(); // id → entries (newest first)
  }

  begin(id) {
    this.sessions.delete(id);
  }

  list(id) {
    return (this.sessions.get(id) || []).map(({ sha1, ...pub }) => pub);
  }

  /** @returns {{entry:object, duplicate:boolean}} */
  add(id, { kind, lang = null, text, at = Date.now() }) {
    if (!this.sessions.has(id)) this.sessions.set(id, []);
    const entries = this.sessions.get(id);
    const sha1 = crypto.createHash('sha1').update(`${kind}\0${text}`).digest('hex');
    const existing = entries.find((e) => e.sha1 === sha1);
    if (existing) {
      const { sha1: _omit, ...pub } = existing;
      return { entry: pub, duplicate: true };
    }
    const stamp = Number.isFinite(at) ? at : Date.now();
    const entry = { id: `${stamp}-${sha1.slice(0, 8)}`, kind, lang, text, at: stamp, sha1 };
    const idx = entries.findIndex((e) => e.at < stamp);
    entries.splice(idx === -1 ? entries.length : idx, 0, entry);
    if (entries.length > this.max) entries.length = this.max;
    const { sha1: _omit, ...pub } = entry;
    return { entry: pub, duplicate: false };
  }
}

module.exports = { extractSnippets, SnippetStore, KIND_CODE, KIND_QUOTE, MAX_SNIPPETS };
