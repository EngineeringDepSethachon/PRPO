// QA round 5 : every PO status transition the web client really performs (workflowEngine / ReceivingModal / PODetailsModal /
// OnlineOrderCard / apiService PUT /api/pos/:id) must pass canTransitionPO ; the "step back" moves must stay refused.
// Pure rule test (no DB) : the route calls exactly this function with the stored status and the body status.
import { describe, it, expect } from 'vitest';
import { canTransitionPO, normalizePoStatus, PO_CLIENT_STATUSES } from '../functions/_lib/rbac.js';

const P = {
  L1: { id: 'U-L1', username: 'req.pd', name: 'Req', department: 'PD', roleId: 'REQUESTER_PD', canonicalRole: 'REQUESTER', level: 1 },
  L2: { id: 'U-L2', username: 'asst.am', name: 'Asst', department: 'PD', roleId: 'ASST_MANAGER', canonicalRole: 'REVIEWER', level: 2 },
  L3: { id: 'U-L3', username: 'plant.pm', name: 'Plant', department: 'MGT', allowedDepartments: '["*"]', roleId: 'PLANT_MANAGER', canonicalRole: 'APPROVER', level: 3 },
  ONLINE: { id: 'U-ON', username: 'nat.on', name: 'Nat', department: 'PUR', roleId: 'ONLINE_PURCHASER', canonicalRole: 'PURCHASER', level: 2 },
  ADMIN: { id: 'U-AD', username: 'admin', name: 'Admin', department: 'ALL', allowedDepartments: '["*"]', roleId: 'ADMIN', canonicalRole: 'ADMIN', level: 99 }
};
const ALL = ['L1', 'L2', 'L3', 'ONLINE', 'ADMIN'];
const NOT_ONLINE = ['L1', 'L2', 'L3', 'ADMIN'];
const ONLINE_ONLY = ['ONLINE', 'ADMIN'];
// closing / completing a PO with an open claim (decision 2026-10-14) : approver, admin, online purchaser (online claims) - and the
// requester who owns the PR, which the route passes as ctx.isOwner (tested in its own block below ; without ctx L1 / L2 are refused)
const CLAIM_CLOSE = ['L3', 'ONLINE', 'ADMIN'];

// [from, to, who may do it, where the client does it]
const CLIENT_MOVES = [
  // createPOFromPR (workflowEngine ~1895) -> POST /api/pos
  [undefined, 'ISSUED', ALL, 'createPOFromPR self-buy'],
  [undefined, 'IN_PROGRESS_ONLINE', ALL, 'createPOFromPR online'],
  // PODetailsModal "mark ordered" (updatePOStatus)
  ['ISSUED', 'IN_DELIVERY', ALL, 'PODetailsModal.jsx:1713 self-buy'],
  ['ISSUED', 'ORDERED_PENDING_DELIVERY', ALL, 'PODetailsModal.jsx:1713 online channel'],
  ['IN_PROGRESS_ONLINE', 'ORDERED_PENDING_DELIVERY', ONLINE_ONLY, 'PODetailsModal.jsx:1713 online channel'],
  ['IN_PROGRESS_ONLINE', 'IN_DELIVERY', ONLINE_ONLY, 'PODetailsModal.jsx:1713'],
  // online purchaser acknowledgeOnlineTask (workflowEngine:534 -> PUT)
  ['IN_PROGRESS_ONLINE', 'ORDERED', ONLINE_ONLY, 'workflowEngine.js:534 / OnlineOrderCard.jsx:1406'],
  ['ORDERED', 'ORDERED', ALL, 'OnlineOrderCard re-save'],
  ['ORDERED', 'IN_DELIVERY', ALL, 'updatePOStatus IN_DELIVERY'],
  ['ORDERED_PENDING_DELIVERY', 'IN_DELIVERY', ALL, 'updatePOStatus IN_DELIVERY'],
  // ReceivingModal.jsx 955-1131 / AppContext.jsx 917-933
  ['ORDERED', 'COMPLETED', ALL, 'ReceivingModal.jsx:955'],
  ['IN_DELIVERY', 'COMPLETED', ALL, 'ReceivingModal.jsx:955'],
  ['ORDERED_PENDING_DELIVERY', 'PARTIAL', ALL, 'ReceivingModal.jsx:1131'],
  ['ISSUED', 'PARTIAL', ALL, 'ReceivingModal.jsx:1131'],
  ['PARTIAL', 'PARTIAL', ALL, 'ReceivingModal.jsx:1131 2nd round'],
  ['PARTIAL', 'COMPLETED', ALL, 'ReceivingModal.jsx:955 2nd round'],
  ['ORDERED', 'PARTIALLY_RECEIVED_IN_CLAIM', ALL, 'ReceivingModal.jsx:1102'],
  ['PARTIAL', 'PARTIALLY_RECEIVED_IN_CLAIM', ALL, 'ReceivingModal.jsx:1102'],
  ['ORDERED', 'WAITING_DELIVERY_ROUND_2', ALL, 'ReceivingModal.jsx:980 inline REPLACEMENT'],
  ['ORDERED', 'COMPLETED_WITH_REFUND', ALL, 'ReceivingModal.jsx:1005 inline REFUND'],
  ['PARTIAL', 'WAITING_DELIVERY_ROUND_2', ALL, 'ReceivingModal.jsx:980'],
  // round 2
  ['WAITING_DELIVERY_ROUND_2', 'COMPLETED', CLAIM_CLOSE, 'receive round 2 -> COMPLETED'],
  ['WAITING_DELIVERY_ROUND_2', 'PARTIAL', ALL, 'receive round 2 still short'],
  ['WAITING_DELIVERY_ROUND_2', 'PARTIALLY_RECEIVED_IN_CLAIM', ALL, 'receive round 2 with a new claim'],
  ['WAITING_DELIVERY_ROUND_2', 'COMPLETED_WITH_REFUND', CLAIM_CLOSE, 'round 2 inline refund'],
  ['PARTIALLY_RECEIVED_IN_CLAIM', 'PARTIAL', ALL, 'receive next round while in claim'],
  ['PARTIALLY_RECEIVED_IN_CLAIM', 'COMPLETED', CLAIM_CLOSE, 'resolveClaim all stores resolved'],
  ['PARTIALLY_RECEIVED_IN_CLAIM', 'WAITING_DELIVERY_ROUND_2', ALL, 'resolveClaim REPLACEMENT workflowEngine:2926/3005/3134'],
  ['PARTIALLY_RECEIVED_IN_CLAIM', 'COMPLETED_WITH_REFUND', CLAIM_CLOSE, 'resolveClaim REFUND'],
  // fileClaim / resolveClaim (workflowEngine:2384, 2827, 2971, 3012, 3144)
  ['ORDERED', 'CLAIM_REPORTED', ALL, 'workflowEngine.js:2384/2827 fileClaim'],
  ['PARTIAL', 'CLAIM_REPORTED', ALL, 'fileClaim'],
  ['COMPLETED', 'CLAIM_REPORTED', ALL, 'fileClaim from COMPLETED'],
  ['CLOSED', 'CLAIM_REPORTED', ALL, 'fileClaim from CLOSED'],
  ['COMPLETED', 'CLAIM_PENDING', ALL, 'resolveClaim :2971'],
  ['CLOSED', 'CLAIM_PENDING', ALL, 'resolveClaim :3012'],
  ['CLAIM_REPORTED', 'WAITING_DELIVERY_ROUND_2', ALL, 'resolveClaim REPLACEMENT'],
  ['CLAIM_REPORTED', 'COMPLETED', CLAIM_CLOSE, 'resolveClaim :2967'],
  ['CLAIM_PENDING', 'WAITING_DELIVERY_ROUND_2', ALL, 'resolveClaim'],
  ['COMPLETED', 'WAITING_DELIVERY_ROUND_2', ALL, 'resolveClaim REPLACEMENT from COMPLETED'],
  ['COMPLETED', 'COMPLETED_WITH_REFUND', ALL, 'resolveClaim refund'],
  // short close / close / settle
  ['PARTIAL', 'CLOSED', ALL, 'shortClosePO workflowEngine:2672'],
  ['ORDERED', 'CLOSED', ALL, 'closePO / settle path :3302'],
  ['COMPLETED', 'CLOSED', ALL, 'closePO'],
  // cancel (PODetailsModal canCancelPO : never the online purchaser)
  ['ISSUED', 'CANCELLED', NOT_ONLINE, 'workflowEngine.js:886'],
  ['IN_PROGRESS_ONLINE', 'CANCELLED', NOT_ONLINE, 'workflowEngine.js:886'],
  ['ORDERED', 'CANCELLED', NOT_ONLINE, 'workflowEngine.js:886 (ORDERED)'],
  ['PARTIAL', 'CANCELLED', NOT_ONLINE, 'workflowEngine.js:886 (partly received)'],
  ['COMPLETED', 'CANCELLED', NOT_ONLINE, 'workflowEngine.js:886 (COMPLETED is not blocked by the client)'],
  ['CANCELLED', 'CANCELLED', ALL, 'idempotent re-save']
];

// the moves nobody but an admin may make (the client has none of them)
const STEP_BACK = [
  ['ORDERED', 'ISSUED'], ['ORDERED', 'IN_PROGRESS_ONLINE'], ['IN_DELIVERY', 'ISSUED'], ['ORDERED_PENDING_DELIVERY', 'IN_PROGRESS_ONLINE'],
  ['PARTIAL', 'ISSUED'], ['COMPLETED', 'ORDERED'], ['COMPLETED', 'PARTIAL'], ['CLOSED', 'PARTIAL'], ['CLOSED', 'ORDERED'],
  ['COMPLETED_WITH_REFUND', 'IN_DELIVERY'], ['RECEIVED', 'PARTIAL'],
  ['ISSUED', 'APPROVED'], ['ORDERED', 'DRAFT'], ['APPROVED', 'ISSUED'], ['DRAFT', 'ORDERED'],
  ['CANCELLED', 'ORDERED'], ['CANCELLED', 'ISSUED'], ['CANCELLED', 'COMPLETED']
];

describe('QA r5 : every PO move the web client makes passes canTransitionPO', () => {
  for (const [from, to, who, where] of CLIENT_MOVES) {
    for (const persona of ALL) {
      it(`${from === undefined ? '(new)' : from} -> ${to} as ${persona} [${where}]`, () => {
        expect(canTransitionPO(P[persona], from, to)).toBe(who.includes(persona));
      });
    }
  }
});

describe('closing a PO with an open claim : the PR owner passes through ctx.isOwner, nobody else below approver', () => {
  const CLOSES = [['WAITING_DELIVERY_ROUND_2', 'COMPLETED'], ['WAITING_DELIVERY_ROUND_2', 'COMPLETED_WITH_REFUND'], ['PARTIALLY_RECEIVED_IN_CLAIM', 'COMPLETED'],
    ['PARTIALLY_RECEIVED_IN_CLAIM', 'COMPLETED_WITH_REFUND'], ['CLAIM_REPORTED', 'COMPLETED'], ['CLAIM_PENDING', 'COMPLETED'], ['CLAIM_IN_PROGRESS', 'CLOSED'], ['CLAIM_REPORTED', 'SETTLED']];
  for (const [from, to] of CLOSES) {
    it(`${from} -> ${to}: owner L1 / L2 yes, non-owner no, approver / online / admin yes`, () => {
      expect(canTransitionPO(P.L1, from, to, { isOwner: true })).toBe(true);
      expect(canTransitionPO(P.L2, from, to, { isOwner: true })).toBe(true);
      expect(canTransitionPO(P.L1, from, to, { isOwner: false })).toBe(false);
      expect(canTransitionPO(P.L2, from, to)).toBe(false);
      expect(canTransitionPO(P.L3, from, to)).toBe(true);
      expect(canTransitionPO(P.ONLINE, from, to)).toBe(true);
      expect(canTransitionPO(P.ADMIN, from, to)).toBe(true);
    });
  }
  it('the restriction does not touch the ordinary receive / settle / short-close moves', () => {
    for (const [from, to] of [['ORDERED', 'COMPLETED'], ['PARTIAL', 'COMPLETED'], ['ORDERED', 'CLOSED'], ['PARTIAL', 'CLOSED'], ['COMPLETED', 'CLOSED'], ['CLAIM_REPORTED', 'WAITING_DELIVERY_ROUND_2'], ['CLAIM_REPORTED', 'CANCELLED']]) {
      expect(canTransitionPO(P.L1, from, to), `${from} -> ${to}`).toBe(true);
    }
  });
});

describe('QA r5 : step-back moves stay admin-only', () => {
  for (const [from, to] of STEP_BACK) {
    for (const persona of ['L1', 'L2', 'L3', 'ONLINE']) {
      it(`${from} -> ${to} refused for ${persona}`, () => {
        expect(canTransitionPO(P[persona], from, to)).toBe(false);
      });
    }
    it(`${from} -> ${to} allowed for ADMIN`, () => {
      expect(canTransitionPO(P.ADMIN, from, to)).toBe(true);
    });
  }
});

describe('QA r5 : status normalisation and allowlist', () => {
  it('trim + upper-case before the rules see it', () => {
    expect(normalizePoStatus('  ordered ')).toBe('ORDERED');
    expect(canTransitionPO(P.L1, ' ordered ', 'issued')).toBe(false);
    expect(canTransitionPO(P.L1, 'ordered', ' Partial ')).toBe(true);
    expect(canTransitionPO(P.ONLINE, 'in_progress_online', 'Ordered')).toBe(true);
    expect(canTransitionPO(P.L1, 'in_progress_online', 'Ordered')).toBe(false);
  });
  it('non-string target is refused for everyone, empty means "no change"', () => {
    expect(normalizePoStatus(5)).toBe(null);
    expect(canTransitionPO(P.ADMIN, 'ORDERED', 5)).toBe(false);
    expect(canTransitionPO(P.L1, 'ORDERED', '')).toBe(true);
    expect(canTransitionPO(P.L1, 'ORDERED', undefined)).toBe(true);
  });
  it('allowlist holds every status the client writes on a PO', () => {
    for (const s of ['ISSUED', 'IN_PROGRESS_ONLINE', 'ORDERED', 'ORDERED_PENDING_DELIVERY', 'IN_DELIVERY', 'PARTIAL', 'COMPLETED', 'COMPLETED_WITH_REFUND',
      'PARTIALLY_RECEIVED_IN_CLAIM', 'WAITING_DELIVERY_ROUND_2', 'CLAIM_REPORTED', 'CLAIM_IN_PROGRESS', 'CLAIM_PENDING', 'CLOSED', 'CANCELLED', 'RECEIVED', 'SETTLED']) {
      expect(PO_CLIENT_STATUSES.has(s), s).toBe(true);
    }
  });
});
