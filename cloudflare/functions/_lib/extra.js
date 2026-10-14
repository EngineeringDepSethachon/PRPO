// Endpoints added by T3.5 (parity with GAS / mock backend). Not a route (folder starts with "_").
// Called from functions/api/[[route]].js AFTER authentication + RBAC (authorize), so every handler here already passed ENDPOINT_RULES.
// handleExtraRoutes(ctx) -> Response | null  (null = not one of these paths ; the main router continues)
//   usage-units CRUD, notifications (GET filtered per user / POST / PUT mark-read), audit-logs (POST any user, GET admin),
//   signatures (GET / POST|PUT admin), PUT /api/storage-locations/:id, POST /api/products/recalculate-mac

import { normalizeDeptCode, canAccessDepartment, isWildcardDept, resolvePermissions } from './rbac.js';
import { sqliteUtcToIso } from './timefmt.js';
import { checkUserSignature } from './sanitize.js';
import { productView } from './products.js';

// targetRole values the client really produces (workflowEngine / notificationService targetRoles + the GAS role words)
export const NOTIFICATION_ROLES = new Set(['ALL', 'ADMIN', 'REQUESTER', 'REQUESTER_PD', 'REQUESTER_QC', 'ASST_MANAGER', 'REVIEWER', 'APPROVER', 'PLANT_MANAGER', 'ONLINE_PURCHASER', 'PURCHASER', 'BUYER']);
const RATE_WINDOW_MS = 60 * 1000;
const NOTIFY_PER_MIN = 60; // rows per user per minute (POST /api/notifications)
const AUDIT_PER_MIN = 120; // rows per user per minute (POST /api/audit-logs)
const NOTIFY_SCAN_PAGE = 500;
const NOTIFY_SCAN_MAX = 2000; // newest rows examined per GET
const NOTIFY_RETURN_MAX = 200; // the client keeps 100 (notificationService)

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const has = (v) => v !== undefined && v !== null && v !== '';

async function readJson(request) {
  return request.json().catch(() => null);
}

// ───────────── notifications : port of gas/Code.gs isUserTargetOfNotification (:3703-3743) ─────────────
export function isUserTargetOfNotification(n, user) {
  if (!n) return false;
  const targetRole = String(n.targetRole || (Array.isArray(n.targetRoles) && n.targetRoles[0]) || 'ALL').toUpperCase();
  const targetDept = String(n.targetDepartment || n.targetDept || n.department || 'ALL').toUpperCase();

  if (!user) return targetRole === 'ALL' && targetDept === 'ALL';
  const userRole = String(user.canonicalRole || user.roleId || user.role || '').toUpperCase();
  const isAdmin = user.isAdmin || Number(user.level) >= 99 || String(user.roleId || '') === 'ADMIN'; // T4.6 admin rule (no username / text match)
  if (isAdmin) return true;

  const userDept = String(user.department || user.dept || '').toUpperCase();
  const isApproverOrMGT = userRole.includes('APPROV') || userRole.includes('REVIEW') || userRole.includes('MANAGER') || userDept === 'MGT';
  const isApproverTarget = targetRole.includes('APPROV') || targetRole.includes('REVIEW') || (Array.isArray(n.targetRoles) && n.targetRoles.some((r) => {
    const ru = String(r).toUpperCase();
    return ru.includes('APPROV') || ru.includes('REVIEW') || ru.includes('MANAGER');
  }));

  const matchDept = (isApproverOrMGT && isApproverTarget)
    ? true
    : (targetDept === 'ALL' || userDept === 'ALL' || targetDept === userDept || userDept.includes(targetDept) || targetDept.includes(userDept));

  if (!matchDept && !user.canViewAllDepts && userDept !== 'ALL') {
    // client notificationService.isNotificationTarget : a department the user is assigned to (not only the primary one) still receives it
    const assigned = Array.isArray(user.assignedDepartments) ? user.assignedDepartments.map((d) => String(d).toUpperCase()) : [];
    if (!assigned.includes(targetDept)) return false;
  }

  if (targetRole === 'ALL') return true;
  if (targetRole.includes('REQUEST')) {
    return userRole.includes('REQUEST') || userRole.includes('PD') || userRole.includes('QC') || Number(user.level) === 1;
  }
  if (targetRole.includes('APPROV')) {
    return isApproverOrMGT || userRole.includes('APPROV') || userRole.includes('REVIEW') || userRole.includes('PLANT_MANAGER') || userRole.includes('ASST_MANAGER') || Boolean(user.canReview || user.canFinalApprove);
  }
  if (targetRole.includes('PURCHAS') || targetRole.includes('BUYER')) {
    return userRole.includes('PURCHAS') || userRole.includes('BUYER') || Boolean(user.canOnlinePurchase);
  }
  return userRole.includes(targetRole);
}

// the client reads isRead / read / status === 'read' (lower case, like the GAS sheet) ; D1 default is 'UNREAD'
// read state is PER USER (notification_reads, migration 0014) : the shared `status` column is never used to tell whether THIS user has read it
const SERVER_NOTIFICATION_TYPES = /^(PR_|PO_|GOODS_RECEIVED$|ONLINE_ORDERED$)/i;
// only what the client reads (createdBy / createdAtMs are bookkeeping of the server and are not sent)
function shapeNotification(n, read = false) {
  const { createdBy: _by, createdAtMs: _ms, ...rest } = n;
  return { ...rest, status: read ? 'read' : 'unread', isRead: read, read, createdAt: sqliteUtcToIso(n.timestamp) };
}

// ───────────── MAC : port of gas/Code.gs apiRecalculateProductMAC (:790-879) ─────────────
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

// ── audit-logs read shape = GAS apiGetAuditLogs rows (recordAuditLogEntry schema, gas/Code.gs ~1102) ──
// module mapping (spec / src/services/auditService.js moduleMap) ; only whitelisted fields are ever returned (never raw details JSON)
// GAS never maps : every recordAuditLogEntry call defaults/sets module 'PURCHASE' (Code.gs:1090,1107,1157) -> PR/PO rows = PURCHASE.
// Everything else follows the client moduleMap (src/services/auditService.js:211-224) literally, unmapped = 'SYSTEM' (e.g. GRN).
// Server-only entity names are folded onto their client docType: stock_log -> STOCK, budget_transaction -> BUDGET.
const AUDIT_MODULES = new Set(['PURCHASE', 'INVENTORY', 'RBAC', 'BUDGET', 'MASTER', 'SYSTEM']);
const AUDIT_MODULE_MAP = {
  PR: 'PURCHASE', PO: 'PURCHASE', STOCK: 'INVENTORY', STOCK_LOG: 'INVENTORY',
  PRODUCT: 'MASTER', VENDOR: 'MASTER', LOCATION: 'MASTER', USAGE_UNIT: 'MASTER', DEPARTMENT: 'MASTER',
  USER: 'RBAC', SIGNATURE: 'RBAC', AUTH: 'RBAC', BUDGET: 'BUDGET', BUDGET_TRANSACTION: 'BUDGET'
};
// fromClient = row written by POST /api/audit-logs : the module is computed from the (validated) entityType through the map only,
// a module NAME sent by the client (e.g. 'PURCHASE') is never trusted.
export function auditModuleOf(entityType, fromClient = false) {
  const up = String(entityType || '').trim().toUpperCase();
  if (AUDIT_MODULE_MAP[up]) return AUDIT_MODULE_MAP[up];
  return !fromClient && AUDIT_MODULES.has(up) ? up : 'SYSTEM';
}

// ── POST /api/audit-logs guard : a logged-in user must not be able to write rows that look like server evidence ──
// PR/PO rows feed the PR timeline / approval history, so pr/po entity types and every action the server itself writes are refused (400).
// The current client never POSTs here (it logs to localStorage only), so this changes nothing a user sees.
const AUDIT_SERVER_ACTIONS = new Set([
  'CREATE', 'PR_DRAFTED', 'RESUBMIT', 'REVIEW_FORWARD', 'APPROVE', 'SEND_BACK', 'CANCEL', 'PR_UPSERT',
  'PO_CREATED', 'UPDATE_PO', 'GOODS_RECEIVED_FULL', 'GOODS_RECEIVED_PARTIAL', 'PO_SETTLED', 'PO_SETTLEMENT_EDITED', 'PO_ADMIN_ITEM_CHANGE',
  'PRODUCT_STOCK_SET', 'PRODUCT_MAC_RECALC', 'STOCK_LOG', 'STOCK_ISSUE', 'USAGE_UNIT_CREATE', 'USAGE_UNIT_DELETE', 'SIGNATURE_SAVE'
]);
const AUDIT_SERVER_PREFIXES = ['PASSWORD_', 'BUDGET_', 'ORPHAN_', 'FILE_UPLOAD', 'UNSHARE_PUBLIC'];
export function isReservedAuditEntry(a) {
  const action = String((a && a.action) || '').trim().toUpperCase();
  if (AUDIT_SERVER_ACTIONS.has(action) || AUDIT_SERVER_PREFIXES.some((p) => action.startsWith(p))) return true;
  return [a && a.docType, a && a.entityType, a && a.module].some((t) => {
    const x = String(t || '').trim().toLowerCase();
    return x === 'pr' || x === 'po';
  });
}
// Internal bookkeeping actions written by the server's audit() helper that duplicate a real event shown elsewhere and do not exist in GAS :
//  PR_UPSERT = one per PR write, the real event is the PR row (CREATE / APPROVE / SEND_BACK ... with the prAuditId);
//  STOCK_LOG = one per synced stock_logs row, the movement itself is the stock card (GAS writes no audit row for it).
// Rows stay in the table (append-only evidence) ; they are only left out of the default GET list. An explicit ?action= still finds them.
// Real events (PASSWORD_*, BUDGET_*, PRODUCT_STOCK_SET, STOCK_ISSUE, PO_ADMIN_ITEM_CHANGE ...) are NOT here.
export const AUDIT_HIDDEN_ACTIONS = ['PR_UPSERT', 'STOCK_LOG'];
// D1 CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' in UTC ; server rows are ISO. Output is always ISO-Z.
export function auditIsoTime(ts) {
  const s = String(ts ?? '').trim();
  if (!s) return '';
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  const ms = m ? Date.parse(`${m[1]}T${m[2]}${m[3] || ''}${m[4] || 'Z'}`) : Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : s;
}
export function shapeAuditLog(r) {
  let d = {};
  try { const p = JSON.parse(r.details || '{}'); d = p && typeof p === 'object' && !Array.isArray(p) ? p : {}; } catch { d = {}; }
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const ts = auditIsoTime(r.timestamp);
  const docNo = (text(d.docNo) || String(r.entityId || '').trim()).toUpperCase();
  const action = String(r.action || 'ACTION').trim();
  const actorName = text(d.actorName) || text(d.actor) || text(r.uName) || text(r.uUsername) || 'ผู้ใช้งาน';
  const actorRole = text(d.actorRole) || text(r.uTitle) || text(d.roleKey) || text(r.uRoleId);
  const comment = text(d.comment) || text(d.summary) || text(d.text);
  const summary = text(d.summary) || comment || `${action} บนเอกสาร ${docNo}`;
  const changes = Array.isArray(d.changes) ? d.changes : (comment ? [{ field: 'บันทึกเหตุผล', before: '-', after: comment }] : []);
  return {
    id: r.id,
    timestamp: ts,
    createdAt: ts,
    action,
    module: auditModuleOf(r.entityType, r.source === 'client'),
    targetRef: docNo,
    docNo,
    documentNo: docNo,
    prNo: docNo,
    actorName,
    actorRole,
    actor: { id: text(r.uUsername) || String(r.performedBy || '') || 'USER', name: actorName, role: actorRole, department: text(r.uDept) },
    summary,
    details: summary,
    comment,
    note: comment,
    reason: text(d.reason) || comment,
    changes
  };
}

export function computeMovingAverage(logs) {
  let stock = 0;
  let avg = 0;
  for (const l of logs) {
    const qty = Number(l.quantity || 0);
    const unit = Number(l.unitPrice ?? l.unitCost ?? 0) || 0;
    const newStock = stock + qty;
    let newAvg = unit;
    if (stock > 0 && newStock > 0) newAvg = (stock * avg + qty * unit) / newStock;
    avg = round2(newAvg);
    stock = newStock;
  }
  return avg;
}

export async function handleExtraRoutes(ctx) {
  const { request, db, method, path, authUser, viewer, jsonResponse, errorResponse, audit, uid, activeFields } = ctx;

  const seg = (prefix) => (path.startsWith(`${prefix}/`) ? decodeURIComponent(path.slice(prefix.length + 1)) : null);
  const oneSeg = (id) => id !== null && id !== '' && !id.includes('/');
  const noDb = () => (method === 'GET' ? jsonResponse([]) : jsonResponse({ success: false, localMode: true }));
  const nowIso = () => new Date().toISOString();

  // ── usage-units ──
  if (path === '/api/usage-units' || path.startsWith('/api/usage-units/')) {
    const id = seg('/api/usage-units');
    if (path !== '/api/usage-units' && !oneSeg(id)) return null;
    if (!db) return noDb();

    if (method === 'GET' && !id) {
      const dept = new URL(request.url).searchParams.get('department');
      const res = await db.prepare('SELECT * FROM usage_units').all();
      let rows = res.results || [];
      if (dept && dept.toUpperCase() !== 'ALL') {
        const want = normalizeDeptCode(dept);
        rows = rows.filter((u) => normalizeDeptCode(u.department) === want);
      }
      return jsonResponse(rows);
    }

    if ((method === 'POST' && !id) || (method === 'PUT' && id)) {
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('ข้อมูลหน่วยเบิกใช้งานไม่ถูกต้อง', 400);
      if (id && has(body.id) && String(body.id) !== id) return errorResponse('รหัสในข้อมูลไม่ตรงกับรหัสในเส้นทาง', 400); // PUT /x with another id in the body
      const unitId = id || (has(body.id) ? str(body.id, 64) : '');
      if (unitId && !SAFE_ID.test(unitId)) return errorResponse('รหัสหน่วยไม่ถูกต้อง', 400);
      const exists = unitId ? await db.prepare('SELECT * FROM usage_units WHERE id = ? LIMIT 1').bind(unitId).first() : null;
      const name = str(body.name, 200);
      if (!exists && !name) return errorResponse('กรุณาระบุชื่อหน่วย', 400);
      const dept = has(body.department) ? normalizeDeptCode(body.department).slice(0, 40) : null;
      const st = activeFields(body).status;
      // same department rule the client applies before saving master data (MasterDataView -> canAccessDepartmentData)
      if (exists && !canAccessDepartment(authUser, exists.department)) return errorResponse('ไม่มีสิทธิ์ดำเนินการนี้', 403);
      if (!canAccessDepartment(authUser, dept || (exists && exists.department) || 'PD')) return errorResponse('ไม่มีสิทธิ์ดำเนินการนี้', 403);
      if (exists) {
        await db.prepare('UPDATE usage_units SET name = COALESCE(?, name), department = COALESCE(?, department), dot = COALESCE(?, dot), color = COALESCE(?, color), status = COALESCE(?, status) WHERE id = ?')
          .bind(name || null, dept, has(body.dot) ? str(body.dot, 40) : null, has(body.color) ? str(body.color, 40) : null, st, exists.id).run();
        const row = await db.prepare('SELECT * FROM usage_units WHERE id = ?').bind(exists.id).first();
        return jsonResponse(row);
      }
      const newId = unitId || `UNIT-${dept || 'PD'}-${uid().slice(0, 8)}`;
      await db.prepare('INSERT INTO usage_units (id, name, department, dot, color, status) VALUES (?, ?, ?, ?, ?, COALESCE(?, ?))')
        .bind(newId, name, dept || 'PD', has(body.dot) ? str(body.dot, 40) : null, has(body.color) ? str(body.color, 40) : null, st, 'ACTIVE').run();
      await audit('USAGE_UNIT_CREATE', 'usage_unit', newId, { name });
      return jsonResponse(await db.prepare('SELECT * FROM usage_units WHERE id = ?').bind(newId).first());
    }

    if (method === 'DELETE' && id) {
      const row = await db.prepare('SELECT department FROM usage_units WHERE id = ?').bind(id).first();
      if (row && !canAccessDepartment(authUser, row.department)) return errorResponse('ไม่มีสิทธิ์ดำเนินการนี้', 403);
      await db.prepare('DELETE FROM usage_units WHERE id = ?').bind(id).run();
      await audit('USAGE_UNIT_DELETE', 'usage_unit', id, {});
      return jsonResponse({ success: true, id });
    }
    return null;
  }

  // ── PUT /api/storage-locations/:id (the client edits a location with PUT ; POST/GET/DELETE stay in the main router) ──
  if (method === 'PUT' && path.startsWith('/api/storage-locations/')) {
    const id = seg('/api/storage-locations');
    if (!oneSeg(id)) return null;
    if (!db) return noDb();
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('ข้อมูลจุดจัดเก็บไม่ถูกต้อง', 400);
    if (has(body.id) && String(body.id) !== id) return errorResponse('รหัสในข้อมูลไม่ตรงกับรหัสในเส้นทาง', 400);
    const name = has(body.name) ? str(body.name, 200) : null;
    const dept = has(body.department) ? normalizeDeptCode(body.department).slice(0, 40) : null;
    const act = activeFields(body).isActive;
    const cur = await db.prepare('SELECT id, department FROM storage_locations WHERE id = ? LIMIT 1').bind(id).first();
    if (cur && !canAccessDepartment(authUser, cur.department)) return errorResponse('ไม่มีสิทธิ์ดำเนินการนี้', 403);
    if (!canAccessDepartment(authUser, dept || (cur && cur.department) || 'PD')) return errorResponse('ไม่มีสิทธิ์ดำเนินการนี้', 403);
    if (cur) {
      await db.prepare('UPDATE storage_locations SET name = COALESCE(?, name), department = COALESCE(?, department), isActive = COALESCE(?, isActive) WHERE id = ?')
        .bind(name, dept, act, id).run();
    } else {
      await db.prepare('INSERT INTO storage_locations (id, name, department, isActive) VALUES (?, ?, ?, COALESCE(?, 1))').bind(id, name || '', dept || 'PD', act).run();
    }
    const row = await db.prepare('SELECT * FROM storage_locations WHERE id = ?').bind(id).first();
    return jsonResponse({ success: true, ...row });
  }

  // ── notifications ──
  if (path === '/api/notifications' || path.startsWith('/api/notifications/')) {
    const id = seg('/api/notifications');
    if (path !== '/api/notifications' && !oneSeg(id)) return null;
    if (!db) return noDb();

    // rows this user is a recipient of (GAS rule), newest first, examined page by page (500 rows, at most 2000) until 200 are found
    const visibleNotifications = async (since) => {
      const out = [];
      for (let offset = 0; offset < NOTIFY_SCAN_MAX && out.length < NOTIFY_RETURN_MAX; offset += NOTIFY_SCAN_PAGE) {
        const res = await db.prepare(`SELECT * FROM notifications ${since ? 'WHERE timestamp >= ?' : ''} ORDER BY timestamp DESC, rowid DESC LIMIT ? OFFSET ?`)
          .bind(...(since ? [since] : []), NOTIFY_SCAN_PAGE, offset).all();
        const page = res.results || [];
        for (const n of page) {
          if (out.length < NOTIFY_RETURN_MAX && isUserTargetOfNotification(n, viewer)) out.push(n);
        }
        if (page.length < NOTIFY_SCAN_PAGE) break;
      }
      return out;
    };

    if (method === 'GET' && !id) {
      // Newest first, examined page by page (500 rows, at most 2000 rows) and filtered with the GAS recipient rule until 200 are found :
      // the table grows forever but the client only keeps the latest 100 (notificationService). Optional ?since=<ISO> narrows it in SQL.
      // (GAS apiGetNotifications reads and filters the whole sheet ; this is the one deliberate difference.)
      const sinceRaw = new URL(request.url).searchParams.get('since');
      const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? new Date(sinceRaw).toISOString() : null;
      const out = await visibleNotifications(since);
      // this user's own read marks only (one query, ids as one JSON parameter) ; a row an older version marked read in the shared column (status = 'read')
      // stays read for everybody (the behaviour before per-user read state)
      const readSet = new Set();
      if (out.length) {
        try {
          const rr = await db.prepare('SELECT notificationId FROM notification_reads WHERE userId = ? AND notificationId IN (SELECT value FROM json_each(?))').bind(authUser.userId, JSON.stringify(out.map((n) => n.id))).all();
          for (const r of rr.results || []) readSet.add(r.notificationId);
        } catch (e) { console.error('[notifications] read marks failed', e && e.message); }
      }
      return jsonResponse(out.map((n) => shapeNotification(n, readSet.has(n.id) || String(n.status || '').toLowerCase() === 'read')));
    }

    // mark many as read in one call : body { ids?: [...] } (at most 200) or nothing = every notification this user can see. Only notifications the user is a
    // recipient of are written (the list is the same filtered scan as GET) ; anything else in `ids` is ignored without a word.
    if (method === 'PUT' && id === 'read-all') {
      const body = (await readJson(request)) || {};
      const wanted = Array.isArray(body.ids) ? new Set(body.ids.slice(0, NOTIFY_RETURN_MAX).map(String)) : null;
      const mine = (await visibleNotifications(null)).filter((n) => (!wanted || wanted.has(String(n.id))) && String(n.status || '').toLowerCase() !== 'read');
      if (mine.length) await db.prepare('INSERT INTO notification_reads (notificationId, userId, readAt) SELECT value, ?, ? FROM json_each(?) WHERE true ON CONFLICT(notificationId, userId) DO NOTHING').bind(authUser.userId, nowIso(), JSON.stringify(mine.map((n) => n.id))).run();
      return jsonResponse({ success: true, count: mine.length });
    }

    if (method === 'POST' && !id) {
      const body = await readJson(request);
      const list = Array.isArray(body) ? body : [body];
      if (list.length === 0 || list.length > 50 || list.some((n) => !n || typeof n !== 'object' || Array.isArray(n))) return errorResponse('ข้อมูลการแจ้งเตือนไม่ถูกต้อง', 400);
      // allow-list of recipients (the roles the client really addresses) ; creator = the token user, never the body
      for (const n of list) {
        const role = (str(n.targetRole || n.role, 64) || 'ALL').toUpperCase();
        if (!NOTIFICATION_ROLES.has(role)) return errorResponse('targetRole ไม่ถูกต้อง', 400);
        // the types the server itself writes for document events can not be made by hand
        if (SERVER_NOTIFICATION_TYPES.test(str(n.type, 40))) return errorResponse('type ไม่ถูกต้อง', 400);
      }
      const nowMs = Date.now();
      const recent = await db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE createdBy = ? AND createdAtMs > ?').bind(authUser.userId, nowMs - RATE_WINDOW_MS).first();
      if (Number(recent && recent.c) + list.length > NOTIFY_PER_MIN) return errorResponse('ส่งการแจ้งเตือนถี่เกินไป กรุณารอสักครู่', 429);
      const saved = [];
      // A notification reaches a department : ALL / another department's code is only for admin / users who see every department (level >= 3,
      // ALL / *, online purchaser). Anybody else can only address departments they have access to ; otherwise it goes to their own department
      // (the client's dispatch never fails because of this - the notification is still delivered, just not broadcast).
      const senderPerm = resolvePermissions(authUser);
      const senderGlobal = Boolean(senderPerm.isAdmin || senderPerm.canViewAllDepts || senderPerm.onlineish);
      const ownDept = [authUser.primaryDepartment, authUser.department].map(normalizeDeptCode).find((d) => d && !isWildcardDept(d)) || 'ALL';
      for (const n of list) {
        let targetDept = str(n.targetDept || n.targetDepartment || n.department, 40) || 'ALL';
        if (!senderGlobal && (isWildcardDept(targetDept) || !canAccessDepartment(authUser, normalizeDeptCode(targetDept)))) targetDept = ownDept;
        const rec = {
          id: `NTF-${Date.now()}-${uid().slice(0, 8)}`, // always issued here : a caller can not pick (or reserve in advance) an id
          timestamp: nowIso(),
          title: str(n.title, 200) || 'การแจ้งเตือนระบบ',
          message: str(n.message, 2000),
          type: str(n.type, 40) || 'INFO',
          targetDepartment: targetDept,
          targetRole: (str(n.targetRole || n.role, 64) || 'ALL').toUpperCase(),
          docRef: str(n.docRef || n.refNo || n.poNumber || n.prNumber || n.prNo || n.poNo, 100),
          status: 'unread' // always unread on creation (GAS Sheet.gs:462)
        };
        await db.prepare('INSERT INTO notifications (id, timestamp, title, message, type, targetDepartment, targetRole, docRef, status, createdBy, createdAtMs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
          .bind(rec.id, rec.timestamp, rec.title, rec.message, rec.type, rec.targetDepartment, rec.targetRole, rec.docRef, rec.status, authUser.userId, nowMs).run();
        saved.push(shapeNotification(rec, false));
      }
      return jsonResponse(Array.isArray(body) ? { success: true, count: saved.length, notifications: saved } : saved[0]);
    }

    // mark read / unread : written to notification_reads for the TOKEN user only (never the shared status column, never another user's mark),
    // and only for a notification this user is a recipient of. A missing id and a notification of somebody else both answer 404 (IDOR : no hint it exists).
    if (method === 'PUT' && id) {
      const body = (await readJson(request)) || {};
      const row = await db.prepare('SELECT * FROM notifications WHERE id = ? LIMIT 1').bind(id).first();
      if (!row || !isUserTargetOfNotification(row, viewer)) return errorResponse('ไม่พบการแจ้งเตือน', 404);
      const unread = body.isRead === false || body.read === false || String(body.status || '').toLowerCase() === 'unread';
      if (unread) await db.prepare('DELETE FROM notification_reads WHERE notificationId = ? AND userId = ?').bind(id, authUser.userId).run();
      else await db.prepare('INSERT INTO notification_reads (notificationId, userId, readAt) VALUES (?, ?, ?) ON CONFLICT(notificationId, userId) DO NOTHING').bind(id, authUser.userId, nowIso()).run();
      return jsonResponse(shapeNotification(row, !unread));
    }
    return null;
  }

  // ── audit-logs : POST = any logged-in user (identity comes from the token), GET = admin (rbac) ──
  if (path === '/api/audit-logs') {
    if (!db) return noDb();
    if (method === 'POST') {
      const body = await readJson(request);
      const list = Array.isArray(body) ? body : [body];
      if (list.length === 0 || list.length > 100 || list.some((a) => !a || typeof a !== 'object' || Array.isArray(a) || !str(a.action, 100))) {
        return errorResponse('ข้อมูล audit log ไม่ถูกต้อง', 400);
      }
      if (list.some(isReservedAuditEntry)) return errorResponse('ข้อมูล audit log ไม่ถูกต้อง', 400); // server-owned actions / pr / po entities
      const nowMs = Date.now();
      const recent = await db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE source = 'client' AND performedBy = ? AND createdAtMs > ?").bind(authUser.userId, nowMs - RATE_WINDOW_MS).first();
      if (Number(recent && recent.c) + list.length > AUDIT_PER_MIN) return errorResponse('ส่ง audit log ถี่เกินไป กรุณารอสักครู่', 429);
      // rows from this endpoint are marked source = 'client' (server-made audit rows have no source) so they can be told apart / rate limited
      const stmts = list.map((a) => db.prepare("INSERT INTO audit_logs (id, action, entityType, entityId, performedBy, details, timestamp, source, createdAtMs) VALUES (?, ?, ?, ?, ?, ?, ?, 'client', ?)").bind(
        `AUD-${Date.now()}-${uid()}`,
        str(a.action, 100),
        str(a.docType || a.entityType || a.module, 60) || null,
        str(a.docNo || a.entityId || a.targetRef, 100) || null,
        authUser.userId, // never the client-supplied actor
        JSON.stringify({
          roleKey: authUser.roleKey,
          actor: authUser.name || authUser.username || '',
          clientActor: typeof a.actor === 'string' ? str(a.actor, 100) : undefined,
          clientId: has(a.id) ? str(a.id, 100) : undefined,
          department: has(a.department) ? str(a.department, 40) : undefined,
          text: typeof a.details === 'string' ? str(a.details, 2000) : undefined
        }),
        nowIso(),
        nowMs
      ));
      await db.batch(stmts);
      return jsonResponse({ success: true, count: stmts.length });
    }
    if (method === 'GET') {
      const sp = new URL(request.url).searchParams;
      const limit = Math.min(Math.max(parseInt(sp.get('limit') || '500', 10) || 500, 1), 5000);
      const where = [];
      const binds = [];
      const dn = sp.get('docNo') || sp.get('entityId');
      // docNo matches the entity id (PR id) or the document number stored in details (PR rows keep the prNo there)
      if (dn) { where.push("(a.entityId = ? OR (CASE WHEN json_valid(a.details) THEN json_extract(a.details, '$.docNo') END) = ?)"); binds.push(dn, dn); }
      if (sp.get('action')) { where.push('a.action = ?'); binds.push(sp.get('action')); }
      else { where.push(`a.action NOT IN (${AUDIT_HIDDEN_ACTIONS.map(() => '?').join(', ')})`); binds.push(...AUDIT_HIDDEN_ACTIONS); }
      // julianday() reads both 'YYYY-MM-DD HH:MM:SS' (D1 CURRENT_TIMESTAMP) and ISO 'T...Z', so mixed formats sort by real time (plain text order would put ' ' before 'T')
      const res = await db.prepare(`SELECT a.id, a.action, a.entityType, a.entityId, a.performedBy, a.details, a.timestamp, a.source, u.username AS uUsername, u.name AS uName, u.title AS uTitle, u.roleId AS uRoleId, u.department AS uDept
        FROM audit_logs a LEFT JOIN users u ON u.id = a.performedBy ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY julianday(a.timestamp) DESC, a.rowid DESC LIMIT ?`)
        .bind(...binds, limit).all();
      return jsonResponse((res.results || []).map(shapeAuditLog));
    }
    return null;
  }

  // ── signatures (table: roleId, name, signatureUrl, updatedAt, updatedBy) ──
  if (path === '/api/signatures' || path.startsWith('/api/signatures/')) {
    const pathRole = seg('/api/signatures');
    if (path !== '/api/signatures' && !oneSeg(pathRole)) return null;
    if (!db) return noDb();
    if (method === 'GET' && !pathRole) {
      const res = await db.prepare('SELECT * FROM signatures').all();
      return jsonResponse((res.results || []).map((r) => ({ ...r, signature: r.signatureUrl })));
    }
    if ((method === 'POST' && !pathRole) || (method === 'PUT' && pathRole)) {
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('ข้อมูลลายเซ็นไม่ถูกต้อง', 400);
      const roleId = pathRole || str(body.roleId, 64);
      if (!SAFE_ID.test(roleId)) return errorResponse('รหัสตำแหน่งไม่ถูกต้อง', 400);
      const url = String(body.signatureUrl ?? body.signature ?? '');
      // raster data URL (<= ~500 KB) or https link only : svg/html data URLs are refused (the image is rendered on PDFs and pages)
      // same rule as the e-signature on a user (POST/PUT /api/users) : PNG/JPEG/WebP data URL <= 400k chars, or a Drive URL
      const sigErr = checkUserSignature(url);
      if (sigErr) return errorResponse(sigErr, 400);
      await db.prepare(`
        INSERT INTO signatures (roleId, name, signatureUrl, updatedAt, updatedBy) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(roleId) DO UPDATE SET name = COALESCE(excluded.name, signatures.name), signatureUrl = excluded.signatureUrl,
          updatedAt = excluded.updatedAt, updatedBy = excluded.updatedBy
      `).bind(roleId, has(body.name) ? str(body.name, 200) : null, url, nowIso(), authUser.userId).run();
      await audit('SIGNATURE_SAVE', 'signature', roleId, {});
      const row = await db.prepare('SELECT * FROM signatures WHERE roleId = ?').bind(roleId).first();
      return jsonResponse({ ...row, signature: row.signatureUrl, success: true });
    }
    return null;
  }

  // ── POST /api/products/recalculate-mac (GAS apiRecalculateProductMAC) ──
  if (method === 'POST' && path === '/api/products/recalculate-mac') {
    if (!db) return noDb();
    const body = await readJson(request);
    const b = body && typeof body === 'object' ? body : {};
    const key = str(b.productId || b.productCode || b.code || b.id || b.targetSkuOrName, 200);
    if (!key) return errorResponse('VALIDATION_ERROR: Missing target product identifier', 400);
    const prod = await db.prepare(
      'SELECT * FROM products WHERE isDeleted = 0 AND (LOWER(id) = LOWER(?) OR LOWER(code) = LOWER(?) OR LOWER(name) = LOWER(?)) ORDER BY (LOWER(id) = LOWER(?)) DESC LIMIT 1'
    ).bind(key, key, key, key).first();
    if (!prod) return errorResponse(`NOT_FOUND: ไม่พบสินค้า "${key}" ในระบบ`, 404);
    if (!canAccessDepartment(authUser, prod.department || prod.category || 'ALL')) return errorResponse('ไม่มีสิทธิ์ดำเนินการนี้', 403);
    // a log belongs to the product by its productId ; a legacy log with NO productId is matched by code / name AND the product's own department
    // (never a same-code / same-name product of another department - its price must not move this product's MAC)
    // Match rule = GAS apiRecalculateProductMAC (productId == id, code == code / productId == code, name == name) narrowed so another department cannot move this MAC :
    //  - productId equal to this product's id -> counts (exact) ;  productId of ANOTHER existing product -> never ;
    //  - otherwise (no productId, or an id no product has : legacy / imported rows) -> code / name match, and the log's department (normalized) must be
    //    empty / wildcard / this product's / not a department code of any product (e.g. a Thai department name written by the old system)
    const low = (v) => String(v ?? '').trim().toLowerCase();
    const pCode = low(prod.code); const pName = low(prod.name);
    const prodDept = normalizeDeptCode(prod.department || prod.category || '');
    const allProds = (await db.prepare('SELECT id, department, category FROM products').all()).results || [];
    const idSet = new Set(allProds.map((r) => String(r.id)));
    const knownDepts = new Set(allProds.map((r) => normalizeDeptCode(r.department || r.category || '')).filter(Boolean));
    const cand = (await db.prepare(
      "SELECT productId, productCode, productName, department, quantity, unitPrice, unitCost FROM stock_logs WHERE UPPER(type) = 'IN' AND quantity > 0 AND (productId = ? OR LOWER(TRIM(productCode)) = NULLIF(?, '') OR LOWER(TRIM(productId)) = NULLIF(?, '') OR LOWER(TRIM(productName)) = NULLIF(?, '')) ORDER BY createdAt ASC, rowid ASC"
    ).bind(String(prod.id), pCode, pCode, pName).all()).results || [];
    const mine = cand.filter((l) => {
      const lId = String(l.productId ?? '').trim();
      if (lId && lId === String(prod.id)) return true;
      if (lId && idSet.has(lId)) return false;
      const byCode = pCode && (low(l.productCode) === pCode || low(lId) === pCode);
      const byName = pName && low(l.productName) === pName;
      if (!byCode && !byName) return false;
      const ld = normalizeDeptCode(l.department);
      return !ld || isWildcardDept(ld) || !prodDept || ld === prodDept || !knownDepts.has(ld);
    });
    let avg = computeMovingAverage(mine);
    if (avg === 0 && Number(b.averageCost) > 0) avg = Number(b.averageCost); // GAS :858 - caller supplied figure when there is no IN history
    if (avg > 0) {
      const totalValue = Math.round(Number(prod.currentStock || 0) * avg * 100) / 100;
      await db.prepare('UPDATE products SET avgCost = ?, totalValue = ?, updatedAt = CURRENT_TIMESTAMP WHERE id = ?').bind(avg, totalValue, prod.id).run();
      await audit('PRODUCT_MAC_RECALC', 'product', prod.id, { avgCost: avg });
    }
    const product = await db.prepare('SELECT * FROM products WHERE id = ?').bind(prod.id).first();
    return jsonResponse({ success: true, product: productView(product), averageCost: product.avgCost, totalValue: product.totalValue });
  }

  return null;
}
