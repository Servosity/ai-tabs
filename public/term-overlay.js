/**
 * Term overlay — absolutely placed boxes that scroll with the terminal's
 * text, for public/inline-marks.js. Like xterm decorations, except a box
 * stays drawn while ANY of its rows is on screen: xterm hides a decoration
 * as soon as its first row scrolls off the top, so a tall image or code
 * block blanked out whenever it filled the view.
 *
 * Usage:
 *   const overlay = TermOverlay.create(term);
 *   const mark = overlay.add({ marker, x, width, height, anchor });  // cells; anchor 'left' | 'right'
 *   mark.element   the box's node, yours to fill
 *   mark.dispose() removes it (also happens when its marker is disposed)
 */
(function (global) {
  'use strict';

  const ANCHOR_RIGHT = 'right';

  function create(term) {
    const marks = new Set();
    let layer = null;

    function host() {
      if (layer && layer.isConnected) return layer;
      const screen = term.element && term.element.querySelector('.xterm-screen');
      if (!screen) return null;
      layer = document.createElement('div');
      layer.className = 'to-layer';
      for (const m of marks) layer.append(m.element);
      screen.append(layer);
      return layer;
    }

    function cellSize() {
      const screen = term.element && term.element.querySelector('.xterm-screen');
      if (!screen || !term.cols || !term.rows) return null;
      return { w: screen.clientWidth / term.cols, h: screen.clientHeight / term.rows };
    }

    function place(m, cell, top, hidden) {
      const s = m.element.style;
      const rowTop = m.marker.line - top;
      if (hidden || rowTop + m.height <= 0 || rowTop >= term.rows) { s.display = 'none'; return; }
      const col = m.anchor === ANCHOR_RIGHT ? term.cols - m.x - m.width : m.x;
      s.display = 'block';
      s.left = `${col * cell.w}px`;
      s.top = `${rowTop * cell.h}px`;
      s.width = `${m.width * cell.w}px`;
      s.height = `${m.height * cell.h}px`;
    }

    function render() {
      if (!marks.size || !host()) return;
      const cell = cellSize();
      if (!cell) return;
      const buf = term.buffer.active;
      const hidden = buf.type !== 'normal';
      for (const m of marks) place(m, cell, buf.viewportY, hidden);
    }

    term.onRender(render);
    term.onScroll(render);
    term.onResize(render);

    function add(opts) {
      const marker = opts.marker;
      if (!marker || marker.isDisposed) return null;
      const element = document.createElement('div');
      element.className = 'to-mark';
      const m = {
        marker, element, x: opts.x || 0, width: opts.width, height: opts.height || 1,
        anchor: opts.anchor, disposed: false,
      };
      m.dispose = () => {
        if (m.disposed) return;
        m.disposed = true;
        marks.delete(m);
        element.remove();
      };
      marker.onDispose(m.dispose);
      marks.add(m);
      const parent = host();
      if (parent) parent.append(element);
      render();
      return m;
    }

    return { add, render };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.TermOverlay = api;
})(typeof window !== 'undefined' ? window : null);
