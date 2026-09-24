/**
 * Claude Code hook wiring for the media panel. Rides the same `--settings`
 * file as the attention hooks (lib/attention-hook.js): a PostToolUse entry
 * whose command is scripts/media-forward.js. The forwarder exits without a
 * POST when the tool result carries no image, so the matcher can afford to
 * be broad: Read (image files) and every MCP tool (browser screenshots).
 */

const MEDIA_TOOL_MATCHER = 'Read|mcp__.*';

/**
 * @param {string} forwarderPath absolute path to scripts/media-forward.js
 * @returns {Record<string, object[]>} hooks block fragment
 */
function buildMediaHooks(forwarderPath) {
  return {
    PostToolUse: [{
      matcher: MEDIA_TOOL_MATCHER,
      hooks: [{ type: 'command', command: `node "${forwarderPath}"` }],
    }],
  };
}

module.exports = { buildMediaHooks, MEDIA_TOOL_MATCHER };
