#!/usr/bin/env node
/**
 * Claude Code attention hooks → ai-tabs bridge.
 *
 * Claude Code chooses its notification channel from the terminal it detects
 * (Apple_Terminal / iTerm.app / kitty / ghostty). ai-tabs is an xterm.js
 * terminal, so that lookup falls through to "no_method_available" and Claude
 * emits no bell or OSC sequence at all — there is nothing on the PTY for the
 * prompt detector to see. Hooks, however, fire regardless of channel.
 *
 * ai-tabs registers this script for Stop, Notification, and PreToolUse on the
 * blocking question tools (see lib/attention-hook.js) in the settings file it
 * passes via `--settings`. Each invocation forwards the hook payload to the
 * local server, which flashes that tab. SubagentStop is deliberately not
 * registered, so background agents never flash a tab.
 *
 * CC_TABS_SESSION_ID (inherited from the tab's PTY) routes the signal to
 * exactly that tab. Prints nothing and always exits 0 fast so it never slows
 * Claude Code down — if the server isn't running, the POST just fails silently.
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
    await fetch(`http://127.0.0.1:${PORT}/api/attention-hook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(800),
    });
  } catch {}
  process.exit(0);
});
