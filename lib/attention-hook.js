const express = require('express');
const { reasonFromHook } = require('./desktop-notify');
const { parseTabSessionId } = require('./command-launch');

/**
 * Attention detection for Claude-family tabs.
 *
 * Claude Code picks its notification channel by sniffing the terminal
 * (Apple_Terminal / iTerm.app / kitty / ghostty); everything else resolves to
 * "no_method_available" and it emits no escape sequence at all. ai-tabs runs
 * xterm.js, so there is nothing on the PTY to watch — OSC-sniffing can never
 * work here, and output quiescence flashes on every pause mid-task.
 *
 * Its hook system fires regardless of the notification channel, so that is the
 * signal ai-tabs uses instead. We subscribe to exactly the events that mean
 * "the human is needed" and deliberately skip SubagentStop/PostToolUse so
 * background agent lifecycle never flashes a tab. A Stop that is only a pause
 * on background subagents, and purely informational notifications, are
 * filtered out too.
 */

// PreToolUse tools that hand control back to the user and then block.
const ATTENTION_TOOLS = Object.freeze(['AskUserQuestion', 'ExitPlanMode']);

// Events that always mean the session is waiting on the user: a finished turn,
// a permission prompt, or Claude's own idle notification.
const ATTENTION_EVENTS = Object.freeze(new Set(['Stop', 'Notification']));

// Notification types that are purely informational — nothing is waiting on the
// user. Anything else (including a missing or future type) still signals.
const SILENT_NOTIFICATION_TYPES = Object.freeze(new Set([
  'auth_success',
  'agent_completed',
  'computer_use_enter',
  'computer_use_exit',
  'quota_auto_resume_fired',
  'quota_auto_resume_stale',
  'quota_auto_resume_disabled',
  'model_refusal_fallback',
]));

const IDLE_NOTIFICATION_TYPE = 'idle_prompt';

// Claude Code ends the turn while background subagents/workflows run, then
// wakes itself when they hand back. These are the Stop payload's
// background_tasks types that do that (mirrors Claude's own "N background
// agents" count); shells and monitors can run forever and never wake it.
const WAKING_TASK_TYPES = Object.freeze(new Set(['subagent', 'workflow']));
const LIVE_TASK_STATUSES = Object.freeze(new Set(['running', 'pending']));

/**
 * Is this Stop only a pause while background agents finish?
 * @param {{background_tasks?: unknown}} payload
 * @returns {boolean}
 */
function isPausedOnBackgroundWork(payload) {
  const tasks = payload.background_tasks;
  if (!Array.isArray(tasks)) return false;
  return tasks.some((t) => t && WAKING_TASK_TYPES.has(t.type) && LIVE_TASK_STATUSES.has(t.status));
}

/**
 * Does this hook payload mean the tab should ask for attention?
 * @param {unknown} payload parsed hook JSON from Claude Code
 * @returns {boolean}
 */
function shouldSignalAttention(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const event = payload.hook_event_name;

  if (event === 'PreToolUse') return ATTENTION_TOOLS.includes(payload.tool_name);
  // Claude sets stop_hook_active when it is resuming *because* of a Stop hook —
  // signalling again would flash the tab for work the user never waited on.
  if (event === 'Stop' && payload.stop_hook_active === true) return false;
  if (event === 'Stop' && isPausedOnBackgroundWork(payload)) return false;
  if (event === 'Notification' && SILENT_NOTIFICATION_TYPES.has(payload.notification_type)) return false;

  return ATTENTION_EVENTS.has(event);
}

/**
 * Build the `hooks` block for the settings file ai-tabs passes to Claude Code
 * via `--settings`.
 * @param {string} forwarderPath absolute path to scripts/attention-forward.js
 * @returns {Record<string, object[]>}
 */
function buildAttentionHooks(forwarderPath) {
  const run = [{ type: 'command', command: `node "${forwarderPath}"` }];
  return {
    Stop: [{ hooks: run }],
    Notification: [{ hooks: run }],
    PreToolUse: [{ matcher: ATTENTION_TOOLS.join('|'), hooks: run }],
  };
}

/**
 * HTTP endpoint the bundled forwarder POSTs each attention hook to.
 * @param {object} opts
 * @param {(id: number) => boolean} opts.isLive session still exists in the PtyManager
 * @param {(id: number, reason: string|null) => void} opts.signal flash the tab
 *   owning this session; reason is a lib/desktop-notify ATTENTION_REASONS value
 *   (or null) describing why, for the desktop notification body
 */
function createAttentionRouter({ isLive, signal }) {
  const router = express.Router();
  // Sessions whose last Stop was a pause on background agents. Claude's 60s
  // idle nag doesn't know about them, so hold it until a real Stop.
  const pausedSessions = new Set();

  router.post('/attention-hook', express.json(), (req, res) => {
    const body = req.body || {};
    const id = parseTabSessionId(body.tabSessionId);
    if (body.hook_event_name === 'Stop' && id !== null) {
      if (isPausedOnBackgroundWork(body)) pausedSessions.add(id);
      else pausedSessions.delete(id);
    }
    const heldIdleNag = body.hook_event_name === 'Notification'
      && body.notification_type === IDLE_NOTIFICATION_TYPE
      && pausedSessions.has(id);
    if (heldIdleNag || !shouldSignalAttention(body)) return res.json({ ok: true, signalled: false });
    if (id === null || !isLive(id)) {
      pausedSessions.delete(id);
      return res.json({ ok: true, signalled: false });
    }
    signal(id, reasonFromHook(body));
    res.json({ ok: true, signalled: true });
  });

  return router;
}

module.exports = {
  shouldSignalAttention,
  buildAttentionHooks,
  createAttentionRouter,
  ATTENTION_TOOLS,
};
