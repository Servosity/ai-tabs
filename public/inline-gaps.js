/**
 * Inline gaps: the blank rows spliced into the terminal's buffer under the
 * line an image came from, for public/inline-marks.js to draw the image in.
 * Uses xterm internals, which is why it is all in one place.
 *
 * Usage:
 *   const gaps = InlineGaps.create({ term, match, log, onForget });
 *   gaps.open(byLine, rowsFor, onScreenOk)  image line → items; rows for each
 *   gaps.values() / gaps.entries()          line → {anchor, top, parts: [{id, rows}], rows}
 *   gaps.waiting                            an image line has no rows yet
 *   gaps.dropOverwritten()                  after each write is parsed
 *   gaps.markExposed()                      when something else moved the rows
 *   gaps.clear()                            the buffer is being rewritten
 *   onForget(line)                          a gap is gone: drop what's drawn on it
 *
 * A gap opened on screen is only safe until the agent redraws above it: it
 * moves the cursor up by the rows it last drew and writes them again, and
 * rows it did not draw would put its text in the gap, under the image. So a
 * write that sends the cursor to or above a gap on screen first closes the
 * gap (the screen is as the agent left it again); the image waits for its
 * line to reach scrollback, where the agent can't reach. Whatever else
 * writes into a gap (a move nothing here watches for), the image comes off it
 * as soon as the write is parsed: an image is never drawn over text.
 */
(function (global) {
  'use strict';

  const MAX_LOGGED_TEXT = 40;

  const live = (m) => m && !m.isDisposed && m.line >= 0;

  function create(opts) {
    const term = opts.term;
    const match = opts.match;
    const log = opts.log || (() => {});
    const onForget = opts.onForget || (() => {});

    const gaps = new Map();      // image line → {anchor, top, parts: [{id, rows}], rows, exposed}
    let waitingForScroll = false; // an image line is still on screen, gap not yet inserted

    function markerAt(row) {
      const b = term.buffer.normal;
      return term.registerMarker(row - (b.baseY + b.cursorY));
    }

    /**
     * Splice `n` blank rows into the buffer at absolute row `at`. Rows in
     * scrollback can always grow: the agent can't address those any more.
     * With `onScreen`, `at` may also be on screen, above the cursor's row:
     * the rows above `at` scroll up by `n` and every row from `at` down
     * keeps its place on screen, so the agent's cursor-relative redraws of
     * what is under it (its input box) still land right. Only safe while
     * the agent is idle: it isn't redrawing anything above its input box.
     * Markers below shift on their own (xterm listens to the line list's
     * insert/trim events). Uses xterm internals; returns false if they're
     * not there.
     */
    function insertBlankRows(at, n, onScreen) {
      const core = term._core;
      const buf = core && core.buffers && core.buffers.normal;
      if (!buf || !buf.lines || typeof buf.getBlankLine !== 'function') return false;
      if (at > buf.ybase && !(onScreen && at <= buf.ybase + buf.y)) return false;
      const atBottom = buf.ydisp === buf.ybase;
      const before = buf.lines.length;
      const blanks = [];
      for (let i = 0; i < n; i++) blanks.push(buf.getBlankLine(buf.getNullCell()));
      buf.lines.splice(at, 0, ...blanks);
      const trimmed = before + n - buf.lines.length; // a full scrollback drops its oldest rows
      buf.ybase += n - trimmed;
      // A saved cursor is an absolute row: keep it on the row it was saved on.
      buf.savedY = buf.savedY >= at ? buf.savedY + n - trimmed : Math.max(0, buf.savedY - trimmed);
      buf.ydisp = atBottom ? buf.ybase : Math.max(0, buf.ydisp + (buf.ydisp >= at ? n : 0) - trimmed);
      if (core.viewport) core.viewport.syncScrollArea(true);
      term.refresh(0, term.rows - 1);
      return true;
    }

    /**
     * Take a gap's blank rows out again, undoing insertBlankRows with
     * `onScreen`: the rows above it come back down to where the agent drew
     * them. Its markers go with the rows (xterm disposes markers on deleted
     * lines), the image's chip with them.
     */
    function removeGapRows(gap) {
      const core = term._core;
      const buf = core && core.buffers && core.buffers.normal;
      if (!buf || !buf.lines || !live(gap.top)) return false;
      const at = gap.top.line;
      const n = gap.rows;
      if (at + n > buf.lines.length || buf.lines.length - n < term.rows || buf.ybase < n) return false;
      const atBottom = buf.ydisp === buf.ybase;
      buf.lines.splice(at, n);
      buf.ybase -= n;
      if (buf.savedY >= at) buf.savedY = Math.max(at, buf.savedY - n);
      buf.ydisp = atBottom ? buf.ybase : Math.min(buf.ybase, Math.max(0, buf.ydisp - (buf.ydisp > at ? n : 0)));
      if (core.viewport) core.viewport.syncScrollArea(true);
      term.refresh(0, term.rows - 1);
      return true;
    }

    /** Rows just moved: any gap may have been on screen since the last look. */
    function markGapsExposed() {
      for (const gap of gaps.values()) gap.exposed = true;
    }

    /** Stop tracking a gap: its image waits for its line to reach scrollback. */
    function forgetGap(line, gap) {
      onForget(line);
      if (live(gap.anchor)) gap.anchor.dispose();
      if (live(gap.top)) gap.top.dispose();
      gaps.delete(line);
      waitingForScroll = true;
    }

    /**
     * The agent is about to move its cursor to screen row `target`: close the
     * gaps at or below it, lowest first. Closing one brings the rows above it
     * down onto the screen, gaps among them, so each pass looks again from
     * where everything is now. A gap wholly in scrollback can't be reached.
     */
    function closeGapsReachedBy(target) {
      if (target == null || !gaps.size || term.buffer.active.type !== 'normal') return;
      for (;;) {
        const ybase = term.buffer.normal.baseY;
        const reached = [...gaps.entries()]
          .filter(([, g]) => live(g.top) && g.top.line + g.rows - 1 >= ybase + target)
          .sort((a, b) => b[1].top.line - a[1].top.line);
        if (!reached.length) return;
        const [line, gap] = reached[0];
        const at = gap.top.line;
        const closed = removeGapRows(gap);
        forgetGap(line, gap); // a gap that couldn't close still loses its image: text is coming
        markGapsExposed();
        log('inline-marks', `${closed ? 'closed' : 'gave up on'} gap at ${at} (${gap.rows} rows, ybase ${ybase}): the agent redraws from screen row ${target}`);
      }
    }

    /**
     * Text got into a gap after all: take the image off it. Only a gap with
     * rows on screen, now or at the last look, can have been written to: the
     * same write may have scrolled it away again. The rest stay unread, so a
     * long scrollback of images costs nothing per write.
     */
    function dropOverwrittenGaps() {
      if (!gaps.size || term.buffer.active.type !== 'normal') return;
      const b = term.buffer.normal;
      for (const [line, gap] of [...gaps]) {
        if (!live(gap.top)) continue;
        const end = gap.top.line + gap.rows;
        const exposed = end > b.baseY;
        if (!exposed && !gap.exposed) continue;
        gap.exposed = exposed;
        for (let r = gap.top.line; r < end; r++) {
          const row = b.getLine(r);
          const text = row ? row.translateToString(true).trim() : '';
          if (!text) continue;
          log('inline-marks', `text in gap at ${gap.top.line} (${gap.rows} rows, ybase ${b.baseY}), screen row ${r - b.baseY}: ${text.slice(0, MAX_LOGGED_TEXT)}`);
          forgetGap(line, gap);
          break;
        }
      }
    }

    // Watch the agent's cursor moves (each handler only looks: returning
    // false lets xterm carry the sequence out as usual).
    function watch(final, params) {
      const b = term.buffer.normal;
      const buf = term._core && term._core.buffers && term._core.buffers.normal;
      const savedRow = buf && buf.savedY != null ? Math.max(0, buf.savedY - b.baseY) : null;
      const target = match.cursorTargetRow(final, params, b.cursorY, savedRow, term.rows);
      if (target != null && target < b.cursorY + 1) closeGapsReachedBy(target);
      return false;
    }
    if (term.parser && match && match.cursorTargetRow) {
      const nums = (params) => Array.from(params || [], (p) => (Array.isArray(p) ? p[0] : p));
      for (const final of ['A', 'F', 'H', 'f', 'd', 'J', 'r']) {
        term.parser.registerCsiHandler({ final }, (params) => watch(final, nums(params)));
      }
      term.parser.registerCsiHandler({ final: 'u' }, () => watch('u', []));
      term.parser.registerEscHandler({ final: '8' }, () => watch('8', []));
      term.parser.registerEscHandler({ final: 'M' }, () => watch('M', []));
    }

    /**
     * Rows for the images in `byLine` (image line → items, oldest first). A
     * line still on screen waits until it scrolls into scrollback or the agent
     * goes idle (`onScreenOk`, see insertBlankRows), so an image never sits
     * over text.
     */
    function open(byLine, rowsFor, onScreenOk) {
      waitingForScroll = false;
      const ybase = term.buffer.normal.baseY;
      for (const line of [...byLine.keys()].sort((a, b) => b - a)) { // bottom up: inserts don't move lines above
        let gap = gaps.get(line);
        if (gap && !(live(gap.anchor) && gap.anchor.line === line && live(gap.top))) gap = null;
        if (!gap && line >= ybase && !onScreenOk) { waitingForScroll = true; continue; }
        const missing = byLine.get(line).filter((item) => !(gap && gap.parts.some((p) => p.id === item.id)));
        if (!missing.length) continue;
        const parts = missing.map((item) => ({ id: item.id, rows: rowsFor(item) }));
        const at = gap ? gap.top.line + gap.rows : line + 1;
        const n = parts.reduce((sum, p) => sum + p.rows, 0);
        if (!insertBlankRows(at, n, onScreenOk)) continue;
        if (gap) { gap.parts.push(...parts); gap.rows += n; continue; }
        const anchor = markerAt(line);
        const top = markerAt(line + 1);
        if (anchor && top) gaps.set(line, { anchor, top, parts, rows: n });
        if (anchor && top && line >= ybase) log('inline-marks', `opened gap at ${line + 1} (${n} rows) on screen, ybase ${ybase}`);
      }
      // Re-key by current line: earlier inserts moved the gaps below them.
      const rekeyed = [...gaps.values()].filter((g) => live(g.anchor) && live(g.top));
      gaps.clear();
      for (const g of rekeyed) gaps.set(g.anchor.line, g);
    }

    function clear() {
      for (const g of gaps.values()) { g.anchor.dispose(); g.top.dispose(); }
      gaps.clear();
    }

    return {
      open,
      clear,
      markerAt,
      dropOverwritten: dropOverwrittenGaps,
      markExposed: markGapsExposed,
      values: () => gaps.values(),
      entries: () => gaps.entries(),
      get waiting() { return waitingForScroll; },
    };
  }

  const api = { create, live };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.InlineGaps = api;
})(typeof window !== 'undefined' ? window : null);
