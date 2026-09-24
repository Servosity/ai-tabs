const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Point both registries at temp files BEFORE requiring the modules.
const agentsFile = path.join(os.tmpdir(), `launch-options-agents-${process.pid}.json`);
const projectsFile = path.join(os.tmpdir(), `launch-options-projects-${process.pid}.json`);
process.env.AI_TABS_AGENTS_FILE = agentsFile;
process.env.AI_TABS_PROJECTS_FILE = projectsFile;

const agents = require('../lib/agents');
const projectAgents = require('../lib/project-agents');
const { DEFAULT_SETTINGS } = require('../lib/theme-presets');
const { serializeAgent } = require('../server');

const NATIVE_SCROLLBACK_ENV = 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN';
const CWD = path.join(os.tmpdir(), 'launch-options-project');

test('claude exposes the nativeScrollback launch option; others expose none', () => {
  const claude = agents.getAgent('claude');
  assert.deepStrictEqual(claude.launchOptions.map((o) => o.id), ['nativeScrollback']);
  assert.deepStrictEqual(claude.launchOptions[0].env, { [NATIVE_SCROLLBACK_ENV]: '1' });
  assert.deepStrictEqual(agents.getAgent('codex').launchOptions, []);
  assert.deepStrictEqual(agents.getAgent('gemini').launchOptions, []);
});

test('resolveLaunchEnv: off (or unspecified) keeps the base env only', () => {
  assert.deepStrictEqual(agents.resolveLaunchEnv('claude'), { CLAUDECODE: '' });
  assert.deepStrictEqual(agents.resolveLaunchEnv('claude', { nativeScrollback: false }), { CLAUDECODE: '' });
  assert.deepStrictEqual(agents.resolveLaunchEnv('claude', null), { CLAUDECODE: '' });
});

test('resolveLaunchEnv: on adds CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1', () => {
  assert.deepStrictEqual(
    agents.resolveLaunchEnv('claude', { nativeScrollback: true }),
    { CLAUDECODE: '', [NATIVE_SCROLLBACK_ENV]: '1' }
  );
});

test('resolveLaunchEnv: unknown options and agents are ignored', () => {
  assert.deepStrictEqual(agents.resolveLaunchEnv('claude', { bogus: true }), { CLAUDECODE: '' });
  assert.deepStrictEqual(agents.resolveLaunchEnv('codex', { nativeScrollback: true }), {});
  assert.deepStrictEqual(agents.resolveLaunchEnv('nope', { nativeScrollback: true }), {});
});

test('user agents.json may declare launch options; malformed ones are dropped', () => {
  fs.writeFileSync(agentsFile, JSON.stringify([{
    id: 'mytool', name: 'My Tool', command: 'mytool',
    launchOptions: [
      { id: 'quiet', label: 'Quiet', env: { MYTOOL_QUIET: '1' } },
      { id: 'bad id', env: { NOPE: '1' } },
      'garbage',
    ],
  }]));
  agents.refresh();
  const mine = agents.getAgent('mytool');
  assert.deepStrictEqual(mine.launchOptions.map((o) => o.id), ['quiet']);
  assert.deepStrictEqual(agents.resolveLaunchEnv('mytool', { quiet: true }), { MYTOOL_QUIET: '1' });
  fs.unlinkSync(agentsFile);
  agents.refresh();
});

test('serializeAgent exposes launch option labels but not their env', () => {
  const s = serializeAgent(agents.getAgent('claude'));
  assert.deepStrictEqual(s.launchOptions.map((o) => o.id), ['nativeScrollback']);
  assert.strictEqual(Object.hasOwn(s.launchOptions[0], 'env'), false);
  assert.strictEqual(JSON.stringify(s).includes(NATIVE_SCROLLBACK_ENV), false);
  assert.ok(s.launchOptions[0].label.includes('native scrollback'));
});

test('DEFAULT_SETTINGS: native scrollback is off by default', () => {
  assert.deepStrictEqual(DEFAULT_SETTINGS.agentLaunchOptions, { claude: { nativeScrollback: false } });
});

test('project overrides: set/get/clear round-trip, inherit by default', () => {
  if (fs.existsSync(projectsFile)) fs.unlinkSync(projectsFile);
  assert.deepStrictEqual(projectAgents.getLaunchOptionsFor(CWD), {});

  projectAgents.setLaunchOptionFor(CWD, 'nativeScrollback', true);
  assert.deepStrictEqual(projectAgents.getLaunchOptionsFor(CWD), { nativeScrollback: true });

  projectAgents.setLaunchOptionFor(CWD, 'nativeScrollback', false);
  assert.deepStrictEqual(projectAgents.getLaunchOptionsFor(CWD), { nativeScrollback: false });

  projectAgents.setLaunchOptionFor(CWD, 'nativeScrollback', null);
  assert.deepStrictEqual(projectAgents.getLaunchOptionsFor(CWD), {});
  // Entry with nothing left in it is removed entirely
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(projectsFile, 'utf8')), {});
});

test('project overrides survive agent changes and clearing ownership', () => {
  projectAgents.setAgentFor(CWD, 'claude');
  projectAgents.setLaunchOptionFor(CWD, 'nativeScrollback', true);
  projectAgents.setAgentFor(CWD, 'codex');
  assert.deepStrictEqual(projectAgents.getLaunchOptionsFor(CWD), { nativeScrollback: true });
  projectAgents.setAgentFor(CWD, null);
  assert.strictEqual(projectAgents.getAgentFor(CWD), null);
  assert.deepStrictEqual(projectAgents.getLaunchOptionsFor(CWD), { nativeScrollback: true });
  projectAgents.removeCwd(CWD);
  projectAgents.setLaunchOptionFor(CWD, 'nativeScrollback', null);
  fs.unlinkSync(projectsFile);
});

test('effectiveLaunchOptions: project override beats the Settings default', () => {
  const { effectiveLaunchOptions } = projectAgents;
  assert.deepStrictEqual(effectiveLaunchOptions({ nativeScrollback: false }, {}), { nativeScrollback: false });
  assert.deepStrictEqual(effectiveLaunchOptions({ nativeScrollback: false }, { nativeScrollback: true }), { nativeScrollback: true });
  assert.deepStrictEqual(effectiveLaunchOptions({ nativeScrollback: true }, { nativeScrollback: false }), { nativeScrollback: false });
  assert.deepStrictEqual(effectiveLaunchOptions(undefined, undefined), {});
  // Non-boolean junk from a hand-edited file never counts as "on"
  assert.deepStrictEqual(effectiveLaunchOptions({ nativeScrollback: 'yes' }, { nativeScrollback: 1 }), {});
});

test('end to end: Settings default + project override → PTY env', () => {
  const defaults = DEFAULT_SETTINGS.agentLaunchOptions.claude;
  const inherit = agents.resolveLaunchEnv('claude', projectAgents.effectiveLaunchOptions(defaults, {}));
  assert.strictEqual(NATIVE_SCROLLBACK_ENV in inherit, false);
  const overridden = agents.resolveLaunchEnv(
    'claude',
    projectAgents.effectiveLaunchOptions(defaults, { nativeScrollback: true })
  );
  assert.strictEqual(overridden[NATIVE_SCROLLBACK_ENV], '1');
});
