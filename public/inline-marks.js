/**
 * Inline marks — click-to-copy boxes over the code blocks and quotes the
 * agent wrote, and the images themselves in blank rows inserted under the
 * line where each image happened. Both are drawn on the terminal's overlay
 * (public/term-overlay.js) so they scroll with the text; positions come
 * from public/inline-match.js.
 *
 * Usage (index.html, terminal mode):
 *   const marks = InlineMarks.create({ term, copy, focusTerminal });
 *   marks.attach(sessionId)     on 'created' / 'attached' (after the scrollback write)
 *   marks.pushSnippet(item)     on {type:'snippet'}
 *   marks.pushImage(item)       on {type:'media'}
 *   marks.removeImage(id)       on {type:'media-removed'}
 *   marks.settled()             on {type:'idle'}: images still on screen get their rows
 */
(function (global) {
  'use strict';

  const SCAN_DEBOUNCE_MS = 400;
  // The Stop hook can beat the reply's last rows to the screen: settle after them.
  const SETTLE_DELAY_MS = 700;
  const PENDING_TTL_MS = 60 * 1000;
  const COPIED_MS = 1200;
  const IMAGE_INDENT_CELLS = 2;  // lines up with the agent's indented output
  const IMAGE_HEADROOM_ROWS = 2; // a tall image still leaves a row or two of text in view
  const IMAGE_PAD_PX = 6;        // space above and below each image
  const UNKNOWN_SIZE_ROWS = 12;  // an image whose dimensions weren't recorded
  // Only an image this fresh is pinned to the agent's current line. Older
  // ones arrive when a restarted server re-reads the transcript, and the
  // current line has nothing to do with them.
  const LIVE_WINDOW_MS = 60 * 1000;
  const KEY_ESCAPE = 'Escape';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function create(opts) {
    const term = opts.term;
    const copy = opts.copy;
    const focusTerminal = opts.focusTerminal || (() => {});
    const fetchFn = opts.fetch || ((url, init) => global.fetch(url, init));
    const match = global.InlineMatch;
    const overlay = global.TermOverlay.create(term);

    let sessionId = null;
    let snippets = [];           // newest first
    let images = [];             // newest first
    const boxes = new Map();     // snippet id → [{marker, mark}]
    const imageRow = new Map();  // image id → marker (live anchor or placed)
    const chips = new Map();     // marker line → {marker, mark}
    const gaps = new Map();      // image line → {anchor, top, parts: [{id, rows}], rows}
    let waitingForScroll = false; // an image line is still on screen, gap not yet inserted
    const pending = new Map();   // snippet id → first seen (ms), until drawn
    const blobUrls = new Map();
    let scanTimer = null;

    // ── Buffer access ──
    function bufferRows() {
      const b = term.buffer.normal;
      const rows = new Array(b.length);
      for (let i = 0; i < b.length; i++) {
        const line = b.getLine(i);
        rows[i] = line ? line.translateToString(true) : '';
      }
      return rows;
    }
    function markerAt(row) {
      const b = term.buffer.normal;
      return term.registerMarker(row - (b.baseY + b.cursorY));
    }
    const live = (m) => m && !m.isDisposed && m.line >= 0;

    // ── Copy boxes ──
    function drawBox(item, range) {
      const marker = markerAt(range.start);
      if (!marker) return null;
      const mark = overlay.add({ marker, x: 0, width: term.cols, height: range.end - range.start + 1 });
      if (!mark) { marker.dispose(); return null; }
      let timer = null;
      const node = mark.element;
      node.classList.add('im-box', item.kind === 'quote' ? 'im-quote' : 'im-code');
      node.title = 'Click to copy';
      const tag = el('span', 'im-tag', 'copy');
      node.append(tag);
      node.addEventListener('mousedown', (e) => e.stopPropagation());
      node.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await copy(item.text);
        tag.textContent = ok ? 'copied' : 'copy failed';
        node.classList.toggle('im-copied', ok);
        clearTimeout(timer);
        timer = setTimeout(() => { tag.textContent = 'copy'; node.classList.remove('im-copied'); }, COPIED_MS);
        focusTerminal();
      });
      return { marker, mark };
    }

    function placeSnippets(rows, list) {
      for (const item of list) {
        const have = (boxes.get(item.id) || []).filter((b) => live(b.marker));
        const taken = new Set(have.map((b) => b.marker.line));
        for (const range of match.findBlocks(rows, item.text)) {
          if (taken.has(range.start)) continue;
          const box = drawBox(item, range);
          if (box) have.push(box);
        }
        boxes.set(item.id, have);
        if (have.length) pending.delete(item.id);
      }
    }

    // ── Image thumbnails ──
    function urlFor(item) {
      return `/api/media/${sessionId}/${encodeURIComponent(item.file)}`;
    }
    async function blobUrl(item) {
      if (blobUrls.has(item.id)) return blobUrls.get(item.id);
      const res = await fetchFn(urlFor(item));
      if (!res.ok) throw new Error(`media ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      blobUrls.set(item.id, url);
      return url;
    }

    /** Pixel size of one terminal cell. */
    function cellSize() {
      const screenEl = term.element && term.element.querySelector('.xterm-screen');
      if (!screenEl || !term.cols || !term.rows) return null;
      return { w: screenEl.clientWidth / term.cols, h: screenEl.clientHeight / term.rows };
    }

    /**
     * Rows an image needs at its own size, shrunk to fit the terminal's
     * width and height like any picture in a conversation.
     */
    function rowsFor(item, cell) {
      if (!item.width || !item.height) return UNKNOWN_SIZE_ROWS;
      const maxW = (term.cols - IMAGE_INDENT_CELLS - 1) * cell.w;
      const maxH = (term.rows - IMAGE_HEADROOM_ROWS) * cell.h;
      const scale = Math.min(1, maxW / item.width, maxH / item.height);
      return Math.max(1, Math.ceil((item.height * scale + IMAGE_PAD_PX) / cell.h));
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
      buf.ydisp = atBottom ? buf.ybase : Math.max(0, buf.ydisp + (buf.ydisp >= at ? n : 0) - trimmed);
      if (core.viewport) core.viewport.syncScrollArea(true);
      term.refresh(0, term.rows - 1);
      return true;
    }

    /** Images grouped by the line their marker sits on, oldest first. */
    function imagesByLine() {
      const byLine = new Map();
      for (const item of [...images].reverse()) {
        const marker = imageRow.get(item.id);
        if (!live(marker)) continue;
        if (!byLine.has(marker.line)) byLine.set(marker.line, []);
        byLine.get(marker.line).push(item);
      }
      return byLine;
    }

    /**
     * Give every image its own blank rows under its line, sized to the
     * picture. A line still on screen waits until it scrolls into
     * scrollback or the agent goes idle (see insertBlankRows), so an image
     * never sits over text.
     */
    function ensureGaps(cell, onScreenOk) {
      waitingForScroll = false;
      const ybase = term.buffer.normal.baseY;
      const byLine = imagesByLine();
      for (const line of [...byLine.keys()].sort((a, b) => b - a)) { // bottom up: inserts don't move lines above
        let gap = gaps.get(line);
        if (gap && !(live(gap.anchor) && gap.anchor.line === line && live(gap.top))) gap = null;
        if (!gap && line >= ybase && !onScreenOk) { waitingForScroll = true; continue; }
        const missing = byLine.get(line).filter((item) => !(gap && gap.parts.some((p) => p.id === item.id)));
        if (!missing.length) continue;
        const parts = missing.map((item) => ({ id: item.id, rows: rowsFor(item, cell) }));
        const at = gap ? gap.top.line + gap.rows : line + 1;
        const n = parts.reduce((sum, p) => sum + p.rows, 0);
        if (!insertBlankRows(at, n, onScreenOk)) continue;
        if (gap) { gap.parts.push(...parts); gap.rows += n; continue; }
        const anchor = markerAt(line);
        const top = markerAt(line + 1);
        if (anchor && top) gaps.set(line, { anchor, top, parts, rows: n });
      }
      // Re-key by current line: earlier inserts moved the gaps below them.
      const rekeyed = [...gaps.values()].filter((g) => live(g.anchor) && live(g.top));
      gaps.clear();
      for (const g of rekeyed) gaps.set(g.anchor.line, g);
    }

    function redrawChips(onScreenOk) {
      for (const chip of chips.values()) { chip.mark.dispose(); chip.marker.dispose(); }
      chips.clear();
      const cell = cellSize();
      if (!cell) return;
      ensureGaps(cell, onScreenOk);
      const byId = new Map(images.map((i) => [i.id, i]));
      for (const [line, gap] of gaps) {
        const parts = gap.parts.filter((p) => byId.has(p.id));
        if (!parts.length) continue;
        const marker = markerAt(gap.top.line);
        if (!marker) continue;
        const mark = overlay.add({
          marker, x: IMAGE_INDENT_CELLS, width: Math.max(1, term.cols - IMAGE_INDENT_CELLS - 1), height: gap.rows,
        });
        if (!mark) { marker.dispose(); continue; }
        const node = mark.element;
        node.classList.add('im-chip');
        node.addEventListener('mousedown', (e) => e.stopPropagation());
        for (const p of parts) node.append(imageFor(byId.get(p.id), p.rows * cell.h));
        chips.set(line, { marker, mark });
      }
    }

    function imageFor(item, heightPx) {
      const box = el('div', 'im-image');
      box.style.height = `${heightPx}px`;
      const img = el('img', 'im-thumb');
      img.alt = item.toolName || 'image';
      img.draggable = false;
      if (item.width) img.style.maxWidth = `min(100%, ${item.width}px)`;
      blobUrl(item).then((u) => { img.src = u; }).catch(() => img.remove());
      img.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(item); });
      box.append(img);
      return box;
    }

    // Lightbox
    const lightbox = el('div', 'im-lightbox');
    lightbox.hidden = true;
    lightbox.tabIndex = -1;
    const lbImg = el('img');
    const lbBar = el('div', 'im-lb-bar');
    const lbMeta = el('span', 'im-lb-meta');
    const lbCopy = el('button', null, 'Copy path');
    const lbOpen = el('button', null, 'Open');
    lbBar.append(lbMeta, lbCopy, lbOpen);
    lightbox.append(lbImg, lbBar);
    let lbItem = null;
    function openLightbox(item) {
      lbItem = item;
      lbImg.removeAttribute('src');
      blobUrl(item).then((u) => { if (lbItem === item) lbImg.src = u; }).catch(() => {});
      const bits = [item.toolName || 'image'];
      if (item.width && item.height) bits.push(`${item.width}×${item.height}`);
      if (item.sourcePath) bits.push(item.sourcePath);
      bits.push(new Date(item.at).toLocaleString());
      lbMeta.textContent = bits.join(' · ');
      lbCopy.hidden = !item.sourcePath;
      lightbox.hidden = false;
      lightbox.focus();
    }
    function closeLightbox() {
      if (lightbox.hidden) return;
      lightbox.hidden = true;
      lbItem = null;
      focusTerminal();
    }
    lightbox.addEventListener('keydown', (e) => {
      if (e.key === KEY_ESCAPE) { e.preventDefault(); e.stopPropagation(); closeLightbox(); }
    });
    lightbox.addEventListener('click', (e) => { if (e.target === lightbox || e.target === lbImg) closeLightbox(); });
    lbCopy.addEventListener('click', () => { if (lbItem && lbItem.sourcePath) copy(lbItem.sourcePath); });
    lbOpen.addEventListener('click', () => { if (lbItem) global.open(urlFor(lbItem), '_blank'); });
    document.body.append(lightbox);

    // ── Scanning ──
    function scan(full, onScreenOk) {
      if (!match || term.buffer.active.type !== 'normal') return;
      const rows = bufferRows();
      const now = Date.now();
      const due = full ? snippets : snippets.filter((s) => pending.has(s.id));
      placeSnippets(rows, due);
      for (const [id, since] of pending) if (now - since > PENDING_TTL_MS) pending.delete(id);
      if (full) {
        const unplaced = images.filter((i) => !live(imageRow.get(i.id)));
        for (const [id, row] of match.placeImages(rows, unplaced)) {
          const marker = markerAt(row);
          if (marker) imageRow.set(id, marker);
        }
      }
      redrawChips(onScreenOk);
      overlay.render();
    }
    function scheduleScan(full) {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => scan(full), SCAN_DEBOUNCE_MS);
    }
    // New output may be the block a pending snippet is waiting for.
    term.onWriteParsed(() => { if (pending.size) scheduleScan(false); });
    // An image line scrolling into scrollback can now get its rows.
    term.onScroll(() => { if (waitingForScroll) scheduleScan(false); });
    // A width change re-wraps rows: redraw everything at the new positions.
    term.onResize(() => { clearAll(false); scheduleScan(true); });

    function clearAll(dropImages) {
      for (const list of boxes.values()) for (const b of list) { b.mark.dispose(); b.marker.dispose(); }
      boxes.clear();
      for (const chip of chips.values()) { chip.mark.dispose(); chip.marker.dispose(); }
      chips.clear();
      if (dropImages) {
        for (const m of imageRow.values()) m.dispose();
        imageRow.clear();
        // The buffer is being rewritten, inserted rows and all.
        for (const g of gaps.values()) { g.anchor.dispose(); g.top.dispose(); }
        gaps.clear();
      }
    }

    // ── Public API ──
    async function attach(id) {
      const changed = id !== sessionId;
      sessionId = id;
      // A (re)attach rewrites the buffer from the replayed scrollback, so
      // every position is new.
      clearAll(true);
      if (changed) {
        for (const url of blobUrls.values()) URL.revokeObjectURL(url);
        blobUrls.clear();
      }
      try {
        const [s, m] = await Promise.all([
          fetchFn(`/api/snippets/${id}`).then((r) => (r.ok ? r.json() : { items: [] })),
          fetchFn(`/api/media/${id}`).then((r) => (r.ok ? r.json() : { items: [] })),
        ]);
        if (sessionId !== id) return;
        snippets = Array.isArray(s.items) ? s.items : [];
        images = Array.isArray(m.items) ? m.items : [];
      } catch {}
      scheduleScan(true);
    }

    function pushSnippet(item) {
      if (!item || typeof item.text !== 'string' || snippets.some((s) => s.id === item.id)) return;
      snippets.unshift(item);
      pending.set(item.id, Date.now());
      scheduleScan(false);
    }

    function pushImage(item) {
      if (!item || !item.id || images.some((i) => i.id === item.id)) return;
      images.unshift(item);
      // Arriving live: it belongs to whatever the agent is showing right now.
      // A re-read of an old transcript goes through placeImages instead.
      const fresh = Date.now() - (item.at || 0) < LIVE_WINDOW_MS;
      if (!fresh) { scheduleScan(true); return; }
      if (match && term.buffer.active.type === 'normal') {
        const rows = bufferRows();
        const b = term.buffer.normal;
        // A line that names the image ("[Image #1]", a screenshot call)
        // beats the agent's current line.
        const named = match.placeImages(rows, [item]).get(item.id);
        const row = named != null ? named : match.liveActivityRow(rows, b.baseY + b.cursorY);
        const marker = row >= 0 ? markerAt(row) : null;
        if (marker) imageRow.set(item.id, marker);
      }
      scheduleScan(false);
    }

    function removeImage(id) {
      images = images.filter((i) => i.id !== id);
      const marker = imageRow.get(id);
      if (marker) marker.dispose();
      imageRow.delete(id);
      const url = blobUrls.get(id);
      if (url) URL.revokeObjectURL(url);
      blobUrls.delete(id);
      if (lbItem && lbItem.id === id) closeLightbox();
      scheduleScan(false);
    }

    /** The agent went idle: images still on screen get their rows now. */
    function settled() {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => {
        if (waitingForScroll) term.write('', () => scan(true, true));
      }, SETTLE_DELAY_MS);
    }

    return { attach, pushSnippet, pushImage, removeImage, settled };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.InlineMarks = api;
})(typeof window !== 'undefined' ? window : null);
