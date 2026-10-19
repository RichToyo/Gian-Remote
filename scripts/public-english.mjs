import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Binary extensions that a text scan must not treat as reviewed copy.
 * Acceptance is an exact path plus SHA-256 in the media review manifest.
 * An extension is not an allowlist. SVG is text and is never listed here. */
export const BINARY_MEDIA_EXTENSIONS = new Set([
  '.png', '.webp', '.icns', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.pdf',
  '.woff', '.woff2', '.ttf', '.otf', '.wasm', '.zip', '.gz', '.tgz', '.dmg',
  '.mp3', '.mp4', '.mov', '.wav', '.node', '.dylib', '.so',
]);

/** Dated runtime captures. Public exports omit the whole directory.
 * Private git keeps the bytes. This is not a per-file language filter. */
export function isHistoricalProxyEvidence(path) {
  return /^packages\/proxies\/[^/]+\/evidence\//.test(path);
}

export function isPublicPath(path) {
  return !/^(AGENTS\.md|CLAUDE\.md|ONBOARDING\.md)$/.test(path)
    && !/^(docs|design|e2e|\.agents|\.claude|\.codex|\.ai|\.cursor)\//.test(path)
    && !/^\.github\/workflows\/(ci|dev-package|nightly-e2e|giandev-acceptance|security-audit|release-owner-065|remote)\.yml$/.test(path)
    && !isHistoricalProxyEvidence(path);
}

const HAN = /\p{Script=Han}/u;
const ESCAPE = /\\u\{([0-9A-Fa-f]+)\}|\\u([0-9A-Fa-f]{4})|&#([xX])([0-9A-Fa-f]+);|&#([0-9]{1,7});/g;

export function mediaReviewPath() {
  return fileURLToPath(new URL('./media-review.json', import.meta.url));
}

export function loadMediaReviews(raw = readFileSync(mediaReviewPath(), 'utf8')) {
  const parsed = JSON.parse(raw);
  if (parsed?.schema !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    throw new Error('Media review manifest must be schema 1 with at least one exact entry');
  }
  if (parsed.extensions || parsed.allowExtensions || parsed.globs) {
    throw new Error('Media review cannot allow an extension or glob; list each path and SHA-256');
  }
  const byPath = new Map();
  for (const entry of parsed.entries) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      throw new Error('Each media review entry needs a path and sha256');
    }
    if (entry.path.startsWith('/') || entry.path.split('/').some(part => !part || part === '.' || part === '..' || part.includes('*') || part.includes('?'))) {
      throw new Error(`Media review path must be one relative file: ${entry.path}`);
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Media review SHA-256 is invalid: ${entry.path}`);
    const extension = extensionOf(entry.path);
    if (extension === '.svg' || !BINARY_MEDIA_EXTENSIONS.has(extension)) {
      throw new Error(`Media review cannot replace a text scan for ${entry.path}`);
    }
    if (byPath.has(entry.path)) throw new Error(`Duplicate media review path: ${entry.path}`);
    byPath.set(entry.path, { path: entry.path, sha256: entry.sha256, kind: extension.slice(1) });
  }
  return byPath;
}

export function scanPublicEntries(entries, reviews) {
  if (!(reviews instanceof Map)) throw new Error('Media reviews must be the loaded path map');
  const violations = [];
  const reviewedMedia = [];
  const seen = new Set();
  for (const entry of entries) {
    const path = entry?.path;
    if (typeof path !== 'string' || seen.has(path)) {
      violations.push({ path: String(path), kind: 'unsafe-entry', detail: 'Each scanned file needs one relative path' });
      continue;
    }
    seen.add(path);
    if (path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) {
      violations.push({ path, kind: 'unsafe-entry', detail: 'Path must stay inside the exported tree' });
      continue;
    }
    const pathHan = firstHan(path);
    if (pathHan) violations.push({ path, kind: 'han-path', detail: `Han character in path at index ${pathHan.index}` });
    const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(entry.bytes ?? '');
    const extension = extensionOf(path);
    if (extension === '.svg' || !BINARY_MEDIA_EXTENSIONS.has(extension)) {
      const decoded = decodeText(bytes);
      if (!decoded) {
        violations.push({
          path,
          kind: 'unreviewed-binary',
          sha256: sha256(bytes),
          detail: 'Bytes are not strict UTF-8 or BOM-prefixed UTF-16 text. Add an exact media review entry after visual inspection, or keep the file out of the public tree.',
        });
        continue;
      }
      const textHan = firstHan(decoded.text);
      if (textHan) {
        violations.push({
          path,
          kind: 'han-text',
          encoding: decoded.encoding,
          detail: `Han character at index ${textHan.index}`,
        });
      }
      const hidden = firstHiddenHan(decoded.text);
      if (hidden) {
        violations.push({
          path,
          kind: 'han-escape',
          encoding: decoded.encoding,
          detail: `Encoded Han via ${hidden.form} at index ${hidden.index}`,
        });
      }
      continue;
    }
    const digest = sha256(bytes);
    const review = reviews.get(path);
    if (!review) {
      violations.push({
        path,
        kind: 'unreviewed-media',
        sha256: digest,
        detail: 'No exact path review. A matching digest at another path is not enough, and the extension is not an allowlist.',
      });
      continue;
    }
    if (review.sha256 !== digest) {
      violations.push({
        path,
        kind: 'media-hash-mismatch',
        sha256: digest,
        expectedSha256: review.sha256,
        detail: 'Reviewed bytes changed. A new visual review must record this path and digest.',
      });
      continue;
    }
    reviewedMedia.push({ path, sha256: digest, kind: review.kind });
  }
  return { ok: violations.length === 0, violations, reviewedMedia };
}

export function assertPublicEnglish(entries, reviews) {
  const result = scanPublicEntries(entries, reviews);
  if (result.ok) return result;
  const lines = result.violations.slice(0, 30).map(item => `${item.path}: ${item.kind}: ${item.detail}`);
  const more = result.violations.length > 30 ? `\n${result.violations.length - 30} more` : '';
  throw new Error(`Public English gate failed (${result.violations.length})\n${lines.join('\n')}${more}`);
}

function extensionOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function firstHan(text) {
  const match = HAN.exec(text);
  HAN.lastIndex = 0;
  return match ? { index: match.index } : null;
}

function isHanScalar(codePoint) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return false;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  const character = String.fromCodePoint(codePoint);
  const matched = HAN.test(character);
  HAN.lastIndex = 0;
  return matched;
}

function escapeCode(match) {
  const hex = match[1] ?? match[2] ?? match[4];
  if (hex !== undefined) {
    if (hex.length > 6) return null;
    return Number.parseInt(hex, 16);
  }
  return match[5] === undefined ? null : Number(match[5]);
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Encoded scalars that render as Han fail. Property syntax such as
 * \\p{Script=Han} is not an encoded character. Adjacent surrogate escapes
 * are one scalar. This scan does not execute source or decode base64. */
function firstHiddenHan(text) {
  ESCAPE.lastIndex = 0;
  const matches = [...text.matchAll(ESCAPE)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    let code = escapeCode(match);
    if (!Number.isInteger(code)) continue;
    const next = matches[index + 1];
    if (isHighSurrogate(code) && next && next.index === match.index + match[0].length) {
      const low = escapeCode(next);
      if (!isLowSurrogate(low)) continue;
      code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
      index += 1;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      continue;
    }
    if (!isHanScalar(code)) continue;
    return { index: match.index, form: match[0].startsWith('\\u') ? 'unicode-escape' : 'html-entity' };
  }
  return null;
}

/** BOM-prefixed UTF-16 is text only when the payload length is even and every
 * surrogate is paired. Odd bytes, lone surrogates, and a UTF-32 LE BOM are
 * unreviewed binary, not a text bypass. UTF-16 without a BOM is not guessed. */
function decodeUtf16(payload, littleEndian) {
  if (payload.length % 2 !== 0) return null;
  let text = '';
  for (let index = 0; index < payload.length; index += 2) {
    const unit = littleEndian
      ? payload[index] | (payload[index + 1] << 8)
      : (payload[index] << 8) | payload[index + 1];
    if (isHighSurrogate(unit)) {
      if (index + 3 >= payload.length) return null;
      const low = littleEndian
        ? payload[index + 2] | (payload[index + 3] << 8)
        : (payload[index + 2] << 8) | payload[index + 3];
      if (!isLowSurrogate(low)) return null;
      text += String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00));
      index += 2;
    } else if (isLowSurrogate(unit)) {
      return null;
    } else {
      text += String.fromCharCode(unit);
    }
  }
  return text;
}

function decodeText(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) {
    return null;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = decodeUtf16(bytes.subarray(2), true);
    return text == null ? null : { encoding: 'utf-16le', text };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const text = decodeUtf16(bytes.subarray(2), false);
    return text == null ? null : { encoding: 'utf-16be', text };
  }
  const payload = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    ? bytes.subarray(3) : bytes;
  if (payload.includes(0)) return null;
  const text = payload.toString('utf8');
  if (Buffer.compare(Buffer.from(text, 'utf8'), payload) !== 0) return null;
  return { encoding: bytes === payload ? 'utf-8' : 'utf-8-bom', text };
}
