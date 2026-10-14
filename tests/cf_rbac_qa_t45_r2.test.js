// @vitest-environment node
// QA (prae) T4.5 round 2: normal client flows must not be 403. Tests under "BUG" are expected to FAIL until fixed.
import { describe, it, expect } from 'vitest';
import { canTransitionPR, canTransitionPO } from '../functions/_lib/rbac.js';

const L2 = { id: 'U-L2', username: 'asst.am', department: 'PD', roleId: 'ASST_MANAGER', level: 2 };
const L3 = { id: 'U-L3', username: 'plant.mgr', department: 'PD', roleId: 'PLANT_MANAGER', level: 3 };
const ONLINE = { id: 'U-ON', username: 'nat.on', department: 'PUR', roleId: 'ONLINE_PURCHASER', level: 2 };

describe('T4.5 r2 - flows that must pass', () => {
  it('L2 review / reject SUBMITTED', () => {
    expect(canTransitionPR(L2, 'SUBMITTED', 'REVIEWED')).toBe(true);
    expect(canTransitionPR(L2, 'SUBMITTED', 'REJECTED_TO_DRAFT')).toBe(true);
    expect(canTransitionPR(L2, 'REJECTED_TO_L2', 'REVIEWED')).toBe(true);
  });
  it('L3 approve REVIEWED -> PO_ISSUED / IN_PROGRESS_ONLINE', () => {
    expect(canTransitionPR(L3, 'REVIEWED', 'PO_ISSUED')).toBe(true);
    expect(canTransitionPR(L3, 'REVIEWED', 'IN_PROGRESS_ONLINE')).toBe(true);
  });
  it('online purchaser: IN_PROGRESS_ONLINE -> ORDERED_PENDING_DELIVERY / CLOSED', () => {
    expect(canTransitionPO(ONLINE, 'IN_PROGRESS_ONLINE', 'ORDERED_PENDING_DELIVERY')).toBe(true);
    expect(canTransitionPO(ONLINE, 'ORDERED_PENDING_DELIVERY', 'CLOSED')).toBe(true);
  });
});

describe('T4.5 r2 - BUGS (expected to fail now)', () => {
  it('BUG-A: workflowEngine.rejectPR always sets REJECTED_TO_DRAFT, so L3 reject of a REVIEWED PR must be allowed', () => {
    expect(canTransitionPR(L3, 'REVIEWED', 'REJECTED_TO_DRAFT')).toBe(true);
  });
  it('BUG-B: workflowEngine.resolveClaim (OnlineOrderCard, online purchaser) sets PO COMPLETED, must not be 403', () => {
    expect(canTransitionPO(ONLINE, 'CLAIM_REPORTED', 'COMPLETED')).toBe(true);
    expect(canTransitionPO(ONLINE, 'CLAIM_PENDING', 'COMPLETED')).toBe(true);
  });
});
