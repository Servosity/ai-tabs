const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { checkForUpdate, applyUpdate, needsNpmInstall, isLockfileOnlyChurn } = require('../lib/auto-update');

test('isLockfileOnlyChurn accepts only a lone modified lockfile', () => {
  assert.strictEqual(isLockfileOnlyChurn('M package-lock.json'), true);
  assert.strictEqual(isLockfileOnlyChurn(' M package-lock.json'), true);
  assert.strictEqual(isLockfileOnlyChurn('MM package-lock.json'), true);
  assert.strictEqual(isLockfileOnlyChurn('M package-lock.json\n M package.json'), false);
  assert.strictEqual(isLockfileOnlyChurn('M app.js'), false);
  assert.strictEqual(isLockfileOnlyChurn('?? package-lock.json'), false);
  assert.strictEqual(isLockfileOnlyChurn('D package-lock.json'), false);
  assert.strictEqual(isLockfileOnlyChurn(''), false);
});

test('needsNpmInstall flags dependency files only', () => {
  assert.strictEqual(needsNpmInstall(['main.js', 'lib/agents.js']), false);
  assert.strictEqual(needsNpmInstall(['package.json']), true);
  assert.strictEqual(needsNpmInstall(['server.js', 'package-lock.json']), true);
  assert.strictEqual(needsNpmInstall(['docs/package.json.md']), false);
  assert.strictEqual(needsNpmInstall([]), false);
});

// ── Integration against real throwaway git repos ──

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** origin repo with one commit on master + a clone tracking it */
function makeRepos(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tabs-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const origin = path.join(root, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '-b', 'master');
  git(origin, 'config', 'user.email', 'test@test');
  git(origin, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(origin, 'app.js'), 'v1\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-m', 'v1');

  const clone = path.join(root, 'clone');
  git(root, 'clone', origin, clone);
  git(clone, 'config', 'user.email', 'test@test');
  git(clone, 'config', 'user.name', 'test');
  return { origin, clone };
}

function commitToOrigin(origin, file, content) {
  fs.writeFileSync(path.join(origin, file), content);
  git(origin, 'add', '.');
  git(origin, 'commit', '-m', `update ${file}`);
}

test('checkForUpdate reports up to date when nothing changed', async (t) => {
  const { clone } = makeRepos(t);
  const res = await checkForUpdate(clone);
  assert.strictEqual(res.behind, 0);
  assert.match(res.reason, /up to date/);
});

test('checkForUpdate sees new origin commits', async (t) => {
  const { origin, clone } = makeRepos(t);
  commitToOrigin(origin, 'app.js', 'v2\n');
  const res = await checkForUpdate(clone);
  assert.strictEqual(res.behind, 1);
  assert.ok(res.from && res.to && res.from !== res.to);
});

test('checkForUpdate skips on a dirty working tree', async (t) => {
  const { origin, clone } = makeRepos(t);
  commitToOrigin(origin, 'app.js', 'v2\n');
  fs.writeFileSync(path.join(clone, 'app.js'), 'local edit\n');
  const res = await checkForUpdate(clone);
  assert.strictEqual(res.behind, 0);
  assert.match(res.reason, /local changes/);
});

/** clone with a committed lockfile, a pending origin commit, and npm-style churn */
function makeChurnedRepos(t) {
  const repos = makeRepos(t);
  commitToOrigin(repos.origin, 'package-lock.json', '{}\n');
  git(repos.clone, 'pull', '-q');
  commitToOrigin(repos.origin, 'app.js', 'v2\n');
  fs.writeFileSync(path.join(repos.clone, 'package-lock.json'), '{"churn":true}\n');
  return repos;
}

test('checkForUpdate discards lone lockfile churn and still updates', async (t) => {
  const { clone } = makeChurnedRepos(t);
  const res = await checkForUpdate(clone);
  assert.strictEqual(res.behind, 1);
  assert.strictEqual(git(clone, 'status', '--porcelain'), '');
});

test('checkForUpdate keeps a lockfile changed alongside other edits', async (t) => {
  const { clone } = makeChurnedRepos(t);
  fs.writeFileSync(path.join(clone, 'app.js'), 'local edit\n');
  const res = await checkForUpdate(clone);
  assert.strictEqual(res.behind, 0);
  assert.match(res.reason, /local changes/);
  assert.match(fs.readFileSync(path.join(clone, 'package-lock.json'), 'utf8'), /churn/);
});

test('checkForUpdate skips off-master branches', async (t) => {
  const { clone } = makeRepos(t);
  git(clone, 'checkout', '-b', 'feature');
  const res = await checkForUpdate(clone);
  assert.strictEqual(res.behind, 0);
  assert.match(res.reason, /branch feature/);
});

test('applyUpdate fast-forwards and skips npm when deps are untouched', async (t) => {
  const { origin, clone } = makeRepos(t);
  commitToOrigin(origin, 'app.js', 'v2\n');
  assert.strictEqual((await checkForUpdate(clone)).behind, 1);

  const statuses = [];
  const res = await applyUpdate(clone, { onStatus: s => statuses.push(s) });
  assert.strictEqual(res.updated, true);
  assert.strictEqual(res.depsInstalled, false);
  // autocrlf may rewrite line endings on checkout — compare content only
  assert.strictEqual(fs.readFileSync(path.join(clone, 'app.js'), 'utf8').replace(/\r/g, ''), 'v2\n');
  assert.ok(statuses.length > 0);
});
