import React, { useState } from 'react';
import { History, ChevronDown, MessageSquare, CheckCircle2, AlertCircle, ArrowRightCircle } from 'lucide-react';

/**
 * Action translation dictionary & styling tokens
 */
export const ACTION_MAP = {
  CREATE: { label: 'สร้างใบขอซื้อ', color: 'bg-blue-100 text-blue-700 border-blue-200' },
  RESUBMIT: { label: 'ส่งใบขอซื้ออีกครั้ง', color: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  SEND_BACK: { label: 'ส่งกลับเพื่อแก้ไข', color: 'bg-amber-100 text-amber-800 border-amber-200' },
  REVIEW_FORWARD: { label: 'ตรวจสอบผ่าน (ส่งต่อ)', color: 'bg-cyan-100 text-cyan-700 border-cyan-200' },
  APPROVE: { label: 'อนุมัติเรียบร้อย', color: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  CANCEL: { label: 'ยกเลิกคำขอ', color: 'bg-rose-100 text-rose-700 border-rose-200' }
};

/**
 * Role translation dictionary
 */
export const ROLE_MAP = {
  requester: 'ผู้ขอซื้อ (Requester)',
  asst_manager: 'ผู้ช่วยผู้จัดการ (Asst. Mgr)',
  plant_mgr: 'ผู้จัดการโรงงาน (Plant Mgr)',
  purchaser: 'เจ้าหน้าที่จัดซื้อ (Purchaser)'
};

/**
 * Resolves action code / name to label and badge color
 */
export const resolveAction = (rawAction) => {
  if (!rawAction) return { label: 'ดำเนินการ', color: 'bg-slate-100 text-slate-700 border-slate-200' };
  const key = String(rawAction).trim().toUpperCase();
  if (ACTION_MAP[key]) return ACTION_MAP[key];

  // Action aliases mapping
  if (['SUBMIT', 'SUBMITTED', 'PR_CREATED', 'PR_SUBMITTED', 'สร้างใบขอซื้อ'].includes(key)) {
    return ACTION_MAP.CREATE;
  }
  if (['PR_RESUBMITTED', 'EDIT_AND_RESUBMIT', 'RESUBMITTED', 'แก้ไขและส่งใหม่'].includes(key)) {
    return ACTION_MAP.RESUBMIT;
  }
  if (['REJECT', 'REJECTED', 'RETURNED', 'REJECTED_TO_DRAFT', 'REJECTED_TO_L2', 'SEND_BACK_TO_REQUESTER', 'ส่งกลับเพื่อแก้ไข', 'ตีกลับ'].includes(key)) {
    return ACTION_MAP.SEND_BACK;
  }
  if (['REVIEW', 'REVIEWED', 'REVIEW_APPROVED', 'ASST_MANAGER_APPROVED', 'ตรวจทานผ่าน', 'ตรวจสอบผ่าน'].includes(key)) {
    return ACTION_MAP.REVIEW_FORWARD;
  }
  if (['APPROVED', 'PR_APPROVED', 'FINAL_APPROVED', 'PLANT_MGR_APPROVED', 'อนุมัติ', 'อนุมัติผ่าน'].includes(key)) {
    return ACTION_MAP.APPROVE;
  }
  if (['CANCELLED', 'PR_CANCELLED', 'VOID', 'ยกเลิก', 'ยกเลิกคำขอ'].includes(key)) {
    return ACTION_MAP.CANCEL;
  }
  if (['PO_CREATED', 'PO_ISSUED'].includes(key)) {
    return { label: 'ออกใบสั่งซื้อ (PO)', color: 'bg-purple-100 text-purple-700 border-purple-200' };
  }
  if (['PO_APPROVED'].includes(key)) {
    return { label: 'อนุมัติใบสั่งซื้อ (PO)', color: 'bg-emerald-100 text-emerald-700 border-emerald-200' };
  }
  if (['PO_CANCELLED'].includes(key)) {
    return { label: 'ยกเลิกใบสั่งซื้อ', color: 'bg-rose-100 text-rose-700 border-rose-200' };
  }
  if (['PR_DRAFTED', 'DRAFT', 'DRAFT_SAVED', 'บันทึกแบบร่าง'].includes(key)) {
    return { label: 'บันทึกแบบร่าง', color: 'bg-slate-100 text-slate-700 border-slate-200' };
  }
  if (['EDIT_ITEMS', 'ITEMS_UPDATED', 'แก้ไขรายการ'].includes(key)) {
    return { label: 'แก้ไขรายการสินค้า', color: 'bg-sky-100 text-sky-700 border-sky-200' };
  }
  if (['GOODS_RECEIVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'รับสินค้า'].includes(key)) {
    return { label: 'รับมอบสินค้า', color: 'bg-teal-100 text-teal-700 border-teal-200' };
  }

  return { label: String(rawAction), color: 'bg-slate-100 text-slate-700 border-slate-200' };
};

/**
 * Resolves user role to standardized Thai title
 */
export const resolveRole = (rawRole) => {
  if (!rawRole) return null;
  const key = String(rawRole).trim().toLowerCase().replace(/[-\s.]+/g, '_');
  if (ROLE_MAP[key]) return ROLE_MAP[key];

  if (key.includes('requester')) return ROLE_MAP.requester;
  if (key.includes('asst') || key.includes('reviewer') || key.includes('assistant')) return ROLE_MAP.asst_manager;
  if (key.includes('plant') || key.includes('approver') || key === 'manager') return ROLE_MAP.plant_mgr;
  if (key.includes('purchas') || key.includes('buyer') || key.includes('procurement')) return ROLE_MAP.purchaser;
  if (key.includes('admin')) return 'ผู้ดูแลระบบ (Admin)';
  if (key.includes('super_admin')) return 'ผู้ดูแลระบบสูงสุด (Super Admin)';
  if (key.includes('accountant') || key.includes('finance')) return 'ฝ่ายบัญชีและการเงิน';

  return String(rawRole);
};

/**
 * Formats datetime into Thai timezone format: วัน/เดือน/ปี เวลา น.
 * Example: 16/09/2026 14:30 น.
 */
export const formatEventTime = (timeVal) => {
  if (!timeVal || timeVal === '-') return '-';
  const str = String(timeVal).trim();
  const pad = (n) => String(n).padStart(2, '0');

  const cleanStr = str.replace(/\s*น\.?$/, '').trim();
  const matchDmy = cleanStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\s*(\d{1,2}):(\d{2})/);
  if (matchDmy) {
    let p1 = parseInt(matchDmy[1], 10);
    let p2 = parseInt(matchDmy[2], 10);
    let yr = parseInt(matchDmy[3], 10);
    const hh = pad(matchDmy[4]);
    const mm = pad(matchDmy[5]);

    if (yr === 12 || yr === 26 || yr === 69) yr = 2026;
    else if (yr < 100) yr = 2000 + yr;
    else if (yr > 2400) yr -= 543;

    let day = p1;
    let month = p2;
    if (p1 <= 12 && p2 > 12) {
      day = p2;
      month = p1;
    }
    return `${pad(day)}/${pad(month)}/${yr} ${hh}:${mm} น.`;
  }

  try {
    const d = new Date(timeVal);
    if (isNaN(d.getTime())) return str.endsWith('น.') ? str : `${str} น.`;
    const day = pad(d.getDate());
    const month = pad(d.getMonth() + 1);
    let year = d.getFullYear();
    if (year > 2400) year -= 543;
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    return `${day}/${month}/${year} ${hours}:${minutes} น.`;
  } catch {
    return str;
  }
};

/**
 * CollapsibleActivityTimeline
 * Reusable Progressive Disclosure Component for Activity Logs / Audit Trails
 * 
 * @param {Array} events - Array of log events ({ action/title, user/actor, role, timestamp/time, note/comment })
 * @param {string} title - Header title (default: "ประวัติการดำเนินงาน")
 * @param {boolean} defaultExpanded - Initial expanded state (default: true)
 * @param {boolean} reverseOrder - If true, display newest events first (default: false)
 * @param {string} className - Additional wrapper classes
 */
export default function CollapsibleActivityTimeline({
  events = [],
  title = 'ประวัติการดำเนินงาน (Activity Timeline)',
  defaultExpanded = true,
  reverseOrder = false,
  className = ''
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  if (!events) events = [];

  // Normalize event fields with Dictionary lookups
  const normalizedEvents = events.map((e, index) => {
    let actorName = '-';
    let rawRole = null;

    if (e.actor && typeof e.actor === 'object') {
      actorName = e.actor.name || e.actor.displayName || e.actor.username || e.actor.id || '-';
      rawRole = e.actor.role || e.actor.title || e.actor.position || e.actor.userRole || null;
    } else {
      actorName = e.actor || e.user || e.actorName || e.userName || e.by || '-';
    }

    if (!rawRole) {
      rawRole = e.role || e.userRole || e.actorRole || e.department || null;
    }

    const actionInfo = resolveAction(e.action || e.title || e.type);
    const roleTitle = resolveRole(rawRole);
    const noteText = e.comment || e.summary || e.reason || e.note || e.description || e.details || null;

    return {
      id: e.id || index,
      actionKey: e.action || e.title || 'ACTION',
      actionLabel: actionInfo.label,
      badgeColor: actionInfo.color,
      actor: actorName,
      role: roleTitle,
      time: formatEventTime(e.timestamp || e.createdAt || e.time || e.date),
      note: noteText,
      changes: Array.isArray(e.changes) ? e.changes : [],
      status: e.status || null,
      raw: e
    };
  });

  // Determine chronological display order
  const displayEvents = reverseOrder ? [...normalizedEvents].reverse() : normalizedEvents;
  const latestEvent = displayEvents.length > 0
    ? (reverseOrder ? displayEvents[0] : displayEvents[displayEvents.length - 1])
    : null;

  return (
    <div className={`font-sans rounded-2xl border border-slate-200/80 bg-white shadow-xs overflow-hidden transition-all ${className}`}>
      {/* ── 1. Interactive Accordion Trigger Header ── */}
      <div
        onClick={() => setIsExpanded(prev => !prev)}
        className="flex items-center justify-between p-3.5 bg-slate-50/90 hover:bg-slate-100/90 border-b border-slate-200/70 transition-colors cursor-pointer select-none gap-2"
        title="คลิกเพื่อพับหรือขยายดูประวัติการดำเนินงานทั้งหมด"
      >
        {/* Left: Title & Count Badge */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-xl bg-white border border-slate-200/80 flex items-center justify-center text-slate-600 shadow-2xs">
            <History className="w-3.5 h-3.5 text-indigo-600" />
          </div>
          <span className="text-xs font-bold text-slate-900 tracking-tight">
            {title}
          </span>
          <span className="px-2 py-0.5 text-[10px] font-mono font-bold rounded-full bg-slate-200 text-slate-700">
            {events.length} ขั้นตอน
          </span>
        </div>

        {/* Center: Latest Event Snapshot (Shown when collapsed) */}
        {!isExpanded && latestEvent && (
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-slate-500 font-normal truncate min-w-0 flex-1 px-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0"></span>
            <span className="truncate">
              ล่าสุด: <strong className="font-semibold text-slate-800">{latestEvent.actionLabel}</strong> โดย {latestEvent.actor}
              {latestEvent.role && <span className="text-slate-400 ml-1">({latestEvent.role})</span>}
              <span className="font-mono text-[11px] text-slate-400 ml-1.5">• {latestEvent.time}</span>
            </span>
          </div>
        )}

        {/* Right: Expand/Collapse Chevron */}
        <div className="flex items-center gap-1.5 shrink-0 text-slate-400">
          <span className="text-[11px] font-medium hidden md:inline text-slate-500">
            {isExpanded ? 'พับเก็บ' : 'ดูรายละเอียด'}
          </span>
          <ChevronDown className={`w-4 h-4 text-slate-500 transition-transform duration-200 ${
            isExpanded ? 'rotate-180 text-indigo-600' : ''
          }`} />
        </div>
      </div>

      {/* ── 2. Body Timeline Layout (When Expanded) ── */}
      {isExpanded && (
        <div className="p-4 sm:p-5 bg-white animate-fade-in">
          {displayEvents.length === 0 ? (
            <p className="text-xs text-slate-400 italic py-3 text-center">
              ยังไม่มีบันทึกประวัติการดำเนินงานสำหรับเอกสารนี้
            </p>
          ) : (
            <div className="relative pl-6 space-y-5 border-l-2 border-slate-200 ml-3 py-1">
              {displayEvents.map((event, idx) => {
                const isLatest = event === latestEvent;
                const stepNum = reverseOrder ? (displayEvents.length - idx) : (idx + 1);

                return (
                  <div key={event.id} className="relative group">
                    {/* Node Dot on vertical timeline line */}
                    {isLatest ? (
                      <div className="absolute -left-[31px] top-1 w-3.5 h-3.5 rounded-full bg-emerald-600 ring-4 ring-emerald-100 border-2 border-white shadow-xs" />
                    ) : (
                      <div className="absolute -left-[29px] top-1.5 w-2.5 h-2.5 rounded-full bg-slate-300 border-2 border-white shadow-2xs group-hover:bg-indigo-400 transition-colors" />
                    )}

                    {/* Step Card Content */}
                    <div className="space-y-1.5">
                      {/* Line 1: Step Badge, Action Badge, Role, Latest indicator */}
                      <div className="flex items-center gap-2 flex-wrap text-xs">
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-slate-100 text-slate-600 border border-slate-200">
                          #{stepNum}
                        </span>

                        {/* Localized Action Badge with distinct color */}
                        <span className={`px-2.5 py-0.5 rounded-md text-xs font-bold border shadow-2xs ${event.badgeColor}`}>
                          {event.actionLabel}
                        </span>

                        {/* Localized Role Badge */}
                        {event.role && (
                          <span className="text-[11px] bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md font-medium border border-slate-200/80">
                            {event.role}
                          </span>
                        )}

                        {/* Latest Indicator */}
                        {isLatest && (
                          <span className="inline-flex items-center gap-1 text-[10px] bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-md font-bold border border-emerald-200 shadow-2xs">
                            <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                            ขั้นตอนปัจจุบัน
                          </span>
                        )}
                      </div>

                      {/* Line 2: Actor & Datetime */}
                      <div className="flex items-center gap-2 text-xs text-slate-500 flex-wrap">
                        <span>ผู้ดำเนินการ: <strong className="font-semibold text-slate-800">{event.actor}</strong></span>
                        <span className="text-slate-300">•</span>
                        <span className="font-mono text-[11px] text-slate-500 font-medium">
                          {event.time}
                        </span>
                      </div>

                      {/* Line 3: Note / Reason box (Always clear & high contrast) */}
                      {event.note && (
                        <div className="mt-2 bg-slate-50/80 border border-slate-200 rounded-xl p-3 text-xs text-slate-800 font-sans leading-relaxed shadow-2xs">
                          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 mb-1">
                            <MessageSquare className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span>เหตุผล / ข้อความประกอบ:</span>
                          </div>
                          <div className="text-slate-700 font-medium whitespace-pre-line pl-5">
                            {event.note}
                          </div>
                        </div>
                      )}

                      {/* Optional: Field changes table/list */}
                      {event.changes && event.changes.length > 0 && (
                        <div className="mt-1.5 text-[11px] text-slate-500 pl-2 border-l border-slate-200">
                          {event.changes.map((ch, cIdx) => (
                            <div key={cIdx} className="flex items-center gap-1.5">
                              <span className="font-medium text-slate-600">{ch.field}:</span>
                              <span className="line-through text-slate-400">{ch.before || '-'}</span>
                              <span className="text-slate-400">→</span>
                              <span className="font-semibold text-slate-700">{ch.after}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
