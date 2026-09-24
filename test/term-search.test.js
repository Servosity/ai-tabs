const { test } = require('node:test');
const assert = require('node:assert');

const {
  HIGHLIGHT_LIMIT, NO_RESULTS_TEXT,
  decorationColors, searchOptions, formatMatchCount, isFindShortcut,
} = require('../public/term-search');

test('formatMatchCount: empty query shows nothing', () => {
  assert.strictEqual(formatMatchCount({ resultIndex: 0, resultCount: 3 }, ''), '');
  assert.strictEqual(formatMatchCount(null, ''), '');
});

test('formatMatchCount: index/count is 1-based', () => {
  assert.strictEqual(formatMatchCount({ resultIndex: 0, resultCount: 3 }, 'x'), '1/3');
  assert.strictEqual(formatMatchCount({ resultIndex: 2, resultCount: 3 }, 'x'), '3/3');
});

test('formatMatchCount: zero or missing results reads "No results"', () => {
  assert.strictEqual(formatMatchCount({ resultIndex: -1, resultCount: 0 }, 'x'), NO_RESULTS_TEXT);
  assert.strictEqual(formatMatchCount(null, 'x'), NO_RESULTS_TEXT);
});

test('formatMatchCount: addon reports -1 when the highlight limit is exceeded', () => {
  assert.strictEqual(formatMatchCount({ resultIndex: -1, resultCount: -1 }, 'x'), `${HIGHLIGHT_LIMIT}+`);
});

test('formatMatchCount: count without a current index shows just the count', () => {
  assert.strictEqual(formatMatchCount({ resultIndex: -1, resultCount: 7 }, 'x'), '7');
});

test('searchOptions: booleans are coerced and decorations always present', () => {
  const opts = searchOptions({ caseSensitive: 1, regex: undefined, incremental: true }, { accent: '#123456' });
  assert.strictEqual(opts.caseSensitive, true);
  assert.strictEqual(opts.regex, false);
  assert.strictEqual(opts.incremental, true);
  assert.strictEqual(opts.decorations.activeMatchBorder, '#123456');
  assert.ok(opts.decorations.matchBackground);
});

test('decorationColors: falls back to defaults when theme colours are missing', () => {
  const d = decorationColors(undefined);
  assert.match(d.matchBorder, /^#[0-9a-f]{6}$/i);
  assert.match(d.activeMatchBackground, /^#[0-9a-f]{8}$/i);
});

test('isFindShortcut: Ctrl+F and Cmd+F only, no Shift/Alt, keydown only', () => {
  assert.strictEqual(isFindShortcut({ type: 'keydown', key: 'f', ctrlKey: true }), true);
  assert.strictEqual(isFindShortcut({ type: 'keydown', key: 'F', ctrlKey: true }), true);
  assert.strictEqual(isFindShortcut({ type: 'keydown', key: 'f', metaKey: true }), true);
  assert.strictEqual(isFindShortcut({ type: 'keydown', key: 'f', ctrlKey: true, shiftKey: true }), false);
  assert.strictEqual(isFindShortcut({ type: 'keydown', key: 'f', ctrlKey: true, altKey: true }), false);
  assert.strictEqual(isFindShortcut({ type: 'keyup', key: 'f', ctrlKey: true }), false);
  assert.strictEqual(isFindShortcut({ type: 'keydown', key: 'g', ctrlKey: true }), false);
  assert.strictEqual(isFindShortcut(null), false);
});
