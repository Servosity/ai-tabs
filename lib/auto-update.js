// Startup auto-update for source checkouts. Before the first window opens,
// fetch origin and fast-forward onto origin/master, reinstalling dependencies
// only when the pull actually touched them. Everything here fails soft: any
// git error, a dirty tree, a feature branch, or no network just means "start
// the version we already have".
const { execFile, exec } = require('child_process');

const UPDATE_BRANCH = 'master';
const GIT_TIMEOUT_MS = 20_000;
const NPM_TIMEOUT_MS = 10 * 60_000;

// Files whose change means node_modules may be stale. postinstall runs
// electron-rebuild, so this is the expensive path — only take it when needed.
const DEP_FILES = ['package.json', 'package-lock.json'];

function needsNpmInstall(changedFiles) {
  return changedFiles.some(f => DEP_FILES.includes(f.trim()));
}

function git(repoDir, args, timeout = GIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repoDir, timeout, windowsHide: true }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

/**
 * Decide whether an update is available. Resolves to
 * { behind, from, to } when origin/master is ahead of a clean local master,
 * or { behind: 0, reason } when there is nothing to do.
 */
async function checkForUpdate(repoDir) {
  const branch = await git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== UPDATE_BRANCH) return { behind: 0, reason: `on branch ${branch}` };

  const dirty = await git(repoDir, ['status', '--porcelain']);
  if (dirty) return { behind: 0, reason: 'working tree has local changes' };

  // Network call — the only step that costs real time on every launch.
  await git(repoDir, ['fetch', 'origin', UPDATE_BRANCH]);

  const behind = parseInt(await git(repoDir, ['rev-list', '--count', `HEAD..origin/${UPDATE_BRANCH}`]), 10);
  if (!behind) return { behind: 0, reason: 'up to date' };

  const from = await git(repoDir, ['rev-parse', '--short', 'HEAD']);
  const to = await git(repoDir, ['rev-parse', '--short', `origin/${UPDATE_BRANCH}`]);
  return { behind, from, to };
}

/**
 * Fast-forward onto origin/master and reinstall dependencies if the pull
 * changed them. Throws if the merge fails; npm failure also throws so the
 * caller never relaunches into a build with mismatched node_modules.
 */
async function applyUpdate(repoDir, { onStatus = () => {} } = {}) {
  const oldHead = await git(repoDir, ['rev-parse', 'HEAD']);
  onStatus('Downloading update...');
  await git(repoDir, ['merge', '--ff-only', `origin/${UPDATE_BRANCH}`]);

  const changed = (await git(repoDir, ['diff', '--name-only', oldHead, 'HEAD'])).split('\n');
  let depsInstalled = false;
  if (needsNpmInstall(changed)) {
    onStatus('Installing dependencies (this can take a few minutes)...');
    await new Promise((resolve, reject) => {
      // exec (not execFile): npm is npm.cmd on Windows and needs a shell.
      exec('npm install --no-audit --no-fund', { cwd: repoDir, timeout: NPM_TIMEOUT_MS, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(`npm install failed: ${(stderr || err.message).slice(0, 500)}`));
          resolve();
        });
    });
    depsInstalled = true;
  }
  return { updated: true, depsInstalled };
}

module.exports = { checkForUpdate, applyUpdate, needsNpmInstall, UPDATE_BRANCH };
