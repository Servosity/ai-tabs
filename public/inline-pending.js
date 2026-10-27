/**
 * Pending image — an image whose line is still on screen. Inline marks
 * (public/inline-marks.js) only give an image its own rows once its line
 * has scrolled into scrollback, because the agent still redraws the screen
 * by cursor position. Until then the newest such image floats over the top
 * right of the terminal, so an image shown at the end of a reply is seen
 * right away. It goes when its rows exist, or when closed.
 *
 * Usage:
 *   const pending = InlinePending.create({ term, imageUrl, open, focusTerminal });
 *   pending.show(items)   items newest first: those still waiting ([] hides it)
 */
(function (global) {
  'use strict';

  /** The newest image not closed by hand, or null. Pure, for tests. */
  function pick(items, closed) {
    return items.find((item) => item && item.id && !closed.has(item.id)) || null;
  }

  function create(opts) {
    const term = opts.term;
    const imageUrl = opts.imageUrl; // item → Promise<url>
    const open = opts.open;         // item → shows it full size
    const focusTerminal = opts.focusTerminal || (() => {});
    const closed = new Set();
    let shown = null;

    const panel = document.createElement('div');
    panel.className = 'ip-panel';
    panel.hidden = true;
    const img = document.createElement('img');
    img.className = 'ip-image';
    img.draggable = false;
    img.title = 'Click to enlarge';
    const close = document.createElement('button');
    close.className = 'ip-close';
    close.textContent = '×';
    close.title = 'Hide (it still appears in the conversation once its line scrolls up)';
    panel.append(img, close);
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    img.addEventListener('click', (e) => { e.stopPropagation(); if (shown) open(shown); });
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      if (shown) closed.add(shown.id);
      hide();
      focusTerminal();
    });

    function hide() {
      shown = null;
      panel.hidden = true;
      img.removeAttribute('src');
    }

    function show(items) {
      const item = pick(items, closed);
      if (!item) { hide(); return; }
      if (!panel.isConnected && term.element) term.element.append(panel);
      if (shown && shown.id === item.id) return;
      shown = item;
      img.removeAttribute('src');
      imageUrl(item).then((url) => { if (shown === item) img.src = url; }).catch(hide);
      panel.hidden = false;
    }

    return { show };
  }

  const api = { create, pick };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.InlinePending = api;
})(typeof window !== 'undefined' ? window : null);
