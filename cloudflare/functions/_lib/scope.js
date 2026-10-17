// P4 : what each user is sent by the read endpoints (GET /api/bootstrap, /api/prs, /api/pos, /api/stock-logs, /api/budgets, /api/budget-transactions, /api/users).
// Not a route (folder starts with "_").
//
// Rule (user decision A) : the server returns the UNION of what the original screens of that user can show, so nothing changes for the user
// and nothing is sent that no screen shows. Every rule below is a port of a real client rule (tests/cf_scope.test.js compares them with the
// client functions themselves, persona by persona) :
//
//   documents (PR / PO)
//     A  PRListView / POListView / KPICards ('ALL' tab) / WorkspaceView (level 2 + PO of the own department) :
//          canAccessDepartmentData(user, doc.department)                      -> rbac.canAccessDepartment
//     B  WorkspaceView.canSeeDocument : ADMIN, level >= 3, PLANT_MANAGER, PURCHASER, ONLINE_PURCHASER see every document
//     C  WorkspaceView.canSeeDocument : anybody who is neither global (B) nor a reviewer (roleId ASST_MANAGER / REVIEWER / level 2) also sees
//          the documents they created (requestedBy / applicantName1 / createdBy = their email, name or username ; requesterId = their id)
//     D  DashboardView : users that get the PD / QC / ALL tabs (isMultiDeptUser) can open the PD and QC tab -> KPICards counts every PR / PO
//          of PD and QC (matchDepartment)
//   stock logs : QuickIssueView / StockCardView / StockMovementTable -> canViewAllDepts, else the log's department is one of the user's (A)
//   budgets / ledger : BudgetView (level >= 2, admin, canViewAllDepts and online see every department ; others their assigned departments)
//                      + the dashboard tabs (D) ; ledger rows follow their department
//   users : everybody (names, roles, signatures are printed on PO / PR) but the e-mail of OTHER people is only for the admin screen
import { ledgerDeptCode, normalizeUser, resolvePermissions, clientMatchDepartment, clientCanAccessDepartmentData, clientViewOfUser } from './rbac.js';

// The screens' own department rule (canAccessDepartmentData). NOT rbac.canAccessDepartment : that one also lets the online purchaser write across
// departments by design, which no list screen does.
const screenAccess = (authUser, dept) => clientCanAccessDepartmentData(clientViewOfUser(authUser), dept);

const WILDCARDS = new Set(['ALL', 'BOTH', '*']);

// the department codes of the user the way the client lists them (upper case)
function userDeptList(authUser) {
  const n = normalizeUser(authUser);
  return n.departments.map((d) => String(d).trim().toUpperCase()).filter(Boolean);
}

export function buildViewer(authUser) {
  const n = normalizeUser(authUser);
  const p = resolvePermissions(authUser);
  const roleId = String(n.roleId || authUser.id || '').toUpperCase();
  const depts = userDeptList(authUser);
  const isGlobal = n.isAdmin || n.level >= 99 || roleId === 'ADMIN' || n.level >= 3
    || roleId === 'PLANT_MANAGER' || roleId === 'PURCHASER' || roleId === 'ONLINE_PURCHASER'
    || Boolean(n.isBuffer); // Phase 3: BUFFER (พี่สุ) sees every department's PR / PO / stock
  const isReviewer = !n.isBuffer && (roleId === 'ASST_MANAGER' || roleId === 'REVIEWER' || n.level === 2);
  // DashboardView.isMultiDeptUser (the role text there is the session role : 'admin' or the lower-cased roleId)
  const dashRole = n.isAdmin ? 'ADMIN' : roleId;
  const dashMulti = depts.length > 1 || ['ADMIN', 'ASST_MANAGER', 'PLANT_MANAGER', 'MANAGER'].includes(dashRole)
    || depts.some((d) => WILDCARDS.has(d)) || Boolean(p.canViewAllDepts);
  return {
    authUser,
    level: n.level,
    isAdmin: n.isAdmin,
    roleId,
    isGlobal,
    isReviewer,
    dashMulti,
    canViewAllDepts: Boolean(p.canViewAllDepts),
    onlineish: Boolean(p.onlineish),
    // NOTE: the client session's `id` is the ROLE id, not the user id (authService spreads resolveUserPermissions(user), whose `id` is the roleId, over
    // the session) so WorkspaceView's `doc.requesterId === user.id` is compared with the role id there. Ported as it is.
    id: n.roleId || authUser.id,
    userId: authUser.userId || authUser.id,
    email: String(authUser.email || '').trim().toLowerCase(),
    name: String(authUser.name || '').trim().toLowerCase(),
    username: String(authUser.username || '').trim().toLowerCase()
  };
}

// WorkspaceView.isUserMatched
function isUserMatched(value, v) {
  if (!value) return false;
  const val = String(value).trim().toLowerCase();
  return Boolean((v.email && val === v.email) || (v.name && val === v.name) || (v.username && val === v.username));
}

const onDashTab = (v, dept) => v.dashMulti && (clientMatchDepartment(dept, 'PD') || clientMatchDepartment(dept, 'QC'));

export function canSeeDocument(v, doc) {
  if (!doc) return false;
  if (screenAccess(v.authUser, doc.department)) return true; // A
  if (v.isGlobal) return true; // B
  if (onDashTab(v, doc.department)) return true; // D
  // E  BudgetView / dashboard budget cards : the figures of a department (actualSpent / committed / ledger) are computed on the CLIENT from the
  //    PRs and POs of that department, so whoever sees the budget of a department must receive its documents (level >= 2, admin, canViewAllDepts, online)
  if (canSeeBudgetDepartment(v, doc.department)) return true;
  if (!v.isReviewer && (isUserMatched(doc.requestedBy, v) || isUserMatched(doc.applicantName1, v) || isUserMatched(doc.createdBy, v)
    || (doc.requesterId && doc.requesterId === v.id))) return true; // C
  return false;
}

export function canSeeStockLog(v, log) {
  if (v.canViewAllDepts) return true;
  // A log without a department is shown to everybody by the original screens : StockMovementTable / StockCardView only drop a log when
  // `log.department && product department && !match` (an empty department passes), and QuickIssueView falls back to the product / shows it when the product
  // is unknown. Server = union of the screens -> screenAccess() with an empty department (true), exactly as before (parity.md P4 round 3).
  return screenAccess(v.authUser, log && log.department);
}

export function canSeeBudgetDepartment(v, dept) {
  return budgetDepartmentVisible(v, dept);
}
function budgetDepartmentVisible(v, dept) {
  if (v.isAdmin || v.level >= 2 || v.canViewAllDepts || v.onlineish) return true;
  if (screenAccess(v.authUser, dept)) return true;
  return onDashTab(v, dept);
}

export const filterDocuments = (v, list) => (list || []).filter((d) => canSeeDocument(v, d));
export const filterStockLogs = (v, list) => (list || []).filter((l) => canSeeStockLog(v, l));
export const filterBudgetRows = (v, list) => (list || []).filter((b) => canSeeBudgetDepartment(v, b && (b.department || b.id)));
// BudgetView drops a ledger row whose department is empty (txDept '' is in no user's list), so a row without any department is only sent to the
// users who see every department (admin / level >= 2 / canViewAllDepts / online) - never to a level 1 user through the "empty = allowed" rule.
export const filterLedger = (v, list) => (list || []).filter((t) => {
  const dept = ledgerDeptCode((t && (t.department || t.dept)) || ''); // old rows may say "ฝ่าย PD"
  if (!dept) return Boolean(v.isAdmin || v.level >= 2 || v.canViewAllDepts || v.onlineish);
  return canSeeBudgetDepartment(v, dept);
});

// e-mail addresses of other people are not shown by any screen except the admin user master
export function stripOtherEmails(v, users) {
  if (v.isAdmin) return users;
  return (users || []).map((u) => {
    if (!u || u.id === v.userId || !('email' in u)) return u;
    const { email, ...rest } = u; // eslint-disable-line no-unused-vars
    return rest;
  });
}
