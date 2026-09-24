const fs = require('fs');
const { extractImageBlocks } = require('./extract');

/**
 * Incremental image scanner for a Claude Code transcript (JSONL). Reads by
 * byte offset like lib/statusline/tail-reader.js, but only JSON-parses lines
 * that can matter: ones mentioning an image block, or a tool_use (so tool
 * results can be attributed to the tool that produced them). Single lines
 * reach 1 MB+ locally, so skipping the parse for everything else is what
 * keeps a 40 MB backfill cheap.
 *
 * Images are taken from `message.content[*]` only: that covers tool results
 * AND user-pasted images, while the top-level `toolUseResult` is a duplicate
 * copy of the same bytes and is ignored.
 */

const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_TOOL_USE_MAP = 500;
const IMAGE_HINT = '"image"';
const TOOL_USE_HINT = '"tool_use"';
const PASTE_TOOL_NAME = 'paste';

function parseTs(j) {
  const t = Date.parse(j.timestamp || '');
  return Number.isNaN(t) ? null : t;
}

class TranscriptScanner {
  constructor(filePath) {
    this.filePath = filePath;
    this.offset = 0;
    this.remainder = '';
    this.toolNames = new Map(); // tool_use_id → tool name (bounded)
  }

  _remember(id, name) {
    if (!id || !name) return;
    if (this.toolNames.size >= MAX_TOOL_USE_MAP) {
      this.toolNames.delete(this.toolNames.keys().next().value);
    }
    this.toolNames.set(id, name);
  }

  /**
   * Pull images out of one parsed transcript line.
   * @returns {{mime:string, data:string, toolName:string|null, toolUseId:string|null, at:number|null}[]}
   */
  imagesFromLine(j) {
    if (!j || typeof j !== 'object') return [];
    const msg = j.message;
    const content = msg && Array.isArray(msg.content) ? msg.content : null;
    if (!content) return [];
    const at = parseTs(j);
    const out = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use') {
        this._remember(block.id, block.name);
        continue;
      }
      if (block.type === 'tool_result') {
        const toolUseId = block.tool_use_id || null;
        const toolName = this.toolNames.get(toolUseId) || null;
        for (const img of extractImageBlocks(block.content)) {
          out.push({ ...img, toolName, toolUseId, at });
        }
        continue;
      }
      for (const img of extractImageBlocks(block)) {
        // A bare image block on a user turn is a paste; on an assistant turn
        // it is model output (rare) — attribute it to the role.
        const toolName = msg.role === 'user' ? PASTE_TOOL_NAME : (msg.role || null);
        out.push({ ...img, toolName, toolUseId: null, at });
      }
    }
    return out;
  }

  /**
   * Scan bytes appended since the last call. Invokes onImage for each image.
   * Returns bytes consumed, or -1 when the file is gone.
   */
  readNew(onImage) {
    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      return -1;
    }
    if (stat.size < this.offset) {
      this.offset = 0;
      this.remainder = '';
    }
    if (stat.size === this.offset) return 0;

    let fd;
    try {
      fd = fs.openSync(this.filePath, 'r');
    } catch {
      return -1;
    }
    const start = this.offset;
    try {
      const buf = Buffer.alloc(Math.min(CHUNK_SIZE, stat.size - this.offset));
      while (this.offset < stat.size) {
        const want = Math.min(buf.length, stat.size - this.offset);
        const got = fs.readSync(fd, buf, 0, want, this.offset);
        if (got <= 0) break;
        this.offset += got;
        const text = this.remainder + buf.toString('utf8', 0, got);
        const lines = text.split('\n');
        this.remainder = lines.pop();
        for (const line of lines) this._handleLine(line, onImage);
      }
    } finally {
      fs.closeSync(fd);
    }
    return this.offset - start;
  }

  _handleLine(line, onImage) {
    if (!line.includes(IMAGE_HINT) && !line.includes(TOOL_USE_HINT)) return;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    for (const img of this.imagesFromLine(j)) onImage(img);
  }
}

module.exports = { TranscriptScanner, PASTE_TOOL_NAME };
