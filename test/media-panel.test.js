const { test } = require('node:test');
const assert = require('node:assert/strict');

// The panel's DOM needs a browser; its pure helpers load fine under node and
// are what the thumbnails and lightbox captions are built from.
const { toolShort, fmtBytes } = require('../public/media-panel');

test('tool names shorten to something that fits a thumbnail caption', () => {
  assert.equal(toolShort('Read'), 'read');
  assert.equal(toolShort('mcp__claude-in-chrome__computer'), 'chrome');
  assert.equal(toolShort('mcp__playwright__browser_take_screenshot'), 'playwright');
  assert.equal(toolShort('paste'), 'paste');
  assert.equal(toolShort(null), 'image');
});

test('byte counts format for the panel header', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(150 * 1024), '150 KB');
  assert.equal(fmtBytes(3.5 * 1024 * 1024), '3.5 MB');
});
