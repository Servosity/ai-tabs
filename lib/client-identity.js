// The desktop app's identity on shared tabs: a random id made once per
// install and a display name (the OS user until the person sets one). Kept in
// the client's userData, never on the server: it describes this machine's
// user, whichever server the app is connected to.
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const MAX_NAME_LENGTH = 40;

function defaultName() {
  try { return os.userInfo().username || 'Someone'; } catch { return 'Someone'; }
}

function readFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeFile(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {}
}

/** { id, name } for this install, creating the id on first use. */
function loadIdentity(file) {
  const saved = readFile(file);
  let { id, name } = saved;
  if (typeof id !== 'string' || !id) {
    id = 'd-' + crypto.randomBytes(12).toString('hex');
    writeFile(file, { ...saved, id });
  }
  const clean = typeof name === 'string' ? name.trim() : '';
  return { id, name: clean || defaultName() };
}

/** Save a display name (blank goes back to the OS user); returns the identity. */
function saveName(file, name) {
  const current = loadIdentity(file);
  const clean = String(name || '').trim().slice(0, MAX_NAME_LENGTH);
  writeFile(file, { ...readFile(file), id: current.id, name: clean });
  return loadIdentity(file);
}

module.exports = { loadIdentity, saveName };
