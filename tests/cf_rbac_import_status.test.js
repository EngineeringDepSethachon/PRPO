// @vitest-environment node
// T4.5e: the sheet importer maps PR statuses the server RBAC does not know to the known set (and reports how many).
import { describe, it, expect } from 'vitest';
import { mapPrStatus, runImport } from '../scripts/import-sheets-to-d1.js';
import { PR_KNOWN_STATUSES, canTransitionPR } from '../functions/_lib/rbac.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('importer PR status mapping', () => {
  it('known statuses are untouched', () => {
    for (const s of PR_KNOWN_STATUSES) expect(mapPrStatus(s)).toEqual({ status: s, mapped: false });
  });

  it('odd values map into the known set', () => {
    const cases = {
      submitted: 'SUBMITTED', Approved: 'APPROVED', 'Waiting Approval': 'REVIEWED', pending: 'SUBMITTED', rejected: 'REJECTED_TO_DRAFT', Cancelled: 'CANCELLED',
      'PO ISSUED': 'PO_ISSUED', Closed: 'CLOSED', 'อนุมัติแล้ว': 'APPROVED', 'ยกเลิก': 'CANCELLED', 'ร่าง': 'DRAFT', 'whatever-123': 'DRAFT', '': 'DRAFT'
    };
    for (const [raw, want] of Object.entries(cases)) {
      const r = mapPrStatus(raw);
      expect(r.status, raw).toBe(want);
      expect(r.mapped, raw).toBe(true);
      expect(PR_KNOWN_STATUSES).toContain(r.status);
    }
  });

  it('every mapped status is movable by the right role (not stuck)', () => {
    const L2 = { level: 2, roleId: 'ASST_MANAGER', department: 'PD' };
    const L3 = { level: 3, roleId: 'PLANT_MANAGER', department: 'MGT' };
    for (const raw of ['pending', 'รอตรวจทาน', 'Waiting Review']) {
      const { status } = mapPrStatus(raw);
      expect(canTransitionPR(L2, status, 'REVIEWED'), raw).toBe(true);
    }
    expect(canTransitionPR(L3, mapPrStatus('Waiting Approval').status, 'PO_ISSUED')).toBe(true);
    expect(canTransitionPR({ level: 1, roleId: 'REQUESTER_PD' }, mapPrStatus('rejected').status, 'SUBMITTED')).toBe(true);
  });

  it('runImport keeps the original in extraJson and reports the mapped count', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prpo-imp-'));
    const file = path.join(dir, 'PRs.json');
    try {
      fs.writeFileSync(file, JSON.stringify([
        { id: 'A', prNo: 'PD001/2026', department: 'PD', status: 'SUBMITTED', totalAmount: 1 },
        { id: 'B', prNo: 'PD002/2026', department: 'PD', status: 'Waiting Approval', totalAmount: 2 },
        { id: 'C', prNo: 'PD003/2026', department: 'PD', status: 'weird', totalAmount: 3 }
      ]));
      const res = await runImport({ inDir: dir, only: ['PRs'] });
      const rep = res.report.find((r) => r.sheet === 'PRs');
      expect(rep.written).toBe(3);
      expect(rep.warnings).toBe(2);
      expect(Object.keys(rep.reasons).some((k) => k.includes('Waiting Approval') && k.includes('REVIEWED'))).toBe(true);
      expect(res.sql).toContain('"originalStatus":"weird"');
    } finally {
      // only the one file this test wrote, then the (now empty) temp dir - no recursive delete
      fs.unlinkSync(file);
      fs.rmdirSync(dir);
    }
  });
});
