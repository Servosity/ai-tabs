const express = require('express');
const http = require('http');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const path = require('path');
const QRCode = require('qrcode');

// Debug logging — writes to same file as main.js
function serverDebugLog(msg) {
  try {
    const settingsFile = path.join(__dirname, 'data', 'settings.json');
    if (!fs.existsSync(settingsFile)) return;
    if (!JSON.parse(fs.readFileSync(settingsFile, 'utf8')).debug) return;
    fs.appendFileSync(path.join(__dirname, 'data', 'debug.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}
const { PtyManager } = require('./lib/pty-manager');
const agents = require('./lib/agents');
const projectAgents = require('./lib/project-agents');
const storeMigrate = require('./lib/store-migrate');
const { trashDirSync } = require('./lib/trash');
const { createNotificationRouter } = require('./lib/notification-bridge');
const { createAttentionRouter } = require('./lib/attention-hook');
const commandLaunch = require('./lib/command-launch');
const { pickOpenTabTarget, openTabClaimStatus } = require('./lib/open-tab-routing');
const { MediaStore, MediaManager, createMediaRouter } = require('./lib/media');
const { authMiddleware, authenticateWs, hasPassword, setPassword, verifyPassword, isLocalhost, hostGuard, originGuard } = require('./lib/auth');
const { launchGuard } = require('./lib/launch-guard');
const { apiNotFound, apiErrorHandler } = require('./lib/api-errors');
const { PushNotifier } = require('./lib/push-notifier');
const { StatuslineManager, ensureHookSettingsFile } = require('./lib/statusline');

const crypto = require('crypto');

const PROJECTS_ROOT = process.env.PROJECTS_ROOT || path.join(require('os').homedir(), 'Documents', 'Projects');
const RESOLVED_PROJECTS_ROOT = path.resolve(PROJECTS_ROOT);

// Overridable so tests can spawn a real server without touching the live one.
const PORT = Number(process.env.AI_TABS_PORT) || 25283;

// Version of the code THIS process actually loaded, captured once at module
// load. Reading package.json per request reports whatever is on disk, so a
// server left running across an upgrade would claim the new version while
// serving old routes — so a stale server would silently 404 every route added
// since it started.
const APP_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
})();

const FAVORITES_FILE = path.join(__dirname, 'data', 'favorites.json');
const CATEGORIES_FILE = path.join(__dirname, 'data', 'categories.json');
const HOTKEYS_FILE = path.join(__dirname, 'data', 'hotkeys.json');
const SETTINGS_FILE = path.join(__dirname, 'data', 'settings.json');
const DEBUG_LOG = path.join(__dirname, 'data', 'debug.log');

function isDebugEnabled() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return !!JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).debug;
    }
  } catch {}
  return false;
}

const ORPHAN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes before killing orphaned sessions

// How long to wait after an attach before nudging the app to repaint. The client
// fits its terminal and sends a resize once its socket is up; nudging before that
// lands would repaint at the previous client's dimensions.
const REPAINT_AFTER_ATTACH_DELAY = 250;

const { THEME_PRESETS, DEFAULT_SETTINGS, deepMerge } = require('./lib/theme-presets');

const DEFAULT_HOTKEYS = {
  bindings: [],
  modifierClick: { modifier: 'RightShift', agentArgs: '--dangerously-skip-permissions' },
};

function buildAgentCommand(agent, args, bypass = false, permissionProfileId = null) {
  const resolvedArgs = agents.resolveLaunchArgs(agent.id, args, bypass, permissionProfileId);
  return resolvedArgs ? `${agent.command} ${resolvedArgs}\n` : `${agent.command}\n`;
}

// Project folder names: whitelist of safe characters. This regex also rejects
// any name containing "." or "/" or "\", so path traversal ("..", "../x") and
// dotfiles cannot pass — no separate "." / ".." check needed.
const PROJECT_NAME_RE = /^[A-Za-z0-9 _-]+$/;

/**
 * Validate a requested project folder name. Returns { ok: true, safeName }
 * or { ok: false, error }.
 */
function sanitizeProjectName(name) {
  if (!name || typeof name !== 'string') {
    return { ok: false, error: 'name is required' };
  }
  const safeName = name.trim();
  if (!PROJECT_NAME_RE.test(safeName)) {
    return {
      ok: false,
      error: 'Folder name may only contain letters, numbers, spaces, hyphens, and underscores',
    };
  }
  return { ok: true, safeName };
}

/**
 * Validate that cwd is an immediate child of the Projects root.
 * Returns { ok: true, folderPath, name } or { ok: false, error }.
 */
function resolveProjectChild(cwd) {
  if (!cwd || typeof cwd !== 'string') {
    return { ok: false, error: 'cwd is required' };
  }
  const folderPath = path.resolve(cwd);
  if (path.dirname(folderPath) !== RESOLVED_PROJECTS_ROOT) {
    return { ok: false, error: 'Not a project folder' };
  }
  return { ok: true, folderPath, name: path.basename(folderPath) };
}

/** Count live PTY sessions whose cwd is the folder or inside it. */
function sessionsInsideFolder(folderPath) {
  const prefix = folderPath + path.sep;
  return ptyManager.listSessions().filter((s) => {
    const scwd = path.resolve(s.cwd || '');
    return scwd === folderPath || scwd.startsWith(prefix);
  }).length;
}

// ── Tab opener (set by Electron main.js — fallback for headless mode) ──
let tabOpener = null;
function setTabOpener(fn) { tabOpener = fn; }

// ── Settings change callback (set by Electron main.js — fallback for headless mode) ──
let onSettingsChanged = null;
function setOnSettingsChanged(fn) { onSettingsChanged = fn; }

// ── Control clients — Electron instances registered over WebSocket ──
const controlClients = new Set();
// Controller slot — the one control client (Electron instance) currently
// allowed to drive session lifecycle: kill-sessions on window close and
// server shutdown. Other connected control clients are locked spectators.
// Handoff: newest claim-control wins; on controller disconnect a grace timer
// (Task 3) fails over to a surviving client.
let controllerClient = null;
const CONTROLLER_FAILOVER_GRACE_MS = Number(process.env.AI_TABS_FAILOVER_GRACE_MS || 5000);
let controllerGraceTimer = null;

function controllerAlive() {
  return controllerClient != null && controllerClient.readyState === 1;
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

// ── Pending request tracking (open-tab API → session lifecycle) ──
// requestId → { sessionId, createdAt, claimedBy, claimedWindowId, command }
// The command stays here, never in the tab URL, so a link can't carry one.
const pendingRequests = new Map();

// ── Session-to-window mapping (updated when tabs move between windows) ──
const sessionWindows = new Map(); // sessionId → current windowId string

function isExistingDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The command an open-tab request asked for, handed out once. */
function takeRequestCommand(requestId) {
  const entry = typeof requestId === 'string' ? pendingRequests.get(requestId) : null;
  if (!entry || !entry.command) return null;
  const { command } = entry;
  entry.command = null;
  return command;
}

// Ensure data directory exists
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
// Ensure projects root exists so /api/projects doesn't fail on fresh installs
fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
const app = express();

// Reject requests whose Host header isn't in the allowlist. MUST be the first
// middleware — it runs before express.static and before the localhost-exempt
// /api auth, blocking DNS-rebinding attacks against the control API.
app.use(hostGuard);
// Refuse framing and launch links that another website sent the browser to.
app.use(launchGuard);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const ptyManager = new PtyManager();
const pushNotifier = new PushNotifier();

// All connected clients keyed by sessionId — Map<id, Set<ws>>
const sessionClients = new Map();

// Per-session status stats (context bar, tokens, git branch) pushed to
// attached terminal clients. Only polls sessions that have live clients.
const statusline = new StatuslineManager({
  isLive: (id) => ptyManager.sessions.has(id),
  hasClients: (id) => {
    const clients = sessionClients.get(id);
    return !!clients && clients.size > 0;
  },
  isEnabled: () => {
    const s = readSettings();
    return !s.statusline || s.statusline.enabled !== false;
  },
  broadcast: (id, stats) => broadcastToSession(id, { type: 'statusline', stats }),
});

// Media panel — images an agent reads or screenshots, captured by the
// PostToolUse hook (scripts/media-forward.js) and the transcript backfill,
// stored under data/media/<sessionId>/ and pushed to the tab's clients.
const mediaStore = new MediaStore(path.join(__dirname, 'data', 'media'), {
  isLive: (id) => ptyManager.sessions.has(id),
});
const media = new MediaManager({
  store: mediaStore,
  isLive: (id) => ptyManager.sessions.has(id),
  hasClients: (id) => {
    const clients = sessionClients.get(id);
    return !!clients && clients.size > 0;
  },
  cwdFor: (id) => (ptyManager.sessions.get(id) || {}).cwd || null,
  broadcast: (id, msg) => broadcastToSession(id, msg),
});
try { mediaStore.sweep(); } catch {}

/**
 * Extra CLI args that wire an agent launch into the statusline hook.
 * Claude-family agents get `--settings <file>` pointing at a generated
 * config whose statusLine command is the bundled forwarder — so session
 * cost / exact context window / transcript path flow into the tab's bar
 * without touching the user's global ~/.claude/settings.json.
 */
function statuslineHookArgs(agent) {
  const s = readSettings();
  if (s.statusline && (s.statusline.enabled === false || s.statusline.autoHook === false)) return '';
  if ((agent.statusline || agent.id) !== 'claude') return '';
  try {
    const file = ensureHookSettingsFile(path.join(__dirname, 'data'));
    return ` --settings "${file}"`;
  } catch {
    return '';
  }
}

// Orphan timers — Map<sessionId, timeout> for sessions with zero clients
const orphanTimers = new Map();

function getClientsForSession(sessionId) {
  if (!sessionClients.has(sessionId)) {
    sessionClients.set(sessionId, new Set());
  }
  return sessionClients.get(sessionId);
}

function broadcastToSession(sessionId, msg) {
  const json = typeof msg === 'string' ? msg : JSON.stringify(msg);
  const clients = sessionClients.get(sessionId);
  if (!clients) return;
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(json);
  }
}

function broadcastAll(msg) {
  const json = JSON.stringify(msg);
  for (const clients of sessionClients.values()) {
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(json);
    }
  }
}

/**
 * Start an orphan timer for a session. If no client reconnects within
 * ORPHAN_TIMEOUT_MS, the session is killed.
 */
function startOrphanTimer(sessionId) {
  clearOrphanTimer(sessionId);
  orphanTimers.set(sessionId, setTimeout(() => {
    orphanTimers.delete(sessionId);
    const clients = sessionClients.get(sessionId);
    if (!clients || clients.size === 0) {
      console.log(`[orphan] Killing orphaned session ${sessionId} after timeout`);
      ptyManager.kill(sessionId);
      sessionClients.delete(sessionId);
      sessionWindows.delete(sessionId);
    }
  }, ORPHAN_TIMEOUT_MS));
}

function clearOrphanTimer(sessionId) {
  const timer = orphanTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    orphanTimers.delete(sessionId);
  }
}

// Serve xterm from node_modules
app.use('/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/xterm/lib/addon-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit/lib')));
app.use('/xterm/lib/addon-webgl', express.static(path.join(__dirname, 'node_modules/@xterm/addon-webgl/lib')));
app.use('/xterm/lib/addon-unicode11', express.static(path.join(__dirname, 'node_modules/@xterm/addon-unicode11/lib')));
app.use('/xterm/lib/addon-web-links', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links/lib')));
app.use('/xterm/lib/addon-search', express.static(path.join(__dirname, 'node_modules/@xterm/addon-search/lib')));

// Route mobile browsers at "/" to the mobile UI, which has the remote-login flow.
// Localhost always gets the desktop landing page so the host machine's UI is never
// redirected, even if a mobile-like UA ever shows up there.
app.get('/', (req, res, next) => {
  if (isLocalhost(req)) return next();
  const ua = req.headers['user-agent'] || '';
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) {
    return res.redirect(302, '/mobile.html');
  }
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Auth middleware — applied to /api/ routes (localhost exempt)
app.use('/api', authMiddleware);

// Origin guard — blocks cross-site browser requests to state-changing /api
// routes. authMiddleware exempts localhost, so this is what stops a malicious
// site the user visits from driving the control API via that exemption.
app.use('/api', originGuard);

// Notification bridge (for CC's hook system)
app.use('/api', createNotificationRouter(broadcastAll, pushNotifier));

// Attention hooks — Claude Code's Stop / Notification / PreToolUse hooks
// (pointed at scripts/attention-forward.js) POST here when the session wants
// the user. This is the only working attention channel in an xterm.js terminal:
// Claude resolves its notification channel to "no_method_available" and emits
// nothing on the PTY, so the prompt detector has nothing to see.
app.use('/api', createAttentionRouter({
  isLive: (id) => ptyManager.sessions.has(id),
  signal: (id, reason) => broadcastToSession(id, { type: 'idle', sessionId: id, reason: reason || null }),
}));

// Media hooks + image serving (see lib/media/router.js). Mounted before the
// global 1mb JSON parser: screenshots arrive as multi-hundred-KB base64.
app.use('/api', createMediaRouter({ manager: media }));

// API: favorites
app.use(express.json({ limit: '1mb' }));

// Renderer-side debug log sink — append to data/debug.log when settings.debug is true.
// Used by the terminal page to log clipboard contents for the soft-wrap copy bug.
app.post('/api/debug-log', (req, res) => {
  if (!isDebugEnabled()) return res.json({ ok: true, skipped: true });
  try {
    const tag = String(req.body?.tag || 'client').slice(0, 32);
    const msg = String(req.body?.msg || '').slice(0, 8000);
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] [${tag}] ${msg}\n`);
  } catch {}
  res.json({ ok: true });
});

// Statusline hook bridge — Claude Code's statusLine command (pointed at
// scripts/statusline-forward.js) POSTs its stdin JSON here. Carries session
// cost, exact context-window size, model display name, and transcript path;
// the manager merges these into the tab's status bar. See the forwarder
// script header for the ~/.claude/settings.json snippet.
app.post('/api/statusline-hook', (req, res) => {
  const body = req.body || {};
  const matched = statusline.applyHook(body.tabSessionId, body);
  // The same payload names the transcript; the media backfill tails it.
  if (matched != null) media.setTranscript(matched, body.transcript_path);
  res.json({ ok: true, matched });
});

app.get('/api/favorites', (req, res) => {
  try {
    if (fs.existsSync(FAVORITES_FILE)) {
      res.json(JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8')));
    } else {
      res.json([]);
    }
  } catch {
    res.json([]);
  }
});

app.post('/api/favorites', (req, res) => {
  try {
    fs.writeFileSync(FAVORITES_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: categories — { assignments: { cwd: "Category Name" }, order: ["Cat1", "Cat2"] }
app.get('/api/categories', (req, res) => {
  try {
    if (fs.existsSync(CATEGORIES_FILE)) {
      res.json(JSON.parse(fs.readFileSync(CATEGORIES_FILE, 'utf8')));
    } else {
      res.json({ assignments: {}, order: [] });
    }
  } catch {
    res.json({ assignments: {}, order: [] });
  }
});

app.post('/api/categories', (req, res) => {
  try {
    fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: hotkeys — { bindings: [...], modifierClick: { modifier, agentArgs } }
app.get('/api/hotkeys', (req, res) => {
  try {
    if (fs.existsSync(HOTKEYS_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(HOTKEYS_FILE, 'utf8'));
      if (cfg.modifierClick && cfg.modifierClick.claudeArgs != null && cfg.modifierClick.agentArgs == null) {
        cfg.modifierClick.agentArgs = cfg.modifierClick.claudeArgs;
      }
      res.json(cfg);
    } else {
      res.json(DEFAULT_HOTKEYS);
    }
  } catch {
    res.json(DEFAULT_HOTKEYS);
  }
});

app.post('/api/hotkeys', (req, res) => {
  try {
    fs.writeFileSync(HOTKEYS_FILE, JSON.stringify(req.body, null, 2));
    broadcastAll({ type: 'hotkeys-updated' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: settings
app.get('/api/settings', (req, res) => {
  res.json(readSettings());
});

app.post('/api/settings', (req, res) => {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(req.body, null, 2));
    broadcastAll({ type: 'settings-updated' });
    if (onSettingsChanged) onSettingsChanged(req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: theme presets
app.get('/api/theme-presets', (req, res) => {
  res.json(THEME_PRESETS);
});

// API: health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// API: app version — the version of the code this process is running, not the
// version currently sitting in package.json on disk. See APP_VERSION.
app.get('/api/version', (req, res) => {
  res.json({ version: APP_VERSION });
});

function serializeAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    color: agent.color,
    installed: agent.installed,
    defaultPermissionProfile: agent.defaultPermissionProfile,
    permissionProfiles: agent.permissionProfiles.map((profile) => ({
      id: profile.id,
      label: profile.label,
      dangerous: profile.dangerous,
      warning: profile.warning,
    })),
    // Labels only — the env each option sets stays server-side.
    launchOptions: (agent.launchOptions || []).map((opt) => ({
      id: opt.id,
      label: opt.label,
      description: opt.description,
    })),
  };
}

// API: agent registry (built-ins + data/agents.json) with installed status
app.get('/api/agents', (req, res) => {
  // The landing page load is the natural "re-check what's installed" moment
  // for a long-lived server — refresh here so newly installed CLIs and
  // edits to data/agents.json show up without a server restart.
  agents.refresh();
  res.json(agents.getAgents().map(serializeAgent));
});

// API: set/clear a project's owning agent
app.post('/api/project-agent', (req, res) => {
  const { cwd, agent } = req.body || {};
  if (typeof cwd !== 'string' || !cwd) {
    return res.status(400).json({ error: 'cwd is required' });
  }
  if (agent != null && !agents.getAgent(agent)) {
    return res.status(400).json({ error: `Unknown agent: ${agent}` });
  }
  try {
    projectAgents.setAgentFor(cwd, agent || null);
    res.json({ ok: true, cwd, agent: agent || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: set/clear a per-project launch-option override.
// value: true | false to override the Settings default, null to inherit.
app.post('/api/project-launch-option', (req, res) => {
  const { cwd, option, value } = req.body || {};
  if (typeof cwd !== 'string' || !cwd) {
    return res.status(400).json({ error: 'cwd is required' });
  }
  const known = agents.getAgents().some((agent) => agent.launchOptions.some((opt) => opt.id === option));
  if (!known) {
    return res.status(400).json({ error: `Unknown launch option: ${option}` });
  }
  if (value !== true && value !== false && value !== null && value !== undefined) {
    return res.status(400).json({ error: 'value must be true, false, or null' });
  }
  try {
    projectAgents.setLaunchOptionFor(cwd, option, value);
    res.json({ ok: true, cwd, launchOptions: projectAgents.getLaunchOptionsFor(cwd) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Settings default for an agent's launch options overlaid with the project's overrides. */
function launchOptionsFor(agentId, cwd) {
  const defaults = (readSettings().agentLaunchOptions || {})[agentId];
  return projectAgents.effectiveLaunchOptions(defaults, projectAgents.getLaunchOptionsFor(cwd));
}

function pickDisplayIps(interfaces) {
  let localIp = null;
  let tailscaleIp = null;
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      // Link-local APIPA (DHCP failed on that adapter, e.g. a leftover
      // hypervisor vNIC) — unroutable, never worth displaying.
      if (addr.address.startsWith('169.254.')) continue;
      // Tailscale range: 100.64.0.0/10
      const second = parseInt(addr.address.split('.')[1], 10);
      if (addr.address.startsWith('100.') && second >= 64 && second <= 127) {
        tailscaleIp = addr.address;
      } else if (!localIp) {
        localIp = addr.address;
      }
    }
  }
  return { localIp, tailscaleIp };
}

app.get('/api/network-info', (req, res) => {
  const os = require('os');
  const { localIp, tailscaleIp } = pickDisplayIps(os.networkInterfaces());
  res.json({ localIp, tailscaleIp, port: PORT });
});

// API: render a QR code as SVG for any URL the landing page wants to offer.
app.get('/api/qr', async (req, res) => {
  const data = typeof req.query.data === 'string' ? req.query.data : '';
  if (!data || data.length > 512) return res.status(400).send('bad data');
  try {
    const svg = await QRCode.toString(data, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f0f1e', light: '#ffffff' },
    });
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'no-store');
    res.send(svg);
  } catch (err) {
    res.status(500).send('qr failed');
  }
});

// API: auth status — public so the mobile UI can detect "no password set yet"
app.get('/api/auth-status', (req, res) => {
  res.json({ passwordSet: hasPassword() });
});

// API: set/change the remote-access password.
// Remote callers already proved the current password via authMiddleware; when no
// password is set yet, the middleware routes to a 401 and only localhost reaches here.
app.post('/api/auth-password', (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  }
  try {
    setPassword(password);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// API: kill all sessions and shut down the server process (called by Electron on quit)
function shutdownServer() {
  ptyManager.killAll();
  server.close();
  setTimeout(() => process.exit(0), 300);
}

app.post('/api/shutdown', (req, res) => {
  res.json({ ok: true });
  shutdownServer();
});

// API: kill all sessions belonging to a specific Electron window (called on window close)
app.post('/api/windows/:winId/kill-sessions', (req, res) => {
  const winId = req.params.winId;
  const killed = [];
  for (const [sessionId, wId] of sessionWindows) {
    if (String(wId) === String(winId)) {
      ptyManager.kill(sessionId);
      clearOrphanTimer(sessionId);
      sessionClients.delete(sessionId);
      sessionWindows.delete(sessionId);
      killed.push(sessionId);
    }
  }
  res.json({ ok: true, killed });
});

// ── Session REST API ──

// List active sessions with status
app.get('/api/sessions', (req, res) => {
  const sessions = ptyManager.listSessions().map(s => {
    const clients = sessionClients.get(s.id);
    const lastLine = getLastLine(s.id);
    return { ...s, clientCount: clients ? clients.size : 0, lastLine };
  });
  res.json(sessions);
});

// Get recent output for a session (plain text, escape sequences stripped)
app.get('/api/sessions/:id/output', (req, res) => {
  const id = parseInt(req.params.id);
  const output = ptyManager.getRecentOutputPlain(id);
  if (output == null) return res.status(404).json({ error: 'Session not found' });
  res.json({ sessionId: id, output });
});

// Write input to a session's PTY
app.post('/api/sessions/:id/input', (req, res) => {
  const id = parseInt(req.params.id);
  const { data } = req.body || {};
  if (!data) return res.status(400).json({ error: 'Missing data field' });
  if (!ptyManager.sessions.has(id)) return res.status(404).json({ error: 'Session not found' });
  ptyManager.write(id, data);
  res.json({ ok: true });
});

// ── Push notification config API ──

app.get('/api/ntfy', (req, res) => {
  res.json(pushNotifier.getConfig());
});

app.post('/api/ntfy', (req, res) => {
  const config = pushNotifier.updateConfig(req.body);
  res.json(config);
});

/** Build the URL and control message for an orchestrator-spawned tab. */
function buildOpenTabMessage({
  cwd, command, agentId, requestId, title,
  background, muted, pinned, windowId, port = PORT,
}) {
  const params = new URLSearchParams();
  if (cwd) params.set('cwd', cwd);
  if (agentId) params.set('agent', agentId);
  if (requestId) params.set('requestId', requestId);
  const url = `http://localhost:${port}/?${params.toString()}`;
  return {
    url,
    message: {
      type: 'open-tab',
      url,
      title: title || 'Session',
      background: !!background,
      muted: !!muted,
      pinned: !!pinned,
      windowId,
      requestId,
    },
  };
}

// API: open a new tab (used by orchestrators to spawn agent sessions)
app.post('/api/open-tab', (req, res) => {
  const { cwd, command, title, background, claude, agent, muted, pinned, windowId, sessionId: callerSessionId } = req.body || {};

  // Resolve windowId: prefer the session's current window (tracks tab moves)
  let resolvedWindowId = windowId;
  if (callerSessionId != null) {
    const current = sessionWindows.get(parseInt(callerSessionId, 10));
    if (current != null) resolvedWindowId = current;
  }
  serverDebugLog(`[open-tab] callerSid=${callerSessionId} windowId=${windowId} resolved=${resolvedWindowId} background=${background} map=${JSON.stringify([...sessionWindows])}`);

  const requestId = crypto.randomUUID();
  pendingRequests.set(requestId, {
    sessionId: null, createdAt: Date.now(), claimedBy: null, claimedWindowId: null,
    command: typeof command === 'string' && command ? command : null,
  });

  // Prune stale entries (>2 hours old with no live session)
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  for (const [id, entry] of pendingRequests) {
    if (Date.now() - entry.createdAt > TWO_HOURS) {
      pendingRequests.delete(id);
    }
  }

  let agentId = null;
  if (typeof agent === 'string' && agent) {
    agentId = agent;
  } else if (agent === true || claude) {
    // Caller wants "the project's agent" — resolve owner, then default
    agentId = projectAgents.getAgentFor(cwd) || readSettings().defaultAgent || 'claude';
  }
  // Send to exactly one control client: the owner of the addressed window,
  // else the controller, else a sole client. That client must open it
  // (assigned) and ack; the ack is what /status reports as claimed.
  const target = pickOpenTabTarget({ clients: controlClients, controller: controllerClient, windowId: resolvedWindowId });
  const { url, message } = buildOpenTabMessage({
    cwd, agentId, requestId, title, background, muted, pinned,
    windowId: target ? target.windowId : resolvedWindowId,
  });
  let dispatched = false;
  if (target) {
    target.client.send(JSON.stringify({ ...message, assigned: true }));
    dispatched = true;
    serverDebugLog(`[open-tab] request=${requestId} → ${target.client._controlAddr} window=${target.windowId}`);
  }

  // Fallback: in-process tabOpener (headless / legacy mode)
  if (!dispatched && tabOpener) {
    try {
      tabOpener(url, title || 'Session', !!background, !!muted, !!pinned, resolvedWindowId);
      pendingRequests.get(requestId).claimedBy = 'in-process';
      dispatched = true;
    } catch (err) {
      pendingRequests.delete(requestId);
      return res.status(500).json({ error: err.message });
    }
  }

  if (!dispatched) {
    pendingRequests.delete(requestId);
    const error = controlClients.size > 0
      ? 'No control client can take the tab (no controller and several clients connected)'
      : 'No Electron control client connected';
    return res.status(503).json({ error });
  }

  res.json({ requestId });
});

// API: poll request status (session alive/dead)
app.get('/api/requests/:requestId/status', (req, res) => {
  const entry = pendingRequests.get(req.params.requestId);
  if (!entry) {
    return res.status(404).json({ error: 'Unknown requestId' });
  }

  let alive = false;
  if (entry.sessionId != null) {
    alive = ptyManager.sessions.has(entry.sessionId);
  } else {
    // Session not yet created — treat as alive (still starting)
    alive = true;
  }

  // claimed: true (a client acked / the session exists), false (nobody acked
  // within the grace period — the tab was not posted), null (still waiting).
  res.json({ requestId: req.params.requestId, sessionId: entry.sessionId, alive, ...openTabClaimStatus(entry) });
});

// API: rename a tab by session ID
app.post('/api/sessions/:id/rename', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid session ID' });
  if (!ptyManager.sessions.has(id)) return res.status(404).json({ error: 'Session not found' });

  const { title } = req.body || {};
  if (typeof title !== 'string') return res.status(400).json({ error: 'title must be a string' });
  const trimmed = title.trim().slice(0, 120);

  const windowId = sessionWindows.get(id) || null;
  const renameMsg = JSON.stringify({ type: 'rename-tab', sessionId: id, title: trimmed, windowId });
  let dispatched = false;
  for (const client of controlClients) {
    if (client.readyState === 1) { client.send(renameMsg); dispatched = true; }
  }
  if (!dispatched) return res.status(503).json({ error: 'No Electron control client connected' });

  res.json({ ok: true, sessionId: id, title: trimmed });
});

// API: kill a session by ID (used by orchestrator and Electron closeTab)
app.post('/api/sessions/:id/kill', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid session ID' });

  if (!ptyManager.sessions.has(id)) {
    return res.status(404).json({ error: 'Session not found' });
  }

  ptyManager.kill(id);
  clearOrphanTimer(id);
  sessionClients.delete(id);
  sessionWindows.delete(id);
  res.json({ ok: true, killed: id });
});

// API: close the Electron tab hosting a session (also kills the PTY).
// Lets a Claude Code session running inside ai-tabs close its own tab via
// the session ID exposed in the CC_TABS_SESSION_ID env var.
app.post('/api/sessions/:id/close-tab', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid session ID' });

  const sessionExists = ptyManager.sessions.has(id);
  const windowId = sessionWindows.get(id) || null;

  const closeMsg = JSON.stringify({ type: 'close-tab', sessionId: id, windowId });
  let dispatched = false;
  for (const client of controlClients) {
    if (client.readyState === 1) { client.send(closeMsg); dispatched = true; }
  }

  // Kill the PTY ourselves ONLY when no control client will close the tab.
  // When a control client IS connected, its closeTab() handler tears the PTY
  // down atomically with the tab (via a 'kill' WS message). Killing the PTY
  // here first makes the renderer reconnect/respawn under a NEW session id
  // before Electron's async window._sessionId check resolves — so the check
  // matches the stale id, the tab is never closed, and the PTY just rotates.
  if (sessionExists && !dispatched) {
    ptyManager.kill(id);
    clearOrphanTimer(id);
    sessionClients.delete(id);
    sessionWindows.delete(id);
  }

  if (!dispatched && !sessionExists) {
    return res.status(404).json({ error: 'Session not found and no control client connected' });
  }

  res.json({ ok: true, sessionId: id, tabClosed: dispatched, sessionKilled: sessionExists });
});

// API: list immediate subfolders of Projects
app.get('/api/projects', (req, res) => {
  try {
    const entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
    const folders = entries
      .filter(e => e.isDirectory())
      .map(e => {
        const cwd = path.join(PROJECTS_ROOT, e.name);
        return {
          name: e.name, cwd, agent: projectAgents.getAgentFor(cwd),
          launchOptions: projectAgents.getLaunchOptionsFor(cwd),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    res.json(folders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: create a new project folder
app.post('/api/projects', express.json(), (req, res) => {
  const { name } = req.body || {};
  const result = sanitizeProjectName(name);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }
  const { safeName } = result;
  const folderPath = path.join(PROJECTS_ROOT, safeName);

  // Belt-and-suspenders: ensure the resolved path stays inside PROJECTS_ROOT.
  if (!path.resolve(folderPath).startsWith(RESOLVED_PROJECTS_ROOT + path.sep)) {
    return res.status(400).json({ error: 'Invalid folder name' });
  }

  try {
    if (fs.existsSync(folderPath)) {
      return res.status(409).json({ error: 'Folder already exists', cwd: folderPath });
    }
    fs.mkdirSync(folderPath, { recursive: true });
    res.json({ name: safeName, cwd: folderPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: rename a project folder (and migrate cwd-keyed stores)
app.patch('/api/projects', express.json(), (req, res) => {
  const { cwd, newName } = req.body || {};
  const src = resolveProjectChild(cwd);
  if (!src.ok) return res.status(400).json({ error: src.error });
  if (!fs.existsSync(src.folderPath) || !fs.statSync(src.folderPath).isDirectory()) {
    return res.status(404).json({ error: 'Folder not found' });
  }
  const nameResult = sanitizeProjectName(newName);
  if (!nameResult.ok) return res.status(400).json({ error: nameResult.error });
  const newPath = path.join(RESOLVED_PROJECTS_ROOT, nameResult.safeName);
  if (newPath === src.folderPath) {
    return res.json({ ok: true, name: nameResult.safeName, cwd: newPath });
  }
  const open = sessionsInsideFolder(src.folderPath);
  if (open > 0) {
    return res.status(409).json({ error: `Close the ${open} open session(s) in this folder first` });
  }
  // Windows fs is case-insensitive: "foo" → "Foo" must not be blocked by existsSync.
  const caseOnly = newPath.toLowerCase() === src.folderPath.toLowerCase();
  if (!caseOnly && fs.existsSync(newPath)) {
    return res.status(409).json({ error: 'Folder already exists' });
  }
  try {
    fs.renameSync(src.folderPath, newPath);
    projectAgents.renameCwd(src.folderPath, newPath);
    storeMigrate.renameCwdInFavorites(FAVORITES_FILE, src.folderPath, newPath);
    storeMigrate.renameCwdInCategories(CATEGORIES_FILE, src.folderPath, newPath);
    res.json({ ok: true, name: nameResult.safeName, cwd: newPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: move a project folder to the OS trash (and clean cwd-keyed stores)
app.delete('/api/projects', express.json(), (req, res) => {
  const src = resolveProjectChild((req.body || {}).cwd);
  if (!src.ok) return res.status(400).json({ error: src.error });
  if (!fs.existsSync(src.folderPath) || !fs.statSync(src.folderPath).isDirectory()) {
    return res.status(404).json({ error: 'Folder not found' });
  }
  const open = sessionsInsideFolder(src.folderPath);
  if (open > 0) {
    return res.status(409).json({ error: `Close the ${open} open session(s) in this folder first` });
  }
  try {
    trashDirSync(src.folderPath);
    projectAgents.removeCwd(src.folderPath);
    storeMigrate.removeCwdFromFavorites(FAVORITES_FILE, src.folderPath);
    storeMigrate.removeCwdFromCategories(CATEGORIES_FILE, src.folderPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Get the last non-empty line of plain-text output for a session.
 */
function getLastLine(sessionId) {
  const output = ptyManager.getRecentOutputPlain(sessionId);
  if (!output) return '';
  const lines = output.split('\n').filter(l => l.trim());
  return lines.length > 0 ? lines[lines.length - 1].trim().slice(0, 200) : '';
}

function sessionListForControl() {
  return ptyManager.listSessions().map(s => ({
    id: s.id, cwd: s.cwd, windowId: sessionWindows.get(s.id) || null,
    agentId: s.agentId,
  }));
}

// Hand control to ws: revoke the previous holder (if any), grant the new one.
// Also cancels a pending disconnect-failover — a reconnecting claimant wins.
function grantControl(ws) {
  if (controllerGraceTimer) { clearTimeout(controllerGraceTimer); controllerGraceTimer = null; }
  const prev = controllerAlive() && controllerClient !== ws ? controllerClient : null;
  controllerClient = ws;
  if (prev) prev.send(JSON.stringify({ type: 'control-revoked', by: ws._controlAddr }));
  ws.send(JSON.stringify({ type: 'control-granted', sessions: sessionListForControl() }));
  serverDebugLog(`[control] control granted to ${ws._controlAddr}${prev ? `, revoked from ${prev._controlAddr}` : ''}`);
}

// WebSocket: each connection can create OR attach to a session
wss.on('connection', (ws, req) => {
  // Authenticate remote WebSocket connections
  if (!authenticateWs(req)) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  const wsAddr = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const isLocalWs = wsAddr === '127.0.0.1' || wsAddr === '::1';

  let sessionId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'register-control': {
        // Allowed for any authenticated connection (localhost or remote with valid key).
        controlClients.add(ws);
        ws._controlLocal = isLocalWs;
        ws._controlAddr = isLocalWs ? 'local' : wsAddr;

        // A reclaim (as opposed to a fresh connect to an idle server) shows up
        // in one of two ways depending on whether the old controller's close
        // event has been processed yet: a stale-but-non-null controllerClient
        // (close still pending) or a running failover grace timer (close done).
        const staleController = controllerClient != null && controllerClient.readyState !== 1;
        const graceWasPending = controllerGraceTimer != null;
        if (!controllerAlive()) controllerClient = ws;
        const isController = controllerClient === ws;
        serverDebugLog(`[control] client registered addr=${ws._controlAddr} controller=${isController}, active sessions=${ptyManager.sessions.size}`);
        ws.send(JSON.stringify({
          type: 'control-ready',
          sessions: sessionListForControl(),
          isPrimary: isController,
          controller: isController ? null : { by: controllerClient._controlAddr },
        }));
        // A claiming registrant (a freshly launched window) preempts the
        // current holder — newest wins, uniformly for local and remote.
        // Remote registrants preempt without asking, as before, or reclaim a
        // just-vacated slot; both must go through grantControl so a pending
        // failover is cancelled. A fresh connect to a genuinely idle slot
        // (no prior controller in sight) needs no grant: control-ready
        // already said isPrimary:true.
        const wantsControl = msg.claim === true || !isLocalWs;
        if (wantsControl && (!isController || graceWasPending || staleController)) {
          grantControl(ws);
        }
        break;
      }

      case 'claim-control': {
        if (!controlClients.has(ws)) break;
        grantControl(ws);
        break;
      }

      case 'control-windows': {
        // The window ids this Electron instance currently owns, so open-tab
        // can go straight to the owner or fall back when the window is gone.
        if (!controlClients.has(ws) || !Array.isArray(msg.windowIds)) break;
        ws._windowIds = msg.windowIds.map(String);
        break;
      }

      case 'open-tab-ack': {
        // The instance that actually opened an open-tab request says so.
        if (!controlClients.has(ws)) break;
        const entry = pendingRequests.get(msg.requestId);
        if (!entry || entry.claimedBy != null) break;
        entry.claimedBy = ws._controlAddr;
        entry.claimedWindowId = msg.windowId != null ? String(msg.windowId) : null;
        serverDebugLog(`[open-tab] request=${msg.requestId} claimed by ${ws._controlAddr} window=${entry.claimedWindowId}`);
        break;
      }

      case 'release-control': {
        // Sent by an Electron instance on quit. The server decides: transfer
        // control to a surviving peer, or — only for a sole local controller —
        // shut everything down (today's quit-the-app behavior).
        const others = [...controlClients].filter(c => c !== ws && c.readyState === 1);
        const wasController = controllerClient === ws;
        const shutdown = wasController && ws._controlLocal === true && others.length === 0;
        ws.send(JSON.stringify({ type: 'release-ack', shutdown }));
        if (shutdown) {
          serverDebugLog('[control] sole local controller released — shutting down');
          shutdownServer();
          break;
        }
        if (wasController && others.length > 0) {
          grantControl(others.find(c => c._controlLocal) || others[0]);
        } else if (wasController) {
          controllerClient = null; // remote sole controller quitting: slot empties, server lives on
        }
        break;
      }

      case 'create': {
        const nextId = ptyManager.nextId;
        // Only an open-tab request may auto-type a command, and only once.
        const command = takeRequestCommand(msg.requestId);
        // Orchestrators may re-export CC_TABS_SESSION_ID (some put a
        // UUID there), so hooks route by AI_TABS_TAB_ID, which only we set.
        const extraEnv = { CC_TABS_SESSION_ID: String(nextId), [commandLaunch.TAB_ID_ENV]: String(nextId) };
        if (msg.windowId) extraEnv.CC_TABS_WINDOW_ID = String(msg.windowId);

        // Resolve the agent up front so its env vars apply to the PTY itself.
        // A request's command replaces the agent launch, as it always has.
        let launchAgent = null;
        if (!command && (msg.launchAgent || msg.launchClaude)) {
          const requestedId = msg.launchAgent || 'claude';
          launchAgent = agents.getAgent(requestedId)
            || agents.getAgent(readSettings().defaultAgent)
            || agents.getAgent('claude');
          if (!agents.getAgent(requestedId)) {
            console.warn(`[agents] Unknown agent '${requestedId}' — falling back to '${launchAgent.id}'`);
          }
          // Base env plus any enabled launch options (Settings default,
          // overridden per project) — e.g. Claude's native-scrollback mode.
          Object.assign(extraEnv, agents.resolveLaunchEnv(
            launchAgent.id,
            launchOptionsFor(launchAgent.id, msg.cwd || null)
          ));
        }

        // A raw command that starts Claude (open-tab API) gets Claude's
        // detection and hook settings, like a registry launch.
        const commandAgent = !launchAgent && commandLaunch.commandLaunchesClaude(command)
          ? agents.getAgent('claude')
          : null;
        const detectionAgent = launchAgent || commandAgent;

        // A bad cwd makes node-pty throw synchronously, and an uncaught throw
        // here takes down the server and every live session with it.
        if (msg.cwd && !isExistingDir(msg.cwd)) {
          ws.send(JSON.stringify({ type: 'error', message: `Folder not found: ${msg.cwd}` }));
          break;
        }
        let created;
        try {
          created = ptyManager.create(
          msg.cwd || null,
          (data) => {
            broadcastToSession(id, { type: 'data', data });
          },
          (exitCode) => {
            broadcastToSession(id, { type: 'exit', exitCode });
            sessionWindows.delete(id);
            statusline.unregister(id);
            media.endSession(id);
          },
          () => {
            broadcastToSession(id, { type: 'idle', sessionId: id });
          },
          msg.cols || 120,
          msg.rows || 30,
          extraEnv,
          detectionAgent ? detectionAgent.detection : {},
          {
            // Remembered so a UI restart can restore the tab's agent identity
            // (its colored dot) without re-launching anything.
            agentId: launchAgent ? launchAgent.id : null,
          }
          );
        } catch (err) {
          console.error(`[ws-create] could not start a shell in ${msg.cwd || '(home)'}: ${err.message}`);
          ws.send(JSON.stringify({ type: 'error', message: `Could not start a shell: ${err.message}` }));
          break;
        }
        const { id } = created;
        sessionId = id;
        if (msg.windowId) {
          sessionWindows.set(id, String(msg.windowId));
          serverDebugLog(`[ws-create] session=${id} windowId=${msg.windowId}`);
        } else {
          serverDebugLog(`[ws-create] session=${id} NO windowId in create message`);
        }
        getClientsForSession(id).add(ws);
        clearOrphanTimer(id);
        statusline.register(id, { agent: launchAgent, cwd: msg.cwd || null });
        statusline.pushSoon(id);
        // PTY ids restart at 1 per server process: drop any media an earlier
        // process left under this id before its hooks can fire.
        media.beginSession(id);
        ws.send(JSON.stringify({ type: 'created', sessionId: id }));

        // Link requestId → sessionId for open-tab API polling
        if (msg.requestId && pendingRequests.has(msg.requestId)) {
          pendingRequests.get(msg.requestId).sessionId = id;
        }

        // Auto-type command if provided (e.g., from open-tab API)
        if (command) {
          const typed = commandAgent
            ? commandLaunch.withHookSettings(command, statuslineHookArgs(commandAgent))
            : command;
          setTimeout(() => ptyManager.write(id, typed + '\n'), 600);
        } else if (launchAgent) {
          if (!launchAgent.installed) {
            setTimeout(() => broadcastToSession(id, {
              type: 'data',
              data: `\r\n\x1b[33m[ai-tabs] '${launchAgent.command}' not found on PATH — install it or pick another agent on the landing page.\x1b[0m\r\n`,
            }), 600);
          } else {
            const currentSettings = readSettings();
            const permissionProfileId = currentSettings.agentPermissions
              ? currentSettings.agentPermissions[launchAgent.id]
              : null;
            const cmd = buildAgentCommand(
              launchAgent,
              msg.agentArgs || msg.claudeArgs,
              msg.agentBypass === true,
              permissionProfileId
            ).replace(/\n$/, statuslineHookArgs(launchAgent) + '\n');
            setTimeout(() => ptyManager.write(id, cmd), 600);
            if (msg.cwd) projectAgents.recordIfUnset(msg.cwd, launchAgent.id);
          }
        }
        break;
      }

      case 'attach': {
        // Mobile/remote client attaching to an existing session
        const targetId = parseInt(msg.sessionId);
        if (!ptyManager.sessions.has(targetId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
          break;
        }

        // Detach from any previous session
        if (sessionId != null) {
          const prevClients = sessionClients.get(sessionId);
          if (prevClients) {
            prevClients.delete(ws);
            if (prevClients.size === 0) startOrphanTimer(sessionId);
          }
        }

        sessionId = targetId;
        getClientsForSession(targetId).add(ws);
        clearOrphanTimer(targetId);
        statusline.pushSoon(targetId, 300);

        // Send plain-text scrollback inside 'attached' so client can write it
        // before the [Reconnected] banner — raw escape sequences break on a fresh xterm.
        //
        // Except on the alternate screen: there the ring buffer is cursor-addressed
        // redraw fragments, so stripping the escapes linearises it into nonsense
        // that lands on top of whatever the app paints next. Send nothing and let
        // the repaint below reconstruct the screen.
        const onAltScreen = ptyManager.isAltScreen(targetId);
        const scrollback = onAltScreen ? '' : (ptyManager.getRecentOutputPlain(targetId) || '');
        const info = ptyManager.getSessionInfo(targetId);
        ws.send(JSON.stringify({ type: 'attached', sessionId: targetId, info, scrollback, altScreen: onAltScreen }));

        // Nudge after the client's own fit()/resize has landed, so the app
        // repaints at the size this client actually has rather than the previous
        // one's. Costs a spurious non-idle blip on the session — acceptable for a
        // one-shot on attach, which is a tab somebody is looking at.
        setTimeout(() => ptyManager.forceRepaint(targetId), REPAINT_AFTER_ATTACH_DELAY);
        break;
      }

      case 'data': {
        if (sessionId != null) ptyManager.write(sessionId, msg.data);
        break;
      }

      case 'resize': {
        if (sessionId != null && msg.cols && msg.rows) {
          ptyManager.resize(sessionId, msg.cols, msg.rows);
        }
        break;
      }

      case 'update-window-id': {
        // Tab moved to a different Electron window — update the mapping
        if (sessionId != null && msg.windowId != null) {
          sessionWindows.set(sessionId, String(msg.windowId));
        }
        break;
      }

      case 'kill': {
        // Explicit kill request (desktop tab close)
        if (sessionId != null) {
          ptyManager.kill(sessionId);
          clearOrphanTimer(sessionId);
          sessionClients.delete(sessionId);
          sessionWindows.delete(sessionId);
          sessionId = null;
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    controlClients.delete(ws);
    if (ws === controllerClient) {
      controllerClient = null;
      serverDebugLog('[control] controller disconnected — starting failover grace timer');
      if (controllerGraceTimer) clearTimeout(controllerGraceTimer);
      controllerGraceTimer = setTimeout(() => {
        controllerGraceTimer = null;
        if (controllerAlive()) return; // someone claimed in the meantime
        const candidates = [...controlClients].filter(c => c.readyState === 1);
        if (candidates.length === 0) return; // slot stays empty; next register claims
        grantControl(candidates.find(c => c._controlLocal) || candidates[0]);
      }, CONTROLLER_FAILOVER_GRACE_MS);
    }
    if (sessionId != null) {
      const clients = sessionClients.get(sessionId);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) {
          // No more clients — start orphan timer instead of killing immediately
          startOrphanTimer(sessionId);
        }
      }
    }
  });
});

// /api fallbacks — mounted after every /api route so clients always get JSON.
// See lib/api-errors.js for why this matters.
app.use('/api', apiNotFound(APP_VERSION));
app.use('/api', apiErrorHandler());

process.on('SIGINT', () => {
  ptyManager.killAll();
  server.close();
  process.exit(0);
});

/**
 * Version of the server already listening on PORT, or null if it can't be
 * reached or is too old to report one. Used to detect a server left running
 * across an upgrade — it keeps serving the routes it booted with, so a newer
 * UI talking to it gets 404s for anything added since.
 */
async function runningServerVersion() {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/version`);
    if (!res.ok) return null;
    return (await res.json()).version || null;
  } catch {
    return null;
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    // Suppress WSS error when server fails (it mirrors the server error)
    wss.on('error', () => {});
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        runningServerVersion().then((version) => {
          const stale = version !== APP_VERSION;
          if (stale) {
            console.warn(
              `Port ${PORT} is held by an ai-tabs server running ${version || 'an unknown version'}, `
              + `but this build is ${APP_VERSION}. That server will keep serving its old routes — `
              + `quit ai-tabs completely (or kill that process) so it restarts on the current code.`
            );
          } else {
            console.log(`Port ${PORT} already in use, reusing existing server`);
          }
          resolve({ port: PORT, reused: true, stale, runningVersion: version });
        });
      } else {
        reject(err);
      }
    });
    server.listen(PORT, () => {
      console.log(`ai-tabs running at http://localhost:${PORT}`);
      if (!hasPassword()) {
        console.log('Remote access password not set — open ai-tabs and set one in Settings to enable remote access.');
      }
      resolve({ port: PORT, reused: false });
    });
  });
}

module.exports = { startServer, setTabOpener, setOnSettingsChanged, ptyManager, PORT, pushNotifier, sanitizeProjectName, resolveProjectChild, RESOLVED_PROJECTS_ROOT, buildAgentCommand, buildOpenTabMessage, serializeAgent, pickDisplayIps };

if (require.main === module) {
  // Last line of defense: the detached server holds every live session, so a
  // stray throw is logged, not allowed to kill them all.
  process.on('uncaughtException', (err) => {
    console.error('[server] uncaught exception:', err);
    serverDebugLog(`[server] uncaught exception: ${err && err.stack}`);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandled rejection:', reason);
  });
  startServer().then(({ reused }) => {
    if (reused) {
      // Another server is already running — this spawned instance exits cleanly.
      console.log(`Port ${PORT} already in use — deferring to running server`);
      process.exit(0);
    }
  }).catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
