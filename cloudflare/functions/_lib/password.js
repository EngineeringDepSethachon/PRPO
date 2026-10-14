// PBKDF2-SHA256 password hashing via WebCrypto (Cloudflare Workers / Pages Functions / Node 18+).
// Folders starting with "_" under functions/ are not treated as routes by Pages Functions.

export const PASSWORD_ALGO = 'PBKDF2-SHA256';
// Cloudflare Workers limits PBKDF2 to at most 100000 iterations.
export const PASSWORD_ITERATIONS = 100000;
export const MIN_ITERATIONS = 1000;
export const MAX_ITERATIONS = 100000;
export const MAX_PASSWORD_LENGTH = 256;
export const SALT_BYTES = 16;

export function isValidIterations(n) {
  return Number.isInteger(n) && n >= MIN_ITERATIONS && n <= MAX_ITERATIONS;
}
export const HASH_BYTES = 32;

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(plain, saltBytes, iterations) {
  const subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey(
    'raw',
    new TextEncoder().encode(plain),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    key,
    HASH_BYTES * 8
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashPassword(plain, { iterations = PASSWORD_ITERATIONS } = {}) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('Password must be a non-empty string');
  }
  if (plain.length > MAX_PASSWORD_LENGTH) {
    throw new Error('Password too long');
  }
  if (!isValidIterations(iterations)) {
    throw new Error('Invalid iterations');
  }
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(plain, salt, iterations);
  return { hash: toBase64(hash), salt: toBase64(salt), algo: PASSWORD_ALGO, iterations };
}

export async function verifyPassword(plain, record) {
  try {
    if (typeof plain !== 'string' || plain.length === 0) return false;
    if (!record || typeof record.hash !== 'string' || typeof record.salt !== 'string') return false;
    if (plain.length > MAX_PASSWORD_LENGTH) return false;
    if (record.algo !== undefined && record.algo !== null && record.algo !== '' && record.algo !== PASSWORD_ALGO) return false;
    const iterations = Number(record.iterations);
    if (!isValidIterations(iterations)) return false;
    const salt = fromBase64(record.salt);
    const expected = fromBase64(record.hash);
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await derive(plain, salt, iterations);
    return constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}
