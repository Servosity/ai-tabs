/**
 * Find image blocks inside whatever shape an agent hands us: a Claude Code
 * PostToolUse `tool_response`, a transcript `message.content` array, or an MCP
 * content list. Shared by the hook forwarder (scripts/media-forward.js), the
 * server route and the transcript backfill so every path agrees on what
 * counts as an image. No Node-only APIs beyond Buffer-free string handling, so
 * the forwarder can load it without pulling in express.
 *
 * Recognised shapes (see docs/research/agent-image-capture.md):
 *   { type:'image', file:{ base64, type } }                       Read tool
 *   { type:'image', source:{ type:'base64', media_type, data } }  API / MCP block
 *   { type:'image', data, mimeType }                              raw MCP item
 *   { type:'input_image', image_url:'data:image/png;base64,…' }  Codex (future)
 * Arrays and `{ content: [...] }` wrappers are walked recursively.
 */

const MIME_EXT = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
});

const MAX_WALK_DEPTH = 4;
const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is;

/** Canonical mime or null when not in the whitelist. */
function normalizeMime(value) {
  let mime = String(value || '').toLowerCase().trim();
  if (mime === 'image/jpg') mime = 'image/jpeg';
  return MIME_EXT[mime] ? mime : null;
}

function fromBlock(block) {
  if (!block || typeof block !== 'object') return null;
  if (block.type === 'image') {
    if (block.file && typeof block.file.base64 === 'string') {
      return { mime: block.file.type, data: block.file.base64 };
    }
    if (block.source && typeof block.source.data === 'string') {
      return { mime: block.source.media_type, data: block.source.data };
    }
    if (typeof block.data === 'string') {
      return { mime: block.mimeType || block.mime_type, data: block.data };
    }
    return null;
  }
  if (block.type === 'input_image' && typeof block.image_url === 'string') {
    const m = DATA_URL_RE.exec(block.image_url);
    return m ? { mime: m[1], data: m[2] } : null;
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {{mime: string, data: string}[]} whitelisted images, base64 still encoded
 */
function extractImageBlocks(value, depth = 0) {
  if (depth > MAX_WALK_DEPTH || value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractImageBlocks(item, depth + 1));
  }
  if (typeof value !== 'object') return [];

  const direct = fromBlock(value);
  if (direct) {
    const mime = normalizeMime(direct.mime);
    return mime && direct.data ? [{ mime, data: direct.data }] : [];
  }
  if (Array.isArray(value.content)) {
    return extractImageBlocks(value.content, depth + 1);
  }
  return [];
}

module.exports = { extractImageBlocks, normalizeMime, MIME_EXT };
