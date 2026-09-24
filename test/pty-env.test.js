const { test } = require('node:test');
const assert = require('node:assert/strict');

const { baseEnv, INHERITED_SESSION_ENV, COLOR_SUPPRESSION_ENV } = require('../lib/pty-manager');

// Launching ai-tabs from inside a Claude Code session (a `claude` session
// running ai-tabs.cmd) leaks that session's identity into the app, and from
// there into every PTY it spawns. Claude Code reads CLAUDE_CODE_CHILD_SESSION
// and treats a fresh top-level session as somebody's subagent — transcript
// saving off, degraded output. Terminals must start clean.

test('session-identity vars do not reach a spawned terminal', () => {
  const env = baseEnv({
    PATH: '/usr/bin',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: '5330a0bc',
    CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_012X',
    CLAUDE_PID: '3120',
    CLAUDE_EFFORT: 'high',
  });

  for (const key of INHERITED_SESSION_ENV) {
    assert.ok(!(key in env), `${key} leaked into the PTY environment`);
  }
  assert.strictEqual(env.PATH, '/usr/bin');
});

test('CLAUDECODE is left alone — agents.js owns that one', () => {
  // The multi-agent spec keeps plain terminals inheriting CLAUDECODE; only the
  // claude registry entry clears it. Stripping it here would silently undo that.
  assert.ok(!INHERITED_SESSION_ENV.includes('CLAUDECODE'));
  assert.strictEqual(baseEnv({ CLAUDECODE: '1' }).CLAUDECODE, '1');
});

test('unrelated Anthropic config survives', () => {
  const env = baseEnv({ ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CONFIG_DIR: '/home/j/.claude' });
  assert.strictEqual(env.ANTHROPIC_API_KEY, 'sk-test');
  assert.strictEqual(env.CLAUDE_CONFIG_DIR, '/home/j/.claude');
});

// An inherited NO_COLOR outranks TERM and COLORTERM, dropping every agent TUI
// to monochrome. It reads as a broken colour scheme, not as an env var — which
// is exactly what makes it worth a test.
test('colour-suppression flags do not reach a spawned terminal', () => {
  const env = baseEnv({ NO_COLOR: '1', FORCE_COLOR: '0', PATH: '/usr/bin' });
  for (const key of COLOR_SUPPRESSION_ENV) {
    assert.ok(!(key in env), `${key} leaked into the PTY environment`);
  }
  assert.strictEqual(env.PATH, '/usr/bin');
});

test('an agent launch can still opt back in through extraEnv', () => {
  // baseEnv only drops what was inherited; it must not stop a caller setting it.
  const spawned = { ...baseEnv({ NO_COLOR: '1' }), ...{ NO_COLOR: '1' } };
  assert.strictEqual(spawned.NO_COLOR, '1');
});

test('baseEnv does not mutate the environment it reads', () => {
  const source = { CLAUDE_PID: '3120' };
  baseEnv(source);
  assert.strictEqual(source.CLAUDE_PID, '3120');
});
