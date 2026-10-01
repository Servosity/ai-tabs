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
const dns = require('node:dns');
const net = require('node:net');
const os = require('node:os');

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

/**
 * An entry's `host` is the machine name it can be re-resolved from when its
 * IP changes (DHCP, a reboot, a new subnet). It is kept separate from `url`
 * because the server rejects non-IP Host headers unless they are in
 * extraAllowedHosts — so we connect by IP, and keep the name only to find
 * that IP again.
 */
function isIpAddress(host) {
  return net.isIP(String(host || '').replace(/^\[|\]$/g, '')) !== 0;
}

function parseAddress(input, defaultPort) {
  const origin = normalizeUrl(input, defaultPort);
  const u = new URL(origin);
  return { origin, hostname: u.hostname, port: u.port, isIp: isIpAddress(u.hostname) };
}

/** Same scheme and port, different host. */
function withHostname(url, hostname) {
  const u = new URL(url);
  u.hostname = hostname;
  return u.origin;
}

/** The hostname inside a url, or null when it is just an address. */
function hostnameOf(url) {
  try {
    const { hostname } = new URL(url);
    return isIpAddress(hostname) ? null : hostname;
  } catch {
    return null;
  }
}

/**
 * Every address a machine name resolves to. Uses the OS resolver (not DNS
 * directly) so all of Windows' name resolution counts — hosts file, mDNS,
 * LLMNR/NetBIOS, and a VPN's own resolver — which is how a LAN desktop is
 * usually findable by name. `lookupImpl` is injected for tests.
 */
async function resolveHostAddresses(host, lookupImpl = dns.promises.lookup) {
  const name = String(host || '').trim();
  if (!name) return [];
  if (isIpAddress(name)) return [name];
  const res = await lookupImpl(name, { all: true, family: 0 });
  const list = Array.isArray(res) ? res : [res];
  return list.map((r) => r?.address).filter(Boolean);
}

/**
 * Resolve a machine name to the one address worth trying first — see
 * rankAddresses for why that is not simply whatever the resolver returned.
 */
async function resolveHostIp(host, lookupImpl = dns.promises.lookup, subnets) {
  const name = String(host || '').trim();
  if (!name) throw new Error('No machine name saved.');
  if (isIpAddress(name)) return name;
  const addresses = rankAddresses(await resolveHostAddresses(name, lookupImpl), subnets);
  if (!addresses.length) throw new Error(`${name} did not resolve to an address.`);
  return addresses[0];
}

// ── This machine's own networks ──
// Used both to prefer a LAN address over a VPN overlay one and to sweep for a
// server whose address changed and whose name does not resolve at all.

const SCAN_PORT_TIMEOUT_MS = 400;
const SCAN_CONCURRENCY = 64;
const SCAN_MAX_HOSTS = 1024;
const SCAN_FINGERPRINT_TIMEOUT_MS = 2000;

/** CGNAT: what Tailscale and similar overlays hand out. */
const CGNAT_RE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

function ipToInt(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/**
 * The IPv4 networks this machine is actually on. Point-to-point interfaces
 * (/31, /32 — a VPN tunnel) have no neighbours to sweep, and anything wider
 * than /22 is too many addresses to probe, so both are left out.
 */
function localSubnets(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const addrs of Object.values(interfaces || {})) {
    for (const a of addrs || []) {
      if (a.internal) continue;
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (!a.address || !a.netmask || a.address.startsWith('169.254.')) continue;
      const prefix = Number(String(a.cidr || '').split('/')[1]);
      if (!Number.isInteger(prefix) || prefix < 22 || prefix > 30) continue;
      out.push({ address: a.address, netmask: a.netmask, prefix });
    }
  }
  return out;
}

function isSameSubnet(ip, subnet) {
  const addr = ipToInt(ip);
  const base = ipToInt(subnet?.address);
  const mask = ipToInt(subnet?.netmask);
  if (addr === null || base === null || mask === null) return false;
  return ((addr & mask) >>> 0) === ((base & mask) >>> 0);
}

/** Every address in a subnet except the network, the broadcast, and us. */
function subnetHosts(subnet, max = SCAN_MAX_HOSTS) {
  const base = ipToInt(subnet?.address);
  const mask = ipToInt(subnet?.netmask);
  if (base === null || mask === null) return [];
  const network = (base & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const hosts = [];
  for (let n = network + 1; n < broadcast && hosts.length < max; n++) {
    if (n !== base) hosts.push(intToIp(n));
  }
  return hosts;
}

/**
 * Order resolved addresses by how likely they are to be the one to use: this
 * machine's own networks first, an overlay (Tailscale/CGNAT) address last.
 * A name that resolves through a VPN's resolver answers with the overlay
 * address even when both machines are sitting on the same LAN, and the LAN
 * path is the one that works without the VPN up.
 */
function rankAddresses(addresses, subnets = localSubnets()) {
  const score = (ip) => {
    if (subnets.some((s) => isSameSubnet(ip, s))) return 0;
    if (CGNAT_RE.test(ip)) return 2;
    return 1;
  };
  return [...new Set(addresses || [])].sort((a, b) => score(a) - score(b));
}

/** Plain TCP connect: is anything listening there at all? */
function probeTcp(host, port, timeoutMs = SCAN_PORT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Is this an ai-tabs server? /api/auth-status is the one unauthenticated
 * endpoint, so a host can be identified before it is ever offered a password.
 */
async function looksLikeAiTabs(origin, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${origin}/api/auth-status`, {
      signal: AbortSignal.timeout(SCAN_FINGERPRINT_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return typeof body?.passwordSet === 'boolean';
  } catch {
    return false;
  }
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/**
 * Sweep this machine's own subnets for ai-tabs servers on `port`. Two passes
 * on purpose: a TCP connect narrows hundreds of addresses down to the few
 * that listen, and only those are fingerprinted — nothing is sent a password.
 */
async function scanLanForServers(port, {
  subnets = localSubnets(), probeImpl = probeTcp, fetchImpl = fetch,
  concurrency = SCAN_CONCURRENCY, timeoutMs = SCAN_PORT_TIMEOUT_MS,
} = {}) {
  const hosts = [...new Set(subnets.flatMap((s) => subnetHosts(s)))];
  const open = [];
  await mapLimit(hosts, concurrency, async (host) => {
    if (await probeImpl(host, port, timeoutMs)) open.push(host);
  });

  const found = [];
  for (const host of open.sort((a, b) => ipToInt(a) - ipToInt(b))) {
    const origin = `http://${host}:${port}`;
    if (await looksLikeAiTabs(origin, fetchImpl)) found.push(origin);
  }
  return found;
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

function addServer(file, { name, url, key, host }) {
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
  const trimmedHost = String(host || '').trim();
  if (trimmedHost) server.host = trimmedHost;
  data.servers.push(server);
  saveServers(file, data);
  return { ok: true, server };
}

/**
 * Edit an existing entry in place, keeping its id so anything holding that id
 * (a shortcut, a relaunch) still points at the same server. Fields left out
 * are kept — in particular an omitted or empty `key` keeps the stored one, so
 * the UI never has to hand the password back to the renderer to re-save it.
 */
function updateServer(file, id, { name, url, key, host } = {}) {
  if (id === LOCAL_ID) return { ok: false, error: 'This machine cannot be edited.' };
  const data = loadServers(file);
  const server = data.servers.find((s) => s.id === id);
  if (!server) return { ok: false, error: 'That server is no longer in the list.' };

  if (name !== undefined) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return { ok: false, error: 'Enter a name for this server.' };
    server.name = trimmed;
  }

  if (url !== undefined) {
    let normalized;
    try {
      normalized = normalizeUrl(url, DEFAULT_PORT);
    } catch (err) {
      return { ok: false, error: err.message === 'Enter the server address.' ? err.message : 'Invalid server address.' };
    }
    if (data.servers.some((s) => s.id !== id && s.url === normalized)) {
      return { ok: false, error: 'Another server in the list already uses that address.' };
    }
    server.url = normalized;
  }

  if (host !== undefined) {
    const trimmed = String(host || '').trim();
    if (trimmed) server.host = trimmed;
    else delete server.host;
  }

  if (typeof key === 'string' && key) server.key = key;

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

/**
 * Re-find a server whose address moved, and save the new one only once it has
 * answered with the stored password. Three sources, cheapest first: the saved
 * machine name, the address already stored, then a sweep of this machine's own
 * subnets. A rescan that reaches nothing leaves the entry untouched, so it can
 * never be worse than not rescanning.
 *
 * When the sweep finds several ai-tabs servers that accept this entry's
 * password, it refuses to guess and hands them back as `candidates`.
 */
async function rescanServer(file, id, {
  lookupImpl, fetchImpl, probeImpl, subnets, scan = true,
} = {}) {
  const data = loadServers(file);
  const server = data.servers.find((s) => s.id === id);
  if (!server || !server.url) return { ok: false, error: 'That server is no longer in the list.' };

  // Never move one entry onto another entry's address.
  const taken = new Set(data.servers.filter((s) => s.id !== id && s.url).map((s) => s.url));
  const port = Number(new URL(server.url).port) || DEFAULT_PORT;
  const host = server.host || hostnameOf(server.url);

  const tried = new Set();
  const accepts = async (origin) => {
    if (!origin || tried.has(origin) || taken.has(origin)) return false;
    tried.add(origin);
    const check = await validateServer(origin, server.key, fetchImpl);
    return check.ok;
  };

  let found = null;
  let lookupError = null;

  // 1. Whatever the machine name resolves to now, this LAN first.
  if (host) {
    let addresses = [];
    try {
      addresses = await resolveHostAddresses(host, lookupImpl);
    } catch (err) {
      lookupError = `Could not find ${host} on the network: ${err.message}`;
    }
    for (const address of rankAddresses(addresses, subnets)) {
      const origin = withHostname(server.url, address);
      if (await accepts(origin)) { found = origin; break; }
    }
  }

  // 2. The stored address — this is what detects "nothing changed".
  if (!found && await accepts(server.url)) found = server.url;

  // 3. Sweep. This is what finds a server whose name resolves to nothing
  //    useful, including an entry that was only ever saved as an IP.
  let candidates = [];
  if (!found && scan) {
    const origins = await scanLanForServers(port, { subnets, probeImpl, fetchImpl });
    for (const origin of origins) {
      if (await accepts(origin)) candidates.push(origin);
    }
    if (candidates.length === 1) [found] = candidates;
  }

  if (!found) {
    if (candidates.length > 1) {
      return {
        ok: false,
        candidates,
        error: `Found ${candidates.length} ai-tabs servers on this network — pick the right one: ${candidates.join(', ')}`,
      };
    }
    return { ok: false, error: lookupError || `Could not find ${server.name} on this network.` };
  }

  if (found === server.url) return { ok: true, changed: false, url: found, host: host || null };

  const saved = updateServer(file, id, { url: found });
  if (!saved.ok) return saved;
  return { ok: true, changed: true, url: found, host: host || null };
}

module.exports = {
  LOCAL_ID, DEFAULT_PORT, VALIDATE_TIMEOUT_MS, SCAN_PORT_TIMEOUT_MS,
  loadServers, saveServers, generateId,
  parseServerArg, resolveLaunchTarget,
  normalizeUrl, parseAddress, isIpAddress, withHostname, hostnameOf,
  resolveHostIp, resolveHostAddresses,
  localSubnets, isSameSubnet, subnetHosts, rankAddresses,
  probeTcp, looksLikeAiTabs, scanLanForServers,
  addServer, updateServer, removeServer, seedServersFile,
  validateServer, rescanServer,
};
