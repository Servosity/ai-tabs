const { test } = require('node:test');
const assert = require('node:assert');
const {
  DEFAULT_SETTINGS,
  deepMerge,
} = require('../lib/theme-presets');

test('default permission settings preserve current agent behavior', () => {
  assert.deepStrictEqual(DEFAULT_SETTINGS.agentPermissions, {
    claude: 'manual',
    codex: 'ask',
    gemini: 'default',
  });
});

test('deepMerge fills missing per-agent permissions in older settings', () => {
  const merged = deepMerge(DEFAULT_SETTINGS, {
    agentPermissions: { codex: 'approve-for-me' },
  });

  assert.deepStrictEqual(merged.agentPermissions, {
    claude: 'manual',
    codex: 'approve-for-me',
    gemini: 'default',
  });
  });
