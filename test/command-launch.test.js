const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseTabSessionId,
  commandLaunchesClaude,
  withHookSettings,
} = require('../lib/command-launch');

// The exact shape an external orchestrator sends to /api/open-tab.
const ORCHESTRATOR_COMMAND = "cd '/c/Projects/orchestrator/specialists/x' && "
  + "export CC_TABS_SESSION_ID='3e4f0c2a-1111-4222-8333-944455556666' && "
  + "claude --session-id '3e4f0c2a-1111-4222-8333-944455556666' --model opus -- 'Read the ticket'";

test('only a plain integer is a tab session id', () => {
  assert.equal(parseTabSessionId('7'), 7);
  assert.equal(parseTabSessionId(12), 12);
  // A UUID that happens to start with digits must not route to tab 3.
  for (const raw of ['3e4f0c2a-1111-4222-8333-944455556666', '7abc', '', null, undefined, '-1', '1.5']) {
    assert.equal(parseTabSessionId(raw), null, String(raw));
  }
});

test('commands that launch claude are recognised, others are not', () => {
  for (const cmd of [ORCHESTRATOR_COMMAND, 'claude', 'claude --resume', "cd x; claude -- 'hi'", 'foo || claude']) {
    assert.equal(commandLaunchesClaude(cmd), true, cmd);
  }
  for (const cmd of ['npm test', 'echo claude-code', "cd '/c/claude/x' && ls", 'claudette', '', null]) {
    assert.equal(commandLaunchesClaude(cmd), false, String(cmd));
  }
});

test('the hook settings flag is added to the claude invocation only', () => {
  const flag = ' --settings "C:\\ai-tabs\\data\\hooks.json"';
  const out = withHookSettings(ORCHESTRATOR_COMMAND, flag);
  assert.ok(out.includes(`&& claude${flag} --session-id`), out);
  // Nothing else in the command moved.
  assert.equal(out.replace(flag, ''), ORCHESTRATOR_COMMAND);
  assert.equal(withHookSettings('claude', flag), `claude${flag}`);
});

test('a command that already passes --settings, or no flag, is left alone', () => {
  const own = "cd x && claude --settings '/tmp/unattended.json' -- 'go'";
  assert.equal(withHookSettings(own, ' --settings "a.json"'), own);
  assert.equal(withHookSettings(ORCHESTRATOR_COMMAND, ''), ORCHESTRATOR_COMMAND);
  assert.equal(withHookSettings('npm test', ' --settings "a.json"'), 'npm test');
});
