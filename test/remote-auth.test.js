const { test } = require('node:test');
const assert = require('node:assert');
const { installRemoteAuthFetch, readAuthKey } = require('../public/remote-auth.js');

// Fake window: enough of the browser surface for the wrapper — a location and
// a fetch that records what it was called with.
function fakeWindow(href, log) {
  const u = new URL(href);
  return {
    location: { href, hash: u.hash, search: u.search },
    fetch: (input, init) => { log.push({ input, init }); return Promise.resolve('ok'); },
  };
}

function headerOf(call) {
  if (!call.init || !call.init.headers) return null;
  return new Headers(call.init.headers).get('authorization');
}

test('readAuthKey prefers the hash over the search string', () => {
  assert.strictEqual(readAuthKey({ hash: '#windowId=1&key=fromhash', search: '?key=fromsearch' }), 'fromhash');
  assert.strictEqual(readAuthKey({ hash: '#windowId=1', search: '?key=fromsearch' }), 'fromsearch');
  assert.strictEqual(readAuthKey({ hash: '', search: '' }), null);
});

test('no key: install returns false and fetch is untouched', () => {
  const log = [];
  const win = fakeWindow('http://192.168.1.20:25283/#windowId=3', log);
  const originalFetch = win.fetch;
  assert.strictEqual(installRemoteAuthFetch(win), false);
  assert.strictEqual(win.fetch, originalFetch);
});

test('key in hash: same-origin /api fetch gains a Bearer header', async () => {
  const log = [];
  const win = fakeWindow('http://192.168.1.20:25283/#windowId=1&bg=1&key=sekret', log);
  assert.strictEqual(installRemoteAuthFetch(win), true);
  await win.fetch('/api/projects');
  assert.strictEqual(log.length, 1);
  assert.strictEqual(headerOf(log[0]), 'Bearer sekret');
});

test('key in search also works (mobile-style URLs)', async () => {
  const log = [];
  const win = fakeWindow('http://192.168.1.20:25283/?key=sekret', log);
  assert.strictEqual(installRemoteAuthFetch(win), true);
  await win.fetch('/api/settings');
  assert.strictEqual(headerOf(log[0]), 'Bearer sekret');
});

test('non-/api same-origin path gets no header', async () => {
  const log = [];
  const win = fakeWindow('http://192.168.1.20:25283/#key=sekret', log);
  installRemoteAuthFetch(win);
  await win.fetch('/icon.svg');
  assert.strictEqual(headerOf(log[0]), null);
});

test('path that merely starts with "api" text is not /api', async () => {
  const log = [];
  const win = fakeWindow('http://192.168.1.20:25283/#key=sekret', log);
  installRemoteAuthFetch(win);
  await win.fetch('/apidocs');
  assert.strictEqual(headerOf(log[0]), null);
});

test('bare /api (no trailing slash) is covered', async () => {
  const log = [];
  const win = fakeWindow('http://192.168.1.20:25283/#key=sekret', log);
  installRemoteAuthFetch(win);
  await win.fetch('/api');
  assert.strictEqual(headerOf(log[0]), 'Bearer sekret');
});

test('cross-origin /api URL gets no header', async () => {
  const log = [];
  const win = fakeWindow('http://192.168.1.20:25283/#key=sekret', log);
  installRemoteAuthFetch(win);
  await win.fetch('http://evil.example.com/api/projects');
  assert.strictEqual(headerOf(log[0]), null);
});

test('absolute same-origin /api URL gets the header', async () => {
  const log = [];
  const win = fakeWindow('http://192.168.1.20:25283/#key=sekret', log);
  installRemoteAuthFetch(win);
  await win.fetch('http://192.168.1.20:25283/api/open-tab');
  assert.strictEqual(headerOf(log[0]), 'Bearer sekret');
});

test('an existing Authorization header is never overwritten', async () => {
  const log = [];
  const win = fakeWindow('http://192.168.1.20:25283/#key=sekret', log);
  installRemoteAuthFetch(win);
  await win.fetch('/api/projects', { headers: { Authorization: 'Bearer other' } });
  assert.strictEqual(headerOf(log[0]), 'Bearer other');
});

test('method, body, and other init fields pass through unchanged', async () => {
  const log = [];
  const win = fakeWindow('http://192.168.1.20:25283/#key=sekret', log);
  installRemoteAuthFetch(win);
  const body = JSON.stringify({ cwd: 'x' });
  await win.fetch('/api/open-tab', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.strictEqual(log[0].init.method, 'POST');
  assert.strictEqual(log[0].init.body, body);
  assert.strictEqual(new Headers(log[0].init.headers).get('content-type'), 'application/json');
  assert.strictEqual(headerOf(log[0]), 'Bearer sekret');
});
