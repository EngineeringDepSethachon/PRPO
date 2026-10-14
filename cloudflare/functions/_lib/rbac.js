// Server-side RBAC (T4.5). Not a route (folder starts with "_").
// Source of truth = the ORIGINAL client rules (GAS has no server RBAC):
//   src/config/constants.js resolveUserPermissions, src/services/workflowEngine.js canAction,
//   views' menu/button gating (UserMaster/MasterData/Budget). This module adds NO new business rule:
//   it only enforces on the server what the original UI already allowed/denied. See docs/parity.md (c).

function parseDepts(u) {
  const raw = u && u.allowedDepartments;
  let arr = null;
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string' && raw) {
    try { const j = JSON.parse(raw); if (Array.isArray(j)) arr = j; } catch { /* fallthrough */ }
    if (!arr) arr = raw.split(',').map((d) => d.trim()).filter(Boolean);
  }
  if (!arr || arr.length === 0) arr = [(u && u.department) || 'PD'];
  return arr;
}

// Same normalization the client sees from login (functions/api/[[route]].js formatSafeUser): admin => level 99
export function normalizeUser(u) {
  const user = u || {};
  const rawLevel = Number(user.level || 1);
  const roleId = user.roleId || user.role_id || user.role || '';
  const roleStr = String((roleId || '') + ' ' + (user.canonicalRole || '') + ' ' + (user.positionKey || '') + ' ' + (user.title || '')).toUpperCase();
  // T4.6: admin = level >= 99 OR roleId exactly 'ADMIN'. Not the username, and not any title / positionKey / canonicalRole text that merely contains ADMIN
  // (a free-text title must never grant admin). Same rule in formatSafeUser (login response) in functions/api/[[route]].js.
  const isAdmin = rawLevel >= 99 || String(user.roleId || user.role_id || '') === 'ADMIN';
  // same online-purchaser formula as formatSafeUser (roleId/positionKey/title text or canonicalRole PURCHASER)
  const isOnlineServer = !isAdmin && (roleStr.includes('ONLINE_PURCHASER') || user.canonicalRole === 'PURCHASER');
  return {
    level: isAdmin ? 99 : rawLevel,
    isAdmin: Boolean(isAdmin),
    isOnlineServer: Boolean(isOnlineServer),
    roleId,
    positionKey: user.positionKey || '',
    department: user.department || 'PD',
    primaryDepartment: user.primaryDepartment || '',
    username: user.username || '',
    departments: parseDepts(user)
  };
}

// Mirror of src/config/constants.js resolveUserPermissions (flags only). Tested against the real function.
export function resolvePermissions(u) {
  const n = u && u.__normalized ? u : normalizeUser(u);
  const level = n.level;
  const dept = n.department;
  const userDepts = n.departments;
  const isOnline = n.roleId === 'ONLINE_PURCHASER';
  return {
    level,
    isAdmin: n.isAdmin,
    roleId: n.roleId, // gating-only (STOCK_ADJUST : the screen shows the stock buttons to roleId ASST_MANAGER)
    isOnline,
    // gating-only flag (not part of resolveUserPermissions): any online-purchaser formula used by the client or login response
    onlineish: Boolean(isOnline || n.isOnlineServer || n.positionKey === 'ONLINE_PURCHASER'),
    canCreatePR: level >= 1,
    canSubmitPR: level >= 1,
    canDeleteOwnDraft: level >= 1,
    canReceiveGoods: level === 1 || level >= 99,
    canCloseOwnPO: level === 1 || level >= 99,
    canManageMaster: level >= 1,
    canDeleteMaster: level >= 1, // user decision: follow runtime behaviour of resolveUserPermissions
    canReview: level >= 2,
    canViewBudget: level >= 2,
    canViewBudgetMenu: level >= 2,
    canViewAllDepts: level >= 99 || level >= 3 || dept === 'ALL' || userDepts.includes('ALL') || userDepts.includes('*'),
    canFinalApprove: level >= 3,
    canSetBudget: level >= 3,
    canOnlinePurchase: isOnline || level >= 99
  };
}

// workflowEngine.canAction -> isOnlinePurchaser (roleId / positionKey / canOnlinePurchase && level<99)
function isOnlinePurchaser(p) {
  return p.onlineish || (p.canOnlinePurchase && p.level < 99);
}

// BudgetView.canAllocateBudget: admin, or not ONLINE_PURCHASER and level >= 2
export function canWriteBudget(p) {
  if (p.isAdmin) return true;
  return !p.onlineish && p.level >= 2;
}

// Department gate used by settle (client canAction checks the PO department for non-admin, non-online users)
// Canonical department code: trimmed, upper-case, without the "DEPT-" id prefix ("dept-qc " -> "QC")
export function normalizeDeptCode(v) {
  return String(v ?? '').trim().toUpperCase().replace(/^DEPT-/, '');
}
// Ledger department : the client labels some rows "ฝ่าย PD" (budgetService display name), the server stores the code "PD".
// Written rows get the code ; rows already stored with the prefix (append-only, never rewritten) are read through the same function.
export function ledgerDeptCode(v) {
  return normalizeDeptCode(String(v ?? '').trim().replace(/^ฝ่าย\s*/, '').trim());
}
// "all departments" markers: never a real department of a document / budget (the client always picks a concrete code)
export function isWildcardDept(v) {
  const c = normalizeDeptCode(v);
  return c === 'ALL' || c === 'BOTH' || c === '*';
}

// Port of src/utils/permissions.js (getUserDepartments / matchDepartment / canAccessDepartmentData) - the rule the client applies to
// VIEWING and to EDITING department-scoped data (workflowEngine.canAction -> matchesDept for every PR/PO action, MasterDataView
// canAccessDepartmentData before saving products/vendors/units). Compared against the real client functions in tests/cf_rbac_dept.test.js.
export function clientUserDepartments(u) {
  const out = [];
  const collect = (val) => {
    if (!val) return;
    if (Array.isArray(val)) val.forEach(collect);
    else if (typeof val === 'string') val.split(',').forEach((part) => { const t = part.trim(); if (t) out.push(t.toUpperCase()); });
  };
  collect(u.departments); collect(u.assignedDepartments); collect(u.allowedDepartments); collect(u.department); collect(u.primaryDepartment);
  const uniq = Array.from(new Set(out));
  const roleId = String(u.roleId || u.role_id || u.id || '').toUpperCase();
  const isAdmin = u.role === 'admin' || roleId === 'ADMIN' || Number(u.level) >= 99 || u.isAdmin === true || u.username === 'admin';
  if (uniq.length === 0 && isAdmin) return ['ALL'];
  return uniq;
}

export function clientMatchDepartment(prodDept, targetDept) {
  if (!prodDept || !targetDept) return false;
  const rawTarget = typeof targetDept === 'string' ? targetDept.trim().toUpperCase() : '';
  const rawProduct = typeof prodDept === 'string' ? prodDept.trim().toUpperCase() : '';
  if (rawTarget === 'ALL' || rawTarget === '*' || rawTarget === 'BOTH') return true;
  if (rawProduct === 'ALL' || rawProduct === '*' || rawProduct === 'BOTH') return true;
  const p = String(prodDept?.code || prodDept?.id || prodDept).trim().toUpperCase();
  const t = String(targetDept).trim().toUpperCase();
  return p === t || p.replace(/^DEPT-/, '') === t.replace(/^DEPT-/, '') || p === t.replace(/^DEPT-/, '') || t === p.replace(/^DEPT-/, '');
}

// the user object the client holds for this account (login response = formatSafeUser: admin => level 99, department arrays)
export function clientViewOfUser(authUser) {
  const n = normalizeUser(authUser);
  const p = resolvePermissions(authUser);
  return {
    departments: n.departments, assignedDepartments: n.departments, allowedDepartments: n.departments,
    department: n.department, primaryDepartment: n.primaryDepartment,
    // username is deliberately NOT passed : the client function treats username 'admin' as admin, the server does not (T4.6)
    roleId: n.roleId, level: n.level, isAdmin: n.isAdmin, username: '', canViewAllDepts: p.canViewAllDepts
  };
}

export function clientCanAccessDepartmentData(user, targetDepartment) {
  if (!user) return false;
  if (!targetDepartment || targetDepartment === 'ALL' || targetDepartment === 'BOTH') return true;
  const userDepts = clientUserDepartments(user);
  const roleId = String(user.roleId || user.role_id || user.id || '').toUpperCase();
  const isAdmin = user.role === 'admin' || roleId === 'ADMIN' || Number(user.level) >= 99 || user.isAdmin === true || user.username === 'admin' ||
    userDepts.includes('ALL') || userDepts.includes('*') || (user.department === 'ALL' && user.canViewAllDepts);
  if (isAdmin) return true;
  const target = String(targetDepartment).trim().toUpperCase();
  return userDepts.some((d) => clientMatchDepartment(d, target));
}

// server gate: exactly the client rule, plus the online purchaser (works across departments by design : ROLES.ONLINE_PURCHASER
// canViewAllDepts, seeded allowedDepartments ["*"], canAction for IN_PROGRESS_ONLINE does not look at the department)
export function canAccessDepartment(authUser, dept) {
  const p = resolvePermissions(authUser);
  if (p.isAdmin || p.onlineish) return true;
  return clientCanAccessDepartmentData(clientViewOfUser(authUser), dept);
}

// Refund-style adjustments are posted by whoever settles/receives (client handleRefundBudget/handleRollbackBudget)
// Non-writers may only post the three flows the client really sends (handleRefundBudget / rollbackBudget / deductBudget);
// the handler computes everything from server state, so no client-supplied newAmount may be used for TOP_UP.
export function canAdjustBudget(authUser, params) {
  const p = resolvePermissions(authUser);
  const body = params || {};
  // only an admin may touch a wildcard "department" (ALL / BOTH / * in any case) - it would open every department's data / budget
  if (!p.isAdmin && body.dept !== undefined && body.dept !== null && body.dept !== '' && isWildcardDept(ledgerDeptCode(body.dept))) return false;
  if (canWriteBudget(p)) return true;
  const action = String(body.action || '').toUpperCase();
  const delta = Number(body.delta);
  if (!Number.isFinite(delta)) return false;
  // a requester-level user (settles/receives POs of own department) may only touch their own departments' budget ;
  // the online purchaser works across departments by design (ROLES.ONLINE_PURCHASER canViewAllDepts) so it is exempt
  if (!canAccessDepartment(authUser, ledgerDeptCode(body.dept) || 'PD')) return false;
  const hasNew = body.newAmount !== undefined && body.newAmount !== null && body.newAmount !== '';
  if (action === 'TOP_UP') return delta > 0 && !hasNew;
  if (action === 'BUDGET_ROLLBACK') return delta > 0; // client sends newAmount=newSpent; server ignores it
  if (action === 'BUDGET_DEDUCT') return delta < 0;
  return false;
}

const PERMS = {
  AUTH: () => true,
  ADMIN: (p) => p.isAdmin,
  MASTER_WRITE: (p) => p.canManageMaster || p.isAdmin,
  MASTER_DELETE: (p) => p.canDeleteMaster || p.isAdmin,
  BUDGET_WRITE: (p) => canWriteBudget(p),
  // route-level only; the handler additionally applies canAdjustBudget(body)
  BUDGET_ADJUST: (p) => canWriteBudget(p) || p.onlineish || p.canOnlinePurchase || p.canCloseOwnPO || p.canReceiveGoods,
  PR_WRITE: (p) => p.isAdmin || p.canCreatePR || p.canSubmitPR || p.canReview || p.canFinalApprove,
  PO_WRITE: (p) => p.isAdmin || p.canCreatePR || p.canReview || p.canFinalApprove || p.canOnlinePurchase || p.canReceiveGoods,
  RECEIVE: (p) => p.isAdmin || p.canReceiveGoods,
  SETTLE: (p) => p.isAdmin || p.onlineish || p.canOnlinePurchase || p.canCloseOwnPO,
  STOCK_WRITE: (p) => p.isAdmin || p.canManageMaster || p.canReceiveGoods,
  // StockCardView shows "ปรับปรุงยอด" / "รับเข้าคลัง Manual" to: not an online purchaser AND (canReceiveGoods | ASST_MANAGER (level 2) | ADMIN)
  STOCK_ADJUST: (p) => p.isAdmin || (!p.onlineish && (p.canReceiveGoods || p.roleId === 'ASST_MANAGER'))
};

const W = ['POST', 'PUT', 'PATCH', 'DELETE'];
const seg = (name) => new RegExp(`^/api/${name}(/.*)?$`);

// Endpoint -> required permission. First match wins. Unlisted write endpoints are denied (fail closed).
export const ENDPOINT_RULES = [
  { id: 'users-read', methods: ['GET'], re: /^\/api\/(users?)(\/.*)?$/, perm: 'AUTH' },
  { id: 'users-write', methods: W, re: /^\/api\/(users?)(\/.*)?$/, perm: 'ADMIN' },
  { id: 'departments-read', methods: ['GET'], re: seg('departments'), perm: 'AUTH' },
  { id: 'departments-write', methods: W, re: seg('departments'), perm: 'ADMIN' },
  { id: 'master-read', methods: ['GET'], re: /^\/api\/(products|vendors|storage-locations|usage-units)(\/.*)?$/, perm: 'AUTH' },
  { id: 'master-delete', methods: ['DELETE'], re: /^\/api\/(products|vendors|storage-locations|usage-units)(\/.*)?$/, perm: 'MASTER_DELETE' },
  { id: 'master-write', methods: ['POST', 'PUT', 'PATCH'], re: /^\/api\/(products|vendors|storage-locations|usage-units)(\/.*)?$/, perm: 'MASTER_WRITE' },
  { id: 'budget-adjust', methods: ['POST'], re: /^\/api\/budgets\/adjust$/, perm: 'BUDGET_ADJUST' },
  { id: 'budget-allocate', methods: ['POST'], re: /^\/api\/budgets\/allocate$/, perm: 'BUDGET_WRITE' },
  { id: 'budget-reset', methods: ['POST'], re: /^\/api\/budgets\/reset$/, perm: 'BUDGET_WRITE' },
  // PUT /api/budgets/:dept is also the client's refund reconcile (budgetService.creditDepartmentBudget, run by whoever resolves a claim / settles).
  // Route-level: same set as budgets/adjust ; the handler gives budget writers the full upsert and everybody else ONLY a refund credit
  // (see the PUT handler: spent lowered, nothing else touched, same limits as adjust BUDGET_ROLLBACK).
  { id: 'budget-dept-update', methods: ['PUT', 'PATCH'], re: /^\/api\/budgets\/[^/]+$/, perm: 'BUDGET_ADJUST' },
  { id: 'budgets-read', methods: ['GET'], re: seg('budgets'), perm: 'AUTH' },
  { id: 'budgets-write', methods: W, re: seg('budgets'), perm: 'BUDGET_WRITE' },
  { id: 'budget-tx', methods: ['GET', 'POST'], re: seg('budget-transactions'), perm: 'AUTH' },
  { id: 'po-receive', methods: ['POST'], re: /^\/api\/(pos\/[^/]+\/receive|receive-goods|receive|grn|inventory\/receive)$/, perm: 'RECEIVE' },
  { id: 'po-settle', methods: ['POST'], re: /^\/api\/pos\/[^/]+\/settle$/, perm: 'SETTLE' },
  { id: 'prs-read', methods: ['GET'], re: /^\/api\/(prs?)(\/.*)?$/, perm: 'AUTH' },
  { id: 'prs-delete', methods: ['DELETE'], re: /^\/api\/(prs?)(\/.*)?$/, perm: 'ADMIN' }, // GAS has no PR delete; the client never calls it
  { id: 'prs-write', methods: ['POST', 'PUT', 'PATCH'], re: /^\/api\/(prs?)(\/.*)?$/, perm: 'PR_WRITE' },
  { id: 'pos-read', methods: ['GET'], re: /^\/api\/(pos?)(\/.*)?$/, perm: 'AUTH' },
  { id: 'pos-delete', methods: ['DELETE'], re: /^\/api\/(pos?)(\/.*)?$/, perm: 'ADMIN' },
  { id: 'pos-write', methods: ['POST', 'PUT', 'PATCH'], re: /^\/api\/(pos?)(\/.*)?$/, perm: 'PO_WRITE' },
  { id: 'stock-read', methods: ['GET'], re: /^\/api\/(stock-logs|stock|inventory)(\/.*)?$/, perm: 'AUTH' },
  { id: 'stock-adjust', methods: ['POST'], re: /^\/api\/stock\/(adjust|manual-in)$/, perm: 'STOCK_ADJUST' },
  { id: 'stock-write', methods: ['POST', 'PUT', 'PATCH'], re: /^\/api\/(stock-logs|stock\/issue|inventory\/issue)$/, perm: 'STOCK_WRITE' },
  { id: 'audit-read', methods: ['GET'], re: /^\/api\/audit-logs(\/.*)?$/, perm: 'ADMIN' }, // UI route admin/audit-logs = SYSTEM_ADMIN
  { id: 'audit-write', methods: ['POST'], re: /^\/api\/audit-logs$/, perm: 'AUTH' },
  // signature images are printed on PO/PR PDFs: no UI writes them (GAS apiSaveSignature has no caller) -> admin only, anyone logged in may read
  { id: 'signatures-write', methods: ['POST', 'PUT', 'PATCH'], re: seg('signatures'), perm: 'ADMIN' },
  { id: 'admin-cleanup-orphans', methods: ['POST'], re: /^\/api\/admin\/cleanup-orphans$/, perm: 'ADMIN' }, // dry run by default (functions/_lib/orphans.js)
  { id: 'admin-restore-orphan', methods: ['POST'], re: /^\/api\/admin\/restore-orphan$/, perm: 'ADMIN' },
  { id: 'admin-unshare-public', methods: ['POST'], re: /^\/api\/admin\/unshare-public$/, perm: 'ADMIN' }, // dry run by default (functions/_lib/unshare.js)
  // notifications are made by the server itself (M7-2) ; the client never POSTs one (it only reads and marks read) -> creating one by hand is admin only
  { id: 'notifications-create', methods: ['POST'], re: /^\/api\/notifications$/, perm: 'ADMIN' },
  { id: 'misc-auth', methods: ['GET', 'POST', 'PUT'], re: /^\/api\/(bootstrap|health|me|logout|notifications|upload|files|signatures)(\/.*)?$/, perm: 'AUTH' }
];

export function matchRule(method, path) {
  let m = String(method || 'GET').toUpperCase();
  if (m === 'HEAD') m = 'GET'; // HEAD is governed by exactly the same rule as GET
  const p = String(path || '');
  for (const r of ENDPOINT_RULES) {
    if (r.methods.includes(m) && r.re.test(p)) return r;
  }
  return null;
}

// -> true when allowed. Unknown GET/HEAD = any logged-in user (same as before); unknown writes = denied.
export function authorize(authUser, method, path) {
  const m = String(method || 'GET').toUpperCase();
  const rule = matchRule(m, path);
  if (!rule) return m === 'GET' || m === 'HEAD';
  const p = resolvePermissions(authUser);
  return Boolean(PERMS[rule.perm](p));
}

// ───────────────────────── document status flows (table-driven; mirrored in docs/parity.md c.5) ─────────────────────────
// Derived from every place the client sets a PR/PO status and persists it through the API:
//   workflowEngine.js : createPR 1187 / updatePR 1475-1487 / submitPR 1556 / updatePRStatus 1608-1700 (review, approve->PO_ISSUED|
//   IN_PROGRESS_ONLINE 1686) / rejectPR 443-458 (ALWAYS REJECTED_TO_DRAFT, by L2 from SUBMITTED and by L3 from REVIEWED) /
//   cancelPR 805-827 (canAction stage owner) / receive+claim+close flows 2385-3327 ; PODetailsModal 1697 (mark ordered) ;
//   OnlineOrderCard (online order, online claim) ; PODetailsModal 486-547 (cancel PO, self-claim resolution).
// actors: any = every logged-in user | requester = canSubmitPR | reviewer = level 2, not online | approver = level>=3, not online
//         | online = online purchaser | notOnline | receiver = canReceiveGoods
// An admin bypasses every flow (canAction admin). fromStatus undefined = brand-new document.
const REVIEW_STATUSES = ['SUBMITTED', 'REJECTED_TO_L2', 'waiting_review', 'pending_review', 'รอตรวจทาน', 'รอตรวจสอบ'];
const PR_DRAFTS = ['DRAFT', 'REJECTED_TO_DRAFT'];
const PR_APPROVED = ['APPROVED', 'PO_ISSUED', 'IN_PROGRESS_ONLINE'];
const PR_DONE = ['CLOSED', 'completed', 'COMPLETED', 'received'];

export const PR_FLOWS = [
  { action: 'create', from: null, to: ['DRAFT', 'SUBMITTED'], actor: 'requester' },
  { action: 'save/resubmit draft', from: PR_DRAFTS, to: ['DRAFT', 'SUBMITTED'], actor: 'requester' },
  { action: 'cancel draft', from: PR_DRAFTS, to: ['CANCELLED'], actor: 'requester' },
  { action: 'review (L2)', from: REVIEW_STATUSES, to: ['REVIEWED'], actor: 'reviewer' },
  { action: 'reject to requester (L2)', from: REVIEW_STATUSES, to: ['REJECTED_TO_DRAFT'], actor: 'reviewer' },
  { action: 'cancel at review (L2)', from: REVIEW_STATUSES, to: ['CANCELLED', 'SUBMITTED'], actor: 'reviewer' },
  { action: 'approve + issue PO (L3)', from: ['REVIEWED'], to: ['APPROVED', 'PO_ISSUED', 'IN_PROGRESS_ONLINE'], actor: 'approver' },
  { action: 'reject (L3)', from: ['REVIEWED'], to: ['REJECTED_TO_DRAFT', 'REJECTED_TO_L2'], actor: 'approver' },
  { action: 'cancel at approval (L3)', from: ['REVIEWED'], to: ['CANCELLED'], actor: 'approver' },
  { action: 'PO progress cascade', from: PR_APPROVED, to: [...PR_APPROVED, ...PR_DONE], actor: 'any' },
  { action: 'completion cascade', from: PR_DONE, to: PR_DONE, actor: 'any' }
];

// every PR status the client produces (= the "from" side of PR_FLOWS) + CANCELLED ; used by the importer to map odd sheet values
export const PR_KNOWN_STATUSES = [...new Set([...PR_FLOWS.flatMap((f) => (f.from || [])), ...PR_FLOWS.flatMap((f) => f.to), 'CANCELLED'])];

// PR content (items / totalAmount) may only change where the client lets it change:
//  - DRAFT / REJECTED_TO_DRAFT : the requester edits his draft (updatePR)
//  - SUBMITTED / REVIEWED / REJECTED_TO_L2 : workflowEngine.editPRItems (level >= 2)
//  - anything later (approved, PO issued, closed, cancelled, unknown) : frozen
const PR_ITEM_EDIT_REVIEW = ['SUBMITTED', 'REVIEWED', 'REJECTED_TO_L2'];
export function canEditPrContent(authUser, rawStatus) {
  const status = String(rawStatus ?? '').trim().toUpperCase();
  const p = resolvePermissions(authUser);
  if (p.isAdmin) return true;
  if (PR_DRAFTS.includes(status)) return true;
  if (PR_ITEM_EDIT_REVIEW.includes(status)) return p.level >= 2;
  return false;
}

const ACTORS = {
  any: () => true,
  requester: (p) => p.canSubmitPR,
  reviewer: (p) => !isOnlinePurchaser(p) && p.level === 2,
  approver: (p) => !isOnlinePurchaser(p) && p.level >= 3
};

export function canTransitionPR(authUser, fromStatus, toStatus) {
  if (!toStatus) return true;
  const p = resolvePermissions(authUser);
  if (p.isAdmin) return true;
  if (fromStatus === toStatus) return true;
  if (fromStatus === 'CANCELLED') return false;
  const known = Boolean(fromStatus) && PR_FLOWS.some((f) => f.from && f.from.includes(fromStatus));
  if (fromStatus && !known) return false; // a status the client never produces: only an admin may move it (the importer maps odd sheet values)
  return PR_FLOWS.some((f) => (f.from === null ? !fromStatus : (fromStatus && f.from.includes(fromStatus)))
    && f.to.includes(toStatus) && ACTORS[f.actor](p));
}

// PO rules. Claim resolution (self-buy: requester/receiver/reviewer ; online: online purchaser), settle/close, cancel and
// "mark ordered" are reachable by several roles in the client, so only edges with one clear owner are enforced:
export const PO_RULES = [
  { action: 'cancelled is final', from: ['CANCELLED'], to: '*', actor: 'nobody' },
  { action: 'online order / mark ordered', from: ['IN_PROGRESS_ONLINE'], to: ['ORDERED', 'ORDERED_PENDING_DELIVERY', 'IN_DELIVERY'], actor: 'online' },
  { action: 'cancel PO (canCancelPO: never the online purchaser)', from: '*', to: ['CANCELLED'], actor: 'notOnline' },
  { action: 'other moves of an online task', from: ['IN_PROGRESS_ONLINE'], to: '*', actor: 'online' },
  { action: 'receiving result written by the receive endpoint', from: '*', to: ['RECEIVED', 'PARTIALLY_RECEIVED', 'PARTIAL_RECEIVED'], actor: 'receiver' }
];
const PO_ACTORS = {
  nobody: () => false,
  online: (p) => isOnlinePurchaser(p) || p.canOnlinePurchase,
  notOnline: (p) => !isOnlinePurchaser(p),
  receiver: (p) => p.canReceiveGoods
};

// PO statuses by stage. One list for the route, the line guard and the transition rules.
export const PO_PRE_ORDER = new Set(['DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'APPROVED']);           // before the PO is issued
const PO_READY = new Set(['ISSUED', 'PO_ISSUED', 'IN_PROGRESS_ONLINE']);                               // issued, not ordered yet
const PO_ORDERED = new Set(['ORDERED', 'ORDERED_PENDING_DELIVERY', 'IN_DELIVERY', 'SHIPPED']);         // ordered, waiting for the goods
const PO_RECEIVING = new Set(['PARTIAL', 'PARTIAL_RECEIVED', 'PARTIALLY_RECEIVED']);
const PO_DONE = new Set(['CLOSED', 'COMPLETED', 'COMPLETED_WITH_REFUND', 'RECEIVED']);                 // finished
// every status the client sets on a PO (workflowEngine / ReceivingModal / PODetailsModal / OnlineOrderCard / constants PO_STATUS) ; a non-admin body
// carrying any other value is refused (400)
export const PO_CLIENT_STATUSES = new Set([...PO_PRE_ORDER, ...PO_READY, ...PO_ORDERED, ...PO_RECEIVING, ...PO_DONE, 'CANCELLED', 'SETTLED',
  'CLAIM_REPORTED', 'CLAIM_IN_PROGRESS', 'CLAIM_PENDING', 'PARTIALLY_RECEIVED_IN_CLAIM', 'WAITING_DELIVERY_ROUND_2']);
// trimmed + upper-cased ; '' for nothing ; null for a value that is not a string
export function normalizePoStatus(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') return null;
  return v.trim().toUpperCase();
}

export function canTransitionPO(authUser, fromStatus, toStatus) {
  const to = normalizePoStatus(toStatus);
  const from = normalizePoStatus(fromStatus) || '';
  if (to === null) return false;
  if (!to || from === to) return true;
  const p = resolvePermissions(authUser);
  if (p.isAdmin) return true;
  if (from) {
    // never back to an earlier stage (the client has no such move ; it would unlock the lines) - admin only
    if (PO_PRE_ORDER.has(to) && !PO_PRE_ORDER.has(from)) return false;                     // past the issue -> a pre-order status
    if (PO_PRE_ORDER.has(from) && !PO_PRE_ORDER.has(to)) return false;                     // a pre-order PO is only issued with the PR approval (POST of a new PO)
    if (PO_READY.has(to) && !PO_READY.has(from)) return false;                             // ordered / receiving / finished -> issued
    if (PO_ORDERED.has(from) && PO_READY.has(to)) return false;
    // a finished PO is only re-opened by the claim flow (CLAIM_* / WAITING_DELIVERY_ROUND_2 / COMPLETED_WITH_REFUND) - never to "ordered" or "receiving"
    if (PO_DONE.has(from) && (PO_ORDERED.has(to) || PO_RECEIVING.has(to))) return false;
  }
  for (const r of PO_RULES) {
    const fromOk = r.from === '*' || (from && r.from.includes(from));
    const toOk = r.to === '*' || r.to.includes(to);
    if (fromOk && toOk) return Boolean(PO_ACTORS[r.actor](p));
  }
  return true; // CLOSED / COMPLETED / CLAIM_* / WAITING_DELIVERY_ROUND_2 ... are set by several roles in the client
}
