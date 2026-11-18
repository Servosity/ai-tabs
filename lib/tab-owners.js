// One driver per tab. Everyone attached to a session sees its output; only
// the owner's keystrokes and resizes reach the PTY. Ownership belongs to a
// client identity ({ id, name }, self-declared by each browser or desktop
// app), not to a socket, so one person with two windows on a tab drives
// from both.
//
// Rules:
// - The client that creates a session owns it. A session the server starts
//   by itself (headless open-tab) starts unowned.
// - The first keystroke into an unowned tab claims it.
// - claim() takes a tab from its owner at any time ("Take this tab").
// - When the owner's last socket on a tab goes away, the tab is released
//   after a grace period, so a reconnecting owner keeps it.

const DEFAULT_RELEASE_GRACE_MS = 5000;
const ANON_NAME = 'Someone';
const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 40;

/** A client identity from a create/attach/identify message, with defaults. */
function normalizeClient(raw, fallbackId) {
  const id = raw && typeof raw.id === 'string' && raw.id.trim()
    ? raw.id.trim().slice(0, MAX_ID_LENGTH)
    : fallbackId;
  const name = raw && typeof raw.name === 'string' && raw.name.trim()
    ? raw.name.trim().slice(0, MAX_NAME_LENGTH)
    : ANON_NAME;
  return { id, name };
}

function createTabOwners({
  graceMs = DEFAULT_RELEASE_GRACE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onChange = () => {},
} = {}) {
  const owners = new Map(); // sessionId → { id, name }
  const releaseTimers = new Map(); // sessionId → timer

  function cancelRelease(sessionId) {
    const timer = releaseTimers.get(sessionId);
    if (timer) {
      clearTimer(timer);
      releaseTimers.delete(sessionId);
    }
  }

  function get(sessionId) {
    return owners.get(sessionId) || null;
  }

  function set(sessionId, client) {
    cancelRelease(sessionId);
    const prev = owners.get(sessionId);
    if (prev && prev.id === client.id && prev.name === client.name) return;
    owners.set(sessionId, { id: client.id, name: client.name });
    onChange(sessionId, get(sessionId));
  }

  /** True when client may type into / resize the tab without claiming it. */
  function mayDrive(sessionId, client) {
    const owner = owners.get(sessionId);
    return !owner || owner.id === client.id;
  }

  /** Keystroke gate: the owner passes, an unowned tab is claimed, others are refused. */
  function drive(sessionId, client) {
    const owner = owners.get(sessionId);
    if (!owner) {
      set(sessionId, client);
      return true;
    }
    return owner.id === client.id;
  }

  /** The owner went away from this tab: release it unless they come back in time. */
  function scheduleRelease(sessionId) {
    if (!owners.has(sessionId) || releaseTimers.has(sessionId)) return;
    const timer = setTimer(() => {
      releaseTimers.delete(sessionId);
      if (!owners.delete(sessionId)) return;
      onChange(sessionId, null);
    }, graceMs);
    if (timer && typeof timer.unref === 'function') timer.unref(); // never holds the process open
    releaseTimers.set(sessionId, timer);
  }

  /** The owner renamed themself: carry the new name on every tab they own. */
  function rename(client) {
    for (const [sessionId, owner] of owners) {
      if (owner.id === client.id && owner.name !== client.name) set(sessionId, client);
    }
  }

  /** The session ended. */
  function forget(sessionId) {
    cancelRelease(sessionId);
    owners.delete(sessionId);
  }

  return {
    get, mayDrive, drive, claim: set, set, scheduleRelease, cancelRelease, rename, forget,
  };
}

module.exports = { createTabOwners, normalizeClient, DEFAULT_RELEASE_GRACE_MS, ANON_NAME };
