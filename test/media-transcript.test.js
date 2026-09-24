const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TranscriptScanner, PASTE_TOOL_NAME } = require('../lib/media/transcript-scan');
const { MediaStore } = require('../lib/media/store');
const { MediaManager } = require('../lib/media/manager');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const GIF_B64 = Buffer.from('GIF89a\x02\x00\x03\x00\x00\x00\x00', 'binary').toString('base64');

// Transcript lines in the shapes recorded in docs/research/agent-image-capture.md.
const LINES = [
  { type: 'assistant', timestamp: '2026-08-04T20:58:30.000Z', message: { role: 'assistant', content: [
    { type: 'text', text: 'Taking a screenshot.' },
    { type: 'tool_use', id: 'toolu_shot', name: 'mcp__claude-in-chrome__computer', input: { action: 'screenshot' } },
  ] } },
  { type: 'user', timestamp: '2026-08-04T20:58:38.682Z', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_shot', content: [
      { type: 'text', text: 'Successfully captured screenshot (2x3, gif)' },
      { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: GIF_B64 } },
    ] },
  ] },
    // Duplicate copy of the same bytes — must not produce a second image.
    toolUseResult: [{ type: 'image', source: { type: 'base64', media_type: 'image/gif', data: GIF_B64 } }] },
  { type: 'assistant', timestamp: '2026-08-04T20:59:00.000Z', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'C:\\proj\\icon.png' } },
  ] } },
  { type: 'user', timestamp: '2026-08-04T20:59:01.000Z', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_read', content: [
      { type: 'image', source: { type: 'base64', data: PNG_B64, media_type: 'image/png' } },
    ] },
  ] }, toolUseResult: { type: 'image', file: { base64: PNG_B64, type: 'image/png' } } },
  // Plain text turn: must be skipped without a JSON.parse.
  { type: 'user', timestamp: '2026-08-04T21:00:00.000Z', message: { role: 'user', content: 'looks good' } },
];

const PASTE_LINE = { type: 'user', timestamp: '2026-08-04T21:01:00.000Z', message: { role: 'user', content: [
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
  { type: 'text', text: 'what is this?' },
] } };

function writeTranscript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tabs-media-transcript-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { dir, file };
}

test('the scanner finds tool-result images, attributes them to their tool, and ignores toolUseResult copies', () => {
  const { dir, file } = writeTranscript(LINES);
  try {
    const scanner = new TranscriptScanner(file);
    const found = [];
    assert.ok(scanner.readNew((img) => found.push(img)) > 0);
    assert.deepEqual(found.map((f) => [f.toolName, f.mime, f.toolUseId]), [
      ['mcp__claude-in-chrome__computer', 'image/gif', 'toolu_shot'],
      ['Read', 'image/png', 'toolu_read'],
    ]);
    assert.equal(found[0].at, Date.parse('2026-08-04T20:58:38.682Z'));

    // Nothing new → nothing re-emitted; an appended paste is picked up incrementally.
    assert.equal(scanner.readNew(() => assert.fail('no new lines')), 0);
    fs.appendFileSync(file, JSON.stringify(PASTE_LINE) + '\n');
    const later = [];
    scanner.readNew((img) => later.push(img));
    assert.equal(later.length, 1);
    assert.equal(later[0].toolName, PASTE_TOOL_NAME);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a partial trailing line is held until the rest arrives', () => {
  const { dir, file } = writeTranscript(LINES.slice(0, 1));
  try {
    const full = JSON.stringify(LINES[1]);
    fs.appendFileSync(file, full.slice(0, 40));
    const scanner = new TranscriptScanner(file);
    const found = [];
    scanner.readNew((img) => found.push(img));
    assert.equal(found.length, 0);
    fs.appendFileSync(file, full.slice(40) + '\n');
    scanner.readNew((img) => found.push(img));
    assert.equal(found.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the manager backfills a transcript into the store once, deduping against hook captures', () => {
  const { dir, file } = writeTranscript([...LINES, PASTE_LINE]);
  const live = new Set([3]);
  const sent = [];
  const store = new MediaStore(path.join(dir, 'media'), { isLive: (id) => live.has(id) });
  const manager = new MediaManager({
    store,
    isLive: (id) => live.has(id),
    hasClients: () => true,
    broadcast: (id, msg) => sent.push(msg),
  });
  try {
    // The hook already delivered the Read image before the transcript was known.
    manager.ingestHook({ tabSessionId: 3, toolName: 'Read', images: [{ mime: 'image/png', data: PNG_B64 }] });
    assert.equal(sent.length, 1);

    manager.setTranscript(3, file);
    const stored = manager.pollOne(3);
    // Screenshot is new; the Read PNG and the pasted PNG are the same bytes as the hook's.
    assert.equal(stored, 1);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].item.origin, 'transcript');
    assert.equal(sent[1].item.toolName, 'mcp__claude-in-chrome__computer');

    // Newest first: the hook capture happened "now", the screenshot in 2026-08-04.
    const ids = manager.list(3).map((e) => e.origin);
    assert.deepEqual(ids, ['hook', 'transcript']);

    // Re-pinning the same file is a no-op; a second poll finds nothing.
    manager.setTranscript(3, file);
    assert.equal(manager.pollOne(3), 0);

    // A dead session stops being polled and its scanner is dropped.
    live.delete(3);
    assert.equal(manager.pollOne(3), 0);
    assert.equal(manager.scanners.has(3), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('beginSession wipes a reused id and setTranscript ignores dead sessions', () => {
  const { dir, file } = writeTranscript(LINES);
  const live = new Set([1]);
  const store = new MediaStore(path.join(dir, 'media'));
  const manager = new MediaManager({ store, isLive: (id) => live.has(id) });
  try {
    manager.setTranscript(1, file);
    manager.pollOne(1);
    assert.equal(manager.list(1).length, 2);
    manager.beginSession(1);
    assert.equal(manager.list(1).length, 0);
    assert.equal(manager.scanners.has(1), false);

    manager.setTranscript(42, file);
    assert.equal(manager.scanners.has(42), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
