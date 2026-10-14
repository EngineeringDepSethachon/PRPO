// @vitest-environment node
// kla T2.1c finding : file/link fields of PR / PO / receive / settle bodies are sanitized on write ; JSON write size caps
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { sanitizeWriteBody, checkFileUrl, checkStoreLink, checkUserSignature, MAX_DEPTH } from '../functions/_lib/sanitize.js';
import { hasOversizedDataUrl } from '../functions/_lib/upload.js';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';

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

const ID = 'FILEID1234567890abcdEF';
const DRIVE = [
  `https://drive.google.com/file/d/${ID}/view`,
  `https://drive.google.com/uc?export=download&id=${ID}`,
  `https://drive.google.com/thumbnail?id=${ID}&sz=w1200`,
  `https://lh3.googleusercontent.com/d/${ID}`,
  `https://docs.google.com/document/d/${ID}/edit`
];

describe('checkFileUrl / checkStoreLink', () => {
  it('accepts every legacy GAS URL shape, data images, bare ids and the old placeholders', () => {
    for (const u of DRIVE) expect(checkFileUrl(u)).toBe(u);
    expect(checkFileUrl('data:image/jpeg;base64,/9j/AAAA')).toBe('data:image/jpeg;base64,/9j/AAAA');
    expect(checkFileUrl('data:application/pdf;base64,JVBERi0=')).toContain('application/pdf');
    expect(checkFileUrl(ID)).toBe(ID);
    expect(checkFileUrl('STORED_IN_DRIVE')).toBe('STORED_IN_DRIVE');
    expect(checkFileUrl('')).toBe('');
  });
  it('cuts everything else, refuses dangerous schemes, rejects oversized data', () => {
    expect(checkFileUrl('https://evil.example/x.png')).toBe('');
    expect(checkFileUrl('http://drive.google.com/file/d/abc')).toBe('');
    expect(checkFileUrl('https://drive.google.com.evil.example/x')).toBe('');
    expect(checkFileUrl('blob:http://localhost/abc')).toBe('');
    expect(checkFileUrl('/uploads/a.png')).toBe('');
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'vbscript:x', 'file:///etc/passwd', 'data:text/html;base64,PGI+']) {
      expect(() => checkFileUrl(bad)).toThrow();
    }
    // svg / bmp data are simply not stored (the client's own demo images are SVG data URLs : must not fail the request)
    expect(checkFileUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe('');
    expect(checkFileUrl('data:image/bmp;base64,Qk0=')).toBe('');
    expect(checkFileUrl('data:image/svg+xml;base64,' + 'A'.repeat(500000))).toBe('');
    expect(() => checkFileUrl('data:image/png;base64,' + 'A'.repeat(400001))).toThrow();
  });
  it('store links : http(s) or scheme-less ; other schemes refused', () => {
    expect(checkStoreLink('https://shopee.co.th/p/1')).toBe('https://shopee.co.th/p/1');
    expect(checkStoreLink('shopee.co.th/p/1')).toBe('shopee.co.th/p/1');
    expect(checkStoreLink('shopee.co.th:8080/x')).toBe('shopee.co.th:8080/x');
    for (const bad of ['javascript:alert(1)', ' VBScript:x', 'data:text/html,x', 'file:///c:/x']) expect(() => checkStoreLink(bad)).toThrow();
  });
  it('store links : odd but harmless legacy values never 400 - URL extracted from text, other schemes cut silently', () => {
    expect(checkStoreLink('Shopee: https://shopee.co.th/p/9?x=1 (ราคาดี)')).toBe('https://shopee.co.th/p/9?x=1');
    expect(checkStoreLink('mailto:a@b.c')).toBe('');
    expect(checkStoreLink('line://ti/p/xyz')).toBe('');
    expect(checkStoreLink('ftp://x/y')).toBe('');
    expect(checkStoreLink('data:image/png;base64,AAAA')).toBe('');
    expect(checkStoreLink('quote-001.pdf')).toBe('quote-001.pdf'); // specUrl holds a file name
    // free text with an unknown "word:" prefix stays exactly as typed
    expect(checkStoreLink('Shopee: ร้าน A')).toBe('Shopee: ร้าน A');
    expect(checkStoreLink('Lazada:ร้านB ลดราคา')).toBe('Lazada:ร้านB ลดราคา');
  });
});

describe('sanitizeWriteBody (pure walk)', () => {
  it('attachment arrays : keeps Drive / data:image, drops others, strips blob:, fixes nested items', async () => {
    const body = {
      department: 'PD',
      attachments: [{ name: 'a.pdf', url: DRIVE[0], previewUrl: 'blob:http://x/1', viewUrl: 'https://evil.example/a' }, `https://evil.example/z`, DRIVE[2]],
      quotationFiles: [{ url: 'data:image/png;base64,AAAA', previewUrl: 'data:image/png;base64,AAAA' }],
      items: [{ name: 'glove', productUrl: 'https://shopee.co.th/p', url: 'https://shopee.co.th/p2', images: [{ url: DRIVE[3], previewUrl: 'ftp://x' }], attachments: ['STORED_IN_DRIVE', 'http://evil'] }],
      settlementProofUrl: 'https://evil.example/slip.png',
      claimPhoto: DRIVE[3],
      note: 'ดู https://evil.example/ ได้'
    };
    expect(await sanitizeWriteBody(null, body)).toBeNull();
    expect(body.attachments).toEqual([{ name: 'a.pdf', url: DRIVE[0], previewUrl: '', viewUrl: '' }, DRIVE[2]]);
    expect(body.quotationFiles[0].url).toContain('data:image/png');
    expect(body.items[0].productUrl).toBe('https://shopee.co.th/p');
    expect(body.items[0].url).toBe('https://shopee.co.th/p2'); // store link outside attachments
    expect(body.items[0].images[0]).toEqual({ url: DRIVE[3], previewUrl: '' });
    expect(body.items[0].attachments).toEqual(['STORED_IN_DRIVE']);
    expect(body.settlementProofUrl).toBe('');
    expect(body.claimPhoto).toBe(DRIVE[3]);
    expect(body.note).toContain('evil.example'); // free text untouched
  });
  it('dangerous schemes -> 400 ; oversized data -> 413 ; too deep -> 400', async () => {
    expect((await sanitizeWriteBody(null, { attachments: [{ url: 'javascript:alert(1)' }] })).status).toBe(400);
    expect((await sanitizeWriteBody(null, { items: [{ productUrl: 'javascript:alert(1)' }] })).status).toBe(400);
    const svgBody = { attachments: ['data:image/svg+xml;base64,PHN2Zz4=', DRIVE[0]] };
    expect(await sanitizeWriteBody(null, svgBody)).toBeNull(); // not fatal : the svg element is dropped
    expect(svgBody.attachments).toEqual([DRIVE[0]]);
    expect((await sanitizeWriteBody(null, { images: [{ previewUrl: 'data:image/png;base64,' + 'A'.repeat(400001) }] })).status).toBe(413);
    let deep = {}; const root = deep;
    for (let i = 0; i < MAX_DEPTH + 3; i++) { deep.n = {}; deep = deep.n; }
    expect((await sanitizeWriteBody(null, root)).status).toBe(400);
    expect(hasOversizedDataUrl(root)).toBe(true);
    expect(hasOversizedDataUrl({ a: '   data:image/png;base64,' + 'A'.repeat(400010) })).toBe(true); // leading blanks do not hide it
  });
});

describe.skipIf(!DatabaseSync)('fileId check + route level', () => {
  let sdb; let env; let tok;
  const rows = (q, ...p) => sdb.prepare(q).all(...p).map((r) => ({ ...r }));
  const call = async (method, p, body, headers = {}) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const res = await onRequest({ request: new Request(`https://prpo.pages.dev${p}`, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...headers }, body: text }), env });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  beforeEach(async () => {
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(readRel('migrations', f));
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES ('U-AD','admin','','Admin','ALL','[\"*\"]','ADMIN','ADMIN',99,'ACTIVE')").run();
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    tok = await signToken({ sub: 'U-AD', userId: 'U-AD', role: 'ADMIN', level: 99 }, SECRET);
  });

  it('fileId is scoped to the caller : own upload / document of a reachable department / stored on such a document (incl. pos.extraJson) ; never cross-department', async () => {
    const PD_USER = { userId: 'U-PD', department: 'PD', allowedDepartments: '["PD"]', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 };
    const mk = (id) => ({ attachments: [{ fileId: id, name: 'x.pdf', url: `https://drive.google.com/file/d/${id}/view`, previewUrl: `https://drive.google.com/file/d/${id}/view` }] });
    const run = async (id, user = PD_USER) => { const b = mk(id); await sanitizeWriteBody(env.DB, b, user); return b.attachments[0]; };
    sdb.prepare("INSERT INTO pos (id, poNumber, department, status, itemsJson) VALUES ('po-pd','PO-PD-1','PD','ORDERED','[]'), ('po-qc','PO-QC-1','QC','ORDERED','[]')").run();
    const att = sdb.prepare('INSERT INTO attachments (id, fileId, docRef, poNumber, docNo, uploaderId) VALUES (?,?,?,?,?,?)');

    expect(await run('UNKNOWNFILEID1234567890')).toMatchObject({ fileId: '', url: '', previewUrl: '', name: 'x.pdf' });
    // the client also keeps the Drive id in `id` (sanitizeAttachment : id = f.id || f.fileId) : checked the same way
    const idOnly = { attachments: [{ id: 'UNKNOWNIDONLY1234567890123', name: 'y.pdf', url: 'https://drive.google.com/file/d/UNKNOWNIDONLY1234567890123/view' }] };
    await sanitizeWriteBody(env.DB, idOnly, PD_USER);
    expect(idOnly.attachments[0]).toMatchObject({ id: '', url: '', name: 'y.pdf' });
    const attId = { attachments: [{ id: 'ATT-1a2b3c4d', fileId: '', name: 'z.pdf', url: 'https://example.invalid/not-drive' }] };
    await sanitizeWriteBody(env.DB, attId, PD_USER);
    expect(attId.attachments[0].id).toBe('ATT-1a2b3c4d'); // internal ATT- ids are not Drive ids : never cleared

    att.run('A0', 'MINEFILEID123456789012', '', '', '', 'U-PD'); // a file this user uploaded through /api/upload
    // the id inside a Drive URL is checked like fileId (no fileId / id on the object, or a plain URL string in the array)
    const urlOnly = { attachments: [{ name: 'u.pdf', url: `https://drive.google.com/file/d/URLONLYUNKNOWN1234567890/view`, previewUrl: 'https://drive.google.com/thumbnail?id=URLONLYUNKNOWN1234567890&sz=w1200' }, `https://lh3.googleusercontent.com/d/STRINGUNKNOWN123456789012`, `https://drive.google.com/uc?export=download&id=MINEFILEID123456789012`] };
    await sanitizeWriteBody(env.DB, urlOnly, PD_USER);
    expect(urlOnly.attachments[0]).toMatchObject({ name: 'u.pdf', url: '', previewUrl: '' });
    expect(urlOnly.attachments).toHaveLength(2); // the unknown string was removed
    expect(urlOnly.attachments[1]).toContain('MINEFILEID123456789012'); // uploaded by U-PD : stays (this is what /api/upload returns to the client)
    // every URL shape /api/upload hands out passes for its uploader
    const shapes = { attachments: [{ fileId: 'MINEFILEID123456789012', url: `https://drive.google.com/file/d/MINEFILEID123456789012/view`, previewUrl: 'https://drive.google.com/thumbnail?id=MINEFILEID123456789012&sz=w1200', lh3Url: 'https://lh3.googleusercontent.com/d/MINEFILEID123456789012', downloadUrl: 'https://drive.google.com/uc?export=download&id=MINEFILEID123456789012' }] };
    await sanitizeWriteBody(env.DB, shapes, PD_USER);
    expect(Object.values(shapes.attachments[0]).filter((x) => x === '')).toHaveLength(0);
    // imported PR line items (pr_items) count as "already stored"
    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson) VALUES ('PX','PD777/2026','PD','DRAFT','[]')").run();
    sdb.prepare("INSERT INTO pr_items (id, prId, images) VALUES ('I1','PX', ?)").run(JSON.stringify(['https://drive.google.com/file/d/PRITEMIMAGE123456789012/view']));
    const prItem = await run('PRITEMIMAGE123456789012');
    expect(prItem.url).toContain('PRITEMIMAGE123456789012');

    // database error -> nothing can be verified -> the request is refused with 503 (P6 : a link that may be legitimate is never cut silently,
    // nothing is trusted, nothing is written, not a 500) and the body is left as it came
    const broken = { prepare: () => { throw new Error('D1 down'); } };
    const b2 = mk('MINEFILEID123456789012');
    expect(await sanitizeWriteBody(broken, b2, PD_USER)).toMatchObject({ status: 503 });
    expect(b2.attachments[0].fileId).toBe('MINEFILEID123456789012');

    att.run('A1', 'MINEFILEID123456789012', '', '', '', 'U-PD');          // uploaded by the caller (PR attachment before the PR exists)
    expect((await run('MINEFILEID123456789012')).url).toContain('MINEFILEID123456789012');
    expect((await run('MINEFILEID123456789012', { ...PD_USER, userId: 'U-OTHER' })).url).toBe(''); // someone else's, no document

    att.run('A2', 'PDDOCFILEID1234567890', 'PO-PD-1', 'PO-PD-1', 'PO-PD-1', 'U-X'); // attached to a PD PO
    expect((await run('PDDOCFILEID1234567890')).url).toContain('PDDOCFILEID1234567890');
    att.run('A3', 'QCDOCFILEID1234567890', 'PO-QC-1', 'PO-QC-1', 'PO-QC-1', 'U-Y'); // attached to a QC PO : not reachable for PD
    expect((await run('QCDOCFILEID1234567890')).url).toBe('');
    expect((await run('QCDOCFILEID1234567890', { userId: 'U-AD', department: 'ALL', allowedDepartments: '["*"]', roleId: 'ADMIN', level: 99 })).url).toContain('QCDOCFILEID');
    att.run('A4', 'LEGACYATTID123456789', '', 'PO-PD-1', 'PO-PD-1', null);          // imported legacy row : found through poNumber / docNo
    expect((await run('LEGACYATTID123456789')).url).toContain('LEGACYATTID');

    sdb.prepare("INSERT INTO prs (id, prNumber, department, status, itemsJson, attachmentsJson) VALUES ('P1','PD001/2026','PD','SUBMITTED','[]', ?)").run(JSON.stringify(mk('LEGACYFILEID123456789')));
    expect((await run('LEGACYFILEID123456789')).url).toContain('LEGACYFILEID123456789');
    sdb.prepare("UPDATE pos SET extraJson = ? WHERE id = 'po-pd'").run(JSON.stringify({ x: mk('EXTRAJSONFILE12345678') }));
    expect((await run('EXTRAJSONFILE12345678')).url).toContain('EXTRAJSONFILE');
    sdb.prepare("UPDATE pos SET extraJson = ? WHERE id = 'po-qc'").run(JSON.stringify({ x: mk('QCEXTRAFILEID12345678') }));
    expect((await run('QCEXTRAFILEID12345678')).url).toBe('');
  });

  it('key groups (docs/parity.md) : photo / grAttachments / specUrl / quotationUrl / signature', async () => {
    const body = {
      photo: { previewUrl: 'https://evil.example/p.png', dataUrl: DRIVE[3] },
      claimEvidence: { evidenceAttachments: [DRIVE[0], 'https://evil.example/e.png'] },
      grAttachments: [{ url: DRIVE[1], previewUrl: 'ftp://x' }, 'https://evil.example/g.png', DRIVE[2]],
      prAttachments: [DRIVE[0], 'https://evil.example/x', { url: DRIVE[1], previewUrl: 'https://evil.example/y' }],
      specUrl: 'Shopee: https://shopee.co.th/p/1', quotationUrl: 'line://ti/p/x',
      reviewerSignature: 'data:image/png;base64,AAAA', approverSignature: 'https://evil.example/s.png', receiverSignature: 'สมชาย ใจดี',
      approvalWorkflow: { reviewedBy: { name: 'A', signature: 'javascript:alert(1)' } }
    };
    expect(await sanitizeWriteBody(null, body)).toBeNull(); // javascript: in a signature is cut, never fatal
    expect(body.approvalWorkflow.reviewedBy.signature).toBe('');
    body.approvalWorkflow.reviewedBy.signature = 'data:image/png;base64,BBBB';
    body.requesterSignature = 'data:image/bmp;base64,Qk0=';
    expect(await sanitizeWriteBody(null, body)).toBeNull();
    expect(body.requesterSignature).toBe('');
    expect(body.prAttachments).toEqual([DRIVE[0], { url: DRIVE[1], previewUrl: '' }]);
    expect(body.photo).toEqual({ previewUrl: '', dataUrl: DRIVE[3] });
    expect(body.claimEvidence.evidenceAttachments).toEqual([DRIVE[0]]);
    expect(body.grAttachments).toEqual([{ url: DRIVE[1], previewUrl: '' }, DRIVE[2]]);
    expect(body.specUrl).toBe('https://shopee.co.th/p/1');
    expect(body.quotationUrl).toBe('');
    expect(body.reviewerSignature).toContain('data:image/png');
    expect(body.approverSignature).toBe('');
    expect(body.receiverSignature).toBe('สมชาย ใจดี');
    const s = { photo: 'https://evil.example/p.png' };
    await sanitizeWriteBody(null, s);
    expect(s.photo).toBe('');
  });

  it('too deep -> 400 with its own message (not the 413 big-image one) ; big image -> 413 ; chunked body (no Content-Length) is capped while reading', async () => {
    let deep = {}; const root = deep;
    for (let i = 0; i < 15; i++) { deep.n = {}; deep = deep.n; }
    const d = await call('POST', '/api/prs', { department: 'PD', ...root, x: root });
    expect(d.status).toBe(400);
    expect(d.json.error).toBe('โครงสร้างข้อมูลซ้อนลึกเกินไป');
    const big = await call('POST', '/api/prs', { department: 'PD', items: [{ images: [{ url: 'data:image/jpeg;base64,' + 'A'.repeat(400001) }] }] });
    expect(big.status).toBe(413);
    expect(big.json.error).toContain('รูปภาพ');

    // no Content-Length : a streamed body larger than the cap is cut off
    const enc = new TextEncoder();
    let sent = 0;
    const stream = new ReadableStream({
      pull(ctl) { if (sent > 5 * 1024 * 1024) { ctl.close(); return; } sent += 512 * 1024; ctl.enqueue(enc.encode(' '.repeat(512 * 1024))); }
    });
    const res = await onRequest({ request: new Request('https://prpo.pages.dev/api/vendors', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: stream, duplex: 'half' }), env });
    expect(res.status).toBe(413);
    expect(sent).toBeLessThanOrEqual(3 * 1024 * 1024); // stopped reading right after the 2 MB cap
    // empty / non-numeric Content-Length is treated like a missing one : still streamed with the cap
    for (const weird of ['', 'abc', '12abc']) {
      let n = 0;
      const s2 = new ReadableStream({ pull(ctl) { if (n > 5 * 1024 * 1024) { ctl.close(); return; } n += 512 * 1024; ctl.enqueue(enc.encode(' '.repeat(512 * 1024))); } });
      const r2 = await onRequest({ request: new Request('https://prpo.pages.dev/api/vendors', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', 'Content-Length': weird }, body: s2, duplex: 'half' }), env });
      expect(r2.status).toBe(413);
      expect(n).toBeLessThanOrEqual(3 * 1024 * 1024);
    }
    // small body without Content-Length still works as before
    expect((await call('POST', '/api/prs', { department: 'PD', items: [] })).status).toBe(200);
  });

  it('JSON text where a list belongs is parsed and checked like the real thing ; unparsable -> empty ; depth keeps counting', async () => {
    const body = {
      attachments: JSON.stringify([{ url: DRIVE[0], previewUrl: 'https://evil.example/a.png' }, 'https://evil.example/b.png', DRIVE[2]]),
      images: '{not json',
      items: JSON.stringify([{ name: 'x', productUrl: 'https://shopee.co.th/p', images: [{ url: 'ftp://x/y', previewUrl: DRIVE[3] }] }]),
      evidence: JSON.stringify({ attachments: ['https://evil.example/e.png', DRIVE[1]] }),
      claimEvidence: 'broken ]'
    };
    expect(await sanitizeWriteBody(null, body)).toBeNull();
    expect(body.attachments).toEqual([{ url: DRIVE[0], previewUrl: '' }, DRIVE[2]]);
    expect(body.images).toEqual([]);
    expect(body.items).toEqual([{ name: 'x', productUrl: 'https://shopee.co.th/p', images: [{ url: '', previewUrl: DRIVE[3] }] }]);
    expect(body.evidence).toEqual({ attachments: [DRIVE[1]] });
    expect(body.claimEvidence).toBe('broken ]'); // plain text under an object key is left alone
    // a dangerous link hidden inside the JSON text is still refused
    expect((await sanitizeWriteBody(null, { items: '[{"productUrl":"javascript:alert(1)"}]' })).status).toBe(400);
    // nesting hidden in text counts toward the depth limit
    let nest = '"x"'; for (let i = 0; i < 20; i++) nest = `{"n":${nest}}`;
    expect((await sanitizeWriteBody(null, { items: `[${nest}]` })).status).toBe(400);
    // a single file URL given as text under a file-list key
    const single = { attachments: DRIVE[0], photos: 'https://evil.example/p.png' };
    await sanitizeWriteBody(null, single);
    expect(single).toEqual({ attachments: DRIVE[0], photos: '' });
  });

  it('scheme checks ignore leading control chars and embedded tab / CR / LF', async () => {
    for (const evil of ['\u0001javascript:alert(1)', 'java\tscript:alert(1)', ' \n JavaScript:alert(1)', 'vb\r\nscript:x', '\u0000\u0008file:///etc/passwd', 'data:text/ht\nml,<b>']) {
      expect(() => checkStoreLink(evil), JSON.stringify(evil)).toThrow();
      expect(() => checkFileUrl(evil), JSON.stringify(evil)).toThrow();
    }
    const sig = { reviewerSignature: '\u0001javascript:alert(1)', approverSignature: 'java\nscript:x', receiverSignature: ' ' + 'data:image/png;base64,iVBORw0KGgo=' };
    expect(await sanitizeWriteBody(null, sig)).toBeNull();
    expect(sig.reviewerSignature).toBe('');
    expect(sig.approverSignature).toBe('');
    expect(sig.receiverSignature).toContain('data:image/png');
    expect(checkUserSignature('\u0001data:image/png;base64,iVBORw0KGgo=')).toBe('');
    expect(checkUserSignature('java\tscript:alert(1)')).not.toBe('');
  });

  it('users : pictureUrl goes through the file-URL rule ; /api/signatures uses the e-signature rule', async () => {
    const base = { name: 'สมชาย', username: 'somchai', password: 'Passw0rd!x', department: 'PD', roleId: 'REQUESTER_PD', level: 1, allowedDepartments: ['PD'] };
    expect((await call('POST', '/api/users', { ...base, pictureUrl: 'javascript:alert(1)' })).status).toBe(400);
    const ok = await call('POST', '/api/users', { ...base, pictureUrl: 'https://evil.example/me.png' });
    expect(ok.status).toBe(200);
    expect(rows("SELECT pictureUrl FROM users WHERE username = 'somchai'")[0].pictureUrl || '').toBe(''); // foreign host: stored empty, not an error
    const drive = 'https://drive.google.com/file/d/AVATARFILEID1234567890/view';
    expect((await call('PUT', '/api/users/somchai', { ...base, pictureUrl: drive })).status).toBe(200);
    expect(rows("SELECT pictureUrl FROM users WHERE username = 'somchai'")[0].pictureUrl).toBe(drive);
    expect((await call('PUT', '/api/signatures/APPROVER', { signatureUrl: 'https://evil.example/s.png' })).status).toBe(400);
    expect((await call('PUT', '/api/signatures/APPROVER', { signatureUrl: 'data:image/png;base64,iVBORw0KGgo=' })).status).toBe(200);
  });

  it('the byte-capped stream is read only AFTER authentication (login excepted)', async () => {
    const enc = new TextEncoder();
    const mkStream = (counter) => new ReadableStream({ pull(ctl) { if (counter.n > 6 * 1024 * 1024) { ctl.close(); return; } counter.n += 512 * 1024; ctl.enqueue(enc.encode(' '.repeat(512 * 1024))); } });
    const anon = { n: 0 };
    const r1 = await onRequest({ request: new Request('https://prpo.pages.dev/api/vendors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: mkStream(anon), duplex: 'half' }), env });
    expect(r1.status).toBe(401);
    expect(anon.n).toBeLessThanOrEqual(1024 * 1024); // not consumed for an unauthenticated caller
    const login = { n: 0 };
    const r2 = await onRequest({ request: new Request('https://prpo.pages.dev/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: mkStream(login), duplex: 'half' }), env });
    expect(r2.status).toBe(413); // login has no token yet : capped right away
    expect(login.n).toBeLessThanOrEqual(3 * 1024 * 1024);
    const authed = { n: 0 };
    const r3 = await onRequest({ request: new Request('https://prpo.pages.dev/api/vendors', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: mkStream(authed), duplex: 'half' }), env });
    expect(r3.status).toBe(413);
    expect(authed.n).toBeLessThanOrEqual(3 * 1024 * 1024);
  });

  it('POST /api/prs stores cleaned fields ; javascript: link -> 400 ; body > 4 MB -> 413 ; other JSON write > 2 MB -> 413', async () => {
    sdb.prepare("INSERT INTO attachments (id, fileId, uploaderId) VALUES ('ATT-D', ?, 'U-AD')").run(ID); // the Drive file the test PR points at was uploaded through the system
    const ok = await call('POST', '/api/prs', { department: 'PD', items: [{ name: 'x', productUrl: 'https://shopee.co.th/p', images: [{ url: 'https://evil.example/a.png', previewUrl: DRIVE[2] }] }] });
    expect(ok.status).toBe(200);
    const stored = JSON.parse(rows('SELECT itemsJson FROM prs')[0].itemsJson);
    expect(stored[0].images[0]).toEqual({ url: '', previewUrl: DRIVE[2] });
    expect(stored[0].productUrl).toBe('https://shopee.co.th/p');

    const bad = await call('POST', '/api/prs', { department: 'PD', items: [{ name: 'x', productUrl: 'javascript:alert(1)' }] });
    expect(bad.status).toBe(400);
    expect(rows('SELECT * FROM prs')).toHaveLength(1);

    expect((await call('POST', '/api/prs', { department: 'PD' }, { 'Content-Length': String(4 * 1024 * 1024 + 1) })).status).toBe(413);
    expect((await call('POST', '/api/vendors', { name: 'v' }, { 'Content-Length': String(2 * 1024 * 1024 + 1) })).status).toBe(413);
    expect((await call('POST', '/api/prs', { department: 'PD', items: [] }, { 'Content-Length': String(3 * 1024 * 1024) })).status).not.toBe(413); // 3 MB is fine for documents
  });
});
