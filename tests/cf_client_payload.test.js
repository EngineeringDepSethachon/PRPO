// @vitest-environment jsdom
// T2.1e : REAL client payloads (workflowEngine.createPOFromPR output, PR review/approve with signatures) go through the Functions router
// with the write-side sanitizer on : nothing a normal flow sends may be answered 400/413 ; unsupported values are cut, never fatal.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

vi.mock('../src/services/modalService', () => ({ modalService: { alert: vi.fn(), error: vi.fn(), warning: vi.fn(), success: vi.fn(), confirm: vi.fn() } }));

import { workflowEngine } from '../src/services/workflowEngine.js';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { checkUserSignature } from '../functions/_lib/sanitize.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readRel = (...p) => fs.readFileSync(path.join(here, '..', ...p), 'utf8');
const MIGRATIONS = ['0001_init.sql', '0002_missing_tables.sql', '0003_users_password_hash.sql', '0004_parity_columns.sql', '0005_budget_columns.sql', '0006_import_parity_columns.sql', '0007_attachments_upload.sql', '0008_ws3_hardening.sql', '0009_upload_attempts.sql', '0010_token_version.sql', '0013_attachments_storage.sql'];
const SECRET = 'unit-test-secret-0123456789abcdef';

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }
function makeD1(sdb) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { sdb.prepare(q).run(...norm(p)); return { success: true }; },
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) })
  });
  return { prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }), batch: async (s) => { const o = []; for (const x of s) o.push(await x.all()); return o; } };
}

const FID = 'QUOTEFILEID1234567890';
const DRIVE_VIEW = `https://drive.google.com/file/d/${FID}/view`;
const SVG = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const BMP = 'data:image/bmp;base64,Qk0=';
const BIG_PNG = 'data:image/png;base64,' + 'A'.repeat(450000);

describe.skipIf(!DatabaseSync)('real client payloads vs the sanitizing router', () => {
  let sdb; let env; let tok;
  const rows = (q, ...p) => sdb.prepare(q).all(...p).map((r) => ({ ...r }));
  const call = async (method, p, body) => {
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  beforeEach(async () => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 }))); // storageService background syncs : nothing to reach
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(readRel('migrations', f));
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES ('U-AD','admin','','Admin','ALL','[\"*\"]','ADMIN','ADMIN',99,'ACTIVE')").run();
    sdb.prepare("INSERT INTO attachments (id, fileId, uploaderId, category, docRef) VALUES ('ATT-1', ?, 'U-AD', 'PR', '')").run(FID);
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    tok = await signToken({ sub: 'U-AD', userId: 'U-AD', role: 'ADMIN', level: 99 }, SECRET);
  });

  const clientPr = () => ({
    id: 'PR-T1', prNo: 'PD001/2099', prNumber: 'PD001/2099', department: 'PD', status: 'SUBMITTED', purchaseChannel: 'SELF',
    vendorId: 'V1', vendorName: 'ร้าน A', vendor: { id: 'V1', name: 'ร้าน A' },
    specUrl: 'quote.pdf', totalAmount: 100, reason: 'ทดสอบ',
    quotationFiles: [{ id: 'ATT-1', fileId: FID, name: 'quote.pdf', fileName: 'quote.pdf', mimeType: 'application/pdf', url: DRIVE_VIEW, previewUrl: DRIVE_VIEW, viewUrl: DRIVE_VIEW, category: 'QUOTATION' }],
    attachments: [{ id: 'ATT-1', fileId: FID, name: 'quote.pdf', url: DRIVE_VIEW, previewUrl: DRIVE_VIEW, category: 'QUOTATION' }],
    images: [{ name: 'p.jpg', url: PNG, previewUrl: PNG }],
    items: [
      { productId: 'ITM-001', code: 'ITM-001', name: 'ถุงมือ', purchaseQty: 2, price: 50, unit: 'กล่อง' }, // no images -> engine adds its SVG seed images
      { productId: 'X-2', code: 'X-2', name: 'อื่น ๆ', purchaseQty: 1, price: 0, productUrl: 'Shopee: ร้าน A', images: [{ name: 'p.png', url: PNG, previewUrl: PNG }] }
    ]
  });

  it('createPOFromPR output (svg seed images, prAttachments, signatures) is accepted by POST /api/prs + /api/pos', async () => {
    const pr = clientPr();
    // PR written the way the client does: submit -> review (reviewer signature) -> approve (approver signature) ; unsupported signatures included
    expect((await call('POST', '/api/prs', pr)).status).toBe(200);
    const reviewed = { ...pr, status: 'REVIEWED', reviewedBy: { id: 'U1', name: 'ผู้ตรวจ', signature: SVG, timestamp: new Date().toISOString() }, reviewerName: 'ผู้ตรวจ', reviewerSignature: SVG, requesterSignature: BMP };
    expect((await call('PUT', '/api/prs/PR-T1', reviewed)).status).toBe(200);
    const approved = { ...reviewed, status: 'APPROVED', approvedBy: { id: 'U2', name: 'ผู้อนุมัติ', signature: BIG_PNG, timestamp: new Date().toISOString() }, approverName: 'ผู้อนุมัติ', approverSignature: BIG_PNG };
    const put = await call('PUT', '/api/prs/PR-T1', approved);
    expect(put.status).toBe(200);
    const stored = rows('SELECT * FROM prs WHERE id = ?', 'PR-T1')[0];
    expect(stored.status).toBe('APPROVED');
    expect(stored.itemsJson).not.toContain('image/svg');
    expect(stored.attachmentsJson).toContain(DRIVE_VIEW); // the real quotation survived

    // the PO exactly as the engine builds it (runs the real src/services/workflowEngine.js)
    const user = { id: 'U2', name: 'ผู้อนุมัติ', roleId: 'PLANT_MANAGER', signature: SVG };
    const out = await workflowEngine.createPOFromPR({ ...approved, status: 'APPROVED' }, user);
    const po = Array.isArray(out) ? out[0] : out;
    expect(po).toBeTruthy();
    const seeded = JSON.stringify(po.items);
    expect(seeded).toContain('image/svg+xml'); // proves the payload really carries the engine's SVG seed images
    expect(Array.isArray(po.prAttachments) && po.prAttachments.length).toBeGreaterThan(0);

    const post = await call('POST', '/api/pos', po);
    expect(post.status).toBe(200);
    const sp = rows('SELECT * FROM pos')[0];
    expect(sp.itemsJson).not.toContain('data:image/svg'); // the seed picture data is not stored (the name / type labels remain)
    expect(JSON.stringify(sp)).not.toContain('data:image/svg');
    // the Shopee free text stays as typed ; a real data image is untouched
    expect(JSON.parse(sp.itemsJson)[1].productUrl).toBe('Shopee: ร้าน A');
    expect(JSON.parse(sp.itemsJson)[1].images[0].url).toBe(PNG);
  });

  it('signature values the server cannot store are cut (svg / bmp / too large / foreign url) and never fail review or approve', async () => {
    const pr = clientPr();
    expect((await call('POST', '/api/prs', pr)).status).toBe(200);
    for (const bad of [SVG, BMP, BIG_PNG, 'https://evil.example/s.png', 'javascript:alert(1)']) {
      const r = await call('PUT', '/api/prs/PR-T1', { ...pr, status: 'REVIEWED', reviewedBy: { name: 'x', signature: bad }, reviewerSignature: bad, requesterSignature: bad });
      expect(r.status).toBe(200);
    }
    const ok = await call('PUT', '/api/prs/PR-T1', { ...pr, status: 'REVIEWED', reviewedBy: { name: 'x', signature: PNG }, reviewerSignature: PNG });
    expect(ok.status).toBe(200);
  });

  it('users: e-signature must be a PNG/JPEG/WebP data URL (<= 400k) or a Drive URL, else 400 with a Thai message ; unchanged old value is not re-checked', async () => {
    const base = { name: 'สมหญิง', username: 'somying', password: 'Passw0rd!x', department: 'PD', roleId: 'REQUESTER_PD', level: 1, allowedDepartments: ['PD'] };
    for (const bad of [SVG, BMP, BIG_PNG, 'https://evil.example/s.png', 'not an image']) {
      const r = await call('POST', '/api/users', { ...base, signature: bad });
      expect(r.status).toBe(400);
      expect(r.json.error).toContain('ลายเซ็น');
    }
    expect(rows("SELECT * FROM users WHERE username = 'somying'")).toHaveLength(0);
    const created = await call('POST', '/api/users', { ...base, signature: PNG });
    expect(created.status).toBe(200);
    expect(rows("SELECT signature FROM users WHERE username = 'somying'")[0].signature).toBe(PNG);
    // legacy value already stored (e.g. gif) : editing other fields keeps working
    sdb.prepare("UPDATE users SET signature = ? WHERE username = 'somying'").run('data:image/gif;base64,R0lGODlhAQABAAAAACw=');
    const edit = await call('PUT', '/api/users/somying', { ...base, name: 'สมหญิง ใจดี', signature: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' });
    expect(edit.status).toBe(200);
    expect(checkUserSignature('')).toBe('');
    expect(checkUserSignature(`https://drive.google.com/file/d/${FID}/view`)).toBe('');
  });
});
