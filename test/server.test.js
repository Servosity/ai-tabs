const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {
  sanitizeProjectName,
  resolveProjectChild,
  RESOLVED_PROJECTS_ROOT,
  buildAgentCommand,
  serializeAgent,
  pickDisplayIps,
} = require('../server');
const agents = require('../lib/agents');
const projectRootsLib = require('../lib/project-roots');

const TWO_ROOTS = [
  { label: 'Servosity', path: path.resolve('C:\\Users\\x\\Documents\\Projects') },
  { label: 'Personal', path: path.resolve('C:\\Users\\x\\Documents\\Personal') },
];

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

test('resolveProjectChild accepts an immediate child of any configured root and reports which', () => {
  const work = resolveProjectChild(path.join(TWO_ROOTS[0].path, 'ai-tabs'), TWO_ROOTS);
  assert.strictEqual(work.ok, true);
  assert.strictEqual(work.name, 'ai-tabs');
  assert.strictEqual(work.root.label, 'Servosity');

  const personal = resolveProjectChild(path.join(TWO_ROOTS[1].path, 'my-game'), TWO_ROOTS);
  assert.strictEqual(personal.ok, true);
  assert.strictEqual(personal.root.label, 'Personal');
  assert.strictEqual(personal.folderPath, path.join(TWO_ROOTS[1].path, 'my-game'));
});

test('resolveProjectChild with two roots still rejects roots themselves, nesting and outsiders', () => {
  assert.strictEqual(resolveProjectChild(TWO_ROOTS[0].path, TWO_ROOTS).ok, false);
  assert.strictEqual(resolveProjectChild(TWO_ROOTS[1].path, TWO_ROOTS).ok, false);
  assert.strictEqual(resolveProjectChild(path.join(TWO_ROOTS[1].path, 'a', 'b'), TWO_ROOTS).ok, false);
  assert.strictEqual(resolveProjectChild(path.resolve('C:\\Users\\x\\Documents\\Other\\thing'), TWO_ROOTS).ok, false);
});

test('resolveProjectRoots falls back to PROJECTS_ROOT as a one-entry list', () => {
  const roots = projectRootsLib.resolveProjectRoots({}, { PROJECTS_ROOT: 'C:\\Users\\x\\Work' });
  assert.deepStrictEqual(roots, [{ label: 'Work', path: path.resolve('C:\\Users\\x\\Work') }]);
  assert.strictEqual(RESOLVED_PROJECTS_ROOT, projectRootsLib.resolveProjectRoots({}, process.env)[0].path);
});

test('resolveProjectRoots: settings.projectRoots wins over PROJECTS_ROOTS, which wins over PROJECTS_ROOT', () => {
  const env = { PROJECTS_ROOTS: 'C:\\a;C:\\b', PROJECTS_ROOT: 'C:\\legacy' };
  const fromEnv = projectRootsLib.resolveProjectRoots({}, env);
  assert.deepStrictEqual(fromEnv.map((r) => r.path), [path.resolve('C:\\a'), path.resolve('C:\\b')]);
  assert.deepStrictEqual(fromEnv.map((r) => r.label), ['a', 'b']);

  const fromSettings = projectRootsLib.resolveProjectRoots({ projectRoots: TWO_ROOTS }, env);
  assert.deepStrictEqual(fromSettings, TWO_ROOTS);

  const empty = projectRootsLib.resolveProjectRoots({ projectRoots: [] }, {});
  assert.strictEqual(empty.length, 1);
  assert.strictEqual(empty[0].path, projectRootsLib.defaultRootPath());
});

test('normalizeRoots drops blanks and duplicate paths and defaults the label to the folder name', () => {
  const roots = projectRootsLib.normalizeRoots([
    { label: '', path: 'C:\\one' },
    { path: '' },
    null,
    'C:\\two',
    { label: 'again', path: 'C:\\one' },
  ]);
  assert.deepStrictEqual(roots, [
    { label: 'one', path: path.resolve('C:\\one') },
    { label: 'two', path: path.resolve('C:\\two') },
  ]);
});

test('listProjects lists every root in configured order, sorted inside each root, tagged with its root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tabs-roots-'));
  try {
    const work = path.join(tmp, 'Work');
    const home = path.join(tmp, 'Home');
    fs.mkdirSync(path.join(work, 'zeta'), { recursive: true });
    fs.mkdirSync(path.join(work, 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(home, 'game'), { recursive: true });
    fs.writeFileSync(path.join(home, 'not-a-folder.txt'), '');
    const roots = [{ label: 'W', path: work }, { label: 'H', path: home }, { label: 'Gone', path: path.join(tmp, 'missing') }];
    const list = projectRootsLib.listProjects(roots, (cwd) => ({ extra: path.basename(cwd) }));
    assert.deepStrictEqual(list.map((p) => [p.name, p.rootLabel, p.extra]), [
      ['alpha', 'W', 'alpha'], ['zeta', 'W', 'zeta'], ['game', 'H', 'game'],
    ]);
    assert.strictEqual(list[2].rootPath, home);
    assert.strictEqual(list[2].cwd, path.join(home, 'game'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('pickRoot chooses the named root, defaults to the first, and rejects unknown roots', () => {
  assert.strictEqual(projectRootsLib.pickRoot(undefined, TWO_ROOTS), TWO_ROOTS[0]);
  assert.strictEqual(projectRootsLib.pickRoot('', TWO_ROOTS), TWO_ROOTS[0]);
  assert.strictEqual(projectRootsLib.pickRoot(TWO_ROOTS[1].path, TWO_ROOTS), TWO_ROOTS[1]);
  assert.strictEqual(projectRootsLib.pickRoot('C:\\somewhere\\else', TWO_ROOTS), null);
});

test('create in a chosen root and rename stays in its own root (HTTP, two roots)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tabs-roots-http-'));
  const { startTestServer, stopTestServer, PASSWORD } = require('./helpers/spawn-server.js');
  const work = path.join(tmp, 'projects');
  const personal = path.join(tmp, 'Personal');
  fs.mkdirSync(path.join(work, 'demo-project'), { recursive: true });
  fs.mkdirSync(personal, { recursive: true });
  const handle = await startTestServer({ env: { PROJECTS_ROOTS: `${work};${personal}` } });
  if (!handle.base) {
    fs.rmSync(tmp, { recursive: true, force: true });
    return; // no non-loopback IPv4 on this machine; the unit tests above cover the logic
  }
  const headers = { Authorization: `Bearer ${PASSWORD}`, 'Content-Type': 'application/json' };
  const url = `http://127.0.0.1:${handle.port}`;
  try {
    const roots = await (await fetch(`${url}/api/project-roots`)).json();
    assert.deepStrictEqual(roots.map((r) => r.label), ['projects', 'Personal']);

    let res = await fetch(`${url}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ name: 'game', root: personal }) });
    assert.strictEqual(res.status, 200);
    const created = await res.json();
    assert.strictEqual(created.cwd, path.join(personal, 'game'));
    assert.strictEqual(created.rootLabel, 'Personal');

    res = await fetch(`${url}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ name: 'default-root' }) });
    assert.strictEqual((await res.json()).cwd, path.join(work, 'default-root'));

    res = await fetch(`${url}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ name: 'x', root: 'C:\\nope' }) });
    assert.strictEqual(res.status, 400);

    const list = await (await fetch(`${url}/api/projects`)).json();
    assert.deepStrictEqual(list.map((p) => [p.name, p.rootLabel]), [
      ['default-root', 'projects'], ['demo-project', 'projects'], ['game', 'Personal'],
    ]);

    res = await fetch(`${url}/api/projects`, { method: 'PATCH', headers, body: JSON.stringify({ cwd: created.cwd, newName: 'game2' }) });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).cwd, path.join(personal, 'game2'));
    assert.ok(fs.existsSync(path.join(personal, 'game2')));
    assert.ok(!fs.existsSync(path.join(work, 'game2')));
  } finally {
    stopTestServer(handle);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
