const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const sm = require('../lib/store-migrate');
const { seedServersFile, loadServers, LOCAL_ID } = require('../lib/servers');

const favFile = path.join(os.tmpdir(), `sm-fav-test-${process.pid}.json`);
const catFile = path.join(os.tmpdir(), `sm-cat-test-${process.pid}.json`);
const OLD = 'C:\\Projects\\old-name';
const NEW = 'C:\\Projects\\new-name';

test('renameCwdInFavorites rewrites matching entries', () => {
  fs.writeFileSync(favFile, JSON.stringify([OLD, 'C:\\Projects\\other']));
  sm.renameCwdInFavorites(favFile, OLD, NEW);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(favFile, 'utf8')), [NEW, 'C:\\Projects\\other']);
});

test('removeCwdFromFavorites drops matching entries', () => {
  fs.writeFileSync(favFile, JSON.stringify([OLD, 'C:\\Projects\\other']));
  sm.removeCwdFromFavorites(favFile, OLD);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(favFile, 'utf8')), ['C:\\Projects\\other']);
});

test('renameCwdInCategories re-keys assignments and preserves order', () => {
  fs.writeFileSync(catFile, JSON.stringify({ assignments: { [OLD]: 'Work' }, order: ['Work'] }));
  sm.renameCwdInCategories(catFile, OLD, NEW);
  const parsed = JSON.parse(fs.readFileSync(catFile, 'utf8'));
  assert.deepStrictEqual(parsed, { assignments: { [NEW]: 'Work' }, order: ['Work'] });
});

test('removeCwdFromCategories deletes the assignment', () => {
  fs.writeFileSync(catFile, JSON.stringify({ assignments: { [OLD]: 'Work' }, order: ['Work'] }));
  sm.removeCwdFromCategories(catFile, OLD);
  const parsed = JSON.parse(fs.readFileSync(catFile, 'utf8'));
  assert.deepStrictEqual(parsed, { assignments: {}, order: ['Work'] });
});

test('all helpers no-op on missing or corrupt files', () => {
  const missing = path.join(os.tmpdir(), `sm-missing-${process.pid}.json`);
  sm.renameCwdInFavorites(missing, OLD, NEW);   // must not throw or create the file
  assert.strictEqual(fs.existsSync(missing), false);
  fs.writeFileSync(favFile, '{not json');
  sm.removeCwdFromFavorites(favFile, OLD);      // must not throw
  fs.unlinkSync(favFile);
  fs.unlinkSync(catFile);
});

test('categories helpers no-op when assignments is valid JSON but not an object', () => {
  fs.writeFileSync(catFile, JSON.stringify({ assignments: 42, order: [] }));
  sm.renameCwdInCategories(catFile, OLD, NEW);   // must not throw
  sm.removeCwdFromCategories(catFile, OLD);      // must not throw
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(catFile, 'utf8')), { assignments: 42, order: [] });
  fs.unlinkSync(catFile);
});

test('seedServersFile imports a legacy remote binding into the server list', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tabs-seed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const serversFile = path.join(dir, 'servers.json');
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    theme: 'default-purple',
    remoteServer: 'http://10.0.0.5:25283',
    remoteKey: 'sekret',
  }));

  seedServersFile(serversFile, settingsFile);

  const { servers } = loadServers(serversFile);
  assert.strictEqual(servers.length, 2);
  assert.strictEqual(servers[0].id, LOCAL_ID);
  assert.strictEqual(servers[1].url, 'http://10.0.0.5:25283');
  assert.strictEqual(servers[1].name, '10.0.0.5'); // hostname becomes the label
});

test('seedServersFile does nothing when there is no legacy settings file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tabs-seed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const serversFile = path.join(dir, 'servers.json');
  seedServersFile(serversFile, path.join(dir, 'nope.json'));
  assert.strictEqual(loadServers(serversFile).servers.length, 1);
});
