/**
 * OS-native desktop notifications for tabs that need attention.
 *
 * The decision ("should this title change raise a notification?") is a pure
 * function so it can be unit-tested without Electron; the side effect lives in
 * createDesktopNotifier, which takes Electron's Notification class injected.
 *
 * A notification fires at most once per attention episode — the same rising
 * edge (non-idle → idle, past the ConPTY title-flap debounce) that starts a tab
 * flashing. It never fires for a muted tab, and never for the active tab while
 * the window is focused (the user is already looking at it).
 */

// Reasons travel from the Claude Code hook payload (lib/attention-hook.js)
// through the server's {type:'idle'} broadcast into the terminal page, where
// main.js reads them back as window._attentionReason.
const REASON_FINISHED = 'finished';
const REASON_PERMISSION = 'permission';
const REASON_QUESTION = 'question';
const REASON_PLAN = 'plan';

const ATTENTION_REASONS = Object.freeze([
  REASON_FINISHED, REASON_PERMISSION, REASON_QUESTION, REASON_PLAN,
]);

const REASON_BODIES = Object.freeze({
  [REASON_FINISHED]: 'finished and is waiting for you',
  [REASON_PERMISSION]: 'needs your input',
  [REASON_QUESTION]: 'has a question for you',
  [REASON_PLAN]: 'has a plan ready for review',
});

const GENERIC_BODY = 'needs your attention';
const GENERIC_SUBJECT = 'Agent';

/**
 * Map a Claude Code hook payload to an attention reason.
 * @param {{hook_event_name?: string, tool_name?: string}} payload
 * @returns {string|null} one of ATTENTION_REASONS, or null when unknown
 */
function reasonFromHook(payload) {
  if (!payload || typeof payload !== 'object') return null;
  switch (payload.hook_event_name) {
    case 'Stop': return REASON_FINISHED;
    case 'Notification': return REASON_PERMISSION;
    case 'PreToolUse':
      if (payload.tool_name === 'AskUserQuestion') return REASON_QUESTION;
      if (payload.tool_name === 'ExitPlanMode') return REASON_PLAN;
      return null;
    default: return null;
  }
}

/**
 * Should an attention episode raise a desktop notification?
 * @param {object} ctx
 * @param {boolean} ctx.enabled      settings.notifications.desktop
 * @param {boolean} ctx.muted        tab is muted
 * @param {boolean} ctx.active       tab is the window's active tab
 * @param {boolean} ctx.windowFocused the owning window has OS focus
 * @param {boolean} ctx.episodeStart this title change is the debounced rising
 *                                   edge into idle (one per episode)
 * @returns {boolean}
 */
function shouldNotify({ enabled, muted, active, windowFocused, episodeStart }) {
  if (!enabled) return false;
  if (muted) return false;
  if (!episodeStart) return false;
  if (active && windowFocused) return false;
  return true;
}

/**
 * Human-readable notification body.
 * @param {string|null|undefined} reason one of ATTENTION_REASONS or anything else
 * @param {string|null|undefined} agentName e.g. "Claude Code"
 * @returns {string}
 */
function describeAttention(reason, agentName) {
  const subject = (typeof agentName === 'string' && agentName.trim()) ? agentName.trim() : GENERIC_SUBJECT;
  const body = REASON_BODIES[reason] || GENERIC_BODY;
  return `${subject} ${body}`;
}

/**
 * Wrap Electron's Notification so main.js only has to call notify().
 * @param {object} deps
 * @param {typeof import('electron').Notification} deps.Notification
 * @param {(msg: string) => void} [deps.log]
 */
function createDesktopNotifier({ Notification, log = () => {} }) {
  const supported = !!(Notification && typeof Notification.isSupported === 'function' && Notification.isSupported());
  if (!supported) log('[notify] desktop notifications unsupported on this platform');

  /**
   * @param {{title: string, body: string, icon?: string, onClick: () => void}} opts
   * @returns {boolean} true when a notification was shown
   */
  function notify({ title, body, icon, onClick }) {
    if (!supported) return false;
    try {
      const n = new Notification({ title, body, icon, silent: false });
      n.on('click', () => { try { onClick(); } catch (err) { log(`[notify] click handler failed: ${err.message}`); } });
      n.show();
      log(`[notify] shown title=${JSON.stringify(title)} body=${JSON.stringify(body)}`);
      return true;
    } catch (err) {
      log(`[notify] failed: ${err.message}`);
      return false;
    }
  }

  return { notify, supported };
}

module.exports = {
  ATTENTION_REASONS,
  reasonFromHook,
  shouldNotify,
  describeAttention,
  createDesktopNotifier,
};
