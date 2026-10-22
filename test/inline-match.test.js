const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalize, findBlocks, liveActivityRow, placeImages } = require('../public/inline-match');

// Rows as Claude Code 2.1.308 drew a reply at 100 columns (native scrollback):
// a quote prefixed "▎" and hard-wrapped, then a code block indented with no fences.
const ROWS = [
  '❯ Reply with a quote and a code block',
  '',
  '● ▎ Farming has shaped human civilization for more than ten thousand years, turning wild grasses ',
  '  ▎ into staple crops and transforming scattered hunter-gatherer bands into permanent villages, ',
  '  ▎ towns, and eventually great cities.',
  '',
  "  const crops = ['wheat', 'barley', 'rice'];",
  '  const yieldPerAcre = 42;',
  '      console.log(`Planting ${crops.length} crops`);',
  '',
  '✻ Baked for 6s · done 12:37 PM',
  '',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
];

const QUOTE = 'Farming has shaped human civilization for more than ten thousand years, turning wild grasses into '
  + 'staple crops and transforming scattered hunter-gatherer bands into permanent villages, towns, and eventually great cities.';
const CODE = "const crops = ['wheat', 'barley', 'rice'];\nconst yieldPerAcre = 42;\n    console.log(`Planting ${crops.length} crops`);";

test('a quote is found across its hard-wrapped rows, whatever the width', () => {
  assert.deepEqual(findBlocks(ROWS, QUOTE), [{ start: 2, end: 4 }]);
});

test('a code block is found by its indented rows', () => {
  assert.deepEqual(findBlocks(ROWS, CODE), [{ start: 6, end: 8 }]);
});

test('markdown emphasis and links match their rendered text', () => {
  assert.equal(normalize('**Bold** and [the docs](https://x.y/z) `here`'), normalize('Bold and the docs here'));
  assert.deepEqual(findBlocks(['● ▎ Bold and the docs here'], '**Bold** and [the docs](https://x.y/z) here'), [{ start: 0, end: 0 }]);
});

test('every copy of a block is found, bottom-most first; text not on screen is not', () => {
  const twice = ['  npm test', 'between', '  npm test'];
  assert.deepEqual(findBlocks(twice, 'npm test'), [{ start: 2, end: 2 }, { start: 0, end: 0 }]);
  assert.deepEqual(findBlocks(ROWS, 'Something Claude never printed in this tab'), []);
  assert.deepEqual(findBlocks(ROWS, ''), []);
});

test('a live image belongs to the last agent line above the input box, past the spinner', () => {
  const rows = ['● Taking a screenshot', '  claude-in-chrome - computer (MCP)', '', '✶ Thinking…', '', '──────────', '❯ ', '──────────'];
  assert.equal(liveActivityRow(rows, 6), 1);
  // Cursor on (or under) the box's bottom rule: still the line above the box.
  assert.equal(liveActivityRow(rows, 7), 1);
  assert.equal(liveActivityRow([...rows, '  status line'], 8), 1);
  assert.equal(liveActivityRow(['no input box here'], 0), -1);
});

test('replayed images pair with paste and MCP rows newest-first, and a Read only with its file name', () => {
  const rows = [
    '❯ [Image #1] what is this?',
    '● chrome - computer (MCP)(action: "screenshot")',
    '● Read(public/icon-192.png)',
    '● chrome - computer (MCP)(action: "screenshot")',
    '  Read 3 files (ctrl+o to expand)',
  ];
  const placed = placeImages(rows, [
    { id: 'shot2', toolName: 'mcp__claude-in-chrome__computer' },
    { id: 'shot1', toolName: 'mcp__claude-in-chrome__computer' },
    { id: 'icon', toolName: 'Read', sourcePath: 'C:\\proj\\public\\icon-192.png' },
    { id: 'collapsed', toolName: 'Read', sourcePath: 'C:\\proj\\other.png' },
    { id: 'paste', toolName: 'paste' },
  ]);
  assert.deepEqual([...placed], [['shot2', 3], ['shot1', 1], ['icon', 2], ['paste', 0]]);
});
