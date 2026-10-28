import { createPublicKey, verify as verifySignature } from 'node:crypto';

const MAX_TOKEN_LENGTH = 16 * 1024;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_JWKS_BYTES = 1024 * 1024;
const DEFAULT_UNKNOWN_KID_REFRESH_MS = 30_000;

function authError() {
  const error = new Error('Bearer token 无效或已过期。');
  error.name = 'UnauthenticatedError';
  return error;
}

function decodePart(value) {
  if (typeof value !== 'string' || !value || !BASE64URL_RE.test(value)) throw authError();
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw authError(); }
}

function audienceMatches(tokenAudience, expectedAudience) {
  return Array.isArray(tokenAudience)
    ? tokenAudience.includes(expectedAudience)
    : tokenAudience === expectedAudience;
}

async function readBoundedText(response, maxBytes) {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw authError();
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, total).toString('utf8');
    } finally {
      reader.releaseLock();
    }
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw authError();
  return raw;
}

/**
 * Provider-neutral OIDC/OAuth2 JWT bearer verifier (RS256 only).
 * Configure with the exact issuer, audience and JWKS endpoint from the identity provider.
 * The returned authenticate(req) function is intended for createRecordHttpServer.
 */
export function createOidcBearerAuthenticator({
  issuer,
  audience,
  jwksUrl,
  fetchImpl = globalThis.fetch,
  cacheTtlMs = 5 * 60_000,
  unknownKidRefreshIntervalMs = DEFAULT_UNKNOWN_KID_REFRESH_MS,
  clockSkewSeconds = 60,
  now = () => Date.now(),
  allowHttpForTests = false,
} = {}) {
  if (typeof issuer !== 'string' || !issuer.trim()) throw new TypeError('issuer is required');
  if (typeof audience !== 'string' || !audience.trim()) throw new TypeError('audience is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isInteger(cacheTtlMs) || cacheTtlMs < 1000) throw new TypeError('cacheTtlMs must be >= 1000');
  if (!Number.isInteger(unknownKidRefreshIntervalMs) || unknownKidRefreshIntervalMs < 1000) throw new TypeError('unknownKidRefreshIntervalMs must be >= 1000');
  if (!Number.isInteger(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 300) throw new TypeError('clockSkewSeconds must be 0..300');
  let jwks;
  try { jwks = new URL(jwksUrl); } catch { throw new TypeError('jwksUrl must be an absolute URL'); }
  if (jwks.protocol !== 'https:' && !(allowHttpForTests && jwks.protocol === 'http:')) {
    throw new TypeError('jwksUrl must use HTTPS');
  }

  let keyCache = new Map();
  let cacheExpiresAt = 0;
  let inflight;
  let lastUnknownKidRefreshAt = Number.NEGATIVE_INFINITY;

  async function loadKeys(force = false) {
    if (!force && keyCache.size && now() < cacheExpiresAt) return keyCache;
    if (force) {
      // Unknown-kid tokens are attacker-controlled input. Throttle forced JWKS refreshes
      // so random kid values cannot turn every rejected request into an outbound fetch.
      if (now() - lastUnknownKidRefreshAt < unknownKidRefreshIntervalMs) return keyCache;
      lastUnknownKidRefreshAt = now();
    }
    if (inflight) return inflight;
    inflight = (async () => {
      let response;
      try { response = await fetchImpl(jwks.href, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000) }); }
      catch { throw authError(); }
      if (!response.ok) throw authError();
      let raw;
      try {
        const declaredLength = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_JWKS_BYTES) throw authError();
        if (typeof response.text === 'function') {
          raw = await readBoundedText(response, MAX_JWKS_BYTES);
        } else {
          const body = await response.json();
          raw = JSON.stringify(body);
          if (Buffer.byteLength(raw, 'utf8') > MAX_JWKS_BYTES) throw authError();
        }
      } catch { throw authError(); }
      let body;
      try { body = JSON.parse(raw); } catch { throw authError(); }
      if (!body || !Array.isArray(body.keys) || body.keys.length > 100) throw authError();
      const next = new Map();
      for (const jwk of body.keys) {
        if (!jwk || typeof jwk.kid !== 'string' || jwk.kty !== 'RSA' || (jwk.use && jwk.use !== 'sig') || (jwk.alg && jwk.alg !== 'RS256')) continue;
        try { next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' })); } catch { /* Ignore malformed provider keys. */ }
      }
      if (!next.size) throw authError();
      keyCache = next;
      cacheExpiresAt = now() + cacheTtlMs;
      return keyCache;
    })();
    try { return await inflight; } finally { inflight = undefined; }
  }

  return async function authenticate(req) {
    const header = req?.headers?.authorization;
    if (typeof header !== 'string' || header.length > MAX_TOKEN_LENGTH + 32) return null;
    const match = header.match(/^Bearer ([A-Za-z0-9._~-]+)$/i);
    if (!match || match[1].length > MAX_TOKEN_LENGTH) return null;
    const token = match[1];
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !part)) return null;

    try {
      const headerPart = decodePart(parts[0]);
      const claims = decodePart(parts[1]);
      if (headerPart.alg !== 'RS256' || typeof headerPart.kid !== 'string' || headerPart.kid.length > 256) return null;
      if (headerPart.crit !== undefined || headerPart.b64 === false) return null;
      let keys = await loadKeys();
      let key = keys.get(headerPart.kid);
      if (!key) {
        keys = await loadKeys(true);
        key = keys.get(headerPart.kid);
      }
      if (!key) return null;
      const signature = Buffer.from(parts[2], 'base64url');
      if (!verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, signature)) return null;

      const nowSeconds = Math.floor(now() / 1000);
      if (claims.iss !== issuer || !audienceMatches(claims.aud, audience)) return null;
      if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds - clockSkewSeconds) return null;
      if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > nowSeconds + clockSkewSeconds)) return null;
      if (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat > nowSeconds + clockSkewSeconds)) return null;
      if (typeof claims.sub !== 'string' || !claims.sub.trim() || claims.sub.length > 512) return null;
      return { userId: `${issuer}#${claims.sub}`, issuer, subject: claims.sub, audience };
    } catch {
      return null;
    }
  };
}
