// @vitest-environment node
// Smoke-test bugs G / F, CLIENT side (cloudflare mode) : apiService.receiveStock -> the real Cloudflare function ; storageService must neither
// invent a second stock row for a received PO (the old "heal", with its hard-coded 16) nor reset the VAT / grandTotal of a PO.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import './setup.js';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { onRequest } from '../functions/api/[[route]].js';
import { signToken } from '../functions/_lib/auth.js';
import { apiService } from '../src/services/apiService';
import { storageService } from '../src/services/storageService';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = fs.readdirSync(path.join(here, '..', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
const SECRET = 'unit-test-secret-0123456789abcdef';
const WH = { id: 'U-WH', username: 'wh', name: 'Warehouse', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 };

let DatabaseSync = null;
try { DatabaseSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync; } catch { DatabaseSync = null; }

function makeD1(sdb) {
  const norm = (a) => a.map((v) => (v === undefined ? null : v));
  const mk = (q, p) => ({
    run: async () => { sdb.prepare(q).run(...norm(p)); return { success: true }; },
    first: async () => { const r = sdb.prepare(q).get(...norm(p)); return r ? { ...r } : null; },
    all: async () => ({ results: sdb.prepare(q).all(...norm(p)).map((r) => ({ ...r })) })
  });
  return {
    prepare: (q) => ({ bind: (...p) => mk(q, p), ...mk(q, []) }),
    batch: async (stmts) => { sdb.exec('BEGIN'); try { const out = []; for (const s of stmts) out.push(await s.all()); sdb.exec('COMMIT'); return out; } catch (e) { try { sdb.exec('ROLLBACK'); } catch { /* done */ } throw e; } }
  };
}

const receivedPo = () => ({
  id: 'PO-G1', poNo: 'PO-PD-2026-001', poNumber: 'PO-PD-2026-001', department: 'PD', status: 'COMPLETED',
  subtotal: 500, vat: 35, totalAmount: 500, vatAmount: 35, grandTotal: 535,
  items: [{ productId: 'P1', code: 'C1', name: 'Item', qty: 5, receivedQty: 5, goodQty: 5, price: 100 }],
  grnHistory: [{ grnNumber: 'GRN-PO-PD-2026-001-01', items: [] }]
});

describe.skipIf(!DatabaseSync)('GRN client flow (cloudflare)', () => {
  let sdb; let env; let token;

  beforeEach(async () => {
    storageService.resetData();
    storageService.savePOs([receivedPo()]);
    sdb = new DatabaseSync(':memory:');
    for (const f of MIGRATIONS) sdb.exec(fs.readFileSync(path.join(here, '..', 'migrations', f), 'utf8'));
    sdb.prepare("INSERT INTO users (id, username, password, name, department, allowedDepartments, roleId, canonicalRole, level, status) VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE')")
      .run(WH.id, WH.username, '', WH.name, WH.department, '["PD"]', WH.roleId, WH.canonicalRole, WH.level);
    sdb.prepare("INSERT INTO products (id, code, name, category, department, purchaseUnit, usageUnit, conversionRate, currentStock, avgCost, isDeleted) VALUES ('P1','C1','Item','PD','PD','pcs','pcs',1,10,0,0)").run();
    sdb.prepare("INSERT INTO pos (id, poNumber, prNumber, department, status, itemsJson, totalAmount, vatAmount, grandTotal, extraJson) VALUES ('PO-G1','PO-PD-2026-001','PD001/2026','PD','ORDERED',?,500,35,535,'{}')")
      .run(JSON.stringify([{ productId: 'P1', code: 'C1', name: 'Item', qty: 5, price: 100 }]));
    storageService.saveProducts([{ id: 'P1', code: 'C1', name: 'Item', department: 'PD', category: 'PD', stockBalance: 10, currentStock: 10, avgCost: 0 }]);
    env = { DB: makeD1(sdb), AUTH_TOKEN_SECRET: SECRET };
    token = await signToken({ sub: WH.id, userId: WH.id, role: WH.roleId, level: WH.level }, SECRET);
    localStorage.setItem('prpo_auth_session', JSON.stringify({ id: WH.id, token }));
    global.fetch = async (url, init) => {
      const res = await onRequest({ request: new Request(`https://prpo.pages.dev${url}`, init), env });
      const text = await res.text();
      return new Response(text, { status: res.status, headers: res.headers });
    };
  });

  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  // what ReceivingModal's PO save puts on the server before the stock call : the GRN entry + the received qty of the line
  const savePoOnServer = () => sdb.prepare("UPDATE pos SET itemsJson = ?, extraJson = ? WHERE id = 'PO-G1'")
    .run(JSON.stringify([{ productId: 'P1', code: 'C1', name: 'Item', qty: 5, price: 100, receivedQty: 5, goodQty: 5 }]), JSON.stringify({ grnHistory: [{ grnNumber: 'GRN-PO-PD-2026-001-01' }] }));

  it('G: a stock call whose PO is not saved yet is kept as pending and replayed with the same GRN number after the PO is saved', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    const items = [{ productId: 'P1', code: 'C1', goodQty: 5, defectiveQty: 0 }];
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error('network down'); };
    await expect(apiService.receiveStock('PO-G1', 'GRN-PO-PD-2026-001-01', items)).rejects.toThrow();
    global.fetch = realFetch;
    expect(JSON.parse(localStorage.getItem('prpo_pending_receive_stock'))).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('prpo_pending_receive_stock'))[0].userId).toBe('U-WH');
    expect(sdb.prepare('SELECT currentStock FROM products WHERE id = ?').get('P1').currentStock).toBe(10);
    // another user's entry stays untouched
    localStorage.setItem('prpo_pending_receive_stock', JSON.stringify([...JSON.parse(localStorage.getItem('prpo_pending_receive_stock')), { poId: 'PO-G1', grNumber: 'GRN-OTHER-01', receivingItems: [], userId: 'U-OTHER' }]));
    savePoOnServer();
    await apiService.flushPendingReceiveStock();
    expect(JSON.parse(localStorage.getItem('prpo_pending_receive_stock')).map((a) => a.userId)).toEqual(['U-OTHER']);
    localStorage.setItem('prpo_pending_receive_stock', '[]');
    sdb.prepare('UPDATE products SET currentStock = 10, avgCost = 0').run();
    sdb.prepare('DELETE FROM stock_logs').run();
    localStorage.setItem('prpo_pending_receive_stock', JSON.stringify([{ poId: 'PO-G1', grNumber: 'GRN-PO-PD-2026-001-01', receivingItems: items, userId: 'U-WH' }]));
    await apiService.flushPendingReceiveStock();
    expect(JSON.parse(localStorage.getItem('prpo_pending_receive_stock'))).toHaveLength(0);
    expect(sdb.prepare('SELECT currentStock FROM products WHERE id = ?').get('P1').currentStock).toBe(15);
    await apiService.flushPendingReceiveStock();
    expect(sdb.prepare('SELECT currentStock FROM products WHERE id = ?').get('P1').currentStock).toBe(15);
  });

  it('G: replay keeps the entry on 401 / 408 / 429 / 5xx / 403 and drops it only on 400 / 409 (told to the user)', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    const entry = { poId: 'PO-G1', grNumber: 'GRN-PO-PD-2026-001-01', receivingItems: [], userId: 'U-WH' };
    const realFetch = global.fetch;
    for (const code of [401, 403, 408, 429, 503]) {
      localStorage.setItem('prpo_pending_receive_stock', JSON.stringify([entry]));
      global.fetch = async () => new Response('{}', { status: code });
      await apiService.flushPendingReceiveStock();
      expect(JSON.parse(localStorage.getItem('prpo_pending_receive_stock'))).toHaveLength(1);
    }
    for (const code of [400, 409]) {
      localStorage.setItem('prpo_pending_receive_stock', JSON.stringify([entry]));
      global.fetch = async () => new Response('{}', { status: code });
      await apiService.flushPendingReceiveStock();
      expect(JSON.parse(localStorage.getItem('prpo_pending_receive_stock'))).toHaveLength(0);
    }
    global.fetch = realFetch;
  });

  it('G: receiveStock -> server stock 15 / MAC (GAS) / ONE log ; the local copies take the server rows ; pressing it twice changes nothing', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    savePoOnServer();
    const items = [{ productId: 'P1', code: 'C1', goodQty: 5, defectiveQty: 0 }];
    await apiService.receiveStock('PO-G1', 'GRN-PO-PD-2026-001-01', items);
    await apiService.receiveStock('PO-G1', 'GRN-PO-PD-2026-001-01', items);
    expect(sdb.prepare('SELECT currentStock, avgCost FROM products WHERE id = ?').get('P1')).toMatchObject({ currentStock: 15, avgCost: 33.33 });
    expect(sdb.prepare("SELECT COUNT(*) AS n FROM stock_logs WHERE type = 'IN'").get().n).toBe(1);
    const local = storageService.getProducts().find((p) => p.id === 'P1');
    expect(local).toMatchObject({ currentStock: 15, avgCost: 33.33 });
    const localLogs = storageService.getStockLogs().filter((l) => l.productId === 'P1');
    expect(localLogs).toHaveLength(1); // no healed second row for the COMPLETED PO, no balance 21 (5 + 16)
    expect(localLogs[0]).toMatchObject({ balance: 15 });
  });

  it('G: cloudflare getStockLogs does not invent rows from received POs (mock mode keeps its legacy heal)', () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    storageService.saveStockLogs([]);
    expect(storageService.getStockLogs().filter((l) => l.docType === 'GRN')).toHaveLength(0);
  });

  it('F: cloudflare getPOs keeps the VAT and grandTotal of a PO after goods receipt (535 stays 535)', () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    const po = storageService.getPOs().find((p) => p.id === 'PO-G1');
    expect(po).toMatchObject({ vat: 35, grandTotal: 535, totalAmount: 500, vatAmount: 35, status: 'COMPLETED' });
  });
});
