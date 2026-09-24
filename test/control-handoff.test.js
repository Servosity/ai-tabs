// Controller-slot handoff: remote clients preempt the local GUI, claim-control
// ping-pongs control, and a claiming registrant takes over from any holder.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { startTestServer, stopTestServer, PASSWORD } = require('./helpers/spawn-server.js');

let handle = null;

before(async () => {
  handle = await startTestServer({ env: { AI_TABS_FAILOVER_GRACE_MS: '200' } });
});
after(() => stopTestServer(handle));

// Open a control WS and collect every message. kind: 'local' | 'remote'.
function controlClient(kind, opts = {}) {
  const url = kind === 'local'
    ? `ws://127.0.0.1:${handle.port}`
    : `ws://${handle.ownIp}:${handle.port}?key=${PASSWORD}`;
  const ws = new WebSocket(url);
  const messages = [];
  ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch {} });
  const registered = new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'register-control', ...opts })));
    ws.on('error', reject);
    const check = setInterval(() => {
      const m = messages.find((x) => x.type === 'control-ready');
      if (m) { clearInterval(check); resolve(m); }
    }, 25);
    setTimeout(() => { clearInterval(check); reject(new Error('control-ready never arrived')); }, 5000);
  });
  const waitFor = (type, timeoutMs = 3000) => new Promise((resolve, reject) => {
    const check = setInterval(() => {
      const m = messages.find((x) => x.type === type);
      if (m) { clearInterval(check); resolve(m); }
    }, 25);
    setTimeout(() => { clearInterval(check); reject(new Error(`${type} never arrived`)); }, timeoutMs);
  });
  return { ws, messages, registered, waitFor, send: (m) => ws.send(JSON.stringify(m)) };
}

test('remote register preempts a local controller', async (t) => {
  if (!handle.base) return t.skip('no non-internal IPv4');
  await new Promise((r) => setTimeout(r, 400));
  const local = controlClient('local');
  const ready = await local.registered;
  assert.strictEqual(ready.isPrimary, true);
  assert.strictEqual(ready.controller, null);

  const remote = controlClient('remote');
  const remoteReady = await remote.registered;
  assert.strictEqual(remoteReady.isPrimary, false);
  assert.deepStrictEqual(remoteReady.controller, { by: 'local' });

  const granted = await remote.waitFor('control-granted');
  assert.ok(Array.isArray(granted.sessions));
  const revoked = await local.waitFor('control-revoked');
  assert.ok(revoked.by && revoked.by !== 'local'); // remote's IP
  local.ws.close(); remote.ws.close();
});

test('claim-control ping-pongs control between clients', async (t) => {
  if (!handle.base) return t.skip('no non-internal IPv4');
  await new Promise((r) => setTimeout(r, 400));
  const local = controlClient('local');
  await local.registered;
  const remote = controlClient('remote');
  await remote.registered;
  await remote.waitFor('control-granted');
  await local.waitFor('control-revoked');

  local.send({ type: 'claim-control' });
  await local.waitFor('control-granted');
  await remote.waitFor('control-revoked');

  remote.send({ type: 'claim-control' });
  // second grant to remote — count grants, not just find-first
  const deadline = Date.now() + 3000;
  while (remote.messages.filter((m) => m.type === 'control-granted').length < 2) {
    if (Date.now() > deadline) throw new Error('second control-granted never arrived');
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.strictEqual(local.messages.filter((m) => m.type === 'control-revoked').length, 2);
  local.ws.close(); remote.ws.close();
});

test('a claiming second local client takes control from the first', async (t) => {
  if (!handle.base) return t.skip('no non-internal IPv4');
  await new Promise((r) => setTimeout(r, 400));
  const first = controlClient('local');
  const firstReady = await first.registered;
  assert.strictEqual(firstReady.isPrimary, true);

  const second = controlClient('local', { claim: true });
  const secondReady = await second.registered;
  assert.strictEqual(secondReady.isPrimary, false); // control-ready races the grant
  await second.waitFor('control-granted');
  const revoked = await first.waitFor('control-revoked');
  assert.strictEqual(revoked.by, 'local');
  first.ws.close(); second.ws.close();
});

test('a non-claiming second local client still just observes', async (t) => {
  if (!handle.base) return t.skip('no non-internal IPv4');
  await new Promise((r) => setTimeout(r, 400));
  const first = controlClient('local');
  const firstReady = await first.registered;
  assert.strictEqual(firstReady.isPrimary, true);

  const second = controlClient('local');           // no claim flag
  const secondReady = await second.registered;
  assert.strictEqual(secondReady.isPrimary, false);
  assert.deepStrictEqual(secondReady.controller, { by: 'local' });
  await assert.rejects(second.waitFor('control-granted', 500));
  first.ws.close(); second.ws.close();
});

test('controller disconnect fails over to the local client after the grace period', async (t) => {
  if (!handle.base) return t.skip('no non-internal IPv4');
  await new Promise((r) => setTimeout(r, 400));
  const local = controlClient('local');
  await local.registered;
  const remote = controlClient('remote');
  await remote.registered;
  await remote.waitFor('control-granted');
  await local.waitFor('control-revoked');

  remote.ws.close();
  // grace is 200ms in this harness — failover should land well within 3s
  const granted = await local.waitFor('control-granted');
  assert.ok(Array.isArray(granted.sessions));
  local.ws.close();
});

test('reconnecting within the grace period cancels failover', async (t) => {
  if (!handle.base) return t.skip('no non-internal IPv4');
  await new Promise((r) => setTimeout(r, 400));
  const local = controlClient('local');
  await local.registered;
  const remote = controlClient('remote');
  await remote.registered;
  await remote.waitFor('control-granted');
  await local.waitFor('control-revoked');

  remote.ws.close();
  // reconnect immediately (well inside 200ms grace)
  const remote2 = controlClient('remote');
  await remote2.registered;
  await remote2.waitFor('control-granted');
  // local must NOT be promoted afterwards
  await new Promise((r) => setTimeout(r, 600));
  assert.strictEqual(local.messages.filter((m) => m.type === 'control-granted').length, 0);
  local.ws.close(); remote2.ws.close();
});

test('remote client to a genuinely idle slot gets control-ready primary and no redundant grant', async (t) => {
  if (!handle.base) return t.skip('no non-internal IPv4');
  await new Promise((r) => setTimeout(r, 400));
  const remote = controlClient('remote');
  const ready = await remote.registered;
  assert.strictEqual(ready.isPrimary, true);
  assert.strictEqual(ready.controller, null);
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(remote.messages.filter((m) => m.type === 'control-granted').length, 0);
  remote.ws.close();
});

test('release-control with a peer connected transfers control, no shutdown', async (t) => {
  if (!handle.base) return t.skip('no non-internal IPv4');
  await new Promise((r) => setTimeout(r, 400));
  const local = controlClient('local');
  await local.registered;
  const remote = controlClient('remote');
  await remote.registered;
  await remote.waitFor('control-granted');
  await local.waitFor('control-revoked');

  // local (locked) quits: ack false, nothing else changes
  local.send({ type: 'release-control' });
  const ack1 = await local.waitFor('release-ack');
  assert.strictEqual(ack1.shutdown, false);
  local.ws.close();

  // remote (controller) quits with nobody else: ack false — remote quits never shut down
  remote.send({ type: 'release-control' });
  const ack2 = await remote.waitFor('release-ack');
  assert.strictEqual(ack2.shutdown, false);
  remote.ws.close();

  // server must still be alive
  const res = await fetch(`http://127.0.0.1:${handle.port}/api/health`);
  assert.ok(res.ok);
});

test('sole local controller releasing gets shutdown:true and the server exits', async (t) => {
  if (!handle.base) return t.skip('no non-internal IPv4');
  // dedicated server — this one dies
  const own = await startTestServer({ env: { AI_TABS_FAILOVER_GRACE_MS: '200' } });
  if (!own.base) return t.skip('no non-internal IPv4');
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${own.port}`);
    const messages = [];
    ws.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString())); } catch {} });
    await new Promise((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'register-control' })));
      ws.on('error', reject);
      const check = setInterval(() => { if (messages.some((m) => m.type === 'control-ready')) { clearInterval(check); resolve(); } }, 25);
      setTimeout(() => { clearInterval(check); reject(new Error('control-ready never arrived')); }, 5000);
    });
    ws.send(JSON.stringify({ type: 'release-control' }));
    const deadline = Date.now() + 3000;
    while (!messages.some((m) => m.type === 'release-ack' && m.shutdown === true)) {
      if (Date.now() > deadline) throw new Error('release-ack shutdown:true never arrived');
      await new Promise((r) => setTimeout(r, 25));
    }
    // the child process should exit on its own
    const exited = await Promise.race([
      new Promise((resolve) => own.child.once('exit', () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    assert.strictEqual(exited, true);
  } finally {
    stopTestServer(own);
  }
});

test('local registering while a remote holds control becomes a locked spectator', async (t) => {
  if (!handle.base) return t.skip('no non-internal IPv4');
  await new Promise((r) => setTimeout(r, 700));
  const remote = controlClient('remote');
  const remoteReady = await remote.registered;
  assert.strictEqual(remoteReady.isPrimary, true);

  const local = controlClient('local');
  const localReady = await local.registered;
  assert.strictEqual(localReady.isPrimary, false);
  // by must be the remote's address, NOT 'local' — 'local' is the quit-dialog signal
  assert.ok(localReady.controller && localReady.controller.by && localReady.controller.by !== 'local');
  // and the local spectator is not granted control
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(local.messages.filter((m) => m.type === 'control-granted').length, 0);
  local.ws.close(); remote.ws.close();
});

