#!/usr/bin/env node
/**
 * Claude Code statusLine → ai-tabs bridge.
 *
 * Claude Code invokes its statusLine command with a JSON payload on stdin
 * (model, workspace, cost.total_cost_usd, context_window, transcript_path).
 * This script forwards that payload to the local ai-tabs server so the
 * per-tab status bar can show authoritative session cost, the exact context
 * window, and the model display name — data the transcript files don't carry.
 *
 * Enable it in ~/.claude/settings.json (use YOUR ai-tabs install path):
 *
 *   {
 *     "statusLine": {
 *       "type": "command",
 *       "command": "node \"C:\\path\\to\\ai-tabs\\scripts\\statusline-forward.js\""
 *     }
 *   }
 *
 * When Claude runs inside an ai-tabs tab, CC_TABS_SESSION_ID (inherited from
 * the tab's PTY) routes the payload to exactly that tab. Outside ai-tabs, or
 * for older sessions, the server falls back to matching by workspace cwd.
 *
 * Prints nothing (ai-tabs renders the status bar) and always exits 0 fast so
 * it never slows Claude Code down — if the server isn't running, the POST
 * just fails silently.
 */

const PORT = process.env.AI_TABS_PORT || 25283;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  payload.tabSessionId = process.env.AI_TABS_TAB_ID || process.env.CC_TABS_SESSION_ID || null;
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/statusline-hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(800),
    });
  } catch {}
  process.exit(0);
});
