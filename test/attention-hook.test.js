const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const express = require('express');

const {
  shouldSignalAttention,
  buildAttentionHooks,
  createAttentionRouter,
} = require('../lib/attention-hook');
const { ensureHookSettingsFile } = require('../lib/statusline');

// ── Which hook events mean "the user is needed" ──────────────────────────────

test('a finished turn signals attention, a finished subagent does not', () => {
  assert.equal(shouldSignalAttention({ hook_event_name: 'Stop' }), true);
  // The whole point of the earlier subagent fix: background agent lifecycle
  // must never flash the tab.
  assert.equal(shouldSignalAttention({ hook_event_name: 'SubagentStop' }), false);
});

test('a re-entrant Stop does not signal attention twice', () => {
  assert.equal(
    shouldSignalAttention({ hook_event_name: 'Stop', stop_hook_active: true }),
    false,
  );
});

test('questions and plan approvals signal attention, ordinary tools do not', () => {
  for (const tool of ['AskUserQuestion', 'ExitPlanMode']) {
    assert.equal(
      shouldSignalAttention({ hook_event_name: 'PreToolUse', tool_name: tool }),
      true,
      `${tool} should flash the tab`,
    );
  }
  for (const tool of ['Read', 'Bash', 'Task', 'Edit']) {
    assert.equal(
      shouldSignalAttention({ hook_event_name: 'PreToolUse', tool_name: tool }),
      false,
      `${tool} must not flash the tab`,
    );
  }
});

test('permission prompts and idle notifications signal attention', () => {
  assert.equal(
    shouldSignalAttention({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }),
    true,
  );
});

// Claude Code ≥2.1 ends the turn while background subagents run and wakes
// itself when they hand back — that Stop is a pause, not "done".
const bgTask = (type, status) => ({ id: `t-${type}-${status}`, type, status, description: 'x' });

test('a Stop while background subagents or workflows run does not signal attention', () => {
  for (const type of ['subagent', 'workflow']) {
    for (const status of ['running', 'pending']) {
      assert.equal(
        shouldSignalAttention({ hook_event_name: 'Stop', background_tasks: [bgTask(type, status)] }),
        false,
        `${type}/${status} should hold the flash`,
      );
    }
  }
});

test('a Stop signals attention once background agents are done, or only shells/monitors run', () => {
  const cases = [
    [],
    [bgTask('subagent', 'completed'), bgTask('subagent', 'failed'), bgTask('workflow', 'killed')],
    // A dev server or monitor can run forever and never wakes the agent.
    [bgTask('shell', 'running'), bgTask('monitor', 'running')],
    'not-an-array',
  ];
  for (const background_tasks of cases) {
    assert.equal(
      shouldSignalAttention({ hook_event_name: 'Stop', background_tasks }),
      true,
      JSON.stringify(background_tasks),
    );
  }
});

test('informational notification types do not signal attention', () => {
  for (const type of [
    'auth_success', 'agent_completed', 'computer_use_enter', 'computer_use_exit',
    'quota_auto_resume_fired', 'quota_auto_resume_stale', 'quota_auto_resume_disabled',
    'model_refusal_fallback',
  ]) {
    assert.equal(
      shouldSignalAttention({ hook_event_name: 'Notification', notification_type: type }),
      false,
      type,
    );
  }
  for (const type of [
    'permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input',
    'worker_permission_prompt', 'push_notification', undefined, 'some_future_type',
  ]) {
    assert.equal(
      shouldSignalAttention({ hook_event_name: 'Notification', notification_type: type }),
      true,
      String(type),
    );
  }
});

test('unknown and malformed payloads never signal attention', () => {
  for (const payload of [null, undefined, 'Stop', 42, {}, { hook_event_name: 'PostToolUse' }]) {
    assert.equal(shouldSignalAttention(payload), false);
  }
});

// ── The generated hook configuration ─────────────────────────────────────────

test('the hook config subscribes to attention events only, never SubagentStop', () => {
  const hooks = buildAttentionHooks('C:\\ai-tabs\\scripts\\attention-forward.js');
  assert.deepEqual(Object.keys(hooks).sort(), ['Notification', 'PreToolUse', 'Stop']);
  assert.ok(!('SubagentStop' in hooks));
  assert.ok(!('PostToolUse' in hooks));

  const matcher = hooks.PreToolUse[0].matcher;
  assert.match('AskUserQuestion', new RegExp(`^(${matcher})$`));
  assert.doesNotMatch('Read', new RegExp(`^(${matcher})$`));

  // Every subscription runs the forwarder, and the quoted path survives Windows
  // backslashes intact.
  for (const event of Object.values(hooks)) {
    for (const group of event) {
      for (const h of group.hooks) {
        assert.equal(h.type, 'command');
        assert.ok(
          h.command.includes('C:\\ai-tabs\\scripts\\attention-forward.js'),
          `command should invoke the forwarder: ${h.command}`,
        );
      }
    }
  }
});

// ── The HTTP bridge the forwarder posts to ───────────────────────────────────

test('the attention route flashes only live sessions, and only for real signals', async () => {
  const LIVE = 7;
  const flashed = [];
  const app = express();
  app.use('/api', createAttentionRouter({
    isLive: (id) => id === LIVE,
    signal: (id, reason) => { flashed.push(id); reasons.push(reason); },
  }));
  const reasons = [];
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/attention-hook`;

  const post = async (body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    return res.json();
  };

  try {
    // A finished turn on a live session flashes it.
    assert.deepEqual(
      await post({ hook_event_name: 'Stop', tabSessionId: String(LIVE) }),
      { ok: true, signalled: true },
    );
    // A pending question flashes it too — the case OSC sniffing always missed.
    await post({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tabSessionId: LIVE });

    // A subagent finishing must not.
    await post({ hook_event_name: 'SubagentStop', tabSessionId: String(LIVE) });
    // Neither must a session that has already exited, or a missing id.
    await post({ hook_event_name: 'Stop', tabSessionId: '999' });
    await post({ hook_event_name: 'Stop' });

    assert.deepEqual(flashed, [LIVE, LIVE]);
    // The reason rides along so the desktop notification can say what happened.
    assert.deepEqual(reasons, ['finished', 'question']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the idle nag stays quiet while a turn is paused on background agents', async () => {
  const flashed = [];
  const app = express();
  app.use('/api', createAttentionRouter({
    isLive: () => true,
    signal: (id, reason) => flashed.push(`${id}:${reason}`),
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/attention-hook`;
  const post = (body) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
  const running = [{ id: 'a1', type: 'subagent', status: 'running' }];
  const idle = { hook_event_name: 'Notification', notification_type: 'idle_prompt' };

  try {
    // Session 1 pauses on a subagent: no flash, and the 60s idle nag is held.
    await post({ hook_event_name: 'Stop', background_tasks: running, tabSessionId: 1 });
    await post({ ...idle, tabSessionId: 1 });
    // Another session is unaffected.
    await post({ ...idle, tabSessionId: 2 });
    // A real permission prompt still gets through while paused.
    await post({ hook_event_name: 'Notification', notification_type: 'permission_prompt', tabSessionId: 1 });
    // Session 1 truly finishes: flash, and the idle nag works again.
    await post({ hook_event_name: 'Stop', background_tasks: [], tabSessionId: 1 });
    await post({ ...idle, tabSessionId: 1 });

    assert.deepEqual(flashed, ['2:permission', '1:permission', '1:finished', '1:permission']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the bundled forwarder routes a real hook payload to the tab that owns it', async () => {
  const LIVE = 12;
  const flashed = [];
  const app = express();
  app.use('/api', createAttentionRouter({
    isLive: (id) => id === LIVE,
    signal: (id) => flashed.push(id),
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const runHook = (payload, sessionId, tabId) => new Promise((resolve) => {
    const env = { ...process.env, AI_TABS_PORT: String(port), CC_TABS_SESSION_ID: sessionId };
    delete env.AI_TABS_TAB_ID;
    if (tabId !== undefined) env.AI_TABS_TAB_ID = tabId;
    const child = spawn(
      process.execPath,
      [path.join(__dirname, '..', 'scripts', 'attention-forward.js')],
      { env },
    );
    child.stdin.end(JSON.stringify(payload));
    child.on('exit', (code) => resolve(code));
  });

  try {
    assert.equal(await runHook({ hook_event_name: 'Stop' }, String(LIVE)), 0);
    assert.equal(
      await runHook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }, String(LIVE)),
      0,
    );
    assert.equal(await runHook({ hook_event_name: 'SubagentStop' }, String(LIVE)), 0);
    assert.deepEqual(flashed, [LIVE, LIVE], 'Stop and AskUserQuestion flash; SubagentStop does not');

    // Some orchestrators re-export CC_TABS_SESSION_ID as a UUID. One that starts
    // with "12" must not flash tab 12 — AI_TABS_TAB_ID is what routes.
    const uuid = `${LIVE}ab34cd-1111-4222-8333-944455556666`;
    await runHook({ hook_event_name: 'Stop' }, uuid);
    assert.deepEqual(flashed, [LIVE, LIVE], 'a UUID session id is not a tab id');
    await runHook({ hook_event_name: 'Stop' }, uuid, String(LIVE));
    assert.deepEqual(flashed, [LIVE, LIVE, LIVE], 'AI_TABS_TAB_ID routes despite the UUID');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the injected settings file carries the statusline, attention and media hooks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tabs-hooks-'));
  try {
    const file = ensureHookSettingsFile(dir);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(written.statusLine, 'statusline wiring must survive');
    assert.deepEqual(Object.keys(written.hooks).sort(), ['Notification', 'PostToolUse', 'PreToolUse', 'Stop']);
    // PostToolUse belongs to the media panel only — it must point at its own
    // forwarder, never at the attention one (which would flash tabs per tool call).
    for (const group of written.hooks.PostToolUse) {
      for (const h of group.hooks) assert.match(h.command, /media-forward\.js/);
    }
    assert.ok(!('SubagentStop' in written.hooks));

    // Idempotent: a second call must not rewrite identical content.
    const before = fs.statSync(file).mtimeMs;
    ensureHookSettingsFile(dir);
    assert.equal(fs.statSync(file).mtimeMs, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
