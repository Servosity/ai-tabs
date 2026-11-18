// Shared-tab identity: the desktop app's (lib/client-identity.js) and a
// browser's (public/tab-share.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadIdentity, saveName } = require('../lib/client-identity');
const { browserIdentity, ID_KEY, NAME_KEY, DEFAULT_NAME } = require('../public/tab-share');

test('desktop identity keeps its id, defaults the name to the OS user, and saves a new one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tabs-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'identity.json');

  const first = loadIdentity(file);
  assert.match(first.id, /^d-[0-9a-f]{24}$/);
  assert.strictEqual(first.name, os.userInfo().username);
  assert.deepStrictEqual(saveName(file, '  Alaister '), { id: first.id, name: 'Alaister' });
  assert.deepStrictEqual(saveName(file, ''), { id: first.id, name: os.userInfo().username });
});

function fakeStorage(init = {}) {
  const data = { ...init };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
}
const fakeCrypto = { getRandomValues: (a) => a.fill(171) };

test('browser identity makes an id once and asks for a name only when none is stored', () => {
  const storage = fakeStorage();
  const asked = [];
  const first = browserIdentity(storage, fakeCrypto, (q) => { asked.push(q); return ' Jeff '; });
  assert.deepStrictEqual(first, { id: 'c-' + 'ab'.repeat(12), name: 'Jeff' });
  assert.deepStrictEqual(storage.data, { [ID_KEY]: first.id, [NAME_KEY]: 'Jeff' });

  const again = browserIdentity(storage, fakeCrypto, () => { throw new Error('asked twice'); });
  assert.deepStrictEqual(again, first);
  assert.strictEqual(asked.length, 1);
});

test('browser identity falls back to a default name when the prompt is dismissed', () => {
  const identity = browserIdentity(fakeStorage(), fakeCrypto, () => null);
  assert.strictEqual(identity.name, DEFAULT_NAME);
});
