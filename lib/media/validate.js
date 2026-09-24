const os = require('os');
const path = require('path');
const { normalizeMime } = require('./extract');

/**
 * Payload validation and header sniffing for the media store. Everything the
 * hook route accepts passes through parseHookPayload first; nothing here
 * touches the disk.
 */

const MAX_IMAGES_PER_PAYLOAD = 8;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const HOOK_BODY_LIMIT = '40mb';
const MAX_META_CHARS = 2048;

const SESSION_ID_RE = /^\d+$/;
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function cleanString(value) {
  return typeof value === 'string' && value ? value.slice(0, MAX_META_CHARS) : null;
}

/**
 * @param {unknown} body parsed JSON from the forwarder
 * @returns {{ok:false, error:string} | {ok:true, tabSessionId:number, meta:object, images:object[]}}
 */
function parseHookPayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'payload must be an object' };
  const rawId = String(body.tabSessionId ?? '');
  if (!SESSION_ID_RE.test(rawId)) return { ok: false, error: 'tabSessionId must be an integer' };
  const tabSessionId = parseInt(rawId, 10);

  if (!Array.isArray(body.images) || body.images.length === 0) {
    return { ok: false, error: 'images must be a non-empty array' };
  }
  if (body.images.length > MAX_IMAGES_PER_PAYLOAD) {
    return { ok: false, error: `at most ${MAX_IMAGES_PER_PAYLOAD} images per payload` };
  }

  const images = [];
  for (const img of body.images) {
    if (!img || typeof img !== 'object') return { ok: false, error: 'image entries must be objects' };
    const mime = normalizeMime(img.mime);
    if (!mime) return { ok: false, error: `unsupported mime: ${String(img.mime).slice(0, 40)}` };
    if (typeof img.data === 'string' && img.data) {
      const buf = Buffer.from(img.data, 'base64');
      if (buf.length === 0) return { ok: false, error: 'image data is not base64' };
      if (buf.length > MAX_IMAGE_BYTES) return { ok: false, error: 'image exceeds size cap' };
      images.push({ mime, buf });
    } else if (typeof img.path === 'string' && img.path) {
      images.push({ mime, path: img.path.slice(0, MAX_META_CHARS) });
    } else {
      return { ok: false, error: 'image needs data or path' };
    }
  }

  return {
    ok: true,
    tabSessionId,
    images,
    meta: {
      agentSessionId: cleanString(body.agentSessionId),
      transcriptPath: cleanString(body.transcriptPath),
      toolName: cleanString(body.toolName),
      toolUseId: cleanString(body.toolUseId),
      cwd: cleanString(body.cwd),
      sourcePath: cleanString(body.sourcePath),
    },
  };
}

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Absolute path of a file the hook asked us to import by reference, or null
 * unless it sits inside one of the allowed roots (session cwd, OS temp dir).
 * @param {string} candidate
 * @param {(string|null)[]} roots
 */
function resolveImportPath(candidate, roots) {
  if (typeof candidate !== 'string' || !candidate) return null;
  const abs = path.resolve(candidate);
  const allowed = [os.tmpdir(), ...roots].filter(Boolean).map((r) => path.resolve(r));
  return allowed.some((root) => isInside(root, abs)) ? abs : null;
}

function jpegDimensions(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

function webpDimensions(buf) {
  if (buf.length < 30 || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/**
 * Pixel size from the file header, without an image library.
 * @returns {{width:number, height:number}|null}
 */
function imageDimensions(buf, mime) {
  try {
    if (mime === 'image/png' && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/gif' && buf.length >= 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === 'image/jpeg') return jpegDimensions(buf);
    if (mime === 'image/webp') return webpDimensions(buf);
  } catch {}
  return null;
}

module.exports = {
  parseHookPayload,
  resolveImportPath,
  imageDimensions,
  isInside,
  MAX_IMAGES_PER_PAYLOAD,
  MAX_IMAGE_BYTES,
  HOOK_BODY_LIMIT,
  SESSION_ID_RE,
  FILE_NAME_RE,
};
