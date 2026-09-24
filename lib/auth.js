const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Overridable so tests can point a spawned server at a throwaway password
// file instead of the real one in data/.
const AUTH_FILE = process.env.AI_TABS_AUTH_FILE
  || path.join(__dirname, '..', 'data', 'auth-key.json');

const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'settings.json');

// Server port. server.js and main.js each define this independently; auth.js
// follows that pattern rather than importing from server.js (circular require),
// since the allowlist below is built at module load.
const PORT = 25283;

// Optional user-configured hostnames (DNS / Tailscale names) folded into the
// allowlist alongside the machine's own IPs. This is a SERVER-side setting:
// the machine running server.js lists the names clients will use to reach it,
// as `extraAllowedHosts: ["name", ...]` in data/settings.json. Read at module
// load like the interface scan — restart the server after editing.
function readExtraAllowedHosts() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (Array.isArray(raw.extraAllowedHosts)) {
      return raw.extraAllowedHosts
        .filter((h) => typeof h === 'string' && h.trim())
        .map((h) => h.trim());
    }
  } catch {}
  return [];
}

// Allowlist for Origin/Host validation, built once at startup from the machine's
// own network interfaces. The resulting Sets are module-private and never
// mutated after construction — the predicates below are the only accessors.
// NOTE: built at module load — if the machine's IP changes (DHCP renewal,
// joining Tailscale later), restart the server to refresh.
function buildAllowlist(extraHosts = []) {
  const hosts = new Set(['localhost', '127.0.0.1', '::1']);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) hosts.add(addr.address);
    }
  }
  for (const h of extraHosts) hosts.add(h);
  const origins = new Set();
  for (const h of hosts) {
    const bracketedHost = h.includes(':') ? `[${h}]` : h;
    origins.add(`http://${bracketedHost}:${PORT}`);
  }
  return { hosts, origins };
}
const { hosts: ALLOWED_HOSTS, origins: ALLOWED_ORIGINS } = buildAllowlist(readExtraAllowedHosts());

// Extract the hostname from a Host header value, dropping any :port suffix and
// handling the [::1]:port IPv6 bracket form. Returns null for missing/invalid.
function parseHostname(hostHeader) {
  if (!hostHeader || typeof hostHeader !== 'string') return null;
  const h = hostHeader.trim();
  if (!h) return null;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end === -1) return null;
    const after = h.slice(end + 1);
    if (after !== '' && !after.startsWith(':')) return null;
    return h.slice(1, end);
  }
  const colon = h.indexOf(':');
  return colon === -1 ? h : h.slice(0, colon);
}

function isAllowedOrigin(origin) {
  if (typeof origin !== 'string') return false;
  return ALLOWED_ORIGINS.has(origin);
}

function isAllowedHost(hostHeader) {
  const hostname = parseHostname(hostHeader);
  if (!hostname) return false;
  return ALLOWED_HOSTS.has(hostname);
}

// Express middleware: reject any request whose Host header is not in the
// allowlist. Mounted FIRST in server.js so it runs before the localhost
// exemption in authMiddleware — that exemption is exactly what a DNS-rebinding
// attacker abuses (the request really does come from 127.0.0.1).
function hostGuard(req, res, next) {
  if (!isAllowedHost(req.headers.host)) {
    console.warn(`[hostGuard] rejected request with Host: ${JSON.stringify(req.headers.host)}`);
    return res.status(403).send('Forbidden: invalid Host header');
  }
  next();
}

// HTTP methods that only read state — a cross-site browser request to one of
// these is harmless, so originGuard lets them through unchecked.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Express middleware: the /api HTTP counterpart of authenticateWs's Origin check.
// authMiddleware exempts localhost, so without this a browser on another site
// could drive state-changing /api routes (e.g. open-tab → RCE) through that
// exemption via a cross-origin request. A browser always sends Origin on a
// cross-site state-changing request; non-browser callers (CC hooks, the Electron
// control client, curl) send none — so a missing Origin is allowed, exactly as
// authenticateWs does. Mounted on /api in server.js.
function originGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    console.warn(`[originGuard] rejected ${req.method} with Origin: ${JSON.stringify(origin)}`);
    return res.status(403).send('Forbidden: invalid Origin');
  }
  next();
}

// Rate limiting: 5 failures in a 10-minute window triggers a 1-minute lockout per IP
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60 * 1000;
const failureTracking = new Map(); // ip → { firstFailAt, fails, lockUntil }

let stored = loadAuthFile();

function loadAuthFile() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const data = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      // Old format had a raw `key` field. Wipe it so the user is prompted to
      // set a proper password instead of being silently downgraded.
      if (data.passwordHash && data.salt) return data;
    }
  } catch {}
  return null;
}

function hasPassword() {
  return stored != null;
}

// The password guards a full shell over plain LAN HTTP; short ones fall to
// the rate-limited brute force in a day.
const MIN_PASSWORD_LENGTH = 12;

function setPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  stored = {
    passwordHash: hash.toString('base64'),
    salt: salt.toString('base64'),
    setAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(stored, null, 2));
}

function verifyPassword(password) {
  if (!stored || typeof password !== 'string') return false;
  try {
    const salt = Buffer.from(stored.salt, 'base64');
    const expected = Buffer.from(stored.passwordHash, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function isLocalhost(req) {
  const ip = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function clientIp(req) {
  return req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown';
}

function checkLockout(ip) {
  const entry = failureTracking.get(ip);
  if (!entry) return false;
  if (entry.lockUntil && Date.now() < entry.lockUntil) return true;
  if (entry.lockUntil && Date.now() >= entry.lockUntil) {
    failureTracking.delete(ip);
    return false;
  }
  return false;
}

function recordFailure(ip) {
  const now = Date.now();
  const entry = failureTracking.get(ip) || { firstFailAt: now, fails: 0, lockUntil: 0 };
  if (now - entry.firstFailAt > RATE_WINDOW_MS) {
    entry.firstFailAt = now;
    entry.fails = 0;
  }
  entry.fails += 1;
  if (entry.fails >= MAX_FAILURES) entry.lockUntil = now + LOCKOUT_MS;
  failureTracking.set(ip, entry);
}

function recordSuccess(ip) {
  failureTracking.delete(ip);
}

function extractToken(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  return req.query?.key || null;
}

function authMiddleware(req, res, next) {
  if (isLocalhost(req)) return next();

  // Public: auth-status must be reachable so the mobile UI can detect "no password set yet"
  if (req.path === '/auth-status') return next();

  const ip = clientIp(req);
  if (checkLockout(ip)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in a minute.' });
  }

  if (!hasPassword()) {
    return res.status(401).json({ error: 'Remote access has not been configured. Open ai-tabs on the server machine to set a password.' });
  }

  const token = extractToken(req);
  if (token && verifyPassword(token)) {
    recordSuccess(ip);
    return next();
  }

  recordFailure(ip);
  res.status(401).json({ error: 'Invalid password.' });
}

function authenticateWs(req) {
  // C1: a browser always sends Origin on a cross-site WebSocket connection.
  // Reject any present-but-foreign Origin before the localhost exemption below.
  // Non-browser clients (Electron ws control client, curl) send no Origin.
  // This deliberately validates Origin only, not Host: a DNS-rebinding attack
  // on the WS endpoint is still browser-driven and therefore carries an Origin.
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    console.warn(`[authenticateWs] rejected WS connection with Origin: ${JSON.stringify(origin)}`);
    return false;
  }

  const ip = req.socket?.remoteAddress || '';
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;

  if (checkLockout(ip)) return false;
  if (!hasPassword()) return false;

  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('key');
  if (token && verifyPassword(token)) {
    recordSuccess(ip);
    return true;
  }
  recordFailure(ip);
  return false;
}

module.exports = {
  authMiddleware,
  authenticateWs,
  hasPassword,
  setPassword,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
  isLocalhost,
  isAllowedOrigin,
  isAllowedHost,
  hostGuard,
  originGuard,
  buildAllowlist,
};
