// @vitest-environment node
// Bug D : PR create / review / approve / send back / cancel write audit_logs rows (actor from the TOKEN) and the PR timeline is assembled from them on read (GAS parity).
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
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0008_ws3_hardening.sql', '0010_token_version.sql'];
const SECRET = 'unit-test-secret-0123456789abcdef';
const PASS = 'Audit#Pass1';
const YEAR = new Date().getFullYear();

function makeD1(sdb) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { sdb.prepare(q).run(...norm(p)); return { success: true }; },
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) })
  });
  return {
    prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }),
    batch: async (stmts) => Promise.all(stmts.map((s) => s.all()))
  };
}

it('node:sqlite is available', () => { expect(DatabaseSync, 'node:sqlite not available in this Node version').toBeTruthy(); });

describe('PR audit_logs + assembled timeline', () => {
  let sdb; let env; const tokens = {};
  const call = async (who, method, p, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const rows = (q, ...p) => sdb.prepare(q).all(...p).map((r) => ({ ...r }));

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    const rec = await hashPassword(PASS);
    const users = [
      ['U-L1', 'req.pd', 'Pim Requester', 'PD', ['PD'], 'REQUESTER_PD', 'REQUESTER', 1],
      ['U-L2', 'asst.pd', 'Asst Manager', 'PD', ['PD'], 'ASST_MANAGER', 'REVIEWER', 2],
      ['U-L3', 'plant', 'Plant Manager', 'MGT', ['*'], 'PLANT_MANAGER', 'APPROVER', 3]
    ];
    for (const [id, username, name, department, depts, roleId, canon, level] of users) {
      sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status, passwordHash, passwordSalt, passwordAlgo, passwordIterations) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?,?)")
        .run(id, username, '', name, department, JSON.stringify(depts), roleId, canon, level, rec.hash, rec.salt, rec.algo, rec.iterations);
    }
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    for (const [id, username] of users.map((u) => [u[0], u[1]])) {
      const r = await onRequest({ request: new Request('https://prpo.pages.dev/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: PASS }) }), env });
      tokens[id] = (await r.json()).token;
    }
  });

  const newPr = (over = {}) => ({ id: 'PR-AUD-1', prNo: `PD001/${YEAR}`, department: 'PD', status: 'SUBMITTED', totalAmount: 100, items: [{ id: 'i1', name: 'x', qty: 1, price: 100 }], ...over });

  it('create -> review -> approve : audit rows carry the token actor, timeline comes back on GET and bootstrap', async () => {
    expect((await call('U-L1', 'POST', '/api/prs', newPr())).status).toBe(200);
    expect((await call('U-L2', 'PUT', '/api/prs/PR-AUD-1', { status: 'REVIEWED', approvalHistory: [{ action: 'REVIEWED', comment: 'ตรวจแล้ว ok', actorName: 'Hacker' }] })).status).toBe(200);
    expect((await call('U-L3', 'PUT', '/api/prs/PR-AUD-1', { status: 'APPROVED' })).status).toBe(200);

    const logs = rows("SELECT action, entityType, entityId, performedBy, details FROM audit_logs WHERE entityType = 'pr' AND action IN ('CREATE','REVIEW_FORWARD','APPROVE') ORDER BY rowid");
    expect(logs.map((l) => l.action)).toEqual(['CREATE', 'REVIEW_FORWARD', 'APPROVE']);
    expect(logs.map((l) => l.performedBy)).toEqual(['U-L1', 'U-L2', 'U-L3']);
    expect(JSON.parse(logs[1].details)).toMatchObject({ actorName: 'Asst Manager', comment: 'ตรวจแล้ว ok', docNo: `PD001/${YEAR}` });
    expect(JSON.parse(logs[2].details).actorName).toBe('Plant Manager');

    for (const view of [(await call('U-L1', 'GET', '/api/prs')).json, (await call('U-L1', 'GET', '/api/bootstrap')).json.prs]) {
      const pr = view.find((x) => x.id === 'PR-AUD-1');
      const acts = pr.timeline.map((e) => e.action);
      expect(acts).toEqual(['CREATE', 'REVIEW_FORWARD', 'APPROVE']);
      expect(pr.timeline.map((e) => e.actorName)).toEqual(['Pim Requester', 'Asst Manager', 'Plant Manager']);
      expect(pr.timeline.some((e) => e.actorName === 'Hacker' || e.action === 'FORGED')).toBe(false);
      expect(pr.timeline[1]).toMatchObject({ comment: 'ตรวจแล้ว ok', user: 'Asst Manager', id: expect.any(String), timestamp: expect.any(String) });
      // approvalHistory entries of the transitions share the audit event id (the modal shows one line)
      const ids = new Set(pr.timeline.map((e) => e.id));
      expect(pr.approvalHistory.filter((h) => ['REVIEWED', 'APPROVED'].includes(h.action)).every((h) => ids.has(h.id))).toBe(true);
    }
  });

  it('send back and cancel are recorded ; an unchanged status writes nothing ; the log is append-only', async () => {
    await call('U-L1', 'POST', '/api/prs', newPr());
    await call('U-L2', 'PUT', '/api/prs/PR-AUD-1', { status: 'REJECTED_TO_DRAFT', rejectReason: 'ข้อมูลไม่ครบ' });
    await call('U-L1', 'PUT', '/api/prs/PR-AUD-1', { reason: 'edit only' });
    await call('U-L1', 'PUT', '/api/prs/PR-AUD-1', { status: 'SUBMITTED', action: 'RESUBMIT' });
    await call('U-L2', 'PUT', '/api/prs/PR-AUD-1', { status: 'CANCELLED', cancelReason: 'ไม่ต้องการแล้ว' });
    const before = rows("SELECT id, action FROM audit_logs WHERE entityType = 'pr' AND action NOT IN ('PR_UPSERT')");
    expect(before.map((l) => l.action)).toEqual(['CREATE', 'SEND_BACK', 'RESUBMIT', 'CANCEL']);
    const pr = (await call('U-L1', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-AUD-1');
    expect(pr.timeline.map((e) => e.action)).toEqual(['CREATE', 'SEND_BACK', 'RESUBMIT', 'CANCEL']);
    expect(pr.timeline[1].comment).toBe('ข้อมูลไม่ครบ');
    expect(pr.timeline[3].comment).toBe('ไม่ต้องการแล้ว');
    // a later read does not add rows
    await call('U-L1', 'GET', '/api/bootstrap');
    expect(rows("SELECT id FROM audit_logs WHERE entityType = 'pr' AND action NOT IN ('PR_UPSERT')").length).toBe(4);
  });

  it('only visible PRs are queried (in chunks, no LIMIT) ; hidden PRs are not queried or returned ; merged timeline is time ordered', async () => {
    await call('U-L3', 'POST', '/api/prs', newPr({ id: 'PR-HID', prNo: `QC001/${YEAR}`, department: 'QC' }));
    for (let i = 0; i < 100; i += 1) {
      sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson) VALUES (?, ?, 'PD', 'REQUESTER_PD', 'Pim', 'SUBMITTED', 1, '[]')").run(`PR-M${i}`, `M-${i}`);
      sdb.prepare("INSERT INTO audit_logs (id, action, entityType, entityId, performedBy, details, timestamp) VALUES (?, 'CREATE', 'pr', ?, 'U-L1', '{}', ?)").run(`AL-M${i}`, `PR-M${i}`, '2026-03-01T00:00:00.000Z');
    }
    // PR-M0 : stored entries before / after the audit event + one with an unparseable time (keeps its place)
    sdb.prepare("UPDATE prs SET timelineJson = ? WHERE id = 'PR-M0'").run(JSON.stringify([
      { id: 'S-late', action: 'X', timestamp: '2999-01-01T00:00:00.000Z' }, { id: 'S-early', action: 'Y', timestamp: '2020-01-01T00:00:00.000Z' }, { id: 'S-thai', action: 'Z', timestamp: 'not-a-date' }
    ]));
    const seenSql = [];
    const realPrepare = env.DB.prepare;
    env.DB = { ...env.DB, prepare: (q) => { const o = realPrepare(q); return { ...o, bind: (...p) => { if (/FROM audit_logs/.test(q) && /entityType = 'pr'/.test(q)) seenSql.push({ q, p }); return o.bind(...p); } }; } };
    const list = (await call('U-L1', 'GET', '/api/prs')).json;
    expect(list.some((x) => x.id === 'PR-HID')).toBe(false);
    expect(list.length).toBe(100);
    expect(seenSql.length).toBe(1); // ONE query : the ids travel as one JSON parameter (json_each)
    expect(seenSql[0].q).toMatch(/json_each/);
    expect(/LIMIT/i.test(seenSql[0].q)).toBe(false);
    expect(seenSql[0].p.length).toBeLessThanOrEqual(10);
    const sentIds = JSON.parse(seenSql[0].p[0]);
    expect(sentIds).not.toContain('PR-HID');
    expect(sentIds).toContain('PR-M99');
    expect(sentIds.length).toBe(100);
    for (const x of list) expect(x.timeline.some((e) => e.action === 'CREATE')).toBe(true);
    expect(list.find((x) => x.id === 'PR-M0').timeline.map((e) => e.id)).toEqual(['S-early', 'S-thai', 'AL-M0', 'S-late']);
  });

  it('a client that sends the timeline it got from GET back (or forges an audit id) cannot re-stamp or hide a real event', async () => {
    await call('U-L1', 'POST', '/api/prs', newPr());
    await call('U-L2', 'PUT', '/api/prs/PR-AUD-1', { status: 'REJECTED_TO_DRAFT', rejectReason: 'ไม่ครบ' });
    const got = (await call('U-L1', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-AUD-1');
    const sendBack = got.timeline.find((e) => e.action === 'SEND_BACK');
    expect(sendBack.actorName).toBe('Asst Manager');
    // requester edits the draft : the whole PR as GET gave it, plus a forged entry reusing the id of the real SEND_BACK
    const put = await call('U-L1', 'PUT', '/api/prs/PR-AUD-1', { ...got, reason: 'แก้แล้ว', timeline: [...got.timeline, { id: sendBack.id, action: 'SEND_BACK', actorName: 'Pim Requester', comment: 'forged' }] });
    expect(put.status).toBe(200);
    const after = (await call('U-L1', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-AUD-1');
    const sb = after.timeline.filter((e) => e.action === 'SEND_BACK');
    expect(sb.length).toBe(1);
    expect(sb[0]).toMatchObject({ id: sendBack.id, actorName: 'Asst Manager', comment: 'ไม่ครบ' });
    expect(after.timeline.filter((e) => e.action === 'CREATE').length).toBe(1);
    // nothing with an audit id was stored in the PR's own timelineJson
    expect(JSON.parse(sdb.prepare("SELECT timelineJson FROM prs WHERE id = 'PR-AUD-1'").get().timelineJson).some((e) => String(e.id || '').startsWith('AL-'))).toBe(false);
    // then the requester resubmits : RESUBMIT is the requester's, the earlier events keep their actors
    await call('U-L1', 'PUT', '/api/prs/PR-AUD-1', { ...after, status: 'SUBMITTED', action: 'RESUBMIT' });
    const fin = (await call('U-L1', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-AUD-1');
    expect(fin.timeline.map((e) => [e.action, e.actorName])).toEqual([['CREATE', 'Pim Requester'], ['SEND_BACK', 'Asst Manager'], ['RESUBMIT', 'Pim Requester']]);
  });

  it('a NEW approvalHistory entry gets the server time, not the client time', async () => {
    await call('U-L1', 'POST', '/api/prs', newPr());
    await call('U-L2', 'PUT', '/api/prs/PR-AUD-1', { status: 'REJECTED_TO_DRAFT', approvalHistory: [{ action: 'SEND_BACK_NOTE', comment: 'c', timestamp: '2001-01-01T00:00:00.000Z', date: '2001-01-01' }] });
    const h = (await call('U-L1', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-AUD-1').approvalHistory;
    const e = h.find((x) => x.action === 'SEND_BACK_NOTE');
    expect(e.timestamp).not.toBe('2001-01-01T00:00:00.000Z');
    expect(e.date).not.toBe('2001-01-01');
  });

  it('the same approvalHistory entry sent twice is stored once ; different entries are both kept ; a copy of GET is not re-added', async () => {
    await call('U-L1', 'POST', '/api/prs', newPr());
    const note = (c, t) => ({ action: 'COMMENT', comment: c, timestamp: t });
    await call('U-L2', 'PUT', '/api/prs/PR-AUD-1', { approvalHistory: [note('A', '2026-05-01T01:00:00.000Z')] });
    await call('U-L2', 'PUT', '/api/prs/PR-AUD-1', { approvalHistory: [note('A', '2026-05-01T01:00:00.000Z')] });
    const count = async (c) => (await call('U-L1', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-AUD-1').approvalHistory.filter((h) => h.action === 'COMMENT' && h.comment === c).length;
    expect(await count('A')).toBe(1);
    await call('U-L2', 'PUT', '/api/prs/PR-AUD-1', { approvalHistory: [note('A', '2026-05-01T01:00:00.000Z'), note('B', '2026-05-01T02:00:00.000Z')] });
    expect(await count('A')).toBe(1);
    expect(await count('B')).toBe(1);
    const got = (await call('U-L1', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-AUD-1');
    await call('U-L2', 'PUT', '/api/prs/PR-AUD-1', { approvalHistory: got.approvalHistory });
    expect(await count('A')).toBe(1);
    expect(await count('B')).toBe(1);
  });

  it('bug E : PO rows carry the UI names poNo / prNo (and keep prNumber / prId) on GET /api/pos and bootstrap', async () => {
    sdb.prepare("INSERT INTO pos (id, poNumber, prId, prNumber, department, status, totalAmount, itemsJson) VALUES ('PO-E1', 'PO-PD-1', 'PR-E1', ?, 'PD', 'ORDERED', 10, '[]')").run(`PD001/${YEAR}`);
    for (const list of [(await call('U-L3', 'GET', '/api/pos')).json, (await call('U-L3', 'GET', '/api/bootstrap')).json.pos]) {
      const po = list.find((x) => x.id === 'PO-E1');
      expect(po).toMatchObject({ poNo: 'PO-PD-1', prNo: `PD001/${YEAR}`, prNumber: `PD001/${YEAR}`, prId: 'PR-E1' });
    }
  });

  it('PR write and audit row are one batch : if the batch fails nothing is written', async () => {
    const real = env.DB;
    env.DB = { ...real, batch: async () => { throw new Error('boom'); } };
    const r = await call('U-L1', 'POST', '/api/prs', newPr({ id: 'PR-ATOM', prNo: `PD009/${YEAR}` }));
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(sdb.prepare("SELECT COUNT(*) AS c FROM prs WHERE id = 'PR-ATOM'").get().c).toBe(0);
    expect(sdb.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE entityId = 'PR-ATOM' AND action = 'CREATE'").get().c).toBe(0);
  });

  it('an audit row POSTed by a client (source = client) never shows in the PR timeline (GET /api/prs and bootstrap)', async () => {
    await call('U-L1', 'POST', '/api/prs', newPr());
    sdb.prepare("INSERT INTO audit_logs (id, action, entityType, entityId, performedBy, details, timestamp, source) VALUES ('AL-FORGED', 'APPROVE', 'pr', 'PR-AUD-1', 'U-L1', ?, ?, 'client')")
      .run(JSON.stringify({ actorName: 'Plant Manager', comment: 'forged' }), new Date().toISOString());
    for (const view of [(await call('U-L1', 'GET', '/api/prs')).json, (await call('U-L1', 'GET', '/api/bootstrap')).json.prs]) {
      const pr = view.find((x) => x.id === 'PR-AUD-1');
      expect(pr.timeline.map((e) => e.action)).toEqual(['CREATE']);
      expect(pr.timeline.some((e) => e.id === 'AL-FORGED')).toBe(false);
    }
  });

  describe('M7-4a RESUBMIT marker', () => {
    const acts = () => sdb.prepare("SELECT action, performedBy, details FROM audit_logs WHERE entityType = 'pr' AND entityId = 'PR-AUD-1' AND action != 'PR_UPSERT' ORDER BY rowid").all().map((r) => ({ ...r }));
    it('resend after send-back with the marker -> exactly one RESUBMIT (actor from token, GAS text) ; the marker is not stored in extraJson', async () => {
      await call('U-L1', 'POST', '/api/prs', newPr());
      await call('U-L2', 'PUT', '/api/prs/PR-AUD-1', { status: 'REJECTED_TO_DRAFT', rejectReason: 'x' });
      expect((await call('U-L1', 'PUT', '/api/prs/PR-AUD-1', { status: 'SUBMITTED', action: 'RESUBMIT', isResubmit: true, reason: 'แก้' })).status).toBe(200);
      const r = acts().filter((a) => a.action === 'RESUBMIT');
      expect(r).toHaveLength(1);
      expect(r[0].performedBy).toBe('U-L1');
      expect(JSON.parse(r[0].details)).toMatchObject({ actorName: 'Pim Requester', comment: 'แก้ไขรายละเอียดเอกสารและส่งตรวจสอบใหม่อีกครั้ง' });
      const extra = JSON.parse(sdb.prepare("SELECT extraJson FROM prs WHERE id = 'PR-AUD-1'").get().extraJson || '{}');
      expect(extra.action).toBeUndefined();
      expect(extra.isResubmit).toBeUndefined();
    });
    it('draft save (action UPDATE) and a status change without the marker write no RESUBMIT ; an edit of the same SUBMITTED PR with the marker writes one', async () => {
      await call('U-L1', 'POST', '/api/prs', newPr({ status: 'DRAFT' }));
      await call('U-L1', 'PUT', '/api/prs/PR-AUD-1', { reason: 'ร่าง', action: 'UPDATE' });
      await call('U-L1', 'PUT', '/api/prs/PR-AUD-1', { status: 'SUBMITTED' });
      expect(acts().map((a) => a.action)).toEqual(['PR_DRAFTED']);
      // marker without a real re-send (same status, content unchanged) : no row
      expect((await call('U-L2', 'PUT', '/api/prs/PR-AUD-1', { reason: 'แก้ไข', action: 'RESUBMIT' })).status).toBe(200);
      expect(acts().map((a) => a.action)).toEqual(['PR_DRAFTED']);
      // content changed (level 2 may edit a SUBMITTED PR) : one RESUBMIT
      expect((await call('U-L2', 'PUT', '/api/prs/PR-AUD-1', { totalAmount: 250, items: [{ id: 'i1', name: 'x', qty: 1, price: 250 }], action: 'RESUBMIT' })).status).toBe(200);
      expect(acts().map((a) => a.action)).toEqual(['PR_DRAFTED', 'RESUBMIT']);
    });
    it('marker on a PR the caller may not edit -> 403 and no audit row', async () => {
      await call('U-L1', 'POST', '/api/prs', newPr());
      await call('U-L2', 'PUT', '/api/prs/PR-AUD-1', { status: 'REVIEWED' });
      const before = acts().length;
      const r = await call('U-L1', 'PUT', '/api/prs/PR-AUD-1', { action: 'RESUBMIT', reason: 'sneaky' });
      expect(r.status).toBe(403);
      expect(acts().length).toBe(before);
    });
    it('marker together with a real transition keeps that transition (APPROVE, not RESUBMIT) ; no second row', async () => {
      await call('U-L1', 'POST', '/api/prs', newPr());
      await call('U-L2', 'PUT', '/api/prs/PR-AUD-1', { status: 'REVIEWED' });
      expect((await call('U-L3', 'PUT', '/api/prs/PR-AUD-1', { status: 'APPROVED', action: 'RESUBMIT', isResubmit: true })).status).toBe(200);
      expect(acts().map((a) => a.action)).toEqual(['CREATE', 'REVIEW_FORWARD', 'APPROVE']);
    });
  });

  it('draft create is PR_DRAFTED ; a PR with no audit rows keeps its stored timeline', async () => {
    await call('U-L1', 'POST', '/api/prs', newPr({ id: 'PR-AUD-D', prNo: `PD002/${YEAR}`, status: 'DRAFT' }));
    sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson, timelineJson) VALUES ('PR-OLD', 'OLD-1', 'PD', 'REQUESTER_PD', 'Old', 'SUBMITTED', 1, '[]', ?)").run(JSON.stringify([{ id: 'T1', action: 'CREATE', timestamp: '2026-01-01T00:00:00.000Z' }]));
    const list = (await call('U-L1', 'GET', '/api/prs')).json;
    expect(list.find((x) => x.id === 'PR-AUD-D').timeline.map((e) => e.action)).toEqual(['PR_DRAFTED']);
    expect(list.find((x) => x.id === 'PR-OLD').timeline).toEqual([{ id: 'T1', action: 'CREATE', timestamp: '2026-01-01T00:00:00.000Z' }]);
  });
});
