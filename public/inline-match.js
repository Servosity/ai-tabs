/**
 * Where in the terminal a snippet or image belongs. Pure functions over the
 * buffer's rows (plain strings), so they run under node for tests.
 *
 * Claude Code draws a block quote as rows prefixed "▎" and a code block as
 * indented rows with no fences, both hard-wrapped at the terminal width, and
 * markdown emphasis without its markers. Comparing with all whitespace and
 * those decorations removed makes the rendered rows and the transcript's
 * markdown the same string, whatever the width.
 */
(function (global) {
  'use strict';

  // Whitespace plus glyphs the renderer adds or markdown removes.
  const NOISE_RE = /[\s▎●⎿│*_`]/g;
  const LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
  const MIN_START_CHARS = 4;
  // A block may differ slightly at the end (a link URL the renderer drops);
  // most of it matching from its first row is still the block.
  const MIN_PARTIAL_FRACTION = 0.85;
  const MIN_PARTIAL_CHARS = 40;

  const PASTE_RE = /\[Image #\d+\]/;
  const MCP_RE = /\(MCP\)/;
  const READ_CALL_RE = /\bRead\(/;
  // The line a Read draws: "Read(path)", or Claude Code's collapsed "Read 1 file (ctrl+o to expand)".
  const READ_ROW_RE = /^\s*(?:[●⏺]\s*)?Read(?:\(|\s+\d+\s+files?\b)/;
  const READ_ROW_MAX_UP = 80;  // how far above its pinned row an image's Read line may be
  const READ_ROW_MAX_DOWN = 8; // and below: the image can arrive before its Read line is drawn
  const SPINNER_RE = /^\s*[✻✶✽✢·*]\s/;
  const INPUT_RULE_RE = /^─{8,}/;
  const INPUT_BOX_MAX_ROWS = 6; // rows between the input box's two rules, at most

  function normalize(text) {
    return String(text || '').replace(LINK_RE, '$1').replace(NOISE_RE, '');
  }

  /**
   * Every place the snippet text is drawn, as {start, end} row ranges
   * (inclusive), bottom-most first.
   * @param {string[]} rows buffer rows as plain text
   * @param {string} text snippet source text
   */
  function findBlocks(rows, text) {
    const target = normalize(text);
    if (!target) return [];
    const norm = rows.map(normalize);
    const minStart = Math.min(MIN_START_CHARS, target.length);
    const found = [];
    let floor = rows.length; // rows below this are already claimed
    for (let r = rows.length - 1; r >= 0; r--) {
      const first = norm[r];
      if (first.length < minStart || !target.startsWith(first)) continue;
      let acc = first;
      let last = r;
      for (let k = r + 1; k < floor && acc.length < target.length; k++) {
        if (!norm[k]) continue; // a blank line inside the block
        if (!target.startsWith(acc + norm[k])) break;
        acc += norm[k];
        last = k;
      }
      const whole = acc.length === target.length;
      const mostly = acc.length >= MIN_PARTIAL_CHARS && acc.length >= target.length * MIN_PARTIAL_FRACTION;
      if (whole || mostly) {
        found.push({ start: r, end: last });
        floor = r;
      }
    }
    return found;
  }

  /**
   * The row a live image belongs to: the last line of agent output above
   * the input box, skipping the spinner. -1 when there is no input box.
   */
  function liveActivityRow(rows, cursorRow) {
    let r = Math.min(cursorRow, rows.length - 1);
    while (r >= 0 && !INPUT_RULE_RE.test(rows[r])) r--;
    // The cursor may sit on or below the box's bottom rule: climb to its top one.
    for (let k = r - 1; k >= 0 && k >= r - INPUT_BOX_MAX_ROWS; k--) {
      if (INPUT_RULE_RE.test(rows[k])) { r = k; break; }
    }
    for (r--; r >= 0; r--) {
      const t = rows[r];
      if (!t.trim() || SPINNER_RE.test(t) || INPUT_RULE_RE.test(t)) continue;
      return r;
    }
    return -1;
  }

  /**
   * Best-effort rows for images whose live position is unknown (a reload
   * replays the scrollback): pastes pair with "[Image #n]" rows, MCP
   * captures with "(MCP)" rows, newest with bottom-most; a Read only with a
   * row naming its file. Returns Map image id → row.
   * @param {string[]} rows
   * @param {{id:string, toolName:string|null, sourcePath:string|null}[]} images newest first
   */
  function placeImages(rows, images) {
    const placed = new Map();
    const pools = { paste: [], mcp: [] };
    for (let r = rows.length - 1; r >= 0; r--) {
      if (PASTE_RE.test(rows[r])) pools.paste.push(r);
      if (MCP_RE.test(rows[r])) pools.mcp.push(r);
    }
    for (const img of images) {
      const tool = img.toolName || '';
      if (tool === 'paste' && pools.paste.length) placed.set(img.id, pools.paste.shift());
      else if (tool.startsWith('mcp__') && pools.mcp.length) placed.set(img.id, pools.mcp.shift());
      else if (img.sourcePath) {
        const base = img.sourcePath.split(/[\\/]/).pop();
        for (let r = rows.length - 1; r >= 0; r--) {
          if (base && READ_CALL_RE.test(rows[r]) && rows[r].includes(base)) { placed.set(img.id, r); break; }
        }
      }
    }
    return placed;
  }

  /**
   * The Read line an image belongs under; -1 when none. An image is pinned
   * to the agent's bottom row when it arrives, which is usually just before
   * its Read line is drawn (so the line is a few rows below), but the agent
   * may also draw other text on that row later (so the line is above). The
   * first Read row within READ_ROW_MAX_DOWN rows below, else the nearest
   * within READ_ROW_MAX_UP above; rows in `claimed` hold another image.
   * @param {string[]} rows
   * @param {number} row
   * @param {Set<number>} [claimed]
   */
  function readRowFor(rows, row, claimed) {
    const free = (r) => READ_ROW_RE.test(rows[r]) && !(claimed && claimed.has(r));
    for (let r = Math.max(row, 0); r < rows.length && r <= row + READ_ROW_MAX_DOWN; r++) {
      if (free(r)) return r;
    }
    for (let r = Math.min(row, rows.length) - 1; r >= 0 && r >= row - READ_ROW_MAX_UP; r--) {
      if (free(r)) return r;
    }
    return -1;
  }

  /**
   * The screen row (0-based) a control sequence sends the cursor to, when it
   * may be above where it is; null when the sequence moves it no higher.
   * The agent redraws what it still owns by moving the cursor up to it, so
   * this is the highest row a write is about to touch.
   * @param {string} final the CSI final byte ('A' CUU, 'F' CPL, 'H'/'f' CUP,
   *   'd' VPA, 'J' ED) or 'M' (ESC M, reverse index), '8'/'u' (restore cursor)
   * @param {number[]} params the sequence's numeric parameters (0 or missing = default)
   * @param {number} cursorY the cursor's screen row now
   * @param {number} [savedY] the row saved by ESC 7 / CSI s
   */
  function cursorTargetRow(final, params, cursorY, savedY) {
    const p0 = params && params.length && params[0] > 0 ? params[0] : 0;
    switch (final) {
      case 'A': case 'F': return Math.max(0, cursorY - Math.max(1, p0));
      case 'M': return Math.max(0, cursorY - 1);
      case 'H': case 'f': case 'd': return Math.max(1, p0) - 1;
      case 'J': return p0 === 1 || p0 === 2 || p0 === 3 ? 0 : null; // erase above, or all
      case '8': case 'u': return savedY == null ? null : savedY;
      default: return null;
    }
  }

  const api = { normalize, findBlocks, liveActivityRow, placeImages, readRowFor, cursorTargetRow };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.InlineMatch = api;
})(typeof window !== 'undefined' ? window : null);
