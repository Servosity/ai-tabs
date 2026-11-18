// Shared tabs, client side: who this client is, and the banner that says who
// drives the tab. The server decides ownership (lib/tab-owners.js) and sends
// {type:'owner'} on attach, on create and whenever the driver changes; this
// file only shows it and asks for the tab back.
//
// Identity: the desktop app hands one over (electronIdentity, term-preload.js);
// a browser keeps a random id and a typed-in name in localStorage.
(function (global) {
  'use strict';

  const ID_KEY = 'aitabs-client-id';
  const NAME_KEY = 'aitabs-client-name';
  const DEFAULT_NAME = 'Someone';
  const NAME_PROMPT = 'Your name — shown to others on shared tabs';
  const BLOCKED_FLASH_MS = 1200;

  function randomId(cryptoObj) {
    // getRandomValues works on plain-http origins; randomUUID does not.
    const bytes = new Uint8Array(12);
    cryptoObj.getRandomValues(bytes);
    return 'c-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function safeGet(storage, key) {
    try { return storage.getItem(key); } catch { return null; }
  }

  function safeSet(storage, key, value) {
    try { storage.setItem(key, value); } catch {}
  }

  /** Browser identity: a stored id (made once) and a name asked for once. */
  function browserIdentity(storage, cryptoObj, askName) {
    let id = safeGet(storage, ID_KEY);
    if (!id) {
      id = randomId(cryptoObj);
      safeSet(storage, ID_KEY, id);
    }
    let name = (safeGet(storage, NAME_KEY) || '').trim();
    if (!name && askName) {
      name = String(askName(NAME_PROMPT) || '').trim();
      if (name) safeSet(storage, NAME_KEY, name);
    }
    return { id, name: name || DEFAULT_NAME };
  }

  let cached = null;

  /** This client's { id, name }. Asks a browser user for a name the first time. */
  async function getIdentity() {
    if (cached) return cached;
    if (global.electronIdentity) {
      try {
        const fromApp = await global.electronIdentity.get();
        if (fromApp && fromApp.id) return (cached = fromApp);
      } catch {}
    }
    const ask = typeof global.prompt === 'function' ? (q) => global.prompt(q) : null;
    return (cached = browserIdentity(global.localStorage, global.crypto, ask));
  }

  /** Change this client's display name; returns the new identity. */
  async function setName(name) {
    const clean = String(name || '').trim();
    if (global.electronIdentity) {
      cached = await global.electronIdentity.set(clean);
      return cached;
    }
    safeSet(global.localStorage, NAME_KEY, clean);
    cached = null;
    return getIdentity();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /**
   * A bar over the terminal while someone else drives. update(ownerMsg, me)
   * shows or hides it; onClaim runs when "Take this tab" is clicked.
   */
  function createOwnerBanner(parent, { onClaim }) {
    const doc = parent.ownerDocument;
    const bar = doc.createElement('div');
    bar.className = 'owner-banner';
    bar.style.cssText = [
      'position:absolute', 'top:0', 'left:50%', 'transform:translateX(-50%)', 'z-index:50',
      'display:none', 'align-items:center', 'gap:10px', 'padding:4px 6px 4px 12px',
      'border-radius:0 0 8px 8px', 'font:12px system-ui,sans-serif',
      'background:rgba(30,30,46,0.92)', 'color:#e0e0e0', 'border:1px solid #555', 'border-top:none',
      'transition:background 0.2s',
    ].join(';');
    const text = doc.createElement('span');
    const btn = doc.createElement('button');
    btn.textContent = 'Take this tab';
    btn.style.cssText = 'font:inherit;padding:2px 10px;border-radius:4px;border:1px solid #888;background:#3a3a5a;color:#fff;cursor:pointer';
    btn.addEventListener('click', () => onClaim());
    bar.append(text, btn);
    if (doc.defaultView.getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    parent.appendChild(bar);

    let flashTimer = null;
    return {
      update(msg, me) {
        const owner = msg && msg.owner;
        const watching = !!owner && !!me && owner.id !== me.id;
        bar.style.display = watching ? 'flex' : 'none';
        if (!watching) return;
        text.innerHTML = `<b>${escapeHtml(owner.name)}</b> is driving this tab — you're watching.`;
        if (msg.blocked) {
          bar.style.background = 'rgba(160,60,40,0.95)';
          clearTimeout(flashTimer);
          flashTimer = setTimeout(() => { bar.style.background = 'rgba(30,30,46,0.92)'; }, BLOCKED_FLASH_MS);
        }
      },
    };
  }

  /** True when this client may type: nobody drives, or it does. */
  function canDrive(msg, me) {
    const owner = msg && msg.owner;
    return !owner || (!!me && owner.id === me.id);
  }

  const api = { getIdentity, setName, createOwnerBanner, canDrive, browserIdentity, DEFAULT_NAME, ID_KEY, NAME_KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.TabShare = api;
})(typeof window !== 'undefined' ? window : null);
