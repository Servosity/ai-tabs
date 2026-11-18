// Per-tab ownership rules (lib/tab-owners.js). Fake timers: no real waiting.
const { test } = require('node:test');
const assert = require('node:assert');
const { createTabOwners, normalizeClient, ANON_NAME } = require('../lib/tab-owners');

const JEFF = { id: 'c-jeff', name: 'Jeff' };
const AL = { id: 'c-al', name: 'Alaister' };

function setup() {
  const timers = [];
  const changes = [];
  const owners = createTabOwners({
    graceMs: 5000,
    setTimer: (fn) => { const t = { fn, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
    onChange: (id, owner) => changes.push([id, owner && owner.name]),
  });
  const fire = () => timers.filter((t) => !t.cleared).forEach((t) => { t.cleared = true; t.fn(); });
  return { owners, changes, fire };
}

test('creator drives; another client is refused until it claims', () => {
  const { owners, changes } = setup();
  owners.set(1, JEFF);
  assert.strictEqual(owners.drive(1, JEFF), true);
  assert.strictEqual(owners.drive(1, AL), false);
  assert.strictEqual(owners.mayDrive(1, AL), false);
  owners.claim(1, AL);
  assert.strictEqual(owners.drive(1, AL), true);
  assert.strictEqual(owners.drive(1, JEFF), false);
  assert.deepStrictEqual(changes, [[1, 'Jeff'], [1, 'Alaister']]);
});

test('first keystroke into an unowned tab claims it', () => {
  const { owners } = setup();
  assert.strictEqual(owners.mayDrive(7, AL), true);
  assert.strictEqual(owners.drive(7, AL), true);
  assert.deepStrictEqual(owners.get(7), AL);
  assert.strictEqual(owners.drive(7, JEFF), false);
});

test('owner leaving releases the tab after the grace period, unless they return', () => {
  const { owners, changes, fire } = setup();
  owners.set(1, JEFF);
  owners.set(2, JEFF);
  owners.scheduleRelease(1);
  owners.scheduleRelease(2);
  owners.cancelRelease(2); // Jeff reconnected to tab 2
  fire();
  assert.strictEqual(owners.get(1), null);
  assert.deepStrictEqual(owners.get(2), JEFF);
  assert.deepStrictEqual(changes.at(-1), [1, null]);
});

test('a claim during the grace period wins over the pending release', () => {
  const { owners, fire } = setup();
  owners.set(1, JEFF);
  owners.scheduleRelease(1);
  owners.claim(1, AL);
  fire();
  assert.deepStrictEqual(owners.get(1), AL);
});

test('rename carries to every tab the client owns; forget drops a tab', () => {
  const { owners } = setup();
  owners.set(1, JEFF);
  owners.set(2, AL);
  owners.rename({ id: 'c-jeff', name: 'J. Moore' });
  assert.strictEqual(owners.get(1).name, 'J. Moore');
  assert.strictEqual(owners.get(2).name, 'Alaister');
  owners.forget(1);
  assert.strictEqual(owners.get(1), null);
});

test('normalizeClient falls back to the socket id and a default name, and caps lengths', () => {
  assert.deepStrictEqual(normalizeClient(null, 'anon:1.2.3.4'), { id: 'anon:1.2.3.4', name: ANON_NAME });
  assert.deepStrictEqual(normalizeClient({ id: '  ', name: '' }, 'fb'), { id: 'fb', name: ANON_NAME });
  const long = normalizeClient({ id: 'x'.repeat(100), name: 'n'.repeat(100) }, 'fb');
  assert.strictEqual(long.id.length, 64);
  assert.strictEqual(long.name.length, 40);
});
