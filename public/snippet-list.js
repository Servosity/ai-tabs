/**
 * Snippet list — the "Copy" tab of the media panel. One box per code block
 * or block quote the agent wrote, newest first; clicking a box copies its
 * exact text (from the transcript, so no terminal wrapping or quote bars).
 *
 * Usage (public/media-panel.js):
 *   const snippets = SnippetList.create({ copy, onChange });
 *   panelBody.append(snippets.element);
 *   snippets.set(items)   after GET /api/snippets/:sessionId
 *   snippets.push(item)   on {type:'snippet'}
 */
(function (global) {
  'use strict';

  const KIND_QUOTE = 'quote';
  const COPIED_MS = 1200;
  const PREVIEW_LINES = 12;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** Box label: the fence language, "code" without one, or "quote". */
  function snippetLabel(item) {
    if (!item) return '';
    if (item.kind === KIND_QUOTE) return 'quote';
    return item.lang || 'code';
  }

  /** "12 lines" / "1 line" for the box caption. */
  function lineCount(text) {
    const n = String(text || '').split('\n').length;
    return n === 1 ? '1 line' : `${n} lines`;
  }

  function create(opts) {
    const copy = opts.copy;
    const onChange = opts.onChange || (() => {});
    let items = [];

    const element = el('div', 'sn-list');

    function boxFor(item) {
      const box = el('div', `sn-box sn-${item.kind === KIND_QUOTE ? 'quote' : 'code'}`);
      box.dataset.id = item.id;
      box.tabIndex = 0;
      box.title = 'Click to copy';
      const cap = el('div', 'sn-cap');
      const status = el('span', 'sn-status', 'copy');
      cap.append(el('span', 'sn-kind', snippetLabel(item)), el('span', 'sn-lines', lineCount(item.text)), status);
      const pre = el('pre', 'sn-text');
      pre.textContent = item.text;
      if (item.text.split('\n').length > PREVIEW_LINES) box.classList.add('sn-long');
      box.append(cap, pre);
      let timer = null;
      const doCopy = async () => {
        const ok = await copy(item.text);
        status.textContent = ok ? 'copied' : 'copy failed';
        box.classList.toggle('sn-copied', ok);
        clearTimeout(timer);
        timer = setTimeout(() => { status.textContent = 'copy'; box.classList.remove('sn-copied'); }, COPIED_MS);
      };
      box.addEventListener('click', () => {
        // A drag-select inside the box is a partial copy; leave it alone.
        const sel = global.getSelection && global.getSelection();
        if (sel && !sel.isCollapsed && box.contains(sel.anchorNode)) return;
        doCopy();
      });
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doCopy(); } });
      return box;
    }

    function render() {
      element.innerHTML = '';
      if (!items.length) element.append(el('div', 'sn-empty', 'No code blocks or quotes yet'));
      for (const item of items) element.append(boxFor(item));
      onChange(items.length);
    }

    function set(next) {
      items = Array.isArray(next) ? next.slice() : [];
      render();
    }

    function push(item) {
      if (!item || !item.id || typeof item.text !== 'string' || items.some((i) => i.id === item.id)) return;
      const idx = items.findIndex((i) => i.at < item.at);
      const at = idx === -1 ? items.length : idx;
      items.splice(at, 0, item);
      const empty = element.querySelector('.sn-empty');
      if (empty) empty.remove();
      element.insertBefore(boxFor(item), element.children[at] || null);
      onChange(items.length);
    }

    return { element, set, push, get count() { return items.length; } };
  }

  const api = { create, snippetLabel, lineCount };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.SnippetList = api;
})(typeof window !== 'undefined' ? window : null);
