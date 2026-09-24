const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MIME_EXT } = require('./extract');
const { imageDimensions, isInside, SESSION_ID_RE, FILE_NAME_RE } = require('./validate');

/**
 * On-disk image store: data/media/<tabSessionId>/{index.json, <id>.<ext>}.
 * The index is newest-first. Content is SHA-1 hashed per session so the hook
 * and the transcript backfill can both offer the same image without storing
 * it twice. Caps evict oldest-first; the global cap prefers evicting sessions
 * that are no longer live.
 */

const INDEX_FILE = 'index.json';
const DEFAULTS = Object.freeze({
  maxEntries: 200,
  maxSessionBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  staleMs: 14 * 24 * 60 * 60 * 1000,
});

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sumBytes(entries) {
  return entries.reduce((n, e) => n + (e.bytes || 0), 0);
}

class MediaStore {
  /**
   * @param {string} root directory (created on demand)
   * @param {object} [opts]
   * @param {(id:number)=>boolean} [opts.isLive]
   */
  constructor(root, opts = {}) {
    this.root = path.resolve(root);
    this.limits = { ...DEFAULTS, ...opts };
    this.isLive = typeof opts.isLive === 'function' ? opts.isLive : () => false;
    this.cache = new Map(); // id → entries (newest first)
  }

  dirFor(id) {
    return path.join(this.root, String(id));
  }

  _entries(id) {
    if (!this.cache.has(id)) {
      this.cache.set(id, readJson(path.join(this.dirFor(id), INDEX_FILE)));
    }
    return this.cache.get(id);
  }

  _save(id, entries) {
    this.cache.set(id, entries);
    const dir = this.dirFor(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, INDEX_FILE), JSON.stringify(entries));
  }

  _unlink(id, entry) {
    try { fs.unlinkSync(path.join(this.dirFor(id), entry.file)); } catch {}
  }

  /** A PTY id is being (re)used: drop whatever an earlier server left there. */
  begin(id) {
    this.cache.delete(id);
    fs.rmSync(this.dirFor(id), { recursive: true, force: true });
  }

  /** @returns {object[]} entries, newest first (public shape, no hash) */
  list(id) {
    return this._entries(id).map(({ sha1, ...pub }) => pub);
  }

  /**
   * Store one image. Returns the public entry plus whether it was already
   * present (in which case nothing was written).
   */
  add(id, { buf, mime, toolName = null, toolUseId = null, sourcePath = null, origin = 'hook', at = Date.now() }) {
    const ext = MIME_EXT[mime];
    if (!ext) throw new Error(`unsupported mime ${mime}`);
    const entries = this._entries(id);
    const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
    const existing = entries.find((e) => e.sha1 === sha1);
    if (existing) {
      const { sha1: _omit, ...pub } = existing;
      return { entry: pub, duplicate: true };
    }

    const stamp = Number.isFinite(at) ? at : Date.now();
    const entryId = `${stamp}-${sha1.slice(0, 8)}`;
    const file = `${entryId}.${ext}`;
    const dims = imageDimensions(buf, mime) || {};
    const entry = {
      id: entryId,
      file,
      mime,
      bytes: buf.length,
      width: dims.width || null,
      height: dims.height || null,
      at: stamp,
      toolName,
      toolUseId,
      sourcePath,
      origin,
      sha1,
    };

    fs.mkdirSync(this.dirFor(id), { recursive: true });
    fs.writeFileSync(path.join(this.dirFor(id), file), buf);
    // Newest first by timestamp so a backfilled older image slots behind
    // anything the hook already delivered.
    const idx = entries.findIndex((e) => e.at <= stamp);
    entries.splice(idx === -1 ? entries.length : idx, 0, entry);
    this._enforceSession(id, entries);
    this._save(id, entries);
    this._enforceTotal();

    const { sha1: _omit, ...pub } = entry;
    return { entry: pub, duplicate: false };
  }

  remove(id, entryId) {
    const entries = this._entries(id);
    const idx = entries.findIndex((e) => e.id === entryId);
    if (idx === -1) return false;
    const [entry] = entries.splice(idx, 1);
    this._unlink(id, entry);
    this._save(id, entries);
    return true;
  }

  /**
   * Absolute path for a served file, or null when the id/name is malformed,
   * unknown to the index, or would escape the session directory.
   */
  resolveFile(id, file) {
    if (!SESSION_ID_RE.test(String(id)) || !FILE_NAME_RE.test(String(file))) return null;
    const dir = this.dirFor(id);
    const abs = path.resolve(dir, file);
    if (!isInside(dir, abs) || path.basename(abs) !== file) return null;
    const known = this._entries(parseInt(id, 10)).some((e) => e.file === file);
    return known ? abs : null;
  }

  _enforceSession(id, entries) {
    while (entries.length > this.limits.maxEntries || sumBytes(entries) > this.limits.maxSessionBytes) {
      const victim = entries.pop();
      if (!victim) break;
      this._unlink(id, victim);
    }
  }

  _sessionIds() {
    let names;
    try {
      names = fs.readdirSync(this.root);
    } catch {
      return [];
    }
    return names.filter((n) => SESSION_ID_RE.test(n)).map((n) => parseInt(n, 10));
  }

  _enforceTotal() {
    const ids = this._sessionIds();
    const sizes = new Map(ids.map((id) => [id, sumBytes(this._entries(id))]));
    let total = [...sizes.values()].reduce((a, b) => a + b, 0);
    if (total <= this.limits.maxTotalBytes) return;

    // Dead sessions first, oldest activity first.
    const dead = ids.filter((id) => !this.isLive(id))
      .sort((a, b) => this._newestAt(a) - this._newestAt(b));
    for (const id of dead) {
      if (total <= this.limits.maxTotalBytes) return;
      total -= sizes.get(id);
      this.begin(id);
    }
    // Then the oldest entries of live sessions.
    const live = ids.filter((id) => this.isLive(id));
    while (total > this.limits.maxTotalBytes) {
      let oldestId = null;
      for (const id of live) {
        const entries = this._entries(id);
        if (!entries.length) continue;
        const oldest = oldestId == null ? null : this._entries(oldestId);
        if (!oldest || entries[entries.length - 1].at < oldest[oldest.length - 1].at) oldestId = id;
      }
      if (oldestId == null) return;
      const entries = this._entries(oldestId);
      const victim = entries.pop();
      total -= victim.bytes || 0;
      this._unlink(oldestId, victim);
      this._save(oldestId, entries);
    }
  }

  _newestAt(id) {
    const entries = this._entries(id);
    return entries.length ? entries[0].at : 0;
  }

  /** Startup sweep: drop directories of dead sessions untouched for staleMs. */
  sweep(now = Date.now()) {
    for (const id of this._sessionIds()) {
      if (this.isLive(id)) continue;
      let mtime = 0;
      try { mtime = fs.statSync(this.dirFor(id)).mtimeMs; } catch {}
      if (now - mtime > this.limits.staleMs) this.begin(id);
    }
  }
}

module.exports = { MediaStore, DEFAULTS };
