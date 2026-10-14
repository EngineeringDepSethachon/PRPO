import React, { useState, useMemo } from 'react';
import { workflowEngine } from '../services/workflowEngine';
import { useAppContext } from '../context/AppContext';
import { PR_STATUS, PO_STATUS } from '../config/constants';
import { hasDepartmentAccess } from '../utils/permissions';
import {
  isCompletedTask as wsIsCompletedTask,
  isInProgressTask as wsIsInProgressTask,
  isToDoTask as wsIsToDoTask,
} from '../services/workspaceService';
import { 
  AlertCircle, Clock, CheckCircle2, ArrowRight, FileText, 
  Sparkles, Building2, Store, Loader2, Info, Calendar,
  Flame, Timer, CheckCheck
} from 'lucide-react';
import PRDetailsModal from '../components/pr/PRDetailsModal';
import PODetailsModal from '../components/po/PODetailsModal';
import TaskCard from '../components/workspace/TaskCard';
import { sortByNewestFirst } from '../utils/sortUtils';
const EMPTY_ARRAY = [];

// 1. สร้างระบบตรวจสอบตัวตนแบบยืดหยุ่น (Robust User Matching)
const isUserMatched = (targetValue, currentUser) => {
  if (!targetValue || !currentUser) return false;
  const val = String(targetValue).trim().toLowerCase();
  const email = String(currentUser.email || '').trim().toLowerCase();
  const name = String(currentUser.name || '').trim().toLowerCase();
  const username = String(currentUser.username || '').trim().toLowerCase();
  return (email && val === email) || (name && val === name) || (username && val === username);
};

export default function WorkspaceView({ 
  prs: propPrs, 
  pos: propPos, 
  currentRole: propRole, 
  currentUser: propUser,
  onNavigate: propNavigate, 
  onRefresh: propRefresh, 
  onEditPR: propEditPR 
} = {}) {
  const context = useAppContext();
  const prs = propPrs ?? context.prs ?? EMPTY_ARRAY;
  const pos = propPos ?? context.pos ?? EMPTY_ARRAY;
  const currentRole = propRole ?? context.currentRole;
  const currentUser = propUser ?? context.currentUser ?? currentRole;
  const onNavigate = propNavigate ?? context.onNavigate;
  const onRefresh = propRefresh ?? context.refreshData;
  const onEditPR = propEditPR ?? context.handleEditPR;

  const [activeTab, setActiveTab] = useState('todo'); // 'todo' | 'in_progress' | 'completed'
  const [completedTypeFilter, setCompletedTypeFilter] = useState('ALL'); // 'ALL' | 'PR' | 'PO'
  const [selectedPR, setSelectedPR] = useState(null);
  const [selectedPO, setSelectedPO] = useState(null);

  // 1. รวมและ Deduplicate งานทั้งหมดด้วย Map พร้อมดักกรองข้อมูลข้ามแผนก (RBAC Scoping Rule) ป้องกัน Data Leak
  const unifiedTasks = useMemo(() => {
    const taskMap = new Map();
    const user = currentUser || currentRole;

    // Helper: ตรวจสอบสิทธิ์การเข้าถึงเอกสารตามแผนกและบทบาท (Pre-Filtering RBAC)
    const canSeeDocument = (doc) => {
      if (!user) return false;
      const roleId = String(user.roleId || user.id || '').toUpperCase();
      const userLevel = Number(user.level || 1);
      
      // Admin, Plant Manager, Central Purchaser sees ALL
      const isAdminOrGlobal = roleId === 'ADMIN' || user.role === 'admin' || userLevel >= 99 || 
                              roleId === 'PLANT_MANAGER' || userLevel >= 3 || 
                              roleId === 'PURCHASER' || roleId === 'ONLINE_PURCHASER';
      if (isAdminOrGlobal) return true;

      // Reviewer / Approver (Asst. Manager) - sees ALL docs in their department(s)
      const isReviewer = roleId === 'ASST_MANAGER' || roleId === 'REVIEWER' || userLevel === 2;
      if (isReviewer) {
        return hasDepartmentAccess(user, doc.department);
      }

      // Requester - sees ONLY docs they created, OR POs in their dept (since they receive goods)
      const isCreator = 
        isUserMatched(doc.requestedBy, user) || 
        isUserMatched(doc.applicantName1, user) || 
        isUserMatched(doc.createdBy, user) || 
        doc.requesterId === user.id;
      if (isCreator) return true;

      // Requesters can see POs in their department (for receiving goods)
      if (doc.docType === 'PO' && hasDepartmentAccess(user, doc.department)) {
         return true;
      }
      
      return false; // Not allowed to see this document (Data Leak Prevention)
    };

    // ใส่ PO ก่อน (PO ถือเป็นสถานะล่าสุดของเอกสาร)
    pos.forEach(po => {
      const docWithMeta = { ...po, docType: 'PO', uniqueKey: `po-${po.id}` };
      if (canSeeDocument(docWithMeta)) {
        taskMap.set(po.id, docWithMeta);
      }
    });

    // ใส่ PR เฉพาะใบที่ยังไม่ถูกแปลงเป็น PO
    prs.forEach(pr => {
      const isConverted = Boolean(
        pr.poNumber || 
        pr.poNo || 
        pos.some(p => 
          (p.prId && (p.prId === pr.id || p.prId === pr.prNo)) ||
          (p.prNo && (p.prNo === pr.prNo || p.prNo === pr.id)) ||
          (p.prNumber && (p.prNumber === pr.id || p.prNumber === pr.prNo)) ||
          (pr.poNo && (p.poNo === pr.poNo || p.id === pr.poNo)) ||
          (pr.poNumber && (p.poNo === pr.poNumber || p.poNumber === pr.poNumber))
        )
      );
      if (!isConverted) {
        const docWithMeta = { ...pr, docType: 'PR', uniqueKey: `pr-${pr.id}` };
        if (canSeeDocument(docWithMeta)) {
          taskMap.set(pr.id, docWithMeta);
        }
      }
    });

    return Array.from(taskMap.values());
  }, [prs, pos, currentUser, currentRole]);

  // Helper: ตรวจสอบว่าเสร็จสิ้นภายใน 30 วันย้อนหลังหรือไม่ (Directive 1: 30-Day Rolling Window)
  const isRecentlyCompleted = (task) => {
    const THIRTY_DAYS_AGO = new Date();
    THIRTY_DAYS_AGO.setDate(THIRTY_DAYS_AGO.getDate() - 30);

    const rawDate = task.completedAt || task.closedAt || task.updatedAt || task.date || task.createdAt;
    if (!rawDate) return true; // กฎความปลอดภัย: ห้ามตัดการ์ดทิ้งเด็ดขาด

    let dateStr = String(rawDate);
    // แปลง พ.ศ. เป็น ค.ศ. อย่างง่าย (ถ้ามีปี 25xx)
    if (/(25\d{2})/.test(dateStr)) {
      dateStr = dateStr.replace(/(25\d{2})/, (match) => String(Number(match) - 543));
    }
    
    const doneDate = new Date(dateStr);
    return isNaN(doneDate.getTime()) ? true : doneDate >= THIRTY_DAYS_AGO;
  };


  // ผลักวัน isTaskForMe → wsIsToDoTask (เจ้าเดียว To-Do ทั้งระบบ)
  // กฎเหล็ก: REQUESTER + CLAIM_PENDING/WAITING_DELIVERY_ROUND_2 → false เสมอ (บล็อกใน workspaceService แล้ว)
  const isTaskForMe = (task, user) => wsIsToDoTask(task, user);

  // ── Delegate to workspaceService (canonical implementations) ──
  // isCompletedTask: ใช้ isUserStakeholder ครอบคลุมทุก role + allPRs backward compat
  const isCompletedTask = (task, user) => wsIsCompletedTask(task, user, prs);

  // isInProgressTask: ใช้ isUserStakeholder + deduplication via allPOs
  const isInProgressTask = (task, user) => wsIsInProgressTask(task, user, prs, pos);

  // 2. กรองข้อมูลตาม Tab ปัจจุบัน โดยไม่พึ่งพา Side-Effect State (Pure useMemo)
  const currentTabTasks = useMemo(() => {
    const user = currentUser || currentRole;
    if (activeTab === 'todo' || activeTab === 'action') {
      return unifiedTasks.filter(t => isTaskForMe(t, user)).sort(sortByNewestFirst);
    }
    if (activeTab === 'in_progress' || activeTab === 'waiting') {
      return unifiedTasks.filter(t => isInProgressTask(t, user)).map(t => {
        let customLabel = t.statusLabel;
        if (t.docType === 'PR') {
          if (['PENDING_REVIEW', 'WAITING_REVIEW', 'waiting_review', 'pending_review', 'รอตรวจทาน', 'รอตรวจสอบ', 'SUBMITTED', 'REJECTED_TO_L2'].includes(t.status)) {
            customLabel = 'รอหัวหน้างานตรวจสอบ';
          } else if (['PENDING_APPROVE', 'PENDING_APPROVAL', 'WAITING_APPROVE', 'WAITING_APPROVAL', 'REVIEWED'].includes(t.status)) {
            // 1.3 ปรับ Badge แสดงสถานะให้ตรงกับบทบาท Assistant
            const isReviewerRole = user?.level === 2 || user?.roleId === 'ASST_MANAGER' || isUserMatched(t.reviewedBy, user);
            const isRequesterRole = t.requesterId === user?.id || isUserMatched(t.createdBy, user);
            
            if (isReviewerRole && !isRequesterRole) {
              customLabel = '⏳ รอผู้จัดการอนุมัติ (คุณตรวจสอบแล้ว)';
            } else {
              customLabel = '⏳ รอผู้จัดการอนุมัติ';
            }
          } else if (['APPROVED', 'PENDING_PO'].includes(t.status)) {
            customLabel = 'รอฝ่ายจัดซื้อเปิดใบสั่งซื้อ (PO)';
          }
        } else if (t.docType === 'PO') {
          if (['ORDERED', 'PURCHASED', 'WAITING_DELIVERY', 'ORDERED_PENDING_DELIVERY', 'IN_DELIVERY', 'PARTIAL', 'WAITING_DELIVERY_ROUND_2', 'ISSUED'].includes(t.status)) {
            customLabel = 'รอร้านค้าจัดส่งสินค้า';
          } else if (['CLAIM_PENDING', 'CLAIM_REPORTED', 'CLAIM_IN_PROGRESS', 'PARTIALLY_RECEIVED_IN_CLAIM'].includes(t.status) || t.hasUnresolvedClaim) {
            const isPurchaser = user?.roleId === 'ONLINE_PURCHASER' || user?.canOnlinePurchase || user?.roleId === 'ADMIN' || Number(user?.level || 1) >= 99;
            customLabel = isPurchaser ? '🔴 รอเจรจาเคลมร้านค้า' : '⏳ รอฝ่ายจัดซื้อเจรจาเคลมร้านค้า';
          }
        }
        return { ...t, statusLabel: customLabel || t.statusLabel };
      }).sort(sortByNewestFirst);
    }
    if (activeTab === 'completed') {
      return unifiedTasks.filter(t => {
        if (!isCompletedTask(t, user)) return false;
        if (!isRecentlyCompleted(t)) return false;
        if (completedTypeFilter === 'PR' && t.docType !== 'PR') return false;
        if (completedTypeFilter === 'PO' && t.docType !== 'PO') return false;
        return true;
      }).sort(sortByNewestFirst);
    }
    return [];
  }, [unifiedTasks, activeTab, completedTypeFilter, currentUser, currentRole]);

  // Tab Badge Counters
  const tabCounts = useMemo(() => {
    const user = currentUser || currentRole;
    let todo = 0;
    let inProgress = 0;
    let completed = 0;
    unifiedTasks.forEach(t => {
      if (isTaskForMe(t, user)) todo++;
      else if (isCompletedTask(t, user) && isRecentlyCompleted(t)) completed++;
      else if (isInProgressTask(t, user)) inProgress++;
    });
    return { todo, inProgress, completed };
  }, [unifiedTasks, currentUser, currentRole]);

  const handleTaskClick = (task) => {
    if (task.docType === 'PR') {
      setSelectedPR(task);
    } else if (task.docType === 'PO') {
      setSelectedPO(task);
    }
  };

  // Keep active modal item synced with latest prs/pos state
  const currentActivePR = selectedPR ? (prs.find(p => p.id === selectedPR.id) || selectedPR) : null;
  const currentActivePO = selectedPO ? (pos.find(p => p.id === selectedPO.id) || selectedPO) : null;

  return (
    <div className="w-full space-y-6 animate-fade-in pb-10">
      {/* ── 1. Header & Summary Hero Banner ── */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900 flex items-center gap-2.5 tracking-tight">
            <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 border border-indigo-100 flex items-center justify-center shadow-2xs">
              <Sparkles className="w-5 h-5" />
            </div>
            <span>พื้นที่ทำงานของฉัน (My Workspace)</span>
          </h2>
          <p className="text-xs sm:text-sm text-slate-500 mt-1 font-normal">
            ศูนย์รวมงานที่คุณต้องดำเนินการ และติดตามสถานะงานที่คุณเกี่ยวข้องทั้งหมด
          </p>
        </div>

        {/* Quick Stats Strip */}
        <div className="inline-flex items-center gap-2.5 px-3.5 py-2 rounded-2xl bg-white border border-slate-200/80 shadow-xs text-xs">
          <div className="flex items-center gap-1.5 font-medium text-slate-700">
            <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
            <span>รอคุณดำเนินการ</span>
            <span className="font-mono font-bold text-rose-600 tabular-nums">
              {tabCounts.todo}
            </span>
            <span>รายการ</span>
          </div>
          <span className="text-slate-300">•</span>
          <div className="flex items-center gap-1.5 text-slate-600">
            <span>มูลค่ารวม</span>
            {currentRole?.canViewBudget ? (
              <span className="font-mono font-bold text-slate-900 tabular-nums">
                ฿{unifiedTasks.filter(t => isTaskForMe(t, currentUser || currentRole)).reduce((sum, t) => sum + (t.grandTotal || t.totalAmount || 0), 0).toLocaleString()}
              </span>
            ) : (
              <span className="font-mono text-slate-400">***</span>
            )}
          </div>
        </div>
      </div>

      {/* ── 2. Floating Segmented Tabs & Sub-type Filters ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="bg-slate-100/80 p-1.5 rounded-2xl inline-flex gap-1 border border-slate-200/60 overflow-x-auto max-w-full">
          <button
            type="button"
            onClick={() => setActiveTab('todo')}
            className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs transition-all whitespace-nowrap cursor-pointer ${
              (activeTab === 'todo' || activeTab === 'action')
                ? 'bg-white text-slate-900 shadow-sm font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Flame size={15} strokeWidth={2} className="text-rose-500" />
            <span>ต้องดำเนินการ (To Do)</span>
            {tabCounts.todo > 0 && (
              <span className="bg-rose-500 text-white font-bold px-2 py-0.5 rounded-full text-[10px] font-mono shadow-2xs">
                {tabCounts.todo}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('in_progress')}
            className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs transition-all whitespace-nowrap cursor-pointer ${
              (activeTab === 'in_progress' || activeTab === 'waiting')
                ? 'bg-white text-slate-900 shadow-sm font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Timer size={15} strokeWidth={2} className="text-amber-500" />
            <span>รอผู้อื่นดำเนินการ (In Progress)</span>
            {tabCounts.inProgress > 0 && (
              <span className="bg-amber-100 text-amber-800 font-bold px-2 py-0.5 rounded-full text-[10px] font-mono border border-amber-200/60">
                {tabCounts.inProgress}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('completed')}
            className={`flex items-center gap-2 rounded-xl px-4 py-2 text-xs transition-all whitespace-nowrap cursor-pointer ${
              activeTab === 'completed'
                ? 'bg-white text-slate-900 shadow-sm font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <CheckCheck size={15} strokeWidth={2} className="text-emerald-500" />
            <span>เสร็จสิ้นแล้ว (Completed)</span>
            {tabCounts.completed > 0 && (
              <span className="bg-emerald-100 text-emerald-800 font-bold px-2 py-0.5 rounded-full text-[10px] font-mono border border-emerald-200/60">
                {tabCounts.completed}
              </span>
            )}
          </button>
        </div>

        {/* Sub-type Pills Filter (Directive 2: [ทั้งหมด], [เฉพาะ PR], [เฉพาะ PO]) */}
        {activeTab === 'completed' && (
          <div className="flex items-center gap-2 self-start sm:self-auto animate-fade-in">
            <span className="text-xs text-slate-400 font-medium hidden md:inline">กรองประเภท:</span>
            <div className="inline-flex p-1 bg-slate-100/90 rounded-xl border border-slate-200/70 shadow-2xs">
              <button
                type="button"
                onClick={() => setCompletedTypeFilter('ALL')}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  completedTypeFilter === 'ALL'
                    ? 'bg-white text-slate-900 shadow-2xs font-bold'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                ทั้งหมด
              </button>
              <button
                type="button"
                onClick={() => setCompletedTypeFilter('PR')}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  completedTypeFilter === 'PR'
                    ? 'bg-white text-indigo-700 shadow-2xs font-bold'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                เฉพาะ PR
              </button>
              <button
                type="button"
                onClick={() => setCompletedTypeFilter('PO')}
                className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  completedTypeFilter === 'PO'
                    ? 'bg-white text-emerald-700 shadow-2xs font-bold'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                เฉพาะ PO
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Rolling 30 Days Scope Notice Header for Completed Tab */}
      {activeTab === 'completed' && (
        <div className="flex items-center gap-2 text-xs text-slate-500 pt-1 pb-0.5 px-1 animate-fade-in">
          <Calendar className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <span>แสดงรายการที่เสร็จสิ้นภายใน 30 วันล่าสุด ({currentTabTasks.length} รายการ)</span>
        </div>
      )}

      {/* ── 3. Consistent Responsive Grid Container across ALL tabs ── */}
      <div className="w-full">
        {currentTabTasks.length === 0 ? (
          <EmptyState tab={activeTab} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 w-full">
            {currentTabTasks.map(task => (
              <TaskCard 
                key={task.uniqueKey} 
                task={task} 
                activeTab={activeTab}
                currentRole={currentRole}
                onClick={() => handleTaskClick(task)}
                onReorderShortage={(draft) => {
                  if (onEditPR) onEditPR(draft);
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── 4. Archive Banner & Handoff Navigation Links (Directive 3) ── */}
      {activeTab === 'completed' && (
        <div className="mt-8 p-4 sm:p-5 bg-slate-50/90 border border-slate-200/80 rounded-2xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 animate-fade-in shadow-2xs">
          <div className="flex items-start sm:items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-blue-50 text-blue-600 border border-blue-100 flex items-center justify-center shrink-0">
              <Info className="w-4 h-4" />
            </div>
            <div>
              <h5 className="text-xs sm:text-sm font-bold text-slate-800">
                แสดงเฉพาะรายการที่เสร็จสิ้นภายใน 30 วันที่ผ่านมา
              </h5>
              <p className="text-[11px] sm:text-xs text-slate-500 mt-0.5">
                สำหรับเอกสารย้อนหลังทั้งหมด กรุณาดูที่เมนู ใบขอซื้อ (PR) หรือ ใบสั่งซื้อ (PO)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                if (onNavigate) onNavigate('pr-list');
              }}
              className="px-3.5 py-2 bg-white hover:bg-slate-100 text-indigo-600 border border-slate-200/80 rounded-xl text-xs font-semibold transition-all shadow-2xs flex items-center gap-1.5 cursor-pointer"
            >
              <span>ดูใบขอซื้อ (PR) ทั้งหมด</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (onNavigate) onNavigate('po-list');
              }}
              className="px-3.5 py-2 bg-white hover:bg-slate-100 text-emerald-600 border border-slate-200/80 rounded-xl text-xs font-semibold transition-all shadow-2xs flex items-center gap-1.5 cursor-pointer"
            >
              <span>ดูใบสั่งซื้อ (PO) ทั้งหมด</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* PR Details Modal */}
      {currentActivePR && (
        <PRDetailsModal
          selectedPR={currentActivePR}
          currentRole={currentRole}
          onClose={() => setSelectedPR(null)}
          onRefresh={() => {
            if (onRefresh) onRefresh();
          }}
          onEditPR={onEditPR}
        />
      )}

      {/* PO Details Modal */}
      {currentActivePO && (
        <PODetailsModal
          selectedPO={currentActivePO}
          currentRole={currentRole}
          onClose={() => setSelectedPO(null)}
          onRefresh={(updatedDoc) => {
            setSelectedPO(null);
            if (onRefresh) onRefresh(updatedDoc);
          }}
        />
      )}
    </div>
  );
}

// ── EmptyState Component ──
function EmptyState({ tab }) {
  if (tab === 'todo' || tab === 'action') {
    return (
      <div className="bg-white rounded-3xl border border-slate-200/80 p-12 text-center shadow-xs flex flex-col items-center justify-center min-h-[340px] w-full">
        <div className="max-w-sm flex flex-col items-center animate-fade-in">
          <div className="w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-600 border border-emerald-100 flex items-center justify-center mb-4 shadow-xs">
            <Sparkles className="w-7 h-7" />
          </div>
          <h4 className="text-base font-bold text-slate-900 mb-1.5">เคลียร์งานครบเรียบร้อย</h4>
          <p className="text-xs text-slate-500 leading-relaxed">
            ไม่มีงานค้างท่อในขณะนี้ คุณได้ตรวจสอบและอนุมัติเอกสารในความรับผิดชอบครบถ้วนแล้ว
          </p>
        </div>
      </div>
    );
  }
  if (tab === 'in_progress' || tab === 'waiting') {
    return (
      <div className="bg-white rounded-3xl border border-slate-200/80 p-12 text-center shadow-xs flex flex-col items-center justify-center min-h-[340px] w-full">
        <div className="max-w-sm flex flex-col items-center animate-fade-in">
          <div className="w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 border border-amber-100 flex items-center justify-center mb-4 shadow-xs">
            <Clock className="w-7 h-7" />
          </div>
          <h4 className="text-base font-bold text-slate-900 mb-1.5">ไม่มีรายการที่รอผู้อื่น</h4>
          <p className="text-xs text-slate-500 leading-relaxed">
            คุณไม่มีคำขอ PR หรือ PO ที่อยู่ระหว่างรอการดำเนินการจากแผนกอื่น
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="bg-white rounded-3xl border border-slate-200/80 p-12 text-center shadow-xs flex flex-col items-center justify-center min-h-[340px] w-full">
      <div className="max-w-sm flex flex-col items-center animate-fade-in">
        <div className="w-14 h-14 rounded-2xl bg-slate-100 text-slate-600 border border-slate-200 flex items-center justify-center mb-4 shadow-xs">
          <FileText className="w-7 h-7" />
        </div>
        <h4 className="text-base font-bold text-slate-900 mb-1.5">ยังไม่มีรายการที่เสร็จสิ้น</h4>
        <p className="text-xs text-slate-500 leading-relaxed">
          ประวัติงานที่คุณอนุมัติหรือตรวจรับเสร็จสิ้นแล้วจะบันทึกไว้ที่นี่
        </p>
      </div>
    </div>
  );
}
