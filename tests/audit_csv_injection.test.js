// @vitest-environment jsdom
// exportAuditLogsToCSV : cells starting with = + - @ TAB CR are prefixed with ' (formula injection hardening)
import { describe, it, expect, vi, afterEach } from 'vitest';
import { exportAuditLogsToCSV } from '../src/services/auditLogger.js';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('auditLogger CSV export', () => {
  it('neutralises formula cells, leaves normal text untouched', () => {
    let csv = '';
    vi.stubGlobal('Blob', class { constructor(parts) { csv = parts.join(''); } });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    exportAuditLogsToCSV([
      { id: '=1+1', module: '+SUM(A1)', action: '-2', targetRef: '@cmd', actor: { name: '\tx', role: '\rx', department: 'PD' }, summary: 'ปกติ "quote"', changes: [] },
      { id: 'AUD-2', module: 'PURCHASE', action: 'A', targetRef: 'PD001/2026', actor: { name: 'a-b', role: 'r', department: 'd' }, summary: 'x=y', changes: [] }
    ]);
    const lines = csv.replace('﻿', '').split('\r\n');
    const cells = lines[1].split(',');
    expect(cells[0]).toBe('"\'=1+1"');
    expect(cells[3]).toBe('"\'+SUM(A1)"');
    expect(cells[4]).toBe('"\'-2"');
    expect(cells[5]).toBe('"\'@cmd"');
    expect(csv).toContain('"\'\tx"');
    expect(csv).toContain('"\'\rx"'.replace('\r', '\r'));
    expect(csv).toContain('"ปกติ ""quote"""');
    expect(lines.at(-1)).toContain('"AUD-2","');
    expect(lines.at(-1)).toContain('"a-b"');
    expect(lines.at(-1)).toContain('"x=y"');
  });
});
