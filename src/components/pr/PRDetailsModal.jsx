import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { PR_STATUS } from '../../config/constants';
import { apiService } from '../../services/apiService';
import { useAppContext } from '../../context/AppContext';
import { storageService } from '../../services/storageService';
import { workflowEngine } from '../../services/workflowEngine';
import { budgetService } from '../../services/budgetService';
import { isCloudflareMode } from '../../config/backendMode';
import { modalService } from '../../services/modalService';
import { 
  ExternalLink, ShieldCheck, CheckCircle2, XCircle, 
  Trash2, Send, Edit3, Save, RotateCcw, AlertTriangle, Layers, 
  X, User, FileText, 
  ChevronRight, MessageSquare, Pencil,
  Paperclip, Package, Loader2
} from 'lucide-react';
import MEMODetailsSection from './MEMODetailsSection';
import POSplitModal from '../po/POSplitModal';
import AttachmentViewerModal from '../common/AttachmentViewerModal';
import ImageLightboxModal from '../common/ImageLightboxModal';
import RejectPRModal from './RejectPRModal';
import CollapsibleActivityTimeline from '../common/CollapsibleActivityTimeline';
import { sanitizeExternalUrl, getProductUrl } from '../../utils/urlHelper';
import { driveFileIdOf, openProxiedFile } from '../../utils/cfAttachments';
import AttachmentThumbnail from '../common/AttachmentThumbnail';
import LoadingOverlay from '../common/LoadingOverlay';
import ProductRemarkNote from '../common/ProductRemarkNote';
import { isBufferRole } from '../../utils/bufferRole';

// Phase 3 (FR-01) : comment limit of the BUFFER user's note to the approver (the server cuts at the same length)
const BUFFER_COMMENT_MAX = 2000;

const formatDateTime = (dateVal) => {
  if (!dateVal) return '-';
  try {
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return String(dateVal);
    const pad = (n) => String(n).padStart(2, '0');
    const day = pad(d.getDate());
    const month = pad(d.getMonth() + 1);
    const year = d.getFullYear();
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    if (typeof dateVal === 'string' && !dateVal.includes('T') && !dateVal.includes(':')) {
      return `${day}/${month}/${year}`;
    }
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  } catch {
    return String(dateVal);
  }
};

export default function PRDetailsModal({ selectedPR: initialPR, currentRole, onClose, onRefresh, onSelectPO, onEditPR }) {
  const context = useAppContext();
  const allPRs = context?.prs || storageService.getPRs() || [];
  const basePR = allPRs.find(p => p.id === initialPR?.id || p.prNo === initialPR?.prNo) || initialPR;
  // The PR as just saved by "edit items" : shown at once, so a failed follow-up (e.g. forward) never leaves the window on the old qty / price / link
  const [savedPR, setSavedPR] = useState(null);
  const selectedPR = (savedPR && basePR && savedPR.id === basePR.id)
    ? {
        ...basePR,
        items: savedPR.items,
        totalAmount: savedPR.totalAmount,
        ...(savedPR.financials ? { financials: savedPR.financials } : {}),
        ...(Array.isArray(savedPR.activityLog) ? { activityLog: savedPR.activityLog } : {})
      }
    : basePR;
  const allPOs = context?.pos || storageService.getPOs() || [];
  // หมายเหตุสินค้า (FR-02): products จาก context ; ถ้ายังว่างใช้ cache ใน storage
  const productMaster = (Array.isArray(context?.products) && context.products.length > 0)
    ? context.products
    : (storageService.getProducts?.() || []);

  // Safe Guard: Declare relatedPOs at the top of the component before any hook or JSX uses it
  const relatedPOs = React.useMemo(() => {
    if (!selectedPR || !Array.isArray(allPOs)) return [];
    return allPOs.filter(po => 
      (po.prId && (String(po.prId) === String(selectedPR.id) || String(po.prId) === String(selectedPR.prNo || selectedPR.docNo))) ||
      (po.prNo && (String(po.prNo) === String(selectedPR.prNo || selectedPR.docNo) || String(po.prNo) === String(selectedPR.id))) ||
      (po.prNumber && (String(po.prNumber) === String(selectedPR.id) || String(po.prNumber) === String(selectedPR.prNo || selectedPR.docNo))) ||
      (selectedPR.poId && (String(po.id) === String(selectedPR.poId) || String(po.poNo) === String(selectedPR.poId))) ||
      (selectedPR.poNumber && (String(po.poNo) === String(selectedPR.poNumber) || String(po.poNumber) === String(selectedPR.poNumber))) ||
      (selectedPR.poNo && (String(po.poNo) === String(selectedPR.poNo) || String(po.id) === String(selectedPR.poNo)))
    );
  }, [allPOs, selectedPR]);

  const displayAttachments = React.useMemo(() => {
    // 1. รวบรวม Key ของรูปภาพประจำสินค้าทั้งหมดในตารางซ้าย
    let parsedItems = [];
    if (Array.isArray(selectedPR?.items)) {
      parsedItems = selectedPR.items;
    } else if (typeof selectedPR?.items === 'string') {
      try { const parsed = JSON.parse(selectedPR.items); if (Array.isArray(parsed)) parsedItems = parsed; } catch(e) {}
    }
    const itemImageList = parsedItems.flatMap(it => {
      let itImages = Array.isArray(it.images) ? it.images : [];
      if (typeof it.images === 'string') { try { const p = JSON.parse(it.images); if(Array.isArray(p)) itImages = p; } catch(e){} }
      let itAtt = Array.isArray(it.attachments) ? it.attachments : [];
      if (typeof it.attachments === 'string') { try { const p = JSON.parse(it.attachments); if(Array.isArray(p)) itAtt = p; } catch(e){} }
      return [...itImages, ...itAtt];
    });
    // a PR-level attachment is "the same file" as an item picture when it has the same stored file (fileId / url) ;
    // the file name alone is used only for legacy entries without any id (a second upload with the same name is a different file)
    const idKeyOf = (f) => String(f?.fileId || f?.url || f?.viewUrl || '').trim().toLowerCase();
    const nameKeyOf = (f) => String(f?.name || f?.fileName || '').trim().toLowerCase();
    const itemImageIds = new Set(itemImageList.map(idKeyOf).filter(Boolean));
    const itemImageNames = new Set(itemImageList.filter(img => !idKeyOf(img)).map(nameKeyOf).filter(Boolean));

    // 2. ดึงเฉพาะเอกสารระดับ PR
    let prAttachments = Array.isArray(selectedPR?.attachments) ? selectedPR.attachments : [];
    if (typeof selectedPR?.attachments === 'string') {
      try { const parsed = JSON.parse(selectedPR.attachments); if (Array.isArray(parsed)) prAttachments = parsed; } catch(e) {}
    }
    
    let prQuotationFiles = Array.isArray(selectedPR?.quotationFiles) ? selectedPR.quotationFiles : [];
    if (typeof selectedPR?.quotationFiles === 'string') {
      try { const parsed = JSON.parse(selectedPR.quotationFiles); if (Array.isArray(parsed)) prQuotationFiles = parsed; } catch(e) {}
    }

    const rawPrAttachments = [...prAttachments, ...prQuotationFiles];
    if (typeof selectedPR?.quotationUrl === 'string' && selectedPR.quotationUrl.trim()) {
      rawPrAttachments.push({ url: selectedPR.quotationUrl, name: 'เอกสารอ้างอิง / ใบเสนอราคา (Link)' });
    }

    // 3. กรองด้วย 2 กฎเหล็ก: Isolate (ไม่เป็นรูปสินค้า) และ Deduplicate (ไม่ซ้ำ)
    return Array.from(
      new Map(
        rawPrAttachments
          .filter(att => {
            const idKey = idKeyOf(att);
            if (idKey) return !itemImageIds.has(idKey);
            const nameKey = nameKeyOf(att);
            return nameKey && !itemImageNames.has(nameKey);
          })
          .map(att => [att.fileId || att.name || att.fileName || att.url, att])
      ).values()
    );
  }, [selectedPR]);

  const [actionNote, setActionNote] = useState('');
  const [showSplitModal, setShowSplitModal] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [viewingAttachment, setViewingAttachment] = useState(null);
  const [selectedPreviewImage, setSelectedPreviewImage] = useState(null);

  // Async Workflow: Blocking state while API call is in-flight
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingAction, setProcessingAction] = useState('กำลังประมวลผล...');

  // Reject / Revision Modal State (Decoupled from footer)
  const [showRejectModal, setShowRejectModal] = useState(false);

  const handleConfirmRevision = async (reason) => {
    const trimmedReason = reason?.trim();
    if (!trimmedReason) {
      modalService.warning('กรุณาระบุเหตุผลการส่งกลับแก้ไข');
      return;
    }

    try {
      if (context?.rejectPR) {
        await context.rejectPR(selectedPR.id, trimmedReason);
      } else {
        await apiService.rejectPR(selectedPR.id, currentRole, trimmedReason);
      }
      modalService.success('ส่งกลับเรียบร้อย', `ส่งกลับใบขอซื้อ ${selectedPR.prNo} เพื่อแก้ไขแล้ว`);
      setShowRejectModal(false);
      setActionNote('');
      onClose();
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error('[Workflow Error Stack]:', err.stack || err);
      modalService.error('เกิดข้อผิดพลาด', err.message);
      throw err;
    }
  };
  
  // Approver Item Editing State
  const [isEditingItems, setIsEditingItems] = useState(false);
  const [editItems, setEditItems] = useState(() => (selectedPR.items || []).map(it => ({ ...it })));
  const [editReason, setEditReason] = useState('');
  const [isSavingItems, setIsSavingItems] = useState(false);
  // Phase 3 (FR-01) : product link typed per item row at PENDING_BUFFER ({ rowIndex: text }) ; kept apart from editItems so an untouched
  // row never gets a productUrl stamped onto it. bufferComment = the BUFFER user's note to the approver.
  const [urlEdits, setUrlEdits] = useState({});
  const [bufferComment, setBufferComment] = useState('');

  // Safe Timeline Aggregator
  const timelineList = useMemo(() => {
    let list = [];
    const sourceArrays = [
      selectedPR?.timeline,
      selectedPR?.activityTimeline,
      selectedPR?.history,
      selectedPR?.approvalHistory,
      selectedPR?.auditLogs,
      selectedPR?.activityLog
    ];
    sourceArrays.forEach(item => {
      if (!item) return;
      if (typeof item === 'string') {
        try { const p = JSON.parse(item); if (Array.isArray(p)) list.push(...p); } catch(e) {}
      } else if (Array.isArray(item)) {
        list.push(...item);
      }
    });
    // Fallback เมื่อยังไม่มีรายการ
    if (list.length === 0) {
      const fallbackList = selectedPR?.timeline || selectedPR?.activityTimeline || selectedPR?.history || selectedPR?.approvalHistory || selectedPR?.activityLog || [];
      if (Array.isArray(fallbackList)) list = [...fallbackList];
    }
    // กรองรายการซ้ำ
    const seen = new Set();
    const unique = list.filter(item => {
      const k = item.id || `${item.timestamp || item.createdAt || item.date || item.time}-${item.action || item.title}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // เรียงจากเก่าไปใหม่ เพื่อให้เห็น Step การเดินทางของเอกสาร
    return unique.sort((a, b) => new Date(a.timestamp || a.createdAt || a.date || a.time || 0) - new Date(b.timestamp || b.createdAt || b.date || b.time || 0));
  }, [selectedPR]);
  // Phase 3 (FR-01) : at PENDING_BUFFER only the BUFFER user (and admin) edits (decision Q9 - reviewer / approver cannot) ;
  // at the other statuses the rule is unchanged, except that the BUFFER user edits nothing there.
  const isBufferUser = isBufferRole(currentRole);
  const isAtBuffer = selectedPR.status === 'PENDING_BUFFER';
  const canApproverEdit = isAtBuffer
    ? workflowEngine.canEditPrAtBuffer(currentRole, selectedPR)
    : (currentRole.level >= 2 && !isBufferUser && ['SUBMITTED', 'REVIEWED', 'REJECTED_TO_L2'].includes(selectedPR.status));
  const canForwardFromBuffer = workflowEngine.canBufferForward(currentRole, selectedPR);
  const canReturnFromBuffer = workflowEngine.canReturnAtBuffer(currentRole, selectedPR);

  const handleItemFieldChange = (index, field, value) => {
    setEditItems(prev => {
      const next = [...prev];
      const target = { ...next[index] };
      if (field === 'qty') {
        const pQty = Number(value) || 1;
        const rate = Number(target.conversionRate) > 0 ? Number(target.conversionRate) : 1;
        target.purchaseQty = pQty;
        target.qty = pQty;
        target.stockQty = pQty * rate;
        target.total = pQty * (Number(target.price) || 0);
      } else if (field === 'price') {
        const price = Number(value) || 0;
        const pQty = Number(target.purchaseQty ?? target.qty) || 1;
        target.price = price;
        target.total = pQty * price;
      } else if (field === 'conversionRate') {
        const rate = Number(value) > 0 ? Number(value) : 1;
        const pQty = Number(target.purchaseQty ?? target.qty) || 1;
        target.conversionRate = rate;
        target.stockQty = pQty * rate;
      } else if (field === 'purchaseUnit') {
        target.purchaseUnit = value;
      }
      next[index] = target;
      return next;
    });
  };

  // The link shown in a row while editing : what the user typed, else the PR's current link
  const editedUrlOf = (index, item) => (index in urlEdits ? urlEdits[index] : getProductUrl(item));

  // True when the open edit form differs from the saved PR (qty / price / link) - used to keep the BUFFER "save and forward" lossless
  const hasPendingItemEdits = () => {
    const origItems = selectedPR.items || [];
    if (editItems.length !== origItems.length) return true;
    return editItems.some((it, i) => {
      const o = origItems[i] || {};
      if (Number(it.purchaseQty ?? it.qty) !== Number(o.purchaseQty ?? o.qty)) return true;
      if ((Number(it.price) || 0) !== (Number(o.price) || 0)) return true;
      return i in urlEdits && String(urlEdits[i] ?? '').trim() !== getProductUrl(o);
    });
  };

  // Sends the open edit form through the existing apiService.editPRItems (the reason must already be checked by the caller)
  const persistItemEdits = async () => {
    // Data Integrity Guard: Ensure master unit conversion and units are locked from original PR items
    const originalItemsMap = new Map((selectedPR.items || []).map(it => [it.id || it.code || it.name, it]));
    const sanitizedItems = editItems.map((item, index) => {
      const orig = originalItemsMap.get(item.id || item.code || item.name);
      const originalRate = Number(orig?.conversionRate ?? item.conversionRate) > 0 ? Number(orig?.conversionRate ?? item.conversionRate) : 1;
      const pQty = Number(item.purchaseQty ?? item.qty) || 1;
      const price = Number(item.price) || 0;
      const sanitized = {
        ...item,
        purchaseUnit: orig?.purchaseUnit || orig?.unit || item.purchaseUnit || item.unit || 'ชิ้น',
        stockUnit: orig?.stockUnit || orig?.unit || item.stockUnit || item.unit || 'ชิ้น',
        conversionRate: originalRate,
        purchaseQty: pQty,
        qty: pQty,
        stockQty: pQty * originalRate,
        price: price,
        total: pQty * price
      };
      // link typed at PENDING_BUFFER : send it only when it really changed (editPRItems then keeps every url key in step)
      if (index in urlEdits) {
        const typed = String(urlEdits[index] ?? '').trim();
        if (typed !== getProductUrl(orig || item)) sanitized.productUrl = typed;
      }
      return sanitized;
    });

    const savedResult = await apiService.editPRItems(selectedPR.id, sanitizedItems, currentRole, editReason.trim());
    // the edit is saved : show it in this window and tell the parent to reload right away (before any follow-up action that may fail)
    if (savedResult && typeof savedResult === 'object' && Array.isArray(savedResult.items)) setSavedPR(savedResult);
    setIsEditingItems(false);
    setEditReason('');
    setUrlEdits({});
    if (onRefresh) onRefresh();
    return savedResult;
  };

  const handleSaveItemsEdit = async () => {
    if (!editReason.trim()) {
      modalService.warning('กรุณาระบุเหตุผลการแก้ไขรายการสินค้า');
      return;
    }
    setIsSavingItems(true);
    try {
      await persistItemEdits(); // also calls onRefresh once the edit is saved
      modalService.success('บันทึกสำเร็จ', 'บันทึกการแก้ไขรายการสินค้าเรียบร้อย');
    } catch (err) {
      console.error('[Workflow Error Stack]:', err.stack || err);
      modalService.error('เกิดข้อผิดพลาด', err.message);
    } finally {
      setIsSavingItems(false);
    }
  };

  // BUFFER user (พี่สุ) : "บันทึกการแก้ไขและส่งต่อผู้อนุมัติ". An open edit form with real changes is saved first (nothing is lost) ;
  // if saving fails the status is NOT forwarded and the form stays open.
  const handleBufferForward = async () => {
    if (isProcessing || isSavingItems) return;
    const comment = bufferComment.trim();
    if (comment.length > BUFFER_COMMENT_MAX) {
      modalService.warning(`บันทึกถึงผู้อนุมัติยาวเกินไป (สูงสุด ${BUFFER_COMMENT_MAX} ตัวอักษร)`);
      return;
    }
    const pendingEdits = isEditingItems && hasPendingItemEdits();
    if (pendingEdits && !editReason.trim()) {
      modalService.warning('กรุณาระบุเหตุผลการแก้ไขรายการสินค้า ก่อนบันทึกและส่งต่อ');
      return;
    }

    const confirmed = await modalService.confirm({
      title: 'ยืนยันการดำเนินการ',
      message: `ต้องการ "บันทึกการแก้ไขและส่งต่อผู้อนุมัติ" สำหรับใบขอซื้อเลขที่ ${selectedPR.prNo} หรือไม่?`,
      confirmText: 'ยืนยันดำเนินการ',
      cancelText: 'ยกเลิก',
      type: 'info'
    });
    if (!confirmed) return;

    setProcessingAction('กำลังบันทึกและส่งต่อผู้อนุมัติ...');
    setIsProcessing(true);
    try {
      if (pendingEdits) {
        await persistItemEdits();
      } else if (isEditingItems) {
        setIsEditingItems(false);
        setUrlEdits({});
      }
      const result = context?.bufferForwardPR
        ? await context.bufferForwardPR(selectedPR.id, comment)
        : await apiService.updatePRStatus(selectedPR.id, 'REVIEWED', currentRole, comment, { bufferComment: comment });
      modalService.success('ดำเนินการสำเร็จ', result?.successMessage || 'ส่งต่อผู้อนุมัติแล้ว');
      setBufferComment('');
      onClose();
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error('[Workflow Error Stack]:', err.stack || err);
      modalService.error('เกิดข้อผิดพลาด', err.message);
    } finally {
      setIsProcessing(false);
    }
  };

  /**
   * Resolve the overlay message for each workflow action.
   */
  const getProcessingMessage = ({ isSubmit, nextStatus }) => {
    if (isSubmit) return 'กำลังส่งใบขอซื้อเข้าสู่ระบบ...';
    if (nextStatus === 'REVIEWED') return 'กำลังอัปเดตสถานะ (ตรวจสอบผ่าน)...';
    if (nextStatus === 'APPROVED') return 'กำลังบันทึกและสร้าง PO กรุณารอสักครู่...';
    return 'กำลังอัปเดตสถานะเอกสาร...';
  };

  const handleWorkflowAction = async ({ actionText, nextStatus, isSubmit = false }) => {
    // State Machine Guard: Only allow approving / PO issuance if PR has passed review (status is REVIEWED)
    if (nextStatus === 'APPROVED') {
      const statusNorm = String(selectedPR.status || '').toLowerCase();
      if (statusNorm !== 'reviewed') {
        modalService.error('ไม่อนุญาตให้ออกใบสั่งซื้อ (PO)', `ใบขอซื้อเลขที่ ${selectedPR.prNo} อยู่ในสถานะ "${selectedPR.status}" ซึ่งยังไม่ผ่านการตรวจทาน (ต้องผ่านการตรวจทานเป็นสถานะ REVIEWED ก่อนเท่านั้น จึงจะสามารถอนุมัติและออก PO ได้)`);
        return;
      }
    }

    // Guard: prevent concurrent actions (e.g. rapid double-click before confirm modal opens)
    if (isProcessing) return;

    const confirmed = await modalService.confirm({
      title: 'ยืนยันการดำเนินการ',
      message: `ต้องการดำเนินการ "${actionText}" สำหรับใบขอซื้อเลขที่ ${selectedPR.prNo} หรือไม่?`,
      confirmText: 'ยืนยันดำเนินการ',
      cancelText: 'ยกเลิก',
      type: 'info'
    });
    if (!confirmed) return;

    // Show blocking overlay immediately after user confirms — before any await
    const msg = getProcessingMessage({ isSubmit, nextStatus });
    setProcessingAction(msg);
    setIsProcessing(true);

    try {
      if (isSubmit) {
        await apiService.submitPR(selectedPR.id, currentRole);
        modalService.success('ส่งใบขอซื้อสำเร็จ', `ใบขอซื้อ ${selectedPR.prNo} ถูกส่งเข้าสู่ระบบแล้ว`);
      } else if (nextStatus === 'REVIEWED' && context?.reviewPR) {
        // Phase 3 : the server decides the next stop (BUFFER user or Plant Mgr) ; the result says which
        const reviewResult = await context.reviewPR(selectedPR.id, actionNote);
        modalService.success('ดำเนินการสำเร็จ', reviewResult?.successMessage || `อัปเดตสถานะใบขอซื้อ ${selectedPR.prNo} เรียบร้อยแล้ว`);
      } else if (nextStatus === 'APPROVED' && context?.approvePR) {
        await context.approvePR(selectedPR.id, actionNote);
        modalService.success('ดำเนินการสำเร็จ', `อัปเดตสถานะใบขอซื้อ ${selectedPR.prNo} เรียบร้อยแล้ว`);
      } else {
        await apiService.updatePRStatus(selectedPR.id, nextStatus, currentRole, actionNote);
        modalService.success('ดำเนินการสำเร็จ', `อัปเดตสถานะใบขอซื้อ ${selectedPR.prNo} เรียบร้อยแล้ว`);
      }
      setActionNote('');
      onClose();
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error('[Workflow Error Stack]:', err.stack || err);
      modalService.error('เกิดข้อผิดพลาด', err.message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancelPR = async () => {
    if (isProcessing || isCancelling) return;
    const reason = await modalService.prompt({
      title: 'ยกเลิกใบขอซื้อ (PR)',
      message: `กรุณาระบุเหตุผลในการยกเลิกใบขอซื้อเลขที่ ${selectedPR.prNo}:`,
      placeholder: 'ระบุเหตุผลในการยกเลิก...',
      required: true,
      confirmText: 'ยืนยันยกเลิก PR',
      cancelText: 'ปิด',
      type: 'danger'
    });
    if (!reason || !reason.trim()) return;

    setIsCancelling(true);
    setProcessingAction('กำลังบันทึกการยกเลิกคำขอ...');
    setIsProcessing(true);
    try {
      let res;
      if (context?.cancelPR) {
        res = await context.cancelPR(selectedPR.id, reason.trim());
      } else {
        res = await apiService.cancelPR(selectedPR.id, currentRole, reason.trim());
      }
      
      // ตรวจสอบ Response ให้ยืดหยุ่นตามที่ได้รับจาก Backend
      if (res || res?.success || res?.status === 'success' || res === true) {
        // อัปเดตสถานะของ PR ใน State ท้องถิ่นทันที
        selectedPR.status = 'CANCELLED';
        
        // สั่งปิด Modal ทันที ไม่ต้องรอ
        onClose();
        if (onRefresh) onRefresh();

        // แสดง Toast แจ้งเตือนแบบไม่บล็อก UI
        if (typeof window !== 'undefined' && window.showToast) {
          window.showToast('ยกเลิกเอกสารเรียบร้อยแล้ว', 'success');
        } else {
          modalService.success('ยกเลิกสำเร็จ', 'ยกเลิกเอกสารเรียบร้อยแล้ว');
        }
      }
    } catch (err) {
      console.error('[Workflow Error Stack]:', err.stack || err);
      modalService.error('เกิดข้อผิดพลาดในการยกเลิก', err.message);
    } finally {
      // สั่งรีเซ็ต State โหลดเสมอ
      setIsCancelling(false);
      setIsProcessing(false);
    }
  };

  // bufferReviewedBy is the stamped name (the server writes a string ; an object is tolerated like workspaceService does)
  const bufferReviewerName = (() => {
    const raw = selectedPR.bufferReviewedBy;
    if (!raw) return '';
    if (typeof raw === 'object') return String(raw.name || raw.id || '').trim();
    return String(raw).trim();
  })();

  const displayedItems = isEditingItems ? editItems : (selectedPR.items || []);
  const calculatedTotal = displayedItems.reduce((sum, it) => sum + (Number(it.total) || ((Number(it.purchaseQty ?? it.qty) || 1) * (Number(it.price) || 0))), 0);

  // Canonical Status Resolution: bind to workflowStatus or status with case-insensitive normalization
  const rawStatus = (selectedPR.workflowStatus || selectedPR.status || '').trim();
  const rawStatusUpper = rawStatus.toUpperCase();

  // Activity Timeline / Approval History inspection for completed approvals
  const hasPlantMgrApproval = React.useMemo(() => {
    const fromActivity = (selectedPR.activityLog || []).some(log => {
      const act = String(log.action || '').toLowerCase();
      const role = String(log.role || '').toLowerCase();
      const note = String(log.note || '').toLowerCase();
      return (
        act.includes('อนุมัติ') || 
        act.includes('approved') || 
        role.includes('plant mgr') || 
        role.includes('plant manager') ||
        note.includes('อนุมัติแล้ว')
      );
    });
    const fromHistory = (selectedPR.approvalHistory || []).some(h => {
      const act = String(h.action || '').toUpperCase();
      const role = String(h.actorRole || '').toLowerCase();
      return act === 'APPROVED' || role.includes('plant');
    });
    return fromActivity || fromHistory || Boolean(selectedPR.approvedBy);
  }, [selectedPR]);

  // Derive resolved canonical status
  const resolvedStatusKey = React.useMemo(() => {
    if (PR_STATUS[rawStatusUpper]) {
      // If status is still WAITING_REVIEW / SUBMITTED but timeline confirms final approval, self-heal to PO_ISSUED or APPROVED
      if (['WAITING_REVIEW', 'SUBMITTED', 'DRAFT'].includes(rawStatusUpper) && hasPlantMgrApproval) {
        return (selectedPR.poNo || selectedPR.poNumber || (relatedPOs || []).length > 0) ? 'PO_ISSUED' : 'APPROVED';
      }
      return rawStatusUpper;
    }

    // Lowercase / legacy fallback mappings
    const lower = rawStatus.toLowerCase();
    if (lower === 'approved') return 'APPROVED';
    if (lower === 'po_issued' || lower === 'ordered') return 'PO_ISSUED';
    if (lower === 'in_progress_online') return 'IN_PROGRESS_ONLINE';
    if (lower === 'reviewed') return 'REVIEWED';
    if (lower === 'pending_buffer') return 'PENDING_BUFFER';
    if (lower === 'completed' || lower === 'closed') return 'CLOSED';
    if (lower === 'waiting_review') return 'WAITING_REVIEW';
    if (lower === 'submitted') return 'SUBMITTED';
    if (lower === 'draft') return 'DRAFT';
    if (lower === 'cancelled') return 'CANCELLED';
    if (lower === 'rejected') return 'REJECTED';

    if (hasPlantMgrApproval) {
      return (selectedPR.poNo || selectedPR.poNumber || (relatedPOs || []).length > 0) ? 'PO_ISSUED' : 'APPROVED';
    }

    return rawStatusUpper || 'SUBMITTED';
  }, [rawStatus, rawStatusUpper, hasPlantMgrApproval, selectedPR.poNo, selectedPR.poNumber, relatedPOs]);

  // State Guard: PR must be approved or in PO-linked state to consider related POs
  const _isPRApproved = ['approved', 'ordered', 'completed', 'closed', 'po_issued', 'in_progress_online'].includes(resolvedStatusKey.toLowerCase());

  // the BUFFER user (พี่สุ) never cancels or sends back, at any status (decision Q6)
  const isPRCancellable = !isBufferUser && workflowEngine.canCancelPR(currentRole, selectedPR);
  const statusInfo = PR_STATUS[resolvedStatusKey] || { 
    label: selectedPR.status || resolvedStatusKey, 
    color: 'bg-slate-100 text-slate-700 border-slate-200' 
  };
  // Cloudflare mode: same numbers as BudgetView (zero-based budgetService summary); comparison rule unchanged
  const isOverBudget = (() => {
    if (!isCloudflareMode()) return apiService.isOverBudget(selectedPR.department, calculatedTotal);
    const current = (context?.budgetSummary?.current)
      || budgetService.calculatePeriodBudgetSummary(undefined, context?.prs, context?.pos).current;
    const deptInfo = current?.[selectedPR.department];
    if (!deptInfo) return false;
    const remaining = deptInfo.allocated - (deptInfo.actualSpent + deptInfo.committed);
    return calculatedTotal > remaining;
  })();

  const modalContent = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs animate-fade-in print:hidden">
      <div className="w-full max-w-5xl xl:max-w-6xl max-h-[90vh] flex flex-col rounded-3xl bg-white shadow-2xl border border-slate-200/80 overflow-hidden text-slate-800 animate-zoom-in">
        
        {/* ── 1. Fixed Header (Sticky Top / Non-scrollable) ── */}
        <div className="shrink-0 px-6 py-4 border-b border-slate-100/90 bg-white/95 backdrop-blur-md sticky top-0 z-20">
          <div className="flex items-center justify-between gap-4">
            {/* Left: PR No + Status Badge */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xl sm:text-2xl font-black font-mono tracking-tight text-slate-950">
                {selectedPR.prNo}
              </span>
              
              <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border shadow-2xs ${statusInfo.color}`}>
                <span className="w-1.5 h-1.5 rounded-full bg-current opacity-75"></span>
                {statusInfo.label}
              </span>
            </div>

            {/* Right: Hero Metric จิ๋ว + Close button */}
            <div className="flex items-center gap-3 shrink-0">
              <div className="hidden sm:flex flex-col items-end px-3.5 py-1.5 rounded-xl bg-slate-900 text-white shadow-sm shrink-0">
                <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider whitespace-nowrap">ยอดเงินสุทธิ</span>
                <span className="font-mono font-black text-sm text-emerald-400 tabular-nums whitespace-nowrap">
                  ฿{Number(selectedPR.financials?.grandTotal || calculatedTotal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>

              <button 
                onClick={onClose} 
                className="text-slate-400 hover:text-slate-700 p-2 rounded-xl hover:bg-slate-100 transition-all cursor-pointer shrink-0" 
                title="ปิดหน้าต่าง (Esc)"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Over-Budget Alert Callout Banner (เมื่อติดเงื่อนไขเกินงบ) */}
          {isOverBudget && (
            <div className="bg-rose-50/80 border border-rose-200/80 rounded-2xl p-3 text-xs text-rose-900 flex items-center gap-2 mt-3 shadow-2xs">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="font-bold">คำเตือนงบประมาณ:</span> ยอดคำขอซื้อนี้เกินกรอบงบประมาณคงเหลือของแผนก ({selectedPR.department}) ระบบจะส่งต่อเพื่อพิจารณาอนุมัติแบบ Over Budget
              </div>
            </div>
          )}
        </div>

        {/* ── 2-Column Split Content Architecture ── */}
        <div className="flex-1 overflow-y-auto px-5 sm:px-6 py-4 custom-scrollbar bg-slate-50/40">
          
          {/* Rejection Alert Banner (When PR has been rejected) */}
          {(selectedPR.status === 'REJECTED_TO_DRAFT' || selectedPR.status === 'REJECTED_TO_L2' || selectedPR.rejectReason) && (
            (() => {
              const displayReason = selectedPR.rejectReason || selectedPR.revisionReason || selectedPR.comment || selectedPR.latestComment || (selectedPR.approvalHistory?.slice(-1)[0]?.comment) || 'กรุณาตรวจสอบรายละเอียดและแก้ไขตามที่ได้รับแจ้งก่อนส่งอีกครั้ง';
              return (
                <div className="bg-rose-50/90 border border-rose-200/90 rounded-2xl p-4 flex items-start gap-3 shadow-2xs mb-4">
                  <div className="w-8 h-8 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center shrink-0 mt-0.5">
                    <RotateCcw className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4 className="text-xs sm:text-sm font-bold text-rose-950">
                      ใบขอซื้อถูกส่งกลับเพื่อแก้ไข (Revision Required)
                    </h4>
                    <p className="text-xs text-rose-900 mt-1 bg-white/90 p-3 rounded-xl border border-rose-200/60 font-medium leading-relaxed">
                      เหตุผลที่ส่งกลับแก้ไข: {displayReason}
                    </p>
                  </div>
                </div>
              );
            })()
          )}

          {/* Linked PO Banner - แสดงเฉพาะเมื่อ PR ผ่านการอนุมัติแล้วเท่านั้น */}
          {(relatedPOs || []).length > 0 && (
            <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-2xs mb-4">
              <div className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0 mt-0.5">
                  <Layers className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs sm:text-sm font-semibold text-indigo-950">
                    ออกใบสั่งซื้อ (PO) เรียบร้อยแล้ว {(relatedPOs || []).length} ฉบับ: {(relatedPOs || []).map(p => `${p.poNo || p.id} (${p.vendorName || 'ไม่ระบุผู้ขาย'})`).join(', ')}
                  </h4>
                  {(relatedPOs || []).length > 1 && (
                    <p className="text-xs text-indigo-700/80 mt-0.5">
                      รายการสินค้าถูกแยกตาม Supplier ของแต่ละรายการโดยอัตโนมัติ
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {(relatedPOs || []).map(po => (
                      <button
                        key={po.id || po.poNo}
                        type="button"
                        onClick={() => {
                          if (onSelectPO) onSelectPO(po);
                          else setShowSplitModal(true);
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white border border-indigo-200 text-indigo-800 text-[11px] font-mono font-semibold hover:bg-indigo-100/60 shadow-2xs transition-all cursor-pointer"
                      >
                        <span>{po.poNo || po.id}</span>
                        <span className="text-[10px] text-indigo-500 font-sans font-normal">
                          ({po.vendorName || 'ไม่ระบุ'})
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowSplitModal(true)}
                className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-3.5 py-2 rounded-xl font-medium shadow-xs transition-all cursor-pointer whitespace-nowrap self-end sm:self-center flex items-center gap-1.5"
              >
                <span>ดูรายละเอียด PO {(relatedPOs || []).length > 1 ? `(${(relatedPOs || []).length} ใบ)` : ''}</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Grid Layout 2-Column (col-span-7 / col-span-5) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            
            {/* ── คอลัมน์ซ้าย (Main Detail - col-span-7): รายการสินค้า & ยอดรวม ── */}
            <div className="lg:col-span-7 space-y-4">
              
              {/* รายการสินค้า Card */}
              <div className="bg-white border border-slate-200/80 rounded-2xl overflow-hidden shadow-xs">
                <div className="bg-slate-50/90 px-4 py-3.5 border-b border-slate-200/80 flex items-center justify-between">
                  <span className="text-xs sm:text-sm font-bold text-slate-900 flex items-center gap-2">
                    <Package className="w-4 h-4 text-slate-700" />
                    <span>รายการสินค้าที่ขอซื้อ</span>
                    <span className="text-xs font-semibold text-slate-500 bg-slate-200/70 px-2 py-0.5 rounded-full font-mono">({displayedItems.length})</span>
                  </span>

                  {canApproverEdit && (
                    <div>
                      {!isEditingItems ? (
                        <button
                          type="button"
                          onClick={() => {
                            setEditItems((selectedPR.items || []).map(it => ({ ...it })));
                            setUrlEdits({});
                            setIsEditingItems(true);
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 rounded-lg text-xs font-semibold transition-all cursor-pointer shadow-2xs"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          <span>{isAtBuffer ? 'แก้ไขจำนวน/ราคา/ลิงก์' : 'แก้ไขจำนวน/ราคา'}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setEditItems((selectedPR.items || []).map(it => ({ ...it })));
                            setUrlEdits({});
                            setIsEditingItems(false);
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded-lg text-xs font-semibold transition-all cursor-pointer"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>ยกเลิกการแก้ไข</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Approver Editing Reason Input Bar */}
                {isEditingItems && (
                  <div className="bg-amber-50/90 p-3.5 border-b border-amber-200 flex flex-col sm:flex-row items-center gap-2.5">
                    <div className="flex-1 w-full">
                      <input
                        type="text"
                        placeholder="ระบุเหตุผลที่ปรับแก้จำนวน/ราคา (เช่น ปรับลดตามงบ หรือ ต่อรองราคาได้)... *"
                        value={editReason}
                        onChange={e => setEditReason(e.target.value)}
                        className="w-full bg-white border border-amber-300 rounded-lg px-3.5 py-1.5 text-xs font-medium focus:ring-2 focus:ring-amber-500 outline-none"
                        required
                      />
                    </div>
                    <button
                      type="button"
                      disabled={isSavingItems}
                      onClick={handleSaveItemsEdit}
                      className="inline-flex items-center gap-1.5 bg-amber-600 hover:bg-amber-700 text-white font-semibold text-xs px-3.5 py-1.5 rounded-lg shadow-xs transition-all cursor-pointer shrink-0"
                    >
                      <Save className="w-3.5 h-3.5" />
                      <span>{isSavingItems ? 'กำลังบันทึก...' : 'บันทึกการแก้ไข'}</span>
                    </button>
                  </div>
                )}

                <div className="w-full overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200/80 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                        <th className="py-2.5 px-2.5 w-10 text-center text-xs text-slate-400">#</th>
                        <th className="py-2.5 px-2.5 min-w-[280px] text-left">รายการ & สเปก</th>
                        <th className="py-2.5 px-2.5 text-right font-mono text-xs whitespace-nowrap w-24">จำนวน</th>
                        <th className="py-2.5 px-2.5 text-right font-mono text-xs whitespace-nowrap w-28">ราคา/หน่วย</th>
                        <th className="py-2.5 px-2.5 text-right font-mono text-xs font-bold text-slate-900 pr-3 whitespace-nowrap w-28">รวม (฿)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {displayedItems.map((item, idx) => {
                        const pQty = item.purchaseQty ?? item.qty;
                        const pUnit = item.purchaseUnit || item.unit || 'ชิ้น';
                        const sUnit = item.stockUnit || item.unit || pUnit;
                        const rate = Number(item.conversionRate) > 0 ? Number(item.conversionRate) : 1;
                        const sQty = item.stockQty ?? (pQty * rate);
                        const storeUrl = item.productUrl || item.onlineUrl || getProductUrl(item);
                        const rawPhotos = item.images || item.attachments || item.image || [];
                        const photos = Array.isArray(rawPhotos) ? rawPhotos : (rawPhotos ? [rawPhotos] : []);

                        return (
                          <tr key={idx} className={`hover:bg-slate-50/70 transition-colors ${isEditingItems ? 'bg-amber-50/20 hover:bg-amber-50/50' : ''}`}>
                            <td className="py-2.5 px-2.5 text-center font-mono font-bold text-slate-400">
                              {idx + 1}
                            </td>
                            <td className="py-2.5 px-2.5 min-w-[280px] text-left">
                              <div className="flex flex-col items-start text-left w-full">
                                {/* แถวหลัก: ชื่อสินค้าหลัก ขึ้นบรรทัดแรก */}
                                <div className="font-bold text-slate-800 text-sm leading-snug break-words w-full" title={item.name}>
                                  {item.name}
                                </div>

                                {/* FR-02: หมายเหตุ/สเปกของสินค้าใต้ชื่อ */}
                                <ProductRemarkNote item={item} products={productMaster} className="mt-1 w-full" />

                                {/* Phase 3 (FR-01) : ช่องแก้ลิงก์สั่งซื้อออนไลน์ - เฉพาะโหมดแก้ไขที่ PENDING_BUFFER (พี่สุ/แอดมิน) ทั้ง PR จัดซื้อเองและออนไลน์ */}
                                {isEditingItems && isAtBuffer && (
                                  <div className="mt-1.5 w-full">
                                    <label className="text-[11px] font-semibold text-amber-800 block mb-0.5" htmlFor={`pr-item-url-${idx}`}>
                                      ลิงก์สั่งซื้อออนไลน์
                                    </label>
                                    <input
                                      id={`pr-item-url-${idx}`}
                                      type="text"
                                      inputMode="url"
                                      placeholder="https://..."
                                      aria-label={`ลิงก์สั่งซื้อออนไลน์ รายการที่ ${idx + 1}`}
                                      value={editedUrlOf(idx, item)}
                                      onChange={e => setUrlEdits(prev => ({ ...prev, [idx]: e.target.value }))}
                                      className="w-full border border-amber-300 rounded p-1 text-xs bg-white focus:ring-2 focus:ring-amber-500 font-mono"
                                    />
                                  </div>
                                )}

                                {/* แถวย่อย Badges: SKU, สถานที่ใช้งาน, ลิงก์ร้านค้าออนไลน์ (flex-nowrap overflow-hidden) */}
                                <div className="flex items-center gap-2 mt-1 flex-nowrap overflow-hidden max-w-full">
                                  {/* SKU Badge */}
                                  {(item.sku || item.code) && (
                                    <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 text-[11px] font-mono font-bold shrink-0">
                                      {item.sku || item.code}
                                    </span>
                                  )}

                                  {/* Location Tag */}
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 text-[11px] font-medium shrink-0">
                                    {(item.usageLocation || item.source) === 'OFFICE' ? '🏢 ออฟฟิศ' : '🏭 โรงงาน'}
                                  </span>

                                  {/* Online Store Link (ถ้ามี) */}
                                  {storeUrl && (
                                    <a
                                      href={sanitizeExternalUrl(storeUrl)}
                                      target="_blank"
                                      rel="noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 hover:text-indigo-700 hover:underline shrink-0"
                                    >
                                      <span>ดูร้านค้าออนไลน์</span>
                                      <ExternalLink className="w-3 h-3" />
                                    </a>
                                  )}
                                </div>

                                {/* Visual Media Strip (รูปสเปกจริงที่ผู้ขอแนบมา) */}
                                {photos.length > 0 && (
                                  <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                                    <div className="flex items-center gap-1 text-[11px] font-semibold text-slate-500 mr-1">
                                      <span>📷 รูปสเปกจริง ({photos.length}):</span>
                                    </div>

                                    {/* แกลเลอรีรูปภาพขนาดย่อม 40x40px */}
                                    <div className="flex items-center gap-1.5">
                                      {photos.map((img, imgIdx) => {
                                        const src = typeof img === 'string' ? img : (img.url || img.previewUrl || img.dataUrl || img.directUrl || img.fileUrl);
                                        if (!src) return null;
                                        return (
                                          <AttachmentThumbnail
                                            key={imgIdx}
                                            img={img}
                                            imgIdx={imgIdx}
                                            sizeClass="w-10 h-10"
                                            title="คลิกเพื่อดูรูปขนาดใหญ่"
                                            altText={`Item attachment ${imgIdx + 1}`}
                                            onClick={() => setSelectedPreviewImage({
                                              url: src,
                                              // keep fileId / mimeType etc. : the lightbox needs them to read an R2 file through the proxy (cloudflare mode)
                                              images: photos.map((p, pIdx) => ({
                                                ...(typeof p === 'object' && p ? p : {}),
                                                url: typeof p === 'string' ? p : (p.url || p.previewUrl || p.dataUrl || p.directUrl || p.fileUrl || ''),
                                                name: (typeof p === 'object' && p.name) ? p.name : `${item.name} (${pIdx + 1})`
                                              })),
                                              initialIndex: imgIdx,
                                              title: item.name
                                            })}
                                          />
                                        );
                                      })}
                                    </div>
                                  </div>
                                )}

                                {/* Conversion Spec Meta (italic gray text) */}
                                {rate > 1 && (
                                  <p className="text-[11px] text-slate-400 italic mt-0.5">
                                    1 {pUnit} = {rate} {sUnit}
                                  </p>
                                )}
                              </div>
                            </td>
                            <td className="py-2.5 px-2.5 text-right font-mono text-xs whitespace-nowrap">
                              {isEditingItems ? (
                                <div className="flex items-center justify-end gap-1">
                                  <input
                                    type="number"
                                    step="any"
                                    min="0.001"
                                    value={item.purchaseQty ?? item.qty}
                                    onChange={e => handleItemFieldChange(idx, 'qty', e.target.value)}
                                    className="w-16 border border-amber-300 rounded p-1 text-center font-bold text-xs bg-white focus:ring-2 focus:ring-amber-500 font-mono"
                                  />
                                  <span className="text-[11px] text-slate-600 font-semibold">{pUnit}</span>
                                </div>
                              ) : (
                                <div>
                                  <span className="font-bold text-slate-900 font-mono text-xs sm:text-sm">{Number(pQty).toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>{' '}
                                  <span className="text-slate-500 text-[11px] font-medium">{pUnit}</span>
                                  {rate > 1 && (
                                    <div className="text-[10px] text-slate-400 font-mono font-normal">
                                      (= {Number(sQty).toLocaleString()} {sUnit})
                                    </div>
                                  )}
                                </div>
                              )}
                            </td>
                            <td className="py-2.5 px-2.5 text-right font-mono text-xs whitespace-nowrap">
                              {isEditingItems ? (
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={item.price}
                                  onChange={e => handleItemFieldChange(idx, 'price', e.target.value)}
                                  className="w-20 border border-amber-300 rounded p-1 text-right font-bold text-xs bg-white focus:ring-2 focus:ring-amber-500 font-mono"
                                />
                              ) : (
                                <span className="font-mono font-semibold text-slate-700 text-xs sm:text-sm">
                                  ฿{Number(item.price || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </span>
                              )}
                            </td>
                            <td className="py-2.5 px-2.5 text-right font-mono text-xs font-bold text-slate-900 pr-3 whitespace-nowrap tabular-nums">
                              ฿{(Number(item.total) || ((Number(item.purchaseQty ?? item.qty) || 1) * (Number(item.price) || 0))).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Clean Financial Summary Strip (Linear / Stripe Vibe) */}
                <div className="bg-slate-50/80 border-t border-slate-200/80 p-4 rounded-b-2xl flex flex-col gap-1.5 text-xs">
                  {selectedPR.financials ? (
                    <>
                      <div className="flex justify-between items-center text-slate-500 font-medium">
                        <span>ยอดรวมสินค้า (Subtotal)</span>
                        <span className="font-mono font-semibold text-slate-800 tabular-nums">฿{Number(selectedPR.financials.subtotal || calculatedTotal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </div>
                      {selectedPR.financials.totalDiscount > 0 && (
                        <div className="flex justify-between items-center text-rose-600 font-medium">
                          <span>ส่วนลดรวม</span>
                          <span className="font-mono font-semibold tabular-nums">-฿{Number(selectedPR.financials.totalDiscount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                      )}
                      {selectedPR.financials.vatAmount > 0 && (
                        <div className="flex justify-between items-center text-slate-500 font-medium">
                          <span>ภาษีมูลค่าเพิ่ม (VAT 7%)</span>
                          <span className="font-mono font-semibold text-slate-800 tabular-nums">+฿{Number(selectedPR.financials.vatAmount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                      )}
                      {parseFloat(selectedPR.financials.roundingAdj || 0) !== 0 && (
                        <div className="flex justify-between items-center text-amber-700 font-medium">
                          <span>ปรับเศษทศนิยม</span>
                          <span className="font-mono font-semibold tabular-nums">{parseFloat(selectedPR.financials.roundingAdj) > 0 ? `+฿${parseFloat(selectedPR.financials.roundingAdj).toFixed(2)}` : `-฿${Math.abs(parseFloat(selectedPR.financials.roundingAdj)).toFixed(2)}`}</span>
                        </div>
                      )}
                      <div className="pt-2.5 mt-1 border-t border-slate-200/80 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold uppercase tracking-wider text-slate-500 font-mono">GRAND TOTAL</span>
                          {selectedPR.financials.vatAmount > 0 && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">รวม VAT</span>
                          )}
                        </div>
                        <span className="font-mono text-xl font-bold text-slate-900 tracking-tight tabular-nums">
                          ฿{Number(selectedPR.financials.grandTotal || calculatedTotal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold uppercase tracking-wider text-slate-500 font-mono">GRAND TOTAL</span>
                      <span className="font-mono text-xl font-bold text-slate-900 tracking-tight tabular-nums">
                        ฿{calculatedTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* MEMO Section (if exists) */}
              <MEMODetailsSection memo={selectedPR.memo} />
            </div>

            {/* ── คอลัมน์ขวา (Context & Activity Rail - col-span-5) ── */}
            <div className="lg:col-span-5 space-y-4">
              
              {/* Context Bento Box: Clean Minimal Key-Value Pairs */}
              <div className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs space-y-3.5">
                <span className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5 pb-2 border-b border-slate-100">
                  <User className="w-3.5 h-3.5 text-slate-500" />
                  <span>ข้อมูลคำขอซื้อ (Request Details)</span>
                </span>

                <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                  <div>
                    <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider block">ผู้ขอซื้อ</span>
                    <p className="text-xs font-semibold text-slate-800 mt-0.5 truncate">
                      {selectedPR.requestedBy}
                    </p>
                    <span className="text-slate-400 font-mono text-[11px] block">
                      ฝ่าย {selectedPR.department}
                    </span>
                  </div>

                  <div>
                    <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider block">วันที่ขอซื้อ</span>
                    <p className="text-xs font-semibold text-slate-800 font-mono mt-0.5 truncate">
                      {formatDateTime(selectedPR.requestedDate || selectedPR.createdAt)}
                    </p>
                  </div>

                  <div>
                    <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider block">ช่องทางจัดซื้อ</span>
                    <p className="text-xs font-semibold text-slate-800 mt-0.5 truncate">
                      {(selectedPR.purchaseChannel === 'ONLINE' || selectedPR.purchaseChannel === 'ONLINE_PURCHASE' || (Array.isArray(selectedPR.items) && selectedPR.items.some(item => !!(item.productUrl || item.onlineUrl || item.url)))) ? '🛒 ออนไลน์' : '🏢 ภายใน'}
                    </p>
                  </div>

                  <div>
                    <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider block">สถานที่ใช้งาน</span>
                    <p className="text-xs font-semibold text-slate-800 mt-0.5 truncate">
                      {selectedPR.source === 'FACTORY' || !selectedPR.source || selectedPR.source === 'PD' ? 'โรงงาน (Factory)' : (selectedPR.source === 'OFFICE' ? 'สำนักงาน (Office)' : selectedPR.source)}
                    </p>
                  </div>

                  {!(selectedPR.purchaseChannel === 'ONLINE' || selectedPR.purchaseChannel === 'ONLINE_PURCHASE' || (Array.isArray(selectedPR.items) && selectedPR.items.some(item => !!(item.productUrl || item.onlineUrl || item.url)))) && (selectedPR.vendorName || selectedPR.vendor?.name) && (
                    <div className="col-span-2 pt-1 border-t border-slate-100">
                      <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider block">ผู้จัดจำหน่าย (Vendor)</span>
                      <p className="text-xs font-bold text-slate-800 mt-0.5 truncate">
                        {selectedPR.vendorName || selectedPR.vendor?.name}
                      </p>
                    </div>
                  )}

                  {/* Phase 3 (FR-01) : ผลตรวจสอบจัดซื้อของพี่สุ (แสดงต่อเมื่อพี่สุส่งต่อแล้ว ; ไม่อยู่ใน PDF) */}
                  {bufferReviewerName && (
                    <div className="col-span-2 pt-1 border-t border-slate-100" data-testid="buffer-review-info">
                      <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider block">ผู้ตรวจสอบจัดซื้อ (พี่สุ)</span>
                      <p className="text-xs font-semibold text-slate-800 mt-0.5 break-words">
                        ตรวจสอบจัดซื้อโดย {bufferReviewerName}{selectedPR.bufferReviewedAt ? ` (${formatDateTime(selectedPR.bufferReviewedAt)})` : ''}
                      </p>
                      {selectedPR.bufferComment && (
                        <p className="mt-1 text-xs text-slate-700 leading-relaxed whitespace-pre-wrap break-words bg-slate-50/70 p-2.5 rounded-xl border border-slate-100">
                          {selectedPR.bufferComment}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* เหตุผลการขอซื้อ */}
              <div className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs space-y-2">
                <span className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                  <FileText className="w-3.5 h-3.5 text-slate-500" />
                  <span>เหตุผล / วัตถุประสงค์</span>
                </span>
                {selectedPR.note || selectedPR.remarks ? (
                  <p className="text-slate-800 text-xs font-medium leading-relaxed whitespace-pre-wrap bg-slate-50/70 p-3 rounded-xl border border-slate-100">
                    {selectedPR.note || selectedPR.remarks}
                  </p>
                ) : (
                  <div className="px-3 py-1.5 rounded-lg bg-slate-50 text-slate-400 text-xs italic border border-slate-100 flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-300"></span>
                    <span>ไม่ระบุเหตุผลประกอบ</span>
                  </div>
                )}
              </div>

              {/* ไฟล์แนบ & เอกสารอ้างอิง */}
              <div className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-xs space-y-2">
                <span className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                  <Paperclip className="w-3.5 h-3.5 text-slate-500" />
                  <span>ไฟล์แนบ & เอกสารอ้างอิง</span>
                </span>
                <div>
                  {displayAttachments.length > 0 ? (
                    <div className="space-y-1.5">
                      {displayAttachments.map((att, attIdx) => {
                        const finalUrl = att.viewUrl || att.url || att.directUrl || att.previewUrl || att.dataUrl || att.driveUrl;
                        const fileName = att.fileName || att.name || 'ไฟล์แนบ';
                        const mimeType = String(att.mimeType || '').toLowerCase();
                        const isPdf = mimeType.includes('pdf') || fileName.toLowerCase().endsWith('.pdf');
                        const isImage = mimeType.includes('image') || fileName.toLowerCase().match(/\.(jpg|jpeg|png|webp|gif)$/);
                        const fileBadge = isPdf ? 'PDF' : (isImage ? 'IMG' : 'DOC');

                        return (
                          <div
                            key={attIdx}
                            className="w-full flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 bg-slate-50 border border-slate-200/80 p-2.5 rounded-xl transition-all"
                          >
                            <div className="flex items-center gap-2.5 min-w-0 flex-1">
                              <div className="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-slate-600 shadow-2xs shrink-0 font-bold text-[10px]">
                                {fileBadge}
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="font-semibold text-xs text-slate-800 truncate" title={fileName}>{fileName}</p>
                                <p className="text-[10px] text-slate-400">{att.category || 'เอกสารแนบ'}</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                              {finalUrl ? (
                                <a
                                  href={finalUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => {
                                    // cloudflare mode : a Drive file opens through GET /api/files/:id (driveFileIdOf is null in other modes)
                                    if (!driveFileIdOf(att)) return;
                                    e.preventDefault();
                                    openProxiedFile(att).then((ok) => { if (!ok) window.open(finalUrl, '_blank', 'noopener,noreferrer'); });
                                  }}
                                  className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-700 border border-slate-200 hover:border-slate-300 text-xs font-bold rounded-lg transition-all cursor-pointer shadow-2xs"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                  <span>เปิดดูเอกสาร</span>
                                </a>
                              ) : (
                                <span className="text-[10px] text-slate-400">ไม่มีลิงก์</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : selectedPR.specUrl ? (
                    <button
                      type="button"
                      onClick={() => setViewingAttachment({ url: selectedPR.specUrl, title: 'เอกสารอ้างอิง / ลิงก์สินค้า' })}
                      className="w-full text-left flex items-center gap-2.5 bg-slate-50 hover:bg-slate-100 border border-slate-200/80 p-2 rounded-xl transition-colors group cursor-pointer"
                    >
                      <div className="w-6 h-6 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-slate-600 shadow-2xs shrink-0">
                        <ExternalLink className="w-3 h-3" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-xs text-slate-900 truncate">ดูเอกสารประกอบ / ลิงก์สินค้า</p>
                        <p className="text-[10px] text-slate-400 truncate">{selectedPR.specUrl}</p>
                      </div>
                    </button>
                  ) : (
                    <div className="px-3 py-1.5 rounded-lg bg-slate-50 text-slate-400 text-xs italic border border-slate-100 flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-300"></span>
                      <span>ไม่มีไฟล์แนบ หรือ เอกสารอ้างอิง</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Activity Log Timeline (Collapsible & Compact) */}
              <CollapsibleActivityTimeline
                events={timelineList}
                title="ลำดับเหตุการณ์ (Activity Timeline)"
                defaultExpanded={true}
                reverseOrder={false}
              />

            </div>

          </div>

        </div>

        {/* ── 5. Unified Command Footer Dock ── */}
        <div className="shrink-0 border-t border-slate-200/80 bg-slate-50/70 p-4 sm:p-5 rounded-b-3xl flex flex-col gap-3.5 sticky bottom-0 z-20 backdrop-blur-md">
          {/* Consolidated Action Dock */}
          <div className="space-y-3">
            {/* Elastic Multi-line Textarea (Shown for Approvers/Reviewers when actionable) */}
            {(['SUBMITTED', 'REVIEWED', 'REJECTED_TO_L2'].includes(selectedPR.status)) && 
             (workflowEngine.canAction(currentRole, selectedPR)) && (
              <div className="space-y-2">
                {/* Header เล็กเหนือน่องพิมพ์ */}
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                    <MessageSquare className="w-3.5 h-3.5 text-slate-400" />
                    <span>บันทึกช่วยจำ / ข้อความถึงผู้อนุมัติ (ไม่บังคับ)</span>
                  </span>
                  <kbd className="text-[10px] bg-slate-200/60 px-1.5 py-0.5 rounded text-slate-600 font-mono hidden sm:inline-block">
                    ⌘ + Enter เพื่อตรวจผ่าน
                  </kbd>
                </div>

                {/* Multi-line Textarea */}
                <div className="relative">
                  <textarea 
                    rows={2}
                    placeholder="ระบุบันทึกช่วยจำ หรือข้อความประกอบการตรวจผ่าน..." 
                    className="w-full bg-white border border-slate-200/90 rounded-2xl p-3.5 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all resize-none shadow-xs min-h-[68px]"
                    value={actionNote}
                    onChange={e => setActionNote(e.target.value)}
                    onKeyDown={e => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        if (selectedPR.status === 'REVIEWED') {
                          handleWorkflowAction({ actionText: 'อนุมัติสั่งซื้อและสร้าง PO', nextStatus: 'APPROVED' });
                        } else {
                          handleWorkflowAction({ actionText: 'ตรวจสอบและส่งต่อขั้นถัดไป', nextStatus: 'REVIEWED' });
                        }
                      }
                    }}
                  />
                </div>

                {/* Quick Preset Chips (ชิปพิมพ์ด่วน) */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  {[
                    { label: '✓ สเปกถูกต้อง', text: 'สเปกถูกต้อง' },
                    { label: '⚡ ใช้งานเร่งด่วน', text: 'ใช้งานเร่งด่วน' },
                    { label: '📊 ยืนยันราคาเดิม', text: 'ยืนยันราคาเดิม' }
                  ].map(chip => (
                    <button
                      key={chip.label}
                      type="button"
                      onClick={() => {
                        if (!actionNote.trim()) {
                          setActionNote(chip.text);
                        } else if (!actionNote.includes(chip.text)) {
                          setActionNote(prev => `${prev.trim()} / ${chip.text}`);
                        }
                      }}
                      className="text-[11px] font-medium text-slate-600 bg-white hover:bg-indigo-50 hover:text-indigo-600 hover:border-indigo-200 border border-slate-200 px-2.5 py-1 rounded-full cursor-pointer transition-all shadow-2xs"
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Phase 3 (FR-01) : ขั้นพี่สุ (PENDING_BUFFER) - บันทึกถึงผู้อนุมัติ */}
            {canForwardFromBuffer && (
              <div className="space-y-2" data-testid="buffer-forward-panel">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                    <MessageSquare className="w-3.5 h-3.5 text-slate-400" />
                    <span>บันทึกถึงผู้อนุมัติ (พี่สุ)</span>
                  </span>
                  <span className="text-[10px] text-slate-400 font-mono">{bufferComment.length}/{BUFFER_COMMENT_MAX}</span>
                </div>
                <textarea
                  rows={2}
                  maxLength={BUFFER_COMMENT_MAX}
                  aria-label="บันทึกถึงผู้อนุมัติ (พี่สุ)"
                  placeholder="ระบุบันทึกถึงผู้อนุมัติ (ไม่บังคับ) เช่น ผลการเช็คราคา/ลิงก์สินค้า..."
                  className="w-full bg-white border border-slate-200/90 rounded-2xl p-3.5 text-xs text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 transition-all resize-none shadow-xs min-h-[68px]"
                  value={bufferComment}
                  onChange={e => setBufferComment(e.target.value)}
                />
              </div>
            )}

            {/* Action Buttons Strip */}
            <div className="flex items-center justify-between flex-wrap gap-2 pt-1">
              
              {/* ฝั่งซ้าย: ปุ่ม "ยกเลิกคำขอ" สไตล์ Ghost Red (แสดงเฉพาะผู้มีสิทธิ์) */}
              <div>
                {isPRCancellable && (
                  <button 
                    type="button"
                    onClick={handleCancelPR}
                    disabled={isCancelling || isProcessing}
                    className={`px-3.5 py-2 text-xs font-semibold text-rose-600 hover:text-rose-700 hover:bg-rose-50 border border-transparent hover:border-rose-200 rounded-xl transition-all flex items-center gap-1.5 ${isCancelling || isProcessing ? 'opacity-40 cursor-not-allowed pointer-events-none' : 'cursor-pointer'}`}
                  >
                    {isCancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    <span>{isCancelling ? 'กำลังยกเลิก...' : 'ยกเลิกคำขอ'}</span>
                  </button>
                )}
              </div>

              {/* ฝั่งขวา: Action Group มีลำดับชั้นความสำคัญชัดเจน */}
              <div className="flex items-center gap-2.5 ml-auto">
                
                {/* Requester Actions (Draft / Rejected to Draft) */}
                {(selectedPR.status === 'DRAFT' || selectedPR.status === 'REJECTED_TO_DRAFT') && 
                 (workflowEngine.canAction(currentRole, selectedPR)) && (
                  <>
                    {onEditPR && (
                      <button 
                        type="button"
                        onClick={() => {
                          onClose();
                          onEditPR(selectedPR);
                        }}
                        className="px-4 py-2 bg-slate-100 hover:bg-slate-200 active:scale-95 text-slate-800 font-semibold text-xs rounded-xl transition-all flex items-center gap-1.5 cursor-pointer border border-slate-300/80"
                      >
                        <Pencil className="w-3.5 h-3.5 text-slate-600" />
                        <span>แก้ไขใบขอซื้อ</span>
                      </button>
                    )}
                    <button 
                      onClick={() => handleWorkflowAction({ actionText: 'ส่งใบ PR เข้าสู่ระบบ', nextStatus: null, isSubmit: true })}
                      disabled={isProcessing}
                      className={`bg-slate-950 hover:bg-slate-900 text-white rounded-xl px-5 py-2.5 font-semibold text-xs shadow-lg shadow-slate-950/20 active:scale-[0.98] transition-all flex items-center gap-2 ${isProcessing ? 'opacity-40 cursor-not-allowed pointer-events-none' : 'cursor-pointer'}`}
                    >
                      <Send className="w-3.5 h-3.5" />
                      <span>ส่งใบขอซื้อ (Submit PR)</span>
                    </button>
                  </>
                )}

                {/* Asst. Manager Actions (Level 1 Review) */}
                {(selectedPR.status === 'SUBMITTED' || selectedPR.status === 'REJECTED_TO_L2') && 
                 (workflowEngine.canAction(currentRole, selectedPR)) && (
                  <>
                    {/* ปุ่มรอง: ส่งกลับแก้ไข */}
                    <button 
                      type="button"
                      onClick={() => { if (!isProcessing) setShowRejectModal(true); }}
                      disabled={isProcessing}
                      className={`px-4 py-2.5 bg-rose-50/60 hover:bg-rose-100/70 text-rose-700 border border-rose-200/80 font-semibold text-xs rounded-xl transition-all flex items-center gap-1.5 shadow-2xs ${isProcessing ? 'opacity-40 cursor-not-allowed pointer-events-none' : 'cursor-pointer'}`}
                    >
                      <XCircle className="w-3.5 h-3.5 text-rose-600" />
                      <span>ส่งกลับแก้ไข (Reject)</span>
                    </button>

                    {/* ปุ่มหลัก: ตรวจสอบผ่าน */}
                    <button 
                      onClick={() => handleWorkflowAction({ actionText: 'ตรวจสอบและส่งต่อขั้นถัดไป', nextStatus: 'REVIEWED' })}
                      disabled={isProcessing}
                      className={`bg-slate-950 hover:bg-slate-900 text-white rounded-xl px-5 py-2.5 font-semibold text-xs shadow-lg shadow-slate-950/20 active:scale-[0.98] transition-all flex items-center gap-2 ${isProcessing ? 'opacity-40 cursor-not-allowed pointer-events-none' : 'cursor-pointer'}`}
                    >
                      <ShieldCheck className="w-4 h-4 text-emerald-400" />
                      <span>ตรวจสอบผ่าน (ส่งต่อขั้นถัดไป)</span>
                    </button>
                  </>
                )}

                {/* Phase 3 (FR-01) : PENDING_BUFFER - ผู้ตรวจทาน/ผู้อนุมัติ/แอดมิน ตีกลับได้ ; พี่สุ/แอดมิน บันทึกและส่งต่อ (พี่สุไม่มีปุ่มตีกลับ) */}
                {selectedPR.status === 'PENDING_BUFFER' && (
                  <>
                    {canReturnFromBuffer && !isBufferUser && (
                      <button
                        type="button"
                        onClick={() => { if (!isProcessing) setShowRejectModal(true); }}
                        disabled={isProcessing}
                        className={`px-4 py-2.5 bg-rose-50/60 hover:bg-rose-100/70 text-rose-700 border border-rose-200/80 font-semibold text-xs rounded-xl transition-all flex items-center gap-1.5 shadow-2xs ${isProcessing ? 'opacity-40 cursor-not-allowed pointer-events-none' : 'cursor-pointer'}`}
                        title="ส่งกลับให้ผู้ขอซื้อแก้ไข"
                      >
                        <XCircle className="w-3.5 h-3.5 text-rose-600" />
                        <span>ส่งกลับแก้ไข (Reject)</span>
                      </button>
                    )}

                    {canForwardFromBuffer && (
                      <button
                        type="button"
                        onClick={handleBufferForward}
                        disabled={isProcessing || isSavingItems}
                        className={`bg-slate-950 hover:bg-slate-900 text-white rounded-xl px-5 py-2.5 font-semibold text-xs shadow-lg shadow-slate-950/20 active:scale-[0.98] transition-all flex items-center gap-2 ${isProcessing || isSavingItems ? 'opacity-40 cursor-not-allowed pointer-events-none' : 'cursor-pointer'}`}
                      >
                        <Send className="w-3.5 h-3.5 text-emerald-400" />
                        <span>บันทึกการแก้ไขและส่งต่อผู้อนุมัติ</span>
                      </button>
                    )}
                  </>
                )}

                {/* Plant Manager Actions (Final Approval) */}
                {selectedPR.status === 'REVIEWED' && 
                 (workflowEngine.canAction(currentRole, selectedPR)) && (
                  <>
                    {/* ปุ่มรอง: ส่งกลับแก้ไข */}
                    <button 
                      type="button"
                      onClick={() => { if (!isProcessing) setShowRejectModal(true); }}
                      disabled={isProcessing}
                      className={`px-4 py-2.5 bg-rose-50/60 hover:bg-rose-100/70 text-rose-700 border border-rose-200/80 font-semibold text-xs rounded-xl transition-all flex items-center gap-1.5 shadow-2xs ${isProcessing ? 'opacity-40 cursor-not-allowed pointer-events-none' : 'cursor-pointer'}`}
                      title="ส่งกลับให้ผู้ขอซื้อแก้ไข"
                    >
                      <XCircle className="w-3.5 h-3.5 text-rose-600" />
                      <span>ส่งกลับแก้ไข (Reject)</span>
                    </button>

                    {/* ปุ่มหลัก: อนุมัติสั่งซื้อ */}
                    <button 
                      onClick={() => handleWorkflowAction({ actionText: 'อนุมัติสั่งซื้อและสร้าง PO', nextStatus: 'APPROVED' })}
                      disabled={isProcessing}
                      className={`bg-slate-950 hover:bg-slate-900 text-white rounded-xl px-5 py-2.5 font-semibold text-xs shadow-lg shadow-slate-950/20 active:scale-[0.98] transition-all flex items-center gap-2 ${isProcessing ? 'opacity-40 cursor-not-allowed pointer-events-none' : 'cursor-pointer'}`}
                    >
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      <span>อนุมัติสั่งซื้อ (Approve & ออก PO)</span>
                    </button>
                  </>
                )}

              </div>
            </div>
          </div>
        </div>

      </div>

      {/* Blocking Loading Overlay — shown while API call is in-flight */}
      <LoadingOverlay isVisible={isProcessing} message={processingAction} />

      {/* RejectPRModal */}
      {showRejectModal && (
        <RejectPRModal
          isOpen={showRejectModal}
          onClose={() => setShowRejectModal(false)}
          onConfirm={handleConfirmRevision}
          initialReason={actionNote.trim()}
          pr={selectedPR}
        />
      )}

      {/* POSplitModal */}
      {showSplitModal && (
        <POSplitModal 
          pr={selectedPR}
          pos={relatedPOs || []}
          onClose={() => setShowSplitModal(false)}
          onSelectPO={onSelectPO}
        />
      )}

      {/* AttachmentViewerModal */}
      {viewingAttachment && (
        <AttachmentViewerModal
          file={viewingAttachment.file}
          url={viewingAttachment.url}
          title={viewingAttachment.title}
          onClose={() => setViewingAttachment(null)}
        />
      )}

      {/* ImageLightboxModal for inspecting product spec images */}
      {selectedPreviewImage && (
        <ImageLightboxModal
          isOpen={Boolean(selectedPreviewImage)}
          images={
            typeof selectedPreviewImage === 'string'
              ? [{ url: selectedPreviewImage, name: 'รูปสเปกสินค้า' }]
              : (selectedPreviewImage.images || (selectedPreviewImage.url ? [selectedPreviewImage] : []))
          }
          initialIndex={typeof selectedPreviewImage === 'object' ? (selectedPreviewImage.initialIndex || 0) : 0}
          title={typeof selectedPreviewImage === 'object' ? (selectedPreviewImage.title || 'รูปสเปกสินค้า') : 'รูปสเปกสินค้า'}
          onClose={() => setSelectedPreviewImage(null)}
        />
      )}
    </div>
  );

  return typeof document !== 'undefined' && document.body
    ? createPortal(modalContent, document.body)
    : modalContent;
}
