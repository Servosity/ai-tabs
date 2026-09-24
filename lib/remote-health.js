// Startup health-wait for remote mode. Each probe carries its own abort
// deadline: without one, fetch against a host that is DOWN (VM off, IP moved)
// blocks on the OS TCP connect timeout (~21s on Windows) per attempt, and the
// retry loop that was budgeted as "~5 seconds" silently becomes ~17 minutes of
// windowless hang before the error dialog can appear.

const REMOTE_HEALTH_ATTEMPTS = 5;
const REMOTE_HEALTH_PROBE_TIMEOUT_MS = 800;
const REMOTE_HEALTH_RETRY_DELAY_MS = 200;
// Worst case: ATTEMPTS × (PROBE_TIMEOUT + RETRY_DELAY) = 5 s — the budget the
// original loop intended.

/**
 * Poll `${remoteServerUrl}/api/health` until it answers 200, an auth/allowlist
 * rejection (401/403) proves retrying is pointless, or the attempts run out.
 * Throws Error with `remoteStatus` (last HTTP status, or null if the host
 * never answered) — the startup dialog in main.js keys its message off that.
 *
 * `fetchImpl` is apiFetch in production (attaches the bearer key) and a plain
 * or fake fetch in tests. Timeout aborts surface as exceptions and count as
 * failed attempts like any other network error.
 */
async function waitForRemoteHealth(remoteServerUrl, fetchImpl, {
  attempts = REMOTE_HEALTH_ATTEMPTS,
  probeTimeoutMs = REMOTE_HEALTH_PROBE_TIMEOUT_MS,
  retryDelayMs = REMOTE_HEALTH_RETRY_DELAY_MS,
} = {}) {
  let lastStatus = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(`${remoteServerUrl}/api/health`, {
        signal: AbortSignal.timeout(probeTimeoutMs),
      });
      if (res.ok) return;
      lastStatus = res.status;
      // Auth or host-allowlist rejection won't fix itself — stop retrying.
      if (res.status === 401 || res.status === 403) break;
    } catch {}
    await new Promise(r => setTimeout(r, retryDelayMs));
  }
  const err = new Error(`Cannot reach remote ai-tabs server at ${remoteServerUrl}`);
  err.remoteStatus = lastStatus;
  throw err;
}

module.exports = {
  waitForRemoteHealth,
  REMOTE_HEALTH_ATTEMPTS,
  REMOTE_HEALTH_PROBE_TIMEOUT_MS,
  REMOTE_HEALTH_RETRY_DELAY_MS,
};
