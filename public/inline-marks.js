/**
 * Inline marks — click-to-copy boxes over the code blocks and quotes the
 * agent wrote, and image thumbnails in blank rows inserted under the line
 * where each image happened, drawn in the terminal itself as xterm decorations so they scroll with the
 * text. Positions come from public/inline-match.js.
 *
 * Usage (index.html, terminal mode):
 *   const marks = InlineMarks.create({ term, copy, focusTerminal });
 *   marks.attach(sessionId)     on 'created' / 'attached' (after the scrollback write)
 *   marks.pushSnippet(item)     on {type:'snippet'}
 *   marks.pushImage(item)       on {type:'media'}
 *   marks.removeImage(id)       on {type:'media-removed'}
 */
(function (global) {
  'use strict';

  const SCAN_DEBOUNCE_MS = 400;
  const PENDING_TTL_MS = 60 * 1000;
  const COPIED_MS = 1200;
  const MAX_THUMBS = 4;
  const GAP_ROWS = 3;         // blank rows inserted under an image's line
  const MORE_CELLS = 3;       // the "+N" label
  // Only an image this fresh is pinned to the agent's current line. Older
  // ones arrive when a restarted server re-reads the transcript, and the
  // current line has nothing to do with them.
  const LIVE_WINDOW_MS = 60 * 1000;
  const PREVIEW_MAX_PX = 360;
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

    let sessionId = null;
    let snippets = [];           // newest first
    let images = [];             // newest first
    const boxes = new Map();     // snippet id → [{marker, decoration}]
    const imageRow = new Map();  // image id → marker (live anchor or placed)
    const chips = new Map();     // marker line → {marker, decoration, ids}
    const gaps = new Map();      // image line → {anchor, top} markers of its inserted rows
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
      const decoration = term.registerDecoration({
        marker, x: 0, width: term.cols, height: range.end - range.start + 1, layer: 'top',
      });
      if (!decoration) { marker.dispose(); return null; }
      let timer = null;
      decoration.onRender((node) => {
        if (node.dataset.snippet) return;
        node.dataset.snippet = item.id;
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
      });
      return { marker, decoration };
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

    /** Cells wide the thumbnails take at `height` rows, from each image's shape. */
    function chipCells(list, height, cell) {
      let px = 0;
      for (const item of list) {
        const ratio = item.width && item.height ? item.width / item.height : 1;
        px += height * cell.h * ratio + 3;
      }
      return Math.ceil(px / cell.w);
    }

    /**
     * Splice `n` blank rows into the buffer at absolute row `at`. Only rows
     * already in scrollback: the agent can't address those any more, so
     * growing them never desyncs its cursor. Markers below shift on their
     * own (xterm listens to the line list's insert/trim events). Uses xterm
     * internals; returns false if they're not there.
     */
    function insertBlankRows(at, n) {
      const core = term._core;
      const buf = core && core.buffers && core.buffers.normal;
      if (!buf || !buf.lines || typeof buf.getBlankLine !== 'function') return false;
      if (at > buf.ybase) return false;
      const atBottom = buf.ydisp === buf.ybase;
      const before = buf.lines.length;
      const blanks = [];
      for (let i = 0; i < n; i++) blanks.push(buf.getBlankLine(buf.getNullCell()));
      buf.lines.splice(at, 0, ...blanks);
      const trimmed = before + n - buf.lines.length; // a full scrollback drops its oldest rows
      buf.ybase += n - trimmed;
      buf.ydisp = atBottom ? buf.ybase : Math.max(0, buf.ydisp + (buf.ydisp >= at ? n : 0) - trimmed);
      if (core.viewport) core.viewport.syncScrollArea(true);
      return true;
    }

    /** Image ids grouped by the line their marker sits on. */
    function imagesByLine() {
      const byLine = new Map();
      for (const item of images) {
        const marker = imageRow.get(item.id);
        if (!live(marker)) continue;
        if (!byLine.has(marker.line)) byLine.set(marker.line, []);
        byLine.get(marker.line).push(item);
      }
      return byLine;
    }

    /**
     * Give every image line its own blank rows underneath. A line still on
     * screen waits until it scrolls into scrollback (see insertBlankRows),
     * so a thumbnail never sits over text.
     */
    function ensureGaps() {
      waitingForScroll = false;
      const ybase = term.buffer.normal.baseY;
      for (const line of [...imagesByLine().keys()].sort((a, b) => b - a)) { // bottom up: inserts don't move lines above
        const have = gaps.get(line);
        if (have && live(have.anchor) && have.anchor.line === line && live(have.top)) continue;
        if (line >= ybase) { waitingForScroll = true; continue; }
        if (!insertBlankRows(line + 1, GAP_ROWS)) continue;
        const anchor = markerAt(line);
        const top = markerAt(line + 1);
        if (anchor && top) gaps.set(line, { anchor, top });
      }
      // Re-key by current line: earlier inserts moved the gaps below them.
      const rekeyed = [...gaps.values()].filter((g) => live(g.anchor) && live(g.top));
      gaps.clear();
      for (const g of rekeyed) gaps.set(g.anchor.line, g);
    }

    function redrawChips() {
      for (const chip of chips.values()) { chip.decoration.dispose(); chip.marker.dispose(); }
      chips.clear();
      ensureGaps();
      const cell = cellSize();
      if (!cell) return;
      for (const [line, list] of imagesByLine()) {
        const gap = gaps.get(line);
        if (!gap) continue;
        const shown = list.slice(0, MAX_THUMBS).reverse(); // oldest left
        const extra = list.length > MAX_THUMBS ? MORE_CELLS : 0;
        const cells = Math.min(chipCells(shown, GAP_ROWS, cell) + extra, term.cols - 1);
        const marker = markerAt(gap.top.line);
        if (!marker) continue;
        const decoration = term.registerDecoration({
          marker, anchor: 'right', x: 1, width: cells, height: GAP_ROWS, layer: 'top',
        });
        if (!decoration) { marker.dispose(); continue; }
        decoration.onRender((node) => {
          if (node.dataset.chip) return;
          node.dataset.chip = '1';
          node.classList.add('im-chip');
          node.addEventListener('mousedown', (e) => e.stopPropagation());
          for (const item of shown) node.append(thumbFor(item));
          if (list.length > MAX_THUMBS) node.append(el('span', 'im-more', `+${list.length - MAX_THUMBS}`));
        });
        chips.set(line, { marker, decoration });
      }
    }

    function thumbFor(item) {
      const img = el('img', 'im-thumb');
      img.alt = item.toolName || 'image';
      img.draggable = false;
      blobUrl(item).then((u) => { img.src = u; }).catch(() => img.remove());
      img.addEventListener('mouseenter', () => showPreview(img, item));
      img.addEventListener('mouseleave', hidePreview);
      img.addEventListener('click', (e) => { e.stopPropagation(); hidePreview(); openLightbox(item); });
      return img;
    }

    // Hover preview
    const preview = el('div', 'im-preview');
    preview.hidden = true;
    const previewImg = el('img');
    preview.append(previewImg);
    function showPreview(anchor, item) {
      blobUrl(item).then((u) => {
        previewImg.src = u;
        const r = anchor.getBoundingClientRect();
        preview.hidden = false;
        const top = Math.max(4, Math.min(r.top, global.innerHeight - PREVIEW_MAX_PX - 8));
        preview.style.top = `${top}px`;
        preview.style.right = `${Math.max(4, global.innerWidth - r.left + 6)}px`;
      }).catch(() => {});
    }
    function hidePreview() { preview.hidden = true; }

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
    document.body.append(preview, lightbox);

    // ── Scanning ──
    function scan(full) {
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
      redrawChips();
      // Decorations draw on the next repaint; an idle terminal has none due.
      term.refresh(0, term.rows - 1);
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
      for (const list of boxes.values()) for (const b of list) { b.decoration.dispose(); b.marker.dispose(); }
      boxes.clear();
      for (const chip of chips.values()) { chip.decoration.dispose(); chip.marker.dispose(); }
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

    return { attach, pushSnippet, pushImage, removeImage };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.InlineMarks = api;
})(typeof window !== 'undefined' ? window : null);
