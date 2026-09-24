// /api/open-tab routing: URL rebasing onto the client's server, fallback
// addressing when the addressed window is gone, and claim status.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  rebaseOpenTabUrl, pickOpenTabTarget, resolveOpenTabWindow, openTabClaimStatus,
} = require('../lib/open-tab-routing');

const SERVER_URL = 'http://localhost:25283/?cwd=C%3A%2Fsrc%2Ffrontline&command=echo+probe&requestId=r1&agent=codex';

// ── URL rebasing ──

test('a remote client rebases the tab URL onto its remote server, keeping every param', () => {
  const url = rebaseOpenTabUrl(SERVER_URL, 'http://10.0.0.5:25283');
  const parsed = new URL(url);
  assert.strictEqual(parsed.origin, 'http://10.0.0.5:25283');
  assert.strictEqual(parsed.searchParams.get('cwd'), 'C:/src/frontline');
  assert.strictEqual(parsed.searchParams.get('command'), 'echo probe');
  assert.strictEqual(parsed.searchParams.get('requestId'), 'r1');
  assert.strictEqual(parsed.searchParams.get('agent'), 'codex');
});

test('a local client keeps the localhost base', () => {
  const url = rebaseOpenTabUrl(SERVER_URL, 'http://localhost:25283');
  assert.ok(url.startsWith('http://localhost:25283/?cwd='));
});

test('the message origin is never trusted', () => {
  const url = rebaseOpenTabUrl('http://evil.example:9999/?cwd=x', 'http://192.168.1.5:25283/');
  assert.strictEqual(url, 'http://192.168.1.5:25283/?cwd=x');
});

test('a key param in the message is dropped — the client adds its own', () => {
  const url = rebaseOpenTabUrl('http://localhost:25283/?cwd=x&key=planted', 'http://10.0.0.2:25283');
  assert.strictEqual(new URL(url).searchParams.has('key'), false);
});

test('a URL with no query rebases to the bare base', () => {
  assert.strictEqual(rebaseOpenTabUrl('http://localhost:25283/', 'http://10.0.0.2:25283'), 'http://10.0.0.2:25283/');
  assert.strictEqual(rebaseOpenTabUrl(undefined, 'http://10.0.0.2:25283'), 'http://10.0.0.2:25283/');
});

// ── Server-side target choice ──

function client(windowIds, readyState = 1) {
  return { readyState, _windowIds: windowIds };
}

test('the client that owns the addressed window gets it, with the window id', () => {
  const a = client(['1']);
  const b = client(['2']);
  const target = pickOpenTabTarget({ clients: [a, b], controller: a, windowId: '2' });
  assert.strictEqual(target.client, b);
  assert.strictEqual(target.windowId, '2');
});

test('a window-id collision between processes goes to the controller', () => {
  const a = client(['1']);
  const b = client(['1']);
  const target = pickOpenTabTarget({ clients: [a, b], controller: b, windowId: 1 });
  assert.strictEqual(target.client, b);
});

test('a stale window id falls back to the controller, unaddressed', () => {
  const a = client(['1']);
  const b = client(['3']);
  const target = pickOpenTabTarget({ clients: [a, b], controller: b, windowId: '7' });
  assert.strictEqual(target.client, b);
  assert.strictEqual(target.windowId, null);
});

test('no window id goes to the controller', () => {
  const a = client(['1']);
  const target = pickOpenTabTarget({ clients: [a], controller: a, windowId: null });
  assert.strictEqual(target.client, a);
});

test('no controller but exactly one control client: that one opens it', () => {
  const remote = client(['1']);
  const target = pickOpenTabTarget({ clients: [remote], controller: null, windowId: '9' });
  assert.strictEqual(target.client, remote);
  assert.strictEqual(target.windowId, null);
});

test('a client that never reported windows can still be the sole fallback', () => {
  const legacy = client(undefined);
  assert.strictEqual(pickOpenTabTarget({ clients: [legacy], controller: null, windowId: null }).client, legacy);
});

test('several clients and no controller: nobody is picked', () => {
  const target = pickOpenTabTarget({ clients: [client(['1']), client(['2'])], controller: null, windowId: '5' });
  assert.strictEqual(target, null);
});

test('closed sockets are never picked', () => {
  const dead = client(['1'], 3);
  const live = client(['2']);
  const target = pickOpenTabTarget({ clients: [dead, live], controller: dead, windowId: '1' });
  assert.strictEqual(target.client, live);
  assert.strictEqual(target.windowId, null);
  assert.strictEqual(pickOpenTabTarget({ clients: [dead], controller: dead, windowId: null }), null);
});

// ── Client-side window choice ──

const W1 = { id: 1 };
const W2 = { id: 2 };
const windows = new Map([[1, W1], [2, W2]]);

test('an addressed window this instance owns is used, assigned or not', () => {
  assert.strictEqual(resolveOpenTabWindow(windows, { windowId: '2' }, false), W2);
  assert.strictEqual(resolveOpenTabWindow(windows, { windowId: '2', assigned: true }, false), W2);
});

test('an assigned message for a missing window lands in the first window', () => {
  assert.strictEqual(resolveOpenTabWindow(windows, { windowId: '9', assigned: true }, false), W1);
});

test('an assigned unaddressed message opens even on a non-controller', () => {
  assert.strictEqual(resolveOpenTabWindow(windows, { windowId: null, assigned: true }, false), W1);
});

test('legacy unassigned messages keep the old rules', () => {
  assert.strictEqual(resolveOpenTabWindow(windows, { windowId: '9' }, true), null);
  assert.strictEqual(resolveOpenTabWindow(windows, {}, false), null);
  assert.strictEqual(resolveOpenTabWindow(windows, {}, true), W1);
});

test('no windows at all resolves to null', () => {
  assert.strictEqual(resolveOpenTabWindow(new Map(), { assigned: true }, true), null);
});

// ── Claim status ──

test('an acked request is claimed by the acking client', () => {
  const s = openTabClaimStatus({ createdAt: 0, sessionId: null, claimedBy: '10.0.0.4' }, 100, 5000);
  assert.deepStrictEqual(s, { claimed: true, claimedBy: '10.0.0.4' });
});

test('a bound session counts as claimed even without an ack', () => {
  assert.strictEqual(openTabClaimStatus({ createdAt: 0, sessionId: 4, claimedBy: null }, 100, 5000).claimed, true);
});

test('unacked inside the grace period is pending; past it, unclaimed', () => {
  const entry = { createdAt: 1000, sessionId: null, claimedBy: null };
  assert.strictEqual(openTabClaimStatus(entry, 2000, 5000).claimed, null);
  assert.deepStrictEqual(openTabClaimStatus(entry, 6000, 5000), { claimed: false, claimedBy: null });
});
