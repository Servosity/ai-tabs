const fs = require('fs');
const path = require('path');

/**
 * Per-project agent ownership. Maps a project's resolved cwd to the agent id
 * that launches for it: { "<resolved cwd>": { "agent": "codex" } }.
 * Reads are cheap (file is tiny); corrupt files are treated as empty.
 */

const PROJECTS_FILE = process.env.AI_TABS_PROJECTS_FILE
  || path.join(__dirname, '..', 'data', 'projects.json');

function load() {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
  } catch (err) {
    console.warn('[project-agents] projects.json unreadable — starting fresh:', err.message);
  }
  return {};
}

function save(map) {
  try {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(map, null, 2));
  } catch (err) {
    console.warn('[project-agents] Failed to write projects.json:', err.message);
  }
}

function getAgentFor(cwd) {
  if (!cwd) return null;
  const entry = load()[path.resolve(cwd)];
  return (entry && typeof entry.agent === 'string') ? entry.agent : null;
}

function setAgentFor(cwd, agentId) {
  if (!cwd) return;
  const map = load();
  const key = path.resolve(cwd);
  if (agentId) {
    map[key] = { ...(map[key] || {}), agent: agentId };
  } else {
    // Clearing ownership keeps any per-project launch-option overrides.
    const { agent: _dropped, ...rest } = map[key] || {};
    if (Object.keys(rest).length > 0) map[key] = rest;
    else delete map[key];
  }
  save(map);
}

/**
 * Per-project launch-option overrides: { nativeScrollback: true }. Only keys
 * the user explicitly set are stored; anything else inherits the Settings
 * default (see effectiveLaunchOptions).
 */
function getLaunchOptionsFor(cwd) {
  if (!cwd) return {};
  const entry = load()[path.resolve(cwd)];
  const opts = entry && entry.launchOptions;
  return (opts && typeof opts === 'object' && !Array.isArray(opts)) ? { ...opts } : {};
}

/** value true/false stores an override; null/undefined removes it (inherit). */
function setLaunchOptionFor(cwd, optionId, value) {
  if (!cwd || typeof optionId !== 'string' || !optionId) return;
  const map = load();
  const key = path.resolve(cwd);
  const entry = { ...(map[key] || {}) };
  const opts = { ...(entry.launchOptions || {}) };
  if (value === true || value === false) opts[optionId] = value;
  else delete opts[optionId];
  if (Object.keys(opts).length > 0) entry.launchOptions = opts;
  else delete entry.launchOptions;
  if (Object.keys(entry).length > 0) map[key] = entry;
  else delete map[key];
  save(map);
}

/** Settings defaults overlaid with the project's explicit overrides. */
function effectiveLaunchOptions(defaults, overrides) {
  const out = {};
  for (const source of [defaults, overrides]) {
    if (!source || typeof source !== 'object') continue;
    for (const [id, value] of Object.entries(source)) {
      if (value === true || value === false) out[id] = value;
    }
  }
  return out;
}

function recordIfUnset(cwd, agentId) {
  if (!cwd || !agentId) return;
  if (!getAgentFor(cwd)) setAgentFor(cwd, agentId);
}

function renameCwd(oldCwd, newCwd) {
  if (!oldCwd || !newCwd) return;
  const map = load();
  const oldKey = path.resolve(oldCwd);
  const newKey = path.resolve(newCwd);
  if (newKey === oldKey) return;
  if (!(oldKey in map)) return;
  map[newKey] = map[oldKey];
  delete map[oldKey];
  save(map);
}

function removeCwd(cwd) {
  setAgentFor(cwd, null);
}

module.exports = {
  getAgentFor, setAgentFor, recordIfUnset, renameCwd, removeCwd,
  getLaunchOptionsFor, setLaunchOptionFor, effectiveLaunchOptions,
};
