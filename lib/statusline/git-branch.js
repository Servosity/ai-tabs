const { execFile } = require('child_process');

/**
 * Cached, non-blocking git branch lookup. Returns the last known branch
 * immediately (null before the first probe resolves) and refreshes in the
 * background at most once per TTL per cwd — the statusline tick must never
 * wait on a subprocess.
 */

const TTL_MS = 10_000;
const cache = new Map(); // cwd → { branch, at, pending }

function getBranch(cwd) {
  if (!cwd) return null;
  const now = Date.now();
  let entry = cache.get(cwd);
  if (entry && (entry.pending || now - entry.at < TTL_MS)) return entry.branch;
  if (!entry) {
    entry = { branch: null, at: 0, pending: false };
    cache.set(cwd, entry);
  }
  entry.pending = true;
  execFile('git', ['-C', cwd, 'branch', '--show-current'],
    { timeout: 1500, windowsHide: true }, (err, stdout) => {
      entry.branch = err ? null : (String(stdout).trim() || null);
      entry.at = Date.now();
      entry.pending = false;
    });
  return entry.branch;
}

module.exports = { getBranch };
