// Spawns a real server.js with a password set and a temp data dir, reachable
// via the machine's own LAN IP (localhost is auth-exempt; only a non-loopback
// address exercises remote auth). Shared by remote-integration and
// control-handoff tests.
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PASSWORD = 'remote-test-pass';

function firstOwnIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startTestServer(opts = {}) {
  const ownIp = firstOwnIPv4();
  if (!ownIp) return { base: null, port: null, ownIp: null, child: null, tmpDir: null, password: PASSWORD };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tabs-remote-'));
  const authFile = path.join(tmpDir, 'auth-key.json');
  const projectsRoot = path.join(tmpDir, 'projects');
  fs.mkdirSync(path.join(projectsRoot, 'demo-project'), { recursive: true });

  process.env.AI_TABS_AUTH_FILE = authFile;
  require('../../lib/auth').setPassword(PASSWORD);

  const port = await freePort();
  const base = `http://${ownIp}:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'server.js')], {
    env: {
      ...process.env,
      AI_TABS_PORT: String(port),
      AI_TABS_AUTH_FILE: authFile,
      PROJECTS_ROOT: projectsRoot,
      ...(opts.env || {}),
    },
    stdio: 'ignore',
  });

  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error('spawned server never came up');
    await new Promise((r) => setTimeout(r, 100));
  }
  return { base, port, ownIp, child, tmpDir, password: PASSWORD };
}

function stopTestServer(handle) {
  if (handle?.child) handle.child.kill();
  if (handle?.tmpDir) fs.rmSync(handle.tmpDir, { recursive: true, force: true });
}

module.exports = { startTestServer, stopTestServer, PASSWORD };
