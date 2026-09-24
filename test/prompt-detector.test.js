const test = require('node:test');
const assert = require('node:assert');

const { PromptDetector } = require('../lib/prompt-detector');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const claudeDetection = {
  oscNotificationCodes: ['2'],
  quiescence: false,
  quiescenceMs: 10,
};

test('Claude detection emits idle for OSC 9;2 notifications', () => {
  const detector = new PromptDetector(1, claudeDetection);
  let idleCount = 0;
  detector.on('idle', () => { idleCount += 1; });

  detector.feed('\x1b]9;2;Claude needs attention\x07');

  assert.strictEqual(idleCount, 1);
  detector.destroy();
});

test('Claude detection handles notifications split across OSC prefix boundaries', () => {
  const notification = '\x1b]9;2;done\x07';

  for (let split = 1; split <= 5; split += 1) {
    const detector = new PromptDetector(1, claudeDetection);
    let idleCount = 0;
    detector.on('idle', () => { idleCount += 1; });

    detector.feed(notification.slice(0, split));
    assert.strictEqual(idleCount, 0, `emitted before boundary ${split} was complete`);

    detector.feed(notification.slice(split));
    assert.strictEqual(idleCount, 1, `missed notification split at boundary ${split}`);
    detector.destroy();
  }
});

test('Claude detection drops oversized incomplete OSC codes without contaminating later input', () => {
  const detector = new PromptDetector(1, claudeDetection);
  let idleCount = 0;
  detector.on('idle', () => { idleCount += 1; });

  detector.feed(`\x1b]9;${'x'.repeat(100)}`);
  detector.feed('2;not-a-notification\x07');
  assert.strictEqual(idleCount, 0);

  detector.feed('\x1b]9;2;real notification\x07');
  assert.strictEqual(idleCount, 1);
  detector.destroy();
});

test('Claude detection ignores non-notification OSC 9 activity', async () => {
  const detector = new PromptDetector(1, claudeDetection);
  let idleCount = 0;
  detector.on('idle', () => { idleCount += 1; });

  detector.feed('\x1b]9;4;1;50\x07');
  await delay(25);

  assert.strictEqual(idleCount, 0);
  detector.destroy();
});

test('Claude detection ignores ordinary output quiescence', async () => {
  const detector = new PromptDetector(1, claudeDetection);
  let idleCount = 0;
  detector.on('idle', () => { idleCount += 1; });

  detector.feed('Finished dispatching a subagent');
  await delay(25);

  assert.strictEqual(idleCount, 0);
  detector.destroy();
});

test('default detection still emits idle after output quiescence', async () => {
  const detector = new PromptDetector(1, { quiescenceMs: 10 });
  let idleCount = 0;
  detector.on('idle', () => { idleCount += 1; });

  detector.feed('ordinary agent output');
  await delay(25);

  assert.strictEqual(idleCount, 1);
  detector.destroy();
});

test('default detection accepts any OSC 9 notification code', () => {
  const detector = new PromptDetector(1);
  let idleCount = 0;
  detector.on('idle', () => { idleCount += 1; });

  detector.feed('\x1b]9;2;attention\x07');
  detector.feed('\x1b]9;4;1;50\x07');

  assert.strictEqual(idleCount, 2);
  detector.destroy();
});
