const express = require('express');
const { HOOK_BODY_LIMIT, SESSION_ID_RE } = require('./validate');

/**
 * HTTP surface of the media panel, mounted once under /api in server.js.
 *
 *   POST   /media-hook              forwarder ingest (localhost-exempt auth, like attention-hook)
 *   GET    /media/:sessionId        index, newest first
 *   GET    /media/:sessionId/:file  image bytes
 *   DELETE /media/:sessionId/:id    drop one entry
 */
function createMediaRouter({ manager }) {
  const router = express.Router();

  router.post('/media-hook', express.json({ limit: HOOK_BODY_LIMIT }), (req, res) => {
    const result = manager.ingestHook(req.body);
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, stored: result.stored });
  });

  router.param('sessionId', (req, res, next, raw) => {
    if (!SESSION_ID_RE.test(String(raw))) return res.status(400).json({ error: 'bad session id' });
    req.mediaSessionId = parseInt(raw, 10);
    next();
  });

  router.get('/media/:sessionId', (req, res) => {
    res.json({ sessionId: req.mediaSessionId, items: manager.list(req.mediaSessionId) });
  });

  router.get('/media/:sessionId/:file', (req, res) => {
    const abs = manager.store.resolveFile(req.mediaSessionId, req.params.file);
    if (!abs) return res.status(404).json({ error: 'not found' });
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(abs, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'not found' });
    });
  });

  router.delete('/media/:sessionId/:id', (req, res) => {
    const removed = manager.remove(req.mediaSessionId, String(req.params.id));
    if (!removed) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createMediaRouter };
