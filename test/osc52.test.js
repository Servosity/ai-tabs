const test = require('node:test');
const assert = require('node:assert');
const { decodeOsc52, install, MAX_BASE64_LENGTH } = require('../public/osc52');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('decodeOsc52 turns a clipboard write into text, refuses everything else', () => {
  const cases = [
    ['c;' + b64('hello'), 'hello'],
    ['pc;' + b64('ünïcödé ✓'), 'ünïcödé ✓'],
    [';' + b64('no targets'), 'no targets'],
    ['c;?', null],                  // read query: never report the clipboard
    ['c;', null],                   // empty
    ['nosemicolon', null],
    ['c;!!!notbase64', null],
    ['c;' + Buffer.from([0xff, 0xfe]).toString('base64'), null], // not UTF-8
    ['c;' + 'A'.repeat(MAX_BASE64_LENGTH + 4), null],
  ];
  for (const [input, want] of cases) assert.strictEqual(decodeOsc52(input), want, input.slice(0, 40));
});

test('install registers OSC 52 and writes only decoded text', () => {
  let handler; const written = [];
  const term = { parser: { registerOscHandler: (id, fn) => { assert.strictEqual(id, 52); handler = fn; } } };
  install(term, (t) => { written.push(t); return Promise.resolve(); });
  assert.strictEqual(handler('c;' + b64('copied')), true);
  assert.strictEqual(handler('c;?'), true);
  assert.deepStrictEqual(written, ['copied']);
});
