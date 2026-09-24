/**
 * Claude Code statusLine payloads carry `rate_limits` for Claude.ai
 * subscribers (Pro/Max) after the first API response:
 *
 *   rate_limits: {
 *     five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
 *     seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
 *   }
 *
 * used_percentage is 0-100, resets_at is Unix epoch SECONDS, and each window
 * may be independently absent. API-key users get no rate_limits at all.
 * Normalised shape: { fiveHour: { usedPct, resetsAt } | null, sevenDay: ... }
 * with resetsAt in epoch milliseconds, or null when neither window is present.
 */

const WINDOWS = Object.freeze([
  ['five_hour', 'fiveHour'],
  ['seven_day', 'sevenDay'],
]);
const PCT_MAX = 100;
const SECONDS_TO_MS = 1000;

function parseWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pct = Number(raw.used_percentage);
  if (!Number.isFinite(pct)) return null;
  const resetsRaw = Number(raw.resets_at);
  return {
    usedPct: Math.min(PCT_MAX, Math.max(0, pct)),
    resetsAt: Number.isFinite(resetsRaw) && resetsRaw > 0 ? Math.round(resetsRaw * SECONDS_TO_MS) : null,
  };
}

function parseRateLimits(payload) {
  const rl = payload && payload.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const out = {};
  let any = false;
  for (const [rawKey, key] of WINDOWS) {
    const win = parseWindow(rl[rawKey]);
    out[key] = win;
    if (win) any = true;
  }
  return any ? out : null;
}

module.exports = { parseRateLimits, parseWindow };
