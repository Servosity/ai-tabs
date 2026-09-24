const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Declarative agent registry. Built-in agents plus user-defined agents merged
 * from data/agents.json (same shape, allowedArgs as an array). Built-ins win
 * id collisions. Adding an agent is a config edit, not a code change.
 */

const USER_AGENTS_FILE = process.env.AI_TABS_AGENTS_FILE
  || path.join(__dirname, '..', 'data', 'agents.json');

// Agent ids appear in URLs, projects.json, and tab state — keep them tame.
const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
// Launch option ids are settings keys and projects.json keys (camelCase ok).
const LAUNCH_OPTION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

const DEFAULT_COLOR = '#888888';

// allowedArgs is the whitelist of CLI flags that may be passed through
// modifier+click / agentArgs URLs — everything else is dropped.
// statusline names the transcript parser (lib/statusline) that can read this
// agent's session files; agents without one get the generic status bar.
const BUILTIN_AGENTS = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    allowedArgs: [
      '--dangerously-skip-permissions',
      '--permission-mode=acceptEdits',
      '--permission-mode=auto',
      '--permission-mode=dontAsk',
      '--permission-mode=plan',
      '--permission-mode=bypassPermissions',
      '--verbose',
      '--no-telemetry',
    ],
    defaultArgs: [],
    bypassArgs: ['--dangerously-skip-permissions'],
    permissionProfiles: [
      { id: 'manual', label: 'Manual', args: [] },
      { id: 'accept-edits', label: 'Accept edits', args: ['--permission-mode=acceptEdits'] },
      { id: 'auto', label: 'Auto', args: ['--permission-mode=auto'] },
      { id: 'dont-ask', label: "Don't ask", args: ['--permission-mode=dontAsk'] },
      { id: 'plan', label: 'Plan', args: ['--permission-mode=plan'] },
      { id: 'bypass', label: 'Bypass permissions', args: ['--permission-mode=bypassPermissions'], dangerous: true, warning: 'Skips Claude Code permission prompts for this session.' },
    ],
    defaultPermissionProfile: 'manual',
    env: { CLAUDECODE: '' }, // cleared so a nested launch doesn't think it's inside CC
    // Opt-in launch switches (Settings default + per-project override in
    // data/projects.json). Each enabled option merges its env into the PTY.
    launchOptions: [
      {
        id: 'nativeScrollback',
        label: 'Use native scrollback (no fullscreen TUI)',
        description: 'Claude Code draws inline instead of taking over the screen, so the tab\'s own scrollback and Ctrl+F search cover the whole session.',
        env: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' },
      },
    ],
    color: '#d97757',
    // Claude picks its notification channel by sniffing the terminal name and
    // resolves to "no_method_available" for xterm.js, so it writes nothing to
    // the PTY — neither channel here can fire. Attention comes from its hook
    // system instead (lib/attention-hook.js). Quiescence stays off: it flashed
    // on every pause in output, including mid-task subagent work.
    detection: {
      oscNotificationCodes: ['2'],
      quiescence: false,
    },
    statusline: 'claude',
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    allowedArgs: [
      '--sandbox=read-only',
      '--sandbox=workspace-write',
      '--sandbox=danger-full-access',
      '--ask-for-approval=on-request',
      '--ask-for-approval=never',
      '--dangerously-bypass-approvals-and-sandbox',
    ],
    defaultArgs: [
      '--sandbox=workspace-write',
      '--ask-for-approval=on-request',
    ],
    bypassArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    permissionProfiles: [
      { id: 'read-only', label: 'Read only', args: ['--sandbox=read-only', '--ask-for-approval=on-request'] },
      { id: 'ask', label: 'Ask for approval', args: ['--sandbox=workspace-write', '--ask-for-approval=on-request', '-c', 'approvals_reviewer=user'] },
      { id: 'approve-for-me', label: 'Approve for me', args: ['--sandbox=workspace-write', '--ask-for-approval=on-request', '-c', 'approvals_reviewer=auto_review'] },
      { id: 'full-access', label: 'Full access', args: ['--sandbox=danger-full-access', '--ask-for-approval=never'], dangerous: true, warning: 'Removes Codex sandbox restrictions and approval prompts.' },
    ],
    defaultPermissionProfile: 'ask',
    env: {},
    color: '#10a37f',
    detection: {},
    statusline: 'codex',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    allowedArgs: [
      '--approval-mode=auto_edit',
      '--approval-mode=plan',
      '--approval-mode=yolo',
      '--sandbox',
    ],
    defaultArgs: [],
    bypassArgs: ['--approval-mode=yolo'],
    permissionProfiles: [
      { id: 'default', label: 'Default', args: [] },
      { id: 'auto-edit', label: 'Auto-edit', args: ['--approval-mode=auto_edit'] },
      { id: 'plan', label: 'Plan', args: ['--approval-mode=plan'] },
      { id: 'yolo', label: 'YOLO', args: ['--approval-mode=yolo'], dangerous: true, warning: 'Automatically approves Gemini tool calls.' },
    ],
    defaultPermissionProfile: 'default',
    env: {},
    color: '#4285f4',
    detection: {},
  },
];

let cache = null; // Map<id, agent> built lazily on first access

function isCommandInstalled(command) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    return spawnSync(probe, [command], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function normalize(entry, { allowPermissionProfiles = false } = {}) {
  return {
    id: entry.id,
    name: entry.name,
    command: entry.command,
    allowedArgs: new Set(Array.isArray(entry.allowedArgs) ? entry.allowedArgs : []),
    defaultArgs: Array.isArray(entry.defaultArgs)
      ? entry.defaultArgs.filter((arg) => typeof arg === 'string')
      : [],
    bypassArgs: Array.isArray(entry.bypassArgs)
      ? entry.bypassArgs.filter((arg) => typeof arg === 'string')
      : [],
    permissionProfiles:
      allowPermissionProfiles && Array.isArray(entry.permissionProfiles)
        ? entry.permissionProfiles.map((profile) => ({
          id: profile.id,
          label: profile.label,
          args: [...profile.args],
          dangerous: profile.dangerous === true,
          warning: typeof profile.warning === 'string' ? profile.warning : '',
        }))
        : [],
    defaultPermissionProfile:
      allowPermissionProfiles && typeof entry.defaultPermissionProfile === 'string'
        ? entry.defaultPermissionProfile
        : null,
    env: (entry.env && typeof entry.env === 'object') ? entry.env : {},
    launchOptions: Array.isArray(entry.launchOptions)
      ? entry.launchOptions
        .filter((opt) => opt && typeof opt.id === 'string' && LAUNCH_OPTION_ID_RE.test(opt.id))
        .map((opt) => ({
          id: opt.id,
          label: typeof opt.label === 'string' ? opt.label : opt.id,
          description: typeof opt.description === 'string' ? opt.description : '',
          env: (opt.env && typeof opt.env === 'object') ? { ...opt.env } : {},
        }))
      : [],
    color: typeof entry.color === 'string' ? entry.color : DEFAULT_COLOR,
    detection: (entry.detection && typeof entry.detection === 'object') ? entry.detection : {},
    statusline: typeof entry.statusline === 'string' ? entry.statusline : null,
    installed: isCommandInstalled(entry.command),
  };
}

function loadUserAgents() {
  try {
    if (!fs.existsSync(USER_AGENTS_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(USER_AGENTS_FILE, 'utf8'));
    if (!Array.isArray(parsed)) {
      console.warn('[agents] agents.json must be an array — ignoring');
      return [];
    }
    return parsed.filter((a) => {
      const ok = a && typeof a === 'object'
        && typeof a.id === 'string' && AGENT_ID_RE.test(a.id)
        && typeof a.name === 'string' && a.name.length > 0
        && typeof a.command === 'string' && a.command.length > 0;
      if (!ok) console.warn('[agents] Skipping invalid agents.json entry:', JSON.stringify(a));
      return ok;
    });
  } catch (err) {
    console.warn('[agents] Could not read agents.json — ignoring:', err.message);
    return [];
  }
}

function buildCache() {
  const byId = new Map();
  for (const agent of BUILTIN_AGENTS) {
    byId.set(agent.id, normalize(agent, { allowPermissionProfiles: true }));
  }
  for (const a of loadUserAgents()) {
    if (!byId.has(a.id)) byId.set(a.id, normalize(a));
  }
  return byId;
}

function getAgents() {
  if (!cache) cache = buildCache();
  return [...cache.values()];
}

function getAgent(id) {
  if (!cache) cache = buildCache();
  return cache.get(id) || null;
}

function refresh() {
  cache = buildCache();
}

function sanitizeArgs(agentId, args) {
  const agent = getAgent(agentId);
  if (!agent || !args) return '';
  return args
    .split(/\s+/)
    .map((arg) => (agent.id === 'gemini' && arg === '--yolo' ? '--approval-mode=yolo' : arg))
    .filter((arg) => agent.allowedArgs.has(arg))
    .join(' ');
}

function resolveLaunchArgs(agentId, args, bypass = false, permissionProfileId = null) {
  const agent = getAgent(agentId);
  if (!agent) return '';

  const explicit = sanitizeArgs(agentId, args).split(/\s+/).filter(Boolean);
  const explicitBypass = explicit.some((arg) => agent.bypassArgs.includes(arg));
  const hasBypassMode = agent.bypassArgs.some((arg) => agent.allowedArgs.has(arg));
  const useBypass = (bypass || explicitBypass) && hasBypassMode;

  if (bypass && !hasBypassMode) {
    console.warn(`[agents] '${agentId}' has no bypass mode — using ordinary defaults`);
  }

  const selectedProfile = agent.permissionProfiles.find(
    (profile) => profile.id === permissionProfileId
  ) || agent.permissionProfiles.find(
    (profile) => profile.id === agent.defaultPermissionProfile
  );

  const profileArgs = selectedProfile ? selectedProfile.args : [];
  const base = useBypass
    ? agent.bypassArgs
    : selectedProfile
      ? profileArgs
      : agent.defaultArgs.filter((arg) => agent.allowedArgs.has(arg));

  const allProfileArgs = new Set(agent.permissionProfiles.flatMap((profile) => profile.args));
  const customBypassConflicts = useBypass && agent.permissionProfiles.length === 0
    ? agent.defaultArgs
    : [];
  const conflicting = new Set([
    ...allProfileArgs,
    ...agent.bypassArgs,
    ...customBypassConflicts,
  ]);

  return [...new Set([
    ...base,
    ...explicit.filter((arg) => !conflicting.has(arg)),
  ])].join(' ');
}

/**
 * PTY env for launching an agent: its base env plus the env of every launch
 * option whose id maps to true in `enabled` ({ nativeScrollback: true }).
 * Unknown option ids are ignored; unknown agents yield {}.
 */
function resolveLaunchEnv(agentId, enabled = {}) {
  const agent = getAgent(agentId);
  if (!agent) return {};
  const env = { ...agent.env };
  const flags = (enabled && typeof enabled === 'object') ? enabled : {};
  for (const opt of agent.launchOptions) {
    if (flags[opt.id] === true) Object.assign(env, opt.env);
  }
  return env;
}

module.exports = {
  getAgents, getAgent, refresh, sanitizeArgs, resolveLaunchArgs, resolveLaunchEnv,
};
