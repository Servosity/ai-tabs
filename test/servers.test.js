const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  LOCAL_ID, loadServers, saveServers, generateId, parseServerArg,
  resolveLaunchTarget, addServer, removeServer, normalizeUrl, seedServersFile,
} = require('../lib/servers');
const { validateServer } = require('../lib/servers');

// Each test gets a throwaway dir; t.after cleans it up.
function tmpFile(t, name = 'servers.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tabs-servers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

test('loadServers on a missing file returns a store with only the local entry', (t) => {
  const file = tmpFile(t);
  const data = loadServers(file);
  assert.strictEqual(data.version, 1);
  assert.strictEqual(data.servers.length, 1);
  assert.strictEqual(data.servers[0].id, LOCAL_ID);
  assert.strictEqual(data.servers[0].url, null);
});

test('loadServers on corrupt JSON recovers instead of throwing', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, '{ this is not json');
  const data = loadServers(file);
  assert.strictEqual(data.servers.length, 1);
  assert.strictEqual(data.servers[0].id, LOCAL_ID);
});

test('loadServers re-adds the local entry if a hand-edited file dropped it', (t) => {
  const file = tmpFile(t);
  fs.writeFileSync(file, JSON.stringify({ version: 1, servers: [
    { id: 'abc123', name: 'VM', url: 'http://10.0.0.5:25283', key: 'k' },
  ] }));
  const data = loadServers(file);
  assert.strictEqual(data.servers[0].id, LOCAL_ID);
  assert.strictEqual(data.servers.length, 2);
});

test('saveServers writes atomically and leaves no temp file behind', (t) => {
  const file = tmpFile(t);
  saveServers(file, { version: 1, servers: [{ id: LOCAL_ID, name: 'This machine', url: null }] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).servers[0].id, LOCAL_ID);
  const strays = fs.readdirSync(path.dirname(file)).filter((f) => f !== 'servers.json');
  assert.deepStrictEqual(strays, []);
});

test('generateId never produces a reserved id', () => {
  for (let i = 0; i < 200; i++) {
    const id = generateId();
    assert.notStrictEqual(id, LOCAL_ID);
    assert.match(id, /^[0-9a-f]{12}$/);
  }
});

test('parseServerArg handles both argument forms and absence', () => {
  assert.strictEqual(parseServerArg(['.', '--server=abc']), 'abc');
  assert.strictEqual(parseServerArg(['.', '--server', 'abc']), 'abc');
  assert.strictEqual(parseServerArg(['.']), null);
  assert.strictEqual(parseServerArg(['.', '--server']), null); // dangling flag
});

test('resolveLaunchTarget returns null with no argument, and for an unknown id', (t) => {
  const file = tmpFile(t);
  assert.strictEqual(resolveLaunchTarget(['.'], file), null);
  assert.strictEqual(resolveLaunchTarget(['.', '--server=nope'], file), null);
});

test('resolveLaunchTarget resolves the reserved local id to a url-less target', (t) => {
  const file = tmpFile(t);
  const target = resolveLaunchTarget(['.', `--server=${LOCAL_ID}`], file);
  assert.strictEqual(target.id, LOCAL_ID);
  assert.strictEqual(target.url, null);
});

test('normalizeUrl adds scheme and default port, and rejects junk', () => {
  assert.strictEqual(normalizeUrl('192.168.1.5', 25283), 'http://192.168.1.5:25283');
  assert.strictEqual(normalizeUrl('http://192.168.1.5:9000', 25283), 'http://192.168.1.5:9000');
  assert.throws(() => normalizeUrl('   ', 25283));
  assert.throws(() => normalizeUrl('http://', 25283));
});

test('addServer stores a normalized entry and rejects a duplicate url', (t) => {
  const file = tmpFile(t);
  const first = addServer(file, { name: 'VM dev', url: '192.168.1.5', key: 'pw' });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.server.url, 'http://192.168.1.5:25283');
  assert.match(first.server.id, /^[0-9a-f]{12}$/);

  const dup = addServer(file, { name: 'Other', url: 'http://192.168.1.5:25283', key: 'pw' });
  assert.strictEqual(dup.ok, false);
  assert.match(dup.error, /already/i);
});

test('addServer requires a name and a key', (t) => {
  const file = tmpFile(t);
  assert.strictEqual(addServer(file, { name: '', url: '10.0.0.1', key: 'pw' }).ok, false);
  assert.strictEqual(addServer(file, { name: 'X', url: '10.0.0.1', key: '' }).ok, false);
});

test('an added server is resolvable by the id it was given', (t) => {
  const file = tmpFile(t);
  const { server } = addServer(file, { name: 'VM dev', url: '192.168.1.5', key: 'pw' });
  const target = resolveLaunchTarget(['.', `--server=${server.id}`], file);
  assert.strictEqual(target.url, 'http://192.168.1.5:25283');
  assert.strictEqual(target.key, 'pw');
  assert.strictEqual(target.name, 'VM dev');
});

test('removeServer deletes a remote entry but refuses to delete local', (t) => {
  const file = tmpFile(t);
  const { server } = addServer(file, { name: 'VM dev', url: '192.168.1.5', key: 'pw' });
  assert.strictEqual(removeServer(file, server.id), true);
  assert.strictEqual(loadServers(file).servers.length, 1);
  assert.strictEqual(removeServer(file, LOCAL_ID), false);
  assert.strictEqual(loadServers(file).servers.length, 1);
});

test('seedServersFile imports an existing remote binding and is idempotent', (t) => {
  const file = tmpFile(t);
  const legacy = tmpFile(t, 'settings.json');
  fs.writeFileSync(legacy, JSON.stringify({
    theme: 'default-purple',
    remoteServer: 'http://10.0.0.5:25283',
    remoteKey: 'sekret',
  }));

  seedServersFile(file, legacy);
  let data = loadServers(file);
  assert.strictEqual(data.servers.length, 2);
  const imported = data.servers.find((s) => s.id !== LOCAL_ID);
  assert.strictEqual(imported.url, 'http://10.0.0.5:25283');
  assert.strictEqual(imported.key, 'sekret');

  seedServersFile(file, legacy);          // second run must not duplicate
  data = loadServers(file);
  assert.strictEqual(data.servers.length, 2);
});

test('seedServersFile with no legacy remote binding creates local only', (t) => {
  const file = tmpFile(t);
  const legacy = tmpFile(t, 'settings.json');
  fs.writeFileSync(legacy, JSON.stringify({ theme: 'default-purple' }));
  seedServersFile(file, legacy);
  assert.strictEqual(loadServers(file).servers.length, 1);
});

test('seedServersFile leaves an existing servers.json untouched', (t) => {
  const file = tmpFile(t);
  const legacy = tmpFile(t, 'settings.json');
  fs.writeFileSync(legacy, JSON.stringify({ remoteServer: 'http://10.0.0.9:25283', remoteKey: 'k' }));
  addServer(file, { name: 'Existing', url: '10.0.0.1', key: 'pw' });
  seedServersFile(file, legacy);
  const names = loadServers(file).servers.map((s) => s.name);
  assert.deepStrictEqual(names, ['This machine', 'Existing']);
});

// Minimal fetch double: returns the queued status for /api/health.
function fakeFetch(status, body = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

test('validateServer accepts a healthy server', async () => {
  const res = await validateServer('http://10.0.0.1:25283', 'pw', fakeFetch(200));
  assert.strictEqual(res.ok, true);
});

test('validateServer reports a wrong password on 401', async () => {
  const res = await validateServer('http://10.0.0.1:25283', 'pw',
    fakeFetch(401, { error: 'Invalid password.' }));
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /Wrong password/i);
});

test('validateServer explains a 403 hostname rejection', async () => {
  const res = await validateServer('http://box.local:25283', 'pw', fakeFetch(403));
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /extraAllowedHosts/);
});

test('validateServer reports other HTTP statuses', async () => {
  const res = await validateServer('http://10.0.0.1:25283', 'pw', fakeFetch(500));
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /HTTP 500/);
});

test('validateServer reports an unreachable host', async () => {
  const res = await validateServer('http://10.0.0.1:25283', 'pw', async () => {
    throw new Error('connect ECONNREFUSED');
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /Cannot reach/);
});
