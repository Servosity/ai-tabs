// /api/open-tab end to end against a real server.js: a remote (keyed) control
// client stands in for an Electron window on another machine. The request
// comes from the server's own host with a stale windowId, the remote client is
// assigned it anyway, rebases the URL onto its server, acks, and the tab's
// session is created on the server. A request nobody acks reports claimed:false.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { startTestServer, stopTestServer, PASSWORD } = require('./helpers/spawn-server.js');
const { rebaseOpenTabUrl } = require('../lib/open-tab-routing');

const CLAIM_GRACE_MS = 400;
let handle = null;

before(async () => {
  // A plain OS shell, so `echo probe` doesn't depend on the caller's $SHELL.
  const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
  handle = await startTestServer({
    env: { AI_TABS_OPEN_TAB_CLAIM_GRACE_MS: String(CLAIM_GRACE_MS), AI_TABS_SHELL: shell },
  });
});
after(() => stopTestServer(handle));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openWs(url) {
  const ws = new WebSocket(url);
  const messages = [];
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch {} });
  const waitFor = (pred, what, timeoutMs = 5000) => new Promise((resolve, reject) => {
    const check = setInterval(() => {
      const m = messages.find(pred);
      if (m) { clearInterval(check); clearTimeout(timer); resolve(m); }
    }, 25);
    const timer = setTimeout(() => { clearInterval(check); reject(new Error(`${what} never arrived`)); }, timeoutMs);
  });
  const opened = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  return { ws, messages, waitFor, opened, send: (m) => ws.send(JSON.stringify(m)) };
}

async function remoteControlClient(windowIds, { local = false } = {}) {
  const c = openWs(local
    ? `ws://127.0.0.1:${handle.port}`
    : `ws://${handle.ownIp}:${handle.port}?key=${PASSWORD}`);
  await c.opened;
  c.send({ type: 'register-control', claim: true });
  await c.waitFor((m) => m.type === 'control-ready', 'control-ready');
  c.send({ type: 'control-windows', windowIds });
  await sleep(100);
  return c;
}

async function postOpenTab(body) {
  const res = await fetch(`http://127.0.0.1:${handle.port}/api/open-tab`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function status(requestId) {
  const res = await fetch(`http://127.0.0.1:${handle.port}/api/requests/${requestId}/status`);
  return res.json();
}

test('a stale windowId still reaches the remote client, which opens the tab on the server', async (t) => {
  if (!handle.base) return t.skip('no non-internal IPv4');
  const control = await remoteControlClient([1]);
  const cwd = handle.tmpDir.replace(/\\/g, '/');

  const posted = await postOpenTab({ cwd, command: 'echo probe', title: 'probe', background: true, windowId: '7' });
  assert.strictEqual(posted.status, 200);
  const { requestId } = posted.body;

  const msg = await control.waitFor((m) => m.type === 'open-tab' && m.requestId === requestId, 'open-tab');
  assert.strictEqual(msg.assigned, true);
  assert.strictEqual(msg.windowId, null); // window 7 is gone: first window

  const before = await status(requestId);
  assert.strictEqual(before.sessionId, null);
  assert.strictEqual(before.alive, true);
  assert.strictEqual(before.claimed, null); // still inside the grace period

  // The client rebuilds the URL onto ITS server, not the server's localhost.
  const tabUrl = new URL(rebaseOpenTabUrl(msg.url, handle.base));
  assert.strictEqual(tabUrl.origin, handle.base);
  // The command never rides in the URL; the server keeps it by requestId.
  assert.strictEqual(tabUrl.searchParams.get('command'), null);
  control.send({ type: 'open-tab-ack', requestId, windowId: 1 });
  await sleep(100);
  const acked = await status(requestId);
  assert.strictEqual(acked.claimed, true);
  assert.strictEqual(acked.claimedBy, handle.ownIp);

  // The tab page creates the session with the URL's params, over the keyed WS.
  const term = openWs(`ws://${handle.ownIp}:${handle.port}?key=${PASSWORD}`);
  await term.opened;
  term.send({
    type: 'create', cols: 80, rows: 24,
    cwd: tabUrl.searchParams.get('cwd'),
    requestId: tabUrl.searchParams.get('requestId'),
  });
  const created = await term.waitFor((m) => m.type === 'created', 'created');

  const bound = await status(requestId);
  assert.strictEqual(bound.sessionId, created.sessionId);
  assert.strictEqual(bound.alive, true);
  assert.strictEqual(bound.claimed, true);

  const sessions = await (await fetch(`http://127.0.0.1:${handle.port}/api/sessions`)).json();
  const session = sessions.find((s) => s.id === created.sessionId);
  assert.ok(session, 'session is listed on the server');
  assert.strictEqual(session.cwd.replace(/\\/g, '/'), cwd);

  const deadline = Date.now() + 10000;
  for (;;) {
    const out = await (await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${created.sessionId}/output`)).json();
    if (/probe/.test(out.output || '')) break;
    if (Date.now() > deadline) throw new Error(`echo probe never ran; output=${JSON.stringify(out.output)}`);
    await sleep(200);
  }

  await fetch(`http://127.0.0.1:${handle.port}/api/sessions/${created.sessionId}/kill`, { method: 'POST' }).catch(() => {});
  term.ws.close();
  control.ws.close();
  await sleep(100);
});

test('an addressed window that exists goes to its owner with the window id', async (t) => {
  if (!handle.base) return t.skip('no non-internal IPv4');
  const control = await remoteControlClient([3, 4]);
  const { body } = await postOpenTab({ title: 'owned', windowId: 4 });
  const msg = await control.waitFor((m) => m.type === 'open-tab' && m.requestId === body.requestId, 'open-tab');
  assert.strictEqual(msg.windowId, '4');
  assert.strictEqual(msg.assigned, true);
  control.ws.close();
  await sleep(100);
});

test('local mode: the local controller gets unaddressed requests and acks as local', async (t) => {
  if (!handle.base) return t.skip('no non-internal IPv4');
  const control = await remoteControlClient([1], { local: true });
  const { body } = await postOpenTab({ title: 'local', command: 'echo hi' });
  const msg = await control.waitFor((m) => m.type === 'open-tab' && m.requestId === body.requestId, 'open-tab');
  assert.strictEqual(msg.assigned, true);
  assert.strictEqual(new URL(rebaseOpenTabUrl(msg.url, 'http://localhost:25283')).origin, 'http://localhost:25283');
  control.send({ type: 'open-tab-ack', requestId: body.requestId, windowId: 1 });
  await sleep(100);
  const s = await status(body.requestId);
  assert.strictEqual(s.claimed, true);
  assert.strictEqual(s.claimedBy, 'local');
  control.ws.close();
  await sleep(100);
});

test('a request nobody acks reports claimed:false after the grace period', async (t) => {
  if (!handle.base) return t.skip('no non-internal IPv4');
  const control = await remoteControlClient([1]); // receives it but never acks
  const { body } = await postOpenTab({ title: 'ignored' });
  await control.waitFor((m) => m.type === 'open-tab' && m.requestId === body.requestId, 'open-tab');
  await sleep(CLAIM_GRACE_MS + 150);
  const s = await status(body.requestId);
  assert.strictEqual(s.claimed, false);
  assert.strictEqual(s.claimedBy, null);
  assert.strictEqual(s.sessionId, null);
  assert.strictEqual(s.alive, true); // existing field keeps its meaning
  control.ws.close();
  await sleep(100);
});

test('no control client connected is a 503, as before', async (t) => {
  if (!handle.base) return t.skip('no non-internal IPv4');
  await sleep(300);
  const { status: code } = await postOpenTab({ title: 'nobody' });
  assert.strictEqual(code, 503);
});
