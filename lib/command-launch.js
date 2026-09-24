/**
 * Tabs opened with a raw `command` (the /api/open-tab path used by
 * external orchestrators) instead of a registry agent.
 *
 * When that command starts Claude Code, the tab should behave like a normal
 * Claude tab: no output-quiescence flashing (it fires on every pause) and the
 * ai-tabs hook settings so attention comes from Claude's own hooks.
 *
 * Orchestrators also re-export CC_TABS_SESSION_ID with their own UUID, so hook
 * forwarders route by AI_TABS_TAB_ID first, and ids are parsed strictly — a
 * UUID like "3e4f…" must never parse to tab 3.
 */

// Set on every PTY alongside CC_TABS_SESSION_ID; nothing else writes it.
const TAB_ID_ENV = 'AI_TABS_TAB_ID';

const TAB_ID_RE = /^\d+$/;

// `claude` as a command word: at the start, or after a shell separator.
const CLAUDE_INVOCATION_RE = /(^|[;&|]\s*)claude(?=\s|$)/;

const SETTINGS_FLAG_RE = /(^|\s)--settings(\s|=)/;

/**
 * @param {unknown} raw tabSessionId from a hook payload
 * @returns {number|null}
 */
function parseTabSessionId(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  return TAB_ID_RE.test(text) ? parseInt(text, 10) : null;
}

/**
 * @param {unknown} command shell line typed into the tab
 * @returns {boolean}
 */
function commandLaunchesClaude(command) {
  return typeof command === 'string' && CLAUDE_INVOCATION_RE.test(command);
}

/**
 * Add ai-tabs' `--settings` flag to the claude invocation in `command`.
 * Left unchanged when there is no flag, no claude, or the command already
 * passes its own --settings (Claude takes one; the caller's wins).
 * @param {string} command
 * @param {string} flag e.g. ` --settings "C:\...\hooks.json"` (leading space)
 * @returns {string}
 */
function withHookSettings(command, flag) {
  if (!flag || !commandLaunchesClaude(command) || SETTINGS_FLAG_RE.test(command)) return command;
  return command.replace(CLAUDE_INVOCATION_RE, (match) => `${match}${flag}`);
}

module.exports = {
  TAB_ID_ENV,
  parseTabSessionId,
  commandLaunchesClaude,
  withHookSettings,
};
