/**
 * Link activation for a terminal tab.
 *
 * Two kinds of link reach a click: plain URLs that @xterm/addon-web-links
 * finds by regex, and OSC 8 hyperlinks the program declares itself (Claude
 * Code emits every link, bare or markdown-style, this way). Without a
 * `linkHandler` option xterm handles OSC 8 with its built-in default, which
 * calls confirm() and then an empty window.open(); in a tab view that opens
 * nothing and leaves the terminal unfocused. Both kinds go through the same
 * opener here, and the terminal gets focus back afterwards.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TermLinks = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OPENABLE_PROTOCOLS = Object.freeze(['http:', 'https:']);

  function isOpenableLink(uri) {
    try {
      return OPENABLE_PROTOCOLS.includes(new URL(uri).protocol);
    } catch {
      return false;
    }
  }

  /**
   * Builds the click handler shared by the web-links addon and xterm's
   * `linkHandler.activate`. `open(uri)` opens the link (window.open in the
   * page, which main.js routes to the default browser); `refocus()` gives
   * the terminal its keyboard back.
   */
  function linkActivator(open, refocus) {
    return function activate(event, uri) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (isOpenableLink(uri)) open(uri);
      if (refocus) refocus();
    };
  }

  /** Terminal `linkHandler` option for OSC 8 hyperlinks. */
  function oscLinkHandler(activate) {
    return { activate, allowNonHttpProtocols: false };
  }

  return { OPENABLE_PROTOCOLS, isOpenableLink, linkActivator, oscLinkHandler };
});
