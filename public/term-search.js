/**
 * Scrollback search bar for a terminal tab (Ctrl+F).
 *
 * Wraps @xterm/addon-search in a small overlay: query input, next/prev
 * (Enter / Shift+Enter), case-sensitive and regex toggles, a live match
 * counter fed by the addon's onDidChangeResults, and Esc to close + refocus
 * the terminal. Pure helpers (option building, counter formatting) are
 * exported for Node tests; the DOM part only runs in the browser.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TermSearch = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // addon-search stops counting past this many matches and reports -1.
  const HIGHLIGHT_LIMIT = 1000;
  const NO_RESULTS_TEXT = 'No results';

  /** Colours for match decorations, derived from the tab's theme preset. */
  function decorationColors(colors) {
    const c = colors || {};
    const accent = c.accent || '#9d7ee0';
    const match = c.match || '#e5c07b';
    return {
      matchBackground: match + '66',
      matchBorder: match,
      matchOverviewRuler: match,
      activeMatchBackground: accent + 'aa',
      activeMatchBorder: accent,
      activeMatchColorOverviewRuler: accent,
    };
  }

  /** Options object for addon.findNext / findPrevious. */
  function searchOptions(state, colors) {
    return {
      caseSensitive: !!(state && state.caseSensitive),
      regex: !!(state && state.regex),
      incremental: !!(state && state.incremental),
      decorations: decorationColors(colors),
    };
  }

  /**
   * "3/12", "No results", "1000+" (limit exceeded), or '' for an empty query.
   * results is the addon's { resultIndex, resultCount } payload.
   */
  function formatMatchCount(results, query) {
    if (!query) return '';
    if (!results) return NO_RESULTS_TEXT;
    const { resultIndex, resultCount } = results;
    if (resultCount === -1) return `${HIGHLIGHT_LIMIT}+`;
    if (!resultCount || resultCount <= 0) return NO_RESULTS_TEXT;
    if (typeof resultIndex !== 'number' || resultIndex < 0) return `${resultCount}`;
    return `${resultIndex + 1}/${resultCount}`;
  }

  /** True when this keydown is the Ctrl+F (or Cmd+F) find shortcut. */
  function isFindShortcut(event) {
    if (!event || event.type !== 'keydown') return false;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
    return typeof event.key === 'string' && event.key.toLowerCase() === 'f';
  }

  /**
   * Build the overlay. Returns { open, close, toggle, isOpen, element }.
   *   term     — xterm Terminal (already opened)
   *   addon    — a loaded SearchAddon instance
   *   colors   — { bg, fg, border, accent, muted, inputBg, match } theme colours
   */
  function createSearchBar({ term, addon, colors, parent }) {
    const doc = (parent && parent.ownerDocument) || document;
    const host = parent || doc.body;
    const state = { caseSensitive: false, regex: false, query: '' };
    const palette = colors || {};

    const bar = doc.createElement('div');
    bar.id = 'term-search';
    bar.className = 'term-search';
    bar.hidden = true;
    const vars = {
      '--ts-bg': palette.bg, '--ts-fg': palette.fg, '--ts-border': palette.border,
      '--ts-accent': palette.accent, '--ts-muted': palette.muted, '--ts-input-bg': palette.inputBg,
    };
    for (const [k, v] of Object.entries(vars)) if (v) bar.style.setProperty(k, v);
    bar.innerHTML = `
      <input type="text" class="ts-input" placeholder="Find in scrollback" spellcheck="false" autocomplete="off">
      <span class="ts-count" aria-live="polite"></span>
      <button type="button" class="ts-toggle" data-opt="caseSensitive" title="Match case">Aa</button>
      <button type="button" class="ts-toggle" data-opt="regex" title="Regular expression">.*</button>
      <button type="button" class="ts-btn" data-act="prev" title="Previous match (Shift+Enter)">&#8593;</button>
      <button type="button" class="ts-btn" data-act="next" title="Next match (Enter)">&#8595;</button>
      <button type="button" class="ts-btn" data-act="close" title="Close (Esc)">&#10005;</button>
    `;
    host.appendChild(bar);

    const input = bar.querySelector('.ts-input');
    const countEl = bar.querySelector('.ts-count');
    let lastResults = null;

    function renderCount() {
      countEl.textContent = formatMatchCount(lastResults, state.query);
      countEl.classList.toggle('ts-none', countEl.textContent === NO_RESULTS_TEXT);
    }

    if (addon && typeof addon.onDidChangeResults === 'function') {
      addon.onDidChangeResults((results) => {
        lastResults = results;
        renderCount();
      });
    }

    function run(direction, incremental) {
      state.query = input.value;
      if (!state.query) {
        lastResults = null;
        try { addon.clearDecorations(); } catch {}
        renderCount();
        return;
      }
      const opts = searchOptions({ ...state, incremental }, palette);
      let found = false;
      try {
        found = direction === 'prev' ? addon.findPrevious(state.query, opts) : addon.findNext(state.query, opts);
      } catch (err) {
        // Invalid regex while typing — show "No results" rather than throwing.
        found = false;
      }
      if (!found) {
        lastResults = { resultIndex: -1, resultCount: 0 };
        renderCount();
      }
    }

    function open() {
      bar.hidden = false;
      input.focus();
      input.select();
      if (input.value) run('next', true);
    }

    function close() {
      if (bar.hidden) return;
      bar.hidden = true;
      try { addon.clearDecorations(); } catch {}
      lastResults = null;
      renderCount();
      if (term && typeof term.focus === 'function') term.focus();
    }

    function toggle() {
      if (bar.hidden) open(); else close();
    }

    input.addEventListener('input', () => run('next', true));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Enter') { e.preventDefault(); run(e.shiftKey ? 'prev' : 'next', false); return; }
      if (isFindShortcut(e)) { e.preventDefault(); input.select(); }
    });
    bar.addEventListener('mousedown', (e) => {
      // Keep focus in the input when clicking buttons.
      if (e.target !== input) e.preventDefault();
    });
    bar.addEventListener('click', (e) => {
      const tog = e.target.closest('.ts-toggle');
      if (tog) {
        state[tog.dataset.opt] = !state[tog.dataset.opt];
        tog.classList.toggle('on', state[tog.dataset.opt]);
        run('next', true);
        return;
      }
      const btn = e.target.closest('.ts-btn');
      if (!btn) return;
      if (btn.dataset.act === 'close') close();
      else run(btn.dataset.act, false);
    });

    return { open, close, toggle, isOpen: () => !bar.hidden, element: bar };
  }

  return {
    HIGHLIGHT_LIMIT, NO_RESULTS_TEXT,
    decorationColors, searchOptions, formatMatchCount, isFindShortcut,
    createSearchBar,
  };
});
