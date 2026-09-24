const fs = require('fs');
const path = require('path');
const { parseHookPayload, resolveImportPath, MAX_IMAGE_BYTES } = require('./validate');
const { TranscriptScanner } = require('./transcript-scan');

/**
 * MediaManager — glue between the hook route, the transcript backfill, the
 * MediaStore and the per-session WebSocket broadcast. One instance per server.
 *
 * opts:
 *   store            MediaStore
 *   isLive(id)       → PTY still exists
 *   hasClients(id)   → at least one attached WS client (gates transcript polling)
 *   cwdFor(id)       → session cwd (limits path imports), may return null
 *   broadcast(id, msg)
 *   pollMs           transcript poll interval
 */

const POLL_MS = 5000;
const ORIGIN_HOOK = 'hook';
const ORIGIN_TRANSCRIPT = 'transcript';

class MediaManager {
  constructor(opts) {
    this.store = opts.store;
    this.isLive = opts.isLive || (() => false);
    this.hasClients = opts.hasClients || (() => true);
    this.cwdFor = opts.cwdFor || (() => null);
    this.broadcast = opts.broadcast || (() => {});
    this.pollMs = opts.pollMs || POLL_MS;
    this.scanners = new Map(); // id → TranscriptScanner
    this.timer = null;
  }

  beginSession(id) {
    this.scanners.delete(id);
    this.store.begin(id);
  }

  endSession(id) {
    this.scanners.delete(id);
    if (this.scanners.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  list(id) {
    return this.store.list(id);
  }

  remove(id, entryId) {
    const removed = this.store.remove(id, entryId);
    if (removed) this.broadcast(id, { type: 'media-removed', sessionId: id, id: entryId });
    return removed;
  }

  /**
   * Ingest a forwarder payload. Returns {ok, stored, error}.
   */
  ingestHook(body) {
    const parsed = parseHookPayload(body);
    if (!parsed.ok) return { ok: false, stored: 0, error: parsed.error };
    const { tabSessionId: id, images, meta } = parsed;
    if (!this.isLive(id)) return { ok: false, stored: 0, error: 'session not live' };

    if (meta.transcriptPath) this.setTranscript(id, meta.transcriptPath);

    let stored = 0;
    for (const img of images) {
      const buf = img.buf || this._readImport(id, img.path, meta.cwd);
      if (!buf) continue;
      const { duplicate } = this._store(id, {
        buf,
        mime: img.mime,
        toolName: meta.toolName,
        toolUseId: meta.toolUseId,
        sourcePath: meta.sourcePath || img.path || null,
        origin: ORIGIN_HOOK,
      });
      if (!duplicate) stored++;
    }
    return { ok: true, stored };
  }

  _readImport(id, candidate, hookCwd) {
    const abs = resolveImportPath(candidate, [this.cwdFor(id), hookCwd]);
    if (!abs) return null;
    try {
      if (fs.statSync(abs).size > MAX_IMAGE_BYTES) return null;
      return fs.readFileSync(abs);
    } catch {
      return null;
    }
  }

  /**
   * Learn (or re-learn after /clear) which transcript backs a tab. Schedules
   * a backfill scan; subsequent polls pick up appended images.
   */
  setTranscript(id, transcriptPath) {
    if (typeof transcriptPath !== 'string' || !transcriptPath || !this.isLive(id)) return;
    const resolved = path.resolve(transcriptPath);
    const current = this.scanners.get(id);
    if (current && current.filePath === resolved) return;
    this.scanners.set(id, new TranscriptScanner(resolved));
    this._ensureTimer();
    const t = setTimeout(() => this.pollOne(id), 0);
    if (t.unref) t.unref();
  }

  _ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.pollAll(), this.pollMs);
    if (this.timer.unref) this.timer.unref();
  }

  pollAll() {
    for (const id of [...this.scanners.keys()]) this.pollOne(id);
  }

  /** Returns the number of images stored by this poll. */
  pollOne(id) {
    const scanner = this.scanners.get(id);
    if (!scanner) return 0;
    if (!this.isLive(id)) {
      this.endSession(id);
      return 0;
    }
    if (!this.hasClients(id)) return 0;
    let stored = 0;
    try {
      scanner.readNew((img) => {
        const buf = Buffer.from(img.data, 'base64');
        if (!buf.length || buf.length > MAX_IMAGE_BYTES) return;
        const { duplicate } = this._store(id, {
          buf,
          mime: img.mime,
          toolName: img.toolName,
          toolUseId: img.toolUseId,
          origin: ORIGIN_TRANSCRIPT,
          at: img.at || undefined,
        });
        if (!duplicate) stored++;
      });
    } catch {}
    return stored;
  }

  _store(id, item) {
    const result = this.store.add(id, item);
    if (!result.duplicate) {
      this.broadcast(id, { type: 'media', sessionId: id, item: result.entry });
    }
    return result;
  }
}

module.exports = { MediaManager, POLL_MS };
