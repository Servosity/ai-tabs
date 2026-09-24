const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  sanitizeProjectName,
  resolveProjectChild,
  RESOLVED_PROJECTS_ROOT,
  buildAgentCommand,
  serializeAgent,
  pickDisplayIps,
} = require('../server');
const agents = require('../lib/agents');

test('serializeAgent exposes permission labels but not command arguments', () => {
  const serialized = serializeAgent(agents.getAgent('codex'));
  assert.strictEqual(serialized.defaultPermissionProfile, 'ask');
  assert.deepStrictEqual(
    serialized.permissionProfiles.map((profile) => profile.id),
    ['read-only', 'ask', 'approve-for-me', 'full-access']
  );
  assert.strictEqual(
    Object.hasOwn(serialized.permissionProfiles[0], 'args'),
    false
  );

  const arbitraryCommand = 'do-not-leak-command';
  const arbitraryArgument = '--do-not-leak-argument';
  const customSerialized = serializeAgent({
    id: 'example',
    name: 'Example',
    color: '#123456',
    installed: true,
    command: arbitraryCommand,
    allowedArgs: new Set([arbitraryArgument]),
    defaultArgs: [arbitraryArgument],
    bypassArgs: [arbitraryArgument],
    defaultPermissionProfile: 'safe',
    permissionProfiles: [{
      id: 'safe',
      label: 'Safe',
      args: [arbitraryArgument],
      dangerous: false,
      warning: '',
    }],
  });
  assert.strictEqual(Object.hasOwn(customSerialized, 'command'), false);
  const serializedJson = JSON.stringify(customSerialized);
  assert.strictEqual(serializedJson.includes(arbitraryCommand), false);
  assert.strictEqual(serializedJson.includes(arbitraryArgument), false);
});

test('buildAgentCommand applies ordinary Codex defaults without changing Claude', () => {
  assert.strictEqual(
    buildAgentCommand(agents.getAgent('codex'), '', false),
    'codex --sandbox=workspace-write --ask-for-approval=on-request -c approvals_reviewer=user\n'
  );
  assert.strictEqual(
    buildAgentCommand(agents.getAgent('claude'), '', false),
    'claude\n'
  );
});

test('buildAgentCommand applies a selected permission profile', () => {
  assert.strictEqual(
    buildAgentCommand(agents.getAgent('claude'), '', false, 'auto'),
    'claude --permission-mode=auto\n'
  );
  assert.strictEqual(
    buildAgentCommand(agents.getAgent('codex'), '', false, 'approve-for-me'),
    'codex --sandbox=workspace-write --ask-for-approval=on-request -c approvals_reviewer=auto_review\n'
  );
  assert.strictEqual(
    buildAgentCommand(agents.getAgent('gemini'), '', false, 'auto-edit'),
    'gemini --approval-mode=auto_edit\n'
  );
});

test('buildAgentCommand keeps modifier bypass above selected profiles', () => {
  assert.strictEqual(
    buildAgentCommand(agents.getAgent('codex'), '', true, 'read-only'),
    'codex --dangerously-bypass-approvals-and-sandbox\n'
  );
});

test('buildAgentCommand uses the selected agent bypass mode', () => {
  assert.strictEqual(
    buildAgentCommand(
      agents.getAgent('codex'),
      '--sandbox=workspace-write --ask-for-approval=on-request',
      true
    ),
    'codex --dangerously-bypass-approvals-and-sandbox\n'
  );
  assert.strictEqual(
    buildAgentCommand(agents.getAgent('claude'), '--dangerously-skip-permissions', true),
    'claude --dangerously-skip-permissions\n'
  );
});

test('sanitizeProjectName accepts a normal folder name', () => {
  const r = sanitizeProjectName('my-project_2');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.safeName, 'my-project_2');
});

test('sanitizeProjectName trims surrounding whitespace', () => {
  const r = sanitizeProjectName('  spaced name  ');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.safeName, 'spaced name');
});

test('sanitizeProjectName rejects path traversal', () => {
  assert.strictEqual(sanitizeProjectName('..').ok, false);
  assert.strictEqual(sanitizeProjectName('../evil').ok, false);
  assert.strictEqual(sanitizeProjectName('foo/bar').ok, false);
  assert.strictEqual(sanitizeProjectName('foo\\bar').ok, false);
});

test('sanitizeProjectName rejects empty / non-string input', () => {
  assert.strictEqual(sanitizeProjectName('').ok, false);
  assert.strictEqual(sanitizeProjectName('   ').ok, false);
  assert.strictEqual(sanitizeProjectName(null).ok, false);
  assert.strictEqual(sanitizeProjectName(undefined).ok, false);
});

test('sanitizeProjectName rejects names with disallowed characters', () => {
  const dots = sanitizeProjectName('name.with.dots');
  assert.strictEqual(dots.ok, false);
  assert.ok(dots.error, 'rejection result should include an error message');
  assert.strictEqual(sanitizeProjectName('name*star').ok, false);
});

test('resolveProjectChild accepts an immediate child of the projects root', () => {
  const r = resolveProjectChild(path.join(RESOLVED_PROJECTS_ROOT, 'some-folder'));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.name, 'some-folder');
  assert.strictEqual(r.folderPath, path.join(RESOLVED_PROJECTS_ROOT, 'some-folder'));
});

test('resolveProjectChild rejects the root itself, nested paths, and outsiders', () => {
  assert.strictEqual(resolveProjectChild(RESOLVED_PROJECTS_ROOT).ok, false);
  assert.strictEqual(resolveProjectChild(path.join(RESOLVED_PROJECTS_ROOT, 'a', 'b')).ok, false);
  assert.strictEqual(resolveProjectChild('C:\\Windows\\System32').ok, false);
  assert.strictEqual(resolveProjectChild(path.join(RESOLVED_PROJECTS_ROOT, 'a', '..', '..')).ok, false);
});

test('resolveProjectChild rejects empty / non-string input', () => {
  assert.strictEqual(resolveProjectChild('').ok, false);
  assert.strictEqual(resolveProjectChild(null).ok, false);
  assert.strictEqual(resolveProjectChild(undefined).ok, false);
});

test('pickDisplayIps skips link-local APIPA addresses', () => {
  const interfaces = {
    'Ethernet 2': [
      { address: '169.254.83.107', family: 'IPv4', internal: false },
    ],
    'Ethernet': [
      { address: '10.0.0.4', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
  };
  const { localIp, tailscaleIp } = pickDisplayIps(interfaces);
  assert.strictEqual(localIp, '10.0.0.4');
  assert.strictEqual(tailscaleIp, null);
});

test('pickDisplayIps detects tailscale and returns null localIp when only APIPA exists', () => {
  const withTailscale = {
    ts: [{ address: '100.101.5.9', family: 'IPv4', internal: false }],
    eth: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
  };
  const r = pickDisplayIps(withTailscale);
  assert.strictEqual(r.tailscaleIp, '100.101.5.9');
  assert.strictEqual(r.localIp, '10.0.0.5');
  const onlyApipa = { e: [{ address: '169.254.1.2', family: 'IPv4', internal: false }] };
  assert.strictEqual(pickDisplayIps(onlyApipa).localIp, null);
});
