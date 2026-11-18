const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { server, connect } = require('./helpers/ws-harness');

test('create in a missing folder answers an error instead of crashing', (t) => {
  const originalSpawn = server.ptyManager.spawn;
  let spawned = false;
  server.ptyManager.spawn = () => { spawned = true; throw new Error('should not spawn'); };
  t.after(() => { server.ptyManager.spawn = originalSpawn; });

  const socket = connect();
  const missing = path.join(os.tmpdir(), `ai-tabs-missing-${process.pid}-${Date.now()}`);
  socket.receive({ type: 'create', cwd: missing, cols: 80, rows: 24 });

  assert.strictEqual(spawned, false);
  assert.strictEqual(socket.sent.length, 1);
  assert.strictEqual(socket.sent[0].type, 'error');
  assert.match(socket.sent[0].message, /Folder not found/);
});

test('a spawn that throws answers an error instead of crashing', (t) => {
  const originalSpawn = server.ptyManager.spawn;
  server.ptyManager.spawn = () => { throw new Error('Cannot create process, error code: 267'); };
  t.after(() => { server.ptyManager.spawn = originalSpawn; });

  const socket = connect();
  socket.receive({ type: 'create', cwd: os.tmpdir(), cols: 80, rows: 24 });

  const errors = socket.sent.filter((m) => m.type === 'error');
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0].message, /error code: 267/);
  assert.strictEqual(socket.sent.some((m) => m.type === 'created'), false);
});

test('a create message cannot carry its own command', async (t) => {
  const originalSpawn = server.ptyManager.spawn;
  const writes = [];
  server.ptyManager.spawn = () => ({
    pid: 4242, write: (d) => writes.push(d), resize() {}, kill() {}, onData() {}, onExit() {},
  });
  t.after(() => {
    server.ptyManager.spawn = originalSpawn;
    server.ptyManager.sessions.clear();
  });

  const socket = connect();
  socket.receive({ type: 'create', cwd: os.tmpdir(), cols: 80, rows: 24, command: 'echo pwned', requestId: 'made-up' });
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.ok(socket.sent.some((m) => m.type === 'created'));
  assert.strictEqual(writes.some((w) => /pwned/.test(w)), false);
});
