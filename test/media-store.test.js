const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MediaStore } = require('../lib/media/store');
const { imageDimensions, parseHookPayload, resolveImportPath } = require('../lib/media/validate');
const { extractImageBlocks } = require('../lib/media/extract');

// 1x1 transparent PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG = Buffer.from(PNG_B64, 'base64');

function gif(w, h) {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}

function jpeg(w, h) {
  // SOI, then an APP0 segment to skip, then SOF0 with the size.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46]);
  const sof = Buffer.alloc(2 + 17);
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8;
  sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function tmpStore(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tabs-media-'));
  return { dir, store: new MediaStore(dir, opts) };
}

// ── Header sniffing ──────────────────────────────────────────────────────────

test('image dimensions come straight from the file header', () => {
  assert.deepEqual(imageDimensions(PNG, 'image/png'), { width: 1, height: 1 });
  assert.deepEqual(imageDimensions(gif(320, 200), 'image/gif'), { width: 320, height: 200 });
  assert.deepEqual(imageDimensions(jpeg(1568, 779), 'image/jpeg'), { width: 1568, height: 779 });
  assert.equal(imageDimensions(Buffer.from('nope'), 'image/png'), null);
});

// ── Block extraction (hook tool_response and transcript content shapes) ──────

test('every documented image shape is recognised, everything else ignored', () => {
  const read = { type: 'image', file: { base64: PNG_B64, type: 'image/png', originalSize: 5665 } };
  const mcp = [
    { type: 'text', text: 'Successfully captured screenshot' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
  ];
  const rawMcp = { content: [{ type: 'image', data: 'BBBB', mimeType: 'image/webp' }] };
  const codex = { type: 'input_image', image_url: 'data:image/gif;base64,CCCC' };

  assert.deepEqual(extractImageBlocks(read), [{ mime: 'image/png', data: PNG_B64 }]);
  assert.deepEqual(extractImageBlocks(mcp), [{ mime: 'image/jpeg', data: 'AAAA' }]);
  assert.deepEqual(extractImageBlocks(rawMcp), [{ mime: 'image/webp', data: 'BBBB' }]);
  assert.deepEqual(extractImageBlocks(codex), [{ mime: 'image/gif', data: 'CCCC' }]);

  // Text results, unknown mimes and non-image blocks never produce entries.
  assert.deepEqual(extractImageBlocks('file contents'), []);
  assert.deepEqual(extractImageBlocks({ type: 'text', text: 'hi' }), []);
  assert.deepEqual(extractImageBlocks({ type: 'image', source: { media_type: 'image/svg+xml', data: 'x' } }), []);
  assert.deepEqual(extractImageBlocks(null), []);
});

// ── Payload validation ───────────────────────────────────────────────────────

test('hook payloads are validated before anything touches disk', () => {
  const ok = parseHookPayload({ tabSessionId: '4', toolName: 'Read', images: [{ mime: 'image/png', data: PNG_B64 }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.tabSessionId, 4);
  assert.equal(ok.images[0].buf.length, PNG.length);

  const bad = [
    null,
    { images: [{ mime: 'image/png', data: PNG_B64 }] },
    { tabSessionId: 'abc', images: [{ mime: 'image/png', data: PNG_B64 }] },
    { tabSessionId: 1, images: [] },
    { tabSessionId: 1, images: [{ mime: 'image/svg+xml', data: PNG_B64 }] },
    { tabSessionId: 1, images: [{ mime: 'image/png' }] },
    { tabSessionId: 1, images: [{ mime: 'image/png', data: '!!!' }] },
    { tabSessionId: 1, images: new Array(9).fill({ mime: 'image/png', data: PNG_B64 }) },
  ];
  for (const body of bad) assert.equal(parseHookPayload(body).ok, false, JSON.stringify(body)?.slice(0, 60));
});

test('path imports are confined to the session cwd and the temp dir', () => {
  const cwd = path.join(os.tmpdir(), 'proj-x');
  assert.ok(resolveImportPath(path.join(cwd, 'shot.png'), [cwd]));
  assert.ok(resolveImportPath(path.join(os.tmpdir(), 'shot.png'), []));
  assert.equal(resolveImportPath(path.join(cwd, '..', '..', 'etc', 'passwd'), [cwd]), null);
  assert.equal(resolveImportPath('C:\\Windows\\win.ini', [cwd]), null);
  assert.equal(resolveImportPath('/etc/passwd', [cwd]), null);
});

// ── The store ────────────────────────────────────────────────────────────────

test('add writes bytes + index, dedups by content, lists newest first', () => {
  const { dir, store } = tmpStore();
  try {
    const a = store.add(7, { buf: PNG, mime: 'image/png', toolName: 'Read', at: 1000 });
    assert.equal(a.duplicate, false);
    assert.match(a.entry.file, /^1000-[0-9a-f]{8}\.png$/);
    assert.equal(a.entry.width, 1);
    assert.ok(fs.existsSync(path.join(dir, '7', a.entry.file)));
    assert.ok(!('sha1' in a.entry), 'hash stays private');

    const dup = store.add(7, { buf: PNG, mime: 'image/png', toolName: 'paste', at: 2000 });
    assert.equal(dup.duplicate, true);
    assert.equal(dup.entry.id, a.entry.id);

    const b = store.add(7, { buf: gif(2, 2), mime: 'image/gif', at: 3000 });
    const older = store.add(7, { buf: jpeg(4, 4), mime: 'image/jpeg', at: 500, origin: 'transcript' });
    assert.deepEqual(store.list(7).map((e) => e.id), [b.entry.id, a.entry.id, older.entry.id]);

    // A fresh store instance reads the same index back from disk.
    assert.deepEqual(new MediaStore(dir).list(7).map((e) => e.id), [b.entry.id, a.entry.id, older.entry.id]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('per-session caps evict the oldest entries and their files', () => {
  const { dir, store } = tmpStore({ maxEntries: 2 });
  try {
    const first = store.add(1, { buf: gif(1, 1), mime: 'image/gif', at: 1 });
    store.add(1, { buf: gif(2, 1), mime: 'image/gif', at: 2 });
    store.add(1, { buf: gif(3, 1), mime: 'image/gif', at: 3 });
    assert.equal(store.list(1).length, 2);
    assert.ok(!fs.existsSync(path.join(dir, '1', first.entry.file)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the global cap evicts dead sessions before touching live ones', () => {
  const live = new Set([2]);
  const { dir, store } = tmpStore({ maxTotalBytes: 40, isLive: (id) => live.has(id) });
  try {
    store.add(1, { buf: gif(1, 1), mime: 'image/gif', at: 1 }); // 13 bytes, dead session
    store.add(2, { buf: gif(2, 1), mime: 'image/gif', at: 2 }); // 13 bytes, live
    store.add(2, { buf: gif(3, 1), mime: 'image/gif', at: 3 }); // 39 total
    store.add(2, { buf: gif(4, 1), mime: 'image/gif', at: 4 }); // 52 → over
    assert.equal(store.list(1).length, 0, 'dead session evicted first');
    assert.equal(store.list(2).length, 3, 'live session untouched once under cap');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('begin wipes a reused PTY id; resolveFile refuses traversal and unknown names', () => {
  const { dir, store } = tmpStore();
  try {
    const { entry } = store.add(3, { buf: PNG, mime: 'image/png' });
    assert.equal(store.resolveFile(3, entry.file), path.join(dir, '3', entry.file));
    assert.equal(store.resolveFile('3', entry.file), path.join(dir, '3', entry.file));
    assert.equal(store.resolveFile(3, '..\\index.json'), null);
    assert.equal(store.resolveFile(3, '../3/' + entry.file), null);
    assert.equal(store.resolveFile(3, 'index.json'), null, 'only indexed files are served');
    assert.equal(store.resolveFile('3; rm', entry.file), null);
    assert.equal(store.remove(3, 'nope'), false);
    assert.equal(store.remove(3, entry.id), true);
    assert.ok(!fs.existsSync(path.join(dir, '3', entry.file)));

    store.add(3, { buf: PNG, mime: 'image/png' });
    store.begin(3);
    assert.deepEqual(store.list(3), []);
    assert.ok(!fs.existsSync(path.join(dir, '3')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
