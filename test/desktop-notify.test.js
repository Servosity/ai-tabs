const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ATTENTION_REASONS,
  reasonFromHook,
  shouldNotify,
  describeAttention,
  createDesktopNotifier,
} = require('../lib/desktop-notify');
const { DEFAULT_SETTINGS } = require('../lib/theme-presets');

// ── shouldNotify ─────────────────────────────────────────────────────────────

const base = { enabled: true, muted: false, active: false, windowFocused: true, episodeStart: true };

test('a background tab starting an attention episode notifies', () => {
  assert.equal(shouldNotify(base), true);
});

test('the setting toggle disables notifications entirely', () => {
  assert.equal(shouldNotify({ ...base, enabled: false }), false);
});

test('muted tabs never notify', () => {
  assert.equal(shouldNotify({ ...base, muted: true }), false);
});

test('the active tab in a focused window never notifies', () => {
  assert.equal(shouldNotify({ ...base, active: true, windowFocused: true }), false);
});

test('the active tab in an unfocused window does notify', () => {
  assert.equal(shouldNotify({ ...base, active: true, windowFocused: false }), true);
});

test('only the episode start notifies — repeated idle titles coalesce', () => {
  assert.equal(shouldNotify({ ...base, episodeStart: false }), false);
});

// ── reasonFromHook ───────────────────────────────────────────────────────────

test('hook events map to distinct reasons', () => {
  assert.equal(reasonFromHook({ hook_event_name: 'Stop' }), 'finished');
  assert.equal(reasonFromHook({ hook_event_name: 'Notification' }), 'permission');
  assert.equal(reasonFromHook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }), 'question');
  assert.equal(reasonFromHook({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode' }), 'plan');
});

test('unknown events and malformed payloads give no reason', () => {
  assert.equal(reasonFromHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), null);
  assert.equal(reasonFromHook({ hook_event_name: 'SubagentStop' }), null);
  assert.equal(reasonFromHook(null), null);
  assert.equal(reasonFromHook('Stop'), null);
});

test('every mapped reason is a known reason', () => {
  for (const p of [
    { hook_event_name: 'Stop' },
    { hook_event_name: 'Notification' },
    { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' },
    { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode' },
  ]) {
    assert.ok(ATTENTION_REASONS.includes(reasonFromHook(p)));
  }
});

// ── describeAttention ────────────────────────────────────────────────────────

test('the body names the agent and what happened', () => {
  assert.equal(describeAttention('finished', 'Claude Code'), 'Claude Code finished and is waiting for you');
  assert.equal(describeAttention('question', 'Claude Code'), 'Claude Code has a question for you');
  assert.equal(describeAttention('plan', 'Claude Code'), 'Claude Code has a plan ready for review');
  assert.equal(describeAttention('permission', 'Claude Code'), 'Claude Code needs your input');
});

test('unknown reasons and agents fall back to a generic body', () => {
  assert.equal(describeAttention(null, null), 'Agent needs your attention');
  assert.equal(describeAttention('bogus', '  '), 'Agent needs your attention');
  assert.equal(describeAttention(undefined, 'Codex CLI'), 'Codex CLI needs your attention');
});

// ── createDesktopNotifier ────────────────────────────────────────────────────

function fakeNotificationClass({ supported = true } = {}) {
  const shown = [];
  class FakeNotification {
    constructor(opts) { this.opts = opts; this.handlers = {}; }
    on(evt, fn) { this.handlers[evt] = fn; }
    show() { shown.push(this); }
    static isSupported() { return supported; }
  }
  return { FakeNotification, shown };
}

test('notify shows a notification and routes clicks to onClick', () => {
  const { FakeNotification, shown } = fakeNotificationClass();
  const notifier = createDesktopNotifier({ Notification: FakeNotification });
  let clicked = 0;
  const ok = notifier.notify({ title: 'my-project', body: 'Claude Code finished', onClick: () => { clicked++; } });
  assert.equal(ok, true);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].opts.title, 'my-project');
  shown[0].handlers.click();
  assert.equal(clicked, 1);
});

test('notify is a no-op when the platform has no notification support', () => {
  const { FakeNotification, shown } = fakeNotificationClass({ supported: false });
  const notifier = createDesktopNotifier({ Notification: FakeNotification });
  assert.equal(notifier.supported, false);
  assert.equal(notifier.notify({ title: 't', body: 'b', onClick: () => {} }), false);
  assert.equal(shown.length, 0);
});

test('a throwing Notification constructor is swallowed and logged', () => {
  class Boom { constructor() { throw new Error('no toast'); } static isSupported() { return true; } }
  const logs = [];
  const notifier = createDesktopNotifier({ Notification: Boom, log: (m) => logs.push(m) });
  assert.equal(notifier.notify({ title: 't', body: 'b', onClick: () => {} }), false);
  assert.ok(logs.some((l) => l.includes('no toast')));
});

// ── settings default ─────────────────────────────────────────────────────────

test('desktop notifications default to on', () => {
  assert.equal(DEFAULT_SETTINGS.notifications.desktop, true);
});
