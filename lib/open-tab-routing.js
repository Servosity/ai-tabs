/**
 * Routing for /api/open-tab: which control client opens the tab, which of
 * its windows gets it, what URL it loads, and whether anyone took it.
 *
 * Pure functions shared by server.js (target choice, claim status) and
 * main.js (window choice, URL rebasing) so both halves of the handshake are
 * testable without Electron.
 */

// A request nobody acks within this long reports claimed:false.
const OPEN_TAB_CLAIM_GRACE_MS = Number(process.env.AI_TABS_OPEN_TAB_CLAIM_GRACE_MS || 5000);
const WS_OPEN = 1;
// Never carried over from the server's URL: remote auth is added by the
// client's own load suffix, from its own configured key.
const UNTRUSTED_PARAMS = Object.freeze(['key']);

/**
 * Rebuild an open-tab URL onto the client's own server base. The server's
 * URL names ITS localhost, which is another machine for a remote client, so
 * only the query string is trusted — never the origin.
 */
function rebaseOpenTabUrl(msgUrl, baseUrl) {
  let query = '';
  if (typeof msgUrl === 'string') {
    const q = msgUrl.indexOf('?');
    if (q !== -1) query = msgUrl.slice(q + 1).split('#')[0];
  }
  const params = new URLSearchParams(query);
  for (const name of UNTRUSTED_PARAMS) params.delete(name);
  const base = String(baseUrl).replace(/\/+$/, '');
  const search = params.toString();
  return search ? `${base}/?${search}` : `${base}/`;
}

/**
 * Server side: pick the one control client that opens the tab.
 *   1. a live client that reported owning the addressed window (the
 *      controller wins a window-id collision between processes);
 *   2. else the live controller, in its first window;
 *   3. else the only live control client, in its first window.
 * Returns { client, windowId } or null when nobody fits.
 */
function pickOpenTabTarget({ clients, controller, windowId }) {
  const live = [...clients].filter((c) => c && c.readyState === WS_OPEN);
  if (live.length === 0) return null;
  if (windowId != null) {
    const wanted = String(windowId);
    const owners = live.filter((c) => Array.isArray(c._windowIds) && c._windowIds.includes(wanted));
    if (owners.length > 0) {
      return { client: owners.includes(controller) ? controller : owners[0], windowId: wanted };
    }
  }
  if (controller && live.includes(controller)) return { client: controller, windowId: null };
  if (live.length === 1) return { client: live[0], windowId: null };
  return null;
}

/**
 * Client side: the window an open-tab message lands in, or null to ignore it.
 * `assigned` means the server chose this client, so it must open the tab
 * somewhere; unassigned messages keep the legacy broadcast rules.
 */
function resolveOpenTabWindow(windows, { windowId, assigned } = {}, isController = null) {
  const first = () => windows.values().next().value || null;
  const requested = windowId != null ? parseInt(windowId, 10) : null;
  if (requested != null && windows.has(requested)) return windows.get(requested);
  if (assigned === true) return first();
  if (requested != null) return null; // not our window — the owning instance handles it
  return isController === true ? first() : null;
}

/**
 * Server side: the claim half of /api/requests/:id/status.
 * claimed: true once a client acked (or the session already exists),
 * false once the grace period passes without one, null while still waiting.
 */
function openTabClaimStatus(entry, now = Date.now(), graceMs = OPEN_TAB_CLAIM_GRACE_MS) {
  if (entry.claimedBy != null || entry.sessionId != null) {
    return { claimed: true, claimedBy: entry.claimedBy ?? null };
  }
  if (now - entry.createdAt >= graceMs) return { claimed: false, claimedBy: null };
  return { claimed: null, claimedBy: null };
}

module.exports = {
  OPEN_TAB_CLAIM_GRACE_MS,
  rebaseOpenTabUrl,
  pickOpenTabTarget,
  resolveOpenTabWindow,
  openTabClaimStatus,
};
