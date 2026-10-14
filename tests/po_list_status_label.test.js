import { describe, it, expect } from 'vitest';
import { getShortPOStatus } from '../src/views/POListView.jsx';
import { getCompletedPOStatus } from '../src/utils/poCompletedStatus.js';
import { PO_STATUS } from '../src/config/constants.js';
import { formatIsoForDisplay } from '../src/utils/timeUtils.js';

describe('formatIsoForDisplay', () => {
  it('ISO-Z -> YYYY-MM-DD HH:mm:ss Thai time', () => {
    expect(formatIsoForDisplay('2026-10-13T01:00:00.000Z')).toBe('2026-10-13 08:00:00');
  });
  it('non-ISO / empty values are returned unchanged', () => {
    expect(formatIsoForDisplay('13/10/2569 14:03:00')).toBe('13/10/2569 14:03:00');
    expect(formatIsoForDisplay('2026-10-13 08:00:00')).toBe('2026-10-13 08:00:00');
    expect(formatIsoForDisplay(undefined)).toBeUndefined();
    expect(formatIsoForDisplay('')).toBe('');
  });
});

describe('POListView getShortPOStatus', () => {
  it('shows COMPLETED (after full receive) with the same label as CLOSED, not the raw code', () => {
    expect(getShortPOStatus('COMPLETED').label).toBe(getShortPOStatus('CLOSED').label);
    expect(getShortPOStatus('COMPLETED').label).not.toBe('COMPLETED');
  });
  it('keeps COMPLETED_WITH_REFUND as before (unchanged behaviour)', () => {
    expect(getShortPOStatus('COMPLETED_WITH_REFUND').label).toBe('COMPLETED_WITH_REFUND');
  });
  it('shared helper: only COMPLETED, and PO_STATUS has no COMPLETED / still owns COMPLETED_WITH_REFUND', () => {
    expect(getCompletedPOStatus('COMPLETED')).toEqual(getShortPOStatus('COMPLETED'));
    expect(getCompletedPOStatus('COMPLETED_WITH_REFUND')).toBeNull();
    expect(getCompletedPOStatus('CLOSED')).toBeNull();
    expect(PO_STATUS.COMPLETED).toBeUndefined();
    expect(PO_STATUS.COMPLETED_WITH_REFUND.label).toBe('เสร็จสิ้น (คืนเงิน)');
  });
  it('keeps existing labels', () => {
    expect(getShortPOStatus('ISSUED').label).toBe('รอรับของ');
    expect(getShortPOStatus('RECEIVED').label).toBe('ตรวจรับแล้ว');
    expect(getShortPOStatus('XYZ').label).toBe('XYZ');
  });
});
