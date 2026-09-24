const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const tmpFile = path.join(os.tmpdir(), `project-agents-test-${process.pid}.json`);
process.env.AI_TABS_PROJECTS_FILE = tmpFile;
const store = require('../lib/project-agents');

const CWD = path.join(os.tmpdir(), 'some-project');

test('getAgentFor returns null when nothing is recorded', () => {
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  assert.strictEqual(store.getAgentFor(CWD), null);
});

test('setAgentFor persists and getAgentFor reads back (path-resolved keys)', () => {
  store.setAgentFor(CWD, 'codex');
  assert.strictEqual(store.getAgentFor(CWD), 'codex');
  // Unnormalized path resolves to the same key
  assert.strictEqual(store.getAgentFor(CWD + path.sep), 'codex');
});

test('recordIfUnset only writes the first time', () => {
  store.setAgentFor(CWD, null);
  store.recordIfUnset(CWD, 'gemini');
  assert.strictEqual(store.getAgentFor(CWD), 'gemini');
  store.recordIfUnset(CWD, 'claude');
  assert.strictEqual(store.getAgentFor(CWD), 'gemini');
});

test('setAgentFor(cwd, null) clears ownership', () => {
  store.setAgentFor(CWD, 'codex');
  store.setAgentFor(CWD, null);
  assert.strictEqual(store.getAgentFor(CWD), null);
});

test('corrupt store file is treated as empty and recovers on next write', () => {
  fs.writeFileSync(tmpFile, '{not json');
  assert.strictEqual(store.getAgentFor(CWD), null);
  store.setAgentFor(CWD, 'claude');
  assert.strictEqual(store.getAgentFor(CWD), 'claude');
  fs.unlinkSync(tmpFile);
});

test('renameCwd moves the agent entry to the new key', () => {
  const NEW_CWD = path.join(os.tmpdir(), 'renamed-project');
  store.setAgentFor(CWD, 'codex');
  store.renameCwd(CWD, NEW_CWD);
  assert.strictEqual(store.getAgentFor(CWD), null);
  assert.strictEqual(store.getAgentFor(NEW_CWD), 'codex');
  store.setAgentFor(NEW_CWD, null);
});

test('renameCwd is a no-op when the old key has no entry', () => {
  const NEW_CWD = path.join(os.tmpdir(), 'renamed-project');
  store.renameCwd(path.join(os.tmpdir(), 'never-recorded'), NEW_CWD);
  assert.strictEqual(store.getAgentFor(NEW_CWD), null);
});

test('removeCwd clears the entry', () => {
  store.setAgentFor(CWD, 'claude');
  store.removeCwd(CWD);
  assert.strictEqual(store.getAgentFor(CWD), null);
});

test('renameCwd with identical old/new path is a no-op, not a delete', () => {
  store.setAgentFor(CWD, 'codex');
  store.renameCwd(CWD, CWD);
  assert.strictEqual(store.getAgentFor(CWD), 'codex');
  store.setAgentFor(CWD, null);
});
