const { test } = require('node:test');
const assert = require('node:assert');
const { launchGuard, isForeignLaunch } = require('../lib/launch-guard');

function req({ url = '/', method = 'GET', headers = {} } = {}) {
  const [path] = url.split('?');
  return { method, path, originalUrl: url, headers: { host: 'localhost:25283', ...headers } };
}

const LAUNCH = '/?cwd=C%3A%5C&agent=claude&agentBypass=1';

test('a cross-site navigation carrying launch params is foreign', () => {
  assert.strictEqual(isForeignLaunch(req({ url: LAUNCH, headers: { 'sec-fetch-site': 'cross-site' } })), true);
  assert.strictEqual(isForeignLaunch(req({ url: LAUNCH, headers: { 'sec-fetch-site': 'same-site' } })), true);
});

test('Electron loadURL, typed URLs and in-app links are allowed', () => {
  assert.strictEqual(isForeignLaunch(req({ url: LAUNCH, headers: { 'sec-fetch-site': 'none' } })), false);
  assert.strictEqual(isForeignLaunch(req({ url: LAUNCH, headers: { 'sec-fetch-site': 'same-origin' } })), false);
  assert.strictEqual(isForeignLaunch(req({ url: LAUNCH })), false);
});

test('without Sec-Fetch-Site, a foreign Referer is refused and our own is not', () => {
  assert.strictEqual(isForeignLaunch(req({ url: LAUNCH, headers: { referer: 'https://evil.example/x' } })), true);
  assert.strictEqual(isForeignLaunch(req({ url: LAUNCH, headers: { referer: 'http://localhost:25283/' } })), false);
});

test('the bare landing page and other paths are never refused', () => {
  const headers = { 'sec-fetch-site': 'cross-site' };
  assert.strictEqual(isForeignLaunch(req({ url: '/', headers })), false);
  assert.strictEqual(isForeignLaunch(req({ url: '/?', headers })), false);
  assert.strictEqual(isForeignLaunch(req({ url: '/xterm/css/xterm.css?v=1', headers })), false);
});

test('launchGuard refuses framing and answers 403 to a foreign launch', () => {
  const headers = {};
  let status = null;
  let nextCalled = false;
  const res = {
    setHeader: (k, v) => { headers[k] = v; },
    status(code) { status = code; return this; },
    type() { return this; },
    send() { return this; },
  };
  launchGuard(req({ url: LAUNCH, headers: { 'sec-fetch-site': 'cross-site' } }), res, () => { nextCalled = true; });
  assert.strictEqual(status, 403);
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(headers['X-Frame-Options'], 'DENY');
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
});
