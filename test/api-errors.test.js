const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { apiNotFound, apiErrorHandler } = require('../lib/api-errors');

// A server left running across an upgrade keeps serving the routes it booted
// with. Everything below covers that case: the server must say "no such
// endpoint" in JSON, never an Express HTML page a client cannot parse.

function withApp(handler) {
  const app = express();
  app.get('/api/known', (req, res) => res.json({ ok: true }));
  app.post('/api/boom', () => { throw Object.assign(new Error('kaboom'), { status: 503, code: 'NOPE' }); });
  app.use('/api', apiNotFound('9.9.9'));
  app.use('/api', apiErrorHandler(() => {}));

  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        resolve(await handler(`http://127.0.0.1:${server.address().port}`));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

// ── Server side: /api never answers with HTML ───────────────────────────────

test('an unknown /api route answers with JSON, not Express HTML', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/no-such/route`, { method: 'POST' });
    assert.strictEqual(res.status, 404);
    assert.match(res.headers.get('content-type'), /application\/json/);

    const body = await res.json();
    assert.strictEqual(body.code, 'UNKNOWN_ENDPOINT');
    assert.strictEqual(body.serverVersion, '9.9.9');
    assert.match(body.error, /POST \/api\/no-such\/route/);
  });
});

test('a route that throws answers with its status and code as JSON', async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/api/boom`, { method: 'POST' });
    assert.strictEqual(res.status, 503);

    const body = await res.json();
    assert.deepStrictEqual(body, { error: 'kaboom', code: 'NOPE' });
  });
});

test('the fallbacks leave working routes alone', async () => {
  await withApp(async (base) => {
    assert.deepStrictEqual(await fetch(`${base}/api/known`).then(r => r.json()), { ok: true });
  });
});
