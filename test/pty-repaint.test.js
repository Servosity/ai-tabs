const { test } = require('node:test');
const assert = require('node:assert/strict');

const { PtyManager, trackAltScreen } = require('../lib/pty-manager');

// Reattaching to a session that a full-screen agent owns used to replay the ring
// buffer with the escape sequences stripped. On the alternate screen that buffer
// is cursor-addressed redraw fragments, so stripping the addressing linearises it
// into garbage on top of whatever the app paints next — the "looks crazy" screen.
// The fix needs two things to hold: know which screen the session is on, and be
// able to make the app repaint.

test('alt-screen state follows the last toggle in a chunk', () => {
  assert.strictEqual(trackAltScreen(false, 'plain output'), false);
  assert.strictEqual(trackAltScreen(false, '\x1b[?1049h'), true);
  assert.strictEqual(trackAltScreen(true, '\x1b[?1049l'), false);

  // Legacy spellings — older TUIs still emit these.
  assert.strictEqual(trackAltScreen(false, '\x1b[?47h'), true);
  assert.strictEqual(trackAltScreen(false, '\x1b[?1047h'), true);

  // Enter and leave in one chunk: the last one is where the session ended up.
  assert.strictEqual(trackAltScreen(false, '\x1b[?1049hdraw\x1b[?1049l'), false);
  assert.strictEqual(trackAltScreen(true, '\x1b[?1049lbye\x1b[?1049h'), true);
});

test('a chunk with no toggle leaves the state alone', () => {
  assert.strictEqual(trackAltScreen(true, 'still painting'), true);
  assert.strictEqual(trackAltScreen(false, 'still scrolling'), false);
});

// The carry exists because node-pty hands over whatever the OS gives it, and an
// 8-byte escape sequence lands across a chunk boundary often enough to matter.
// Without it a session silently sticks on the wrong screen.
test('a toggle split across chunks is still detected', () => {
  const CARRY = 7;
  const chunks = ['output\x1b[?10', '49hnow painting'];

  let state = false;
  let carry = '';
  for (const chunk of chunks) {
    const scan = carry + chunk;
    state = trackAltScreen(state, scan);
    carry = scan.slice(-CARRY);
  }
  assert.strictEqual(state, true, 'split alt-screen enter was missed');
});

test('re-scanning the carried tail does not flip the state back', () => {
  // The carry deliberately re-presents bytes that were already scanned. Since
  // resolution is "last toggle wins", that has to be idempotent.
  const CARRY = 7;
  let state = false;
  let carry = '';
  for (const chunk of ['\x1b[?1049h', 'a', 'b', 'c']) {
    const scan = carry + chunk;
    state = trackAltScreen(state, scan);
    carry = scan.slice(-CARRY);
  }
  assert.strictEqual(state, true);
});

// A fake node-pty that records resize calls, so the nudge can be asserted
// without spawning a real shell.
function fakeSpawn(recorder) {
  return () => ({
    pid: 4242,
    onData() {},
    onExit() {},
    write() {},
    kill() {},
    resize(cols, rows) { recorder.push({ cols, rows }); },
  });
}

test('forceRepaint shrinks then restores, so the app sees SIGWINCH', async () => {
  const resizes = [];
  const mgr = new PtyManager({ spawn: fakeSpawn(resizes) });
  const { id } = mgr.create('/tmp', () => {}, () => {}, () => {}, 120, 30);

  assert.strictEqual(mgr.forceRepaint(id), true);
  assert.deepStrictEqual(resizes, [{ cols: 119, rows: 30 }]);

  await new Promise((r) => setTimeout(r, 120));
  assert.deepStrictEqual(resizes[1], { cols: 120, rows: 30 }, 'never restored the real width');

  // The session's authoritative size must be untouched by the nudge, or the
  // next real resize compares against a width the client never asked for and
  // the no-op guard in resize() swallows it.
  assert.strictEqual(mgr.sessions.get(id).cols, 120);
});

test('a client resize during the nudge is what gets restored', async () => {
  const resizes = [];
  const mgr = new PtyManager({ spawn: fakeSpawn(resizes) });
  const { id } = mgr.create('/tmp', () => {}, () => {}, () => {}, 120, 30);

  mgr.forceRepaint(id);
  mgr.resize(id, 80, 24); // client attached at a different size mid-nudge

  await new Promise((r) => setTimeout(r, 120));
  assert.deepStrictEqual(resizes[resizes.length - 1], { cols: 80, rows: 24 });
});

test('forceRepaint is a no-op for an unknown session', () => {
  const mgr = new PtyManager({ spawn: fakeSpawn([]) });
  assert.strictEqual(mgr.forceRepaint(999), false);
});

test('a session that died mid-nudge does not throw on restore', async () => {
  const resizes = [];
  const mgr = new PtyManager({ spawn: fakeSpawn(resizes) });
  const { id } = mgr.create('/tmp', () => {}, () => {}, () => {}, 120, 30);

  mgr.forceRepaint(id);
  mgr.kill(id);

  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(resizes.length, 1, 'restored a resize onto a dead session');
});

test('isAltScreen reports false for a session that never switched', () => {
  const mgr = new PtyManager({ spawn: fakeSpawn([]) });
  const { id } = mgr.create('/tmp', () => {}, () => {}, () => {}, 120, 30);
  assert.strictEqual(mgr.isAltScreen(id), false);
  assert.strictEqual(mgr.isAltScreen(999), false);
});
