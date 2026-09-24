/**
 * Media panel — per-tab strip of images the agent read or captured, fed by
 * {type:'media'} WebSocket messages and GET /api/media/:sessionId.
 *
 * Usage (index.html, terminal mode):
 *   const panel = MediaPanel.create({ container, focusTerminal, badge });
 *   panel.attach(sessionId)      on 'created' / 'attached'
 *   panel.push(item)             on {type:'media'}
 *   panel.remove(id)             on {type:'media-removed'}
 *   panel.setBottom(px)          when the statusline shows/hides
 *
 * The panel owns its DOM (appended to <body>), shrinks `container` via
 * style.right so the page's ResizeObserver refits xterm, and reports the
 * number of unseen images through `badge(n)` for the tab bar.
 */
(function (global) {
  'use strict';

  const DEFAULT_WIDTH = 200;
  const MIN_WIDTH = 140;
  const RAIL_WIDTH = 24;
  const MAX_WIDTH_FRACTION = 0.5;
  const LS_WIDTH = 'ai-tabs.media.width';
  const LS_OPEN = 'ai-tabs.media.open';

  const KEY_ESCAPE = 'Escape';
  const KEY_PREV = 'ArrowLeft';
  const KEY_NEXT = 'ArrowRight';

  function lsGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  function fmtTime(ms) {
    const d = new Date(ms);
    const sameDay = new Date().toDateString() === d.toDateString();
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return sameDay ? hm : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
  }
  /** "mcp__claude-in-chrome__computer" → "chrome", "Read" → "read", "paste" → "paste". */
  function toolShort(name) {
    if (!name) return 'image';
    if (name.startsWith('mcp__')) {
      const parts = name.split('__');
      const server = (parts[1] || '').replace(/^claude-in-/, '');
      return server || parts[parts.length - 1] || 'mcp';
    }
    return name.toLowerCase();
  }
  function describe(item) {
    const bits = [item.toolName || 'image'];
    if (item.width && item.height) bits.push(`${item.width}×${item.height}`);
    bits.push(fmtBytes(item.bytes));
    if (item.sourcePath) bits.push(item.sourcePath);
    bits.push(new Date(item.at).toLocaleString());
    return bits.join(' · ');
  }

  function create(opts) {
    const container = opts.container;
    const focusTerminal = opts.focusTerminal || (() => {});
    const badge = opts.badge || (() => {});
    const fetchFn = opts.fetch || ((url, init) => global.fetch(url, init));

    let sessionId = null;
    let items = [];              // newest first
    let open = lsGet(LS_OPEN, true);
    let width = lsGet(LS_WIDTH, DEFAULT_WIDTH);
    let bottom = 0;
    let unseen = 0;
    const seen = new Set();
    const blobUrls = new Map();  // item.id → object URL
    let lightboxIndex = -1;
    let menu = null;

    // ── DOM ──
    const panel = el('div', 'mp-hidden');
    panel.id = 'media-panel';
    const resize = el('div', 'mp-resize');
    const rail = el('div', 'mp-rail');
    rail.title = 'Show images';
    rail.append(el('span', 'mp-rail-icon', '\u{1F5BC}'), el('span', 'mp-rail-count'), el('span', 'mp-rail-label', 'images'));
    const head = el('div', 'mp-head');
    const title = el('span', 'mp-title', 'Images');
    const count = el('span', 'mp-count');
    const size = el('span', 'mp-size');
    const collapseBtn = el('button', 'mp-btn', '›');
    collapseBtn.title = 'Collapse panel';
    head.append(title, count, size, collapseBtn);
    const list = el('div', 'mp-list');
    panel.append(resize, rail, head, list);

    const lightbox = el('div');
    lightbox.id = 'media-lightbox';
    lightbox.hidden = true;
    lightbox.tabIndex = -1;
    const stage = el('div', 'mp-lb-stage');
    const lbImg = el('img');
    stage.append(lbImg);
    const prevBtn = el('button', 'mp-lb-nav mp-lb-prev', '‹');
    const nextBtn = el('button', 'mp-lb-nav mp-lb-next', '›');
    const closeBtn = el('button', 'mp-lb-close', '×');
    closeBtn.title = 'Close (Esc)';
    const bar = el('div', 'mp-lb-bar');
    const lbTitle = el('span');
    const lbMeta = el('span', 'mp-lb-meta');
    const copyBtn = el('button', null, 'Copy path');
    const openBtn = el('button', null, 'Open');
    bar.append(lbTitle, lbMeta, el('span', 'mp-lb-grow'), copyBtn, openBtn);
    lightbox.append(stage, prevBtn, nextBtn, closeBtn, bar);

    document.body.append(panel, lightbox);

    // ── Layout ──
    function clampWidth(w) {
      const max = Math.max(MIN_WIDTH, Math.floor(global.innerWidth * MAX_WIDTH_FRACTION));
      return Math.min(max, Math.max(MIN_WIDTH, Math.round(w)));
    }
    function layout() {
      const visible = items.length > 0;
      panel.classList.toggle('mp-hidden', !visible);
      panel.classList.toggle('mp-collapsed', !open);
      panel.style.width = `${clampWidth(width)}px`;
      panel.style.bottom = `${bottom}px`;
      const right = !visible ? 0 : (open ? clampWidth(width) : RAIL_WIDTH);
      container.style.right = `${right}px`;
    }
    function setOpen(next) {
      open = !!next;
      lsSet(LS_OPEN, open);
      if (open) markAllSeen();
      layout();
      if (!open) focusTerminal();
    }
    function reportBadge() {
      const railCount = rail.querySelector('.mp-rail-count');
      railCount.textContent = unseen > 99 ? '99+' : String(unseen);
      railCount.classList.toggle('mp-has', unseen > 0);
      badge(unseen);
    }
    function markAllSeen() {
      for (const it of items) seen.add(it.id);
      unseen = 0;
      list.querySelectorAll('.mp-thumb.mp-new').forEach((n) => n.classList.remove('mp-new'));
      reportBadge();
    }

    // ── Images ──
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
    function revoke(id) {
      const url = blobUrls.get(id);
      if (url) URL.revokeObjectURL(url);
      blobUrls.delete(id);
    }

    function thumbFor(item) {
      const t = el('div', 'mp-thumb mp-loading');
      t.dataset.id = item.id;
      t.tabIndex = 0;
      t.title = describe(item);
      if (!seen.has(item.id)) t.classList.add('mp-new');
      const img = el('img');
      img.alt = item.toolName || 'image';
      img.draggable = false;
      const cap = el('div', 'mp-cap');
      cap.append(el('span', 'mp-tool', toolShort(item.toolName)), el('span', 'mp-time', fmtTime(item.at)));
      t.append(img, cap);
      blobUrl(item).then((u) => { img.src = u; t.classList.remove('mp-loading'); }).catch(() => t.remove());
      t.addEventListener('click', () => openLightbox(items.findIndex((i) => i.id === item.id)));
      t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); t.click(); } });
      t.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e, item); });
      return t;
    }

    function renderAll() {
      list.innerHTML = '';
      if (!items.length) list.append(el('div', 'mp-empty', 'No images yet'));
      for (const item of items) list.append(thumbFor(item));
      renderHead();
      layout();
    }
    function renderHead() {
      count.textContent = items.length ? String(items.length) : '';
      size.textContent = fmtBytes(items.reduce((n, i) => n + (i.bytes || 0), 0));
    }

    // ── Context menu ──
    function hideMenu() {
      if (menu) menu.remove();
      menu = null;
    }
    function showMenu(e, item) {
      hideMenu();
      menu = el('div', 'mp-menu');
      const add = (label, fn, cls) => {
        const row = el('div', cls, label);
        row.addEventListener('click', () => { hideMenu(); fn(); });
        menu.append(row);
      };
      if (item.sourcePath) add('Copy path', () => copyText(item.sourcePath));
      add('Open in new tab', () => global.open(urlFor(item), '_blank'));
      add('Delete', () => deleteItem(item), 'mp-danger');
      menu.style.left = `${Math.min(e.clientX, global.innerWidth - 150)}px`;
      menu.style.top = `${Math.min(e.clientY, global.innerHeight - 100)}px`;
      document.body.append(menu);
    }
    document.addEventListener('mousedown', (e) => { if (menu && !menu.contains(e.target)) hideMenu(); }, true);

    async function copyText(text) {
      try {
        if (global.electronClipboard && global.electronClipboard.write) await global.electronClipboard.write(text);
        else await navigator.clipboard.writeText(text);
      } catch {}
    }
    async function deleteItem(item) {
      try {
        await fetchFn(`/api/media/${sessionId}/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      } catch {}
      remove(item.id);
    }

    // ── Lightbox ──
    function openLightbox(index) {
      if (index < 0 || index >= items.length) return;
      lightboxIndex = index;
      const item = items[index];
      lbImg.removeAttribute('src');
      blobUrl(item).then((u) => { if (lightboxIndex === index) lbImg.src = u; }).catch(() => {});
      lbTitle.textContent = `${toolShort(item.toolName)} · ${index + 1}/${items.length}`;
      lbMeta.textContent = describe(item);
      copyBtn.hidden = !item.sourcePath;
      prevBtn.disabled = index >= items.length - 1; // older
      nextBtn.disabled = index <= 0;                 // newer
      lightbox.hidden = false;
      lightbox.focus();
    }
    function closeLightbox() {
      if (lightbox.hidden) return;
      lightbox.hidden = true;
      lightboxIndex = -1;
      focusTerminal();
    }
    function step(delta) {
      if (lightboxIndex < 0) return;
      const next = lightboxIndex + delta;
      if (next >= 0 && next < items.length) openLightbox(next);
    }
    // Keys are handled on the focused overlay (capture, so xterm never sees them).
    lightbox.addEventListener('keydown', (e) => {
      if (e.key === KEY_ESCAPE) { e.preventDefault(); e.stopPropagation(); closeLightbox(); }
      else if (e.key === KEY_PREV) { e.preventDefault(); step(1); }
      else if (e.key === KEY_NEXT) { e.preventDefault(); step(-1); }
    });
    lightbox.addEventListener('click', (e) => { if (e.target === lightbox || e.target === stage || e.target === lbImg) closeLightbox(); });
    closeBtn.addEventListener('click', closeLightbox);
    prevBtn.addEventListener('click', () => step(1));
    nextBtn.addEventListener('click', () => step(-1));
    copyBtn.addEventListener('click', () => { const it = items[lightboxIndex]; if (it && it.sourcePath) copyText(it.sourcePath); });
    openBtn.addEventListener('click', () => { const it = items[lightboxIndex]; if (it) global.open(urlFor(it), '_blank'); });

    // ── Panel chrome ──
    rail.addEventListener('click', () => setOpen(true));
    collapseBtn.addEventListener('click', () => setOpen(false));
    list.addEventListener('scroll', () => { if (open && unseen) markAllSeen(); });

    resize.addEventListener('mousedown', (e) => {
      e.preventDefault();
      panel.classList.add('mp-resizing');
      document.body.classList.add('mp-resizing');
      const onMove = (ev) => { width = clampWidth(global.innerWidth - ev.clientX); layout(); };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        panel.classList.remove('mp-resizing');
        document.body.classList.remove('mp-resizing');
        lsSet(LS_WIDTH, width);
        focusTerminal();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    global.addEventListener('resize', layout);
    // Switching to this tab with the panel open means the user now sees them.
    global.addEventListener('focus', () => { if (open && unseen && items.length) markAllSeen(); });

    // ── Public API ──
    async function attach(id) {
      const changed = id !== sessionId;
      sessionId = id;
      if (changed) {
        for (const key of [...blobUrls.keys()]) revoke(key);
        seen.clear();
        unseen = 0;
      }
      try {
        const res = await fetchFn(`/api/media/${id}`);
        if (!res.ok) return;
        const data = await res.json();
        if (sessionId !== id) return;
        items = Array.isArray(data.items) ? data.items : [];
        // Everything already on disk at attach time counts as seen: the user
        // is looking at this tab right now.
        for (const it of items) seen.add(it.id);
        renderAll();
        reportBadge();
      } catch {}
    }

    function push(item) {
      if (!item || !item.id || items.some((i) => i.id === item.id)) return;
      const idx = items.findIndex((i) => i.at <= item.at);
      items.splice(idx === -1 ? items.length : idx, 0, item);
      const empty = list.querySelector('.mp-empty');
      if (empty) empty.remove();
      const node = thumbFor(item);
      const before = list.children[idx === -1 ? items.length - 1 : idx];
      list.insertBefore(node, before || null);
      const wasHidden = panel.classList.contains('mp-hidden');
      renderHead();
      layout();
      if (open && !wasHidden && document.hasFocus()) {
        seen.add(item.id);
        node.classList.remove('mp-new');
      } else {
        unseen++;
      }
      reportBadge();
    }

    function remove(id) {
      const idx = items.findIndex((i) => i.id === id);
      if (idx === -1) return;
      items.splice(idx, 1);
      revoke(id);
      const node = list.querySelector(`.mp-thumb[data-id="${CSS.escape(id)}"]`);
      if (node) node.remove();
      if (lightboxIndex === idx) closeLightbox();
      if (!items.length) list.append(el('div', 'mp-empty', 'No images yet'));
      renderHead();
      layout();
    }

    function setBottom(px) {
      bottom = px || 0;
      layout();
    }

    function destroy() {
      for (const key of [...blobUrls.keys()]) revoke(key);
      panel.remove();
      lightbox.remove();
      hideMenu();
    }

    layout();
    return { attach, push, remove, setBottom, setOpen, destroy, get items() { return items.slice(); } };
  }

  const api = { create, toolShort, fmtBytes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.MediaPanel = api;
})(typeof window !== 'undefined' ? window : null);
