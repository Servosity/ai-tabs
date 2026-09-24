const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { isAllowedOrigin, isAllowedHost, hostGuard, authenticateWs, originGuard, buildAllowlist } = require('../lib/auth');

const PORT = 25283;

// Find a non-internal IPv4 the machine owns, the same way lib/auth.js does.
function firstOwnIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

test('isAllowedOrigin rejects a foreign origin', () => {
  assert.strictEqual(isAllowedOrigin('https://evil.com'), false);
  assert.strictEqual(isAllowedOrigin('http://evil.com:25283'), false);
});

test('isAllowedOrigin allows loopback origins on the server port', () => {
  assert.strictEqual(isAllowedOrigin(`http://localhost:${PORT}`), true);
  assert.strictEqual(isAllowedOrigin(`http://127.0.0.1:${PORT}`), true);
  assert.strictEqual(isAllowedOrigin(`http://[::1]:${PORT}`), true);
});

test('isAllowedOrigin rejects non-string input', () => {
  assert.strictEqual(isAllowedOrigin(undefined), false);
  assert.strictEqual(isAllowedOrigin(null), false);
});

test('isAllowedHost rejects a foreign host', () => {
  assert.strictEqual(isAllowedHost('evil.com'), false);
  assert.strictEqual(isAllowedHost(`evil.com:${PORT}`), false);
});

test('isAllowedHost allows loopback hosts', () => {
  assert.strictEqual(isAllowedHost(`localhost:${PORT}`), true);
  assert.strictEqual(isAllowedHost(`127.0.0.1:${PORT}`), true);
  assert.strictEqual(isAllowedHost('localhost'), true);
  assert.strictEqual(isAllowedHost('[::1]:' + PORT), true);
});

test('isAllowedHost rejects missing/empty host', () => {
  assert.strictEqual(isAllowedHost(undefined), false);
  assert.strictEqual(isAllowedHost(''), false);
});

test('isAllowedHost allows the machine\'s own LAN IP when one exists', () => {
  const ownIp = firstOwnIPv4();
  if (!ownIp) return; // CI box with only loopback — nothing to assert
  assert.strictEqual(isAllowedHost(`${ownIp}:${PORT}`), true);
});

// Minimal Express-style res mock that records what the handler did.
function mockRes() {
  const calls = { statusCode: null, body: null };
  return {
    calls,
    status(code) {
      if (calls.statusCode !== null) throw new Error('res.status() called more than once');
      calls.statusCode = code;
      return { send(body) { calls.body = body; } };
    },
  };
}

test('hostGuard rejects a foreign Host with 403', () => {
  const res = mockRes();
  let nextCalled = false;
  hostGuard({ headers: { host: 'evil.com' } }, res, () => { nextCalled = true; });
  assert.strictEqual(res.calls.statusCode, 403);
  assert.strictEqual(res.calls.body, 'Forbidden: invalid Host header');
  assert.strictEqual(nextCalled, false);
});

test('hostGuard passes a loopback Host through to next()', () => {
  const res = mockRes();
  let nextCalled = false;
  hostGuard({ headers: { host: `localhost:${PORT}` } }, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.calls.statusCode, null);
});

test('hostGuard rejects a missing Host with 403', () => {
  const res = mockRes();
  let nextCalled = false;
  hostGuard({ headers: {} }, res, () => { nextCalled = true; });
  assert.strictEqual(res.calls.statusCode, 403);
  assert.strictEqual(res.calls.body, 'Forbidden: invalid Host header');
  assert.strictEqual(nextCalled, false);
});

// authenticateWs receives the Node http.IncomingMessage for the WS upgrade.
function mockUpgradeReq({ origin, remoteAddress = '127.0.0.1' }) {
  return {
    headers: origin === undefined ? {} : { origin },
    socket: { remoteAddress },
    url: '/',
  };
}

test('authenticateWs rejects a foreign Origin even from localhost', () => {
  assert.strictEqual(
    authenticateWs(mockUpgradeReq({ origin: 'https://evil.com' })),
    false
  );
});

test('authenticateWs allows a localhost connection with no Origin header', () => {
  // Non-browser clients (the Electron ws control client, curl) send no Origin.
  assert.strictEqual(authenticateWs(mockUpgradeReq({ origin: undefined })), true);
});

test('authenticateWs allows a localhost connection with an allowed Origin', () => {
  assert.strictEqual(
    authenticateWs(mockUpgradeReq({ origin: `http://localhost:${PORT}` })),
    true
  );
});

test('authenticateWs with allowed Origin from a non-localhost IP still requires password', () => {
  // The Origin guard passes, but the remote IP must still go through the password path.
  // With no password configured, it should return false.
  const result = authenticateWs(mockUpgradeReq({
    origin: `http://localhost:${PORT}`,
    remoteAddress: '192.168.1.100',
  }));
  assert.strictEqual(result, false);
});

// originGuard is the /api HTTP equivalent of authenticateWs's Origin check: it
// blocks a browser on another site from driving state-changing /api routes via
// the localhost auth exemption. Reuses the same status().send() mockRes.
test('originGuard rejects a state-changing request with a foreign Origin', () => {
  const res = mockRes();
  let nextCalled = false;
  originGuard(
    { method: 'POST', headers: { origin: 'https://evil.com' } },
    res,
    () => { nextCalled = true; }
  );
  assert.strictEqual(res.calls.statusCode, 403);
  assert.strictEqual(res.calls.body, 'Forbidden: invalid Origin');
  assert.strictEqual(nextCalled, false);
});

test('originGuard allows a state-changing request with an allowed Origin', () => {
  const res = mockRes();
  let nextCalled = false;
  originGuard(
    { method: 'POST', headers: { origin: `http://localhost:${PORT}` } },
    res,
    () => { nextCalled = true; }
  );
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.calls.statusCode, null);
});

test('originGuard allows a state-changing request with no Origin header', () => {
  // Non-browser callers (CC hooks, the Electron control client, curl) send no
  // Origin — the same exemption authenticateWs makes.
  const res = mockRes();
  let nextCalled = false;
  originGuard({ method: 'POST', headers: {} }, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.calls.statusCode, null);
});

test('originGuard allows a GET with a foreign Origin (safe method, read-only)', () => {
  const res = mockRes();
  let nextCalled = false;
  originGuard(
    { method: 'GET', headers: { origin: 'https://evil.com' } },
    res,
    () => { nextCalled = true; }
  );
  assert.strictEqual(nextCalled, true);
  assert.strictEqual(res.calls.statusCode, null);
});

test('buildAllowlist folds extra hosts into hosts and origins', () => {
  const { hosts, origins } = buildAllowlist(['tabs.example.com']);
  assert.strictEqual(hosts.has('tabs.example.com'), true);
  assert.strictEqual(origins.has(`http://tabs.example.com:${PORT}`), true);
  assert.strictEqual(hosts.has('localhost'), true);
});

test('buildAllowlist with no extras keeps loopback and adds nothing else', () => {
  const { hosts } = buildAllowlist([]);
  assert.strictEqual(hosts.has('localhost'), true);
  assert.strictEqual(hosts.has('127.0.0.1'), true);
  assert.strictEqual(hosts.has('tabs.example.com'), false);
});

test('setPassword refuses passwords shorter than the minimum', () => {
  const { setPassword, MIN_PASSWORD_LENGTH } = require('../lib/auth');
  assert.strictEqual(MIN_PASSWORD_LENGTH, 12);
  assert.throws(() => setPassword('short-pass'), /at least 12 characters/);
});
