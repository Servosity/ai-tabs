const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const windowState = require('../lib/window-state');

const LAPTOP = { x: 0, y: 0, width: 1920, height: 1040 };
const RIGHT_MONITOR = { x: 1920, y: 0, width: 2560, height: 1400 };

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tabs-window-state-'));
  return { dir, file: path.join(dir, 'window-state.json') };
}

test('bounds round-trip per launch target, and a missing or corrupt file means no memory', () => {
  const { dir, file } = tmpFile();
  try {
    assert.equal(windowState.load(file, 'local'), null);
    windowState.save(file, 'local', { x: 10, y: 20, width: 1600, height: 900, maximized: false });
    windowState.save(file, 'vm', { x: 1950, y: 40, width: 1200, height: 800, maximized: true });
    assert.deepEqual(windowState.load(file, 'local'), { x: 10, y: 20, width: 1600, height: 900, maximized: false });
    assert.equal(windowState.load(file, 'vm').maximized, true);
    fs.writeFileSync(file, '{not json');
    assert.equal(windowState.load(file, 'local'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a saved position on an attached monitor is kept', () => {
  const saved = { x: 2100, y: 100, width: 1800, height: 1100, maximized: false };
  assert.deepEqual(windowState.fitToDisplays(saved, [LAPTOP, RIGHT_MONITOR]), saved);
});

test('a position on a monitor that is gone is dropped, and the size is capped to what fits', () => {
  const saved = { x: 2100, y: 100, width: 2400, height: 1300, maximized: true };
  assert.deepEqual(windowState.fitToDisplays(saved, [LAPTOP]), { width: 1920, height: 1040, maximized: true });
});

test('a window whose title strip is above the screen loses its position', () => {
  const saved = { x: 100, y: -200, width: 1200, height: 800, maximized: false };
  assert.equal('x' in windowState.fitToDisplays(saved, [LAPTOP]), false);
});

function fakeWindow() {
  const win = new EventEmitter();
  return Object.assign(win, {
    isDestroyed: () => false, isMinimized: () => false, isFullScreen: () => false, isVisible: () => false,
    isMaximized: () => true,
    getNormalBounds: () => ({ x: 50, y: 60, width: 1500, height: 950 }),
    getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
  });
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('a user resize is saved on close, as the restored size of a maximized window', async () => {
  const { dir, file } = tmpFile();
  try {
    const win = fakeWindow();
    windowState.track(win, file, 'local', { settleMs: 5 });
    win.emit('show');
    await tick(20);
    win.emit('resize');
    win.emit('close');
    assert.deepEqual(windowState.load(file, 'local'), { x: 50, y: 60, width: 1500, height: 950, maximized: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the window placing itself at launch is not saved, so the size cannot creep', async () => {
  const { dir, file } = tmpFile();
  try {
    windowState.save(file, 'local', { x: 1, y: 2, width: 1854, height: 1184, maximized: false });
    const win = fakeWindow();
    windowState.track(win, file, 'local', { settleMs: 30 });
    win.emit('resize'); // before it shows
    win.emit('show');
    win.emit('resize'); // while settling
    await tick(60);
    win.emit('close'); // nothing the user did
    assert.deepEqual(windowState.load(file, 'local'), { x: 1, y: 2, width: 1854, height: 1184, maximized: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
