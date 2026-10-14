// @vitest-environment node
// P3 : token versioning (tv), mustChangePassword (admin created / reset only), POST /api/me/password, migration 0010
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { hashPassword } from '../functions/_lib/password.js';

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0008_ws3_hardening.sql'];
const SECRET = 'unit-test-secret-0123456789abcdef';

function makeD1(sdb) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { sdb.prepare(q).run(...norm(p)); return { success: true }; },
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) })
  });
  return {
    prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }),
    batch: async (stmts) => {
      sdb.exec('BEGIN');
      try { const out = await Promise.all(stmts.map((s) => s.all())); sdb.exec('COMMIT'); return out; } catch (e) { try { sdb.exec('ROLLBACK'); } catch { /* done */ } throw e; }
    }
  };
}

// node:sqlite is required : if it is missing these tests FAIL (never skip silently)
it('node:sqlite is available', () => { expect(DatabaseSync, 'node:sqlite not available in this Node version').toBeTruthy(); });

describe('password session (tokenVersion / mustChangePassword)', () => {
  let sdb; let env;
  const row = (id) => ({ ...sdb.prepare('SELECT * FROM users WHERE id = ?').get(id) });
  const call = async (token, method, p, body) => {
    const res = await onRequest({
      request: new Request(`https://prpo.pages.dev${p}`, {
        method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
      }),
      env
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const login = (username, password) => call(null, 'POST', '/api/auth/login', { username, password });
  const addUser = async (id, username, password, extra = {}) => {
    const rec = password ? await hashPassword(password) : null;
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, passwordHash, passwordSalt, passwordAlgo, passwordIterations) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?,?)")
      .run(id, username, extra.plain || '', username, extra.department || 'PD', JSON.stringify([extra.department || 'PD']), extra.roleId || 'REQUESTER_PD', extra.canonicalRole || 'REQUESTER', extra.level || 1,
        rec ? rec.hash : null, rec ? rec.salt : null, rec ? rec.algo : null, rec ? rec.iterations : null);
  };

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    sdb.exec("INSERT INTO users (id, username, password, name, department, roleId, canonicalRole, pin, status, level) VALUES ('U-PIN', 'pinuser', '', 'p', 'PD', 'REQUESTER_PD', 'REQUESTER', '9999', 'ACTIVE', 1)");
    sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', '0010_token_version.sql'), 'utf8'));
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    await addUser('U-AD', 'admin', 'AdminPass1', { roleId: 'ADMIN', canonicalRole: 'ADMIN', level: 99, department: 'ALL' });
    await addUser('U-L1', 'req.pd', 'OldPass1');
  });

  it('migration 0010 : tokenVersion column (default 0), pin cleared, no DROP', () => {
    expect(row('U-PIN').pin).toBe('');
    expect(row('U-L1').tokenVersion).toBe(0);
    const sql = fs.readFileSync(path.join(rootDir, 'migrations', '0010_token_version.sql'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(sql).not.toMatch(/\bDROP\b/i);
  });

  it('login token carries tv ; mustChangePassword false for a normal / imported account ; login response never leaks tokenVersion', async () => {
    const r = await login('req.pd', 'OldPass1');
    expect(r.status).toBe(200);
    expect(r.json.mustChangePassword).toBe(false);
    expect(r.json.user.tokenVersion).toBeUndefined();
    expect(JSON.parse(Buffer.from(r.json.token.split('.')[0], 'base64url').toString()).tv).toBe(0);
    expect((await call(r.json.token, 'GET', '/api/bootstrap')).status).toBe(200);
  });

  it('an imported user with the old plaintext password logs in and is NOT forced to change it', async () => {
    await addUser('U-IMP', 'imported', null, { plain: 'legacy-secret' });
    const r = await login('imported', 'legacy-secret');
    expect(r.status).toBe(200);
    expect(r.json.mustChangePassword).toBe(false);
    expect(row('U-IMP').tokenVersion).toBe(0); // the lazy hash upgrade is not a password change
    expect((await call(r.json.token, 'GET', '/api/bootstrap')).status).toBe(200);
  });

  it('admin resets a password : old token dies, mustChangePassword=1, restricted token, user changes it -> normal again', async () => {
    const before = (await login('req.pd', 'OldPass1')).json.token;
    const admin = (await login('admin', 'AdminPass1')).json.token;
    expect((await call(admin, 'PUT', '/api/users/U-L1', { id: 'U-L1', username: 'req.pd', name: 'req.pd', password: 'ResetPass9' })).status).toBe(200);
    expect(row('U-L1')).toMatchObject({ tokenVersion: 1, mustChangePassword: 1 });
    expect(row('U-L1').passwordUpdatedAt).toBeTruthy();
    expect((await call(before, 'GET', '/api/bootstrap')).status).toBe(401); // old token
    expect((await call(admin, 'GET', '/api/bootstrap')).status).toBe(200); // the admin's own token is untouched

    const l = await login('req.pd', 'ResetPass9');
    expect(l.status).toBe(200);
    expect(l.json.mustChangePassword).toBe(true);
    const tok = l.json.token;
    // restricted : everything except /api/me, /api/me/password, /api/logout is refused
    for (const [m, p] of [['GET', '/api/bootstrap'], ['GET', '/api/prs'], ['POST', '/api/prs'], ['GET', '/api/users']]) {
      const r = await call(tok, m, p, m === 'POST' ? {} : undefined);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.json.mustChangePassword).toBe(true);
    }
    expect((await call(tok, 'GET', '/api/me')).json).toMatchObject({ success: true, mustChangePassword: true });
    expect((await call(tok, 'POST', '/api/logout')).status).toBe(200);

    // validations of the change
    const bad = async (b) => (await call(tok, 'POST', '/api/me/password', b)).status;
    expect(await bad({ currentPassword: 'wrong-one', newPassword: 'BrandNew77' })).toBe(400);
    expect(await bad({ currentPassword: 'ResetPass9', newPassword: 'ResetPass9' })).toBe(400); // same as the old one
    expect(await bad({ currentPassword: 'ResetPass9', newPassword: '12345' })).toBe(400); // < 6
    expect(await bad({ currentPassword: 'ResetPass9', newPassword: 'Password123' })).toBe(400); // default password
    expect(await bad({ currentPassword: '', newPassword: 'BrandNew77' })).toBe(400);
    expect(row('U-L1').mustChangePassword).toBe(1);

    const ok = await call(tok, 'POST', '/api/me/password', { currentPassword: 'ResetPass9', newPassword: 'BrandNew77' });
    expect(ok.status).toBe(200);
    expect(row('U-L1')).toMatchObject({ tokenVersion: 2, mustChangePassword: 0, password: '', pin: '' });
    expect((await call(tok, 'GET', '/api/bootstrap')).status).toBe(401); // restricted token is dead
    expect((await call(ok.json.token, 'GET', '/api/bootstrap')).status).toBe(200); // the fresh token works
    expect((await login('req.pd', 'ResetPass9')).status).toBe(401);
    const again = await login('req.pd', 'BrandNew77');
    expect(again.json.mustChangePassword).toBe(false);
  });

  it('a user who changes the password himself : older tokens die, no forced change', async () => {
    const a = (await login('req.pd', 'OldPass1')).json.token;
    const b = (await login('req.pd', 'OldPass1')).json.token;
    const r = await call(a, 'POST', '/api/me/password', { currentPassword: 'OldPass1', newPassword: 'SelfChosen5' });
    expect(r.status).toBe(200);
    expect((await call(a, 'GET', '/api/bootstrap')).status).toBe(401);
    expect((await call(b, 'GET', '/api/bootstrap')).status).toBe(401);
    expect((await call(r.json.token, 'GET', '/api/bootstrap')).status).toBe(200);
    expect(row('U-L1').mustChangePassword).toBe(0);
  });

  it('admin creates a user with a password -> mustChangePassword=1 ; without a password nothing is forced', async () => {
    const admin = (await login('admin', 'AdminPass1')).json.token;
    const c = await call(admin, 'POST', '/api/users', { id: 'U-NEW', username: 'new.user', name: 'New', password: 'Initial123', department: 'PD', roleId: 'REQUESTER_PD' });
    expect(c.status).toBe(200);
    expect(row('U-NEW')).toMatchObject({ mustChangePassword: 1, tokenVersion: 1 });
    const l = await login('new.user', 'Initial123');
    expect(l.json.mustChangePassword).toBe(true);
    // editing the profile without a password does not force / reset anything
    await call(admin, 'PUT', '/api/users/U-L1', { id: 'U-L1', username: 'req.pd', name: 'Renamed' });
    expect(row('U-L1')).toMatchObject({ mustChangePassword: 0, tokenVersion: 0 });
  });

  it('the admin setting his OWN password is a self change : tokens die, no forced change', async () => {
    const admin = (await login('admin', 'AdminPass1')).json.token;
    expect((await call(admin, 'PUT', '/api/users/U-AD', { id: 'U-AD', username: 'admin', name: 'admin', roleId: 'ADMIN', level: 99, password: 'AdminNew77' })).status).toBe(200);
    expect(row('U-AD')).toMatchObject({ mustChangePassword: 0, tokenVersion: 1 });
    expect((await call(admin, 'GET', '/api/bootstrap')).status).toBe(401);
  });

  it('wrong current password is rate limited', async () => {
    const t = (await login('req.pd', 'OldPass1')).json.token;
    for (let i = 0; i < 5; i += 1) expect((await call(t, 'POST', '/api/me/password', { currentPassword: 'nope', newPassword: 'BrandNew77' })).status).toBe(400);
    expect((await call(t, 'POST', '/api/me/password', { currentPassword: 'OldPass1', newPassword: 'BrandNew77' })).status).toBe(429);
  });

  it('PUT /api/users keeps the stored e-mail when the client sends none ; changes it only when one is sent', async () => {
    sdb.prepare("UPDATE users SET email='real.person@corp.test' WHERE id='U-L1'").run();
    const admin = (await login('admin', 'AdminPass1')).json.token;
    expect((await call(admin, 'PUT', '/api/users/U-L1', { id: 'U-L1', username: 'req.pd', name: 'Renamed' })).status).toBe(200);
    expect(row('U-L1').email).toBe('real.person@corp.test'); // not overwritten by req.pd@company.com
    expect((await call(admin, 'PUT', '/api/users/U-L1', { id: 'U-L1', username: 'req.pd', name: 'Renamed', email: 'new.address@corp.test' })).status).toBe(200);
    expect(row('U-L1').email).toBe('new.address@corp.test');
    // a new account still gets the derived default
    await call(admin, 'POST', '/api/users', { id: 'U-EM', username: 'Em.User', name: 'Em', department: 'PD', roleId: 'REQUESTER_PD' });
    expect(row('U-EM').email).toBe('em.user@company.com');
  });

  it('/api/me returns the user without internal fields', async () => {
    const t = (await login('req.pd', 'OldPass1')).json.token;
    const me = await call(t, 'GET', '/api/me');
    expect(me.status).toBe(200);
    const keys = Object.keys(me.json.user);
    for (const k of ['tokenVersion', 'dbTokenVersion', 'dbMustChange', 'roleKey', 'passwordHash', 'passwordSalt', 'password', 'pin', 'mustChangePassword']) expect(keys, k).not.toContain(k);
    expect(me.json).toMatchObject({ success: true, mustChangePassword: false });
    expect(me.json.user.username).toBe('req.pd');
  });

  it('closing an account (DELETE or status INACTIVE) bumps tokenVersion : an old token does not revive on re-activation', async () => {
    const admin = (await login('admin', 'AdminPass1')).json.token;
    await addUser('U-X1', 'x.one', 'XxPass123');
    await addUser('U-X2', 'x.two', 'XxPass123');
    const t1 = (await login('x.one', 'XxPass123')).json.token;
    const t2 = (await login('x.two', 'XxPass123')).json.token;
    expect((await call(admin, 'DELETE', '/api/users/U-X1')).status).toBe(200);
    expect(row('U-X1')).toMatchObject({ status: 'INACTIVE', tokenVersion: 1 });
    expect((await call(admin, 'PUT', '/api/users/U-X2', { id: 'U-X2', username: 'x.two', name: 'x.two', status: 'INACTIVE', roleId: 'REQUESTER_PD' })).status).toBe(200);
    expect(row('U-X2').tokenVersion).toBe(1);
    sdb.prepare("UPDATE users SET status='ACTIVE' WHERE id IN ('U-X1','U-X2')").run();
    expect((await call(t1, 'GET', '/api/bootstrap')).status).toBe(401);
    expect((await call(t2, 'GET', '/api/bootstrap')).status).toBe(401);
  });

  it('change-password rate limit also counts per IP, and a concurrent version change is a 409 (never a lost update)', async () => {
    const t = (await login('req.pd', 'OldPass1')).json.token;
    // a version bump between authentication and the UPDATE : emulate by making the stored version move while the request is in flight
    const realPrepare = env.DB.prepare;
    let armed = true;
    env.DB.prepare = (q) => {
      if (armed && /UPDATE users SET passwordHash/.test(q)) { armed = false; sdb.prepare("UPDATE users SET tokenVersion = 7 WHERE id='U-L1'").run(); }
      return realPrepare(q);
    };
    const r = await call(t, 'POST', '/api/me/password', { currentPassword: 'OldPass1', newPassword: 'BrandNew77' });
    env.DB.prepare = realPrepare;
    expect(r.status).toBe(409);
    expect(row('U-L1').tokenVersion).toBe(7); // untouched by the lost request
    // per IP : 31 wrong guesses from one IP across users are refused
    const rows = [];
    for (let i = 0; i < 31; i += 1) rows.push(`('IP', 'pw:9.9.9.9', 0, ${Date.now()}, '9.9.9.9', 'seed${i}')`);
    sdb.exec(`INSERT INTO login_attempts (kind, identifier, success, attemptedAt, ip, userAgent) VALUES ${rows.join(',')}`);
    const t2 = (await login('admin', 'AdminPass1')).json.token;
    const res = await onRequest({
      request: new Request('https://prpo.pages.dev/api/me/password', { method: 'POST', headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' }, body: JSON.stringify({ currentPassword: 'AdminPass1', newPassword: 'BrandNew77' }) }),
      env
    });
    expect(res.status).toBe(429);
  });

  it('401 carries a reason code (TOKEN_INVALID / TOKEN_EXPIRED / TOKEN_REVOKED) ; a database error while looking the user up is 503, never 401', async () => {
    const good = (await login('req.pd', 'OldPass1')).json.token;
    expect((await call('garbage.token', 'GET', '/api/bootstrap')).json).toMatchObject({ code: 'TOKEN_INVALID' });
    expect((await call(null, 'GET', '/api/bootstrap')).json.code).toBe('TOKEN_INVALID');
    const { signToken } = await import('../functions/_lib/auth.js');
    const expired = await signToken({ sub: 'U-L1', userId: 'U-L1', role: 'REQUESTER', level: 1, tv: 0 }, SECRET, { now: Date.now() - 9 * 3600 * 1000 });
    const e = await call(expired, 'GET', '/api/bootstrap');
    expect(e.status).toBe(401);
    expect(e.json.code).toBe('TOKEN_EXPIRED');
    // revoked : password changed elsewhere
    const admin = (await login('admin', 'AdminPass1')).json.token;
    await call(admin, 'PUT', '/api/users/U-L1', { id: 'U-L1', username: 'req.pd', name: 'req.pd', password: 'ResetPass9' });
    const rv = await call(good, 'GET', '/api/bootstrap');
    expect(rv.status).toBe(401);
    expect(rv.json.code).toBe('TOKEN_REVOKED');
    // missing row
    sdb.prepare("DELETE FROM users WHERE id='U-L1'").run();
    expect((await call(good, 'GET', '/api/bootstrap')).json.code).toBe('TOKEN_REVOKED');
    // DB failure on the lookup -> 503
    const realPrepare = env.DB.prepare;
    env.DB.prepare = (q) => {
      if (/SELECT \* FROM users WHERE id = \? LIMIT 1/.test(q)) return { bind: () => ({ first: async () => { throw new Error('D1_ERROR: boom'); } }) };
      return realPrepare(q);
    };
    const down = await call(admin, 'GET', '/api/bootstrap');
    env.DB.prepare = realPrepare;
    expect(down.status).toBe(503);
    expect(down.json.code).toBe('DB_UNAVAILABLE');
    expect((await call(admin, 'GET', '/api/bootstrap')).status).toBe(200); // recovers without a new login
  });

  it('stock-log department column = the product\'s department (the one the gate used)', async () => {
    sdb.prepare("INSERT INTO products (id, code, name, category, department, currentStock, isDeleted) VALUES ('P-PD','PD-A','n','PD','PD',5,0)").run();
    const t = (await login('req.pd', 'OldPass1')).json.token;
    const r = await call(t, 'POST', '/api/stock-logs', [{ id: 'L-1', productId: 'P-PD', type: 'IN', quantity: 1, department: 'pd-label' }]);
    expect(r.json).toMatchObject({ count: 1 });
    expect(sdb.prepare("SELECT department FROM stock_logs WHERE id='L-1'").get().department).toBe('PD');
  });
});
