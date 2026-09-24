/**
 * Status-line rate-limit pills ("5h 42%", "7d 18%") for the Claude status
 * bar. Pure formatting over the normalised shape produced by
 * lib/statusline/rate-limits.js; the renderer (index.html slRender) turns
 * the returned descriptors into coloured spans. UMD so Node tests can
 * require it and the browser gets window.SlRateLimits.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SlRateLimits = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WINDOWS = [
    { key: 'fiveHour', label: '5h', name: '5-hour limit' },
    { key: 'sevenDay', label: '7d', name: '7-day limit' },
  ];
  const PCT_MAX = 100;
  const MS_PER_MIN = 60 * 1000;
  const MS_PER_HOUR = 60 * MS_PER_MIN;
  const MS_PER_DAY = 24 * MS_PER_HOUR;

  /** "3d 4h", "1h 12m", "5m", or "now" for a reset that has already passed. */
  function formatResetIn(resetsAtMs, nowMs) {
    if (typeof resetsAtMs !== 'number' || !Number.isFinite(resetsAtMs)) return '';
    const delta = resetsAtMs - (typeof nowMs === 'number' ? nowMs : Date.now());
    if (delta <= 0) return 'now';
    const days = Math.floor(delta / MS_PER_DAY);
    const hours = Math.floor((delta % MS_PER_DAY) / MS_PER_HOUR);
    const mins = Math.floor((delta % MS_PER_HOUR) / MS_PER_MIN);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${Math.max(1, mins)}m`;
  }

  /** Whole percent for display; clamps to 0-100. */
  function formatPct(usedPct) {
    const n = Math.min(PCT_MAX, Math.max(0, Number(usedPct) || 0));
    return `${Math.round(n)}%`;
  }

  /**
   * Descriptors for each present window, in 5h → 7d order:
   *   { key, label, text: '5h 42%', frac: 0.42, title: '5-hour limit: 42% used · resets in 1h 12m' }
   * Empty array when rateLimits is null / has no windows.
   */
  function formatRateLimitPills(rateLimits, nowMs) {
    if (!rateLimits || typeof rateLimits !== 'object') return [];
    const pills = [];
    for (const w of WINDOWS) {
      const win = rateLimits[w.key];
      if (!win || typeof win.usedPct !== 'number') continue;
      const pct = formatPct(win.usedPct);
      const resetIn = formatResetIn(win.resetsAt, nowMs);
      pills.push({
        key: w.key,
        label: w.label,
        text: `${w.label} ${pct}`,
        frac: Math.min(1, Math.max(0, win.usedPct / PCT_MAX)),
        title: `${w.name}: ${pct} used` + (resetIn ? ` · resets in ${resetIn}` : ''),
      });
    }
    return pills;
  }

  return { formatRateLimitPills, formatResetIn, formatPct };
});
