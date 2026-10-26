const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Project roots — the ordered list of folders whose immediate subfolders are
 * launchable projects. Each root carries a label the UI groups under.
 *
 * Precedence (first non-empty wins):
 *   1. settings.projectRoots   — data/settings.json, the source of truth
 *   2. PROJECTS_ROOTS env      — semicolon-separated paths, label = folder name
 *   3. PROJECTS_ROOT env       — one-entry list (legacy)
 *   4. ~/Documents/Projects
 *
 * Every function here is pure over its arguments so the server can re-read
 * roots per request (settings change without a restart) and tests can pass
 * synthetic lists.
 */

const ROOTS_ENV_SEPARATOR = ';';

function defaultRootPath() {
  return path.join(os.homedir(), 'Documents', 'Projects');
}

function labelFor(rootPath) {
  return path.basename(rootPath) || rootPath;
}

/** { label, path } with a resolved absolute path, or null when unusable. */
function normalizeRoot(entry) {
  const raw = typeof entry === 'string' ? { path: entry } : entry;
  if (!raw || typeof raw.path !== 'string' || !raw.path.trim()) return null;
  const resolved = path.resolve(raw.path.trim());
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : labelFor(resolved);
  return { label, path: resolved };
}

/** Drop invalid entries and later duplicates of the same path. */
function normalizeRoots(list) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const root = normalizeRoot(entry);
    if (!root) continue;
    const key = process.platform === 'win32' ? root.path.toLowerCase() : root.path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}

function rootsFromEnv(env) {
  if (typeof env.PROJECTS_ROOTS === 'string' && env.PROJECTS_ROOTS.trim()) {
    const roots = normalizeRoots(env.PROJECTS_ROOTS.split(ROOTS_ENV_SEPARATOR));
    if (roots.length > 0) return roots;
  }
  if (typeof env.PROJECTS_ROOT === 'string' && env.PROJECTS_ROOT.trim()) {
    const roots = normalizeRoots([env.PROJECTS_ROOT]);
    if (roots.length > 0) return roots;
  }
  return [];
}

/**
 * The effective ordered root list.
 * @param {{projectRoots?: unknown}} settings parsed settings.json (or {})
 * @param {NodeJS.ProcessEnv} env
 * @returns {{label:string, path:string}[]} never empty
 */
function resolveProjectRoots(settings = {}, env = process.env) {
  const fromSettings = normalizeRoots(settings && settings.projectRoots);
  if (fromSettings.length > 0) return fromSettings;
  const fromEnv = rootsFromEnv(env);
  if (fromEnv.length > 0) return fromEnv;
  return normalizeRoots([defaultRootPath()]);
}

/** The configured root a path is an immediate child of, or null. */
function rootOfChild(folderPath, roots) {
  const parent = path.dirname(folderPath);
  return roots.find((r) => r.path === parent) || null;
}

/**
 * Validate that cwd is an immediate child of one of the roots.
 * @returns {{ok:true, folderPath:string, name:string, root:{label:string,path:string}} | {ok:false, error:string}}
 */
function resolveProjectChild(cwd, roots) {
  if (!cwd || typeof cwd !== 'string') {
    return { ok: false, error: 'cwd is required' };
  }
  const folderPath = path.resolve(cwd);
  const root = rootOfChild(folderPath, roots);
  if (!root) {
    return { ok: false, error: 'Not a project folder' };
  }
  return { ok: true, folderPath, name: path.basename(folderPath), root };
}

/** The root whose path equals rootPath (resolved), else the first root. */
function pickRoot(rootPath, roots) {
  if (typeof rootPath === 'string' && rootPath.trim()) {
    const wanted = path.resolve(rootPath.trim());
    const found = roots.find((r) => r.path === wanted);
    if (found) return found;
    return null;
  }
  return roots[0];
}

/**
 * Immediate subfolders of every root, in root order, sorted by name within
 * each root. A root that does not exist on disk contributes nothing.
 * @param {{label:string, path:string}[]} roots
 * @param {(cwd:string) => object} [decorate] extra per-project fields
 */
function listProjects(roots, decorate = () => ({})) {
  const out = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root.path, { withFileTypes: true });
    } catch {
      continue;
    }
    const folders = entries
      .filter((e) => e.isDirectory())
      .map((e) => {
        const cwd = path.join(root.path, e.name);
        return { name: e.name, cwd, rootLabel: root.label, rootPath: root.path, ...decorate(cwd) };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    out.push(...folders);
  }
  return out;
}

module.exports = {
  resolveProjectRoots,
  normalizeRoots,
  resolveProjectChild,
  pickRoot,
  listProjects,
  rootOfChild,
  defaultRootPath,
};
