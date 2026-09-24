const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

// Capture the server's WebSocket connection handler without binding a port.
let connectionHandler = null;
class CapturingWebSocketServer {
  on(event, handler) {
    if (event === 'connection') connectionHandler = handler;
    return this;
  }
}

const wsPath = require.resolve('ws');
const realWs = require(wsPath);
require.cache[wsPath].exports = { ...realWs, WebSocketServer: CapturingWebSocketServer };
const server = require('../server');
require.cache[wsPath].exports = realWs;

function fakeSocket() {
  const handlers = {};
  return {
    readyState: 1,
    sent: [],
    on(event, handler) { handlers[event] = handler; },
    send(payload) { this.sent.push(JSON.parse(payload)); },
    close() {},
    receive(message) { handlers.message(JSON.stringify(message)); },
  };
}

function connect() {
  const socket = fakeSocket();
  connectionHandler(socket, { headers: {}, socket: { remoteAddress: '127.0.0.1' }, url: '/' });
  return socket;
}

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
