// The server list: which ai-tabs servers this machine can launch against.
//
// Lives in Electron's userData directory, NOT the install directory, so a
// reinstall or a second install shares one list. Binding used to be a property
// of the install dir (data/settings.json), which forced a full copy of the app
// per remote target.
//
// Keys are stored plaintext, matching the remoteKey handling this replaces.
// They are deliberately NOT passed on the command line: argv is readable by
// every process on the machine, and the key grants terminal access.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LOCAL_ID = 'local';
const RESERVED_IDS = new Set([LOCAL_ID]);
const LOCAL_ENTRY = { id: LOCAL_ID, name: 'This machine', url: null };
const STORE_VERSION = 1;

function localEntry() {
  return { ...LOCAL_ENTRY };
}

/**
 * Read the store. Never throws: a missing, unreadable, or corrupt file yields
 * a fresh store, because no config failure may block launch.
 * The local entry is always present and always first.
 */
function loadServers(file) {
  let parsed = null;
  try {
    if (fs.existsSync(file)) parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`[servers] unreadable store, starting fresh: ${err.message}`);
  }
  const servers = Array.isArray(parsed?.servers)
    ? parsed.servers.filter((s) => s && typeof s.id === 'string' && s.id !== LOCAL_ID)
    : [];
  return { version: STORE_VERSION, servers: [localEntry(), ...servers] };
}

/** Write via temp + rename so a crash mid-write cannot truncate the store. */
function saveServers(file, data) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function generateId() {
  let id;
  do { id = crypto.randomBytes(6).toString('hex'); } while (RESERVED_IDS.has(id));
  return id;
}

/** Accepts both `--server=<id>` and `--server <id>`. */
function parseServerArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--server=')) return a.slice('--server='.length) || null;
    if (a === '--server') return argv[i + 1] || null;
  }
  return null;
}

/** null means "no usable target" — the caller opens the picker. */
function resolveLaunchTarget(argv, file) {
  const id = parseServerArg(argv);
  if (!id) return null;
  const found = loadServers(file).servers.find((s) => s.id === id);
  if (!found) return null;
  return { id: found.id, name: found.name, url: found.url ?? null, key: found.key ?? null };
}

function normalizeUrl(input, defaultPort) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter the server address.');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  const u = new URL(s);            // throws on junk
  if (!u.hostname) throw new Error('Invalid server address.');
  if (!u.port) u.port = String(defaultPort);
  return u.origin;
}

const DEFAULT_PORT = 25283;

function addServer(file, { name, url, key }) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return { ok: false, error: 'Enter a name for this server.' };
  if (typeof key !== 'string' || !key) return { ok: false, error: 'Enter the remote-access password.' };

  let normalized;
  try {
    normalized = normalizeUrl(url, DEFAULT_PORT);
  } catch (err) {
    return { ok: false, error: err.message === 'Enter the server address.' ? err.message : 'Invalid server address.' };
  }

  const data = loadServers(file);
  if (data.servers.some((s) => s.url === normalized)) {
    return { ok: false, error: 'That server is already in the list.' };
  }
  const server = { id: generateId(), name: trimmedName, url: normalized, key };
  data.servers.push(server);
  saveServers(file, data);
  return { ok: true, server };
}

/** Returns false for an unknown id or the un-deletable local entry. */
function removeServer(file, id) {
  if (id === LOCAL_ID) return false;
  const data = loadServers(file);
  const before = data.servers.length;
  data.servers = data.servers.filter((s) => s.id !== id);
  if (data.servers.length === before) return false;
  saveServers(file, data);
  return true;
}

/**
 * One-time migration. Creates the store with the local entry, importing this
 * install's existing remoteServer/remoteKey if it still has one. Deliberately
 * does NOT scan sibling install directories.
 */
function seedServersFile(file, legacySettingsFile) {
  try {
    if (fs.existsSync(file)) return;
    const data = { version: STORE_VERSION, servers: [localEntry()] };
    try {
      if (fs.existsSync(legacySettingsFile)) {
        const legacy = JSON.parse(fs.readFileSync(legacySettingsFile, 'utf8'));
        if (legacy.remoteServer && legacy.remoteKey) {
          let hostname = legacy.remoteServer;
          try { hostname = new URL(legacy.remoteServer).hostname; } catch {}
          data.servers.push({
            id: generateId(),
            name: hostname,
            url: String(legacy.remoteServer).replace(/\/$/, ''),
            key: legacy.remoteKey,
          });
        }
      }
    } catch (err) {
      console.error(`[servers] could not import legacy remote binding: ${err.message}`);
    }
    saveServers(file, data);
  } catch (err) {
    console.error(`[servers] seed failed: ${err.message}`);
  }
}

const VALIDATE_TIMEOUT_MS = 5000;

/**
 * Probe a candidate server before it is saved. Error strings are the ones the
 * old Settings connect flow used, so the wording users know is preserved.
 * `fetchImpl` is injected for tests.
 */
async function validateServer(url, key, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(`${url}/api/health`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: `Cannot reach ${url}: ${err.message}` };
  }
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    return {
      ok: false,
      error: body.error === 'Invalid password.' ? 'Wrong password.' : (body.error || 'Wrong password.'),
    };
  }
  if (res.status === 403) {
    return {
      ok: false,
      error: "The server only accepts its own IP addresses as hostnames — "
        + "connect by IP, or add this name to extraAllowedHosts in the server's data/settings.json.",
    };
  }
  if (!res.ok) return { ok: false, error: `Server answered HTTP ${res.status}.` };
  return { ok: true };
}

module.exports = {
  LOCAL_ID, DEFAULT_PORT, VALIDATE_TIMEOUT_MS,
  loadServers, saveServers, generateId,
  parseServerArg, resolveLaunchTarget,
  normalizeUrl, addServer, removeServer, seedServersFile,
  validateServer,
};
