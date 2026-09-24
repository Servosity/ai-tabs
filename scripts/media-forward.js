#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook → ai-tabs media panel bridge.
 *
 * ai-tabs registers this script for PostToolUse on `Read|mcp__.*` in the
 * settings file it passes via `--settings` (see lib/media/hooks.js). Claude
 * Code hands the full tool result on stdin — for an image Read or a browser
 * screenshot that includes the inline base64 bytes (verified in
 * docs/research/agent-image-capture.md). This script pulls the image blocks
 * out and POSTs them to the local server, which writes them under data/media/
 * and pushes them to the owning tab.
 *
 * Most matched calls return no image (text Reads, MCP tool calls without a
 * screenshot): those exit immediately with no network traffic. Always exits 0
 * and prints nothing so it can never slow Claude Code down or leak output
 * into the conversation.
 *
 * CC_TABS_SESSION_ID (inherited from the tab's PTY) routes the images to
 * exactly that tab.
 */

const path = require('path');
const { extractImageBlocks } = require(path.join(__dirname, '..', 'lib', 'media', 'extract'));

const PORT = process.env.AI_TABS_PORT || 25283;
const POST_TIMEOUT_MS = 4000;

const chunks = [];
process.stdin.on('data', (chunk) => { chunks.push(chunk); });
process.stdin.on('end', async () => {
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    process.exit(0);
  }
  const images = extractImageBlocks(payload && payload.tool_response);
  if (!images.length) process.exit(0);

  const toolInput = (payload.tool_input && typeof payload.tool_input === 'object') ? payload.tool_input : {};
  const body = {
    tabSessionId: process.env.AI_TABS_TAB_ID || process.env.CC_TABS_SESSION_ID || null,
    agentSessionId: payload.session_id || null,
    transcriptPath: payload.transcript_path || null,
    toolName: payload.tool_name || null,
    toolUseId: payload.tool_use_id || null,
    cwd: payload.cwd || null,
    sourcePath: typeof toolInput.file_path === 'string' ? toolInput.file_path : null,
    images,
  };
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/media-hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch {}
  process.exit(0);
});
