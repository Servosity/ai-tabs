const fs = require('fs');

/**
 * Window size and position memory. Each launch target (the local server, or
 * a saved remote server) remembers the last bounds and maximized state of
 * its windows in userData/window-state.json, so a new window opens where and
 * how big the last one was.
 *
 * Saved positions are checked against the current displays on the way back
 * in: a monitor that has gone away must not leave the window off-screen.
 */

const SAVE_DEBOUNCE_MS = 500;
// After a window shows, how long its own placement and maximize settle
// before moves and resizes count as the user's.
const SETTLE_MS = 1500;
// How much of the window must land on some display for the saved position
// to be kept: enough of the top edge to grab and drag it.
const MIN_VISIBLE_WIDTH = 120;
const MIN_VISIBLE_HEIGHT = 40;
const MIN_WIDTH = 400;
const MIN_HEIGHT = 300;

function readAll(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isNum(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

/** @returns {{x:number, y:number, width:number, height:number, maximized:boolean}|null} */
function load(file, key) {
  const entry = readAll(file)[key];
  if (!entry || !isNum(entry.width) || !isNum(entry.height)) return null;
  return {
    x: isNum(entry.x) ? entry.x : undefined,
    y: isNum(entry.y) ? entry.y : undefined,
    width: Math.round(entry.width),
    height: Math.round(entry.height),
    maximized: entry.maximized === true,
  };
}

function save(file, key, state) {
  const all = readAll(file);
  all[key] = state;
  try {
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
  } catch (err) {
    console.warn(`[window-state] could not save ${file}: ${err.message}`);
  }
}

function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { w: Math.max(0, w), h: Math.max(0, h) };
}

/**
 * Saved bounds made safe for the displays attached now. The size is capped
 * to the largest work area; the position is kept only if the window's top
 * strip lands on a display, otherwise dropped so the OS centres it.
 * @param {object|null} saved from load()
 * @param {{x:number, y:number, width:number, height:number}[]} workAreas
 */
function fitToDisplays(saved, workAreas) {
  if (!saved || !workAreas.length) return saved;
  const maxW = Math.max(...workAreas.map((a) => a.width));
  const maxH = Math.max(...workAreas.map((a) => a.height));
  const width = Math.max(MIN_WIDTH, Math.min(saved.width, maxW));
  const height = Math.max(MIN_HEIGHT, Math.min(saved.height, maxH));
  const out = { width, height, maximized: saved.maximized };
  if (isNum(saved.x) && isNum(saved.y)) {
    const topStrip = { x: saved.x, y: saved.y, width, height: MIN_VISIBLE_HEIGHT };
    const visible = workAreas.some((a) => {
      const o = overlap(topStrip, a);
      return o.w >= Math.min(MIN_VISIBLE_WIDTH, width) && o.h >= MIN_VISIBLE_HEIGHT;
    });
    if (visible) Object.assign(out, { x: saved.x, y: saved.y });
  }
  return out;
}

/**
 * Save a window's bounds whenever it moves, resizes, maximizes or closes.
 * A maximized window records its restored size, so un-maximizing next time
 * lands somewhere sensible. Minimized and full-screen states are not saved.
 */
function track(win, file, key, { settleMs = SETTLE_MS } = {}) {
  let timer = null;
  // Only the user's own moves and resizes are saved. The window placing
  // itself (and the OS rounding the restored size at fractional display
  // scaling) also fires resize/move, and saving those made the remembered
  // size creep a pixel larger every launch.
  let armed = false;
  let dirty = false;
  const snapshot = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    const b = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
    save(file, key, { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() });
    dirty = false;
  };
  const changed = () => {
    if (!armed) return;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(snapshot, SAVE_DEBOUNCE_MS);
  };
  const arm = () => { const t = setTimeout(() => { armed = true; }, settleMs); if (t.unref) t.unref(); };
  if (win.isVisible()) arm(); else win.once('show', arm);
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) win.on(event, changed);
  win.on('close', () => { clearTimeout(timer); if (dirty) snapshot(); });
}

module.exports = { load, save, fitToDisplays, track, MIN_WIDTH, MIN_HEIGHT };
