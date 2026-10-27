const { test } = require('node:test');
const assert = require('node:assert');
const { pick } = require('../public/inline-pending.js');

test('the newest waiting image is shown', () => {
  const items = [{ id: 'b', at: 2 }, { id: 'a', at: 1 }];
  assert.strictEqual(pick(items, new Set()).id, 'b');
});

test('an image closed by hand gives way to the next one', () => {
  const items = [{ id: 'b', at: 2 }, { id: 'a', at: 1 }];
  assert.strictEqual(pick(items, new Set(['b'])).id, 'a');
  assert.strictEqual(pick(items, new Set(['a', 'b'])), null);
});

test('nothing waiting shows nothing', () => {
  assert.strictEqual(pick([], new Set()), null);
  assert.strictEqual(pick([null, {}], new Set()), null);
});
