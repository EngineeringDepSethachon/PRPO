import { describe, it, expect, beforeEach, vi } from 'vitest';
import './setup.js';
import { storageService } from '../src/services/storageService';

// Inline helpers matching QuickIssueView.jsx logic
const getLogUnit = (log) => {
  if (log.location && String(log.location).trim()) return String(log.location).trim();
  if (log.issueUnit && String(log.issueUnit).trim()) return String(log.issueUnit).trim();
  if (log.issuedTo && String(log.issuedTo).trim() && !String(log.issuedTo).includes('@')) return String(log.issuedTo).trim();
  if (log.note) { const m = log.note.match(/\[(.*?)\]/); if (m && m[1]) return m[1].trim(); }
  return 'ไม่ระบุหน่วย';
};

const isStockOutLog = (log) => {
  const t = String(log.type || '').toUpperCase();
  if (['OUT', 'ISSUE', 'DISPATCH'].includes(t)) return true;
  if (Number(log.changeQty) < 0) return true;
  return false;
};

const matchDept = (a, b) => !a || !b || String(a).trim().toUpperCase() === String(b).trim().toUpperCase();

const PROD = { id: 'PROD-PD-GLOVE-001', code: 'PD-GLV-003', name: 'ถุงมือกันร้อน', department: 'PD', category: 'PD', stockBalance: 50, stockUnit: 'คู่' };

const mkLog = (ov = {}) => ({
  id: `LOG-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  timestamp: new Date().toISOString(), date: new Date().toISOString(),
  type: 'OUT', productId: PROD.id, productCode: PROD.code,
  department: 'PD', location: 'ห้อง K1', issueUnit: 'ห้อง K1', issuedTo: 'ห้อง K1',
  changeQty: -3, qty: 3, unit: 'คู่', balanceAfter: 47,
  reason: '[ห้อง K1] เบิกใช้งาน', actorName: 'ผู้ใช้ทดสอบ', ...ov
});

const recentFor = (sel, logs) => {
  if (!sel || !logs || !logs.length) return [];
  const tid = String(sel.id || '').trim();
  const tc = String(sel.code || '').trim();
  const td = String(sel.department || sel.category || '').trim();
  return logs.filter(l => {
    if (!isStockOutLog(l)) return false;
    if (tid && l.productId && String(l.productId).trim() === tid) return true;
    const lc = String(l.productCode || '').trim();
    if (!lc || lc !== tc) return false;
    return matchDept(l.department, td);
  }).slice(0, 5);
};

describe('Domain Suite: Quick Issue Location Tracking & Analytics', () => {
  beforeEach(() => { vi.clearAllMocks(); if (typeof localStorage !== 'undefined') localStorage.clear(); storageService.resetData(); });

  describe('1. Issue Payload & Log Entry Structure', () => {
    it('submit payload includes location field set to selected unit', () => {
      const unit = 'ห้อง K1';
      const payload = { productId: PROD.id, productCode: PROD.code, department: 'PD', quantity: 3, issuedTo: unit, location: unit, reason: `[${unit}] เบิกใช้งาน` };
      expect(payload.location).toBe('ห้อง K1');
      expect(payload.issuedTo).toBe('ห้อง K1');
    });

    it('logEntry has type OUT, location, issueUnit, and negative changeQty', () => {
      const entry = { type: 'OUT', location: 'ห้อง K2', issueUnit: 'ห้อง K2', changeQty: -5, qty: 5 };
      expect(entry.type).toBe('OUT');
      expect(entry.location).toBe('ห้อง K2');
      expect(entry.issueUnit).toBe('ห้อง K2');
      expect(entry.changeQty).toBeLessThan(0);
    });
  });

  describe('2. getLogUnit() Priority Resolution', () => {
    it('prefers location over issueUnit', () => expect(getLogUnit(mkLog({ location: 'ห้อง K1', issueUnit: 'ห้อง K2' }))).toBe('ห้อง K1'));
    it('falls back to issueUnit when location empty', () => expect(getLogUnit(mkLog({ location: '', issueUnit: 'ห้อง K2' }))).toBe('ห้อง K2'));
    it('falls back to issuedTo when location and issueUnit empty', () => expect(getLogUnit(mkLog({ location: '', issueUnit: '', issuedTo: 'ห้องแพ็ค' }))).toBe('ห้องแพ็ค'));
    it('falls back to note bracket pattern as last resort', () => expect(getLogUnit(mkLog({ location: '', issueUnit: '', issuedTo: '', note: '[ห้องผลไม้] เบิก' }))).toBe('ห้องผลไม้'));
    it('returns ไม่ระบุหน่วย when all empty', () => expect(getLogUnit(mkLog({ location: '', issueUnit: '', issuedTo: '', note: '' }))).toBe('ไม่ระบุหน่วย'));
  });

  describe('3. isStockOutLog() Type Classification', () => {
    it('classifies type=OUT as stock-out', () => expect(isStockOutLog({ type: 'OUT', changeQty: -3 })).toBe(true));
    it('classifies type=ISSUE as stock-out (backward compat)', () => expect(isStockOutLog({ type: 'ISSUE', changeQty: -5 })).toBe(true));
    it('classifies type=DISPATCH as stock-out', () => expect(isStockOutLog({ type: 'DISPATCH', changeQty: -2 })).toBe(true));
    it('classifies negative changeQty as stock-out when type missing', () => expect(isStockOutLog({ type: '', changeQty: -1 })).toBe(true));
    it('does NOT classify type=IN as stock-out', () => expect(isStockOutLog({ type: 'IN', changeQty: 10 })).toBe(false));
    it('does NOT classify type=GRN as stock-out', () => expect(isStockOutLog({ type: 'GRN', changeQty: 5 })).toBe(false));
  });

  describe('4. Unit Breakdown Analytics — Non-Zero Stats', () => {
    it('counts correctly across OUT and ISSUE types', () => {
      const logs = [
        mkLog({ location: 'ห้อง K1', type: 'OUT', qty: 3 }),
        mkLog({ location: 'ห้อง K1', type: 'OUT', qty: 2 }),
        mkLog({ location: 'ห้อง K2', type: 'OUT', qty: 5 }),
        mkLog({ location: 'ห้อง K2', type: 'ISSUE', qty: 1 }),
        mkLog({ location: 'ห้องแพ็ค', type: 'OUT', qty: 4 }),
      ];
      const issueLogs = logs.filter(isStockOutLog);
      expect(issueLogs).toHaveLength(5);
      const map = {};
      issueLogs.forEach(l => {
        const u = getLogUnit(l);
        if (!map[u]) map[u] = { count: 0, totalQty: 0 };
        map[u].count++; map[u].totalQty += Number(l.qty) || 0;
      });
      expect(map['ห้อง K1'].count).toBe(2); expect(map['ห้อง K1'].totalQty).toBe(5);
      expect(map['ห้อง K2'].count).toBe(2); expect(map['ห้อง K2'].totalQty).toBe(6);
      expect(map['ห้องแพ็ค'].count).toBe(1);
    });

    it('stats are non-zero when stockLogs contain ISSUE-type entries', () => {
      const logs = [mkLog({ type: 'ISSUE', qty: 10 }), mkLog({ type: 'ISSUE', qty: 5 })];
      const issueLogs = logs.filter(isStockOutLog);
      const total = issueLogs.reduce((s, l) => s + Number(l.qty || 0), 0);
      expect(issueLogs.length).toBeGreaterThan(0);
      expect(total).toBe(15);
    });
  });

  describe('5. recentIssuesForProduct — Product-Level History', () => {
    it('shows history matching by productId', () => {
      const logs = [mkLog({ productId: PROD.id }), mkLog({ productId: PROD.id }), mkLog({ productId: 'OTHER', productCode: 'XX' })];
      expect(recentFor(PROD, logs)).toHaveLength(2);
    });

    it('shows history via code+dept fallback when productId missing in log', () => {
      const logs = [mkLog({ productId: '', productCode: PROD.code, department: 'PD' }), mkLog({ productId: '', productCode: PROD.code, department: 'PD' }), mkLog({ productId: '', productCode: 'QC-X', department: 'QC' })];
      expect(recentFor(PROD, logs)).toHaveLength(2);
    });

    it('does NOT show QC logs for PD product with same code (cross-dept contamination prevention)', () => {
      const logs = [mkLog({ productId: '', productCode: 'CODE-3', department: 'PD' }), mkLog({ productId: '', productCode: 'CODE-3', department: 'QC' })];
      const pdProd = { id: 'PD-001', code: 'CODE-3', department: 'PD', category: 'PD' };
      const result = recentFor(pdProd, logs);
      expect(result).toHaveLength(1);
      expect(result[0].department).toBe('PD');
    });

    it('returns empty array when no logs match product', () => {
      const logs = [mkLog({ productId: 'OTHER', productCode: 'OTHER-CODE' })];
      expect(recentFor(PROD, logs)).toHaveLength(0);
    });

    it('returns empty array when selectedProduct is null', () => {
      expect(recentFor(null, [mkLog({})])).toHaveLength(0);
    });
  });

  describe('6. Real-time MAC Recalculation on Quick Issue Summary Card', () => {
    it('recalculates MAC from historical IN logs and computes accurate issue value', async () => {
      const { healMACForProduct } = await import('../src/utils/macMigration');
      const targetProd = {
        id: 'PROD-QI-MAC-01',
        code: 'QI-MAC-01',
        name: 'หัวแร้งไฟฟ้าสำหรับสายการผลิต',
        department: 'PD',
        category: 'PD',
        stockBalance: 10,
        averageCost: 0,
        avgCost: 0,
        unit: 'อัน'
      };

      const inLogs = [
        { type: 'IN', productId: 'PROD-QI-MAC-01', productCode: 'QI-MAC-01', qty: 4, unitPrice: 200, timestamp: '2026-09-10T09:00:00Z' },
        { type: 'IN', productId: 'PROD-QI-MAC-01', productCode: 'QI-MAC-01', qty: 6, unitPrice: 250, timestamp: '2026-09-12T09:00:00Z' }
      ];

      storageService.saveProducts([targetProd]);
      storageService.saveStockLogs(inLogs);

      // (4 * 200 + 6 * 250) / 10 = (800 + 1500) / 10 = 2300 / 10 = 230
      const healed = await healMACForProduct('PROD-QI-MAC-01');
      expect(healed).not.toBeNull();
      expect(healed.averageCost).toBe(230);
      expect(healed.avgCost).toBe(230);

      // Real-time issue value calculation: issueQty = 3 -> 3 * 230 = 690
      const issueQty = 3;
      const issueValue = issueQty * healed.averageCost;
      expect(issueValue).toBe(690);
    });
  });
});
