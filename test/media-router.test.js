const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const express = require('express');

const { MediaStore, MediaManager, createMediaRouter, buildMediaHooks } = require('../lib/media');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function startApp({ live }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tabs-media-router-'));
  const sent = [];
  const store = new MediaStore(path.join(dir, 'media'), { isLive: (id) => live.has(id) });
  const manager = new MediaManager({
    store,
    isLive: (id) => live.has(id),
    cwdFor: () => dir,
    broadcast: (id, msg) => sent.push({ id, msg }),
  });
  const app = express();
  app.use('/api', createMediaRouter({ manager }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const stop = async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { base, dir, sent, manager, stop, port: server.address().port };
}

const postJson = (url, body) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('the hook route stores images for live sessions, serves them, and pushes a WS message', async () => {
  const live = new Set([5]);
  const ctx = await startApp({ live });
  try {
    const res = await postJson(`${ctx.base}/media-hook`, {
      tabSessionId: '5', toolName: 'Read', toolUseId: 'toolu_1',
      sourcePath: 'C:\\proj\\icon.png',
      images: [{ mime: 'image/png', data: PNG_B64 }],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, stored: 1 });

    assert.equal(ctx.sent.length, 1);
    const { msg } = ctx.sent[0];
    assert.equal(msg.type, 'media');
    assert.equal(msg.sessionId, 5);
    assert.equal(msg.item.toolName, 'Read');
    assert.equal(msg.item.sourcePath, 'C:\\proj\\icon.png');
    assert.equal(msg.item.origin, 'hook');

    const list = await (await fetch(`${ctx.base}/media/5`)).json();
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].id, msg.item.id);

    const img = await fetch(`${ctx.base}/media/5/${msg.item.file}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await img.arrayBuffer()).toString('base64'), PNG_B64);

    // Same bytes again (e.g. the transcript backfill) → nothing new.
    const again = await postJson(`${ctx.base}/media-hook`, {
      tabSessionId: 5, images: [{ mime: 'image/png', data: PNG_B64 }],
    });
    assert.deepEqual(await again.json(), { ok: true, stored: 0 });
    assert.equal(ctx.sent.length, 1);

    // Delete removes the entry and announces it.
    const del = await fetch(`${ctx.base}/media/5/${msg.item.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal((await (await fetch(`${ctx.base}/media/5`)).json()).items.length, 0);
    assert.equal(ctx.sent[1].msg.type, 'media-removed');
  } finally {
    await ctx.stop();
  }
});

test('the hook route rejects dead sessions, bad mimes and traversal attempts', async () => {
  const live = new Set([5]);
  const ctx = await startApp({ live });
  try {
    const dead = await postJson(`${ctx.base}/media-hook`, {
      tabSessionId: 99, images: [{ mime: 'image/png', data: PNG_B64 }],
    });
    assert.equal(dead.status, 400);

    const svg = await postJson(`${ctx.base}/media-hook`, {
      tabSessionId: 5, images: [{ mime: 'image/svg+xml', data: PNG_B64 }],
    });
    assert.equal(svg.status, 400);
    assert.equal(ctx.sent.length, 0);

    // A path import outside the session cwd / temp dir is silently skipped.
    const outside = await postJson(`${ctx.base}/media-hook`, {
      tabSessionId: 5, images: [{ mime: 'image/png', path: 'C:\\Windows\\win.ini' }],
    });
    assert.deepEqual(await outside.json(), { ok: true, stored: 0 });

    // A path inside the cwd is imported.
    const inside = path.join(ctx.dir, 'shot.png');
    fs.writeFileSync(inside, Buffer.from(PNG_B64, 'base64'));
    const imported = await postJson(`${ctx.base}/media-hook`, {
      tabSessionId: 5, toolName: 'Read', images: [{ mime: 'image/png', path: inside }],
    });
    assert.deepEqual(await imported.json(), { ok: true, stored: 1 });

    for (const bad of ['5/..%2Findex.json', '5/..%5C..%5Cpackage.json', 'x/anything.png', '5/index.json']) {
      const res = await fetch(`${ctx.base}/media/${bad}`);
      assert.ok(res.status === 400 || res.status === 404, `${bad} → ${res.status}`);
    }
  } finally {
    await ctx.stop();
  }
});

test('the bundled forwarder posts only when the tool result carries an image', async () => {
  const live = new Set([12]);
  const ctx = await startApp({ live });
  const runHook = (payload, sessionId) => new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, '..', 'scripts', 'media-forward.js')],
      { env: { ...process.env, AI_TABS_PORT: String(ctx.port), CC_TABS_SESSION_ID: sessionId } },
    );
    child.stdin.end(JSON.stringify(payload));
    child.on('exit', (code) => resolve(code));
  });
  try {
    // Text Read → no POST.
    assert.equal(await runHook({
      hook_event_name: 'PostToolUse', tool_name: 'Read',
      tool_input: { file_path: 'C:\\proj\\a.js' }, tool_response: 'const x = 1;',
    }, '12'), 0);
    assert.equal(ctx.sent.length, 0);

    // Image Read (exact shape from the research doc) → stored with its path.
    assert.equal(await runHook({
      hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'toolu_01W6',
      session_id: 'abc', transcript_path: path.join(ctx.dir, 'missing.jsonl'), cwd: ctx.dir,
      tool_input: { file_path: 'C:\\proj\\icon.png' },
      tool_response: { type: 'image', file: { base64: PNG_B64, type: 'image/png', originalSize: 70 } },
    }, '12'), 0);
    assert.equal(ctx.sent.length, 1);
    assert.equal(ctx.sent[0].msg.item.sourcePath, 'C:\\proj\\icon.png');
    assert.equal(ctx.sent[0].msg.item.toolUseId, 'toolu_01W6');

    // MCP screenshot shape (content array with a base64 image block) → stored.
    const gif = Buffer.from('GIF89a\x02\x00\x03\x00\x00\x00\x00', 'binary').toString('base64');
    assert.equal(await runHook({
      hook_event_name: 'PostToolUse', tool_name: 'mcp__claude-in-chrome__computer',
      tool_input: { action: 'screenshot' },
      tool_response: [
        { type: 'text', text: 'Successfully captured screenshot' },
        { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: gif } },
      ],
    }, '12'), 0);
    assert.equal(ctx.sent.length, 2);
    assert.equal(ctx.sent[1].msg.item.toolName, 'mcp__claude-in-chrome__computer');
    assert.equal(ctx.sent[1].msg.item.mime, 'image/gif');

    // Garbage on stdin still exits 0.
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'media-forward.js')],
      { env: { ...process.env, AI_TABS_PORT: String(ctx.port) } });
    child.stdin.end('not json');
    assert.equal(await new Promise((r) => child.on('exit', r)), 0);
  } finally {
    await ctx.stop();
  }
});

test('the media hook config matches Read and MCP tools only', () => {
  const hooks = buildMediaHooks('C:\\ai-tabs\\scripts\\media-forward.js');
  assert.deepEqual(Object.keys(hooks), ['PostToolUse']);
  const re = new RegExp(`^(${hooks.PostToolUse[0].matcher})$`);
  for (const tool of ['Read', 'mcp__claude-in-chrome__computer', 'mcp__playwright__screenshot']) {
    assert.match(tool, re);
  }
  for (const tool of ['Bash', 'Edit', 'Write', 'Task', 'ReadFile']) assert.doesNotMatch(tool, re);
  assert.ok(hooks.PostToolUse[0].hooks[0].command.includes('C:\\ai-tabs\\scripts\\media-forward.js'));
});
