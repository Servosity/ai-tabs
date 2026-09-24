const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Point the registry at a temp user-agents file BEFORE requiring the module.
const tmpFile = path.join(os.tmpdir(), `agents-test-${process.pid}.json`);
process.env.AI_TABS_AGENTS_FILE = tmpFile;
const agents = require('../lib/agents');

test('built-in agents are present, in order', () => {
  const ids = agents.getAgents().map(a => a.id);
  assert.deepStrictEqual(ids.slice(0, 3), ['claude', 'codex', 'gemini']);
});

test('getAgent returns null for unknown ids', () => {
  assert.strictEqual(agents.getAgent('nope'), null);
});

test('every agent has an installed boolean', () => {
  for (const a of agents.getAgents()) {
    assert.strictEqual(typeof a.installed, 'boolean');
  }
});

test('sanitizeArgs keeps only whitelisted flags for that agent', () => {
  assert.strictEqual(
    agents.sanitizeArgs('claude', '--verbose --rm --dangerously-skip-permissions'),
    '--verbose --dangerously-skip-permissions'
  );
  assert.strictEqual(
    agents.sanitizeArgs('codex', '--verbose --sandbox=workspace-write'),
    '--sandbox=workspace-write'
  );
  assert.strictEqual(agents.sanitizeArgs('nope', '--verbose'), '');
  assert.strictEqual(agents.sanitizeArgs('claude', ''), '');
});

test('Gemini canonicalizes only the exact legacy yolo token', () => {
  assert.strictEqual(
    agents.sanitizeArgs('gemini', '--yolo --yolo=maybe --approval-mode=plan'),
    '--approval-mode=yolo --approval-mode=plan'
  );
});

test('legacy Gemini yolo remains an explicit bypass above selected profiles', () => {
  assert.strictEqual(
    agents.resolveLaunchArgs('gemini', '--yolo', false, 'plan'),
    '--approval-mode=yolo'
  );
  assert.strictEqual(
    agents.resolveLaunchArgs('gemini', '--yolo=maybe', false, 'plan'),
    '--approval-mode=plan'
  );
});

test('Codex rejects removed full-auto input', () => {
  assert.strictEqual(agents.sanitizeArgs('codex', '--full-auto'), '');
});

test('claude keeps the CLAUDECODE env marker', () => {
  assert.deepStrictEqual(agents.getAgent('claude').env, { CLAUDECODE: '' });
  assert.deepStrictEqual(agents.getAgent('codex').env, {});
});

test('agents expose normalized default and bypass argument arrays', () => {
  assert.deepStrictEqual(agents.getAgent('claude').defaultArgs, []);
  assert.deepStrictEqual(agents.getAgent('claude').bypassArgs, ['--dangerously-skip-permissions']);
  assert.deepStrictEqual(agents.getAgent('codex').defaultArgs, [
    '--sandbox=workspace-write',
    '--ask-for-approval=on-request',
  ]);
  assert.deepStrictEqual(agents.getAgent('codex').bypassArgs, ['--dangerously-bypass-approvals-and-sandbox']);
});

test('built-ins expose supported permission profiles and unchanged defaults', () => {
  const summary = Object.fromEntries(
    ['claude', 'codex', 'gemini'].map((id) => {
      const agent = agents.getAgent(id);
      return [id, {
        defaultProfile: agent.defaultPermissionProfile,
        ids: agent.permissionProfiles.map((profile) => profile.id),
      }];
    })
  );

  assert.deepStrictEqual(summary, {
    claude: { defaultProfile: 'manual', ids: ['manual', 'accept-edits', 'auto', 'dont-ask', 'plan', 'bypass'] },
    codex: { defaultProfile: 'ask', ids: ['read-only', 'ask', 'approve-for-me', 'full-access'] },
    gemini: { defaultProfile: 'default', ids: ['default', 'auto-edit', 'plan', 'yolo'] },
  });

  assert.strictEqual(agents.getAgent('claude').permissionProfiles.find((p) => p.id === 'bypass').dangerous, true);
  assert.strictEqual(agents.getAgent('codex').permissionProfiles.find((p) => p.id === 'full-access').dangerous, true);
  assert.strictEqual(agents.getAgent('gemini').permissionProfiles.find((p) => p.id === 'yolo').dangerous, true);
});
test('ordinary Codex uses its default ask-for-approval profile', () => {
  assert.strictEqual(
    agents.resolveLaunchArgs('codex', '', false),
    '--sandbox=workspace-write --ask-for-approval=on-request -c approvals_reviewer=user'
  );
});

test('resolveLaunchArgs applies ordinary defaults without changing Claude', () => {
  assert.strictEqual(agents.resolveLaunchArgs('claude', '', false), '');
});

test('resolveLaunchArgs expands trusted permission profiles', () => {
  assert.strictEqual(agents.resolveLaunchArgs('claude', '', false, 'accept-edits'), '--permission-mode=acceptEdits');
  assert.strictEqual(agents.resolveLaunchArgs('codex', '', false, 'approve-for-me'), '--sandbox=workspace-write --ask-for-approval=on-request -c approvals_reviewer=auto_review');
  assert.strictEqual(agents.resolveLaunchArgs('gemini', '', false, 'plan'), '--approval-mode=plan');
});

test('invalid permission profiles fall back to each built-in default', () => {
  assert.strictEqual(agents.resolveLaunchArgs('claude', '', false, 'obsolete'), '');
  assert.strictEqual(agents.resolveLaunchArgs('codex', '', false, 'obsolete'), '--sandbox=workspace-write --ask-for-approval=on-request -c approvals_reviewer=user');
  assert.strictEqual(agents.resolveLaunchArgs('gemini', '', false, 'obsolete'), '');
});

test('modifier bypass wins over configured permission profiles', () => {
  assert.strictEqual(agents.resolveLaunchArgs('claude', '', true, 'plan'), '--dangerously-skip-permissions');
  assert.strictEqual(agents.resolveLaunchArgs('codex', '', true, 'read-only'), '--dangerously-bypass-approvals-and-sandbox');
  assert.strictEqual(agents.resolveLaunchArgs('gemini', '', true, 'plan'), '--approval-mode=yolo');
});
test('resolveLaunchArgs uses mutually exclusive per-agent bypass arguments', () => {
  assert.strictEqual(
    agents.resolveLaunchArgs(
      'codex',
      '--sandbox=workspace-write --ask-for-approval=on-request',
      true
    ),
    '--dangerously-bypass-approvals-and-sandbox'
  );
  assert.strictEqual(
    agents.resolveLaunchArgs('claude', '--dangerously-skip-permissions', true),
    '--dangerously-skip-permissions'
  );
});

test('legacy explicit bypass suppresses defaults and disallowed flags are dropped', () => {
  assert.strictEqual(
    agents.resolveLaunchArgs('codex', '--dangerously-bypass-approvals-and-sandbox --verbose', false),
    '--dangerously-bypass-approvals-and-sandbox'
  );
  assert.strictEqual(agents.resolveLaunchArgs('nope', '--sandbox=workspace-write', false), '');
});

test('bypass request falls back to defaults when a user agent has no bypass mode', () => {
  fs.writeFileSync(tmpFile, JSON.stringify([{
    id: 'aider',
    name: 'Aider',
    command: 'aider',
    allowedArgs: ['--yes'],
    defaultArgs: ['--yes'],
  }]));
  agents.refresh();
  assert.strictEqual(agents.resolveLaunchArgs('aider', '', true), '--yes');
  fs.unlinkSync(tmpFile);
  agents.refresh();
});

test('custom bypass suppresses conflicting custom defaults and explicit arguments', () => {
  fs.writeFileSync(tmpFile, JSON.stringify([{
    id: 'aider',
    name: 'Aider',
    command: 'aider',
    allowedArgs: ['--yes', '--bypass'],
    defaultArgs: ['--yes'],
    bypassArgs: ['--bypass'],
  }]));
  agents.refresh();
  assert.strictEqual(agents.resolveLaunchArgs('aider', '--bypass --yes'), '--bypass');
  fs.unlinkSync(tmpFile);
  agents.refresh();
});
test('user agents merge from agents.json; built-ins win collisions; invalid entries skipped', () => {
  fs.writeFileSync(tmpFile, JSON.stringify([
    { id: 'aider', name: 'Aider', command: 'aider', allowedArgs: ['--yes'], color: '#00cc88' },
    { id: 'claude', name: 'Impostor', command: 'evil' },
    { id: 'BAD ID!', name: 'x', command: 'x' },
  ]));
  agents.refresh();
  const aider = agents.getAgent('aider');
  assert.strictEqual(aider.name, 'Aider');
  assert.ok(aider.allowedArgs.has('--yes'));
  assert.strictEqual(agents.getAgent('claude').command, 'claude'); // built-in wins
  assert.strictEqual(agents.getAgents().some(a => a.id === 'BAD ID!'), false);
  fs.unlinkSync(tmpFile);
  agents.refresh();
});

test('corrupt agents.json is ignored, built-ins still work', () => {
  fs.writeFileSync(tmpFile, '{not json');
  agents.refresh();
  assert.strictEqual(agents.getAgents().length, 3);
  fs.unlinkSync(tmpFile);
  agents.refresh();
});

test('Claude uses explicit notifications instead of quiescence', () => {
  assert.deepStrictEqual(agents.getAgent('claude').detection, {
    oscNotificationCodes: ['2'],
    quiescence: false,
  });
});
