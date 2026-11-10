// AI_TABS_HEADLESS=1: /api/open-tab against a real server.js with NO control
// client connected. The server opens the session itself, the request reports
// claimed by 'server', and a viewer that connects later attaches to it.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { startTestServer, stopTestServer } = require('./helpers/spawn-server.js');

let handle = null;

before(async () => {
  const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
  handle = await startTestServer({ env: { AI_TABS_HEADLESS: '1', AI_TABS_SHELL: shell } });
});
after(() => stopTestServer(handle));

const api = (path, init) => fetch(`http://127.0.0.1:${handle.port}${path}`, init);

async function postOpenTab(body) {
  const res = await api('/api/open-tab', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('with nobody connected the server opens the tab and a later viewer attaches', async (t) => {
  if (!handle.base) return t.skip('no non-internal IPv4');
  const cwd = handle.tmpDir.replace(/\\/g, '/');

  const posted = await postOpenTab({ cwd, command: 'echo probe', title: 'probe', background: true });
  assert.strictEqual(posted.status, 200);
  const { requestId } = posted.body;

  const state = await (await api(`/api/requests/${requestId}/status`)).json();
  assert.strictEqual(state.claimed, true);
  assert.strictEqual(state.claimedBy, 'server');
  assert.strictEqual(state.alive, true);
  assert.notStrictEqual(state.sessionId, null);

  const sessions = await (await api('/api/sessions')).json();
  assert.ok(sessions.find((s) => s.id === state.sessionId), 'the session is in the list a UI reads');

  // A UI that turns up afterwards can attach to it.
  const ws = new WebSocket(`ws://127.0.0.1:${handle.port}`);
  const attached = new Promise((resolve, reject) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'attached') resolve(msg);
      if (msg.type === 'error') reject(new Error(msg.message));
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('attached never arrived')), 5000);
  });
  await new Promise((resolve) => ws.on('open', resolve));
  ws.send(JSON.stringify({ type: 'attach', sessionId: state.sessionId }));
  assert.strictEqual((await attached).sessionId, state.sessionId);
  ws.close();

  // With no orphan timer, the API is what ends it (and what frees the folder).
  const killed = await api(`/api/sessions/${state.sessionId}/kill`, { method: 'POST' });
  assert.strictEqual(killed.status, 200);
  const deadline = Date.now() + 5000;
  for (;;) {
    const left = await (await api('/api/sessions')).json();
    if (!left.find((s) => s.id === state.sessionId)) break;
    assert.ok(Date.now() < deadline, 'the killed session never left the list');
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 500)); // Windows: let the shell let go of its cwd
});

test('a folder that does not exist is an error, not a session', async (t) => {
  if (!handle.base) return t.skip('no non-internal IPv4');
  const before = (await (await api('/api/sessions')).json()).length;
  const posted = await postOpenTab({ cwd: `${handle.tmpDir.replace(/\\/g, '/')}/not-here`, command: 'echo probe' });
  assert.strictEqual(posted.status, 500);
  assert.match(posted.body.error, /Folder not found/);
  assert.strictEqual((await (await api('/api/sessions')).json()).length, before);
});
