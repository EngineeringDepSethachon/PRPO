/**
 * Audit Logger Service
 * Centralized logging service for tracking critical system actions:
 * - Master Data modifications
 * - PR/PO Lifecycle & Workflow (Create, Review, Approve, Reject, Receive)
 * - Stock Movements & Quick Issues
 * - RBAC & User Administration
 *
 * Stores entries in localStorage under key 'app_audit_logs' (capped at 500 records).
 */

import { formatLocalTimestamp } from '../utils/timeUtils.js';

export const AUDIT_STORAGE_KEY = 'app_audit_logs';
const MAX_LOG_ENTRIES = 500;

// Listeners for real-time reactivity
const listeners = new Set();

/**
 * Helper to normalize actor info from currentUser object or string
 */
export function extractActorInfo(currentUser) {
  if (!currentUser) {
    return {
      id: 'SYSTEM',
      name: 'ระบบอัตโนมัติ (System)',
      role: 'System Engine',
      department: 'SYSTEM'
    };
  }

  if (typeof currentUser === 'string') {
    return {
      id: 'USER',
      name: currentUser,
      role: 'User',
      department: 'GENERAL'
    };
  }

  return {
    id: currentUser.id || currentUser.userId || currentUser.username || 'USR-ANON',
    name: currentUser.name || currentUser.title || currentUser.username || 'ผู้ใช้งานระบบ',
    role: currentUser.title || currentUser.roleTitle || currentUser.role || currentUser.roleId || 'Staff',
    department: currentUser.department || currentUser.primaryDepartment || (Array.isArray(currentUser.assignedDepartments) ? currentUser.assignedDepartments.join(', ') : 'ALL')
  };
}

/**
 * Standardize changes to a uniform array format: [{ field, before, after }]
 */
export function normalizeChanges(changes) {
  if (!changes) return [];
  if (Array.isArray(changes)) {
    return changes.map(item => ({
      field: item.field || item.key || item.name || 'การแก้ไข',
      before: item.before !== undefined ? item.before : (item.oldValue !== undefined ? item.oldValue : '-'),
      after: item.after !== undefined ? item.after : (item.newValue !== undefined ? item.newValue : '-')
    }));
  }

  if (typeof changes === 'object') {
    // If it's already { field, before, after }
    if ('field' in changes || 'before' in changes || 'after' in changes) {
      return [{
        field: changes.field || 'การแก้ไข',
        before: changes.before !== undefined ? changes.before : '-',
        after: changes.after !== undefined ? changes.after : '-'
      }];
    }
    // If it's a key-value diff object: { status: { before: 'A', after: 'B' } }
    return Object.entries(changes).map(([key, val]) => {
      if (val && typeof val === 'object' && ('before' in val || 'after' in val)) {
        return {
          field: key,
          before: val.before !== undefined ? val.before : '-',
          after: val.after !== undefined ? val.after : '-'
        };
      }
      return {
        field: key,
        before: '-',
        after: typeof val === 'object' ? JSON.stringify(val) : String(val)
      };
    });
  }

  return [{
    field: 'บันทึกการเปลี่ยนแปลง',
    before: '-',
    after: String(changes)
  }];
}

/**
 * Primary Audit Event Logger
 * @param {Object} params
 * @param {string} params.action - 'CREATE', 'UPDATE', 'APPROVE', 'REJECT', 'RECEIVE', etc.
 * @param {string} params.module - 'PURCHASE', 'INVENTORY', 'MASTER', 'RBAC', 'BUDGET', 'SYSTEM'
 * @param {string} params.targetRef - Document or entity reference code (e.g. 'PR-PD-2603-001')
 * @param {string} params.summary - Human-readable summary in Thai
 * @param {Object|Array} [params.changes] - Changes payload { field, before, after }
 * @param {Object|string} [params.currentUser] - Actor context
 */
export function logAuditEvent({ action, module = 'SYSTEM', targetRef = '-', summary, changes = null, currentUser = null }) {
  try {
    const now = new Date();
    const actor = extractActorInfo(currentUser);
    const normalizedChanges = normalizeChanges(changes);

    const logEntry = {
      id: `AUD-${now.getTime()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`,
      timestamp: formatLocalTimestamp(now),
      timeFormatted: formatLocalTimestamp(now),
      action: (action || 'UPDATE').toUpperCase(),
      module: (module || 'SYSTEM').toUpperCase(),
      targetRef: targetRef || '-',
      summary: summary || `ดำเนินการ ${action} บน ${targetRef}`,
      actor,
      changes: normalizedChanges,
      hasDiff: normalizedChanges.length > 0
    };

    // Retrieve existing logs
    const existing = getAuditLogs();
    const updated = [logEntry, ...existing].slice(0, MAX_LOG_ENTRIES);

    localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(updated));

    // Also mirror to prpo_audit_logs for legacy compatibility
    try {
      localStorage.setItem('prpo_audit_logs', JSON.stringify(updated));
    } catch (_) {}

    // Dispatch custom browser event
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('app_audit_logs_updated', { detail: logEntry }));
    }

    // Notify in-memory listeners
    listeners.forEach(fn => {
      try { fn(logEntry); } catch (e) { console.error('[auditLogger] listener error:', e); }
    });
    return logEntry;
  } catch (err) {
    console.error('[AuditLogger] Failed to log audit event:', err);
    return null;
  }
}

/**
 * Retrieve logs with optional filtering
 */
export function getAuditLogs(filters = {}) {
  try {
    let raw = localStorage.getItem(AUDIT_STORAGE_KEY);
    // Fallback check on prpo_audit_logs
    if (!raw) {
      raw = localStorage.getItem('prpo_audit_logs');
    }

    let logs = [];
    if (raw) {
      logs = JSON.parse(raw);
    } else {
      // Seed with initial realistic logs if completely empty
      logs = seedInitialAuditLogs();
      localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(logs));
    }

    return logs.filter(log => {
      // Module filter
      if (filters.module && filters.module !== 'ALL' && log.module !== filters.module) {
        return false;
      }
      // Action filter
      if (filters.action && filters.action !== 'ALL' && log.action !== filters.action) {
        return false;
      }
      // Date range filter
      if (filters.startDate) {
        const logDate = new Date(log.timestamp);
        const start = new Date(filters.startDate);
        start.setHours(0, 0, 0, 0);
        if (logDate < start) return false;
      }
      if (filters.endDate) {
        const logDate = new Date(log.timestamp);
        const end = new Date(filters.endDate);
        end.setHours(23, 59, 59, 999);
        if (logDate > end) return false;
      }
      // Global Search
      if (filters.searchQuery) {
        const q = filters.searchQuery.trim().toLowerCase();
        const matchRef = (log.targetRef || '').toLowerCase().includes(q);
        const matchActor = (log.actor?.name || '').toLowerCase().includes(q) || 
                           (log.actor?.id || '').toLowerCase().includes(q) ||
                           (log.actor?.department || '').toLowerCase().includes(q);
        const matchSummary = (log.summary || '').toLowerCase().includes(q);
        const matchAction = (log.action || '').toLowerCase().includes(q);
        const matchModule = (log.module || '').toLowerCase().includes(q);
        if (!matchRef && !matchActor && !matchSummary && !matchAction && !matchModule) {
          return false;
        }
      }
      return true;
    });
  } catch (err) {
    console.error('[AuditLogger] Error reading logs:', err);
    return [];
  }
}

/**
 * Clear all logs
 */
export function clearAuditLogs() {
  localStorage.removeItem(AUDIT_STORAGE_KEY);
  localStorage.removeItem('prpo_audit_logs');
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('app_audit_logs_updated', { detail: null }));
  }
  listeners.forEach(fn => {
    try { fn(null); } catch (e) {}
  });
}

/**
 * Subscribe to audit log changes
 */
export function subscribeAuditLogs(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * Export logs to CSV with UTF-8 BOM for Excel compatibility
 */
export function exportAuditLogsToCSV(logsToExport = null) {
  const logs = logsToExport || getAuditLogs();
  if (!logs || logs.length === 0) {
    alert('ไม่มีข้อมูลสำหรับส่งออก');
    return;
  }

  const headers = [
    'Log ID',
    'Timestamp (ISO)',
    'Date & Time (Thai)',
    'Module',
    'Action',
    'Target Ref',
    'Actor Name',
    'Actor Role',
    'Actor Department',
    'Summary',
    'Changes (Diff)'
  ];

  const escapeCSV = (str) => {
    if (str === null || str === undefined) return '""';
    const s = String(str).replace(/"/g, '""');
    return `"${s}"`;
  };

  const rows = logs.map(log => {
    const diffText = Array.isArray(log.changes) && log.changes.length > 0
      ? log.changes.map(c => `[${c.field}: "${c.before}" -> "${c.after}"]`).join(' | ')
      : '-';

    return [
      escapeCSV(log.id),
      escapeCSV(formatLocalTimestamp(log.timestamp || log.createdAt || log.timeFormatted)),
      escapeCSV(formatLocalTimestamp(log.timeFormatted || log.timestamp || log.createdAt)),
      escapeCSV(log.module),
      escapeCSV(log.action),
      escapeCSV(log.targetRef),
      escapeCSV(log.actor?.name || '-'),
      escapeCSV(log.actor?.role || '-'),
      escapeCSV(log.actor?.department || '-'),
      escapeCSV(log.summary),
      escapeCSV(diffText)
    ].join(',');
  });

  // UTF-8 BOM for Thai language Excel support
  const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const nowStr = new Date().toISOString().slice(0, 10);
  link.setAttribute('href', url);
  link.setAttribute('download', `Audit_Logs_${nowStr}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Realistic initial seed logs for rich demonstration
 */
export function seedInitialAuditLogs() {
  const now = Date.now();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  return [
    {
      id: `AUD-${now - 5 * minute}-A101`,
      timestamp: formatLocalTimestamp(new Date(now - 5 * minute)),
      timeFormatted: formatLocalTimestamp(new Date(now - 5 * minute)),
      action: 'APPROVE',
      module: 'PURCHASE',
      targetRef: 'PR-PD-2603-001',
      summary: 'อนุมัติใบขอซื้อวัตถุดิบแป้งสาลีและสารปรุงแต่ง (ยอดเงิน 45,200.00 บาท)',
      actor: { id: 'U003', name: 'สุรชัย บริหารการผลิต', role: 'Plant Manager', department: 'PD' },
      changes: [
        { field: 'สถานะเอกสาร', before: 'WAITING_APPROVAL', after: 'APPROVED' },
        { field: 'ผู้ลงนามขั้นสุดท้าย', before: '-', after: 'สุรชัย บริหารการผลิต' }
      ],
      hasDiff: true
    },
    {
      id: `AUD-${now - 25 * minute}-B202`,
      timestamp: formatLocalTimestamp(new Date(now - 25 * minute)),
      timeFormatted: formatLocalTimestamp(new Date(now - 25 * minute)),
      action: 'RECEIVE',
      module: 'INVENTORY',
      targetRef: 'PO-2603-002',
      summary: 'ตรวจรับพัสดุเข้าคลังสินค้าสำเร็จรูป ห้อง K1 (50 ถุง)',
      actor: { id: 'U002', name: 'สมศรี มีวินัย', role: 'Reviewer / Asst. Manager', department: 'QC' },
      changes: [
        { field: 'สถานะ PO', before: 'ORDERED', after: 'RECEIVED' },
        { field: 'ยอดคงคลัง SKU-FLOUR-01', before: '120 ถุง', after: '170 ถุง (+50)' },
        { field: 'สถานที่จัดเก็บ', before: '-', after: 'ห้อง K1' }
      ],
      hasDiff: true
    },
    {
      id: `AUD-${now - 45 * minute}-C303`,
      timestamp: formatLocalTimestamp(new Date(now - 45 * minute)),
      timeFormatted: formatLocalTimestamp(new Date(now - 45 * minute)),
      action: 'UPDATE',
      module: 'MASTER',
      targetRef: 'SKU-CHOC-02',
      summary: 'ปรับปรุงราคาอ้างอิงและจุดสั่งซื้อใหม่ของ ผงช็อกโกแลตเข้มข้น 100%',
      actor: { id: 'ADMIN-01', name: 'ผู้ดูแลระบบกลาง (Admin)', role: 'System Admin', department: 'IT' },
      changes: [
        { field: 'ราคาต่อหน่วย (Price/Unit)', before: '125.00 ฿', after: '138.50 ฿' },
        { field: 'จุดสั่งซื้อต่ำสุด (Min Stock)', before: '30 กล่อง', after: '45 กล่อง' }
      ],
      hasDiff: true
    },
    {
      id: `AUD-${now - 2 * hour}-D404`,
      timestamp: formatLocalTimestamp(new Date(now - 2 * hour)),
      timeFormatted: formatLocalTimestamp(new Date(now - 2 * hour)),
      action: 'CREATE',
      module: 'PURCHASE',
      targetRef: 'PO-2603-005',
      summary: 'สร้างใบสั่งซื้อ PO จาก PR-QC-2603-002 ผู้ขาย: บจก. สยามเคมีคอล',
      actor: { id: 'U005', name: 'วรรณา จัดซื้อไว', role: 'Purchaser Online', department: 'PURCHASING' },
      changes: [
        { field: 'เลขที่ PO', before: '-', after: 'PO-2603-005' },
        { field: 'ผู้จำหน่าย (Vendor)', before: '-', after: 'บจก. สยามเคมีคอล' },
        { field: 'มูลค่าสุทธิ (Total)', before: '0.00 ฿', after: '18,500.00 ฿' }
      ],
      hasDiff: true
    },
    {
      id: `AUD-${now - 3 * hour}-E505`,
      timestamp: formatLocalTimestamp(new Date(now - 3 * hour)),
      timeFormatted: formatLocalTimestamp(new Date(now - 3 * hour)),
      action: 'UPDATE',
      module: 'RBAC',
      targetRef: 'USER-QC-002',
      summary: 'ปรับเปลี่ยนบทบาทและสิทธิ์การอนุมัติของผู้ใช้งาน: นายนิรันดร์ ตรวจสอบ',
      actor: { id: 'ADMIN-01', name: 'ผู้ดูแลระบบกลาง (Admin)', role: 'System Admin', department: 'IT' },
      changes: [
        { field: 'บทบาท (Role)', before: 'REQUESTER', after: 'REVIEWER' },
        { field: 'สิทธิ์ตรวจทาน PR (canReview)', before: 'false', after: 'true' },
        { field: 'ระดับสิทธิ์ (Level)', before: '1', after: '2' }
      ],
      hasDiff: true
    },
    {
      id: `AUD-${now - 5 * hour}-F606`,
      timestamp: formatLocalTimestamp(new Date(now - 5 * hour)),
      timeFormatted: formatLocalTimestamp(new Date(now - 5 * hour)),
      action: 'REJECT',
      module: 'PURCHASE',
      targetRef: 'PR-PD-2603-004',
      summary: 'ตีกลับใบขอซื้อ: เกินกรอบวงเงินงบประมาณประจำไตรมาส 1 ฝ่ายผลิต',
      actor: { id: 'U003', name: 'สุรชัย บริหารการผลิต', role: 'Plant Manager', department: 'PD' },
      changes: [
        { field: 'สถานะเอกสาร', before: 'WAITING_APPROVAL', after: 'REJECTED' },
        { field: 'เหตุผลการตีกลับ', before: '-', after: 'งบประมาณหมวดวัตถุดิบเกินโควต้า ให้ลดปริมาณสั่งซื้อลง 20%' }
      ],
      hasDiff: true
    },
    {
      id: `AUD-${now - 1 * day}-G707`,
      timestamp: formatLocalTimestamp(new Date(now - 1 * day)),
      timeFormatted: formatLocalTimestamp(new Date(now - 1 * day)),
      action: 'CREATE',
      module: 'MASTER',
      targetRef: 'VN-SUP-888',
      summary: 'เพิ่มข้อมูลคู่ค้าใหม่: บริษัท เจริญภัณฑ์ แพคเกจจิ้ง จำกัด (เครดิตเทอม 30 วัน)',
      actor: { id: 'ADMIN-01', name: 'ผู้ดูแลระบบกลาง (Admin)', role: 'System Admin', department: 'IT' },
      changes: [
        { field: 'รหัสผู้ขาย', before: '-', after: 'VN-SUP-888' },
        { field: 'ชื่อสถานประกอบการ', before: '-', after: 'บริษัท เจริญภัณฑ์ แพคเกจจิ้ง จำกัด' },
        { field: 'เครดิตเทอม (Credit Term)', before: '-', after: '30 วัน' }
      ],
      hasDiff: true
    },
    {
      id: `AUD-${now - 2 * day}-H808`,
      timestamp: formatLocalTimestamp(new Date(now - 2 * day)),
      timeFormatted: formatLocalTimestamp(new Date(now - 2 * day)),
      action: 'RECEIVE',
      module: 'INVENTORY',
      targetRef: 'RM-SUGAR-05',
      summary: 'เบิกจ่ายด่วน (Quick Issue) น้ำตาลทรายขาวบริสุทธิ์ 15 กก. ไปยังห้องแพ็ค',
      actor: { id: 'U001', name: 'สมชาย นักผลิต', role: 'Requester Staff', department: 'PD' },
      changes: [
        { field: 'ประเภทรายการ', before: '-', after: 'เบิกจ่ายด่วน (QUICK_ISSUE)' },
        { field: 'ปริมาณเบิกจ่าย', before: '-', after: '15 กก.' },
        { field: 'หน่วยงานปลายทาง', before: '-', after: 'ห้องแพ็ค (PD)' }
      ],
      hasDiff: true
    }
  ];
}

export const auditLogger = {
  logAuditEvent,
  getAuditLogs,
  clearAuditLogs,
  subscribeAuditLogs,
  exportAuditLogsToCSV,
  seedInitialAuditLogs
};

export default auditLogger;
