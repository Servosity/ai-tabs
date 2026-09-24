const fs = require('fs');

const CHUNK_SIZE = 4 * 1024 * 1024; // read appended data in 4MB slices

/**
 * Incremental JSONL tail reader. Tracks a byte offset into an append-only
 * file and parses only the lines added since the last read, so polling a
 * multi-hundred-MB transcript costs proportional to what's new, not the
 * whole file. Handles truncation (offset reset) and partial trailing lines.
 */
class TailReader {
  constructor(filePath) {
    this.filePath = filePath;
    this.offset = 0;
    this.remainder = '';
  }

  /**
   * Parse newly appended lines, invoking onLine(obj) per valid JSON line.
   * Returns the number of new bytes consumed, or -1 if the file is gone.
   */
  readNew(onLine) {
    let stat;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      return -1;
    }
    if (stat.size < this.offset) {
      // Truncated/rewritten — start over
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
    const startOffset = this.offset;
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
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          try {
            onLine(JSON.parse(t));
          } catch {}
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    return this.offset - startOffset;
  }
}

module.exports = { TailReader };
