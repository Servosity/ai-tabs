/**
 * A plain left-drag always makes a terminal selection, even when the app in
 * the tab has turned on mouse reporting.
 *
 * Claude Code's fullscreen renderer sets mouseTrackingMode 'any', so xterm
 * forwards a left-drag to Claude Code, which runs its own selection and copies
 * via OSC 52. That selection is invisible to ai-tabs: smart right-click sees
 * no selection and pastes instead of copying, and copy-on-select never fires.
 * xterm already forces its own selection when Shift is held, so a plain
 * left-press is re-dispatched as a Shift-press. Wheel events are untouched,
 * so the app keeps scrolling. Cost: the app no longer receives left-clicks,
 * nor hover movement while a selection is showing.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ForceSelection = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LEFT_BUTTON = 0;

  /** Whether this mousedown should be turned into a forced selection. */
  function shouldForce(ev, mouseTrackingMode) {
    if (!mouseTrackingMode || mouseTrackingMode === 'none') return false;
    if (ev.button !== LEFT_BUTTON) return false;
    if (ev.forcedSelection) return false; // our own re-dispatch
    return !(ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey);
  }

  /** Re-dispatch plain left-presses inside `container` as Shift-presses. */
  function install(container, term) {
    container.addEventListener('mousedown', (ev) => {
      if (!shouldForce(ev, term.modes && term.modes.mouseTrackingMode)) return;
      ev.stopPropagation();
      ev.preventDefault();
      const forced = new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, view: ev.view, detail: ev.detail,
        screenX: ev.screenX, screenY: ev.screenY, clientX: ev.clientX, clientY: ev.clientY,
        button: ev.button, buttons: ev.buttons, shiftKey: true,
      });
      forced.forcedSelection = true;
      ev.target.dispatchEvent(forced);
    }, true);
    // xterm treats every mouse report as user input, and user input clears
    // the selection. Claude Code asks for hover reports, so the first pixel
    // the pointer moves after the drag wiped what was just selected. Hold
    // hover reports back while a selection is showing.
    container.addEventListener('mousemove', (ev) => {
      if (shouldHoldHover(ev, term.modes && term.modes.mouseTrackingMode, term.hasSelection())) {
        ev.stopPropagation();
      }
    }, true);
  }

  /** Whether a buttonless mousemove must not reach the app (it would clear the selection). */
  function shouldHoldHover(ev, mouseTrackingMode, hasSelection) {
    return hasSelection && ev.buttons === 0 && !!mouseTrackingMode && mouseTrackingMode !== 'none';
  }

  return { shouldForce, shouldHoldHover, install };
});
