import { STORAGE_KEYS } from '../config/constants.js';
import { logAuditEvent } from './auditLogger.js';

/**
 * Format timestamp strictly in Thailand time (Asia/Bangkok UTC+7)
 * Output format: YYYY-MM-DD HH:mm:ss
 */
export const formatLocalTimestamp = (date = new Date()) => {
  if (!date) return '';
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date.trim())) {
    return date.trim();
  }
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return String(date);
  // ใช้ locale 'sv-SE' ร่วมกับ timeZone 'Asia/Bangkok' เพื่อให้ได้รูปแบบ YYYY-MM-DD HH:mm:ss เวลาไทย
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(d).replace('T', ' ');
};

/**
 * Resolves current user session from localStorage or sessionStorage as fallback
 */
function resolveCurrentUser() {
  try {
    if (typeof localStorage !== 'undefined') {
      const authSession = localStorage.getItem('prpo_auth_session');
      if (authSession) {
        const parsed = JSON.parse(authSession);
        if (parsed && (parsed.name || parsed.username || parsed.employeeName)) {
          return parsed;
        }
      }
      const currentRole = localStorage.getItem('prpo_current_role');
      if (currentRole) {
        const parsed = JSON.parse(currentRole);
        if (parsed && (parsed.name || parsed.title)) {
          return parsed;
        }
      }
    }
    if (typeof sessionStorage !== 'undefined') {
      const sessionUser = sessionStorage.getItem('current_user') || sessionStorage.getItem('prpo_auth_session');
      if (sessionUser) {
        const parsed = JSON.parse(sessionUser);
        if (parsed && (parsed.name || parsed.username)) {
          return parsed;
        }
      }
    }
  } catch (e) {}
  return null;
}

/**
 * Format audit details in clear, human-readable Thai
 */
function formatThaiAuditDetails(action, docType, docNo, details) {
  let text = String(details || '').trim();
  const act = String(action || '').toUpperCase();
  const type = String(docType || '').toUpperCase();
  const ref = String(docNo || '').trim();

  // If text is empty, generate standard Thai description
  if (!text) {
    if (act === 'LOGIN') return `เข้าสู่ระบบสำเร็จ (Username: ${ref || 'user'})`;
    if (act === 'LOGOUT') return `ออกจากระบบสำเร็จ (Username: ${ref || 'user'})`;
    if (type === 'PRODUCT') {
      return act.includes('CREATE') ? `เพิ่มสินค้าใหม่: [${ref}]` : `แก้ไขข้อมูลสินค้า: [${ref}]`;
    }
    if (type === 'PR') {
      return `สร้างใบขอซื้อ PR: ${ref}`;
    }
    if (type === 'PO') {
      return `สร้างใบสั่งซื้อ PO: ${ref}`;
    }
    if (type === 'STOCK') {
      return `เบิกจ่ายพัสดุ: [${ref}]`;
    }
    return `บันทึกกิจกรรม ${act}: ${ref}`;
  }

  // Polish common English/generic details
  if (act === 'LOGIN' && !text.includes('เข้าสู่ระบบ')) {
    return `เข้าสู่ระบบสำเร็จ (Username: ${ref || 'user'})`;
  }
  if (act === 'LOGOUT' && !text.includes('ออกจากระบบ')) {
    return `ออกจากระบบสำเร็จ (Username: ${ref || 'user'})`;
  }

  return text;
}

/**
 * Audit Service for tracking all system actions, document status changes, 
 * master data edits, stock movements, and signature updates.
 * Features Smart Middleware with garbage prevention, fallback enrichment, and IP capture.
 */
export const auditService = {
  /**
   * Log an audit event
   * @param {Object} params
   * @param {string} params.action - E.g. 'LOGIN', 'LOGOUT', 'CREATE', 'UPDATE', 'DELETE', 'PR_SUBMITTED', 'STOCK_ISSUE', etc.
   * @param {Object|string} [params.actor] - User object or name string
   * @param {string} [params.department] - 'PD', 'QC', 'PURCHASING', etc.
   * @param {string} [params.docNo] - Document number or entity ID (SKU, PR no, PO no, etc.)
   * @param {string} [params.docType] - 'USER', 'PRODUCT', 'VENDOR', 'LOCATION', 'PR', 'PO', 'STOCK', 'AUTH', 'SYSTEM'
   * @param {string} params.details - Detailed human-readable Thai description
   * @param {Object} [params.changes] - { before, after } or extra key-value context
   */
  logAction({ action, actor, department, docNo, docType = 'SYSTEM', details, changes = null }) {
    try {
      const now = new Date();
      const localTimeStr = formatLocalTimestamp(now);
      const cleanAction = String(action || '').trim().toUpperCase();
      const cleanDocType = String(docType || 'SYSTEM').trim().toUpperCase();
      const cleanDocNo = String(docNo || '').trim();
      let cleanDetails = String(details || '').trim();

      const isSystemEvent = cleanAction.includes('SYSTEM') || cleanAction.includes('INIT') || cleanAction.includes('CACHE') || cleanAction.includes('CLEAR') || cleanDocType === 'SYSTEM';
      const isAuthEvent = cleanAction === 'LOGIN' || cleanAction === 'LOGOUT' || cleanDocType === 'AUTH' || cleanDocType === 'USER';
      const hasDocRef = Boolean(cleanDocNo && cleanDocNo !== '-' && cleanDocType);

      // Smart Garbage Prevention Filter:
      // If no details OR (no docType/docNo and not System Event and not Auth Event) -> DO NOT LOG
      if (!cleanDetails && !hasDocRef && !isSystemEvent && !isAuthEvent) {
        return null;
      }
      if (!cleanDetails && !isSystemEvent && !isAuthEvent) {
        return null;
      }
      if (!hasDocRef && !isSystemEvent && !isAuthEvent) {
        return null;
      }

      cleanDetails = formatThaiAuditDetails(cleanAction, cleanDocType, cleanDocNo, cleanDetails);

      // Fallback Enrichment for Actor
      let resolvedActorName = '';
      let resolvedActorRole = '';
      let resolvedActorDept = '';

      if (typeof actor === 'object' && actor !== null) {
        resolvedActorName = actor.name || actor.displayName || actor.employeeName || actor.username || actor.title || actor.id || '';
        resolvedActorRole = actor.title || actor.roleTitle || actor.canonicalRole || actor.roleId || actor.role || '';
        resolvedActorDept = actor.department || actor.primaryDepartment || '';
      } else if (typeof actor === 'string' && actor.trim()) {
        resolvedActorName = actor.trim();
      }

      // Fallback enrichment from current active session
      if (!resolvedActorName || resolvedActorName === 'System' || resolvedActorName === 'Unknown User') {
        const sessionUser = resolveCurrentUser();
        if (sessionUser) {
          resolvedActorName = sessionUser.name || sessionUser.displayName || sessionUser.employeeName || sessionUser.username || resolvedActorName;
          if (!resolvedActorRole || resolvedActorRole === 'System') {
            resolvedActorRole = sessionUser.title || sessionUser.roleTitle || sessionUser.canonicalRole || sessionUser.roleId || sessionUser.role || 'Staff';
          }
          if (!resolvedActorDept || resolvedActorDept === 'SYSTEM' || resolvedActorDept === 'GENERAL') {
            resolvedActorDept = sessionUser.department || sessionUser.primaryDepartment || 'PD';
          }
        }
      }

      if (!resolvedActorName) resolvedActorName = 'ระบบอัตโนมัติ (System)';
      if (!resolvedActorRole) resolvedActorRole = 'Staff';
      if (!resolvedActorDept) resolvedActorDept = department || 'GENERAL';

      // Client IP & Environment detection
      let clientIp = 'CLIENT_DIRECT';
      try {
        if (typeof sessionStorage !== 'undefined') {
          clientIp = sessionStorage.getItem('client_ip') || clientIp;
        }
      } catch (e) {}

      const clientEnv = (typeof navigator !== 'undefined' && navigator.userAgent) 
        ? navigator.userAgent.slice(0, 150) 
        : 'React Web App';

      const logEntry = {
        id: `AUD-${now.getTime()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`,
        timestamp: localTimeStr,
        timeFormatted: localTimeStr,
        action: cleanAction,
        docType: cleanDocType,
        docNo: cleanDocNo || '-',
        details: cleanDetails,
        actorName: resolvedActorName,
        department: resolvedActorDept,
        actorRole: resolvedActorRole,
        clientIp: clientIp,
        clientEnv: clientEnv,
        changes: changes ? JSON.stringify(changes) : ''
      };

      // Save to localStorage
      const existing = this.getLogs();
      const updated = [logEntry, ...existing].slice(0, 1000); // Keep latest 1000 logs
      localStorage.setItem(STORAGE_KEYS.AUDIT_LOGS || 'prpo_audit_logs', JSON.stringify(updated));

      // Also forward to centralized auditLogger for app_audit_logs
      try {
        const moduleMap = {
          PR: 'PURCHASE',
          PO: 'PURCHASE',
          STOCK: 'INVENTORY',
          PRODUCT: 'MASTER',
          VENDOR: 'MASTER',
          LOCATION: 'MASTER',
          USAGE_UNIT: 'MASTER',
          DEPARTMENT: 'MASTER',
          USER: 'RBAC',
          SIGNATURE: 'RBAC',
          AUTH: 'RBAC',
          BUDGET: 'BUDGET'
        };
        let normAction = 'UPDATE';
        if (cleanAction.includes('APPROV')) normAction = 'APPROVE';
        else if (cleanAction.includes('REJECT') || cleanAction.includes('CANCEL')) normAction = 'REJECT';
        else if (cleanAction.includes('RECEIV') || cleanAction.includes('ISSUE')) normAction = 'RECEIVE';
        else if (cleanAction.includes('CREATE') || cleanAction.includes('NEW') || cleanAction.includes('SUBMIT')) normAction = 'CREATE';
        else if (cleanAction.includes('DELETE') || cleanAction.includes('REMOVE')) normAction = 'DELETE';
        else if (cleanAction.includes('LOGIN')) normAction = 'LOGIN';
        else if (cleanAction.includes('LOGOUT')) normAction = 'LOGOUT';

        logAuditEvent({
          action: normAction,
          module: moduleMap[cleanDocType] || 'SYSTEM',
          targetRef: cleanDocNo || '-',
          summary: cleanDetails,
          changes,
          currentUser: { name: resolvedActorName, role: resolvedActorRole, department: resolvedActorDept }
        });
      } catch (logErr) {
        console.warn('[AuditService] auditLogger sync error:', logErr);
      }

      return logEntry;
    } catch (err) {
      console.error('[AuditService] Error writing audit log:', err);
      return null;
    }
  },

  /**
   * Get filtered audit logs
   */
  getLogs(filters = {}) {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.AUDIT_LOGS || 'prpo_audit_logs');
      const logs = raw ? JSON.parse(raw) : [];

      return logs.filter(log => {
        if (filters.department && filters.department !== 'ALL' && log.department !== filters.department) {
          return false;
        }
        if (filters.docType && filters.docType !== 'ALL' && log.docType !== filters.docType) {
          return false;
        }
        if (filters.action && filters.action !== 'ALL' && log.action !== filters.action) {
          return false;
        }
        if (filters.searchQuery) {
          const q = filters.searchQuery.toLowerCase();
          const matchDoc = (log.docNo || '').toLowerCase().includes(q);
          const matchActor = (log.actorName || '').toLowerCase().includes(q);
          const matchDetails = (log.details || '').toLowerCase().includes(q);
          const matchAction = (log.action || '').toLowerCase().includes(q);
          if (!matchDoc && !matchActor && !matchDetails && !matchAction) return false;
        }
        return true;
      });
    } catch (err) {
      console.error('[AuditService] Error getting audit logs:', err);
      return [];
    }
  },

  /**
   * Clear all audit logs (Admin function)
   */
  clearLogs() {
    localStorage.removeItem(STORAGE_KEYS.AUDIT_LOGS || 'prpo_audit_logs');
  }
};
