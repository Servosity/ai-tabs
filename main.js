const { app, BaseWindow, BrowserWindow, WebContentsView, Notification, clipboard, dialog, globalShortcut, ipcMain, screen, nativeImage, shell } = require('electron');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { THEME_PRESETS, DEFAULT_SETTINGS, deepMerge } = require('./lib/theme-presets');
const agents = require('./lib/agents');
const { waitForRemoteHealth } = require('./lib/remote-health');
const { rebaseOpenTabUrl, resolveOpenTabWindow } = require('./lib/open-tab-routing');
const { checkForUpdate, applyUpdate } = require('./lib/auto-update');
const { shouldNotify, describeAttention, createDesktopNotifier } = require('./lib/desktop-notify');

const TAB_BAR_HEIGHT = 42;
const APP_ICON = path.join(__dirname, 'ai-tabs.ico');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');

// ── Server binding — resolved before anything else so all constants are
// correct. The target comes from --server=<id> against the server list in
// userData; no argument means the picker decides (see whenReady).
const servers = require('./lib/servers');
const SERVERS_FILE = path.join(app.getPath('userData'), 'servers.json');

let remoteServerUrl = null;
let remoteServerKey = null;
const launchTarget = servers.resolveLaunchTarget(process.argv, SERVERS_FILE);
if (launchTarget && launchTarget.url) {
  remoteServerUrl = launchTarget.url.replace(/\/$/, '');
  remoteServerKey = launchTarget.key;
}
const isRemoteMode = !!(remoteServerUrl && remoteServerKey);

let BASE_URL = isRemoteMode ? remoteServerUrl : 'http://localhost:25283';

// Same-origin test, never a string prefix: 'http://localhost:25283@evil.com/'
// starts with BASE_URL, but its host is evil.com.
function isAppUrl(url) {
  try {
    return new URL(url).origin === new URL(BASE_URL).origin;
  } catch {
    return false;
  }
}

// IPC that touches the clipboard or the saved servers answers only our own
// pages (the app origin, or the bundled file:// pages like the picker).
function isTrustedSender(e) {
  const url = (e.senderFrame && e.senderFrame.url) || e.sender.getURL();
  return url.startsWith('file://') || isAppUrl(url);
}

// Chromium only exposes navigator.clipboard on secure origins (https/localhost).
// The remote server is plain http on a LAN IP, so without this switch copy and
// paste silently fail in remote mode. Must be set before app ready.
// This only covers the origin bound at launch — a view can still end up on an
// unlisted LAN origin, so the renderer must not assume navigator.clipboard
// exists. The clipboard-read/clipboard-write IPC below is the reliable path.
if (isRemoteMode) {
  app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', remoteServerUrl);
}

app.setAppUserModelId('com.servosity.ai-tabs');

// ── Debug log file ──
const DEBUG_LOG = path.join(__dirname, 'data', 'debug.log');
function debugLog(msg) {
  if (!debugLog._enabled) return;
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(DEBUG_LOG, line); } catch {}
}
debugLog._enabled = process.env.AI_TABS_DEBUG === '1' || process.env.CC_TABS_DEBUG === '1'; // CC_TABS_DEBUG: legacy alias
try {
  if (fs.existsSync(SETTINGS_FILE)) {
    if (JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).debug) debugLog._enabled = true;
  }
} catch {}
if (debugLog._enabled) try { fs.writeFileSync(DEBUG_LOG, ''); } catch {}

// Periodic snapshot of all tabs' idle/flashing/active state — anchors the timeline
// when no title events fire. Cheap: one log line per tab every 10s.
if (debugLog._enabled) {
  setInterval(() => {
    try {
      for (const state of windows.values()) {
        for (const tab of state.tabs) {
          debugLog(`[snapshot] tab=${tab.id} active=${tab.id===state.activeTabId} idle=${tab.idle} flashing=${tab.flashing} muted=${tab.muted} pinned=${tab.pinned} title=${JSON.stringify(tab.customTitle || tab.title)}`);
        }
      }
    } catch {}
  }, 10000);
}

// Multiple local instances are allowed to run side by side: the shared
// server's control-ready handshake designates one controller at a time, and
// a freshly launched window claims the slot (claim:true on register-control,
// see connectControlWs), locking whichever window held it before.
// requestSingleInstanceLock is not used — at module scope it kills
// WebContentsView renderers, and inside whenReady it always returns false.

function openInBrowser(url) {
  if (!/^https?:\/\//i.test(url)) return;
  // No cmd.exe `start` fallback: it expands %VARS% inside the URL.
  shell.openExternal(url).catch((err) => {
    console.warn(`[openInBrowser] could not open ${url}: ${err.message}`);
  });
}

function cleanIdleTitle(title) {
  return title.replace(/>>>\s*/g, '').replace(/\s*<<</g, '').trim();
}

function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return deepMerge(DEFAULT_SETTINGS, saved);
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function getThemeData() {
  const settings = readSettings();
  const preset = THEME_PRESETS[settings.theme] || THEME_PRESETS['default-purple'];
  return { terminal: preset.terminal, ui: preset.ui };
}

const PORT = 25283;

// ── Multi-window state ──
const windows = new Map(); // winId → windowState
let nextTabId = 1;
let quitting = false;
let restarting = false;
let controlWs = null;
// True once register-control has been sent at least once for this process.
// The claim flag is only sent on the first registration — a reconnect after
// that (see the close handler's setTimeout) must never claim, or a window
// that merely dropped its socket would steal control back from whichever
// window the user has since switched to.
let hasRegisteredControl = false;
// True once this process has seen evidence that another control client has
// been attached to the server: a non-primary control-ready, a control-granted,
// or a control-revoked. Electron window ids restart at 1 in every process, so
// once a peer is known (even one that has since disconnected), kill-sessions
// by windowId is unsafe — it can hit a same-numbered window's sessions in the
// other process. See the guard in the 'closed' handler.
let knownControlPeer = false;
// True once this process has handled its first control-ready. The first one
// decides bootstrap (create tabs for the initial session list, or load
// favorites); every one after that must reconcile instead of blindly
// creating tabs — a plain WS reconnect (see connectControlWs's close handler)
// also yields a control-ready with a full session list, and this process may
// already hold live tabs for those sessions.
let controlBootstrapped = false;
let foreignDragTarget = null; // { winId, insertIndex } — tracks cross-window tab bar drop target
// Set by the server's control handshake. `null` until the first control-ready
// arrives and treated as "don't touch shared state". True while this instance
// holds the controller slot; flips live via control-granted / control-revoked.
let isController = null;
let pendingReleaseAck = null; // resolver while a quit-time release-control awaits its ack

// ── Drag ghost overlay window (floats above title bar) ──
let ghostWin = null;

function createGhostWindow() {
  if (ghostWin && !ghostWin.isDestroyed()) return;
  const html = `<!DOCTYPE html><html><head><style>
*{margin:0;padding:0}html,body{background:transparent;overflow:hidden;height:100%}
#g{display:inline-block;padding:4px 12px;border-radius:4px;
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
font-size:12px;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,0.5)}
</style></head><body><div id="g"></div></body></html>`;

  ghostWin = new BrowserWindow({
    width: 300,
    height: 42,
    show: false,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  ghostWin.setIgnoreMouseEvents(true);
  ghostWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

// ── Server startup ──

// All main-process /api calls aimed at BASE_URL go through this so remote mode
// can attach the key. Local mode passes straight through to fetch.
function apiFetch(url, init = {}) {
  if (!isRemoteMode) return fetch(url, init);
  const headers = { ...(init.headers || {}), Authorization: `Bearer ${remoteServerKey}` };
  return fetch(url, { ...init, headers });
}

async function startExpressServer() {
  if (isRemoteMode) {
    // Remote mode: connect to another machine's ai-tabs server — don't start
    // locally. Each probe carries its own abort deadline (see lib/remote-health)
    // so an unreachable host fails in ~5s instead of hanging on OS connect
    // timeouts with no window on screen.
    return waitForRemoteHealth(remoteServerUrl, apiFetch);
  }

  const { spawn } = require('child_process');

  // Spawn server.js as a detached process so it outlives Electron restarts.
  // ELECTRON_RUN_AS_NODE=1 makes the Electron binary act as Node.js.
  // If a server is already running (EADDRINUSE), the spawned child exits cleanly.
  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
  } catch {}

  // Wait up to 5 s for the server to respond
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/health`);
      if (res.ok) return warnIfServerIsStale();
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Server did not start within 5 seconds');
}

/**
 * The server is detached and outlives Electron, so an upgrade can leave the
 * previous build listening on PORT while this UI runs the new one. The server
 * keeps serving the routes it booted with, so anything added since 404s — which
 * reaches callers as HTML and surfaces as a nonsense parse error far from the
 * cause. Say so plainly at startup instead.
 */
async function warnIfServerIsStale() {
  let ours;
  try {
    ours = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
  } catch {
    return;
  }

  let theirs = null;
  try {
    const res = await fetch(`http://localhost:${PORT}/api/version`);
    if (res.ok) theirs = (await res.json()).version || null;
  } catch {
    return;
  }
  if (theirs === ours) return;

  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'ai-tabs server is out of date',
    message: `The background server is running ${theirs || 'an unknown version'}, but this app is ${ours}.`,
    detail: 'The server keeps running between restarts, so it is still serving the older build. '
      + 'Features added since then will fail until it restarts. Restarting ends every terminal '
      + 'session it is hosting — unsaved work in those sessions is lost.',
    buttons: ['Restart server', 'Continue anyway'],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return;

  await restartBackgroundServer();
}

/**
 * Kill whatever holds PORT and spawn a fresh server from this build. Resolves
 * once the new server answers, so callers can carry on immediately.
 */
async function restartBackgroundServer() {
  const { spawn } = require('child_process');
  const pids = await pidsListeningOnPort();
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch (error) {
      console.warn(`[server] could not kill pid ${pid}: ${error.message}`);
    }
  }

  // Give the port a moment to free up before rebinding it.
  await new Promise(r => setTimeout(r, 500));
  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
  } catch (error) {
    console.error(`[server] restart failed: ${error.message}`);
    return;
  }

  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/health`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  console.error('[server] restarted server did not come up within 5 seconds');
}

/** PIDs with a LISTENING socket on PORT, newest first. Empty if none found. */
function pidsListeningOnPort() {
  const command = process.platform === 'win32'
    ? `netstat -ano -p TCP | findstr LISTENING | findstr :${PORT}`
    : `lsof -nP -iTCP:${PORT} -sTCP:LISTEN -t`;
  return new Promise((resolve) => {
    exec(command, (error, stdout) => {
      if (error && !stdout) return resolve([]);
      const pids = new Set();
      for (const line of stdout.split('\n')) {
        const pid = process.platform === 'win32'
          ? (line.trim().split(/\s+/).pop() || '')
          : line.trim();
        const parsed = Number(pid);
        if (Number.isInteger(parsed) && parsed > 0) pids.add(parsed);
      }
      resolve([...pids]);
    });
  });
}

// ── Control WebSocket — Electron registers as a control client ──

function controlLog(msg) {
  // Always log control WS events regardless of debug flag
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(path.join(__dirname, 'data', 'debug.log'), line);
  } catch {}
}

function connectControlWs() {
  const WS = require('ws');
  const wsBase = isRemoteMode
    ? remoteServerUrl.replace(/^http/, 'ws')
    : `ws://localhost:${PORT}`;
  const wsUrl = isRemoteMode ? `${wsBase}?key=${remoteServerKey}` : wsBase;
  controlLog(`[control] connectControlWs called, url=${wsUrl}`);
  let ws;
  try { ws = new WS(wsUrl); } catch (e) {
    controlLog(`[control] WS constructor threw: ${e.message}`);
    return;
  }
  controlWs = ws;
  controlLog('[control] WS instance created, waiting for open...');

  ws.on('open', () => {
    // claim:true — a freshly launched window takes the controller slot from
    // whoever holds it; the previous holder gets the lock overlay and can
    // take it back. Reconnects after the first registration do not claim, so
    // a dropped WebSocket does not steal control back from another window.
    const claim = !hasRegisteredControl;
    hasRegisteredControl = true;
    controlLog(`[control] WS open, sending register-control (claim=${claim})`);
    ws.send(JSON.stringify({ type: 'register-control', claim }));
    reportControlWindows();
  });

  ws.on('message', (rawData) => {
    let msg;
    try { msg = JSON.parse(rawData.toString()); } catch { return; }

    switch (msg.type) {
      case 'control-ready':
        isController = msg.isPrimary === true;
        // Not primary means some other control connection currently holds
        // the slot — direct evidence of a peer. See knownControlPeer above.
        if (!isController) knownControlPeer = true;
        controlLog(`[control] control-ready received, sessions=${(msg.sessions||[]).length}, isController=${isController}, controller=${JSON.stringify(msg.controller || null)}`);
        onControlReady(msg.sessions || [], msg.controller || null);
        break;

      case 'control-granted':
        // The server can send control-ready{isPrimary:true} followed by a
        // redundant control-granted when a claim lands on a stale-but-not-
        // yet-reaped slot (graceWasPending / staleController on the server).
        // If we're already the controller from that control-ready, treat this
        // as a no-op — promoting again would run reconcileTabs before the
        // tabs control-ready just created have set window._sessionId,
        // duplicating them. A grant that arrives while we are NOT already
        // controller (contested claim, reclaim after revoke, failover) still
        // promotes normally.
        if (isController === true) {
          controlLog('[control] control-granted while already controller — ignoring redundant grant');
          break;
        }
        // A grant always means a real transfer happened (never sent for a
        // fresh connect to a genuinely idle slot) — evidence of a peer.
        knownControlPeer = true;
        controlLog(`[control] control-granted, sessions=${(msg.sessions||[]).length}`);
        isController = true;
        promoteToController(msg.sessions || []);
        break;

      case 'control-revoked':
        controlLog(`[control] control-revoked by=${msg.by}`);
        isController = false;
        knownControlPeer = true; // someone else just took the slot from us
        demoteFromController(msg.by || 'another client');
        break;

      case 'release-ack':
        if (pendingReleaseAck) { const f = pendingReleaseAck; pendingReleaseAck = null; f(); }
        break;

      case 'open-tab': {
        // assigned: the server picked this instance, so open it even if the
        // addressed window is gone. Unassigned (older server) keeps the
        // broadcast rules: the window's owner, or the controller if unaddressed.
        const state = resolveOpenTabWindow(windows, msg, isController);
        if (!state) break;
        if (msg.requestId && ws.readyState === WS.OPEN) {
          ws.send(JSON.stringify({ type: 'open-tab-ack', requestId: msg.requestId, windowId: state.win.id }));
        }
        // The server's URL points at ITS localhost; rebuild it on our own
        // server base (remote mode adds the key via withLoadSuffix).
        const url = rebaseOpenTabUrl(msg.url, BASE_URL);
        controlLog(`[control] open-tab request=${msg.requestId} window=${state.win.id} assigned=${!!msg.assigned}`);
        createTab(state, url, msg.title, !!msg.pinned, !!msg.background, !!msg.muted);
        break;
      }

      case 'settings-updated': {
        const theme = getThemeData();
        for (const state of windows.values()) {
          if (state.tabBarView && !state.tabBarView.webContents.isDestroyed()) {
            state.tabBarView.webContents.send('settings-updated');
          }
          if (!state.win.isDestroyed()) {
            state.win.setTitleBarOverlay({ color: theme.ui.deepBg || theme.ui.tabBarBg, symbolColor: theme.terminal.foreground, height: TAB_BAR_HEIGHT });
            if (!state.tabBarExpanded) state.tabBarView.setBackgroundColor(theme.ui.deepBg || theme.ui.tabBarBg);
          }
        }
        break;
      }

      case 'rename-tab': {
        const wantedSid = msg.sessionId;
        const windowId = msg.windowId != null ? parseInt(msg.windowId, 10) : null;
        const states = windowId != null
          ? (windows.has(windowId) ? [windows.get(windowId)] : [])
          : [...windows.values()];
        const trimmed = typeof msg.title === 'string' ? msg.title.trim() : '';
        for (const state of states) {
          for (const tab of state.tabs) {
            if (tab.view.webContents.isDestroyed()) continue;
            tab.view.webContents.executeJavaScript('window._sessionId').then(sid => {
              if (sid !== wantedSid) return;
              tab.customTitle = trimmed || null;
              sendTabsUpdate(state);
            }).catch(() => {});
          }
        }
        break;
      }

      case 'close-tab': {
        const wantedSid = msg.sessionId;
        const windowId = msg.windowId != null ? parseInt(msg.windowId, 10) : null;
        const states = windowId != null
          ? (windows.has(windowId) ? [windows.get(windowId)] : [])
          : [...windows.values()];
        for (const state of states) {
          for (const tab of state.tabs) {
            if (tab.view.webContents.isDestroyed()) continue;
            tab.view.webContents.executeJavaScript('window._sessionId').then(sid => {
              if (sid !== wantedSid) return;
              closeTab(state, tab.id);
            }).catch(() => {});
          }
        }
        break;
      }

    }
  });

  ws.on('close', (code, reason) => {
    controlLog(`[control] WS close: code=${code} reason=${reason}`);
    controlWs = null;
    if (!quitting) setTimeout(connectControlWs, 2000);
  });

  ws.on('error', (err) => {
    controlLog(`[control] WS error: ${err.message}`);
  });
}

// Tell the server which windows this instance owns, so open-tab requests go
// to the right instance and fall back when an addressed window is gone.
function reportControlWindows() {
  if (!controlWs || controlWs.readyState !== 1) return;
  try {
    controlWs.send(JSON.stringify({ type: 'control-windows', windowIds: [...windows.keys()] }));
  } catch (e) {
    controlLog(`[control] control-windows send failed: ${e.message}`);
  }
}

// app.relaunch() doesn't work reliably with renamed Electron binaries on
// Windows. Spawn a new instance explicitly before quitting.
function relaunchApp() {
  restarting = true;
  require('child_process').spawn(process.execPath, process.argv.slice(1), {
    detached: true, stdio: 'ignore', cwd: __dirname,
  }).unref();
  app.quit();
}

function onControlReady(sessions, controller) {
  const state = windows.values().next().value;
  if (!state) return;

  // Only this process's very first control-ready bootstraps by creating tabs
  // (or loading favorites) directly. Every control-ready after that — a
  // locked window being promoted via reconnect, or a plain WS reconnect that
  // still holds live tabs for these sessions (ws.on('close')'s automatic
  // setTimeout(connectControlWs, 2000)) — must go through the full promote/
  // reconcile path instead of blindly (re-)creating tabs, which would
  // duplicate tabs that survived a demotion or a dropped socket.
  const isFirstControlReady = !controlBootstrapped;
  controlBootstrapped = true;

  if (isController === false) {
    // A remote client (or, in remote mode, the server's own GUI) holds control:
    // start locked. Tabs arrive via reconcile when control is granted.
    demoteFromController(controller?.by || 'another client');
    return;
  }

  if (!isFirstControlReady) {
    promoteToController(sessions);
    return;
  }

  if (sessions.length > 0) {
    // Reconnect to sessions (post-restart locally, or all sessions in remote mode)
    for (const session of sessions) {
      const name = session.cwd ? path.basename(session.cwd) : `Session ${session.id}`;
      const cwdParam = session.cwd ? `&cwd=${encodeURIComponent(session.cwd)}` : '';
      createTab(state, `${BASE_URL}/?sessionId=${session.id}${cwdParam}`, name, false, true, false, false, {
        agent: session.agentId || null,
        sessionId: session.id,
      });
    }
  } else if (!isRemoteMode) {
    // Fresh local start with no existing sessions — open favorites
    loadFavorites(state);
  }
}

// ── Lock overlay: shown while another control client holds the controller slot ──

function showLockOverlay(state, by) {
  if (state.win.isDestroyed()) return;
  if (state.lockView) {
    // already locked — refresh who holds control
    state.lockView.webContents.loadFile(path.join(__dirname, 'public', 'lock.html'), { query: { by } });
    return;
  }
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  state.lockView = view;
  state.win.contentView.addChildView(view); // added last → topmost, swallows all input
  const { width, height } = state.win.getContentBounds();
  view.setBounds({ x: 0, y: 0, width, height });
  view.webContents.loadFile(path.join(__dirname, 'public', 'lock.html'), { query: { by } });
  view.webContents.focus();
}

function hideLockOverlay(state) {
  if (!state.lockView) return;
  if (!state.win.isDestroyed()) state.win.contentView.removeChildView(state.lockView);
  if (!state.lockView.webContents.isDestroyed()) state.lockView.webContents.close();
  state.lockView = null;
}

// Bring this instance's tabs in line with the server's session list after a
// promotion: close tabs whose sessions died while we were locked, open tabs
// for sessions the other side created. Untouched tabs keep their live views.
async function reconcileTabs(sessions) {
  const state = windows.values().next().value;
  if (!state) return;
  const wanted = new Map(sessions.map(s => [s.id, s]));
  const seen = new Set();
  for (const st of windows.values()) {
    for (const tab of [...st.tabs]) {
      if (tab.view.webContents.isDestroyed()) continue;
      // Prefer the synchronously-tracked id set at createTab time: the
      // renderer only sets window._sessionId after its page finishes loading,
      // so a tab created moments ago (e.g. by this same control-ready/grant
      // pair) can still be mid-load here and would otherwise look like "no
      // session tab yet", causing a duplicate to be created below.
      let sid = tab.sessionId;
      if (sid == null) {
        try { sid = await tab.view.webContents.executeJavaScript('window._sessionId'); } catch {}
      }
      if (sid == null) continue; // not a session tab (landing page etc.) — leave it
      if (wanted.has(sid)) {
        if (seen.has(sid)) {
          closeTab(st, tab.id); // duplicate viewer of the same session
        } else {
          seen.add(sid);
        }
      } else {
        closeTab(st, tab.id);
      }
    }
  }
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    const name = session.cwd ? path.basename(session.cwd) : `Session ${session.id}`;
    const cwdParam = session.cwd ? `&cwd=${encodeURIComponent(session.cwd)}` : '';
    createTab(state, `${BASE_URL}/?sessionId=${session.id}${cwdParam}`, name, false, true, false, false, {
      agent: session.agentId || null,
      sessionId: session.id,
    });
  }
}

function demoteFromController(by) {
  unregisterShortcuts();
  for (const state of windows.values()) showLockOverlay(state, by);
}

async function promoteToController(sessions) {
  registerShortcutsIfFocused();
  for (const state of windows.values()) hideLockOverlay(state);
  await reconcileTabs(sessions);
}

function getProjectAgentMap() {
  try {
    const f = path.join(__dirname, 'data', 'projects.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (err) {
    console.error('Failed to read projects.json:', err);
  }
  return {};
}

function getDefaultAgent() {
  try {
    const f = path.join(__dirname, 'data', 'settings.json');
    if (fs.existsSync(f)) {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (typeof s.defaultAgent === 'string' && s.defaultAgent) return s.defaultAgent;
    }
  } catch (err) {
    console.error('Failed to read settings.json:', err);
  }
  return 'claude';
}

// One-time migration: if this install replaced a cc-tabs install, adopt its data.
function migrateLegacyData() {
  try {
    const dataDir = path.join(__dirname, 'data');
    if (fs.existsSync(path.join(dataDir, 'settings.json'))) return; // already have data
    const legacyDir = path.join(path.dirname(__dirname), 'cc-tabs', 'data');
    if (path.resolve(legacyDir) === path.resolve(dataDir)) return;  // dev checkout named cc-tabs
    if (!fs.existsSync(legacyDir)) return;
    fs.mkdirSync(dataDir, { recursive: true });
    for (const f of fs.readdirSync(legacyDir)) {
      if (!f.endsWith('.json')) continue;
      const dest = path.join(dataDir, f);
      if (!fs.existsSync(dest)) fs.copyFileSync(path.join(legacyDir, f), dest);
    }
    console.log('Migrated settings from legacy cc-tabs data directory');
  } catch (err) {
    console.error('Legacy data migration failed:', err);
  }
}

function loadFavorites(state) {
  try {
    const favFile = path.join(__dirname, 'data', 'favorites.json');
    if (fs.existsSync(favFile)) {
      const favs = JSON.parse(fs.readFileSync(favFile, 'utf8'));
      const agentMap = getProjectAgentMap();
      const fallback = getDefaultAgent();
      for (const cwd of favs) {
        if (!fs.existsSync(cwd)) continue;
        const name = path.basename(cwd);
        const agent = agentMap[path.resolve(cwd)]?.agent || fallback;
        createTab(state, `${BASE_URL}/?cwd=${encodeURIComponent(cwd)}&agent=${encodeURIComponent(agent)}`, name, false, true);
      }
    }
  } catch (err) {
    console.error('Failed to load favorites:', err);
  }
}

// ── Window creation ──

function createWindow(opts = {}) {
  const themeData = getThemeData();
  const win = new BaseWindow({
    width: opts.width || 1200,
    height: opts.height || 800,
    x: opts.x,
    y: opts.y,
    show: opts.show !== false,
    backgroundColor: themeData.terminal.background,
    title: 'ai-tabs',
    icon: APP_ICON,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: themeData.ui.deepBg || themeData.ui.tabBarBg,
      symbolColor: themeData.terminal.foreground,
      height: TAB_BAR_HEIGHT,
    },
  });

  const tabBarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  tabBarView.setBackgroundColor(themeData.ui.deepBg || themeData.ui.tabBarBg);
  win.contentView.addChildView(tabBarView);
  tabBarView.webContents.loadFile(path.join(__dirname, 'tab-bar.html'));

  const state = { win, tabBarView, tabs: [], activeTabId: null, tabBarExpanded: false, _raisedTabId: null, lockView: null };
  const winId = win.id; // capture before destruction
  windows.set(winId, state);
  reportControlWindows();

  if (isController === false) showLockOverlay(state, 'another client');

  const layout = () => {
    if (quitting || win.isDestroyed()) return;
    layoutViews(state);
  };
  win.on('resize', layout);
  win.on('restore', layout);
  win.on('maximize', layout);
  win.on('unmaximize', layout);
  win.on('show', layout);

  win.on('focus', () => {
    if (quitting || win.isDestroyed()) return;
    win.flashFrame(false);
    registerShortcuts();
  });

  win.on('blur', () => {
    if (quitting) return;
    unregisterShortcuts();
  });

  // quitting is only set by before-quit (app shutdown), not individual window closes.
  // Otherwise closing a dragged window during merge would block sendTabsUpdate globally.

  // Warn before closing if any agent sessions are still running
  let closeConfirmed = false;
  win.on('close', (e) => {
    if (quitting || closeConfirmed) return;
    const agentTabs = state.tabs.filter(t => t.agent && !t.locked);
    if (agentTabs.length === 0) return;

    e.preventDefault();
    Promise.all(agentTabs.map(t => {
      const wc = t.view.webContents;
      if (wc.isDestroyed()) return true;
      return wc.executeJavaScript('!!window._processExited').catch(() => true);
    })).then(results => {
      const active = results.filter(exited => !exited).length;
      if (active === 0) { closeConfirmed = true; win.close(); return; }
      const s = active === 1 ? 'session' : 'sessions';
      dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Cancel', 'Close anyway'],
        defaultId: 0,
        cancelId: 0,
        title: 'Active agent sessions',
        message: `You have ${active} running agent ${s}.\nAre you sure you want to close?`,
      }).then(({ response }) => {
        if (response === 1) { closeConfirmed = true; win.close(); }
      });
    });
  });

  win.on('closed', () => {
    // Kill sessions belonging to this window unless we're restarting (they survive),
    // quitting app-wide (shutdown handles everything), or in remote mode (sessions
    // live on another machine and should keep running when the laptop disconnects).
    // Also skip if we're not the controller, or if a peer control client is known
    // to have ever been attached (knownControlPeer): Electron window ids restart
    // at 1 in every process, so a second local ai-tabs process's window can carry
    // the same numeric id as this one, and the server kills sessions by that
    // string-matched windowId — calling kill-sessions in that situation can wipe
    // out the OTHER process's sessions too, not just this window's own. A false
    // positive here just skips a cleanup (an orphan-timer on the server will
    // eventually catch genuinely abandoned sessions); a false negative destroys
    // live terminals, so this stays conservative.
    if (!restarting && !quitting && !isRemoteMode && isController === true && !knownControlPeer) {
      fetch(`http://localhost:${PORT}/api/windows/${winId}/kill-sessions`, { method: 'POST' }).catch(() => {});
    }
    hideLockOverlay(state);
    windows.delete(winId);
    reportControlWindows();
    // Destroy ghost overlay when last user window closes so app can quit
    if (windows.size === 0 && ghostWin && !ghostWin.isDestroyed()) {
      ghostWin.destroy();
      ghostWin = null;
    }
  });

  layout();
  return state;
}

function layoutViews(state) {
  if (!state.win || state.win.isDestroyed()) return;
  const { width, height } = state.win.getContentBounds();

  const tabBarH = state.tabBarExpanded ? height : TAB_BAR_HEIGHT;
  state.tabBarView.setBounds({ x: 0, y: 0, width, height: tabBarH });

  // All tabs get full bounds so xterm gets correct dimensions.
  const contentBounds = { x: 0, y: TAB_BAR_HEIGHT, width, height: height - TAB_BAR_HEIGHT };
  for (const tab of state.tabs) {
    tab.view.setBounds(contentBounds);
  }

  // Raise active tab + tab bar only when the active tab has CHANGED (i.e. tab switch).
  // removeChildView/addChildView forces Electron to repaint but also drops keyboard
  // focus.  Doing it on every resize/maximize/background-tab-create was the root cause
  // of the recurring "blinking tab steals focus" bug — the active tab was briefly
  // detached and keystrokes were lost.  Repaints during resize are handled by setBounds
  // above; switchTab still does the full raise when the user actually switches tabs.
  // Raise active tab and tab bar to top of z-order.
  const activeTab = state.tabs.find(t => t.id === state.activeTabId);
  if (activeTab) {
    state.win.contentView.removeChildView(activeTab.view);
    state.win.contentView.addChildView(activeTab.view);
  }
  state.win.contentView.removeChildView(state.tabBarView);
  state.win.contentView.addChildView(state.tabBarView);

  // Lock overlay stays full-window and above everything, including the tab bar.
  if (state.lockView) {
    state.lockView.setBounds({ x: 0, y: 0, width, height });
    state.win.contentView.removeChildView(state.lockView);
    state.win.contentView.addChildView(state.lockView);
  }
}

// ── Find which window state a tab belongs to ──

function findTabWindow(tabId) {
  for (const state of windows.values()) {
    if (state.tabs.some(t => t.id === tabId)) return state;
  }
  return null;
}

function findStateByWebContentsId(wcId) {
  for (const state of windows.values()) {
    if (state.tabBarView.webContents.id === wcId) return state;
  }
  return null;
}

// ── Tab management ──

// Pass windowId via URL hash (not query param) — query params in loadURL trigger
// an Electron bug that kills the tab bar's page load.  Hash is parsed client-side
// and doesn't affect the HTTP request.
function withLoadSuffix(url, state, background) {
  const keyParam = isRemoteMode ? `&key=${remoteServerKey}` : '';
  return url + (url.includes('#') ? '&' : '#') + 'windowId=' + state.win.id
    + (background ? '&bg=1' : '') + keyParam;
}

function createTab(state, url, title, pinned = false, background = false, muted = false, locked = false, meta = {}) {
  const themeData = getThemeData();
  const id = nextTabId++;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'term-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  view.setBackgroundColor(themeData.terminal.background);

  // Reconnected tabs carry no launch params in their URL, so the server-supplied
  // agent id (meta.agent) is what keeps their colored dot after a restart.
  const agentMatch = url.match(/[?&]agent=([A-Za-z0-9_-]+)/);
  const tabAgent = (agentMatch ? agentMatch[1] : (/[?&]claude=1/.test(url) ? 'claude' : null))
    || meta.agent || null;
  const tab = {
    id, view, title: title || 'Loading...', customTitle: title || null, pinned,
    flashing: false, idle: false, lastIdleFalseAt: 0, muted: !!muted, locked: !!locked, agent: tabAgent,
    newMedia: 0,
    // Known synchronously only for tabs created from a session the server
    // already told us about (reconnect/reconcile). null for a freshly
    // launched session tab until the renderer reports window._sessionId —
    // reconcileTabs falls back to that async probe when this is null.
    sessionId: meta.sessionId != null ? meta.sessionId : null,
  };
  if (debugLog._enabled) debugLog(`[create] tab=${id} pinned=${!!pinned} bg=${!!background} url=${JSON.stringify(url)}`);
  if (pinned) {
    const pinnedCount = state.tabs.filter(t => t.pinned).length;
    state.tabs.splice(pinnedCount, 0, tab);
  } else {
    state.tabs.push(tab);
  }

  bindTabToState(tab, state);

  view.webContents.loadURL(withLoadSuffix(url, state, background));

  // Background tabs go at z-index 0 (bottom) so they don't disrupt focus.
  // Foreground tabs go on top — switchTab will raise + focus them.
  if (background) {
    state.win.contentView.addChildView(view, 0);
    // Restore focus immediately — addChildView can briefly shift Electron focus.
    // Do NOT call layoutViews here: its removeChildView/addChildView on the active
    // tab and tab bar is the main source of focus disruption for background tabs.
    // Instead, just size the new view directly.
    if (!state.win.isDestroyed()) {
      const { width, height } = state.win.getContentBounds();
      view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width, height: height - TAB_BAR_HEIGHT });
    }
    const activeTab = state.tabs.find(t => t.id === state.activeTabId);
    if (activeTab && !activeTab.view.webContents.isDestroyed() && state.win.isFocused()) {
      activeTab.view.webContents.focus();
    }
    sendTabsUpdate(state);
  } else {
    state.win.contentView.addChildView(view);
    switchTab(state, id);
  }

  return id;
}

function switchTab(state, id) {
  const tab = state.tabs.find(t => t.id === id);
  if (!tab) return;

  const _from = state.activeTabId;
  state.activeTabId = id;
  if (debugLog._enabled) debugLog(`[switch] from=${_from} to=${id} cleared_flashing=${!!tab.flashing}`);
  tab.flashing = false;

  layoutViews(state);
  if (state.win.isFocused()) {
    tab.view.webContents.focus();
  }
  // Refit + focus via executeJavaScript — no preload/IPC needed on terminal views.
  // webContents.focus() above also fires the renderer's window 'focus' event
  // which calls term.focus(), but executeJavaScript handles the fit + resize too.
  tab.view.webContents.executeJavaScript(
    'if(window._activateTab)window._activateTab()'
  ).catch(() => {});
  sendTabsUpdate(state);
}

function closeTab(state, id) {
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx === -1) return;

  const tab = state.tabs[idx];
  if (tab.locked) return;

  // Send kill via JS before destroying — beforeunload alone is unreliable
  const wc = tab.view.webContents;
  if (!wc.isDestroyed()) {
    wc.executeJavaScript(
      `(() => { try { if (window._ws && window._ws.readyState === WebSocket.OPEN) window._ws.send(JSON.stringify({type:'kill'})); } catch(e){} })()`
    ).catch(() => {});
  }

  state.win.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  state.tabs.splice(idx, 1);

  if (state.tabs.length === 0) {
    state.win.close();
    return;
  }

  if (state.activeTabId === id) {
    const newIdx = Math.min(idx, state.tabs.length - 1);
    if (state.tabs[newIdx]) switchTab(state, state.tabs[newIdx].id);
  }

  sendTabsUpdate(state);
}

function moveTab(state, fromIndex, toIndex) {
  if (fromIndex === toIndex) return;
  if (fromIndex < 0 || fromIndex >= state.tabs.length) return;
  if (toIndex < 0 || toIndex >= state.tabs.length) return;

  // Pinned and unpinned tabs can only reorder within their own section
  if (state.tabs[fromIndex].pinned !== state.tabs[toIndex].pinned) return;
  // Locked tabs cannot be moved
  if (state.tabs[fromIndex].locked || state.tabs[toIndex].locked) return;

  const [tab] = state.tabs.splice(fromIndex, 1);
  state.tabs.splice(toIndex, 0, tab);
  sendTabsUpdate(state);
}

function detachTab(state, tabId, screenX, screenY) {
  const tabIndex = state.tabs.findIndex(t => t.id === tabId);
  if (tabIndex < 0) return;
  const tab = state.tabs[tabIndex];
  if (tab.pinned) return;

  const sourceWinId = state.win.id;

  // Remove from source window
  state.win.contentView.removeChildView(tab.view);
  state.tabs.splice(tabIndex, 1);

  const sourceEmpty = state.tabs.length === 0;

  if (!sourceEmpty) {
    if (state.activeTabId === tabId) {
      const newIdx = Math.min(tabIndex, state.tabs.length - 1);
      if (state.tabs[newIdx]) switchTab(state, state.tabs[newIdx].id);
    } else {
      sendTabsUpdate(state);
    }
  }

  // Check if drop position is over another existing window → merge
  for (const [winId, targetState] of windows) {
    if (winId === sourceWinId) continue;
    if (targetState.win.isDestroyed()) continue;
    const bounds = targetState.win.getBounds();
    if (screenX >= bounds.x && screenX <= bounds.x + bounds.width &&
        screenY >= bounds.y && screenY <= bounds.y + bounds.height) {
      bindTabToState(tab, targetState);
      // Insert at the tracked position if the drop is on this window's tab bar
      if (foreignDragTarget && foreignDragTarget.winId === winId && foreignDragTarget.insertIndex >= 0) {
        const idx = Math.min(foreignDragTarget.insertIndex, targetState.tabs.length);
        targetState.tabs.splice(idx, 0, tab);
      } else {
        targetState.tabs.push(tab);
      }
      foreignDragTarget = null;
      targetState.win.contentView.addChildView(tab.view);
      notifyWindowChange(tab, targetState);
      switchTab(targetState, tab.id);
      targetState.win.focus();
      if (sourceEmpty && !state.win.isDestroyed()) state.win.close();
      return;
    }
  }

  foreignDragTarget = null;

  // Otherwise create new window at the drop position
  const newState = createWindow({
    width: 1000,
    height: 700,
    x: screenX - 500,
    y: screenY - 20,
  });

  bindTabToState(tab, newState);
  newState.tabs.push(tab);
  newState.win.contentView.addChildView(tab.view);
  notifyWindowChange(tab, newState);
  switchTab(newState, tab.id);
  if (sourceEmpty && !state.win.isDestroyed()) state.win.close();
}

/** Notify the tab's web content (and hence the server) that it moved to a new window. */
function notifyWindowChange(tab, state) {
  if (tab.view.webContents.isDestroyed()) return;
  const winId = state.win.id;
  tab.view.webContents.executeJavaScript(
    `if(window.__aiTabsWs&&window.__aiTabsWs.readyState===1)` +
    `window.__aiTabsWs.send(JSON.stringify({type:'update-window-id',windowId:${winId}}))`
  ).catch(() => {});
}

// ── Desktop notifications ──
// Lazily built so Electron's Notification is only touched after app ready.
let desktopNotifier = null;
function getDesktopNotifier() {
  if (!desktopNotifier) desktopNotifier = createDesktopNotifier({ Notification, log: debugLog });
  return desktopNotifier;
}

/**
 * Raise an OS toast for a tab entering an attention episode. Decision logic is
 * lib/desktop-notify.shouldNotify; this only gathers the inputs and reacts.
 * @param {object} tab
 * @param {object} state window state owning the tab
 * @param {boolean} episodeStart debounced rising edge into idle
 */
function maybeNotifyAttention(tab, state, episodeStart) {
  if (state.win.isDestroyed() || tab.view.webContents.isDestroyed()) return;
  const enabled = readSettings().notifications?.desktop !== false;
  const ok = shouldNotify({
    enabled,
    muted: !!tab.muted,
    active: tab.id === state.activeTabId,
    windowFocused: state.win.isFocused(),
    episodeStart,
  });
  if (!ok) return;
  const agentName = tab.agent ? (agents.getAgent(tab.agent)?.name || tab.agent) : null;
  const title = tab.customTitle || tab.title || 'ai-tabs';
  // The terminal page stashes the hook reason before it flips the title, so
  // reading it back here is ordered after the write that triggered us.
  tab.view.webContents.executeJavaScript('window._attentionReason').catch(() => null)
    .then((reason) => {
      if (state.win.isDestroyed()) return;
      getDesktopNotifier().notify({
        title,
        body: describeAttention(reason, agentName),
        icon: APP_ICON,
        onClick: () => focusTabFromNotification(state, tab.id),
      });
    });
}

/** Notification click: bring the window forward and land on the tab. */
function focusTabFromNotification(state, tabId) {
  if (state.win.isDestroyed()) return;
  if (state.win.isMinimized()) state.win.restore();
  state.win.show();
  state.win.focus();
  switchTab(state, tabId);
  // switchTab only calls webContents.focus() when the window already reports
  // focus; on Windows the OS grants it a beat later, so refocus then too —
  // webContents.focus() alone doesn't restore xterm input, _activateTab does.
  if (!state.win.isFocused()) {
    state.win.once('focus', () => {
      const tab = state.tabs.find(t => t.id === tabId);
      if (!tab || tab.view.webContents.isDestroyed() || state.activeTabId !== tabId) return;
      tab.view.webContents.focus();
      tab.view.webContents.executeJavaScript('if(window._activateTab)window._activateTab()').catch(() => {});
    });
  }
}

function bindTabToState(tab, state) {
  tab.view.webContents.removeAllListeners('page-title-updated');
  tab.view.webContents.removeAllListeners('will-navigate');
  tab.view.webContents.removeAllListeners('focus');

  // Prevent non-active tabs from stealing focus (xterm.js, page loads, etc.)
  // webContents.focus() triggers the renderer's window 'focus' event → term.focus()
  tab.view.webContents.on('focus', () => {
    if (tab.id === state.activeTabId) return;
    if (state.win.isDestroyed() || !state.win.isFocused()) return;
    const active = state.tabs.find(t => t.id === state.activeTabId);
    if (active && !active.view.webContents.isDestroyed()) {
      active.view.webContents.focus();
    }
  });

  tab.view.webContents.on('page-title-updated', (e, newTitle) => {
    if (quitting) return;
    const _wasIdle = tab.idle, _wasFlashing = tab.flashing;
    if (debugLog._enabled) {
      debugLog(`[title-raw] tab=${tab.id} pinned=${!!tab.pinned} active=${tab.id===state.activeTabId} idle=${tab.idle} flashing=${tab.flashing} title=${JSON.stringify(newTitle)}`);
    }
    const isIdle = newTitle.includes('>>>');
    // Track when idle becomes false so we can require a sustained non-idle period
    // before allowing flashing to re-arm. ConPTY emits transient title flaps that
    // briefly drop ">>>"; without this debounce, those re-arm flashing on every flap.
    if (tab.idle && !isIdle) tab.lastIdleFalseAt = Date.now();
    const nonIdleMs = tab.lastIdleFalseAt ? Date.now() - tab.lastIdleFalseAt : Number.MAX_SAFE_INTEGER;
    const REARM_DEBOUNCE_MS = 750;

    if (tab.pinned) {
      // Locked home tab keeps its assigned title — it has no PTY
      if (tab.locked) { sendTabsUpdate(state); return; }
      const cleaned = cleanIdleTitle(newTitle);
      if (cleaned) tab.title = cleaned;
      const wasIdle = tab.idle;
      tab.idle = isIdle;
      if (tab.idle && !wasIdle && !tab.muted) {
        if (tab.id !== state.activeTabId && !tab.flashing) {
          if (nonIdleMs >= REARM_DEBOUNCE_MS) {
            tab.flashing = true;
          } else if (debugLog._enabled) {
            debugLog(`[debounce] tab=${tab.id} pinned suppressed flash, non-idle window only ${nonIdleMs}ms`);
          }
        }
        if (!state.win.isDestroyed() && !state.win.isFocused()) {
          if (debugLog._enabled) debugLog(`[flashFrame] tab=${tab.id} pinned`);
          state.win.flashFrame(true);
        }
        maybeNotifyAttention(tab, state, nonIdleMs >= REARM_DEBOUNCE_MS);
      }
      if (debugLog._enabled && (tab.idle !== _wasIdle || tab.flashing !== _wasFlashing)) {
        debugLog(`[title] tab=${tab.id} pinned active=${tab.id===state.activeTabId} idle=${_wasIdle}->${tab.idle} flashing=${_wasFlashing}->${tab.flashing} nonIdleMs=${nonIdleMs} title=${JSON.stringify(newTitle)}`);
      }
      sendTabsUpdate(state);
      return;
    }
    tab.idle = isIdle;
    if (isIdle) {
      tab.title = cleanIdleTitle(newTitle);
      if (!tab.muted) {
        if (tab.id !== state.activeTabId && !tab.flashing) {
          if (nonIdleMs >= REARM_DEBOUNCE_MS) {
            tab.flashing = true;
          } else if (debugLog._enabled) {
            debugLog(`[debounce] tab=${tab.id} suppressed flash, non-idle window only ${nonIdleMs}ms`);
          }
        }
        if (!state.win.isDestroyed() && !state.win.isFocused()) {
          if (debugLog._enabled) debugLog(`[flashFrame] tab=${tab.id}`);
          state.win.flashFrame(true);
        }
        // Rising edge only (past the flap debounce) — one toast per episode.
        maybeNotifyAttention(tab, state, !_wasIdle && nonIdleMs >= REARM_DEBOUNCE_MS);
      }
    } else {
      tab.title = newTitle;
    }
    if (debugLog._enabled && (tab.idle !== _wasIdle || tab.flashing !== _wasFlashing)) {
      debugLog(`[title] tab=${tab.id} active=${tab.id===state.activeTabId} idle=${_wasIdle}->${tab.idle} flashing=${_wasFlashing}->${tab.flashing} nonIdleMs=${nonIdleMs} title=${JSON.stringify(newTitle)}`);
    }
    sendTabsUpdate(state);
  });
  tab.view.webContents.setWindowOpenHandler(({ url: newUrl, disposition }) => {
    // External URLs open in the default browser
    if (!isAppUrl(newUrl)) {
      openInBrowser(newUrl);
      return { action: 'deny' };
    }
    // Ctrl+click / middle-click = 'background-tab' → open without switching
    const background = (disposition === 'background-tab');
    createTab(state, newUrl, null, false, background);
    return { action: 'deny' };
  });
  // Prevent in-page navigation to external URLs (links without target="_blank")
  tab.view.webContents.on('will-navigate', (e, navUrl) => {
    if (!isAppUrl(navUrl)) {
      e.preventDefault();
      openInBrowser(navUrl);
    }
  });
}

function sendTabsUpdate(state) {
  if (quitting) return;
  if (!state.tabBarView || state.tabBarView.webContents.isDestroyed()) return;
  const tabData = state.tabs.map(t => ({
    id: t.id,
    title: t.customTitle || t.title,
    pinned: t.pinned,
    locked: t.locked || false,
    flashing: t.flashing,
    muted: t.muted,
    active: t.id === state.activeTabId,
    agentColor: t.agent ? ((agents.getAgent(t.agent) || {}).color || '#888888') : null,
    newMedia: t.newMedia || 0,
  }));
  state.tabBarView.webContents.send('tabs-updated', tabData);
}

// ── IPC handlers ──

// Let renderers check whether they are the active tab (used to gate term.focus()
// so background tabs never steal focus on load).
ipcMain.handle('is-active-tab', (e) => {
  for (const state of windows.values()) {
    const tab = state.tabs.find(t => t.view.webContents.id === e.sender.id);
    if (tab) return tab.id === state.activeTabId;
  }
  return false;
});

// Media panel badge: the terminal page reports how many images arrived while
// its panel was collapsed; the tab bar draws the count next to the title.
ipcMain.on('media-badge', (e, count) => {
  const n = Math.max(0, Number(count) || 0);
  for (const state of windows.values()) {
    const tab = state.tabs.find(t => t.view.webContents.id === e.sender.id);
    if (!tab) continue;
    if (tab.newMedia === n) return;
    tab.newMedia = n;
    sendTabsUpdate(state);
    return;
  }
});

ipcMain.on('claim-control', () => {
  if (controlWs && controlWs.readyState === 1) {
    controlWs.send(JSON.stringify({ type: 'claim-control' }));
  }
});

ipcMain.on('tab-create', (e, urlOrOpts) => {
  const state = findStateByWebContentsId(e.sender.id);
  if (!state) return;
  if (typeof urlOrOpts === 'object' && urlOrOpts !== null) {
    const { url, pinned, background, muted } = urlOrOpts;
    createTab(state, url || BASE_URL, null, !!pinned, !!background, !!muted);
  } else {
    createTab(state, urlOrOpts || BASE_URL);
  }
});

ipcMain.on('tab-switch', (e, id) => {
  const state = findTabWindow(id);
  if (state) switchTab(state, id);
});

ipcMain.on('tab-close', (e, id) => {
  const state = findTabWindow(id);
  if (state) closeTab(state, id);
});

ipcMain.on('tab-mute', (e, id) => {
  const state = findTabWindow(id);
  if (!state) return;
  const tab = state.tabs.find(t => t.id === id);
  if (!tab) return;
  tab.muted = !tab.muted;
  if (tab.muted) tab.flashing = false;
  sendTabsUpdate(state);
});

ipcMain.on('tab-rename', (e, id, newTitle) => {
  const state = findTabWindow(id);
  if (!state) return;
  const tab = state.tabs.find(t => t.id === id);
  if (!tab) return;
  const trimmed = typeof newTitle === 'string' ? newTitle.trim() : '';
  tab.customTitle = trimmed || null;
  sendTabsUpdate(state);
});

ipcMain.on('tab-pin', (e, id) => {
  const state = findTabWindow(id);
  if (!state) return;
  const tab = state.tabs.find(t => t.id === id);
  if (!tab || tab.locked) return;

  const idx = state.tabs.indexOf(tab);
  state.tabs.splice(idx, 1);

  if (tab.pinned) {
    // Unpin: place at start of unpinned section
    tab.pinned = false;
    const pinnedCount = state.tabs.filter(t => t.pinned).length;
    state.tabs.splice(pinnedCount, 0, tab);
  } else {
    // Pin: place at end of pinned section
    tab.pinned = true;
    const pinnedCount = state.tabs.filter(t => t.pinned).length;
    state.tabs.splice(pinnedCount, 0, tab);
  }

  sendTabsUpdate(state);
});

ipcMain.on('tab-move', (e, fromIndex, toIndex) => {
  const state = findStateByWebContentsId(e.sender.id);
  if (state) moveTab(state, fromIndex, toIndex);
});

ipcMain.on('tab-detach', (e, tabId, screenX, screenY) => {
  const state = findStateByWebContentsId(e.sender.id);
  if (state) detachTab(state, tabId, screenX, screenY);
});

ipcMain.handle('get-tabs', (e) => {
  const state = findStateByWebContentsId(e.sender.id);
  debugLog(`[get-tabs] called, found state=${!!state}, tabs=${state ? state.tabs.length : 0}`);
  if (!state) return [];
  const result = state.tabs.map(t => ({
    id: t.id, title: t.customTitle || t.title, pinned: t.pinned,
    locked: t.locked || false, flashing: t.flashing,
    muted: t.muted, active: t.id === state.activeTabId,
    newMedia: t.newMedia || 0,
  }));
  debugLog(`[get-tabs] returning ${result.length} tabs: [${result.map(t=>t.title).join(', ')}]`);
  return result;
});

ipcMain.handle('get-theme', () => getThemeData());

// ── Remote-server connection (Settings → "Connect to a remote server") ──
// These write the LOCAL data/settings.json regardless of which server served
// the page, which is why they live on IPC instead of /api.

ipcMain.handle('remote-config-get', () => ({
  isRemoteMode,
  remoteServer: remoteServerUrl,
  id: launchTarget ? launchTarget.id : null,
  name: launchTarget ? launchTarget.name : null,
}));

// Restart is a property of THIS process, not the server serving the page —
// it must not fan out to other clients of a shared server, which is what the
// old /api/restart broadcast did.
ipcMain.handle('app-restart', (e) => {
  if (!isTrustedSender(e)) return { ok: false };
  setTimeout(relaunchApp, 250);   // let the reply reach the renderer first
  return { ok: true };
});

// ── Clipboard bridge ──
// Chromium hides navigator.clipboard on insecure origins, so a terminal view
// served from a plain-http LAN address has no clipboard API at all — copy and
// paste die there. Electron's clipboard module is origin-independent, so route
// through the main process and let the renderer use this whenever it exists.
ipcMain.handle('clipboard-read', (e) => (isTrustedSender(e) ? clipboard.readText() : ''));

ipcMain.handle('clipboard-write', (e, text) => {
  if (!isTrustedSender(e)) return { ok: false };
  clipboard.writeText(String(text == null ? '' : text));
  return { ok: true };
});

ipcMain.handle('tab-bar-expand', (e) => {
  const state = findStateByWebContentsId(e.sender.id);
  if (!state || state.win.isDestroyed()) return;
  state.tabBarExpanded = true;
  state.tabBarView.setBackgroundColor('#00000000');
  const { width, height } = state.win.getContentBounds();
  state.tabBarView.setBounds({ x: 0, y: 0, width, height });
});

ipcMain.on('tab-bar-collapse', (e) => {
  const state = findStateByWebContentsId(e.sender.id);
  if (!state || state.win.isDestroyed()) return;
  state.tabBarExpanded = false;
  const theme = getThemeData();
  state.tabBarView.setBackgroundColor(theme.ui.deepBg || theme.ui.tabBarBg);
  const { width } = state.win.getContentBounds();
  state.tabBarView.setBounds({ x: 0, y: 0, width, height: TAB_BAR_HEIGHT });
});

// ── Drag ghost overlay (separate window, floats above title bar) ──

ipcMain.on('drag-ghost-show', (e, title, screenX, screenY) => {
  if (!ghostWin || ghostWin.isDestroyed()) createGhostWindow();
  const theme = getThemeData();
  const bg = theme.ui.headerBg || theme.ui.tabBarBg;
  const accent = theme.ui.accent;
  const fg = theme.terminal.foreground;
  ghostWin.setPosition(screenX + 12, screenY - 14);
  ghostWin.webContents.executeJavaScript(
    `(()=>{const g=document.getElementById('g');` +
    `g.textContent=${JSON.stringify(title)};` +
    `g.style.background=${JSON.stringify(bg)};` +
    `g.style.border='1px solid ${accent}';` +
    `g.style.color=${JSON.stringify(fg)};})()`
  ).then(() => {
    if (ghostWin && !ghostWin.isDestroyed()) ghostWin.showInactive();
  }).catch(() => {});
});

ipcMain.on('drag-ghost-move', (e, screenX, screenY) => {
  if (!ghostWin || ghostWin.isDestroyed()) return;
  ghostWin.setPosition(screenX + 12, screenY - 14);
});

ipcMain.on('drag-ghost-hide', () => {
  if (!ghostWin || ghostWin.isDestroyed()) return;
  ghostWin.hide();
});

// ── Drag: hide/show source window for last-tab drag ──

ipcMain.on('hide-for-drag', (e) => {
  const state = findStateByWebContentsId(e.sender.id);
  if (!state || state.win.isDestroyed()) return;
  // Use near-zero opacity instead of 0 — Windows DWM compositing treats
  // fully-transparent owner windows specially and can hide child overlays.
  state.win.setOpacity(0.01);
});

ipcMain.on('show-after-drag', (e) => {
  const state = findStateByWebContentsId(e.sender.id);
  if (!state || state.win.isDestroyed()) return;
  state.win.setOpacity(1);
});

// ── Cross-window tab bar snap during drag ──

ipcMain.on('drag-foreign-move', (e, screenX, screenY) => {
  const sourceState = findStateByWebContentsId(e.sender.id);
  let found = false;

  for (const [winId, targetState] of windows) {
    if (sourceState && targetState.win.id === sourceState.win.id) continue;
    if (targetState.win.isDestroyed()) continue;

    const contentBounds = targetState.win.getContentBounds();
    const clientX = screenX - contentBounds.x;
    const clientY = screenY - contentBounds.y;

    if (clientX >= 0 && clientX <= contentBounds.width &&
        clientY >= 0 && clientY <= TAB_BAR_HEIGHT) {
      // Cursor is over this window's tab bar
      if (foreignDragTarget && foreignDragTarget.winId !== winId) {
        // Left previous target — clear its indicators
        const prevState = windows.get(foreignDragTarget.winId);
        if (prevState && !prevState.tabBarView.webContents.isDestroyed()) {
          prevState.tabBarView.webContents.send('foreign-drag-leave');
        }
      }
      targetState.tabBarView.webContents.send('foreign-drag-over', clientX);
      if (!foreignDragTarget || foreignDragTarget.winId !== winId) {
        foreignDragTarget = { winId, insertIndex: targetState.tabs.length };
      }
      found = true;
      break;
    }
  }

  if (!found && foreignDragTarget) {
    const prevState = windows.get(foreignDragTarget.winId);
    if (prevState && !prevState.tabBarView.webContents.isDestroyed()) {
      prevState.tabBarView.webContents.send('foreign-drag-leave');
    }
    foreignDragTarget = null;
  }
});

ipcMain.on('foreign-drag-index', (e, index) => {
  if (foreignDragTarget) foreignDragTarget.insertIndex = index;
});

ipcMain.on('drag-foreign-end', () => {
  if (foreignDragTarget) {
    const state = windows.get(foreignDragTarget.winId);
    if (state && !state.tabBarView.webContents.isDestroyed()) {
      state.tabBarView.webContents.send('foreign-drag-leave');
    }
    foreignDragTarget = null;
  }
});

// ── Keyboard shortcuts ──

function registerShortcuts() {
  globalShortcut.unregisterAll();

  globalShortcut.register('CommandOrControl+W', () => {
    const win = BaseWindow.getFocusedWindow();
    if (!win) return;
    const state = windows.get(win.id);
    if (state && state.activeTabId) closeTab(state, state.activeTabId);
  });

  globalShortcut.register('Control+Tab', () => cycleTab(1));
  globalShortcut.register('Control+Shift+Tab', () => cycleTab(-1));

  globalShortcut.register('CommandOrControl+T', () => {
    const win = BaseWindow.getFocusedWindow();
    if (!win) return;
    const state = windows.get(win.id);
    if (state) createTab(state, BASE_URL);
  });
}

// globalShortcut is system-wide: registering while another app has focus
// swallows its Ctrl+T/Ctrl+W/Ctrl+Tab. Outside a focus event, register only if
// one of our windows is the focused one; the focus handler covers the rest.
function registerShortcutsIfFocused() {
  const focused = BaseWindow.getFocusedWindow();
  if (focused && windows.has(focused.id)) registerShortcuts();
}

function unregisterShortcuts() {
  globalShortcut.unregisterAll();
}

function cycleTab(direction) {
  const win = BaseWindow.getFocusedWindow();
  if (!win) return;
  const state = windows.get(win.id);
  if (!state || state.tabs.length <= 1) return;
  const currentIdx = state.tabs.findIndex(t => t.id === state.activeTabId);
  const newIdx = (currentIdx + direction + state.tabs.length) % state.tabs.length;
  switchTab(state, state.tabs[newIdx].id);
}

// ── Startup auto-update ──

// Check origin/master before any window opens; if we're behind, fast-forward,
// reinstall deps when needed, and relaunch into the new build. Returns true
// when a relaunch is underway (caller must bail out of startup). Every failure
// path returns false — never block launch on an update problem.
async function runAutoUpdate() {
  if (readSettings().autoUpdate !== true) return false;

  let check;
  try {
    check = await checkForUpdate(__dirname);
  } catch (err) {
    console.warn(`[update] check skipped: ${err.message}`);
    return false;
  }
  if (!check.behind) return false;
  console.log(`[update] ${check.behind} commit(s) behind (${check.from} -> ${check.to}), updating`);

  // Splash only appears once we know an update is real, so normal startups
  // never flash an extra window.
  const splash = createUpdateSplash();
  const setStatus = (text) => {
    if (splash.isDestroyed()) return;
    splash.webContents.executeJavaScript(
      `document.getElementById('s').textContent=${JSON.stringify(text)}`
    ).catch(() => {});
  };

  try {
    await applyUpdate(__dirname, { onStatus: setStatus });
    setStatus('Restarting...');
    return true;
  } catch (err) {
    console.error(`[update] failed, starting current version: ${err.message}`);
    if (!splash.isDestroyed()) splash.destroy();
    return false;
  }
}

function createUpdateSplash() {
  const theme = getThemeData();
  const bg = theme.ui.deepBg || theme.ui.tabBarBg;
  const html = `<!DOCTYPE html><html><head><style>
html,body{margin:0;height:100%;background:${bg};color:${theme.terminal.foreground};
font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
user-select:none;-webkit-app-region:drag}
.box{text-align:center}.title{font-size:15px;font-weight:600;margin-bottom:8px}
#s{font-size:12px;opacity:.75}
.bar{margin:14px auto 0;width:180px;height:3px;border-radius:2px;background:rgba(128,128,128,.25);overflow:hidden}
.bar div{width:40%;height:100%;border-radius:2px;background:${theme.ui.accent || '#8b5cf6'};
animation:slide 1.2s ease-in-out infinite}
@keyframes slide{0%{margin-left:-40%}100%{margin-left:100%}}
</style></head><body><div class="box"><div class="title">Updating ai-tabs</div>
<div id="s">Checking...</div><div class="bar"><div></div></div></div></body></html>`;
  const win = new BrowserWindow({
    width: 340, height: 150, frame: false, resizable: false, show: false,
    backgroundColor: bg, icon: APP_ICON, skipTaskbar: false, alwaysOnTop: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
  return win;
}

// ── Server picker ──
// Shown when no --server argument was given. Runs in its own short-lived
// process: it spawns the bound window, then quits.

let pickerWin = null;

/**
 * Turn a failed remote start into the advice the user actually needs.
 *
 * Keyed off `err.remoteStatus`, which startExpressServer sets: a number is an
 * answer from the server (so the machine is demonstrably reachable and the
 * problem is auth, hostname, or the server itself), while null means nothing
 * answered at all — only then is the raw "cannot reach" message the truth.
 */
function remoteFailureDetail(err) {
  if (err.remoteStatus == null) return err.message;
  if (err.remoteStatus === 401) {
    return 'The server rejected the saved password. In the server picker, remove '
      + 'that server with × and add it again with "+ Add server", entering the '
      + "correct remote-access password.";
  }
  if (err.remoteStatus === 403) {
    let hostname = remoteServerUrl;
    try { hostname = new URL(remoteServerUrl).hostname; } catch {}
    return `The server refused the hostname "${hostname}". Connect using the `
      + "server's IP address, or add this name to extraAllowedHosts in the "
      + "server's data/settings.json and restart the server.";
  }
  return `${remoteServerUrl} answered HTTP ${err.remoteStatus}. Check the server logs `
    + 'on that machine.';
}

function openPicker(notice = null) {
  if (pickerWin && !pickerWin.isDestroyed()) { pickerWin.focus(); return; }
  const themeData = getThemeData();
  pickerWin = new BrowserWindow({
    width: 380,
    height: 460,
    resizable: false,
    title: 'ai-tabs',
    icon: APP_ICON,
    backgroundColor: themeData.ui.deepBg || themeData.ui.tabBarBg,
    webPreferences: {
      preload: path.join(__dirname, 'term-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  pickerWin.setMenuBarVisibility(false);
  pickerWin.loadFile(path.join(__dirname, 'public', 'picker.html'), {
    query: notice ? { notice } : {},
  });
  pickerWin.on('closed', () => { pickerWin = null; });
}

/**
 * Spawn the process for a bound window. Returns the ChildProcess so the
 * caller can wait for either the 'spawn' or 'error' event — spawn failures
 * (ENOENT/EACCES) surface asynchronously, never as a synchronous throw, so a
 * try/catch around spawn() alone cannot detect them.
 */
function spawnServerWindow(id) {
  const args = process.argv.slice(1).filter((a, i, arr) => {
    if (a === '--server' || a.startsWith('--server=')) return false;
    if (arr[i - 1] === '--server') return false; // drop the value token of the space form
    return true;
  });
  return require('child_process').spawn(process.execPath, [...args, `--server=${id}`], {
    detached: true, stdio: 'ignore', cwd: __dirname,
  });
}

// Keys never cross into the renderer — the picker only needs to display names.
ipcMain.handle('picker-list', () => ({
  servers: servers.loadServers(SERVERS_FILE).servers.map(s => ({ id: s.id, name: s.name, url: s.url })),
}));

ipcMain.handle('picker-launch', (e, id) => new Promise((resolve) => {
  if (!isTrustedSender(e)) {
    resolve({ ok: false, error: 'untrusted sender' });
    return;
  }
  let child;
  try {
    child = spawnServerWindow(id);
  } catch (err) {
    resolve({ ok: false, error: err.message });
    return;
  }
  // Do not close the picker or quit until the child is confirmed to have
  // started — a silent quit on a failed spawn would leave no window at all.
  child.once('error', (err) => {
    console.error(`[picker] spawn failed: ${err.message}`);
    resolve({ ok: false, error: err.message });
  });
  child.once('spawn', () => {
    child.unref();
    if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
    // Only quit when this process exists solely to run the picker; when the
    // picker was reopened from a window's tab bar, that window must survive.
    if (!launchTarget) setTimeout(() => app.quit(), 100);
    resolve({ ok: true });
  });
}));

ipcMain.handle('picker-add', async (e, { name, url, key }) => {
  if (!isTrustedSender(e)) return { ok: false, error: 'untrusted sender' };
  let normalized;
  try {
    normalized = servers.normalizeUrl(url, servers.DEFAULT_PORT);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const check = await servers.validateServer(normalized, key);
  if (!check.ok) return check;
  const result = servers.addServer(SERVERS_FILE, { name, url: normalized, key });
  // Never return the key to the renderer, even though it just typed it.
  return result.ok ? { ok: true } : result;
});

ipcMain.handle('picker-remove', (e, id) => ({ ok: isTrustedSender(e) && servers.removeServer(SERVERS_FILE, id) }));

ipcMain.handle('picker-open', () => { openPicker(); return { ok: true }; });

// ── App lifecycle ──

app.whenReady().then(async () => {
  migrateLegacyData();
  servers.seedServersFile(SERVERS_FILE, SETTINGS_FILE);

  // No usable --server: let the picker decide, and stop here. Auto-update
  // deliberately does not run in the picker process — it runs in the bound
  // child, where relaunchApp preserves --server through process.argv.
  if (!launchTarget) {
    const requested = servers.parseServerArg(process.argv);
    openPicker(requested ? 'That server is no longer configured.' : null);
    return;
  }

  if (await runAutoUpdate()) {
    relaunchApp();
    return;
  }

  try {
    await startExpressServer();
  } catch (err) {
    console.error('Failed to start server:', err);
    if (isRemoteMode) {
      // Never clear the binding: a transient network failure must not silently
      // convert this into a local install. The picker stays up showing the
      // reason, and this process survives because launchTarget is set.
      openPicker(remoteFailureDetail(err));
      return;
    }
    dialog.showErrorBox('ai-tabs could not start', err.message);
    app.quit();
    return;
  }

  createGhostWindow();
  const state = createWindow({ show: false });
  const projectsRoot = process.env.PROJECTS_ROOT || path.join(require('os').homedir(), 'Documents', 'Projects');
  createTab(state, BASE_URL, path.basename(projectsRoot), true, false, false, true);

  // Show window once tab bar is painted (local file, near-instant)
  state.tabBarView.webContents.once('did-finish-load', () => {
    if (!state.win.isDestroyed()) state.win.show();
    sendTabsUpdate(state);
  });
  // Safety fallback in case did-finish-load doesn't fire
  setTimeout(() => {
    if (!state.win.isDestroyed() && !state.win.isVisible()) state.win.show();
  }, 2000);

  registerShortcutsIfFocused();
  // Favorites or session-reconnect happen via onControlReady once the control
  // WebSocket handshake completes — avoids a startup race with the server.
  connectControlWs();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (e) => {
  if (quitting) return; // re-entry after async shutdown — let it through
  quitting = true;
  unregisterShortcuts();
  if (ghostWin && !ghostWin.isDestroyed()) { ghostWin.destroy(); ghostWin = null; }

  // Tell the server we're leaving. The server decides: transfer control to a
  // connected peer (keep running) or — sole local controller — shut down with
  // all sessions, exactly like the old /api/shutdown quit. A 3s timeout keeps
  // a dead server from blocking quit.
  if (!restarting && controlWs && controlWs.readyState === 1) {
    e.preventDefault();
    const timer = setTimeout(() => { pendingReleaseAck = null; app.quit(); }, 3000);
    pendingReleaseAck = () => { clearTimeout(timer); app.quit(); };
    try {
      controlWs.send(JSON.stringify({ type: 'release-control' }));
    } catch {
      clearTimeout(timer); pendingReleaseAck = null; app.quit();
    }
  } else if (!restarting && !isRemoteMode && isController === true) {
    // Control WS is down but we're the local controller — fall back to the
    // old HTTP shutdown so sessions don't silently outlive the app.
    e.preventDefault();
    fetch(`http://localhost:${PORT}/api/shutdown`, { method: 'POST' })
      .catch(() => {})
      .finally(() => app.quit());
  }
});
