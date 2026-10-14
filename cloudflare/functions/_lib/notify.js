// Server-made in-app notifications (M7-2) : port of gas/SheetService.gs recordNotification (:414-487) and of the call sites in gas/Code.gs.
// Not a route. ONE helper (notificationStmt) builds the row as a prepared statement so the caller puts it in the SAME db.batch as the document write
// (all or nothing). Title / message / type / targetRole are the GAS strings literally ; targetDept is the department of the document ROW in D1, never the body.
// Rows made here have createdBy = 'SERVER' (they do not count against the per-user POST /api/notifications rate limit).

export const NOTIFY_SERVER_USER = 'SERVER';

const rid = () => (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function' ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8) : String(Math.floor(Math.random() * 1e8)));
const s = (v, max) => String(v === undefined || v === null ? '' : v).slice(0, max);

/**
 * One notification row as a prepared statement (status 'unread', like recordNotification).
 * id : pass a fixed id to make a retried request a no-op (ON CONFLICT DO NOTHING) ; default NTF-{ms}-{random}.
 * whereSql / whereBinds : the same guard as the document write the row travels with (INSERT ... SELECT ... WHERE), so a refused write leaves no row.
 */
export function notificationStmt(db, { type, title, message, targetDept, targetRole, docRef, whereSql, whereBinds }, id) {
  if (!db) return null;
  const now = Date.now();
  const rowId = id || `NTF-${now}-${rid()}`;
  return db.prepare(`INSERT INTO notifications (id, timestamp, title, message, type, targetDepartment, targetRole, docRef, status, createdBy, createdAtMs)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ? WHERE ${whereSql || '1'} ON CONFLICT(id) DO NOTHING`)
    .bind(rowId, new Date(now).toISOString(), s(title || 'การแจ้งเตือนระบบ', 200), s(message, 2000), s(type || 'INFO', 40), s(targetDept || 'ALL', 40), s(targetRole || 'ALL', 64), s(docRef, 100),
      NOTIFY_SERVER_USER, now, ...(whereBinds || []));
}

// ───────────── PR events (gas/Code.gs apiCreatePR :1524, apiApprovePR :1737/:1745, apiRejectPR :1806, apiCancelPR :1912) ─────────────
// act = the audit action of the transition (CREATE / APPROVE / SEND_BACK / CANCEL) ; GAS sends nothing for REVIEW, DRAFT or a re-submit.
const firstStr = (...vals) => { for (const v of vals) if (typeof v === 'string' && v) return v; return ''; };

export function prNotificationParams(act, { dept, prNo, requesterName, body }) {
  const d = dept || 'PD';
  const b = body && typeof body === 'object' ? body : {};
  if (act === 'CREATE') {
    return [{ title: 'มี PR รอการตรวจสอบ / อนุมัติ', message: 'ใบขอซื้อ ' + prNo + ' แผนก ' + d + ' จาก ' + requesterName + ' รอการอนุมัติ', type: 'PR_SUBMITTED', targetDept: d, targetRole: 'Approver', docRef: prNo }];
  }
  if (act === 'APPROVE') {
    return [
      { title: 'PR ได้รับการอนุมัติแล้ว', message: 'ใบขอซื้อ ' + prNo + ' ได้รับการอนุมัติเรียบร้อยแล้ว', type: 'PR_APPROVED', targetDept: d, targetRole: 'Requester', docRef: prNo },
      { title: 'มี PR ใหม่ได้รับการอนุมัติ (พร้อมออก PO)', message: 'ใบขอซื้อ ' + prNo + ' แผนก ' + d + ' ได้รับการอนุมัติแล้ว พร้อมดำเนินการจัดซื้อ', type: 'PR_APPROVED', targetDept: d, targetRole: 'Purchaser', docRef: prNo }
    ];
  }
  if (act === 'SEND_BACK') {
    // the reason of THIS request only (rejectReason / comment ...) ; `reason` of the PR body is the PR's purpose, not the send-back reason
    const reason = firstStr(b.rejectReason, b.rejectionReason, b.returnComment, b.comment, b.revisionReason).slice(0, 500);
    return [{ title: 'PR ไม่อนุมัติ / ส่งกลับแก้ไข', message: 'ใบขอซื้อ ' + prNo + ' ถูกส่งกลับ: ' + (reason || 'โปรดตรวจสอบรายละเอียดและแก้ไข'), type: 'PR_REJECTED', targetDept: d, targetRole: 'Requester', docRef: prNo }];
  }
  if (act === 'CANCEL') {
    // cancel reason of THIS request only (never an old rejectReason / the PR's purpose stored on the PR)
    const reason = firstStr(b.cancelReason, b.comment).slice(0, 500);
    return [{ title: 'PR ถูกยกเลิกและคืนงบประมาณแล้ว', message: 'ใบขอซื้อ ' + prNo + ' ถูกยกเลิก' + (reason ? (' (' + reason + ')') : '') + ' และคืนงบประมาณเรียบร้อยแล้ว', type: 'PR_CANCELLED', targetDept: d, targetRole: 'ALL', docRef: prNo }];
  }
  return [];
}

// ───────────── PO events (apiSavePO :2457 / :2475 / :2517, apiReceivePO :2966-2990) ─────────────
// prev = the stored row before the write ({ status, extra }) or null ; next = { status, body } as written. Only the transitions GAS reacts to.
const parseObj = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string' && v) { try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } }
  return null;
};

export function poSaveNotificationParams({ prev, status, body, dept, poNo }) {
  const out = [];
  const b = body && typeof body === 'object' ? body : {};
  const d = dept || 'ALL';
  const prevStatus = prev ? prev.status : undefined;
  const prevExtra = (prev && prev.extra) || {};
  if (status === 'CANCELLED' && prevStatus !== 'CANCELLED') {
    out.push({ title: 'PO ถูกยกเลิกและคืนงบประมาณแล้ว', message: 'ใบสั่งซื้อ ' + poNo + ' ถูกยกเลิกและคืนงบประมาณเรียบร้อยแล้ว', type: 'PO_CANCELLED', targetDept: d, targetRole: 'ALL', docRef: poNo });
  }
  const wasOrdered = Boolean(prev) && (prevStatus === 'ORDERED' || prevExtra.orderStatus === 'ORDERED');
  const isNowOrdered = status === 'ORDERED' || b.orderStatus === 'ORDERED';
  if (isNowOrdered && !wasOrdered) {
    out.push({ title: 'สินค้าสั่งซื้อแล้ว (รอรับของ)', message: 'ใบสั่งซื้อ ' + poNo + ' ได้รับการยืนยันการสั่งซื้อแล้ว อยู่ระหว่างการจัดส่ง', type: 'ONLINE_ORDERED', targetDept: d, targetRole: 'Requester', docRef: poNo });
  }
  const res = parseObj(b.claimResolution);
  const liveRes = parseObj(prevExtra.claimResolution);
  if (res && res.type && (!liveRes || liveRes.resolvedAt !== res.resolvedAt)) {
    const refund = Number(res.refundAmount);
    out.push({
      title: 'เคลมสินค้าสำเร็จ / คืนเงินเรียบร้อย',
      message: 'ใบสั่งซื้อ ' + poNo + ' จัดการเคลมสำเร็จ' + (refund > 0 ? (' ได้รับเงินคืน ฿' + refund.toLocaleString('en-US')) : ''),
      type: 'PO_CLAIM_CLOSED', targetDept: d, targetRole: 'Purchaser', docRef: poNo
    });
  }
  return out;
}

// cyrb53 : small non-crypto 53-bit string hash (ids only, nothing secret)
function idHash(str) {
  let h1 = 0xdeadbeef; let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function poReceiveNotificationParams({ closed, dept, poNo }) {
  const d = dept || 'ALL';
  if (closed) {
    return [{ title: 'ตรวจรับสินค้าเข้าคลังเรียบร้อย', message: 'ใบสั่งซื้อ ' + poNo + ' ได้รับสินค้าครบถ้วนและเข้าคลังเรียบร้อยแล้ว', type: 'GOODS_RECEIVED', targetDept: d, targetRole: 'Purchaser', docRef: poNo }];
  }
  const base = { title: 'ตรวจรับสินค้าบางส่วน / มีรายการค้างรับ-รอเคลม', message: 'ใบสั่งซื้อ ' + poNo + ' ตรวจรับบางส่วน มีรายการค้างรับหรือรอเคลม', type: 'PO_CLAIM', targetDept: d, docRef: poNo };
  return [{ ...base, targetRole: 'Purchaser' }, { ...base, targetRole: 'Requester' }];
}

/** params list -> statements (ids derived from `idBase` when given, so a retried request hits the same ids). */
export function notificationStmts(db, list, { idBase, whereSql, whereBinds } = {}) {
  // id = NTF-{first 60 chars of idBase}~{hash of the WHOLE idBase}-{i} : deterministic (a retry hits the same id) and two long idBase that share a prefix never collide
  const idOf = (i) => `NTF-${String(idBase).slice(0, 60)}~${idHash(String(idBase))}-${i}`;
  return (list || []).map((p, i) => notificationStmt(db, { ...p, whereSql, whereBinds }, idBase ? idOf(i) : undefined)).filter(Boolean);
}
