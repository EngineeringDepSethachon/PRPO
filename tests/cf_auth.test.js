// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { onRequest } from '../functions/api/[[route]].js';
import { hashPassword } from '../functions/_lib/password.js';
import { signToken, verifyToken, sanitizeUser } from '../functions/_lib/auth.js';

const SECRET = 'unit-test-secret-0123456789abcdef';
const ORIGIN = 'https://prpo.pages.dev';

function makeDb(initialUsers) {
  const state = { users: initialUsers.map((u) => ({ ...u })), attempts: [], idSeq: 1 };
  const exec = (query, p, mode) => {
    const q = query.replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT COUNT(*) AS c FROM login_attempts')) {
      const [kind, identifier, since] = p;
      const c = state.attempts.filter((a) => a.kind === kind && a.identifier === identifier && a.success === 0 && a.attemptedAt > since).length;
      return { results: [{ c }] };
    }
    if (q.startsWith('INSERT INTO login_attempts')) {
      state.attempts.push({ kind: p[0], identifier: p[1], success: 0, attemptedAt: p[2], ip: p[3], userAgent: p[4] });
      return { success: true };
    }
    if (q.startsWith('DELETE FROM login_attempts')) {
      if (q.includes("kind = 'USER'")) state.attempts = state.attempts.filter((a) => !(a.kind === 'USER' && a.identifier === p[0]));
      else if (q.includes("kind = 'IP'")) state.attempts = state.attempts.filter((a) => !(a.kind === 'IP' && a.userAgent === p[0]));
      else state.attempts = state.attempts.filter((a) => a.userAgent !== p[0]);
      return { success: true };
    }
    if (q.startsWith('INSERT INTO audit_logs')) {
      (state.audits = state.audits || []).push(p);
      return { success: true };
    }
    if (q.startsWith('INSERT INTO prs')) {
      state.prInsert = p;
      return { success: true };
    }
    if (q.includes('FROM users WHERE LOWER(username) = ?')) {
      return state.users.find((u) => [u.username, u.employeeId, u.email].some((v) => v && v.toLowerCase() === p[0])) || null;
    }
    if (q.includes('FROM users WHERE id = ?')) {
      const u = state.users.find((x) => x.id === p[0]);
      return u ? { id: u.id, username: u.username, name: u.name, status: u.status, level: u.level, roleId: u.roleId, canonicalRole: u.canonicalRole } : null;
    }
    if (q.startsWith('UPDATE users SET passwordHash')) {
      const u = state.users.find((x) => x.id === p[7]);
      if (p[0]) { u.passwordHash = p[0]; u.passwordSalt = p[1]; u.passwordAlgo = p[2]; u.passwordIterations = p[3]; }
      u.password = '';
      if (u.pin === p[6]) u.pin = '';
      return { success: true };
    }
    if (q.startsWith('SELECT * FROM users ORDER BY')) {
      return { results: state.users.map((u) => ({ ...u })) };
    }
    if (q.startsWith('UPDATE doc_counters SET lastNumber = lastNumber + 1')) return { lastNumber: (state.docSeq = (state.docSeq || 0) + 1) }; // T3.3 server-issued PR number
    if (q.includes('COUNT(*)')) return { count: state.users.length };
    return mode === 'all' ? { results: [] } : null;
  };
  const db = {
    state,
    // D1 batch: statements run sequentially, atomically (no interleaving with other requests)
    batch: async (stmts) => stmts.map((s) => exec(s.query, s.params, 'all')),
    prepare: (query) => ({
      bind: (...p) => ({
        query,
        params: p,
        first: async () => exec(query, p, 'first'),
        all: async () => exec(query, p, 'all'),
        run: async () => exec(query, p, 'run') || { success: true }
      }),
      first: async () => exec(query, [], 'first'),
      all: async () => exec(query, [], 'all'),
      run: async () => ({ success: true })
    })
  };
  return db;
}

const login = (db, username, password, { ip = '1.1.1.1', env } = {}) =>
  onRequest({
    request: new Request(`${ORIGIN}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ username, password })
    }),
    env: env || { DB: db, AUTH_TOKEN_SECRET: SECRET }
  });

const call = (db, path, token, method = 'GET') =>
  onRequest({
    request: new Request(`${ORIGIN}${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} }),
    env: { DB: db, AUTH_TOKEN_SECRET: SECRET }
  });

let hashed;
beforeEach(async () => {
  hashed = await hashPassword('Correct-Pass1');
});
afterEach(() => vi.useRealTimers());

const baseUser = (over = {}) => ({
  id: 'USR-1', username: 'wichai.pd', employeeId: 'EMP-1', email: 'w@x.com', name: 'Wichai', level: 1,
  status: 'ACTIVE', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', password: '', pin: '', ...over
});
const hashedUser = (over = {}) => baseUser({
  passwordHash: hashed.hash, passwordSalt: hashed.salt, passwordAlgo: hashed.algo, passwordIterations: hashed.iterations, ...over
});

describe('T4.3 login', () => {
  it('correct password -> 200, token, sanitized user', async () => {
    const db = makeDb([hashedUser({ pin: '1234' })]);
    const res = await login(db, 'WICHAI.pd', 'Correct-Pass1');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    const payload = await verifyToken(json.token, SECRET);
    expect(payload.userId).toBe('USR-1');
    expect(payload.exp - payload.iat).toBe(8 * 3600);
    expect(payload.role).toBe('REQUESTER');
    const text = JSON.stringify(json);
    for (const k of ['password', 'pin', 'passwordHash', 'passwordSalt']) expect(text).not.toContain(`"${k}"`);
  });

  it('wrong password, unknown user -> same 401 message', async () => {
    const db = makeDb([hashedUser()]);
    const a = await login(db, 'wichai.pd', 'nope');
    const b = await login(db, 'ghost', 'nope', { ip: '2.2.2.2' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect((await a.json()).error).toBe((await b.json()).error);
  });

  it('empty password rejected (even for user without password)', async () => {
    const db = makeDb([baseUser()]);
    expect((await login(db, 'wichai.pd', '')).status).toBe(400);
    expect((await login(db, 'wichai.pd', '   ')).status).toBe(400);
  });

  it('hardcoded backdoor passwords do not work', async () => {
    const db = makeDb([hashedUser({ username: 'admin', id: 'USR-A', level: 99, email: 'a@x.com', employeeId: 'E-A' })]);
    expect((await login(db, 'admin', 'admin123')).status).toBe(401);
    expect((await login(db, 'admin', 'password123', { ip: '3.3.3.3' })).status).toBe(401);
  });

  it('password longer than 256 chars -> 401', async () => {
    const db = makeDb([hashedUser()]);
    expect((await login(db, 'wichai.pd', 'a'.repeat(257))).status).toBe(401);
  });

  it('lazy upgrade: plaintext compared, hashed, plaintext + pin cleared; second login uses hash', async () => {
    const db = makeDb([baseUser({ password: 'Legacy-Pass9', pin: 'Legacy-Pass9' })]);
    expect((await login(db, 'wichai.pd', 'wrong')).status).toBe(401);
    const res = await login(db, 'wichai.pd', 'Legacy-Pass9');
    expect(res.status).toBe(200);
    const u = db.state.users[0];
    expect(u.password).toBe('');
    expect(u.pin).toBe('');
    expect(u.passwordHash).toBeTruthy();
    expect(u.passwordIterations).toBe(100000);
    expect((await login(db, 'wichai.pd', 'Legacy-Pass9')).status).toBe(200);
  });

  it('rehashes when stored iterations are below current', async () => {
    const weak = await hashPassword('Correct-Pass1', { iterations: 1000 });
    const db = makeDb([baseUser({ passwordHash: weak.hash, passwordSalt: weak.salt, passwordAlgo: weak.algo, passwordIterations: 1000 })]);
    expect((await login(db, 'wichai.pd', 'Correct-Pass1')).status).toBe(200);
    expect(db.state.users[0].passwordIterations).toBe(100000);
    expect((await login(db, 'wichai.pd', 'Correct-Pass1')).status).toBe(200);
  });

  it('only ACTIVE users can log in (INACTIVE / missing status / unknown status -> 403), isActive=1 allowed', async () => {
    for (const status of ['INACTIVE', undefined, 'PENDING', '']) {
      const db = makeDb([hashedUser({ status })]);
      expect((await login(db, 'wichai.pd', 'Correct-Pass1')).status).toBe(403);
    }
    const ok = makeDb([hashedUser({ status: undefined, isActive: 1 })]);
    expect((await login(ok, 'wichai.pd', 'Correct-Pass1')).status).toBe(200);
    // wrong password on a disabled account still looks like any other failure
    const dis = makeDb([hashedUser({ status: 'INACTIVE' })]);
    expect((await login(dis, 'wichai.pd', 'nope')).status).toBe(401);
  });

  it('rejects placeholder secret from .dev.vars.example and short secrets', async () => {
    const db = makeDb([hashedUser()]);
    for (const s of ['REPLACE_ME', 'change-me-generate-a-long-random-value', 'short', '']) {
      const res = await login(db, 'wichai.pd', 'Correct-Pass1', { env: { DB: db, AUTH_TOKEN_SECRET: s } });
      expect(res.status).toBe(500);
    }
  });

  it('example file value is itself rejected', async () => {
    const fs = await import('node:fs');
    const txt = fs.readFileSync(new URL('../.dev.vars.example', import.meta.url), 'utf8');
    const m = txt.match(/^AUTH_TOKEN_SECRET=(.*)$/m);
    const { hasSecret } = await import('../functions/_lib/auth.js');
    expect(hasSecret({ AUTH_TOKEN_SECRET: m[1].trim() })).toBe(false);
  });

  it('unknown user still performs a PBKDF2 derivation (timing equalization)', async () => {
    const db = makeDb([hashedUser()]);
    const spy = vi.spyOn(globalThis.crypto.subtle, 'deriveBits');
    await login(db, 'ghost', 'whatever', { ip: '2.2.2.2' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  const postPr = async (db, userId) => {
    const token = await signToken({ userId }, SECRET);
    return onRequest({
      request: new Request(`${ORIGIN}/api/prs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'PR-1', requesterId: 'USR-EVIL', requesterName: 'Evil', items: [] })
      }),
      env: { DB: db, AUTH_TOKEN_SECRET: SECRET }
    });
  };

  it('POST /api/prs: requesterId = role id (frontend parity), name from token, real user id in audit_logs', async () => {
    const db = makeDb([hashedUser()]);
    expect((await postPr(db, 'USR-1')).status).toBe(200);
    expect(db.state.prInsert[3]).toBe('REQUESTER_PD');
    expect(db.state.prInsert[4]).toBe('Wichai');
    const aud = db.state.audits.find((a) => a[1] === 'PR_UPSERT');
    expect(aud[3]).toBe('PR-1');
    expect(aud[4]).toBe('USR-1');
  });

  it('role key falls back by level when roleId empty (same as resolveUserPermissions)', async () => {
    for (const [level, expected] of [[1, 'REQUESTER'], [2, 'REVIEWER'], [3, 'APPROVER'], [99, 'ADMIN']]) {
      const db = makeDb([hashedUser({ roleId: '', level })]);
      await postPr(db, 'USR-1');
      expect(db.state.prInsert[3]).toBe(expected);
    }
  });

  it('no AUTH_TOKEN_SECRET -> 500 fail closed (login and other endpoints)', async () => {
    const db = makeDb([hashedUser()]);
    expect((await login(db, 'wichai.pd', 'Correct-Pass1', { env: { DB: db } })).status).toBe(500);
    const res = await onRequest({ request: new Request(`${ORIGIN}/api/products`), env: { DB: db } });
    expect(res.status).toBe(500);
  });
});

describe('T4.3 token middleware', () => {
  it('missing / forged / expired / garbage token -> 401', async () => {
    const db = makeDb([hashedUser()]);
    expect((await call(db, '/api/users')).status).toBe(401);
    expect((await call(db, '/api/users', 'garbage')).status).toBe(401);
    const forged = await signToken({ userId: 'USR-1' }, 'another-secret-0123456789abcdef');
    expect((await call(db, '/api/users', forged)).status).toBe(401);
    const good = await signToken({ userId: 'USR-1' }, SECRET);
    const [p, s] = good.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ userId: 'USR-1', level: 99, exp: 9999999999 })).toString('base64url');
    expect((await call(db, '/api/users', `${tamperedPayload}.${s}`)).status).toBe(401);
    expect(p).toBeTruthy();
    const expired = await signToken({ userId: 'USR-1' }, SECRET, { now: Date.now() - 9 * 3600 * 1000 });
    expect((await call(db, '/api/users', expired)).status).toBe(401);
  });

  it('valid token passes; deleted/inactive user token -> 401; OPTIONS needs no token', async () => {
    const db = makeDb([hashedUser()]);
    const token = await signToken({ userId: 'USR-1' }, SECRET);
    expect((await call(db, '/api/health', token)).status).toBe(200);
    db.state.users[0].status = 'INACTIVE';
    expect((await call(db, '/api/health', token)).status).toBe(401);
    const opt = await onRequest({ request: new Request(`${ORIGIN}/api/users`, { method: 'OPTIONS' }), env: { DB: db, AUTH_TOKEN_SECRET: SECRET } });
    expect(opt.status).toBe(200);
  });

  it('GET /api/users never leaks password/pin/hash', async () => {
    const db = makeDb([hashedUser({ pin: '9999', password: 'leftover' })]);
    const token = await signToken({ userId: 'USR-1' }, SECRET);
    const res = await call(db, '/api/users', token);
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const k of ['"password"', '"pin"', '"passwordHash"', '"passwordSalt"']) expect(text).not.toContain(k);
    expect(text).not.toContain('leftover');
    expect(text).not.toContain('9999');
  });

  it('sanitizeUser strips sensitive fields', () => {
    const s = sanitizeUser({ id: 1, password: 'a', pin: 'b', passwordHash: 'c', passwordSalt: 'd', name: 'x' });
    expect(s).toEqual({ id: 1, name: 'x' });
  });
});

describe('T4.4 rate limit', () => {
  it('5 wrong attempts -> 6th is 429 (even with the right password), username unknown behaves the same', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    const db = makeDb([hashedUser()]);
    for (let i = 0; i < 5; i++) {
      expect((await login(db, 'wichai.pd', 'bad', { ip: `9.9.9.${i}` })).status).toBe(401);
    }
    const locked = await login(db, 'wichai.pd', 'Correct-Pass1', { ip: '8.8.8.8' });
    expect(locked.status).toBe(429);
    expect((await locked.json()).error).toMatch(/15/);

    for (let i = 0; i < 5; i++) await login(db, 'ghost', 'bad', { ip: `7.7.7.${i}` });
    expect((await login(db, 'ghost', 'bad', { ip: '6.6.6.6' })).status).toBe(429);

    // still locked at 14 min, free after 15 min
    vi.setSystemTime(new Date('2026-10-12T10:14:00Z'));
    expect((await login(db, 'wichai.pd', 'Correct-Pass1', { ip: '8.8.8.8' })).status).toBe(429);
    vi.setSystemTime(new Date('2026-10-12T10:15:01Z'));
    expect((await login(db, 'wichai.pd', 'Correct-Pass1', { ip: '8.8.8.8' })).status).toBe(200);
  });

  it('IP ceiling is 30 per 15 min across different usernames; other IPs unaffected', async () => {
    const db = makeDb([hashedUser()]);
    for (let i = 0; i < 30; i++) {
      expect((await login(db, `user${i}`, 'bad', { ip: '5.5.5.5' })).status).toBe(401);
    }
    expect((await login(db, 'wichai.pd', 'Correct-Pass1', { ip: '5.5.5.5' })).status).toBe(429);
    expect((await login(db, 'wichai.pd', 'Correct-Pass1', { ip: '4.4.4.4' })).status).toBe(200);
  });

  it('lazy upgrade rejects known default plaintext passwords, even when typed correctly', async () => {
    for (const pw of ['123456', 'password123', 'admin123']) {
      const db = makeDb([baseUser({ password: pw })]);
      expect((await login(db, 'wichai.pd', pw, { ip: '12.0.0.1' })).status).toBe(401);
      expect(db.state.users[0].passwordHash).toBeUndefined();
    }
  });

  it('unhandled errors return a generic message (no internal details)', async () => {
    const db = makeDb([hashedUser()]);
    const token = await signToken({ userId: 'USR-1' }, SECRET);
    const base = db.prepare;
    db.prepare = (q) => {
      if (q.startsWith('SELECT * FROM prs')) throw new Error('SECRET-DETAIL table prs exploded');
      return base(q);
    };
    const res = await onRequest({
      request: new Request(`${ORIGIN}/api/prs`, { headers: { Authorization: `Bearer ${token}` } }),
      env: { DB: db, AUTH_TOKEN_SECRET: SECRET }
    });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain('Internal error');
    expect(text).not.toContain('SECRET-DETAIL');
  });

  it('20 parallel wrong-password attempts: at most 5 get 401, the rest 429', async () => {
    const db = makeDb([hashedUser()]);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => login(db, 'wichai.pd', 'bad', { ip: `10.0.0.${i}` }))
    );
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 401).length).toBe(5);
    expect(codes.filter((c) => c === 429).length).toBe(15);
    // rejected attempts leave no rows behind
    expect(db.state.attempts.filter((a) => a.kind === 'USER')).toHaveLength(5);
  });

  it('counter is per resolved user: username, email and employeeId share it', async () => {
    const db = makeDb([hashedUser()]);
    const ids = ['wichai.pd', 'w@x.com', 'EMP-1', 'wichai.pd', 'w@x.com'];
    for (let i = 0; i < ids.length; i++) await login(db, ids[i], 'bad', { ip: `11.0.0.${i}` });
    expect((await login(db, 'EMP-1', 'Correct-Pass1', { ip: '11.0.0.99' })).status).toBe(429);
  });

  it('success resets the user counter', async () => {
    const db = makeDb([hashedUser()]);
    for (let i = 0; i < 4; i++) await login(db, 'wichai.pd', 'bad', { ip: `1.2.3.${i}` });
    expect((await login(db, 'wichai.pd', 'Correct-Pass1', { ip: '1.2.3.9' })).status).toBe(200);
    expect(db.state.attempts.filter((a) => a.kind === 'USER' && a.identifier === 'id:USR-1')).toHaveLength(0);
    for (let i = 0; i < 4; i++) {
      expect((await login(db, 'wichai.pd', 'bad', { ip: `1.2.4.${i}` })).status).toBe(401);
    }
    expect((await login(db, 'wichai.pd', 'Correct-Pass1', { ip: '1.2.4.9' })).status).toBe(200);
  });
});
