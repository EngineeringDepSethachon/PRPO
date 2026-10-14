// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  PASSWORD_ITERATIONS,
  PASSWORD_ALGO,
} from '../functions/_lib/password.js';

describe('password hashing (PBKDF2-SHA256)', () => {
  it('hashes and verifies correct password', async () => {
    const rec = await hashPassword('s3cret!');
    expect(rec.algo).toBe(PASSWORD_ALGO);
    expect(rec.iterations).toBe(PASSWORD_ITERATIONS);
    expect(PASSWORD_ITERATIONS).toBeLessThanOrEqual(100000);
    expect(Buffer.from(rec.salt, 'base64').length).toBe(16);
    expect(Buffer.from(rec.hash, 'base64').length).toBe(32);
    expect(await verifyPassword('s3cret!', rec)).toBe(true);
  });

  it('returns false for wrong password', async () => {
    const rec = await hashPassword('s3cret!');
    expect(await verifyPassword('wrong', rec)).toBe(false);
    expect(await verifyPassword('', rec)).toBe(false);
  });

  it('uses a different salt and hash each time', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it('throws on empty password', async () => {
    await expect(hashPassword('')).rejects.toThrow();
    await expect(hashPassword(undefined)).rejects.toThrow();
  });

  it('returns false (no throw) for corrupted records', async () => {
    const rec = await hashPassword('pw');
    expect(await verifyPassword('pw', null)).toBe(false);
    expect(await verifyPassword('pw', {})).toBe(false);
    expect(await verifyPassword('pw', { ...rec, hash: '!!!notbase64' })).toBe(false);
    expect(await verifyPassword('pw', { ...rec, salt: '%%%' })).toBe(false);
    expect(await verifyPassword('pw', { ...rec, iterations: 'abc' })).toBe(false);
    expect(await verifyPassword('pw', { ...rec, hash: rec.hash.slice(0, 10) })).toBe(false);
  });

  it('respects custom iterations', async () => {
    const rec = await hashPassword('pw', { iterations: 1000 });
    expect(rec.iterations).toBe(1000);
    expect(await verifyPassword('pw', rec)).toBe(true);
  });
});

describe('password hashing - extra QA cases', () => {
  it('matches PBKDF2-HMAC-SHA256 reference (node:crypto, passwd/salt/c=1000)', async () => {
    const { pbkdf2Sync } = await import('node:crypto');
    const rec = {
      hash: pbkdf2Sync('passwd', 'salt', 1000, 32, 'sha256').toString('base64'),
      salt: Buffer.from('salt').toString('base64'),
      iterations: 1000,
    };
    expect(await verifyPassword('passwd', rec)).toBe(true);
    expect(await verifyPassword('passwd2', rec)).toBe(false);
  });

  it('supports Thai/unicode passwords and is case sensitive', async () => {
    const rec = await hashPassword('รหัสผ่าน๑๒๓😀');
    expect(await verifyPassword('รหัสผ่าน๑๒๓😀', rec)).toBe(true);
    expect(await verifyPassword('รหัสผ่าน๑๒๓', rec)).toBe(false);
    const r2 = await hashPassword('Abc');
    expect(await verifyPassword('abc', r2)).toBe(false);
  });

  it('rejects a tampered hash/salt of the same length', async () => {
    const rec = await hashPassword('pw');
    const h = Buffer.from(rec.hash, 'base64');
    h[0] ^= 1;
    expect(await verifyPassword('pw', { ...rec, hash: h.toString('base64') })).toBe(false);
    const s = Buffer.from(rec.salt, 'base64');
    s[0] ^= 1;
    expect(await verifyPassword('pw', { ...rec, salt: s.toString('base64') })).toBe(false);
  });

  it('rejects wrong iterations count and invalid iterations in record', async () => {
    const rec = await hashPassword('pw', { iterations: 1000 });
    expect(await verifyPassword('pw', { ...rec, iterations: 999 })).toBe(false);
    expect(await verifyPassword('pw', { ...rec, iterations: 0 })).toBe(false);
    expect(await verifyPassword('pw', { ...rec, iterations: -5 })).toBe(false);
    expect(await verifyPassword('pw', { ...rec, iterations: 1.5 })).toBe(false);
    expect(await verifyPassword('pw', { ...rec, iterations: undefined })).toBe(false);
  });

  it('returns false for empty / non-string / missing fields without throwing', async () => {
    const rec = await hashPassword('pw');
    expect(await verifyPassword('pw', { ...rec, hash: '' })).toBe(false);
    expect(await verifyPassword('pw', { ...rec, salt: '' })).toBe(false);
    expect(await verifyPassword('pw', { ...rec, hash: 123 })).toBe(false);
    expect(await verifyPassword('pw', { ...rec, hash: null })).toBe(false);
    expect(await verifyPassword(null, rec)).toBe(false);
    expect(await verifyPassword(undefined, rec)).toBe(false);
    expect(await verifyPassword(12345, rec)).toBe(false);
    expect(await verifyPassword('pw')).toBe(false);
  });

  it('hashPassword rejects non-string and invalid iterations', async () => {
    await expect(hashPassword(null)).rejects.toThrow();
    await expect(hashPassword(12345)).rejects.toThrow();
    await expect(hashPassword('pw', { iterations: 0 })).rejects.toThrow();
    await expect(hashPassword('pw', { iterations: -1 })).rejects.toThrow();
    await expect(hashPassword('pw', { iterations: 1.5 })).rejects.toThrow();
  });

  it('enforces iterations range 1000..100000', async () => {
    await expect(hashPassword('pw', { iterations: 999 })).rejects.toThrow();
    await expect(hashPassword('pw', { iterations: 100001 })).rejects.toThrow();
    const rec = await hashPassword('pw', { iterations: 1000 });
    expect(await verifyPassword('pw', { ...rec, iterations: 100001 })).toBe(false);
    expect(await verifyPassword('pw', { ...rec, iterations: 10000000 })).toBe(false);
    expect(await verifyPassword('pw', { ...rec, iterations: 999 })).toBe(false);
  });

  it('rejects unknown algo in record but accepts matching/absent algo', async () => {
    const rec = await hashPassword('pw');
    expect(await verifyPassword('pw', { ...rec, algo: 'PBKDF2-SHA1' })).toBe(false);
    expect(await verifyPassword('pw', { ...rec, algo: PASSWORD_ALGO })).toBe(true);
    const { algo, ...noAlgo } = rec;
    expect(await verifyPassword('pw', noAlgo)).toBe(true);
  });

  it('limits password length to 256 characters', async () => {
    await expect(hashPassword('a'.repeat(257), { iterations: 1000 })).rejects.toThrow();
    const rec = await hashPassword('a'.repeat(256), { iterations: 1000 });
    expect(await verifyPassword('a'.repeat(256), rec)).toBe(true);
    expect(await verifyPassword('a'.repeat(257), rec)).toBe(false);
  });

  it('is not a Pages route and does not depend on Node Buffer', async () => {
    const mod = await import('../functions/_lib/password.js');
    expect(Object.keys(mod).filter((k) => k.startsWith('onRequest'))).toEqual([]);
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../functions/_lib/password.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bBuffer\b/);
    expect(src).not.toMatch(/from\s+['"]node:/);
  });
});
