// Token HMAC-SHA256 (WebCrypto) + sanitizeUser. Not a route (folder starts with "_").
// Token format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, base64url(payload)))
// payload: { sub: userId, userId, role, level, tv, iat, exp }  (iat/exp = epoch seconds ; tv = users.tokenVersion, a mismatch with the DB = 401)

export const TOKEN_TTL_SECONDS = 8 * 60 * 60;

const SENSITIVE_FIELDS = [
  'password', 'pin', 'passwordHash', 'passwordSalt', 'passwordAlgo',
  'passwordIterations', 'passwordUpdatedAt', 'mustChangePassword', 'tokenVersion'
];

export function sanitizeUser(u) {
  if (!u || typeof u !== 'object') return u;
  const safe = { ...u };
  for (const k of SENSITIVE_FIELDS) delete safe[k];
  return safe;
}

function b64urlFromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromB64url(str) {
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret, usages) {
  return globalThis.crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages
  );
}

// Placeholder values (e.g. copied from .dev.vars.example) are rejected like a missing secret.
const PLACEHOLDER_SECRET = /^(change[-_ ]?me|replace[-_ ]?me|your[-_ ]|example|secret$|todo|xxx)/i;

// The throw-away secret hard-coded in playwright.cf.config.js (public in the repo) : accepted ONLY in dev/local mode (ENVIRONMENT=dev), never in production.
const E2E_SECRET_PREFIX = 'e2e-local-secret-';

export function hasSecret(env) {
  const s = env && env.AUTH_TOKEN_SECRET;
  if (typeof s !== 'string' || s.length < 32 || PLACEHOLDER_SECRET.test(s)) return false;
  if (s.startsWith(E2E_SECRET_PREFIX) && String(env.ENVIRONMENT || '').toLowerCase() !== 'dev') return false;
  return true;
}

export async function signToken(payload, secret, { now = Date.now(), ttlSeconds = TOKEN_TTL_SECONDS } = {}) {
  if (typeof secret !== 'string' || !secret) throw new Error('AUTH_TOKEN_SECRET missing');
  const iat = Math.floor(now / 1000);
  const body = { ...payload, iat, exp: iat + ttlSeconds };
  const p = b64urlFromBytes(new TextEncoder().encode(JSON.stringify(body)));
  const key = await hmacKey(secret, ['sign']);
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(p)));
  return `${p}.${b64urlFromBytes(sig)}`;
}

// returns payload or null (never throws)
export async function verifyToken(token, secret, { now = Date.now() } = {}) {
  try {
    if (typeof token !== 'string' || typeof secret !== 'string' || !secret) return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const key = await hmacKey(secret, ['verify']);
    const ok = await globalThis.crypto.subtle.verify(
      'HMAC', key, bytesFromB64url(parts[1]), new TextEncoder().encode(parts[0])
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(bytesFromB64url(parts[0])));
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.userId || !Number.isFinite(payload.exp) || Math.floor(now / 1000) >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// Same checks as verifyToken but says WHY it failed : { payload } | { error: 'TOKEN_INVALID' | 'TOKEN_EXPIRED' }
// (expired is only reported for a token whose signature is valid)
export async function verifyTokenDetailed(token, secret, { now = Date.now() } = {}) {
  const payload = await verifyToken(token, secret, { now });
  if (payload) return { payload };
  try {
    if (typeof token === 'string' && typeof secret === 'string' && secret) {
      const parts = token.split('.');
      if (parts.length === 2 && parts[0] && parts[1]) {
        const key = await hmacKey(secret, ['verify']);
        const ok = await globalThis.crypto.subtle.verify('HMAC', key, bytesFromB64url(parts[1]), new TextEncoder().encode(parts[0]));
        if (ok) {
          const p = JSON.parse(new TextDecoder().decode(bytesFromB64url(parts[0])));
          if (p && p.userId && Number.isFinite(p.exp) && Math.floor(now / 1000) >= p.exp) return { error: 'TOKEN_EXPIRED' };
        }
      }
    }
  } catch { /* fall through */ }
  return { error: 'TOKEN_INVALID' };
}

export function getBearerToken(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}
