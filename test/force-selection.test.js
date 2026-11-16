const test = require('node:test');
const assert = require('node:assert');
const { shouldForce, shouldHoldHover } = require('../public/force-selection');

test('shouldForce turns only a plain left-press under mouse reporting into a selection', () => {
  const plain = { button: 0 };
  const cases = [
    [plain, 'any', true],
    [plain, 'drag', true],
    [plain, 'none', false],          // app not reporting: xterm selects already
    [plain, undefined, false],
    [{ button: 2 }, 'any', false],   // right button stays with the right-click handler
    [{ button: 1 }, 'any', false],
    [{ button: 0, shiftKey: true }, 'any', false], // xterm forces this itself
    [{ button: 0, ctrlKey: true }, 'any', false],
    [{ button: 0, forcedSelection: true }, 'any', false], // our re-dispatch
  ];
  for (const [ev, mode, want] of cases) assert.strictEqual(shouldForce(ev, mode), want, JSON.stringify([ev, mode]));
});

test('shouldHoldHover keeps hover reports from clearing a selection', () => {
  assert.strictEqual(shouldHoldHover({ buttons: 0 }, 'any', true), true);
  assert.strictEqual(shouldHoldHover({ buttons: 0 }, 'any', false), false); // nothing to protect
  assert.strictEqual(shouldHoldHover({ buttons: 1 }, 'any', true), false);  // drag in progress
  assert.strictEqual(shouldHoldHover({ buttons: 0 }, 'none', true), false);
});
