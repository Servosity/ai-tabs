const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { trashDirSync } = require('../lib/trash');

test('trashDirSync throws on a nonexistent path', () => {
  assert.throws(
    () => trashDirSync(path.join(os.tmpdir(), 'no-such-dir-xyz')),
    /Not a directory/
  );
});

test('trashDirSync throws on a file (not a directory)', () => {
  const f = path.join(os.tmpdir(), `trash-test-file-${process.pid}.txt`);
  fs.writeFileSync(f, 'x');
  try {
    assert.throws(() => trashDirSync(f), /Not a directory/);
  } finally {
    fs.unlinkSync(f);
  }
});

test('trashDirSync moves a real directory to the trash (win32 only)', { skip: process.platform !== 'win32' }, () => {
  const dir = path.join(os.tmpdir(), `trash-test-dir-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'marker.txt'), 'ai-tabs trash test');
  trashDirSync(dir);
  assert.strictEqual(fs.existsSync(dir), false, 'directory should be gone from its original location');
});
