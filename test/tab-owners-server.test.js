// Per-tab ownership as the server enforces it over the session WebSocket.
// The rules themselves are in tab-owners.test.js; this checks the wiring.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { server, connect } = require('./helpers/ws-harness');

const JEFF = { id: 'c-jeff', name: 'Jeff' };
const AL = { id: 'c-al', name: 'Alaister' };

function fakePty(t) {
  const originalSpawn = server.ptyManager.spawn;
  const pty = { writes: [], resizes: [] };
  server.ptyManager.spawn = () => ({
    pid: 4242,
    write: (d) => pty.writes.push(d),
    resize: (c, r) => pty.resizes.push([c, r]),
    kill() {}, onData() {}, onExit() {},
  });
  t.after(() => {
    server.ptyManager.spawn = originalSpawn;
    server.ptyManager.sessions.clear();
  });
  return pty;
}

function share(t) {
  const pty = fakePty(t);
  const control = connect();
  control.receive({ type: 'register-control' });
  const jeff = connect();
  jeff.receive({ type: 'create', cwd: os.tmpdir(), cols: 80, rows: 24, client: JEFF, instance: 'inst-1' });
  const sessionId = jeff.sent.find((m) => m.type === 'created').sessionId;
  const al = connect();
  al.receive({ type: 'attach', sessionId, client: AL });
  t.after(() => { jeff.close(); al.close(); }); // control stays open: closing it starts the 5 s failover timer
  return { pty, control, jeff, al, sessionId };
}

const owners = (socket) => socket.sent.filter((m) => m.type === 'owner').map((m) => m.owner && m.owner.name);

test('only the driver types and resizes; a watcher is told who drives', (t) => {
  const { pty, jeff, al } = share(t);
  assert.deepStrictEqual(owners(al), ['Jeff']);

  al.receive({ type: 'data', data: 'rm -rf' });
  al.receive({ type: 'resize', cols: 200, rows: 60 });
  jeff.receive({ type: 'data', data: 'ls\r' });
  jeff.receive({ type: 'resize', cols: 100, rows: 30 });

  assert.deepStrictEqual(pty.writes, ['ls\r']);
  assert.deepStrictEqual(pty.resizes, [[100, 30]]);
  assert.strictEqual(al.sent.find((m) => m.type === 'owner' && m.blocked).owner.name, 'Jeff');
  assert.deepStrictEqual(al.sent.filter((m) => m.type === 'size').map((m) => [m.cols, m.rows]), [[100, 30]]);
});

test('claim-tab hands the tab over and both sides hear it', (t) => {
  const { pty, jeff, al } = share(t);
  al.receive({ type: 'claim-tab' });
  assert.strictEqual(owners(jeff).at(-1), 'Alaister');
  assert.strictEqual(owners(al).at(-1), 'Alaister');

  jeff.receive({ type: 'data', data: 'x' });
  al.receive({ type: 'data', data: 'y' });
  assert.deepStrictEqual(pty.writes, ['y']);
});

test("closing someone else's tab detaches instead of killing it", (t) => {
  const { al, jeff, sessionId } = share(t);
  al.receive({ type: 'kill' });
  assert.ok(server.ptyManager.sessions.has(sessionId));
  jeff.receive({ type: 'kill' });
  assert.ok(!server.ptyManager.sessions.has(sessionId));
});

test('control clients hear each new session with the instance that opened it', (t) => {
  const { control, sessionId } = share(t);
  const changed = control.sent.filter((m) => m.type === 'sessions-changed').at(-1);
  assert.deepStrictEqual(changed.sessions.find((s) => s.id === sessionId).instance, 'inst-1');
});
