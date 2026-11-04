// The real public/inline-marks.js on a headless xterm, drawn to by a stand-in
// for the agent's renderer. The one rule under test: an image is never drawn
// over text the agent has written.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/headless');

// The module's debounces only pace real output; run them fast.
const TIME_SCALE = 40;
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, (ms || 0) / TIME_SCALE, ...args);
const pause = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

const stubNode = () => ({
  style: {}, classList: { add() {}, remove() {}, toggle() {} },
  append() {}, remove() {}, addEventListener() {}, removeAttribute() {}, focus() {},
});
global.window = global;
global.document = { createElement: stubNode, body: stubNode() };
global.URL.createObjectURL = () => 'blob:test';
global.URL.revokeObjectURL = () => {};

let chips = null; // the overlay marks of the terminal being tested
global.TermOverlay = {
  create() {
    const own = chips;
    return {
      render() {},
      add(opts) {
        const mark = { ...opts, element: stubNode(), dispose() { own.delete(mark); } };
        opts.marker.onDispose(mark.dispose);
        own.add(mark);
        return mark;
      },
    };
  },
};
require('../public/inline-match');
require('../public/inline-gaps');
require('../public/inline-marks');

const COLS = 120;
const ROWS = 54;
const MONTAGE_WIDTH = 844;
const MONTAGE_HEIGHT = 1476; // 18 rows at this cell size
const SCAN_WAIT_MS = 30;
const SETTLE_WAIT_MS = 60;

async function agentTerminal({ scrollback = 10000 } = {}) {
  chips = new Set();
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback, allowProposedApi: true });
  term.element = { querySelector: () => ({ clientWidth: COLS * 12, clientHeight: term.rows * 24 }) };
  term.refresh = () => {};
  // The headless build has no onWriteParsed: fire it after each write here.
  const parsedListeners = [];
  term.onWriteParsed = (listener) => { parsedListeners.push(listener); return { dispose() {} }; };
  const marks = global.InlineMarks.create({
    term,
    copy: async () => true,
    fetch: async () => ({ ok: true, json: async () => ({ items: [] }), blob: async () => ({}) }),
  });
  await marks.attach('s');
  await pause(SCAN_WAIT_MS);

  const write = (data) => new Promise((resolve) => term.write(data, () => {
    for (const listener of parsedListeners) listener();
    resolve();
  }));
  const footer = ['✻ Working…', '', '─'.repeat(COLS), '> ', '─'.repeat(COLS), '  status'];
  let drawn = 0;
  async function say(lines) {
    let out = '\r';
    for (let i = 0; i < drawn; i++) out += '\x1b[2K' + (i < drawn - 1 ? '\x1b[1A' : '');
    await write(out + '\r' + lines.map((l) => `${l}\r\n`).join('') + footer.join('\r\n'));
    drawn = footer.length;
  }
  let imageCount = 0;
  const agent = {
    term, write, say,
    lines: (n) => say(Array.from({ length: n }, (_, i) => `● line ${i}`)),
    async read() {
      const id = `i${++imageCount}`;
      await say([`● Read(${id}.png)`, '  ⎿  Read image']);
      marks.pushImage({
        id, file: id, width: MONTAGE_WIDTH, height: MONTAGE_HEIGHT,
        toolName: 'Read', sourcePath: `${id}.png`, at: Date.now(),
      });
      await pause(SCAN_WAIT_MS);
    },
    async idle() {
      marks.settled();
      await pause(SETTLE_WAIT_MS);
      await write('');
    },
    async openStack(images) {
      await agent.lines(60);
      for (let i = 0; i < images; i++) { await agent.read(); await agent.lines(1); }
      await agent.idle();
    },
    async repaint(prefix) {
      await write(prefix + Array.from({ length: term.rows - 1 }, (_, i) => `● repainted ${i}`).join('\r\n'));
      await pause(SCAN_WAIT_MS);
    },
    textUnderImages() {
      const buffer = term.buffer.normal;
      const hits = [];
      for (const chip of chips) {
        for (let row = chip.marker.line; row < chip.marker.line + chip.height; row++) {
          const text = buffer.getLine(row)?.translateToString(true);
          if (text && text.trim()) hits.push(`row ${row}: ${text.trim().slice(0, 30)}`);
        }
      }
      return hits;
    },
  };
  await write(footer.join('\r\n'));
  drawn = footer.length;
  return agent;
}

for (const [name, prefix] of [
  ['a jump home', '\x1b[H'],
  ['a long cursor-up', '\x1b[60A'],
  ['a clear and home', '\x1b[2J\x1b[H'],
]) {
  test(`a stack of images taller than the screen closes on ${name}`, async () => {
    const agent = await agentTerminal();
    await agent.openStack(10);
    await agent.repaint(prefix);
    assert.deepEqual(agent.textUnderImages(), []);
  });
}

test('a gap a taller window pulled out of scrollback closes when the agent reaches it', async () => {
  const agent = await agentTerminal();
  await agent.lines(60);
  await agent.read();
  await agent.lines(50);
  await pause(SCAN_WAIT_MS);
  assert.equal(chips.size, 1, 'the gap opened in scrollback');
  agent.term.resize(COLS, ROWS + 25);
  await pause(SCAN_WAIT_MS);
  await agent.repaint('\x1b[70A');
  assert.deepEqual(agent.textUnderImages(), []);
});

test('a scroll-region command, which homes the cursor, closes the gaps', async () => {
  const agent = await agentTerminal();
  await agent.openStack(1);
  await agent.repaint(`\x1b[1;${ROWS}r`);
  assert.deepEqual(agent.textUnderImages(), []);
});

test('a cursor saved before a gap opened is restored to the row it was saved on', async () => {
  const agent = await agentTerminal();
  await agent.lines(60);
  await agent.read();
  await agent.write('\x1b7');
  await agent.idle();
  const savedRow = agent.term.buffer.normal.cursorY;
  await agent.write('\x1b8');
  assert.equal(agent.term.buffer.normal.cursorY, savedRow);
  await agent.write('● restored');
  await pause(SCAN_WAIT_MS);
  assert.deepEqual(agent.textUnderImages(), []);
});

test('text reaching a gap some other way takes the image off it', async () => {
  const agent = await agentTerminal();
  await agent.openStack(1);
  assert.equal(chips.size, 1);
  await agent.repaint('\x1b[?6h'); // origin mode homes the cursor; nothing watches for it
  await agent.write('\x1b[?6l');
  assert.deepEqual(agent.textUnderImages(), []);
});

test('an image taken off its gap comes back once its line is in scrollback', async () => {
  const agent = await agentTerminal();
  await agent.openStack(1);
  await agent.repaint('\x1b[H');
  assert.equal(chips.size, 0, 'the gap closed');
  await agent.lines(70);
  await pause(SCAN_WAIT_MS);
  assert.deepEqual(agent.textUnderImages(), []);
  assert.equal(chips.size, 1, 'the image is back, in its own rows');
});

test('an open gap survives the agent redrawing only what is under it', async () => {
  const agent = await agentTerminal();
  await agent.openStack(1);
  assert.equal(chips.size, 1);
  await agent.write('\x1b[3A\x1b[2K> typing\x1b[3B');
  await pause(SCAN_WAIT_MS);
  assert.equal(chips.size, 1, 'the image is still drawn');
  assert.deepEqual(agent.textUnderImages(), []);
});

test('text that overwrites a gap and scrolls it away in one write takes the image off it', async () => {
  const agent = await agentTerminal();
  await agent.openStack(1);
  const lines = Array.from({ length: 100 }, (_, i) => `● overwrite ${i}`).join('\r\n');
  await agent.write(`\x1b[?6h${lines}\x1b[?6l`);
  await pause(SCAN_WAIT_MS);
  assert.deepEqual(agent.textUnderImages(), []);
});

test('a cursor saved above a gap stays on its row when a full scrollback trims', async () => {
  const agent = await agentTerminal({ scrollback: 20 });
  await agent.lines(100);
  await agent.read();
  await agent.write(`\x1b[H\x1b7\x1b[${ROWS};1H`);
  const savedRow = agent.term.registerMarker(-(ROWS - 1));
  await agent.idle();
  agent.term.resize(COLS, ROWS + 20); // room for the row to be on screen after the trim
  await agent.write('\x1b8');
  const buffer = agent.term.buffer.normal;
  assert.equal(buffer.cursorY, Math.max(0, savedRow.line - buffer.baseY));
});

test('a scroll region xterm ignores leaves the gaps alone', async () => {
  const agent = await agentTerminal();
  await agent.openStack(1);
  await agent.write('\x1b[10;5r');
  await pause(SCAN_WAIT_MS);
  assert.equal(chips.size, 1);
});

test('a gap exposed and overwritten within one write takes its image off', async () => {
  const agent = await agentTerminal();
  await agent.openStack(4);
  const lines = Array.from({ length: 100 }, (_, i) => `● overwrite ${i}`).join('\r\n');
  await agent.write(`\x1b[40;1H\x1b[?6h${lines}\x1b[?6l`);
  await pause(SCAN_WAIT_MS);
  assert.deepEqual(agent.textUnderImages(), []);
});
