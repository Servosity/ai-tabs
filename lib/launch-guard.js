// Guards against another website driving the app page.
//
// The terminal page acts on its query string on load: ?cwd= opens a shell
// there, ?agent=...&agentBypass=1 launches an agent with permission prompts
// off. hostGuard/originGuard don't cover this — a top-level navigation from
// evil.com to http://localhost:25283/?... loads OUR page on OUR origin, so its
// WebSocket passes the Origin check. So refuse such loads when the browser
// says the navigation came from another site, and refuse to be framed.

// Pages whose query string launches or attaches a session.
const LAUNCH_PAGES = Object.freeze(new Set(['/', '/index.html']));
// Sec-Fetch-Site values for navigations we did not start ourselves.
const FOREIGN_FETCH_SITES = Object.freeze(new Set(['cross-site', 'same-site']));

function refererIsForeign(req) {
  const referer = req.headers.referer;
  if (!referer) return false;
  try {
    return new URL(referer).host !== req.headers.host;
  } catch {
    return true;
  }
}

/**
 * True when a GET of the app page carries launch params and was started by a
 * different site. Electron loadURL, typed URLs and bookmarks send
 * Sec-Fetch-Site: none; the app's own links send same-origin. Browsers omit the
 * header on plain-http LAN origins, so fall back to the Referer there.
 */
function isForeignLaunch(req) {
  if (req.method !== 'GET' || !LAUNCH_PAGES.has(req.path)) return false;
  const queryStart = req.originalUrl.indexOf('?');
  if (queryStart === -1 || queryStart === req.originalUrl.length - 1) return false;
  const site = req.headers['sec-fetch-site'];
  if (site) return FOREIGN_FETCH_SITES.has(site);
  return refererIsForeign(req);
}

function launchGuard(req, res, next) {
  // Never render inside another site's frame (clickjacking, framed launches).
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  if (isForeignLaunch(req)) {
    console.warn(`[launchGuard] rejected cross-site launch from ${req.headers.referer || req.headers['sec-fetch-site']}`);
    res.status(403).type('text/plain').send('Forbidden: launch links must come from ai-tabs itself');
    return;
  }
  next();
}

module.exports = { launchGuard, isForeignLaunch };
