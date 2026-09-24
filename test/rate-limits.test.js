const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { parseRateLimits, parseWindow } = require('../lib/statusline/rate-limits');
const { formatRateLimitPills, formatResetIn, formatPct } = require('../public/sl-rate-limits');
const { StatuslineManager } = require('../lib/statusline');

// Shape from https://code.claude.com/docs/en/statusline: used_percentage is
// 0-100, resets_at is Unix epoch seconds, windows independently optional.
const DOC_PAYLOAD = {
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
  },
};

test('parseRateLimits: normalises both windows, seconds → ms', () => {
  const rl = parseRateLimits(DOC_PAYLOAD);
  assert.deepStrictEqual(rl, {
    fiveHour: { usedPct: 23.5, resetsAt: 1738425600000 },
    sevenDay: { usedPct: 41.2, resetsAt: 1738857600000 },
  });
});

test('parseRateLimits: absent for API-key users → null', () => {
  assert.strictEqual(parseRateLimits({}), null);
  assert.strictEqual(parseRateLimits({ rate_limits: null }), null);
  assert.strictEqual(parseRateLimits({ rate_limits: {} }), null);
  assert.strictEqual(parseRateLimits(null), null);
});

test('parseRateLimits: windows are independently optional', () => {
  const rl = parseRateLimits({ rate_limits: { five_hour: { used_percentage: 80 } } });
  assert.deepStrictEqual(rl, { fiveHour: { usedPct: 80, resetsAt: null }, sevenDay: null });
});

test('parseWindow: clamps to 0-100 and rejects non-numeric percentages', () => {
  assert.strictEqual(parseWindow({ used_percentage: 140 }).usedPct, 100);
  assert.strictEqual(parseWindow({ used_percentage: -5 }).usedPct, 0);
  assert.strictEqual(parseWindow({ used_percentage: 'lots' }), null);
  assert.strictEqual(parseWindow({ resets_at: 1 }), null);
  assert.strictEqual(parseWindow(null), null);
});

test('formatPct: whole percent, clamped', () => {
  assert.strictEqual(formatPct(23.5), '24%');
  assert.strictEqual(formatPct(0.2), '0%');
  assert.strictEqual(formatPct(250), '100%');
  assert.strictEqual(formatPct(undefined), '0%');
});

test('formatResetIn: days/hours/minutes granularity and "now"', () => {
  const now = 1_000_000_000_000;
  const H = 3600 * 1000;
  assert.strictEqual(formatResetIn(now + 2 * 24 * H + 5 * H, now), '2d 5h');
  assert.strictEqual(formatResetIn(now + H + 12 * 60 * 1000, now), '1h 12m');
  assert.strictEqual(formatResetIn(now + 7 * 60 * 1000, now), '7m');
  assert.strictEqual(formatResetIn(now + 10, now), '1m');
  assert.strictEqual(formatResetIn(now - 1, now), 'now');
  assert.strictEqual(formatResetIn(null, now), '');
});

test('formatRateLimitPills: "5h 42%" / "7d 18%" with ramp fraction and tooltip', () => {
  const now = 1738420000000;
  const pills = formatRateLimitPills({
    fiveHour: { usedPct: 42, resetsAt: now + 72 * 60 * 1000 },
    sevenDay: { usedPct: 18, resetsAt: null },
  }, now);
  assert.deepStrictEqual(pills.map((p) => p.text), ['5h 42%', '7d 18%']);
  assert.strictEqual(pills[0].frac, 0.42);
  assert.strictEqual(pills[0].title, '5-hour limit: 42% used · resets in 1h 12m');
  assert.strictEqual(pills[1].title, '7-day limit: 18% used');
});

test('formatRateLimitPills: hidden when absent or empty', () => {
  assert.deepStrictEqual(formatRateLimitPills(null), []);
  assert.deepStrictEqual(formatRateLimitPills(undefined), []);
  assert.deepStrictEqual(formatRateLimitPills({ fiveHour: null, sevenDay: null }), []);
  // Only the 7-day window present
  const pills = formatRateLimitPills({ fiveHour: null, sevenDay: { usedPct: 99.6, resetsAt: null } });
  assert.deepStrictEqual(pills.map((p) => p.text), ['7d 100%']);
  assert.ok(pills[0].frac > 0.99 && pills[0].frac <= 1);
});

test('StatuslineManager.applyHook carries rate limits through to the broadcast', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-rl-'));
  const broadcasts = [];
  const mgr = new StatuslineManager({
    isLive: () => true,
    hasClients: () => true,
    isEnabled: () => true,
    broadcast: (id, stats) => broadcasts.push({ id, stats }),
  });
  mgr.register(5, { agent: { id: 'claude', name: 'Claude Code', color: '#d97757', statusline: 'claude' }, cwd: dir });
  mgr.sessions.get(5).parser = null; // no transcript; hook synthesises the provider block

  mgr.applyHook('5', { ...DOC_PAYLOAD, cost: { total_cost_usd: 0.1 } });
  mgr._tickOne(5, true);
  const withLimits = broadcasts[broadcasts.length - 1].stats.provider;
  assert.deepStrictEqual(withLimits.rateLimits, {
    fiveHour: { usedPct: 23.5, resetsAt: 1738425600000 },
    sevenDay: { usedPct: 41.2, resetsAt: 1738857600000 },
  });

  // API-key payload: no rate_limits key at all → field absent, not stale.
  mgr.applyHook('5', { cost: { total_cost_usd: 0.2 } });
  mgr._tickOne(5, true);
  const without = broadcasts[broadcasts.length - 1].stats.provider;
  assert.strictEqual(without.rateLimits, undefined);
  assert.strictEqual(without.costUsd, 0.2);
});
