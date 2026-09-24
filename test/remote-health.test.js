const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const {
  waitForRemoteHealth,
  REMOTE_HEALTH_ATTEMPTS,
  REMOTE_HEALTH_PROBE_TIMEOUT_MS,
  REMOTE_HEALTH_RETRY_DELAY_MS,
} = require('../lib/remote-health');

// 192.0.2.0/24 is TEST-NET-1 (RFC 5737): guaranteed unrouted, so connects
// black-hole exactly like a powered-off VM — the shape that used to hang
// startup for ~17 minutes on Windows connect timeouts.
const BLACKHOLE_URL = 'http://192.0.2.1:25283';

// Full default budget plus generous slack for slow CI — still two orders of
// magnitude under the old failure mode.
const WORST_CASE_MS =
  REMOTE_HEALTH_ATTEMPTS * (REMOTE_HEALTH_PROBE_TIMEOUT_MS + REMOTE_HEALTH_RETRY_DELAY_MS);
const ELAPSED_LIMIT_MS = WORST_CASE_MS + 5000;

function listen(handler, t) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    t.after(() => server.close());
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

test('unreachable host fails within the ~5s budget, not minutes', async () => {
  const started = Date.now();
  await assert.rejects(
    waitForRemoteHealth(BLACKHOLE_URL, fetch),
    (err) => {
      assert.match(err.message, /Cannot reach remote ai-tabs server/);
      assert.strictEqual(err.remoteStatus, null); // host never answered
      return true;
    }
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < ELAPSED_LIMIT_MS, `took ${elapsed}ms, budget ${ELAPSED_LIMIT_MS}ms`);
});

test('timeout aborts count as failed attempts and are retried', async () => {
  let calls = 0;
  const neverSettles = (url, { signal }) => {
    calls++;
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    });
  };
  await assert.rejects(
    waitForRemoteHealth('http://example.invalid', neverSettles, {
      attempts: 3, probeTimeoutMs: 50, retryDelayMs: 10,
    }),
    /Cannot reach remote/
  );
  assert.strictEqual(calls, 3);
});

test('healthy server resolves immediately', async (t) => {
  const base = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  }, t);
  await waitForRemoteHealth(base, fetch);
});

test('401 stops retrying and surfaces remoteStatus for the dialog', async (t) => {
  let hits = 0;
  const base = await listen((req, res) => {
    hits++;
    res.writeHead(401);
    res.end();
  }, t);
  await assert.rejects(
    waitForRemoteHealth(base, fetch),
    (err) => err.remoteStatus === 401
  );
  assert.strictEqual(hits, 1, '401 must break the loop on the first attempt');
});

test('403 stops retrying and surfaces remoteStatus for the dialog', async (t) => {
  let hits = 0;
  const base = await listen((req, res) => {
    hits++;
    res.writeHead(403);
    res.end();
  }, t);
  await assert.rejects(
    waitForRemoteHealth(base, fetch),
    (err) => err.remoteStatus === 403
  );
  assert.strictEqual(hits, 1, '403 must break the loop on the first attempt');
});
