/**
 * OSC 52 clipboard writes from the app running in a tab.
 *
 * Claude Code in its fullscreen renderer turns on mouse reporting, so a plain
 * drag never reaches xterm's own selection: Claude Code selects the text
 * itself and copies it by emitting `ESC ] 52 ; c ; <base64> BEL`. xterm.js
 * ignores OSC 52 unless a handler is registered, so without this the copy was
 * silently dropped and only Shift+drag (xterm's forced selection) worked.
 *
 * Writes only. A `?` payload asks the terminal to report the clipboard back to
 * the app — that would let any program in a tab read the OS clipboard, so it
 * is refused. Pure parsing is exported for Node tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Osc52 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OSC_CLIPBOARD = 52;
  // Bigger payloads are dropped rather than pushed onto the OS clipboard.
  const MAX_BASE64_LENGTH = 8 * 1024 * 1024;

  /**
   * Decode an OSC 52 payload ("<targets>;<base64>") to the text to copy.
   * Returns null for a clipboard read query, an empty or oversized payload,
   * or base64 that does not decode.
   */
  function decodeOsc52(data) {
    const sep = String(data).indexOf(';');
    if (sep < 0) return null;
    const b64 = String(data).slice(sep + 1);
    if (!b64 || b64 === '?' || b64.length > MAX_BASE64_LENGTH) return null;
    try {
      const bin = atob(b64);
      const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }

  /** Route OSC 52 writes from `term` to `writeClipboard(text)`. */
  function install(term, writeClipboard, log) {
    return term.parser.registerOscHandler(OSC_CLIPBOARD, (data) => {
      const text = decodeOsc52(data);
      if (log) log('osc52', JSON.stringify({ len: text === null ? -1 : text.length }));
      if (text) Promise.resolve(writeClipboard(text)).catch(() => {});
      return true; // handled: never fall through to xterm's default (ignore)
    });
  }

  return { decodeOsc52, install, OSC_CLIPBOARD, MAX_BASE64_LENGTH };
});
