// Which sessions a desktop app opens tabs for when another app starts one.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sessionsToAdopt } = require('../lib/session-mirror');

test('adopts sessions opened elsewhere that are neither shown nor dismissed', () => {
  const sessions = [
    { id: 1, instance: 'me' },      // opened here
    { id: 2, instance: 'other' },   // already has a tab
    { id: 3, instance: 'other' },   // closed here while someone else drove it
    { id: 4, instance: 'other' },   // new from the other app
    { id: 5, instance: null },      // started by a headless server
  ];
  const adopted = sessionsToAdopt(sessions, { instance: 'me', shown: new Set([2]), dismissed: new Set([3]) });
  assert.deepStrictEqual(adopted.map((s) => s.id), [4, 5]);
});
