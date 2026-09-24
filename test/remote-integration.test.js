// End-to-end remote-mode auth: spawn a real server.js with a password set,
// reach it via the machine's own LAN IP (localhost is auth-exempt, so only a
// non-loopback address exercises authMiddleware), and drive /api/projects and
// /api/open-tab through the renderer fetch wrapper.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { installRemoteAuthFetch } = require('../public/remote-auth.js');
const { startTestServer, stopTestServer, PASSWORD } = require('./helpers/spawn-server.js');

let handle = null;
let base = null;
let skip = false;

before(async () => {
  handle = await startTestServer();
  base = handle.base;
  if (!base) skip = 'no non-internal IPv4 on this machine — cannot exercise remote auth';
});

after(() => stopTestServer(handle));

// Wrapped fetch as the Electron renderer sees it: key in the hash, exactly the
// withLoadSuffix format.
function wrappedFetch(base, key) {
  const win = {
    location: (() => {
      const href = `${base}/#windowId=1&bg=1&key=${key}`;
      const u = new URL(href);
      return { href, hash: u.hash, search: u.search };
    })(),
    fetch: globalThis.fetch,
  };
  assert.strictEqual(installRemoteAuthFetch(win), true);
  return win.fetch;
}

test('non-localhost /api request without a key is rejected with 401', async (t) => {
  if (!base) return t.skip('no non-internal IPv4');
  const res = await fetch(`${base}/api/projects`);
  assert.strictEqual(res.status, 401);
});

test('the wrapper with a wrong key still gets 401', async (t) => {
  if (!base) return t.skip('no non-internal IPv4');
  const doFetch = wrappedFetch(base, 'wrong-password');
  const res = await doFetch(`${base}/api/projects`);
  assert.strictEqual(res.status, 401);
});

test('the wrapper authenticates /api/projects end-to-end', async (t) => {
  if (!base) return t.skip('no non-internal IPv4');
  const doFetch = wrappedFetch(base, PASSWORD);
  const res = await doFetch(`${base}/api/projects`);
  assert.strictEqual(res.status, 200);
  const projects = await res.json();
  assert.ok(Array.isArray(projects));
  assert.ok(projects.some((p) => (p.name || p) === 'demo-project' || String(p).includes('demo-project')));
});

test('the wrapper authenticates /api/open-tab and a keyed control client receives it', async (t) => {
  if (!base) return t.skip('no non-internal IPv4');
  // Register a control client the way Electron does in remote mode: ?key= on the WS URL.
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}?key=${PASSWORD}`);
  const received = [];
  ws.on('message', (raw) => {
    try { received.push(JSON.parse(raw.toString())); } catch {}
  });
  await new Promise((resolve, reject) => {
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'register-control' })); });
    ws.on('error', reject);
    const check = setInterval(() => {
      if (received.some((m) => m.type === 'control-ready')) { clearInterval(check); resolve(); }
    }, 50);
    setTimeout(() => { clearInterval(check); reject(new Error('control-ready never arrived')); }, 5000);
  });

  const doFetch = wrappedFetch(base, PASSWORD);
  const res = await doFetch(`${base}/api/open-tab`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'integration' }),
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(body.requestId);

  // The open-tab broadcast reaches the authenticated control client.
  const deadline = Date.now() + 5000;
  while (!received.some((m) => m.type === 'open-tab')) {
    if (Date.now() > deadline) throw new Error('open-tab broadcast never arrived');
    await new Promise((r) => setTimeout(r, 50));
  }
  ws.close();
});
