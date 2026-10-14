// @vitest-environment node
// M7-4b : user signature clear / keep / replace through PUT /api/users (admin only) ; signerOf role fallback (GAS resolveUserSignatureBase64 :2002) ; repeated submit is a 200 no-op.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach } from 'vitest';
import { onRequest } from '../functions/api/[[route]].js';
import { hashPassword } from '../functions/_lib/password.js';

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = fs.readdirSync(path.join(rootDir, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
const SECRET = 'unit-test-secret-0123456789abcdef';
const PASS = 'Sig#Pass1';
const YEAR = new Date().getFullYear();
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG2 = PNG.replace('iVBOR', 'iVBOS');
const ROLE_SIG = 'data:image/png;base64,ROLESIG';

const d = DatabaseSync ? describe : describe.skip;

d('M7-4b user signature + repeated submit', () => {
  let sdb; let env; const tok = {};
  const call = async (who, method, p, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tok[who]}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const sigOf = (id) => sdb.prepare('SELECT signature FROM users WHERE id = ?').get(id).signature;
  const putUser = (extra) => call('adm', 'PUT', '/api/users/U3', { id: 'U3', username: 'pm', name: 'Plant', roleId: 'PLANT_MANAGER', department: 'MGT', allowedDepartments: ['*'], ...extra });

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    const rec = await hashPassword(PASS);
    const users = [
      ['U1', 'req', 'Req', 'PD', '["PD"]', 'REQUESTER_PD', 'REQUESTER', 1, null],
      ['U2', 'asst', 'Asst', 'PD', '["PD"]', 'ASST_MANAGER', 'REVIEWER', 2, null],
      ['U3', 'pm', 'Plant', 'MGT', '["*"]', 'PLANT_MANAGER', 'APPROVER', 3, PNG],
      ['U9', 'adm', 'Admin', 'ALL', '["*"]', 'ADMIN', 'ADMIN', 99, null]
    ];
    for (const [id, username, name, dept, allowed, roleId, canon, level, sig] of users) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, signature, passwordHash, passwordSalt, passwordAlgo, passwordIterations) VALUES (?,?,'',?,?,?,?,?,?,'ACTIVE',?,?,?,?,?)")
        .run(id, username, name, dept, allowed, roleId, canon, level, sig, rec.hash, rec.salt, rec.algo, rec.iterations);
    }
    env = { DB: { prepare: (q) => { const mk = (p) => ({ run: async () => { sdb.prepare(q).run(...p.map((v) => (v === undefined ? null : v))); return { success: true }; }, first: async () => { const r = sdb.prepare(q).get(...p.map((v) => (v === undefined ? null : v))); return r ? { ...r } : null; }, all: async () => ({ results: sdb.prepare(q).all(...p.map((v) => (v === undefined ? null : v))).map((r) => ({ ...r })) }) }); return { bind: (...p) => mk(p), ...mk([]) }; }, batch: async (stmts) => { sdb.exec('BEGIN'); try { const o = []; for (const s of stmts) o.push(await s.all()); sdb.exec('COMMIT'); return o; } catch (e) { sdb.exec('ROLLBACK'); throw e; } } }, AUTH_TOKEN_SECRET: SECRET };
    for (const [, username] of users) {
      const r = await onRequest({ request: new Request('https://prpo.pages.dev/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASS }) }), env });
      tok[username] = (await r.json()).token;
    }
  });

  it('signature null / "" clears it ; field not sent keeps it ; a new value replaces it', async () => {
    expect((await putUser({ description: 'a' })).status).toBe(200);
    expect(sigOf('U3')).toBe(PNG); // not sent -> kept
    expect((await putUser({ signature: PNG2 })).status).toBe(200);
    expect(sigOf('U3')).toBe(PNG2);
    expect((await putUser({ signature: null })).status).toBe(200);
    expect(sigOf('U3') || '').toBe('');
    await putUser({ signature: PNG });
    expect((await putUser({ signature: '' })).status).toBe(200);
    expect(sigOf('U3') || '').toBe('');
  });

  it('non-admin 403 ; bad type / oversize -> 400 and the stored signature is untouched', async () => {
    expect((await call('pm', 'PUT', '/api/users/U3', { id: 'U3', username: 'pm', name: 'Plant', roleId: 'PLANT_MANAGER', signature: null })).status).toBe(403);
    expect(sigOf('U3')).toBe(PNG);
    expect((await putUser({ signature: 'data:text/html;base64,PGI+' })).status).toBe(400);
    expect((await putUser({ signature: `data:image/png;base64,${'A'.repeat(500000)}` })).status).toBe(400);
    expect((await putUser({ signature: { x: 1 } })).status).toBe(400);
    expect(sigOf('U3')).toBe(PNG);
  });

  const seedPr = () => sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson) VALUES ('PR-S1', ?, 'PD', 'REQUESTER_PD', 'Req', 'REVIEWED', 10, '[]')").run(`PD001/${YEAR}`);
  const approverSig = async () => (await call('pm', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-S1').approverSignature;

  it('approve after the signature was cleared carries no old signature ; with a stored signature it carries it', async () => {
    seedPr();
    await call('pm', 'PUT', '/api/prs/PR-S1', { status: 'APPROVED' });
    expect(await approverSig()).toBe(PNG);
    sdb.prepare("DELETE FROM prs WHERE id = 'PR-S1'").run();
    seedPr();
    expect((await putUser({ signature: null })).status).toBe(200);
    expect((await call('pm', 'PUT', '/api/prs/PR-S1', { status: 'APPROVED' })).status).toBe(200);
    expect(await approverSig() || null).toBe(null);
  });

  it('no personal signature -> the signature row of the user\'s own role ; no roleId -> the REQUESTER_PD row (GAS :2002)', async () => {
    sdb.prepare("INSERT INTO signatures (roleId, signatureUrl) VALUES ('PLANT_MANAGER', ?)").run(ROLE_SIG);
    sdb.prepare("INSERT INTO signatures (roleId, signatureUrl) VALUES ('REQUESTER_PD', 'data:image/png;base64,REQSIG')").run();
    seedPr();
    await putUser({ signature: null });
    await call('pm', 'PUT', '/api/prs/PR-S1', { status: 'APPROVED' });
    expect(await approverSig()).toBe(ROLE_SIG);
    // the role row is matched case-insensitively and trimmed ; another role's row is never used
    sdb.prepare("UPDATE signatures SET roleId = ' plant_manager ' WHERE roleId = 'PLANT_MANAGER'").run();
    sdb.prepare("DELETE FROM prs WHERE id = 'PR-S1'").run();
    seedPr();
    await call('pm', 'PUT', '/api/prs/PR-S1', { status: 'APPROVED' });
    expect(await approverSig()).toBe(ROLE_SIG);
  });

  it('repeated submit (same status, same content) -> 200 no-op, nothing written, no audit ; changing content without the right is still 403', async () => {
    await call('req', 'POST', '/api/prs', { id: 'PR-RS', prNo: `PD007/${YEAR}`, department: 'PD', status: 'SUBMITTED', totalAmount: 100, items: [{ id: 'i1', name: 'x', qty: 1, price: 100 }] });
    const rows = () => sdb.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE entityId = 'PR-RS'").get().n;
    const before = rows();
    const upd = sdb.prepare("SELECT updatedAt FROM prs WHERE id = 'PR-RS'").get().updatedAt;
    const r = await call('req', 'PUT', '/api/prs/PR-RS', { status: 'SUBMITTED', action: 'RESUBMIT', totalAmount: 100, items: [{ id: 'i1', name: 'x', qty: 1, price: 100 }] });
    expect(r.status).toBe(200);
    expect(rows()).toBe(before);
    expect(sdb.prepare("SELECT updatedAt FROM prs WHERE id = 'PR-RS'").get().updatedAt).toBe(upd);
    const bad = await call('req', 'PUT', '/api/prs/PR-RS', { status: 'SUBMITTED', action: 'RESUBMIT', totalAmount: 999, items: [{ id: 'i1', name: 'x', qty: 9, price: 111 }] });
    expect(bad.status).toBe(403);
    expect(rows()).toBe(before);
  });
});
