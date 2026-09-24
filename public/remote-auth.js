// Injects the remote-access key as an Authorization header on same-origin /api
// fetches. Loaded by every page the Electron shell serves from the server; in
// local mode (no key in the URL) it changes nothing. The header form keeps the
// key out of server access logs, unlike ?key=.
(function (global) {
  'use strict';

  // Same source as wsAuthKey in index.html: hash first (withLoadSuffix puts the
  // key there), then the search string.
  function readAuthKey(loc) {
    try {
      const hashParams = new URLSearchParams((loc.hash || '').replace(/^#/, ''));
      const fromHash = hashParams.get('key');
      if (fromHash) return fromHash;
      return new URLSearchParams(loc.search || '').get('key') || null;
    } catch {
      return null;
    }
  }

  // Returns true when a wrapper was installed, false when the page has no key
  // (local mode: fetch is left completely untouched).
  function installRemoteAuthFetch(win) {
    const key = readAuthKey(win.location);
    if (!key) return false;
    const baseFetch = win.fetch.bind(win);
    const pageOrigin = new URL(win.location.href).origin;
    win.fetch = function (input, init) {
      let target;
      try {
        target = new URL(
          typeof input === 'string' ? input : (input && input.url) || String(input),
          win.location.href
        );
      } catch {
        return baseFetch(input, init);
      }
      const isApi = target.pathname === '/api' || target.pathname.startsWith('/api/');
      if (target.origin !== pageOrigin || !isApi) return baseFetch(input, init);
      const headers = new Headers(
        (init && init.headers)
          || (input && typeof input === 'object' && input.headers)
          || undefined
      );
      if (!headers.has('authorization')) headers.set('Authorization', 'Bearer ' + key);
      return baseFetch(input, Object.assign({}, init, { headers }));
    };
    return true;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { installRemoteAuthFetch, readAuthKey };
  }
  if (global && typeof global.fetch === 'function' && global.location) {
    installRemoteAuthFetch(global);
  }
})(typeof window !== 'undefined' ? window : null);
