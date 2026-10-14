// @vitest-environment jsdom
// S3 : GRN round 2 of a replacement claim (4 ordered, 2 good + 2 NG in round 1, replacement delivered) must close the PO (COMPLETED),
// not ask for a claim resolution again / stay PARTIALLY_RECEIVED_IN_CLAIM.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../src/services/modalService', async (orig) => {
  const mod = await orig();
  return { ...mod, modalService: { ...mod.modalService, confirm: vi.fn(async () => true), success: vi.fn(), warning: vi.fn(), error: vi.fn() } };
});

import { readFileSync } from 'node:fs';
import { getShortPOStatus } from '../src/views/POListView';
import ReceivingModal from '../src/views/inventory/ReceivingModal';
import { storageService } from '../src/services/storageService';
import { PO_STATUS, PR_STATUS } from '../src/config/constants';

const mkPo = (over = {}) => ({
  id: 'PO-S3-1', poNo: 'PO-S3-1', poNumber: 'PO-S3-1', department: 'PD', status: 'WAITING_DELIVERY_ROUND_2', purchaseChannel: 'SELF',
  claimStatus: 'REPLACEMENT_PENDING',
  grnHistory: [{ grnNumber: 'GRN-PO-S3-1-01', round: 1 }],
  items: [{
    productId: 'P-S3', code: 'S3', name: 'Glue', orderedQty: 4, quantity: 4, receivedQty: 2, goodQty: 2, accumulatedReceived: 2, damagedQty: 2,
    // remainingQty is what the PO creation wrote (the full ordered qty) : nothing updates it per round in the modal flow
    remainingQty: 4, claimResolution: 'REPLACEMENT', replacementPendingQty: 2, purchaseUnit: 'ชิ้น', unitPrice: 10
  }],
  ...over
});

describe('S3 receiving round 2 after a replacement claim', () => {
  beforeEach(() => { localStorage.clear(); storageService.resetData(); });
  afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('round 2 form does not ask for a claim resolution and saves COMPLETED', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    const po = mkPo();
    storageService.savePOs([po]);
    const puts = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
      if (init.method === 'PUT' && String(url).startsWith('/api/pos/')) puts.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ success: true, products: [], stockLogs: [] }), { status: 200 });
    }));
    render(<ReceivingModal po={po} isOpen={true} onClose={vi.fn()} currentUser={{ id: 'u1', name: 'Req', roleId: 'REQUESTER_PD', department: 'PD' }} />);
    expect(screen.queryByText(/Inline Claim Resolution/)).toBeNull();
    fireEvent.click(screen.getByText('ยืนยันรับเข้าคลังสมบูรณ์ (ปิดงาน PO)'));
    await waitFor(() => expect(puts.length).toBeGreaterThan(0));
    const saved = puts[puts.length - 1];
    expect(saved.status).toBe('COMPLETED');
    expect(saved.hasUnresolvedClaim).toBe(false);
    expect(saved.items[0].receivedQty).toBe(4);
    expect(saved.items[0].remainingQty).toBe(0);
  });

  it('split shipment (stale remainingQty = ordered) : round 2 is not a claim either', () => {
    const po = mkPo({ status: 'PARTIAL', claimStatus: undefined, items: [{ ...mkPo().items[0], damagedQty: 0, claimResolution: undefined, replacementPendingQty: 0 }] });
    render(<ReceivingModal po={po} isOpen={true} />);
    expect(screen.queryByText(/Inline Claim Resolution/)).toBeNull();
  });

  it('PO list shows the PO_STATUS labels for the statuses that had no short label (no raw ids)', () => {
    const r2 = getShortPOStatus('WAITING_DELIVERY_ROUND_2');
    const claim = getShortPOStatus('PARTIALLY_RECEIVED_IN_CLAIM');
    expect(r2.label).toBe(PO_STATUS.WAITING_DELIVERY_ROUND_2.label);
    expect(claim.label).toBe(PO_STATUS.PARTIALLY_RECEIVED_IN_CLAIM.label);
    expect(r2.label).not.toMatch(/[A-Z_]{8,}/);
    expect(getShortPOStatus('PARTIAL').label).toBe('รับบางส่วน'); // existing short labels unchanged
    expect(getShortPOStatus('SOMETHING_UNKNOWN').label).toBe('SOMETHING_UNKNOWN'); // nothing in the system for it -> unchanged
  });

  it('PR edit form header shows the PR_STATUS label of REJECTED_TO_DRAFT', () => {
    expect(PR_STATUS.REJECTED_TO_DRAFT.label).toBe('ถูกส่งกลับให้แก้ไข (ร่าง)');
    const src = readFileSync(`${process.cwd()}/src/views/PRCreateView.jsx`, 'utf8');
    expect(src).toContain('{PR_STATUS[editingPR.status]?.label || editingPR.status}');
  });
});
