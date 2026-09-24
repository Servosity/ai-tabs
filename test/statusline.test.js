const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ClaudeParser, slugForCwd } = require('../lib/statusline/claude-parser');
const { CodexParser } = require('../lib/statusline/codex-parser');
const { createParser, StatuslineManager, ensureHookSettingsFile } = require('../lib/statusline');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJsonl(file, lines) {
  fs.writeFileSync(file, lines.map(JSON.stringify).join('\n') + '\n');
}

function ts(offsetSec) {
  return new Date(Date.parse('2026-07-21T12:00:00Z') + offsetSec * 1000).toISOString();
}

// ── Claude transcript fixtures ──

function assistantLine(overrides = {}) {
  const { usage, model, ...rest } = overrides;
  return {
    isSidechain: false,
    timestamp: ts(5),
    uuid: 'u-' + Math.random(),
    message: {
      id: 'msg_1',
      role: 'assistant',
      model: model || 'claude-fable-5',
      content: [{ type: 'text', text: 'hello' }],
      usage: usage || {
        input_tokens: 2,
        cache_read_input_tokens: 25000,
        cache_creation_input_tokens: 10000,
        output_tokens: 300,
      },
    },
    ...rest,
  };
}

function userLine(overrides = {}) {
  return {
    isSidechain: false,
    timestamp: ts(0),
    uuid: 'user-' + Math.random(),
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ...overrides,
  };
}

test('slugForCwd matches Claude Code project-dir munging', () => {
  assert.strictEqual(
    slugForCwd('C:\\Users\\Alice\\Documents\\Project\\ai-tabs'),
    'C--Users-Alice-Documents-Project-ai-tabs'
  );
});

test('claude parser: context usage, model, and window from transcript', () => {
  const dir = tmpDir('sl-claude-');
  writeJsonl(path.join(dir, 'abc.jsonl'), [
    userLine(),
    assistantLine(),
  ]);
  const p = new ClaudeParser({ cwd: dir, startTime: Date.now() - 1000, dir });
  const stats = p.poll();
  assert.ok(stats);
  assert.strictEqual(stats.contextUsed, 2 + 25000 + 10000);
  assert.strictEqual(stats.model, 'claude-fable-5');
  assert.strictEqual(stats.contextWindow, 200_000);
  assert.strictEqual(stats.tokensOut, 300);
});

test('claude parser: 1m model id widens the window', () => {
  const dir = tmpDir('sl-claude-');
  writeJsonl(path.join(dir, 'abc.jsonl'), [
    assistantLine({ model: 'claude-sonnet-4-5[1m]' }),
  ]);
  const p = new ClaudeParser({ cwd: dir, startTime: Date.now() - 1000, dir });
  assert.strictEqual(p.poll().contextWindow, 1_000_000);
});

test('claude parser: streaming duplicates dedupe by message id', () => {
  const dir = tmpDir('sl-claude-');
  const line = assistantLine();
  const dup = JSON.parse(JSON.stringify(line));
  dup.uuid = 'different-wrapper-uuid';
  writeJsonl(path.join(dir, 'abc.jsonl'), [line, dup]);
  const p = new ClaudeParser({ cwd: dir, startTime: Date.now() - 1000, dir });
  const stats = p.poll();
  assert.strictEqual(stats.tokensIn, 35002); // counted once, not twice
  assert.strictEqual(stats.tokensOut, 300);
});

test('claude parser: sidechain usage counts toward totals but not the bar', () => {
  const dir = tmpDir('sl-claude-');
  const side = assistantLine({
    isSidechain: true,
    timestamp: ts(60),
    usage: { input_tokens: 100000, output_tokens: 500 },
  });
  side.message.id = 'msg_side';
  writeJsonl(path.join(dir, 'abc.jsonl'), [assistantLine(), side]);
  const p = new ClaudeParser({ cwd: dir, startTime: Date.now() - 1000, dir });
  const stats = p.poll();
  assert.strictEqual(stats.contextUsed, 35002);       // sidechain never wins the bar
  assert.strictEqual(stats.tokensIn, 35002 + 100000); // but is in the cumulative
});

test('claude parser: synthetic and error messages excluded from the bar', () => {
  const dir = tmpDir('sl-claude-');
  const synthetic = assistantLine({ model: '<synthetic>', timestamp: ts(60) });
  synthetic.message.id = 'msg_syn';
  const apiError = assistantLine({ isApiErrorMessage: true, timestamp: ts(70) });
  apiError.message.id = 'msg_err';
  writeJsonl(path.join(dir, 'abc.jsonl'), [assistantLine(), synthetic, apiError]);
  const p = new ClaudeParser({ cwd: dir, startTime: Date.now() - 1000, dir });
  assert.strictEqual(p.poll().contextUsed, 35002);
});

test('claude parser: active time excludes waiting-on-user gaps', () => {
  const dir = tmpDir('sl-claude-');
  const toolResult = {
    isSidechain: false, timestamp: ts(100), uuid: 'tr-1',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
  };
  const a2 = assistantLine({ timestamp: ts(110) });
  a2.message.id = 'msg_2';
  writeJsonl(path.join(dir, 'abc.jsonl'), [
    userLine({ timestamp: ts(0) }),      // t=0
    assistantLine({ timestamp: ts(5) }), // +5s counted (generation)
    toolResult,                          // +95s counted (tool execution)
    a2,                                  // +10s counted
    userLine({ timestamp: ts(200), uuid: 'u-late' }), // +90s NOT counted (waiting on user)
  ]);
  const p = new ClaudeParser({ cwd: dir, startTime: Date.now() - 1000, dir });
  assert.strictEqual(p.poll().activeMs, (5 + 95 + 10) * 1000);
});

test('claude parser: incremental polling picks up appended lines', () => {
  const dir = tmpDir('sl-claude-');
  const file = path.join(dir, 'abc.jsonl');
  writeJsonl(file, [assistantLine()]);
  const p = new ClaudeParser({ cwd: dir, startTime: Date.now() - 1000, dir });
  assert.strictEqual(p.poll().contextUsed, 35002);

  const a2 = assistantLine({
    timestamp: ts(60),
    usage: { input_tokens: 5, cache_read_input_tokens: 60000, cache_creation_input_tokens: 0, output_tokens: 10 },
  });
  a2.message.id = 'msg_2';
  fs.appendFileSync(file, JSON.stringify(a2) + '\n');
  const stats = p.poll();
  assert.strictEqual(stats.contextUsed, 60005);
  assert.strictEqual(stats.tokensIn, 35002 + 60005);
});

test('claude parser: transcripts older than the session are ignored', () => {
  const dir = tmpDir('sl-claude-');
  writeJsonl(path.join(dir, 'old.jsonl'), [assistantLine()]);
  // Session "starts" far in the future relative to the file's mtime
  const p = new ClaudeParser({ cwd: dir, startTime: Date.now() + 10 * 60_000, dir });
  assert.strictEqual(p.poll(), null);
});

// ── Codex rollout fixtures ──

function codexFixture(root, cwd, extraLines = []) {
  const day = path.join(root, '2026', '07', '21');
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, 'rollout-2026-07-21T12-00-00-abc.jsonl');
  writeJsonl(file, [
    { timestamp: ts(0), type: 'session_meta', payload: { id: 'abc', cwd } },
    { timestamp: ts(1), type: 'turn_context', payload: { cwd, model: 'gpt-5-codex' } },
    {
      timestamp: ts(10), type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 40000, cached_input_tokens: 35000, output_tokens: 2000, reasoning_output_tokens: 500, total_tokens: 42000 },
          last_token_usage: { input_tokens: 40000, cached_input_tokens: 35000, output_tokens: 1000, reasoning_output_tokens: 200, total_tokens: 41000 },
          model_context_window: 272000,
        },
      },
    },
    ...extraLines,
  ]);
  return file;
}

test('codex parser: tokens, window, and model from rollout', () => {
  const root = tmpDir('sl-codex-');
  const cwd = tmpDir('sl-codex-cwd-');
  codexFixture(root, cwd);
  const p = new CodexParser({ cwd, startTime: Date.now() - 1000, root });
  const stats = p.poll();
  assert.ok(stats);
  assert.strictEqual(stats.model, 'gpt-5-codex');
  assert.strictEqual(stats.contextWindow, 272000);
  assert.strictEqual(stats.tokensIn, 40000);
  assert.strictEqual(stats.tokensOut, 2000);
  // last_token_usage.total_tokens minus reasoning output
  assert.strictEqual(stats.contextUsed, 41000 - 200);
});

test('codex parser: rollout for a different cwd is not matched', () => {
  const root = tmpDir('sl-codex-');
  codexFixture(root, path.join(os.tmpdir(), 'some-other-project'));
  const p = new CodexParser({ cwd: tmpDir('sl-codex-cwd-'), startTime: Date.now() - 1000, root });
  assert.strictEqual(p.poll(), null);
});

test('codex parser: flat (older) token_count payload still parses', () => {
  const root = tmpDir('sl-codex-');
  const cwd = tmpDir('sl-codex-cwd-');
  const day = path.join(root, '2026', '07', '21');
  fs.mkdirSync(day, { recursive: true });
  writeJsonl(path.join(day, 'rollout-old.jsonl'), [
    { timestamp: ts(0), type: 'session_meta', payload: { id: 'x', cwd } },
    { timestamp: ts(5), type: 'event_msg', payload: { type: 'token_count', input_tokens: 12000, output_tokens: 800, total_tokens: 12800 } },
  ]);
  const p = new CodexParser({ cwd, startTime: Date.now() - 1000, root });
  const stats = p.poll();
  assert.strictEqual(stats.tokensIn, 12000);
  assert.strictEqual(stats.tokensOut, 800);
  assert.strictEqual(stats.contextUsed, 12800);
});

// ── Statusline hook (Claude Code statusLine → ai-tabs bridge) ──

function makeManager(broadcasts) {
  return new StatuslineManager({
    isLive: () => true,
    hasClients: () => true,
    isEnabled: () => true,
    broadcast: (id, stats) => broadcasts.push({ id, stats }),
  });
}

test('applyHook overlays cost/window/model and pins the transcript', () => {
  const dir = tmpDir('sl-hook-');
  const pinnedFile = path.join(dir, 'pinned.jsonl');
  writeJsonl(pinnedFile, [assistantLine()]);
  // A decoy with a newer mtime that the heuristic would otherwise pick
  writeJsonl(path.join(dir, 'decoy.jsonl'), [assistantLine({
    usage: { input_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 0, output_tokens: 1 },
  })]);

  const broadcasts = [];
  const mgr = makeManager(broadcasts);
  mgr.register(7, { agent: { id: 'claude', name: 'Claude Code', color: '#d97757', statusline: 'claude' }, cwd: dir });
  mgr.sessions.get(7).parser = new ClaudeParser({ cwd: dir, startTime: Date.now() - 1000, dir });

  const matched = mgr.applyHook('7', {
    transcript_path: pinnedFile,
    model: { id: 'claude-fable-5', display_name: 'Fable 5' },
    cost: { total_cost_usd: 3.21 },
    context_window: { context_window_size: 200000 },
    workspace: { current_dir: dir },
  });
  assert.strictEqual(matched, 7);

  mgr._tickOne(7, true);
  const { stats } = broadcasts[broadcasts.length - 1];
  assert.strictEqual(stats.provider.costUsd, 3.21);
  assert.strictEqual(stats.provider.model, 'Fable 5');
  assert.strictEqual(stats.provider.contextWindow, 200000);
  assert.strictEqual(stats.provider.contextUsed, 35002); // pinned file, not the decoy
});

test('applyHook falls back to cwd matching when tabSessionId is unknown', () => {
  const dir = tmpDir('sl-hook-cwd-');
  const mgr = makeManager([]);
  mgr.register(1, { agent: null, cwd: dir });
  mgr.register(2, { agent: null, cwd: tmpDir('sl-hook-other-') });
  assert.strictEqual(
    mgr.applyHook(null, { cost: { total_cost_usd: 1 }, workspace: { current_dir: dir } }),
    1
  );
  assert.strictEqual(
    mgr.applyHook('999', { cost: { total_cost_usd: 1 }, workspace: { current_dir: '/nope/nowhere' } }),
    null
  );
});

test('hook overlay synthesizes provider stats for parserless agents', () => {
  const dir = tmpDir('sl-hook-gen-');
  const broadcasts = [];
  const mgr = makeManager(broadcasts);
  mgr.register(3, { agent: { id: 'my-wrapper', name: 'Wrapper', color: '#888' }, cwd: dir });
  mgr.applyHook('3', { cost: { total_cost_usd: 0.5 }, model: { display_name: 'Fable 5' } });
  mgr._tickOne(3, true);
  const { stats } = broadcasts[broadcasts.length - 1];
  assert.strictEqual(stats.provider.costUsd, 0.5);
  assert.strictEqual(stats.provider.model, 'Fable 5');
  assert.strictEqual(stats.provider.contextUsed, null);
});

test('claude parser: pinFile survives quiet periods without rescanning away', () => {
  const dir = tmpDir('sl-pin-');
  const pinned = path.join(dir, 'mine.jsonl');
  writeJsonl(pinned, [assistantLine()]);
  const p = new ClaudeParser({ cwd: dir, startTime: Date.now() - 1000, dir });
  p.pinFile(pinned);
  assert.strictEqual(p.poll().contextUsed, 35002);
  // Newer decoy appears; a pinned parser must not switch to it
  writeJsonl(path.join(dir, 'decoy.jsonl'), [assistantLine({
    usage: { input_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 9 },
  })]);
  p.lastScanAt = 0; // force the rescan window open
  assert.strictEqual(p.poll().contextUsed, 35002);
});

test('codex parser: active time sums task_started→task_complete spans', () => {
  const root = tmpDir('sl-codex-');
  const cwd = tmpDir('sl-codex-cwd-');
  codexFixture(root, cwd, [
    { timestamp: ts(20), type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: ts(50), type: 'event_msg', payload: { type: 'task_complete' } }, // 30s
    { timestamp: ts(60), type: 'event_msg', payload: { type: 'task_started' } },
    { timestamp: ts(75), type: 'event_msg', payload: { type: 'task_complete' } }, // 15s
    { timestamp: ts(90), type: 'event_msg', payload: { type: 'task_started' } },  // aborted — no complete
  ]);
  const p = new CodexParser({ cwd, startTime: Date.now() - 1000, root });
  assert.strictEqual(p.poll().activeMs, 45_000);
});

test('ensureHookSettingsFile writes a --settings file pointing at the forwarder', () => {
  const dataDir = tmpDir('sl-hookset-');
  const file = ensureHookSettingsFile(dataDir);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(parsed.statusLine.type, 'command');
  assert.match(parsed.statusLine.command, /^node ".*statusline-forward\.js"$/s);
  // The quoted forwarder path must exist
  const fwd = parsed.statusLine.command.match(/^node "(.*)"$/s)[1];
  assert.ok(fs.existsSync(fwd), 'forwarder path in settings file exists: ' + fwd);
  // Idempotent — second call returns the same content
  const before = fs.statSync(file).mtimeMs;
  assert.strictEqual(ensureHookSettingsFile(dataDir), file);
  assert.strictEqual(fs.statSync(file).mtimeMs, before);
});

// ── Parser registry ──

test('createParser maps agents to parsers, generic gets none', () => {
  const cwd = os.tmpdir();
  assert.ok(createParser({ id: 'claude', statusline: 'claude' }, cwd, Date.now()) instanceof ClaudeParser);
  assert.ok(createParser({ id: 'codex', statusline: 'codex' }, cwd, Date.now()) instanceof CodexParser);
  // statusline override lets a fork/wrapper agent opt into a parser
  assert.ok(createParser({ id: 'my-claude-fork', statusline: 'claude' }, cwd, Date.now()) instanceof ClaudeParser);
  assert.strictEqual(createParser({ id: 'gemini', statusline: null }, cwd, Date.now()), null);
  assert.strictEqual(createParser(null, cwd, Date.now()), null);
});
