const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { extractSnippets, SnippetStore, KIND_CODE, KIND_QUOTE } = require('../lib/media/snippets');
const { TranscriptScanner } = require('../lib/media/transcript-scan');
const { MediaManager } = require('../lib/media/manager');
const { MediaStore } = require('../lib/media/store');

const REPLY = [
  'Here is the fix:',
  '',
  '```js',
  'const a = 1;',
  '',
  '  indented();',
  '```',
  '',
  'Paste this into the mod page:',
  '',
  '> Hey, thanks for the report. This one is fixed in 0.4.2,',
  '> grab it from the Files tab.',
  '>',
  '> Second paragraph.',
  '',
  '1. In a list:',
  '   ```',
  '   npm test',
  '   ```',
].join('\n');

test('code blocks and quotes come out with their exact source text, in order', () => {
  assert.deepEqual(extractSnippets(REPLY), [
    { kind: KIND_CODE, lang: 'js', text: 'const a = 1;\n\n  indented();' },
    { kind: KIND_QUOTE, lang: null, text: 'Hey, thanks for the report. This one is fixed in 0.4.2,\ngrab it from the Files tab.\n\nSecond paragraph.' },
    { kind: KIND_CODE, lang: null, text: 'npm test' },
  ]);
});

test('a longer fence holds shorter fences, and an unclosed fence runs to the end', () => {
  const nested = '````md\n```js\nx\n```\n````';
  assert.deepEqual(extractSnippets(nested), [{ kind: KIND_CODE, lang: 'md', text: '```js\nx\n```' }]);
  assert.deepEqual(extractSnippets('```\nhalf\nwritten'), [{ kind: KIND_CODE, lang: null, text: 'half\nwritten' }]);
  assert.deepEqual(extractSnippets('no snippets here\n\n```\n```'), []);
  assert.deepEqual(extractSnippets(null), []);
});

test('the store keeps one copy per text, newest first, capped', () => {
  const store = new SnippetStore({ max: 2 });
  assert.equal(store.add(1, { kind: KIND_CODE, text: 'a', at: 1 }).duplicate, false);
  assert.equal(store.add(1, { kind: KIND_CODE, text: 'a', at: 5 }).duplicate, true);
  store.add(1, { kind: KIND_QUOTE, text: 'b', at: 3 });
  store.add(1, { kind: KIND_CODE, text: 'c', at: 2 });
  assert.deepEqual(store.list(1).map((s) => s.text), ['b', 'c']);
  assert.ok(!('sha1' in store.list(1)[0]));
  store.begin(1);
  assert.deepEqual(store.list(1), []);
});

test('the scanner hands assistant snippets to onSnippet and skips user text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tabs-snippets-'));
  const file = path.join(dir, 'session.jsonl');
  const lines = [
    { type: 'user', timestamp: '2026-10-22T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '```\nmine\n```' }] } },
    { type: 'assistant', timestamp: '2026-10-22T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: REPLY }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  try {
    const found = [];
    new TranscriptScanner(file).readNew(() => {}, (s) => found.push(s));
    assert.equal(found.length, 3);
    assert.equal(found[0].at, Date.parse('2026-10-22T10:00:05.000Z'));

    const sent = [];
    const manager = new MediaManager({
      store: new MediaStore(path.join(dir, 'media')),
      isLive: () => true,
      broadcast: (id, msg) => sent.push(msg),
    });
    manager.setTranscript(7, file);
    manager.pollOne(7);
    manager.scanners.get(7).offset = 0; // a re-scan must not duplicate
    manager.pollOne(7);
    assert.deepEqual(sent.map((m) => m.type), ['snippet', 'snippet', 'snippet']);
    assert.equal(manager.listSnippets(7).length, 3);
    manager.endSession(7);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
