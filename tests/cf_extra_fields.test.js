// @vitest-environment node
// P4c : PR / PO fields without a column (requestedBy, applicantName1, financials, reviewer / approver details, stakeholders, vendor snapshot ...)
// are kept in extraJson on POST / PUT and come back as top-level fields on GET / bootstrap ; server-owned and ownership fields cannot be written by the client.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { onRequest } from '../functions/api/[[route]].js';
import { hashPassword } from '../functions/_lib/password.js';
import { canSeeWorkspaceDocument } from '../src/services/workspaceService.js';

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0008_ws3_hardening.sql', '0010_token_version.sql'];
const SECRET = 'unit-test-secret-0123456789abcdef';
const PASS = 'Extra#Pass1';
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
    batch: async (stmts) => { sdb.exec('BEGIN'); try { const out = await Promise.all(stmts.map((s) => s.all())); sdb.exec('COMMIT'); return out; } catch (e) { try { sdb.exec('ROLLBACK'); } catch { /* done */ } throw e; } }
  };
}

// node:sqlite is required : if it is missing these tests FAIL (never skip silently)
it('node:sqlite is available', () => { expect(DatabaseSync, 'node:sqlite not available in this Node version').toBeTruthy(); });

describe('P4c PR / PO extra fields through the real routes', () => {
  let sdb; let env; const tokens = {};
  const call = async (who, method, p, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const one = (q, ...p) => { const r = sdb.prepare(q).get(...p); return r ? { ...r } : null; };

  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(rootDir, 'migrations', f), 'utf8'));
    const rec = await hashPassword(PASS);
    const users = [
      ['U-L1', 'req.pd', 'Pim Requester', 'PD', ['PD'], 'REQUESTER_PD', 'REQUESTER', 1],
      ['U-L2', 'asst.pd', 'Asst Manager', 'PD', ['PD'], 'ASST_MANAGER', 'REVIEWER', 2],
      ['U-L3', 'plant', 'Plant Manager', 'MGT', ['*'], 'PLANT_MANAGER', 'APPROVER', 3],
      ['U-AD', 'adm', 'Admin', 'ALL', ['*'], 'ADMIN', 'ADMIN', 99]
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

  const newPr = (over = {}) => ({
    id: 'PR-EX-1', prNo: `PD001/${YEAR}`, department: 'PD', status: 'SUBMITTED', totalAmount: 1234, purchaseChannel: 'SELF',
    items: [{ id: 'i1', name: 'สินค้า', qty: 2, price: 617 }],
    requestedBy: 'Somebody Else', applicantName1: 'Forged Applicant', requestedByRole: 'Requester (PD)', requestedDept: 'PD',
    note: 'ขอซื้อด่วน', memo: 'memo-x', specUrl: 'https://example.com/spec', hasVat: true, vendor: { id: 'V1', name: 'ร้านค้า', taxId: '123' },
    financials: { subtotal: 1234, vatAmount: 0, grandTotal: 1234 }, approvalHistory: [{ actorName: 'Pim Requester', action: 'SUBMITTED' }],
    activityLog: [{ action: 'created' }], submittedAt: '2026-01-01T00:00:00.000Z', requesterSignature: 'data:image/png;base64,AAAA',
    ...over
  });

  it('PR : POST -> GET returns every extra field on top level ; the creator comes from the token, never from the body', async () => {
    const r = await call('U-L1', 'POST', '/api/prs', newPr({ requesterId: 'FORGED-ID', extraJson: '{"x":1}', approvedTotal: 9 }));
    expect(r.status).toBe(200);
    for (const view of [(await call('U-L1', 'GET', '/api/prs')).json, (await call('U-L1', 'GET', '/api/bootstrap')).json.prs]) {
      const pr = view.find((x) => x.id === 'PR-EX-1');
      expect(pr).toMatchObject({
        requestedBy: 'Pim Requester', applicantName1: 'Pim Requester', requestedByRole: 'Requester (PD)', requestedDept: 'PD',
        note: 'ขอซื้อด่วน', memo: 'memo-x', specUrl: 'https://example.com/spec', vendor: { id: 'V1', name: 'ร้านค้า', taxId: '123' },
        financials: { subtotal: 1234, vatAmount: 0, grandTotal: 1234 }, approvalHistory: [{ actorName: 'Pim Requester', action: 'SUBMITTED' }],
        activityLog: [{ action: 'created' }], submittedAt: '2026-01-01T00:00:00.000Z', purchaseChannel: 'SELF', requesterSignature: 'data:image/png;base64,AAAA'
      });
      // kla round 2 : the top-level copies of the financials (hasVat / vatMode / subtotal ...) are no longer stored as extra fields - `financials` is the server's own
      expect(pr.hasVat).toBeUndefined();
      expect(pr.requesterId).toBe('REQUESTER_PD'); // role key from the token, not 'FORGED-ID'
      expect(pr.x).toBeUndefined(); // the client cannot smuggle an extraJson of its own
      expect(pr.approvedTotal).toBeUndefined();
    }
  });

  it('PR : a later save merges fields and never rewrites the creator ; reviewer / approver details are kept ; columns still win', async () => {
    await call('U-L1', 'POST', '/api/prs', newPr());
    // the assistant manager reviews : PUT with the reviewer details + an attempt to change the creator
    const put = await call('U-L2', 'PUT', '/api/prs/PR-EX-1', { status: 'REVIEWED', reviewedBy: { name: 'Asst Manager', signature: 'sig', timestamp: 't' }, reviewerName: 'Asst Manager', requestedBy: 'Hijack', applicantName1: 'Hijack', workflowStatus: 'REVIEWED', totalAmount: 1234 });
    expect(put.status).toBe(200);
    const pr = (await call('U-L1', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-EX-1');
    // the reviewer comes from the token (the body said 'Asst Manager' with signature 'sig' - the server writes its own values)
    expect(pr).toMatchObject({ status: 'REVIEWED', reviewerName: 'Asst Manager', reviewedBy: { id: 'ASST_MANAGER', name: 'Asst Manager' }, workflowStatus: 'REVIEWED', requestedBy: 'Pim Requester', applicantName1: 'Pim Requester', note: 'ขอซื้อด่วน' });
    expect(pr.reviewedBy.signature ?? null).toBeNull(); // this user has no signature and the role has none : not the client's 'sig' (json_patch drops a null member)
    // an upsert through POST for an existing PR keeps the creator too
    await call('U-L1', 'POST', '/api/prs', { ...newPr({ status: 'REVIEWED' }), requestedBy: 'Hijack again' });
    expect((await call('U-L1', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-EX-1').requestedBy).toBe('Pim Requester');
    expect(one("SELECT status FROM prs WHERE id='PR-EX-1'").status).not.toBe('Hijack');
  });

  it('PR : poNumber / purchaseChannel are real columns and are written', async () => {
    await call('U-L1', 'POST', '/api/prs', newPr({ purchaseChannel: 'ONLINE' }));
    expect(one("SELECT purchaseChannel, poNumber FROM prs WHERE id='PR-EX-1'")).toMatchObject({ purchaseChannel: 'ONLINE', poNumber: null });
    await call('U-AD', 'PUT', '/api/prs/PR-EX-1', { poNumber: 'PO-PD-2026-001', poNumbers: ['PO-PD-2026-001'], poId: 'PO-1' });
    expect(one("SELECT poNumber FROM prs WHERE id='PR-EX-1'").poNumber).toBe('PO-PD-2026-001');
    const pr = (await call('U-AD', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-EX-1');
    expect(pr).toMatchObject({ poNumber: 'PO-PD-2026-001', poNumbers: ['PO-PD-2026-001'], poId: 'PO-1' });
  });

  it('PR : an old row (importer / before this fix) with only requesterName reads back with requestedBy = requesterName', async () => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson) VALUES ('PR-OLD', 'OLD-1', 'PD', 'REQUESTER_PD', 'Old Name', 'SUBMITTED', 1, '[]')").run();
    const pr = (await call('U-L1', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-OLD');
    expect(pr.requestedBy).toBe('Old Name');
  });

  it('PR : an oversized extra is refused (413), not silently cut', async () => {
    const r = await call('U-L1', 'POST', '/api/prs', newPr({ id: 'PR-BIG', note: 'x'.repeat(1300000) }));
    expect([413]).toContain(r.status);
  });

  it('PO : created from the PR - ownership (requesterId / requestedBy) comes from the PR row ; approvedTotal and settlement fields cannot be written by the client', async () => {
    await call('U-L1', 'POST', '/api/prs', newPr());
    sdb.prepare("UPDATE prs SET status='APPROVED' WHERE id='PR-EX-1'").run();
    const po = {
      id: 'PO-EX-1', poNo: `PO-PD-${YEAR}-001`, prId: 'PR-EX-1', prNo: `PD001/${YEAR}`, department: 'PD', status: 'ISSUED', vendorId: 'V1', vendorName: 'ร้านค้า',
      totalAmount: 1234, grandTotal: 1234, items: [{ id: 'i1', name: 'สินค้า', qty: 2 }], purchaseChannel: 'SELF',
      requestedBy: 'Forged Owner', requesterId: 'FORGED', requesterSignature: 'data:image/png;base64,BBBB',
      stakeholders: { requesterName: 'Pim Requester', approverNames: ['Plant Manager'] }, vendor: { id: 'V1', name: 'ร้านค้า' }, vendorDetails: { id: 'V1', taxId: '123' },
      issueDate: `${YEAR}-02-03`, reviewerName: 'Asst Manager', reviewerSignature: 'sigR', approverName: 'Forged Approver', approverSignature: 'sigA', approvedAt: 'ts', refPrNo: 'FORGED-PR',
      approvedTotal: 999999, settlementStatus: 'PAID', savingsAmount: 77, actualItems: [{ id: 'z' }], onlineLink: 'https://example.com/o'
    };
    const r = await call('U-L3', 'POST', '/api/pos', po);
    expect(r.status).toBe(200);
    const got = (await call('U-L3', 'GET', '/api/pos')).json.find((x) => x.id === 'PO-EX-1');
    expect(got).toMatchObject({
      requestedBy: 'Pim Requester', requesterId: 'REQUESTER_PD', requesterSignature: 'data:image/png;base64,BBBB',
      stakeholders: { requesterName: 'Pim Requester', approverNames: ['Plant Manager'] }, vendor: { id: 'V1', name: 'ร้านค้า' }, vendorDetails: { id: 'V1', taxId: '123' },
      issueDate: `${YEAR}-02-03`, approvedBy: 'Plant Manager', approverName: 'Plant Manager', refPrNo: `PD001/${YEAR}`,
      onlineLink: 'https://example.com/o', purchaseChannel: 'SELF'
    });
    expect(got.approvedAt).not.toBe('ts'); // server time (th-TH string), not the body's value
    expect(got.reviewerName).toBeUndefined(); // the PR was never reviewed here : nothing to forward, the body's reviewer is not kept
    expect(got.settlementStatus).toBeUndefined();
    expect(got.savingsAmount).toBeUndefined();
    expect(got.actualItems).toBeUndefined();
    expect(got.approvedTotal).toBeUndefined();
    const stored = JSON.parse(one("SELECT extraJson FROM pos WHERE id='PO-EX-1'").extraJson);
    expect(stored.approvedTotal).toBe(1234); // computed by the server from the PR, not 999999
    // a later save merges ; the owner is not rewritten ; settlement stays server-only
    await call('U-L3', 'PUT', '/api/pos/PO-EX-1', { status: 'ORDERED_PENDING_DELIVERY', receiverName: 'Pim', requestedBy: 'Hijack', requesterId: 'X', approvedTotal: 1, settlementStatus: 'PAID' });
    const after = (await call('U-L3', 'GET', '/api/pos')).json.find((x) => x.id === 'PO-EX-1');
    // the receiver sent by the client ('Pim') is replaced by the token user (first time receiver details arrive)
    expect(after).toMatchObject({ receiverName: 'Plant Manager', requestedBy: 'Pim Requester', requesterId: 'REQUESTER_PD', approverName: 'Plant Manager', refPrNo: `PD001/${YEAR}` });
    expect(after.settlementStatus).toBeUndefined();
    expect(JSON.parse(one("SELECT extraJson FROM pos WHERE id='PO-EX-1'").extraJson).approvedTotal).toBe(1234);
  });

  it('the client flow submit -> review -> approve : reviewer / approver details and the history are written by the server with the values the screens/PDF showed before', async () => {
    sdb.prepare("UPDATE users SET signature='data:image/png;base64,SIG-L2', employeeName='คุณสมหญิง ผู้ช่วย' WHERE id='U-L2'").run();
    sdb.prepare("UPDATE users SET signature='data:image/png;base64,SIG-L3' WHERE id='U-L3'").run();
    sdb.prepare("INSERT INTO signatures (roleId, name, signatureUrl) VALUES ('PLANT_MANAGER', 'role sig', 'ROLE-SIG-PM')").run();
    // 1. submit (what createPR sends) - including a forged approval trail and totals
    const submit = await call('U-L1', 'POST', '/api/prs', newPr({
      reviewedBy: { name: 'Forged', signature: 'x' }, reviewerName: 'Forged', approverName: 'Forged', approvedBy: { name: 'Forged' }, totalEstimate: 1, estimatedTotal: 1, createdBy: 'Forged Creator',
      approvalHistory: [{ actorName: 'Forged', actorRole: 'Boss', action: 'SUBMITTED', date: '2026-01-01T00:00:00.000Z', timestamp: '2026-01-01T00:00:00.000Z', comment: 'ยื่นเสนอขอซื้อเข้าสู่ระบบ' },
        { actorName: 'Forged', action: 'APPROVED', timestamp: 'x', comment: 'fake approval' }]
    }));
    expect(submit.status).toBe(200);
    let pr = (await call('U-L1', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-EX-1');
    for (const k of ['reviewedBy', 'reviewerName', 'approverName', 'approvedBy', 'totalEstimate', 'estimatedTotal']) expect(pr[k], k).toBeUndefined();
    expect(pr.createdBy).toBe('Pim Requester');
    expect(pr.approvalHistory).toHaveLength(1); // the fake APPROVED entry was dropped
    expect(pr.approvalHistory[0]).toMatchObject({ actorName: 'Pim Requester', action: 'SUBMITTED', comment: 'ยื่นเสนอขอซื้อเข้าสู่ระบบ' });

    // 2. review (workflowEngine.updatePRStatus REVIEWED : the client appends its entry and sends the whole PR)
    const afterSubmitHistory = pr.approvalHistory;
    const review = await call('U-L2', 'PUT', '/api/prs/PR-EX-1', {
      status: 'REVIEWED', workflowStatus: 'REVIEWED', reviewedBy: { id: 'FAKE', name: 'Forged', signature: 'bad' }, reviewerName: 'Forged', approvedBy: { name: 'Forged early' },
      approvalHistory: [...afterSubmitHistory, { actorName: 'Asst', actorRole: 'Asst. Manager', action: 'REVIEWED', date: '15/1/2569 10:00:00', timestamp: '15/1/2569 10:00:00', comment: 'ตรวจแล้ว' }]
    });
    expect(review.status).toBe(200);
    pr = (await call('U-L1', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-EX-1');
    expect(pr.reviewedBy).toMatchObject({ id: 'ASST_MANAGER', name: 'คุณสมหญิง ผู้ช่วย', signature: 'data:image/png;base64,SIG-L2' }); // employeeName first, users.signature
    expect(typeof pr.reviewedBy.timestamp).toBe('string');
    expect(pr).toMatchObject({ reviewerName: 'คุณสมหญิง ผู้ช่วย', reviewerSignature: 'data:image/png;base64,SIG-L2', reviewedAt: pr.reviewedBy.timestamp });
    expect(pr.approvedBy).toBeUndefined();
    expect(pr.approvalHistory.map((e) => e.action)).toEqual(['SUBMITTED', 'REVIEWED']);
    expect(pr.approvalHistory[1]).toMatchObject({ actorName: 'Asst Manager', comment: 'ตรวจแล้ว' }); // token identity (users.name), client comment kept

    // 3. approve (APPROVED -> PO_ISSUED in one PUT, as the client sends the final status)
    const approve = await call('U-L3', 'PUT', '/api/prs/PR-EX-1', {
      status: 'PO_ISSUED', workflowStatus: 'PO_ISSUED', poNumbers: ['PO-X'], poNumber: 'PO-X',
      approvedBy: { id: 'FAKE', name: 'Forged' }, approverName: 'Forged', reviewerName: 'Forged again',
      approvalHistory: [...pr.approvalHistory, { actorName: 'PM', action: 'APPROVED', date: 'd', timestamp: 't', comment: 'อนุมัติ' }]
    });
    expect(approve.status).toBe(200);
    pr = (await call('U-L1', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-EX-1');
    // approver: no employeeName -> users.name ; signature = users.signature
    expect(pr.approvedBy).toMatchObject({ id: 'PLANT_MANAGER', name: 'Plant Manager', signature: 'data:image/png;base64,SIG-L3' });
    expect(pr).toMatchObject({ approverName: 'Plant Manager', approverSignature: 'data:image/png;base64,SIG-L3', approvedAt: pr.approvedBy.timestamp, reviewerName: 'คุณสมหญิง ผู้ช่วย', poNumber: 'PO-X', poNumbers: ['PO-X'] });
    expect(pr.approvalHistory.map((e) => e.action)).toEqual(['SUBMITTED', 'REVIEWED', 'APPROVED']);
    expect(pr.approvalHistory[2].actorName).toBe('Plant Manager');

    // 4. the approver without a personal signature gets the role's signature row (client: getSignatureByRole(roleId))
    sdb.prepare("UPDATE users SET signature=NULL WHERE id='U-L3'").run();
    await call('U-L1', 'POST', '/api/prs', newPr({ id: 'PR-EX-2', prNo: `PD002/${YEAR}` }));
    sdb.prepare("UPDATE prs SET status='REVIEWED' WHERE id='PR-EX-2'").run();
    await call('U-L3', 'PUT', '/api/prs/PR-EX-2', { status: 'IN_PROGRESS_ONLINE' });
    const pr2 = (await call('U-L3', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-EX-2');
    expect(pr2.approverSignature).toBe('ROLE-SIG-PM');
    expect(pr2.approvalHistory.at(-1)).toMatchObject({ action: 'APPROVED', actorName: 'Plant Manager' }); // transition without a client entry : the server adds one ('APPROVED' is what PDF / PrintablePO look for)

    // 5. the PO issued from the approved PR forwards the reviewer and names the approver (strings, like createPOFromPR)
    const po = await call('U-L3', 'POST', '/api/pos', { id: 'PO-FLOW', poNo: `PO-PD-${YEAR}-050`, prId: 'PR-EX-1', prNo: `PD001/${YEAR}`, department: 'PD', status: 'ISSUED', totalAmount: 1234, grandTotal: 1234, items: [{ id: 'i1', name: 'สินค้า', qty: 2 }], vendorName: 'ร้านค้า' });
    expect(po.status).toBe(200);
    const gotPo = (await call('U-L3', 'GET', '/api/pos')).json.find((x) => x.id === 'PO-FLOW');
    expect(gotPo).toMatchObject({
      reviewerName: 'คุณสมหญิง ผู้ช่วย', reviewerSignature: 'data:image/png;base64,SIG-L2', reviewedBy: { name: 'คุณสมหญิง ผู้ช่วย' },
      approvedBy: 'Plant Manager', approverName: 'Plant Manager', refPrNo: `PD001/${YEAR}`, requestedBy: 'Pim Requester', createdBy: 'Pim Requester', applicantName1: 'Pim Requester'
    });
    expect(typeof gotPo.approvedAt).toBe('string');
    expect(gotPo.approvalHistory).toBeUndefined();
  });

  it('timestamps are Bangkok time even though Workers run in UTC : 01:30 in Thailand (18:30Z the day before) shows the Thai date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-03-14T18:30:00.000Z')); // 15 March 2026 01:30 in Bangkok
      await call('U-L1', 'POST', '/api/prs', newPr());
      await call('U-L2', 'PUT', '/api/prs/PR-EX-1', { status: 'REVIEWED' }); // no client entry -> the server writes the history entry
      const pr = (await call('U-L1', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-EX-1');
      const entry = pr.approvalHistory.find((e) => e.action === 'REVIEWED');
      expect(entry.timestamp).toContain('15/3/2569'); // not 14/3/2569 (UTC)
      expect(entry.timestamp).toContain('01:30');
      // the PO's approvedAt string
      sdb.prepare("UPDATE prs SET status='APPROVED' WHERE id='PR-EX-1'").run();
      await call('U-L3', 'POST', '/api/pos', { id: 'PO-TZ', poNo: `PO-PD-${YEAR}-077`, prId: 'PR-EX-1', prNo: `PD001/${YEAR}`, department: 'PD', status: 'ISSUED', totalAmount: 1, grandTotal: 1, items: [{ id: 'i1', name: 'สินค้า', qty: 2 }] });
      const po = (await call('U-L3', 'GET', '/api/pos')).json.find((x) => x.id === 'PO-TZ');
      expect(po.approvedAt).toContain('15/3/2569');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an admin-seeded PO without a PR gets the approver from the token and NO reviewer', async () => {
    const r = await call('U-AD', 'POST', '/api/pos', { id: 'PO-NOPR', poNo: `PO-PD-${YEAR}-088`, department: 'PD', status: 'ISSUED', totalAmount: 5, grandTotal: 5, items: [], reviewerName: 'Fake Reviewer', approverName: 'Fake' });
    expect(r.status).toBe(200);
    const po = (await call('U-AD', 'GET', '/api/pos')).json.find((x) => x.id === 'PO-NOPR');
    expect(po).toMatchObject({ approvedBy: 'Admin', approverName: 'Admin' });
    expect(typeof po.approvedAt).toBe('string');
    expect(po.reviewerName).toBeUndefined();
    expect(po.reviewedBy).toBeUndefined();
  });

  it('a workflow entry cannot be added without the real transition ; reserved amounts and null-clearing', async () => {
    await call('U-L1', 'POST', '/api/prs', newPr());
    // the requester re-saves the SUBMITTED PR and tries to slip in an APPROVED / REVIEWED entry
    await call('U-L1', 'PUT', '/api/prs/PR-EX-1', { note: 'edited', approvalHistory: [{ action: 'APPROVED', timestamp: 'z', comment: 'self-approved' }, { action: 'REVIEWED', timestamp: 'y' }, { action: 'EDITED', timestamp: 'e', comment: 'แก้ไข' }], totalEstimate: 5 });
    let pr = (await call('U-L1', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-EX-1');
    expect(pr.approvalHistory.map((e) => e.action)).toEqual(['SUBMITTED', 'EDITED'].slice(0, pr.approvalHistory.length));
    expect(pr.approvalHistory.some((e) => ['APPROVED', 'REVIEWED'].includes(e.action))).toBe(false);
    expect(pr.totalEstimate).toBeUndefined();
    expect(pr.note).toBe('edited');
    // null clears a stored field (json_patch) ; a reserved key set to null does nothing
    await call('U-L1', 'PUT', '/api/prs/PR-EX-1', { note: null, memo: null, requestedBy: null });
    pr = (await call('U-L1', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-EX-1');
    expect(pr.note).toBeUndefined();
    expect(pr.memo).toBeUndefined();
    expect(pr.requestedBy).toBe('Pim Requester');
  });

  it('P4f logs are append-only with the token\'s identity ; actor / stamp fields of a receipt, a short close and the history are written by the server', async () => {
    sdb.prepare("UPDATE users SET signature='data:image/png;base64,SIG-L3' WHERE id='U-L3'").run();
    await call('U-L1', 'POST', '/api/prs', newPr({ activityLog: [{ action: 'สร้าง', user: 'Pim Requester', role: 'Requester', timestamp: 't0', note: 'n0' }], timeline: [{ action: 'created', user: 'Pim Requester' }] }));
    // a later save rewrites an old entry and adds a new one under somebody else's name
    await call('U-L1', 'PUT', '/api/prs/PR-EX-1', {
      activityLog: [{ action: 'สร้าง', user: 'Forged', role: 'Boss', timestamp: 'tX', note: 'n0' }, { action: 'แก้ไข', user: 'Forged', role: 'Boss', timestamp: 'tY', note: 'n1' }],
      timeline: [{ action: 'created', user: 'Forged' }, { action: 'edited', user: 'Forged', date: 'old-date' }], workflowStatus: 'FORGED', fullyReceivedAt: 'fake'
    });
    const pr = (await call('U-L1', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-EX-1');
    expect(pr.activityLog).toHaveLength(2);
    expect(pr.activityLog[0]).toMatchObject({ user: 'Pim Requester', role: 'REQUESTER', note: 'n0' }); // stamped at creation (token identity) and untouched by the later save
    expect(pr.activityLog[0].timestamp).not.toBe('tX');
    expect(pr.activityLog[1]).toMatchObject({ action: 'แก้ไข', user: 'Pim Requester', note: 'n1' }); // new entry: content kept, identity from the token
    expect(pr.activityLog[1].role).not.toBe('Boss');
    expect(pr.activityLog[1].timestamp).not.toBe('tY');
    expect(pr.timeline.filter((t) => !String(t.id || '').startsWith('AL-')).map((t) => t.user)).toEqual(['Pim Requester', 'Pim Requester']); // + the server's audit event (CREATE)
    expect(pr.timeline[1].date).not.toBe('old-date');
    expect(pr.workflowStatus).toBe('SUBMITTED'); // = status, never the body's
    expect(pr.fullyReceivedAt).not.toBe('fake');

    // PO : receipt through the screens' PUT (grnHistory grows) -> receiver details are the token user's, with their signature
    sdb.prepare("UPDATE prs SET status='APPROVED' WHERE id='PR-EX-1'").run();
    await call('U-L3', 'POST', '/api/pos', { id: 'PO-LOG', poNo: `PO-PD-${YEAR}-060`, prId: 'PR-EX-1', prNo: `PD001/${YEAR}`, department: 'PD', status: 'ISSUED', totalAmount: 1, grandTotal: 1, items: [{ id: 'i1', name: 'สินค้า', qty: 2 }] });
    await call('U-L1', 'PUT', '/api/pos/PO-LOG', {
      status: 'PARTIAL', receivedBy: 'Forged Receiver', receiverName: 'Forged Receiver', receiverSignature: 'FORGED-SIG', receivedAt: 'fake', receivingInfo: { receiverName: 'Forged Receiver' },
      grnHistory: [{ grnNumber: 'GRN-1', round: 1, date: 'x', receivedBy: 'Forged Receiver', items: [], note: 'ครบ' }], workflowStatus: 'PARTIAL', fullyReceivedAt: 'fake'
    });
    let po = (await call('U-L1', 'GET', '/api/pos')).json.find((x) => x.id === 'PO-LOG');
    expect(po).toMatchObject({ receivedBy: 'Pim Requester', receiverName: 'Pim Requester', receivedById: 'REQUESTER_PD', workflowStatus: 'PARTIAL' });
    expect(po.receiverSignature).toBe('/signatures/receiver-default.png'); // this user has no signature : the client's default, not 'FORGED-SIG'
    expect(po.receivingInfo).toMatchObject({ receiverName: 'Pim Requester', receiverId: 'REQUESTER_PD' });
    expect(po.grnHistory).toHaveLength(1);
    expect(po.grnHistory[0]).toMatchObject({ grnNumber: 'GRN-1', receivedBy: 'Pim Requester', note: 'ครบ' });
    // an unrelated later save by somebody else (no new receipt) does not change the receiver
    await call('U-L3', 'PUT', '/api/pos/PO-LOG', { status: 'PARTIAL', receivedBy: 'Plant Manager', receivingInfo: { receiverName: 'Plant Manager' }, grnHistory: po.grnHistory, note: 'later' });
    po = (await call('U-L1', 'GET', '/api/pos')).json.find((x) => x.id === 'PO-LOG');
    expect(po.receivedBy).toBe('Pim Requester');
    expect(po.grnHistory).toHaveLength(1);
    // short close : closedBy / closedDate come from the server ; the reason is the client's content
    await call('U-L3', 'PUT', '/api/pos/PO-LOG', { status: 'CLOSED', closedEarly: true, shortCloseReason: 'ไม่รอของ', closedBy: 'Forged Closer', closedDate: 'fake' });
    po = (await call('U-L1', 'GET', '/api/pos')).json.find((x) => x.id === 'PO-LOG');
    expect(po).toMatchObject({ closedEarly: true, shortCloseReason: 'ไม่รอของ', closedBy: 'Plant Manager' });
    expect(po.closedDate).not.toBe('fake');
  });

  it('P4f the server receive endpoint writes receivingInfo / grnHistory / timeline from the token and the PO line\'s product', async () => {
    sdb.prepare("INSERT INTO products (id, code, name, category, department, currentStock, isDeleted) VALUES ('P-REC', 'REC-1', 'rec item', 'PD', 'PD', 1, 0)").run();
    sdb.prepare("UPDATE users SET signature='data:image/png;base64,SIG-L1' WHERE id='U-L1'").run();
    await call('U-L1', 'POST', '/api/prs', newPr({ items: [{ id: 'i1', productId: 'P-REC', code: 'REC-1', name: 'rec item', qty: 2, price: 617 }] }));
    sdb.prepare("UPDATE prs SET status='APPROVED' WHERE id='PR-EX-1'").run();
    await call('U-L3', 'POST', '/api/pos', { id: 'PO-REC', poNo: `PO-PD-${YEAR}-061`, prId: 'PR-EX-1', prNo: `PD001/${YEAR}`, department: 'PD', status: 'ISSUED', totalAmount: 1, grandTotal: 1, items: [{ id: 'i1', productId: 'P-REC', code: 'REC-1', name: 'rec item', qty: 2 }] });
    const r = await call('U-L1', 'POST', '/api/pos/PO-REC/receive', { receivingItems: [{ productId: 'P-REC', goodQty: 2, name: 'Forged name' }], note: 'รับครบ', grNumber: 'GRN-REC-1', user: { name: 'Forged' } });
    expect(r.status).toBe(200);
    const po = (await call('U-L1', 'GET', '/api/pos')).json.find((x) => x.id === 'PO-REC');
    expect(po).toMatchObject({ status: 'CLOSED', workflowStatus: 'CLOSED', receivedBy: 'Pim Requester', receiverSignature: 'data:image/png;base64,SIG-L1', receivedById: 'REQUESTER_PD' });
    expect(po.receivingInfo).toMatchObject({ receiverName: 'Pim Requester', receiverSignature: 'data:image/png;base64,SIG-L1' });
    expect(po.grnHistory[0]).toMatchObject({ grnNumber: 'GRN-REC-1', receivedBy: 'Pim Requester', note: 'รับครบ' });
    expect(po.fullyReceivedAt).toBeTruthy();
    expect(po.timeline.at(-1).user).toBe('Pim Requester');
    expect(one("SELECT productName FROM stock_logs WHERE productId='P-REC'").productName).toBe('rec item'); // not 'Forged name'
    expect(one("SELECT currentStock FROM products WHERE id='P-REC'").currentStock).toBe(3);
  });

  it('P4f a legacy PR (history never stored by the server) takes the client entries ONCE, with the token\'s identity', async () => {
    sdb.prepare("INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, itemsJson) VALUES ('PR-LEG', 'LEG-1', 'PD', 'REQUESTER_PD', 'Old Name', 'SUBMITTED', 1, '[]')").run();
    await call('U-L1', 'PUT', '/api/prs/PR-LEG', { note: 'x', approvalHistory: [{ actorName: 'Somebody Else', actorRole: 'Boss', action: 'SUBMITTED', timestamp: 't', comment: 'c' }] });
    const pr = (await call('U-L1', 'GET', '/api/prs')).json.find((x) => x.id === 'PR-LEG');
    expect(pr.approvalHistory).toHaveLength(1);
    expect(pr.approvalHistory[0]).toMatchObject({ actorName: 'Pim Requester', action: 'SUBMITTED', comment: 'c' });
    expect(pr.approvalHistory[0].actorRole).not.toBe('Boss');
  });

  it('rule C runs on the data read back from D1 : the creator sees their PR of ANOTHER department in the workspace, others do not', async () => {
    // an admin enters a QC PR on behalf of Pim (requestedBy is the admin from the token) ; here the stored creator is set directly like an import would
    await call('U-AD', 'POST', '/api/prs', newPr({ id: 'PR-QC-1', prNo: `QC001/${YEAR}`, department: 'QC' }));
    sdb.prepare("UPDATE prs SET extraJson = json_set(extraJson, '$.requestedBy', 'Pim Requester') WHERE id='PR-QC-1'").run();
    const boot = (await call('U-L1', 'GET', '/api/bootstrap')).json;
    const pr = boot.prs.find((x) => x.id === 'PR-QC-1');
    expect(pr, 'the creator receives the PR of the other department').toBeTruthy();
    expect(pr.requestedBy).toBe('Pim Requester');
    const session = { id: 'REQUESTER_PD', roleId: 'REQUESTER_PD', level: 1, name: 'Pim Requester', username: 'req.pd', department: 'PD', departments: ['PD'], assignedDepartments: ['PD'], allowedDepartments: ['PD'] };
    expect(canSeeWorkspaceDocument({ ...pr, docType: 'PR' }, session)).toBe(true); // the client's own rule agrees with what the server sent
    // somebody else's PR in that department is not sent
    await call('U-AD', 'POST', '/api/prs', newPr({ id: 'PR-QC-2', prNo: `QC002/${YEAR}`, department: 'QC' }));
    expect((await call('U-L1', 'GET', '/api/prs')).json.some((x) => x.id === 'PR-QC-2')).toBe(false);
  });

  describe('P4f follow-up : who / when fields stamped by the server', () => {
    const makePo = async (id = 'PO-WHO') => {
      await call('U-L1', 'POST', '/api/prs', newPr());
      sdb.prepare("UPDATE prs SET status='APPROVED' WHERE id='PR-EX-1'").run();
      const r = await call('U-L3', 'POST', '/api/pos', { id, poNo: `PO-PD-${YEAR}-070`, prId: 'PR-EX-1', prNo: `PD001/${YEAR}`, department: 'PD', status: 'ISSUED', totalAmount: 1, grandTotal: 1, items: [{ id: 'i1', name: 'สินค้า', qty: 2 }] });
      expect(r.status).toBe(200);
    };
    const getPo = async (id = 'PO-WHO') => (await call('U-AD', 'GET', '/api/pos')).json.find((x) => x.id === id);

    it('claimHistory (resolvedBy / resolvedById / resolvedAt) and timeline (actor) of a new entry come from the token ; stored entries stay', async () => {
      await makePo();
      await call('U-L3', 'PUT', '/api/pos/PO-WHO', {
        claimHistory: [{ round: 1, resolution: { type: 'REFUND' }, resolvedBy: 'Forged', resolvedById: 'FORGED-ID', resolvedAt: 'fake-time', channel: 'ONLINE' }],
        timeline: [{ action: 'resolved', actor: 'Forged', actorRole: 'Boss', date: 'fake-date' }]
      });
      let po = await getPo();
      expect(po.claimHistory).toHaveLength(1);
      expect(po.claimHistory[0]).toMatchObject({ round: 1, resolution: { type: 'REFUND' }, resolvedBy: 'Plant Manager', resolvedById: 'PLANT_MANAGER', channel: 'ONLINE' });
      expect(po.claimHistory[0].resolvedAt).not.toBe('fake-time');
      expect(po.timeline.at(-1)).toMatchObject({ action: 'resolved', actor: 'Plant Manager' });
      expect(po.timeline.at(-1).date).not.toBe('fake-date');
      // a later save by somebody else cannot rewrite the stored entry, a new one gets that user's identity
      await call('U-L1', 'PUT', '/api/pos/PO-WHO', {
        claimHistory: [{ round: 1, resolution: { type: 'REFUND' }, resolvedBy: 'Hijack', resolvedAt: 'x', channel: 'ONLINE' }, { round: 2, resolvedBy: 'Hijack', resolvedAt: 'y' }]
      });
      po = await getPo();
      expect(po.claimHistory.map((e) => e.resolvedBy)).toEqual(['Plant Manager', 'Pim Requester']);
    });

    it('orderedBy / orderedAt, storeClaims, inlineClaimData and claimData : stamped when new or changed, stored values kept when unchanged', async () => {
      await makePo();
      const at = new Date().toISOString();
      const claim = { reason: 'ของเสีย', channel: 'ONLINE', reportedBy: 'Forged', reportedById: 'F', reportedAt: 'fake' };
      await call('U-L3', 'PUT', '/api/pos/PO-WHO', {
        orderedBy: 'Forged', orderedAt: at,
        storeClaims: { shopA: { status: 'RESOLVED', type: 'REFUND', resolvedBy: 'Forged', resolvedAt: at }, 'Shop A': { status: 'RESOLVED', type: 'REFUND', resolvedBy: 'Forged', resolvedAt: at } },
        inlineClaimData: { resolution: 'REFUND', resolvedBy: 'Forged', resolvedAt: 'fake' },
        claimData: claim
      });
      let po = await getPo();
      expect(po).toMatchObject({ orderedBy: 'Plant Manager', orderedAt: at });
      expect(po.storeClaims.shopA).toMatchObject({ status: 'RESOLVED', resolvedBy: 'Plant Manager' });
      expect(po.storeClaims['Shop A'].resolvedBy).toBe('Plant Manager');
      expect(po.storeClaims.shopA.resolvedAt).not.toBe('forged');
      expect(po.inlineClaimData).toMatchObject({ resolution: 'REFUND', resolvedBy: 'Plant Manager' });
      expect(po.claimData).toMatchObject({ reason: 'ของเสีย', reportedBy: 'Plant Manager', reportedById: 'PLANT_MANAGER' });
      expect(po.claimData.reportedAt).not.toBe('fake');
      const stampedAt = po.storeClaims.shopA.resolvedAt;
      const stampedReportedAt = po.claimData.reportedAt;
      // a stale copy saved by another user : nothing changes, the stored who / when stay
      await call('U-L1', 'PUT', '/api/pos/PO-WHO', {
        orderedBy: 'Client Name', orderedAt: at,
        storeClaims: { shopA: { status: 'RESOLVED', type: 'REFUND', resolvedBy: 'Client Name', resolvedAt: 'client-time' } },
        inlineClaimData: { resolution: 'REFUND', resolvedBy: 'Client Name', resolvedAt: 'client-time' },
        claimData: { ...claim, reportedBy: 'Client Name', reportedAt: 'client-time' }
      });
      po = await getPo();
      expect(po).toMatchObject({ orderedBy: 'Plant Manager', orderedAt: at });
      expect(po.storeClaims.shopA).toMatchObject({ resolvedBy: 'Plant Manager', resolvedAt: stampedAt });
      expect(po.inlineClaimData.resolvedBy).toBe('Plant Manager');
      expect(po.claimData).toMatchObject({ reportedBy: 'Plant Manager', reportedAt: stampedReportedAt });
      // a real change : a new ordering and a changed claim take the saver's identity
      const at2 = new Date(Date.now() + 1000).toISOString();
      await call('U-L1', 'PUT', '/api/pos/PO-WHO', {
        orderedBy: 'Forged 2', orderedAt: at2,
        storeClaims: { shopA: { status: 'WAITING_REPLACEMENT', type: 'REPLACEMENT', resolvedBy: 'Forged 2', resolvedAt: at2 } },
        claimData: { ...claim, reason: 'ส่งผิด', reportedBy: 'Forged 2' }
      });
      po = await getPo();
      expect(po).toMatchObject({ orderedBy: 'Pim Requester', orderedAt: at2 });
      expect(po.storeClaims.shopA).toMatchObject({ status: 'WAITING_REPLACEMENT', resolvedBy: 'Pim Requester' });
      expect(po.claimData).toMatchObject({ reason: 'ส่งผิด', reportedBy: 'Pim Requester' });
      // an ordering time far from the server clock is not trusted
      await call('U-L3', 'PUT', '/api/pos/PO-WHO', { orderedBy: 'Forged 3', orderedAt: '2020-01-01T00:00:00.000Z' });
      po = await getPo();
      expect(po.orderedBy).toBe('Pim Requester'); // the stored value from the previous ordering stays
      expect(po.orderedAt).toBe(at2);
      expect(po.logSealed).toBeUndefined(); // server bookkeeping is never sent to the client
    });

    it('a legacy row (no log stored by the server) keeps the client\'s history as sent ONCE ; afterwards the log is append-only with the token\'s identity', async () => {
      sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson, extraJson) VALUES ('PO-OLD', 'PO-OLD-1', 'PD', 'ISSUED', '[]', '{}')").run();
      await call('U-AD', 'PUT', '/api/pos/PO-OLD', {
        activityLog: [{ action: 'old-1', user: 'Original Author', role: 'Buyer', timestamp: '1/1/2569 09:00:00' }, { action: 'old-2', user: 'Other Author', timestamp: '2/1/2569 09:00:00' }]
      });
      let po = await getPo('PO-OLD');
      expect(po.activityLog.map((e) => e.user)).toEqual(['Original Author', 'Other Author']);
      expect(po.activityLog[0]).toMatchObject({ role: 'Buyer', timestamp: '1/1/2569 09:00:00' });
      // from now on the log belongs to the server
      await call('U-AD', 'PUT', '/api/pos/PO-OLD', {
        activityLog: [{ action: 'old-1', user: 'Hijack', timestamp: 'x' }, { action: 'old-2', user: 'Hijack', timestamp: 'y' }, { action: 'new-3', user: 'Forged', timestamp: 'z' }]
      });
      po = await getPo('PO-OLD');
      expect(po.activityLog.map((e) => e.user)).toEqual(['Original Author', 'Other Author', 'Admin']);
      // a row created through the server stamps new entries right away (not treated as legacy)
      await makePo();
      await call('U-L3', 'PUT', '/api/pos/PO-WHO', { activityLog: [{ action: 'first', user: 'Forged' }] });
      expect((await getPo()).activityLog[0].user).toBe('Plant Manager');
    });

    const rawExtra = (id) => JSON.parse(sdb.prepare('SELECT extraJson FROM pos WHERE id = ?').get(id).extraJson || '{}');

    it('legacy rows are sealed key by key : a log key the server never stored stays open for its first save', async () => {
      sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson, extraJson) VALUES ('PO-OLD2', 'PO-OLD-2', 'PD', 'ISSUED', '[]', '{}')").run();
      await call('U-AD', 'PUT', '/api/pos/PO-OLD2', { activityLog: [{ action: 'a1', user: 'Author A', timestamp: 't1' }] });
      expect(rawExtra('PO-OLD2').logSealed).toEqual(['activityLog']);
      // another key arrives in a later round : still legacy for that key, taken as sent
      await call('U-L3', 'PUT', '/api/pos/PO-OLD2', {
        activityLog: [{ action: 'a1', user: 'Author A', timestamp: 't1' }],
        history: [{ action: 'h1', user: 'Author H', timestamp: 't2' }]
      });
      let po = await getPo('PO-OLD2');
      expect(po.history.map((e) => e.user)).toEqual(['Author H']);
      expect(po.activityLog.map((e) => e.user)).toEqual(['Author A']);
      expect(po.logSealed).toBeUndefined();
      expect(rawExtra('PO-OLD2').logSealed).toEqual(['activityLog', 'history']);
      // now history is sealed too
      await call('U-L1', 'PUT', '/api/pos/PO-OLD2', { history: [{ action: 'h1', user: 'Hijack' }, { action: 'h2', user: 'Forged' }] });
      po = await getPo('PO-OLD2');
      expect(po.history.map((e) => e.user)).toEqual(['Author H', 'Pim Requester']);
      // the boolean older dev rows may carry means every key is sealed
      sdb.prepare("UPDATE pos SET extraJson = json_set(extraJson, '$.logSealed', json('true')) WHERE id = 'PO-OLD2'").run();
      await call('U-L3', 'PUT', '/api/pos/PO-OLD2', { claimHistory: [{ round: 1, resolvedBy: 'Forged' }] });
      expect((await getPo('PO-OLD2')).claimHistory[0].resolvedBy).toBe('Plant Manager');
      expect(rawExtra('PO-OLD2').logSealed).toBe(true);
    });

    it('/receive on an old row seals only grnHistory ; the other keys keep their legacy first save', async () => {
      sdb.prepare("INSERT INTO products (id, code, name, category, department, currentStock, isDeleted) VALUES ('P-LG', 'LG-1', 'lg item', 'PD', 'PD', 1, 0)").run();
      await call('U-L1', 'POST', '/api/prs', newPr({ items: [{ id: 'i1', productId: 'P-LG', code: 'LG-1', name: 'lg item', qty: 2, price: 617 }] }));
      sdb.prepare("UPDATE prs SET status='APPROVED' WHERE id='PR-EX-1'").run();
      await call('U-L3', 'POST', '/api/pos', { id: 'PO-LG', poNo: `PO-PD-${YEAR}-072`, prId: 'PR-EX-1', prNo: `PD001/${YEAR}`, department: 'PD', status: 'ISSUED', totalAmount: 1, grandTotal: 1, items: [{ id: 'i1', productId: 'P-LG', code: 'LG-1', name: 'lg item', qty: 2 }] });
      // make it an old row : the server holds none of the logs
      sdb.prepare("UPDATE pos SET extraJson = json_remove(extraJson, '$.logSealed', '$.activityLog', '$.history', '$.grnHistory') WHERE id = 'PO-LG'").run();
      const r = await call('U-L1', 'POST', '/api/pos/PO-LG/receive', { receivingItems: [{ productId: 'P-LG', goodQty: 2 }], note: 'x', grNumber: 'GRN-LG-1' });
      expect(r.status).toBe(200);
      expect(rawExtra('PO-LG').logSealed).toEqual(['grnHistory']);
      // the client then saves its copy : activityLog is still legacy (taken as sent), grnHistory is the server's (append-only)
      let po = await getPo('PO-LG');
      await call('U-L3', 'PUT', '/api/pos/PO-LG', {
        activityLog: [{ action: 'old', user: 'Original Author', timestamp: 'ts' }],
        grnHistory: [{ grnNumber: 'GRN-OLD', receivedBy: 'Forged' }, ...po.grnHistory]
      });
      po = await getPo('PO-LG');
      expect(po.activityLog.map((e) => e.user)).toEqual(['Original Author']);
      expect(po.grnHistory.map((e) => e.grnNumber)).toEqual(['GRN-LG-1', 'GRN-OLD']);
      expect(po.grnHistory.at(-1).receivedBy).toBe('Plant Manager');
      expect(rawExtra('PO-LG').logSealed).toEqual(['activityLog', 'grnHistory']);
    });

    it('a PO created through the server has no legacy window : every key is sealed from the start', async () => {
      await makePo();
      expect(rawExtra('PO-WHO').logSealed).toBe(true);
      await call('U-L3', 'PUT', '/api/pos/PO-WHO', { history: [{ action: 'first', user: 'Forged' }], claimHistory: [{ round: 1, resolvedBy: 'Forged' }] });
      const po = await getPo();
      expect(po.history[0].user).toBe('Plant Manager');
      expect(po.claimHistory[0].resolvedBy).toBe('Plant Manager');
      expect(rawExtra('PO-WHO').logSealed).toBe(true);
    });

    it('an unchanged entry that gains resolvedBy / reportedBy from the client is stamped from the token, not stripped', async () => {
      await makePo();
      await call('U-L3', 'PUT', '/api/pos/PO-WHO', { storeClaims: { shopA: { status: 'OPEN', type: 'REFUND' } }, claimData: { reason: 'r' } });
      let po = await getPo();
      expect(po.storeClaims.shopA.resolvedBy).toBeUndefined();
      await call('U-L1', 'PUT', '/api/pos/PO-WHO', { storeClaims: { shopA: { status: 'OPEN', type: 'REFUND', resolvedBy: 'Forged', resolvedAt: 'fake' } }, claimData: { reason: 'r', reportedBy: 'Forged' } });
      po = await getPo();
      expect(po.storeClaims.shopA).toMatchObject({ status: 'OPEN', resolvedBy: 'Pim Requester' });
      expect(po.storeClaims.shopA.resolvedAt).not.toBe('fake');
      expect(po.claimData.reportedBy).toBe('Pim Requester');
    });

    it('receivedBy in grnHistory / activityLog keeps the old "name (position)" look ; plain name when the user has no position', async () => {
      sdb.prepare("UPDATE users SET title='Warehouse Supervisor' WHERE id='U-L1'").run();
      sdb.prepare("INSERT INTO products (id, code, name, category, department, currentStock, isDeleted) VALUES ('P-RB', 'RB-1', 'rb item', 'PD', 'PD', 1, 0)").run();
      await call('U-L1', 'POST', '/api/prs', newPr({ items: [{ id: 'i1', productId: 'P-RB', code: 'RB-1', name: 'rb item', qty: 2, price: 617 }] }));
      sdb.prepare("UPDATE prs SET status='APPROVED' WHERE id='PR-EX-1'").run();
      await call('U-L3', 'POST', '/api/pos', { id: 'PO-RB', poNo: `PO-PD-${YEAR}-071`, prId: 'PR-EX-1', prNo: `PD001/${YEAR}`, department: 'PD', status: 'ISSUED', totalAmount: 1, grandTotal: 1, items: [{ id: 'i1', productId: 'P-RB', code: 'RB-1', name: 'rb item', qty: 2 }] });
      await call('U-L1', 'PUT', '/api/pos/PO-RB', {
        status: 'PARTIAL', grnHistory: [{ grnNumber: 'GRN-RB-1', receivedBy: 'Forged (Boss)' }], activityLog: [{ action: 'รับของ', receivedBy: 'Forged (Boss)' }]
      });
      let po = await getPo('PO-RB');
      expect(po.grnHistory[0].receivedBy).toBe('Pim Requester (Warehouse Supervisor)');
      expect(po.activityLog[0].receivedBy).toBe('Pim Requester (Warehouse Supervisor)');
      expect(po.receivedBy).toBe('Pim Requester'); // the document-level receiver stays the plain name
      // the server receive endpoint writes the same look
      const r = await call('U-L1', 'POST', '/api/pos/PO-RB/receive', { receivingItems: [{ productId: 'P-RB', goodQty: 2 }], note: 'รับครบ', grNumber: 'GRN-RB-2' });
      expect(r.status).toBe(200);
      po = await getPo('PO-RB');
      expect(po.grnHistory.at(-1)).toMatchObject({ grnNumber: 'GRN-RB-2', receivedBy: 'Pim Requester (Warehouse Supervisor)' });
      expect(po.logSealed).toBeUndefined();
      // no position -> name only
      sdb.prepare("UPDATE users SET title=NULL, position=NULL WHERE id='U-L3'").run();
      await call('U-L3', 'PUT', '/api/pos/PO-RB', { grnHistory: [...po.grnHistory, { grnNumber: 'GRN-RB-3', receivedBy: 'Forged (Boss)' }] });
      expect((await getPo('PO-RB')).grnHistory.at(-1).receivedBy).toBe('Plant Manager');
    });
  });
});
