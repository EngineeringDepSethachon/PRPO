import React, { useState, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { 
  Package, Download, AlertTriangle, CheckCircle2, 
  X, UploadCloud, Trash2, Camera, FileText, ArrowLeft,
  Check, Truck, AlertOctagon, Receipt
} from 'lucide-react';
import { recordGoodsReceipt as recordGoodsReceiptFn } from '../../context/ProcurementContext';
import { useAuth } from '../../context/AuthContext';
import { useAppContext } from '../../context/AppContext';
import { authService } from '../../services/authService';
import { modalService } from '../../services/modalService';
import { apiService } from '../../services/apiService';
import { storageService, isGAS, callGAS } from '../../services/storageService';
import { generateGRNNumber } from '../../services/warehouseService';
import { formatLocalTimestamp } from '../../services/inventoryService';
import { getValidConversionRate, toStockQuantity, toStockUnitCost } from '../../utils/uomEngine.js';
import AttachmentViewerModal from '../../components/common/AttachmentViewerModal';
import AttachmentThumbnail from '../../components/common/AttachmentThumbnail';
import { driveService } from '../../services/driveService';
import LoadingOverlay from '../../components/common/LoadingOverlay.jsx';
import { matchDepartment } from '../../utils/permissions';
import { getStoreGroupKey } from '../procurement/OnlineOrderCard';

/**
 * Helper to resiliently resolve refund quantity and amount
 * Supports Dual-Layer Refund Recognition:
 * Layer 1: Item-level fields (item.refundedQty, item.claimResolution === 'REFUND')
 * Layer 2: Store-level claim records (po.storeClaims) as fallback for disputed items
 */
export const resolveRefundedQtyAndAmount = (item, po) => {
  const ordered = Number(item?.orderedQty ?? item?.quantity ?? item?.actualQty ?? item?.purchaseQty ?? item?.qty) || 0;
  const accumulated = Number(item?.accumulatedReceived ?? item?.goodQty ?? item?.receivedQty ?? 0);

  const itemStoreName = (item?.actualStoreName || item?.storeName || '').trim();
  const itemPlatform = (item?.storePlatform || item?.platform || 'Shopee').trim();
  const derivedStoreKey = item?.storeKey || (itemStoreName ? `${itemPlatform}_${itemStoreName.toLowerCase()}` : '');

  const storeClaim = 
    (item?.storeKey && po?.storeClaims?.[item.storeKey]) ||
    (derivedStoreKey && po?.storeClaims?.[derivedStoreKey]) ||
    (itemStoreName && (po?.storeClaims?.[itemStoreName] || po?.storeClaims?.[itemStoreName.toLowerCase()])) ||
    (po?.storeClaims && Object.entries(po.storeClaims).find(([k]) => {
      if (!k || !itemStoreName) return false;
      const normK = String(k).toLowerCase().replace(/['"`]/g, '');
      const normS = itemStoreName.toLowerCase().replace(/['"`]/g, '');
      return normK === normS || normK.includes(normS) || normS.includes(normK);
    })?.[1]);

  const isStoreRefunded = Boolean(
    storeClaim && (storeClaim.isResolved || storeClaim.status === 'RESOLVED' || storeClaim.status === 'COMPLETED') &&
    (storeClaim.type === 'REFUND' || storeClaim.actionType === 'REFUND' || storeClaim.resolutionType === 'REFUND' || storeClaim.type === 'CANCEL' || String(storeClaim.note || '').includes('คืนเงิน'))
  );

  let refunded = Number(item?.refundedQty || 0);
  if (refunded === 0 && (item?.claimResolution === 'REFUND' || isStoreRefunded)) {
    refunded = Number(item?.damagedQty || item?.shortageQty || Math.max(0, ordered - accumulated));
  }

  const remainingToReceive = item?.remainingQty !== undefined 
    ? Number(item.remainingQty) 
    : Math.max(0, ordered - accumulated - refunded);

  const itemUnitPrice = Number(item?.actualPrice ?? item?.actUnitPrice ?? item?.unitPrice ?? item?.price ?? 0);
  let refundAmt = Number(item?.refundAmount || 0);
  if (refundAmt === 0 && refunded > 0) {
    refundAmt = Number(storeClaim?.refundAmount || (refunded * itemUnitPrice) || 0);
  }

  const isReplacement = Boolean(
    !isStoreRefunded && (
      item?.claimResolution === 'REPLACEMENT' || 
      Number(item?.replacementPendingQty) > 0 || 
      storeClaim?.type === 'REPLACEMENT' || 
      storeClaim?.actionType === 'REPLACEMENT' ||
      po?.claimStatus === 'REPLACEMENT_PENDING' ||
      po?.claimResolution?.type === 'REPLACEMENT'
    )
  );

  const isSplitShipment = Boolean(
    !isReplacement && !isStoreRefunded && (
      item?.shortageAction === 'WAIT_NEXT_ROUND' || 
      item?.disputeAction === 'WAIT_NEXT_ROUND' || 
      item?.shortageReason === 'SPLIT_SHIPMENT' || 
      item?.action === 'WAIT_NEXT_ROUND' ||
      po?.status === 'WAITING_DELIVERY_ROUND_2'
    )
  );

  return {
    ordered,
    accumulated,
    refunded,
    refundAmount: refundAmt,
    remainingToReceive,
    isStoreRefunded,
    isReplacement,
    isSplitShipment,
    storeClaim
  };
};

/**
 * Helper to check if an order's items are 100% accounted for
 * (receivedQty + refundedQty >= orderedQty for all items, or remainingToReceive is 0)
 */
export const checkIsFullyAccounted = (items = []) => {
  if (!items || items.length === 0) return false;
  return items.every(it => {
    const ordered = Number(it.ordered ?? it.orderedQty ?? it.quantity ?? it.actualQty ?? it.purchaseQty ?? it.qty ?? 0);
    const prevReceived = Number(it.accumulated ?? it.alreadyReceived ?? it.receivedQty ?? it.goodQty ?? 0);
    const refunded = Number(it.refunded ?? it.refundedQty ?? 0);
    const remaining = Math.max(0, ordered - prevReceived - refunded);
    return (prevReceived + refunded >= ordered) || (ordered > 0 && remaining === 0);
  });
};

/**
 * Helper to generate a collision-safe unique line identifier for PO items
 * Prevents State Overwrite when a PO contains multiple line items with the same product
 */
export const getLineKey = (item, index = 0) => {
  if (!item) return `item_p_${index}`;
  if (item.lineId) return String(item.lineId);
  if (item.id && item.id !== item.productId && item.id !== item.code && item.id !== item.sku) {
    return String(item.id);
  }
  return `item_${item.productId || item.code || 'p'}_${index}`;
};

/**
 * ReceivingModal (GoodsReceiptModal)
 * Enterprise-grade partial receiving modal with automatic shortage calculation,
 * stock acceptance filtering, and automatic dispute task routing to Online Hub.
 */
export default function ReceivingModal({ 
  po, 
  selectedPO,
  isOpen = true, 
  onClose, 
  onSuccess,
  onBack,
  onBackToPO,
  _currentRole,
  currentRole,
  currentUser: propCurrentUser,
  user: propUser
}) {
  const targetPO = po || selectedPO || { items: [] };
  const isOnlinePurchase = targetPO?.isOnlinePurchase === true || targetPO?.purchaseChannel === 'ONLINE';
  const auth = useAuth();
  const appContext = useAppContext();

  // ดึงข้อมูลผู้ใช้งานปัจจุบันอย่างปลอดภัย (Safe User Resolution)
  const sessionUser = (typeof authService?.getCurrentUser === 'function' ? authService.getCurrentUser() : null) ||
                      (typeof authService?.getCurrentSession === 'function' ? authService.getCurrentSession() : null) || {};
  const activeUser = propCurrentUser || propUser || currentRole || _currentRole || auth?.currentUser || appContext?.currentUser || sessionUser || {};
  const actorName = activeUser?.name || activeUser?.employeeName || activeUser?.username || (typeof activeUser === 'string' ? activeUser : 'ผู้ตรวจรับพัสดุ');
  const actorRole = activeUser?.canonicalRole || activeUser?.roleId || activeUser?.role || activeUser?.title || 'REQUESTER';



  const handleBackToPO = onBack || onBackToPO;

  const fileInputRef = useRef(null);

  // Initialize line-item state
  const [itemsState, setItemsState] = useState(() => {
    const initial = {};
    (targetPO.items || []).forEach((item, idx) => {
      const lineKey = getLineKey(item, idx);
      const remainingQty = Math.max(0, Number(item.quantity || item.orderedQty || 0) - Number(item.receivedQty || item.accumulatedReceived || 0));

      initial[lineKey] = {
        acceptedQty: remainingQty === 0 ? 0 : remainingQty,
        damagedQty: 0,
        shortageAction: item.shortageAction || 'CLAIM_SHORTAGE', // Default: CLAIM_SHORTAGE เพื่อป้องกันการเสียสิทธิ์เคลม
        shortageReason: item.shortageReason || (item.shortageAction === 'WAIT_NEXT_ROUND' ? 'SPLIT_SHIPMENT' : 'VENDOR_SHORTAGE'),
        defectNote: '',
        isDamagedExpanded: false
      };
    });
    return initial;
  });

  // Re-sync line-item state if targetPO changes
  useEffect(() => {
    if (!targetPO?.items) return;
    const initial = {};
    targetPO.items.forEach((item, idx) => {
      const lineKey = getLineKey(item, idx);
      const remainingQty = Math.max(0, Number(item.quantity || item.orderedQty || 0) - Number(item.receivedQty || item.accumulatedReceived || 0));

      initial[lineKey] = {
        acceptedQty: remainingQty === 0 ? 0 : remainingQty,
        damagedQty: 0,
        shortageAction: item.shortageAction || 'CLAIM_SHORTAGE',
        shortageReason: item.shortageReason || (item.shortageAction === 'WAIT_NEXT_ROUND' ? 'SPLIT_SHIPMENT' : 'VENDOR_SHORTAGE'),
        defectNote: '',
        isDamagedExpanded: false
      };
    });
    setItemsState(initial);
  }, [targetPO?.id, targetPO?.poNo]);

  const [grnNote, setGrnNote] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [previewAttachment, setPreviewAttachment] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // --- Inline Fast-Track Claim State (Self-Procurement only) ---
  const [inlineClaimAction, setInlineClaimAction] = useState('PENDING'); // PENDING | REPLACEMENT | REFUND | WRITE_OFF
  const [inlineRefundAmount, setInlineRefundAmount] = useState('');
  const [inlineExpectedDelivery, setInlineExpectedDelivery] = useState('');
  const [inlineClaimNote, setInlineClaimNote] = useState('');

  // Computed line items with auto-calculated shortage and remaining quantity
  const computedItems = useMemo(() => {
    return (targetPO.items || []).map((item, idx) => {
      const lineKey = getLineKey(item, idx);
      const key = lineKey;
      const state = itemsState[lineKey] || {
        acceptedQty: 0,
        damagedQty: 0,
        shortageReason: 'VENDOR_SHORTAGE',
        defectNote: '',
        isDamagedExpanded: false
      };

      const {
        ordered,
        accumulated,
        refunded,
        refundAmount,
        remainingToReceive,
        isStoreRefunded,
        isReplacement,
        isSplitShipment,
        storeClaim
      } = resolveRefundedQtyAndAmount(item, targetPO);

      const isRowLocked = remainingToReceive === 0;

      const remainingQty = Math.max(0, Number(item.quantity || item.orderedQty || 0) - Number(item.receivedQty || item.accumulatedReceived || 0));

      const rawAccepted = state.acceptedQty === '' ? '' : state.acceptedQty;
      const parsedAccepted = rawAccepted === '' ? 0 : Number(rawAccepted);
      const safeAccepted = isNaN(parsedAccepted) ? 0 : Math.max(0, parsedAccepted);
      const acceptedQty = isRowLocked ? 0 : Math.min(remainingQty, safeAccepted);

      const rawDamaged = state.damagedQty === '' ? '' : state.damagedQty;
      const parsedDamaged = rawDamaged === '' ? 0 : Number(rawDamaged);
      const safeDamaged = isNaN(parsedDamaged) ? 0 : Math.max(0, parsedDamaged);
      const damagedQty = isRowLocked ? 0 : Math.min(Math.max(0, remainingToReceive - acceptedQty), safeDamaged);

      // กฎเหล็ก: ตรวจจับ raw input ที่เกิน remainingToReceive ก่อน clamp (สำหรับ UI warning)
      // isOverLimit = true เมื่อผู้ใช้พิมพ์ค่าเกินจริง เพื่อแสดง highlight สีแดงบนแถว
      const allowedQty = isRowLocked ? 0 : remainingToReceive;
      const isOverLimit = !isRowLocked && allowedQty > 0 && (safeAccepted + safeDamaged) > allowedQty;

      // Remaining quantity and shortage calculations
      const shortageQty = isRowLocked ? 0 : Math.max(0, remainingToReceive - (acceptedQty + damagedQty));
      const hasShortage = !isRowLocked && (shortageQty > 0 || (acceptedQty < remainingToReceive && (acceptedQty + damagedQty < remainingToReceive)));
      const hasDamage = !isRowLocked && (safeDamaged > 0 || Number(state.damagedQty) > 0);

      const uom = storageService?.getUomConversion ? storageService.getUomConversion(item.code || item.productId || item.id) : null;
      const conversionRatio = getValidConversionRate(item.conversionRatio || item.conversionRate || uom?.conversionRatio || 1);

      const pUnit = item.purchaseUom || item.purchaseUnit || item.pUnit || uom?.purchaseUom || item.unit || 'ชิ้น';
      const sUnit = item.baseUom || item.stockUnit || item.sUnit || uom?.baseUom || (conversionRatio > 1 ? 'หน่วย' : pUnit);

      const shortageAction = state.shortageAction || (state.shortageReason === 'SPLIT_SHIPMENT' ? 'WAIT_NEXT_ROUND' : 'CLAIM_SHORTAGE');
      const shortageReason = state.shortageReason || (shortageAction === 'WAIT_NEXT_ROUND' ? 'SPLIT_SHIPMENT' : 'VENDOR_SHORTAGE');

      const refundAmountFormatted = refundAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      return {
        ...item,
        key: lineKey,
        lineKey,
        lineIndex: idx,
        ordered,
        orderedQty: ordered,
        accumulated,
        alreadyReceived: accumulated,
        refunded,
        refundAmount,
        refundAmountFormatted,
        remainingToReceive,
        remainingReceivable: remainingQty,
        remainingQty,
        isRowLocked,
        isStoreRefunded,
        isReplacement,
        isSplitShipment,
        storeClaim,
        acceptedQty,
        damagedQty,
        shortageQty,
        hasShortage,
        hasDamage,
        isOverLimit,
        rawAcceptedInput: isRowLocked ? 0 : (rawAccepted !== undefined ? rawAccepted : remainingQty),
        rawDamagedInput: isRowLocked ? 0 : (rawDamaged !== undefined ? rawDamaged : 0),
        shortageAction,
        shortageReason,
        defectNote: isRowLocked ? '' : (state.defectNote || ''),
        isDamagedExpanded: !isRowLocked && Boolean(state.isDamagedExpanded || hasDamage),
        conversionRatio,
        conversionRate: conversionRatio,
        purchaseUom: pUnit,
        purchaseUnit: pUnit,
        baseUom: sUnit,
        stockUnit: sUnit,
        pUnit,
        sUnit
      };
    });
  }, [targetPO.items, targetPO.storeClaims, itemsState]);

  // Overall delivery summary
  const summary = useMemo(() => {
    let totalAccepted = 0;
    let totalDamaged = 0;
    let totalShortage = 0;
    let hasVendorShortage = false;
    let hasSplitShipment = false;

    computedItems.forEach(item => {
      totalAccepted += item.acceptedQty;
      totalDamaged += item.damagedQty;
      totalShortage += item.shortageQty;
      if (item.hasShortage) {
        if (item.shortageAction === 'CLAIM_SHORTAGE' || item.shortageReason === 'VENDOR_SHORTAGE') hasVendorShortage = true;
        if (item.shortageAction === 'WAIT_NEXT_ROUND' || item.shortageReason === 'SPLIT_SHIPMENT') hasSplitShipment = true;
      }
    });

    const isFullyAccepted = totalShortage === 0 && totalDamaged === 0;
    const isClaimRequired = totalDamaged > 0 || hasVendorShortage;

    return {
      totalAccepted,
      totalDamaged,
      totalShortage,
      hasVendorShortage,
      hasSplitShipment,
      isFullyAccepted,
      isClaimRequired
    };
  }, [computedItems]);

  // ── Intelligent GRN Resolution: Calculate whether all items are completely resolved ──
  const isFullyAccounted = useMemo(() => {
    if (!computedItems || computedItems.length === 0) return false;
    return checkIsFullyAccounted(computedItems);
  }, [computedItems]);

  const totalAcceptedQty = summary.totalAccepted;

  const currentRound = (targetPO.grnHistory && targetPO.grnHistory.length > 0) 
    ? targetPO.grnHistory.length + 1 
    : (Number(targetPO.receivedQty || 0) > 0 || (targetPO.items || []).some(it => Number(it.receivedQty || it.accumulatedReceived || 0) > 0) ? 2 : 1);

  // Handler: Update item accepted quantity
  const handleAcceptedQtyChange = (key, value) => {
    const item = computedItems.find(it => it.key === key);
    if (item && item.isRowLocked) return; // Row locked: 100% read-only
    setItemsState(prev => {
      const current = prev[key] || {};
      return {
        ...prev,
        [key]: {
          ...current,
          acceptedQty: value
        }
      };
    });
  };

  // Handler: Update item damaged quantity
  const handleDamagedQtyChange = (key, value) => {
    const item = computedItems.find(it => it.key === key);
    if (item && item.isRowLocked) return; // Row locked: 100% read-only
    setItemsState(prev => {
      const current = prev[key] || {};
      return {
        ...prev,
        [key]: {
          ...current,
          damagedQty: value
        }
      };
    });
  };

  // Handler: Update shortage action (Directive 1)
  const handleShortageActionChange = (key, action) => {
    const item = computedItems.find(it => it.key === key);
    if (item && item.isRowLocked) return;
    setItemsState(prev => {
      const current = prev[key] || {};
      const reason = action === 'WAIT_NEXT_ROUND' ? 'SPLIT_SHIPMENT' : 'VENDOR_SHORTAGE';
      return {
        ...prev,
        [key]: {
          ...current,
          shortageAction: action,
          shortageReason: reason
        }
      };
    });
  };


  // Handler: Update defect note
  const handleDefectNoteChange = (key, note) => {
    const item = computedItems.find(it => it.key === key);
    if (item && item.isRowLocked) return;
    setItemsState(prev => {
      const current = prev[key] || {};
      return {
        ...prev,
        [key]: {
          ...current,
          defectNote: note
        }
      };
    });
  };

  // Handler: Fill all remaining as accepted
  const handleFillAllRemaining = () => {
    setItemsState(prev => {
      const next = { ...prev };
      computedItems.forEach(item => {
        next[item.key] = {
          ...next[item.key],
          acceptedQty: item.isRowLocked ? 0 : item.remainingToReceive,
          damagedQty: 0
        };
      });
      return next;
    });
  };

  const handleFillAllComplete = handleFillAllRemaining;

  // Handle Image compression & Google Drive attachment
  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setIsUploading(true);

    try {
      const processed = [];
      for (const file of files) {
        // Create local object URL for instant, reliable browser preview
        let localPreview = '';
        if (typeof window !== 'undefined' && window.URL && file.type?.startsWith('image/')) {
          try {
            localPreview = URL.createObjectURL(file);
          } catch (e) {
            console.warn('[ReceivingModal] Could not create ObjectURL:', e);
          }
        }

        try {
          const uploadRes = await driveService.uploadFileToDrive({
            file,
            category: 'GRN',
            poNumber: targetPO.poNo || targetPO.id,
            docNo: targetPO.poNo || targetPO.id,
            docType: 'GRN_EVIDENCE',
            description: `ภาพถ่ายตรวจรับสินค้า PO ${targetPO.poNo || targetPO.id}`
          });
          processed.push({
            name: file.name,
            fileName: file.name,
            size: file.size,
            type: file.type,
            fileId: uploadRes.fileId,
            fileUrl: uploadRes.fileUrl,
            viewUrl: uploadRes.viewUrl,
            downloadUrl: uploadRes.downloadUrl,
            previewUrl: localPreview || uploadRes.previewUrl || uploadRes.fileUrl,
            dataUrl: localPreview || uploadRes.previewUrl || uploadRes.fileUrl,
            localUrl: localPreview,
            uploadedAt: new Date().toLocaleString('th-TH')
          });
        } catch (uploadErr) {
          console.warn('[ReceivingModal] Drive upload fallback to local preview:', uploadErr.message);
          let base64 = '';
          try {
            const reader = new FileReader();
            base64 = await new Promise((res, rej) => {
              reader.onload = (re) => res(re.target.result);
              reader.onerror = rej;
              reader.readAsDataURL(file);
            });
          } catch (readErr) {
            console.warn('[ReceivingModal] FileReader error:', readErr);
          }
          processed.push({
            name: file.name,
            fileName: file.name,
            size: file.size,
            type: file.type,
            previewUrl: localPreview || base64,
            dataUrl: localPreview || base64,
            localUrl: localPreview,
            uploadedAt: new Date().toLocaleString('th-TH')
          });
        }
      }
      setAttachments(prev => [...prev, ...processed]);
    } catch (err) {
      modalService.error('อัปโหลดไฟล์ล้มเหลว', err.message);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemoveAttachment = (idx) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  const TERMINAL_RECEIVE_STATUSES = ['CLOSED', 'CANCELLED', 'RECEIVED', 'COMPLETED', 'COMPLETED_WITH_REFUND'];

  // Main Confirm Receiving Handler
  const handleConfirmReceiving = async () => {
    if (isSubmitting) return;

    // Double-Receipt Guard: ห้ามรับของซ้ำหาก PO อยู่ในสถานะเสร็จสิ้นแล้วโดยเด็ดขาด
    const isAlreadyClosed = TERMINAL_RECEIVE_STATUSES.includes(String(targetPO?.status || '').toUpperCase());
    if (isAlreadyClosed) {
      return modalService.warning(
        'เอกสารนี้ตรวจรับเข้าคลังเรียบร้อยแล้ว',
        `ใบสั่งซื้อ ${targetPO.poNo || targetPO.id} อยู่ในสถานะ "${targetPO.status}" ไม่สามารถกดรับซ้ำได้ เพื่อป้องกันยอดสต็อกบวม`
      );
    }

    // Validate boundaries & enforce allowedReceiveQty
    for (const it of computedItems) {
      const allowed = Math.max(0, it.ordered - it.accumulated - it.refunded);
      if (allowed === 0) {
        it.acceptedQty = 0;
        it.damagedQty = 0;
      } else {
        if (it.acceptedQty > allowed) {
          return modalService.warning(
            'จำนวนตรวจรับเกินกำหนด',
            `รายการ "${it.name}" มียอดตรวจรับเกินจำนวนที่รอตรวจรับ (${allowed} ${it.pUnit})`
          );
        }
        if (it.acceptedQty + it.damagedQty > allowed) {
          return modalService.warning(
            'จำนวนตรวจรับเกินกำหนด',
            `รายการ "${it.name}" มียอดรับสมบูรณ์ + ยอดชำรุด เกินจำนวนที่รอตรวจรับ (${allowed} ${it.pUnit})`
          );
        }
      }
    }

    if (!isFullyAccounted && summary.totalAccepted === 0 && summary.totalDamaged === 0 && summary.totalShortage === 0) {
      return modalService.warning('กรุณาระบุจำนวนสินค้าที่ตรวจรับ');
    }

    // Validation: Require note and photo if there are any damages
    if (summary.totalDamaged > 0) {
      if (!grnNote || grnNote.trim() === '') {
        return modalService.warning('กรุณาระบุหมายเหตุ', 'พบสินค้าชำรุด กรุณาระบุอาการชำรุดหรือหมายเหตุการตรวจรับ');
      }
      if (!attachments || attachments.length === 0) {
        return modalService.warning('กรุณาแนบรูปถ่าย', 'พบสินค้าชำรุด กรุณาแนบรูปถ่ายพัสดุหรือจุดที่ชำรุดเพื่อใช้เป็นหลักฐานในการเคลม');
      }
    }

    // Confirmation dialog
    let confirmTitle = 'ยืนยันการตรวจรับสินค้า';
    let confirmDesc = `ยืนยันบันทึกตรวจรับสินค้าเข้าคลังสำหรับ PO ${targetPO.poNo || targetPO.id} หรือไม่?`;
    let confirmType = 'success';

    if (isFullyAccounted) {
      confirmTitle = 'ยืนยันปิดงานใบสั่งซื้อ';
      confirmDesc = `สินค้าทุกรายการในใบสั่งซื้อ ${targetPO.poNo || targetPO.id} ได้รับการตรวจรับหรือชดเชยครบถ้วนแล้ว ยืนยันปิดงานใบสั่งซื้อ (Finalize PO) หรือไม่?`;
      confirmType = 'success';
    } else if (summary.isClaimRequired) {
      confirmTitle = 'ยืนยันตรวจรับสินค้า & ส่งเรื่องเคลม';
      confirmDesc = 'ตรวจพบสินค้าขาดส่งหรือชำรุดเสียหาย ระบบจะบันทึกรับเฉพาะสินค้าที่สมบูรณ์เข้าคลัง และส่งเรื่องเคลมไปยังฝ่ายจัดซื้อทันที';
      confirmType = 'warning';
    } else if (summary.hasSplitShipment) {
      confirmTitle = 'ยืนยันตรวจรับพัสดุ (รอส่งรอบถัดไป)';
      confirmDesc = 'บันทึกรับพัสดุรอบนี้เรียบร้อย สถานะเอกสารจะเปลี่ยนเป็น "รอพัสดุส่งรอบถัดไป" เพื่อรอรับสินค้าที่เหลือ';
      confirmType = 'info';
    }

    const confirmed = await modalService.confirm({
      title: confirmTitle,
      message: confirmDesc,
      type: confirmType,
      confirmText: isFullyAccounted
        ? 'ยืนยันปิดงานใบสั่งซื้อ (Finalize PO)'
        : (summary.isClaimRequired ? 'ยืนยันตรวจรับ & ส่งเรื่องเคลม' : (summary.hasSplitShipment ? 'ยืนยันรับพัสดุรอบนี้' : 'ยืนยันรับเข้าคลังสมบูรณ์')),
      cancelText: 'ยกเลิก'
    });

    if (!confirmed) return;

    setIsSubmitting(true);

    try {
      // ดึงข้อมูลผู้ใช้งานปัจจุบันอย่างปลอดภัย
      const currentUser = activeUser;
      
      // ดึง PO ล่าสุดจาก storage เพื่อให้ได้ grnHistory ที่อัปเดตแล้ว (ป้องกันเลขที่เอกสารซ้ำ)
      const freshPOs = storageService.getPOs() || [];
      const freshPO = freshPOs.find(p => p.id === (targetPO.id || targetPO.poNo)) || targetPO;
      const nextRound = (freshPO.grnHistory?.length || 0) + 1;
      const grnNumber = generateGRNNumber(freshPO.poNo || freshPO.id, nextRound);
      
      const timestamp = new Date().toLocaleString('th-TH');

      // Status determination
      let statusOverride = 'PARTIAL';
      if (summary.isClaimRequired) {
        statusOverride = 'CLAIM_PENDING';
      } else if (isFullyAccounted) {
        statusOverride = 'COMPLETED';
      } else if (summary.isFullyAccepted) {
        statusOverride = 'CLOSED';
      }

      // 1. Prepare Receiver Metadata (Directive 1)
      const receiverName = (currentUser?.name && currentUser.name !== 'Admin System') 
        ? currentUser.name 
        : (currentUser?.employeeName || currentUser?.username || '');
      const receiverRole = currentUser?.position || currentUser?.roleId || currentUser?.role || 'ผู้ตรวจรับ / บันทึกสต็อก';
      const receiverSignature = currentUser?.signatureUrl || 
        currentUser?.signature || 
        storageService.getSignatureByRole?.(currentUser?.roleId || currentUser?.id)?.signatureUrl || 
        storageService.getSignatures?.()?.[currentUser?.roleId || 'REQUESTER_PD']?.signatureUrl || 
        null;
      const receivedAtIso = new Date().toISOString();

      const receivingMetadata = {
        receiverName: receiverName,
        receiverId: currentUser?.id || currentUser?.username || '',
        receiverRole: receiverRole,
        receiverSignature: receiverSignature || '',
        receivedAt: receivedAtIso
      };
      const receivingInfo = receivingMetadata;

      // 2. Prepare Dispute Items for Online Hub
      const disputeItems = computedItems
        .filter(it => it.shortageQty > 0 || it.damagedQty > 0)
        .map(it => {
          const isShortage = it.shortageQty > 0;
          return {
            productId: it.productId,
            code: it.code,
            name: it.name,
            orderedQty: it.orderedQty,
            acceptedQty: it.acceptedQty,
            damagedQty: it.damagedQty,
            shortageQty: it.shortageQty,
            shortageAction: 'CLAIM_SHORTAGE', // Default routing to Claim Hub
            reason: isShortage ? 'SHORT_SHIPMENT' : 'DAMAGED',
            reasonLabel: isShortage ? 'ร้านส่งของไม่ครบตามกล่อง (ขาดส่ง)' : 'สินค้าชำรุด / แตกหักเสียหาย',
            description: isShortage ? `ยอดขาดส่ง ${it.shortageQty} ${it.pUnit}` : it.defectNote || 'สินค้ามีปัญหาจากการตรวจรับ',
            unit: it.pUnit
          };
        });

      // 3. Prepare GRN Payload
      const claimEvidence = summary.isClaimRequired ? {
         inspectorName: currentUser?.name || receiverName,
         inspectedAt: receivedAtIso,
         notes: grnNote.trim(),
         attachments: attachments || []
      } : null;

      const grnPayload = {
        grnNumber,
        round: nextRound,
        receivedDate: timestamp,
        receivedBy: currentUser?.name ? `${currentUser.name} (${currentUser.title || actorRole || ''})` : receiverName,
        receiverSignature,
        receivingInfo,
        actorName,
        actorRole,
        user: {
          id: currentUser?.id || 'USR-RECEIVER',
          name: actorName,
          title: actorRole,
          role: actorRole,
          canonicalRole: actorRole
        },
        currentUser: {
          id: currentUser?.id || 'USR-RECEIVER',
          name: actorName,
          title: actorRole,
          role: actorRole,
          canonicalRole: actorRole
        },
        note: grnNote.trim(),
        attachments,
        claimEvidence,
        statusOverride,
        waitingRound2: summary.hasSplitShipment,
        receivingItems: computedItems.map(it => {
          const sAction = it.shortageAction || (it.shortageReason === 'SPLIT_SHIPMENT' ? 'WAIT_NEXT_ROUND' : 'CLAIM_SHORTAGE');
          const isWait = sAction === 'WAIT_NEXT_ROUND';
          return {
            productId: it.productId,
            code: it.code,
            name: it.name,
            receivedThisTime: it.acceptedQty,
            goodQty: it.acceptedQty,
            damagedQty: it.damagedQty,
            shortageQty: it.shortageQty,
            shortageAction: sAction,
            shortageReason: isWait ? 'SPLIT_SHIPMENT' : 'VENDOR_SHORTAGE',
            disputeAction: isWait ? 'WAIT_NEXT_ROUND' : ((it.damagedQty > 0 || (it.shortageQty > 0 && sAction === 'CLAIM_SHORTAGE')) ? 'CLAIM' : 'NONE'),
            defectReason: it.defectNote,
            condition: it.damagedQty > 0 ? 'DAMAGED' : it.shortageQty > 0 ? 'SHORTAGE' : 'GOOD'
          };
        })
      };

      // 4. Call recordGoodsReceipt from Procurement Context
      const grResult = appContext?.recordGoodsReceipt
        ? await appContext.recordGoodsReceipt(targetPO.id, grnPayload)
        : await recordGoodsReceiptFn(targetPO.id, grnPayload);

      // 5. Call receiveToStock / submitGRN and emit enterprise stockMovements with Dual-UOM (Strictly good goods only)
      const stockItemsToReceive = computedItems
        .filter(it => Number(it.acceptedQty || 0) > 0 && !it.isRowLocked)
        .map(it => {
          const uom = storageService?.getUomConversion ? storageService.getUomConversion(it.code || it.productId || it.id) : null;
          const ratio = getValidConversionRate(it.conversionRatio || it.conversionRate || uom?.conversionRatio || 1);

          const purchaseUnit = it.purchaseUom || it.purchaseUnit || it.pUnit || uom?.purchaseUom || 'ชิ้น';
          const stockUnit = it.baseUom || it.stockUnit || it.sUnit || uom?.baseUom || purchaseUnit;
          const purchasePrice = Number(it.actUnitPrice ?? it.actualPrice ?? it.price ?? uom?.purchaseUnitPrice ?? 0);
          const baseUnitCost = typeof toStockUnitCost === 'function'
            ? toStockUnitCost(purchasePrice, ratio)
            : purchasePrice / (Number(ratio) > 0 ? Number(ratio) : 1);
          const baseStockQty = typeof toStockQuantity === 'function'
            ? toStockQuantity(it.acceptedQty, ratio)
            : Number(it.acceptedQty || 0) * (Number(ratio) > 0 ? Number(ratio) : 1);
          const totalVal = baseStockQty * baseUnitCost;

          return {
            productId: it.productId || it.id,
            id: it.id || it.productId,
            code: it.code,
            itemCode: it.code || it.productId,
            name: it.name,
            qty: baseStockQty,
            quantity: baseStockQty,
            receivedQty: Number(it.acceptedQty),
            purchaseQty: Number(it.acceptedQty),
            goodQty: Number(it.acceptedQty),
            damagedQty: 0, // only intact good goods
            conversionRate: ratio,
            conversionRatio: ratio,
            purchaseUnit,
            purchaseUom: purchaseUnit,
            stockUnit,
            baseUom: stockUnit,
            docNo: targetPO.poNo || targetPO.id,
            poNo: targetPO.poNo || targetPO.id,
            poNumber: targetPO.poNo || targetPO.id,
            unitPrice: baseUnitCost,
            baseUnitCost,
            actualPrice: purchasePrice,
            purchaseUnitPrice: purchasePrice,
            totalValue: totalVal,
            totalPrice: totalVal,
            grNumber: grnNumber,
            grnNumber
          };
        });

      if (stockItemsToReceive.length > 0) {
        // Single SSOT Pipeline: logStockMovements is the canonical Dual-UOM stock intake path.
        // It updates stockBalance, enforces deduplication by (documentNo + productCode),
        // and persists atomically to storage and backend.
        const allProducts = storageService.getProducts() || [];
        const vendorName = targetPO.vendorName || targetPO.vendor?.name || 'ผู้จำหน่าย';
        const movementsToEmit = stockItemsToReceive.map(it => {
          const matchedProd = allProducts.find(p => {
            if (it.productId && p.id === it.productId) return true;
            if (it.code && p.code === it.code) {
              return matchDepartment(p.department || p.category, targetPO.department);
            }
            return false;
          });
          const curBal = Number(matchedProd?.stockBalance || 0);
          const newBal = curBal + it.quantity;

          return {
            id: `MOV-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
            timestamp: formatLocalTimestamp(), // เวลาไทย UTC+7
            date: formatLocalTimestamp(),
            productId: String(matchedProd?.id || it.productId || '').trim(),
            productCode: String(matchedProd?.code || it.code || it.productId || '').trim(),
            sku: String(matchedProd?.code || it.code || it.productId || '').trim(),
            itemCode: String(matchedProd?.code || it.code || it.productId || '').trim(),
            productName: it.name,
            name: it.name,

            type: 'IN', // รับเข้า (+IN)
            docType: 'GRN',
            docNo: grnNumber, // เช่น GRN-PO-PD-2026-003-01
            documentNo: grnNumber,
            grnNo: grnNumber,
            grnNumber: grnNumber,
            poNo: targetPO.poNo || targetPO.id, // เช่น PO-PD-2026-003
            poNumber: targetPO.poNo || targetPO.id,
            refPo: targetPO.poNo || targetPO.id,
            prNo: targetPO.prNo || targetPO.prNumber || '',
            quantity: it.quantity, // จำนวนในหน่วยสต็อก (เช่น +20 ชิ้น)
            qty: it.quantity,
            receivedQty: it.receivedQty, // จำนวนหน่วยจัดซื้อ (เช่น 10 คู่)
            unit: it.stockUnit || it.baseUom || 'ชิ้น',
            stockUnit: it.stockUnit || it.baseUom || 'ชิ้น',
            baseUom: it.baseUom || 'ชิ้น',
            purchaseUnit: it.purchaseUnit || it.purchaseUom || 'คู่',
            purchaseUom: it.purchaseUom || 'คู่',
            conversionRatio: it.conversionRatio,
            conversionRate: it.conversionRatio,
            balanceAfter: Number(newBal), // ยอดหลังรับ (เช่น 36)
            balance: Number(newBal),
            unitPrice: Number(it.unitPrice), // ต้นทุนต่อหน่วยสต็อก (เช่น ฿50.00 / ชิ้น)
            baseUnitCost: Number(it.unitPrice),
            purchaseUnitPrice: it.purchaseUnitPrice,
            totalAmount: Number(it.totalValue), // มูลค่าเงินตาม PO จริง (เช่น 1,000.00 ฿)
            totalPrice: Number(it.totalValue),
            totalValue: Number(it.totalValue),
            actorName,
            user: actorName,
            actorRole,
            department: targetPO.department || matchedProd?.department || 'PD',
            location: matchedProd?.storageLocationName || it.locationName || 'ออฟฟิศ PD',
            locationName: matchedProd?.storageLocationName || it.locationName || 'ออฟฟิศ PD',
            notes: `ตรวจรับสินค้าตามใบสั่งซื้อ ${targetPO.poNo || targetPO.id} (${vendorName})`,
            note: `ตรวจรับสินค้าตามใบสั่งซื้อ ${targetPO.poNo || targetPO.id} (${vendorName})`,
            createdAt: new Date().toISOString()
          };
        });

        storageService.logStockMovements(movementsToEmit);

        if (appContext?.setStockLogs) {
          appContext.setStockLogs(prev => [...movementsToEmit, ...(prev || [])]);
        }
      }

      // 6. Calculate updatedPoItems reflecting this inspection round with dynamic remaining quantity & refund settlement
      const updatedPoItems = (targetPO.items || []).map((poItem, poIdx) => {
        const lineKey = getLineKey(poItem, poIdx);
        const inspected = computedItems.find(row => row.key === lineKey) ||
          computedItems[poIdx] ||
          computedItems.find(row => 
            (row.id && (row.id === poItem.id || row.productId === poItem.id)) || 
            (row.productId && (row.productId === poItem.productId || row.productId === poItem.id)) ||
            (row.code && String(row.code).trim().toUpperCase() === String(poItem.code || poItem.sku).trim().toUpperCase()) ||
            (row.key !== undefined && (row.key === poItem.productId || row.key === poIdx))
          );
        
        if (!inspected) return poItem;

        const ordered = Number(poItem.orderedQty ?? poItem.actualQty ?? poItem.quantity ?? poItem.purchaseQty ?? poItem.qty ?? 0);
        const prevReceived = Number(poItem.accumulatedReceived ?? poItem.receivedQty ?? 0);
        const prevDamaged = Number(poItem.damagedQty ?? 0);
        
        const refundInfo = resolveRefundedQtyAndAmount(poItem, targetPO);
        const refunded = Number(inspected.refunded ?? refundInfo.refundedQty ?? poItem.refundedQty ?? 0);
        const refundAmount = Number(inspected.refundAmount ?? refundInfo.refundAmount ?? poItem.refundAmount ?? 0);
        const isItemRefunded = refunded > 0 || poItem.claimResolution === 'REFUND' || refundInfo.isRefunded;

        const allowedReceiveQty = Math.max(0, ordered - prevReceived - refunded);

        const receivedThisRound = allowedReceiveQty === 0 ? 0 : Math.max(0, Math.min(Number(inspected.acceptedQty || 0), allowedReceiveQty));
        const damagedThisRound = allowedReceiveQty === 0 ? 0 : Math.max(0, Math.min(Number(inspected.damagedQty || 0), allowedReceiveQty - receivedThisRound));

        const totalReceived = prevReceived + receivedThisRound;
        const totalDamaged = prevDamaged + damagedThisRound;
        const shortage = Math.max(0, ordered - totalReceived - refunded - totalDamaged);

        const sAction = inspected.shortageAction || (inspected.shortageReason === 'SPLIT_SHIPMENT' ? 'WAIT_NEXT_ROUND' : (shortage > 0 ? 'CLAIM_SHORTAGE' : ''));
        const isWait = sAction === 'WAIT_NEXT_ROUND';
        const hasItemDispute = (damagedThisRound > 0) || (shortage > 0 && sAction === 'CLAIM_SHORTAGE');
        const disputeAction = isWait ? 'WAIT_NEXT_ROUND' : (hasItemDispute ? 'CLAIM' : 'NONE');

        return {
          ...poItem,
          orderedQty: ordered,
          receivedQty: totalReceived,
          goodQty: totalReceived,
          acceptedQty: totalReceived,
          accumulatedReceived: totalReceived,
          damagedQty: totalDamaged,
          shortageQty: shortage,
          refundedQty: refunded,
          refundAmount: refundAmount || poItem.refundAmount,
          isSettled: isItemRefunded ? true : (hasItemDispute ? false : poItem.isSettled),
          claimResolution: isItemRefunded ? 'REFUND' : (hasItemDispute ? null : poItem.claimResolution),
          replacementPendingQty: hasItemDispute ? 0 : poItem.replacementPendingQty,
          shortageAction: sAction,
          shortageReason: isWait ? 'SPLIT_SHIPMENT' : (sAction === 'CLAIM_SHORTAGE' ? 'VENDOR_SHORTAGE' : (poItem.shortageReason || '')),
          isDamaged: totalDamaged > 0,
          defectReason: inspected.defectNote || poItem.defectReason || '',
          disputeAction: disputeAction,
          hasDispute: hasItemDispute
        };
      });

      let finalTargetPO = {
        ...(grResult?.po || targetPO),
        items: updatedPoItems
      };

      const hasActiveDispute = summary.isClaimRequired || disputeItems.length > 0;
      const isCompleteReceipt = !hasActiveDispute && (isFullyAccounted || summary.isFullyAccepted || statusOverride === 'CLOSED' || statusOverride === 'COMPLETED' || finalTargetPO.status === 'COMPLETED');

      if (isCompleteReceipt) {
        finalTargetPO = {
          ...finalTargetPO,
          status: 'COMPLETED',
          workflowStatus: 'COMPLETED',
          isCompleted: true,
          isClosed: true,
          claimStatus: (finalTargetPO.claimStatus === 'RESOLVED' || isFullyAccounted) ? 'RESOLVED' : (finalTargetPO.claimStatus || 'RESOLVED'),
          hasDispute: false,
          isInClaim: false,
          hasUnresolvedClaim: false,
          completedAt: finalTargetPO.completedAt || new Date().toISOString(),
          receivingInfo: receivingMetadata,
          receivedBy: receivingMetadata.receiverName,
          receiverName: receivingMetadata.receiverName,
          receiverSignature: receivingMetadata.receiverSignature,
          receivedAt: receivingMetadata.receivedAt
        };
      }

      // --- Inline Fast-Track Claim Logic (Self-Procurement) ---
      let skipDefaultClaimFiling = false;
      if (!isOnlinePurchase && summary.isClaimRequired && inlineClaimAction !== 'PENDING') {
        skipDefaultClaimFiling = true; // We resolve it right away

        if (inlineClaimAction === 'REPLACEMENT') {
           finalTargetPO = {
             ...finalTargetPO,
             status: 'WAITING_DELIVERY_ROUND_2',
             workflowStatus: 'WAITING_DELIVERY_ROUND_2',
             claimStatus: 'REPLACEMENT_PENDING',
             hasDispute: true,
             isInClaim: true,
             isCompleted: false,
             isClosed: false,
             inlineClaimData: {
               resolution: 'REPLACEMENT',
               expectedDelivery: inlineExpectedDelivery,
               note: inlineClaimNote,
               resolvedAt: timestamp,
               resolvedBy: actorName
             }
           };
           // Update items to wait for next round
           finalTargetPO.items = finalTargetPO.items.map(it => {
             if (it.shortageQty > 0 || it.damagedQty > 0) {
               return { ...it, shortageAction: 'WAIT_NEXT_ROUND', disputeAction: 'WAIT_NEXT_ROUND' };
             }
             return it;
           });
        } else if (inlineClaimAction === 'REFUND') {
           finalTargetPO = {
             ...finalTargetPO,
             status: 'COMPLETED_WITH_REFUND',
             workflowStatus: 'COMPLETED_WITH_REFUND',
             claimStatus: 'RESOLVED',
             hasDispute: false,
             isInClaim: false,
             hasUnresolvedClaim: false,
             isCompleted: true,
             isClosed: true,
             completedAt: timestamp,
             inlineClaimData: {
               resolution: 'REFUND',
               refundAmount: Number(inlineRefundAmount || 0),
               note: inlineClaimNote,
               resolvedAt: timestamp,
               resolvedBy: actorName
             }
           };
           finalTargetPO.items = finalTargetPO.items.map(it => {
             if (it.shortageQty > 0 || it.damagedQty > 0) {
               return { ...it, claimResolution: 'REFUND', isSettled: true };
             }
             return it;
           });
        } else if (inlineClaimAction === 'WRITE_OFF') {
           finalTargetPO = {
             ...finalTargetPO,
             status: 'COMPLETED',
             workflowStatus: 'COMPLETED',
             claimStatus: 'RESOLVED',
             hasDispute: false,
             isInClaim: false,
             hasUnresolvedClaim: false,
             isCompleted: true,
             isClosed: true,
             completedAt: timestamp,
             inlineClaimData: {
               resolution: 'WRITE_OFF',
               note: inlineClaimNote,
               resolvedAt: timestamp,
               resolvedBy: actorName
             }
           };
           finalTargetPO.items = finalTargetPO.items.map(it => {
             if (it.shortageQty > 0 || it.damagedQty > 0) {
               return { ...it, claimResolution: 'WRITE_OFF', isSettled: true };
             }
             return it;
           });
        }
      }

      // 7. If Dispute exists and we didn't fast-track resolve it, register claim onto PO
      if (disputeItems.length > 0 && !skipDefaultClaimFiling) {
        const claimDesc = disputeItems.map(d => `${d.name}: ${d.description}`).join('; ');
        const claimData = {
          reason: disputeItems[0].reasonLabel,
          description: claimDesc,
          channel: targetPO.purchaseChannel || 'ONLINE',
          reportedBy: actorName || currentUser?.name || 'Warehouse Inspector',
          reportedAt: timestamp,
          disputeItems,
          items: disputeItems,
          attachments: attachments || [],
          defectImages: attachments || []
        };

        // Reset storeClaims for stores associated with disputed items in this round
        const currentStoreClaims = { ...(finalTargetPO.storeClaims || targetPO.storeClaims || {}) };
        disputeItems.forEach((dItem, dIdx) => {
          const matchedItem = (targetPO.items || []).find(it => 
            (dItem.productId && (it.productId === dItem.productId || it.id === dItem.productId)) ||
            (dItem.code && (it.code === dItem.code || it.sku === dItem.code))
          ) || dItem;
          const storeName = (matchedItem.actualStoreName || matchedItem.storeName || targetPO.actualStoreName || targetPO.storeName || '').trim();
          const plat = (matchedItem.storePlatform || matchedItem.platform || targetPO.storePlatform || targetPO.platform || 'Shopee').trim();
          const storeGroupKey = (storeName ? `${plat}_${storeName.toLowerCase()}` : '') || getStoreGroupKey(matchedItem, dIdx);
          
          const resetClaimEntry = {
            isResolved: false,
            status: 'PENDING_CLAIM',
            claimStatus: 'PENDING_CLAIM',
            type: null,
            actionType: null,
            reason: dItem.reasonLabel || disputeItems[0].reasonLabel,
            description: dItem.description || claimDesc,
            reportedAt: timestamp,
            reportedBy: actorName || currentUser?.name || 'Warehouse Inspector',
            defectNote: dItem.description || '',
            attachments: attachments || []
          };
          
          if (storeGroupKey) currentStoreClaims[storeGroupKey] = resetClaimEntry;
          if (storeName && storeName !== storeGroupKey) currentStoreClaims[storeName] = resetClaimEntry;
        });

        finalTargetPO = {
          ...finalTargetPO,
          status: 'PARTIALLY_RECEIVED_IN_CLAIM',
          workflowStatus: 'PARTIALLY_RECEIVED_IN_CLAIM',
          claimStatus: 'PENDING_CLAIM',
          hasDispute: true,
          isInClaim: true,
          hasUnresolvedClaim: true,
          isCompleted: false,
          isClosed: false,
          claimReason: disputeItems[0].reasonLabel,
          claimDescription: claimDesc,
          claimData,
          claimDetails: claimData,
          claimEvidence,
          storeClaims: currentStoreClaims
        };

        try {
          await apiService.fileClaim(targetPO.id, claimData, currentUser);
        } catch {
          // Backend offline fallback
        }
      } else if (summary.hasSplitShipment && !isCompleteReceipt) {
        // กฎเหล็ก: WAITING_DELIVERY_ROUND_2 เกิดได้เฉพาะเมื่อ Online Purchaser กดเลือก
        // "ร้านค้าส่งสินค้าใหม่ทดแทน" ใน Online Hub เท่านั้น
        // ห้ามเซ็ตจาก GRN path เด็ดขาด — ใช้ PARTIAL แทน
        finalTargetPO = {
          ...finalTargetPO,
          status: 'PARTIAL'
        };
      }

      // 8. Atomic Persistence to StorageService, Contexts & API
      if (isFullyAccounted) {
        storageService.finalizePO?.(targetPO.id, finalTargetPO);
      }
      const allPos = storageService.getPOs() || [];
      const pIdx = allPos.findIndex(p => p.id === targetPO.id || p.poNo === targetPO.id || p.poNumber === targetPO.id);
      if (pIdx !== -1) {
        allPos[pIdx] = { ...allPos[pIdx], ...finalTargetPO };
        storageService.savePOs(allPos);
      }

      if (appContext?.updatePO) {
        appContext.updatePO(targetPO.id, finalTargetPO);
      }

      try {
        await apiService.updatePO(targetPO.id, finalTargetPO, activeUser);
      } catch {
        // Backend offline fallback
      }

      if (isGAS()) {
        try {
          const gasPayload = {
            id: finalTargetPO.id,
            poNo: finalTargetPO.poNo,
            department: finalTargetPO.department,
            status: finalTargetPO.status,
            grNumber: grnNumber,
            items: finalTargetPO.items,
            history: finalTargetPO.history,
            timeline: finalTargetPO.timeline,
            activityLog: finalTargetPO.activityLog,
            grnHistory: finalTargetPO.grnHistory,
            ngItems: finalTargetPO.ngItems,
            receivedBy: receiverName,
            receiverName: receiverName,
            receivedAt: receivedAtIso,
            receivingInfo: receivingMetadata,
            actualTotalAmount: finalTargetPO.actualTotalAmount,
            savingsAmount: finalTargetPO.savingsAmount,
            settlementStatus: finalTargetPO.settlementStatus,
            settlementNote: finalTargetPO.settlementNote,
            settlementProofUrl: finalTargetPO.settlementProofUrl,
            settledBy: finalTargetPO.settledBy,
            settledAt: finalTargetPO.settledAt,
            actualItems: finalTargetPO.actualItems,
            prId: finalTargetPO.prId,
            prNo: finalTargetPO.prNo,
            prNumber: finalTargetPO.prNumber,
            currentUser: activeUser
          };
          await callGAS('apiReceivePO', gasPayload);
        } catch (gasErr) {
          console.warn('[ReceivingModal] GAS apiReceivePO error:', gasErr.message);
        }
      }

      // Optimistic state update & non-blocking background refresh
      if (appContext?.setPOs) {
        appContext.setPOs(prev => prev.map(p => (p.id === finalTargetPO.id || p.poNo === finalTargetPO.poNo) ? finalTargetPO : p));
      }
      setTimeout(() => {
        if (appContext?.loadAllData) {
          appContext.loadAllData(true);
        }
      }, 1500);

      modalService.success(
        isFullyAccounted ? 'ปิดงานใบสั่งซื้อสำเร็จ' : (summary.isClaimRequired ? 'บันทึกตรวจรับ & ส่งเรื่องเคลมเรียบร้อย' : 'บันทึกตรวจรับสินค้าสำเร็จ'),
        isFullyAccounted
          ? `ใบสั่งซื้อ ${targetPO.poNo || targetPO.id} ตรวจรับและเคลมชดเชยครบถ้วนแล้ว ปิดงานใบสั่งซื้อเรียบร้อย`
          : (summary.isClaimRequired
              ? `บันทึกรับของเข้าคลัง ${summary.totalAccepted} ชิ้น และส่งต่อเรื่องเคลมไปยังฝ่ายจัดซื้อเรียบร้อยแล้ว`
              : `บันทึกรับสินค้าเข้าคลังเรียบร้อย (เลขที่ GRN: ${grnNumber})`)
      );

      if (onSuccess) onSuccess({ po: finalTargetPO, grn: grResult?.grn });
      if (onClose) onClose();

    } catch (err) {
      modalService.error('เกิดข้อผิดพลาดในการตรวจรับสินค้า', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const modalContent = (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/70 backdrop-blur-xs animate-fade-in font-sans">
      <div className="bg-white w-full max-w-4xl rounded-xl shadow-2xl border border-slate-200/90 flex flex-col max-h-[92vh] overflow-hidden">
        
        {/* ── 1. MODAL HEADER ── */}
        <div className="px-5 py-3.5 bg-slate-900 text-white flex items-center justify-between shrink-0 border-b border-slate-800">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            {handleBackToPO && (
              <button
                type="button"
                onClick={handleBackToPO}
                className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 hover:text-white mr-1 sm:mr-3 px-2.5 py-1.5 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer shrink-0 border border-slate-700/80 shadow-2xs"
                title="กลับไปที่หน้าต่างใบสั่งซื้อ (PO)"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>กลับไปใบ PO</span>
              </button>
            )}
            <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center text-white shadow-xs shrink-0">
              <Download className="w-4.5 h-4.5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base sm:text-lg font-bold text-white tracking-tight truncate">
                  ตรวจรับพัสดุเข้าคลัง (Goods Receipt / GRN)
                </h3>
                <span className="font-mono text-xs sm:text-sm bg-slate-800 text-emerald-400 px-2.5 py-0.5 rounded font-semibold border border-slate-700 shrink-0">
                  {targetPO.poNo || targetPO.id}
                </span>
              </div>
              <p className="text-xs sm:text-sm text-slate-400 mt-0.5 truncate">
                ผู้ขาย: <span className="text-slate-200 font-semibold">{targetPO.vendorName || targetPO.vendor || '-'}</span> • แผนก: <span className="text-slate-200 font-semibold">{targetPO.department}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleFillAllComplete}
              className="text-xs font-semibold text-emerald-700 bg-emerald-50/80 hover:bg-emerald-100/80 border border-emerald-200/80 px-3 py-1.5 rounded-lg transition-all flex items-center gap-1.5 shrink-0 shadow-2xs cursor-pointer"
              title="กรอกจำนวนตรวจรับเต็มจำนวนที่ค้างรับทั้งหมด"
            >
              <span>⚡ กรอกรับครบทุกรายการ</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* ── 2. SCROLLABLE BODY (Zero Banner / Clean Workspace) ── */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 bg-slate-50/50" style={{ scrollbarWidth: 'thin' }}>
          
          {/* Informational notice when all items are fully accounted for via receipts and claims */}
          {isFullyAccounted && (
            <div className="bg-emerald-50/90 border border-emerald-200 rounded-xl p-3 flex items-start gap-2.5 text-xs text-emerald-900 shadow-2xs">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              <div>
                <div className="font-bold text-emerald-800">สินค้าทุกรายการได้รับการตรวจรับหรือเคลมชดเชยครบถ้วนแล้ว (100% Accounted)</div>
                <div className="text-emerald-700 text-[11px] mt-0.5">
                  รายการสินค้าในใบสั่งซื้อนี้รับเข้าคลังครบถ้วนหรือได้รับการชดเชยเงินคืนแล้ว สามารถกดปุ่ม &quot;ยืนยันปิดงานใบสั่งซื้อ (Finalize PO)&quot; ด้านล่างเพื่อบันทึกปิดงานสมบูรณ์
                </div>
              </div>
            </div>
          )}

          {/* Online Settlement Notification Banner */}
          {targetPO.settlementStatus === 'SETTLED' && (
            <div className="bg-emerald-50/90 border border-emerald-300 rounded-xl p-3 flex items-start gap-2.5 text-xs text-emerald-950 shadow-2xs">
              <Receipt className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-bold text-emerald-900 flex items-center justify-between">
                  <span>ใบสั่งซื้อนี้ปิดยอดจ่ายจริงแล้ว (Online Settled)</span>
                  <span className="font-mono text-emerald-800 font-black">
                    จ่ายจริง: ฿{Number(targetPO.actualTotalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="text-emerald-700 text-[11px] mt-0.5">
                  ราคาทุนสต็อกจะถูกบันทึกลง StockLogs ตามมูลค่าจ่ายจริงที่คำนวณไว้
                  {targetPO.savingsAmount > 0 && ` (ประหยัด ฿${Number(targetPO.savingsAmount).toLocaleString(undefined, { minimumFractionDigits: 2 })} คืนงบประมาณแล้ว)`}
                </div>
              </div>
            </div>
          )}

          {/* ── Line-Items Clean Compact Table ── */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
            <div className="bg-slate-50/90 px-4 py-2.5 border-b border-slate-200 flex items-center justify-between text-xs">
              <span className="font-bold text-slate-800 flex items-center gap-1.5">
                <Package className="w-4 h-4 text-slate-500" />
                <span>รายการสินค้าที่ตรวจรับ ({computedItems.length} รายการ)</span>
              </span>
              <span className="text-xs text-slate-500 font-mono">
                รอบตรวจรับที่ <strong className="font-bold text-slate-800">{currentRound}</strong>
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse table-fixed">
                <thead>
                  <tr className="bg-slate-100/80 border-b border-slate-200 text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">
                    <th className="w-5/12 min-w-[220px] py-2.5 px-4 text-left">สินค้า</th>
                    <th className="w-36 min-w-[130px] py-2.5 px-3 text-center">รอตรวจรับ (รอบนี้)</th>
                    <th className="w-24 py-2.5 px-3 text-center">รับดี (เข้าคลัง)</th>
                    <th className="w-24 py-2.5 px-3 text-center">ชำรุด (NG)</th>
                    <th className="w-20 py-2.5 px-3 text-center">ขาดส่ง</th>
                    <th className="w-48 py-2.5 px-4 text-right">สถานะ / การจัดการ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {computedItems.map((item, idx) => {
                    // Mathematical calculation of remaining pending quantity for next delivery round:
                    const orderedQty = Number(item.quantity || item.orderedQty || 0);
                    const previouslyReceived = Number(item.receivedQty || item.alreadyReceived || 0);
                    const remainingBeforeRound = Math.max(0, orderedQty - previouslyReceived);
                    
                    const rawAccepted = item.rawAcceptedInput !== undefined ? item.rawAcceptedInput : item.acceptedQty;
                    const parsedAccepted = rawAccepted === '' ? 0 : Number(rawAccepted);
                    const currentReceiveInput = isNaN(parsedAccepted) ? remainingBeforeRound : Math.max(0, parsedAccepted);

                    const rawDamaged = item.rawDamagedInput !== undefined ? item.rawDamagedInput : item.damagedQty;
                    const parsedDamaged = rawDamaged === '' ? 0 : Number(rawDamaged);
                    const currentDamageInput = isNaN(parsedDamaged) ? 0 : Math.max(0, parsedDamaged);

                    const deliveredQty = currentReceiveInput + currentDamageInput;
                    const hasDefect = currentDamageInput > 0;

                    // ยอดรวมหลังรับรอบนี้
                    const totalDelivered = previouslyReceived + (item.isRowLocked ? 0 : deliveredQty);
                    const shortageQty = Math.max(0, orderedQty - totalDelivered);
                    const isFullyDelivered = shortageQty === 0;

                    return (
                      <React.Fragment key={item.key}>
                        <tr 
                          className={`transition-colors border-b border-slate-100 ${
                            item.isOverLimit
                              ? 'bg-rose-50/60 ring-1 ring-inset ring-rose-300'
                              : item.isRowLocked && item.refunded > 0 
                                ? 'opacity-80 bg-slate-50/50' 
                                : (item.isRowLocked ? 'bg-slate-50/40' : 'hover:bg-slate-50/80')
                          }`}
                        >
                          {/* 1. สินค้า */}
                          <td className="w-5/12 min-w-[220px] py-3.5 px-4 align-middle">
                            <div className="space-y-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-mono text-xs font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded border border-slate-200 shrink-0">
                                  {item.code || `ITEM-${idx + 1}`}
                                </span>
                                <span className="text-sm font-bold text-slate-800 leading-snug" title={item.name}>
                                  {item.name}
                                </span>
                              </div>
                              <div className="text-xs text-slate-500 font-mono flex items-center gap-2 flex-wrap">
                                <span>หน่วย: <strong className="text-slate-700">{item.pUnit}</strong></span>
                                {item.conversionRatio > 1 && (
                                  <span className="text-[11px] text-indigo-700 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded font-sans">
                                    (1 {item.pUnit} = {item.conversionRatio.toLocaleString()} {item.sUnit})
                                  </span>
                                )}
                                {item.originalPurchaseQty && Number(item.originalPurchaseQty) !== Number(item.orderedQty) && (
                                  <span className="text-[11px] text-indigo-700 font-sans">
                                    (ปรับจาก PR: {item.originalPurchaseQty})
                                  </span>
                                )}
                              </div>
                              {item.isOverLimit && (
                                <div className="text-[11px] text-rose-700 font-semibold flex items-center gap-1 mt-0.5">
                                  <span>⚠</span>
                                  <span>จำนวนรวมเกินยอดค้างรับ ({item.remainingToReceive} {item.pUnit}) — ระบบจะ clamp อัตโนมัติ</span>
                                </div>
                              )}
                            </div>
                          </td>

                        {/* 2. รอตรวจรับ (รอบนี้) */}
                        <td className="w-36 min-w-[130px] py-3.5 px-3 text-center align-middle">
                          <div className="flex flex-col items-center justify-center">
                            {/* Hero Number */}
                            <div className="flex items-baseline justify-center gap-1">
                              <span className="font-mono font-bold text-slate-800 text-base leading-none">
                                {item.remainingToReceive}
                              </span>
                              <span className="text-xs text-slate-500 font-medium font-sans">
                                {item.pUnit}
                              </span>
                            </div>
                            {/* Context Subtext */}
                            <span className="text-[11px] text-slate-400 mt-1 whitespace-nowrap font-sans">
                              สั่งทั้งหมด {orderedQty} • รับแล้ว {previouslyReceived}
                            </span>
                          </div>
                        </td>

                        {/* 3. รับดี (เข้าคลัง) */}
                        <td className="w-24 py-3.5 px-3 text-center align-middle">
                          <div className="flex flex-col items-center justify-center">
                            <div className="h-10 flex items-center justify-center">
                              <input
                                type="number"
                                min="0"
                                max={remainingBeforeRound}
                                value={item.isRowLocked ? 0 : item.rawAcceptedInput}
                                disabled={item.isRowLocked}
                                onChange={(e) => handleAcceptedQtyChange(item.key, e.target.value)}
                                className={`h-10 w-20 text-center font-bold text-base rounded-xl outline-none transition-all duration-150 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${
                                  item.isRowLocked
                                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed border-slate-200 select-none'
                                    : item.isOverLimit
                                      ? 'bg-rose-50 border-2 border-rose-500 text-rose-700 focus:ring-4 focus:ring-rose-500/20 shadow-sm'
                                      : 'bg-white border-2 border-emerald-400/80 text-emerald-700 focus:ring-4 focus:ring-emerald-500/10 focus:border-emerald-500 shadow-sm'
                                }`}
                                title={item.isRowLocked ? 'ปิดรับแล้ว' : 'จำนวนสินค้าสมบูรณ์ที่รับรอบนี้'}
                              />
                            </div>
                          </div>
                        </td>

                        {/* 4. ชำรุด (NG) */}
                        <td className="w-24 py-3.5 px-3 text-center align-middle">
                          <div className="flex flex-col items-center justify-center">
                            <div className="h-10 flex items-center justify-center">
                              <input
                                type="number"
                                min="0"
                                max={item.remainingQty}
                                value={item.isRowLocked ? 0 : item.rawDamagedInput}
                                disabled={item.isRowLocked}
                                onChange={(e) => handleDamagedQtyChange(item.key, e.target.value)}
                                className={`h-10 w-20 text-center font-bold text-base rounded-xl outline-none transition-all duration-150 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${
                                  item.isRowLocked
                                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed border-slate-200 select-none'
                                    : item.isOverLimit
                                      ? 'bg-rose-50 border-2 border-rose-500 text-rose-700 focus:ring-4 focus:ring-rose-500/20 shadow-sm'
                                      : item.hasDamage
                                        ? 'bg-rose-50/30 border-2 border-rose-400 text-rose-700 focus:ring-4 focus:ring-rose-500/10 shadow-sm'
                                        : 'bg-slate-50/50 border border-slate-200 text-slate-400 hover:border-slate-300'
                                }`}
                                title={item.isRowLocked ? 'ปิดรับแล้ว' : 'จำนวนสินค้าชำรุดเสียหาย'}
                              />
                            </div>
                          </div>
                        </td>

                        {/* 5. ขาดส่ง */}
                        <td className="w-20 py-3.5 px-3 text-center align-middle">
                          <div className="flex flex-col items-center justify-center">
                            <div className="h-10 flex items-center justify-center">
                              {shortageQty > 0 ? (
                                <span className="inline-flex items-center justify-center h-10 w-16 rounded-xl font-bold text-sm bg-amber-50 text-amber-700 border border-amber-200/80">
                                  {shortageQty}
                                </span>
                              ) : (
                                <span className="inline-flex items-center justify-center h-10 w-16 rounded-xl font-bold text-sm border border-transparent text-slate-300">-</span>
                              )}
                            </div>
                          </div>
                        </td>

                        {/* 6. สถานะ / การจัดการ */}
                        <td className="w-48 py-3.5 px-4 align-middle text-right">
                          <div className="flex flex-col items-end gap-1.5 w-full">
                            {item.isRowLocked ? (
                              item.refunded > 0 ? (
                                <span className="inline-flex items-center justify-center px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200/80 whitespace-nowrap">
                                  💰 ได้รับเงินคืนแล้ว ฿{item.refundAmountFormatted}
                                </span>
                              ) : (
                                <span className="inline-flex items-center justify-center px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200 whitespace-nowrap">
                                  <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0 mr-1" />
                                  ตรวจรับครบแล้วในรอบก่อน
                                </span>
                              )
                            ) : (hasDefect && shortageQty > 0) ? (
                              <>
                                <div className="flex items-center justify-end gap-1.5 w-full flex-wrap">
                                  <span className="bg-rose-50 border border-rose-200/80 text-rose-700 px-2.5 py-1 rounded-full font-medium text-xs inline-flex items-center gap-1 whitespace-nowrap">
                                    <AlertTriangle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                                    <span>ชำรุด {currentDamageInput}</span>
                                  </span>
                                  <span className="bg-amber-50 border border-amber-200/80 text-amber-700 px-2.5 py-1 rounded-full font-medium text-xs inline-flex items-center gap-1 whitespace-nowrap">
                                    <span>ขาด {shortageQty}</span>
                                  </span>
                                </div>
                                <span className="text-[11px] text-slate-400 mt-0.5 inline-block whitespace-nowrap">
                                  ↳ {isOnlinePurchase ? 'ส่งต่องานให้จัดซื้อออนไลน์ประสานงานร้านค้า' : 'ผู้สั่งซื้อดำเนินการประสานงานเคลมกับร้านค้าด้วยตนเอง'}
                                </span>
                              </>
                            ) : hasDefect ? (
                              <>
                                <div className="flex items-center justify-end w-full">
                                  <span className="bg-rose-50 border border-rose-200/80 text-rose-700 px-2.5 py-1 rounded-full font-medium text-xs inline-flex items-center gap-1 whitespace-nowrap">
                                    <AlertTriangle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                                    <span>ชำรุด {currentDamageInput} {item.pUnit}</span>
                                  </span>
                                </div>
                                <span className="text-[11px] text-slate-400 mt-0.5 inline-block whitespace-nowrap">
                                  ↳ {isOnlinePurchase ? 'ส่งต่องานให้จัดซื้อออนไลน์ประสานงานร้านค้า' : 'ผู้สั่งซื้อดำเนินการประสานงานเคลมกับร้านค้าด้วยตนเอง'}
                                </span>
                              </>
                            ) : shortageQty > 0 ? (
                              <>
                                <div className="flex items-center justify-end w-full">
                                  <span className="bg-amber-50 border border-amber-200/80 text-amber-700 px-2.5 py-1 rounded-full font-medium text-xs inline-flex items-center gap-1 whitespace-nowrap">
                                    <span>ขาด {shortageQty} {item.pUnit}</span>
                                  </span>
                                </div>
                                <span className="text-[11px] text-slate-400 mt-0.5 inline-block whitespace-nowrap">
                                  ↳ {isOnlinePurchase ? 'ส่งต่องานให้จัดซื้อออนไลน์ประสานงานร้านค้า' : 'ผู้สั่งซื้อดำเนินการประสานงานเคลมกับร้านค้าด้วยตนเอง'}
                                </span>
                              </>
                            ) : (
                              <div className="flex items-center justify-end w-full">
                                <span className="bg-emerald-50 text-emerald-700 border border-emerald-200/80 px-2.5 py-1 rounded-full font-medium text-xs inline-flex items-center gap-1.5 whitespace-nowrap">
                                  <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                                  <span>ครบถ้วน</span>
                                </span>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>

                      {/* Sub-row Panel for Defect Context */}
                      {item.hasDamage && !item.isRowLocked && (
                        <tr className="bg-slate-50/30">
                          <td colSpan="6" className="p-0 border-b border-slate-200">
                            <div className="bg-rose-50/50 border-t border-rose-200/60 p-3 mx-4 mb-3 rounded-b-xl flex flex-col md:flex-row items-center gap-3">
                              <div className="flex-1 w-full flex items-center gap-2">
                                <AlertTriangle className="w-4 h-4 text-rose-500 shrink-0" />
                                <input
                                  type="text"
                                  placeholder="ระบุอาการชำรุด เช่น แตกหัก, ฉีกขาด..."
                                  value={item.defectNote || ''}
                                  onChange={(e) => handleDefectNoteChange(item.key, e.target.value)}
                                  className="w-full h-9 px-3 text-sm bg-white border border-rose-200 rounded-lg text-rose-900 placeholder:text-rose-300 focus:outline-none focus:ring-2 focus:ring-rose-400 focus:border-rose-400 shadow-xs"
                                />
                              </div>
                              <div className="shrink-0 flex items-center gap-3">
                                <span className="text-[10px] text-rose-500 font-medium">
                                  * จำเป็นต้องระบุอาการและแนบรูปเพื่อส่งเรื่องเคลม
                                </span>
                                <button
                                  type="button"
                                  onClick={() => fileInputRef.current?.click()}
                                  className="h-9 px-3 bg-white hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-lg text-xs font-bold cursor-pointer flex items-center gap-1.5 transition-all shadow-xs"
                                >
                                  <Camera className="w-4 h-4" />
                                  <span>ถ่ายรูป / แนบหลักฐาน</span>
                                  {attachments.length > 0 && (
                                    <span className="ml-1 px-1.5 py-0.5 bg-rose-600 text-white rounded-full text-[10px]">
                                      {attachments.length}
                                    </span>
                                  )}
                                </button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── 3. Compact Note & Photos Grid (Symmetrical Equal-Height Columns) ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-stretch">
            {/* Note */}
            <div className="bg-white rounded-xl border border-slate-200 p-3.5 space-y-2 shadow-2xs flex flex-col h-full">
              <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5 shrink-0">
                <FileText className="w-4 h-4 text-slate-500" />
                <span>หมายเหตุการตรวจรับ</span>
              </label>
              <textarea
                value={grnNote}
                onChange={(e) => setGrnNote(e.target.value)}
                placeholder="บันทึกข้อความเพิ่มเติม เช่น พัสดุอยู่ในสภาพเรียบร้อย..."
                className="w-full flex-1 min-h-[88px] p-2.5 text-xs sm:text-sm bg-slate-50 focus:bg-white border border-slate-200 focus:border-slate-400 rounded-lg outline-none resize-none transition-all placeholder:text-slate-400"
              />
            </div>

            {/* Attachments */}
            <div className="bg-white rounded-xl border border-slate-200 p-3.5 space-y-2 shadow-2xs flex flex-col justify-between h-full">
              <div className="flex items-center justify-between shrink-0">
                <label className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <Camera className="w-4 h-4 text-slate-500" />
                  <span>ภาพถ่ายพัสดุ / ใบปะหน้ากล่อง</span>
                </label>
                <label className="h-7 px-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 rounded-md text-xs sm:text-sm font-medium cursor-pointer flex items-center gap-1.5 transition-all">
                  <UploadCloud className="w-3.5 h-3.5 text-slate-600" />
                  <span>{isUploading ? 'กำลังแนบ...' : '+ เพิ่มไฟล์'}</span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,application/pdf"
                    multiple
                    onChange={handleFileUpload}
                    disabled={isUploading}
                    className="hidden"
                  />
                </label>
              </div>

              {attachments.length === 0 ? (
                <div className="flex-1 min-h-[88px] border border-dashed border-slate-200 rounded-lg flex items-center justify-center text-slate-400 text-xs sm:text-sm gap-2 bg-slate-50/50">
                  <Camera className="w-4 h-4 text-slate-300" />
                  <span>ยังไม่มีรูปถ่ายหรือเอกสารแนบ</span>
                </div>
              ) : (
                <div className="flex-1 min-h-[88px] grid grid-cols-4 gap-2 overflow-y-auto pr-1">
                  {attachments.map((att, i) => (
                    <div 
                      key={i} 
                      className="relative group bg-slate-50 border border-slate-200 rounded-md p-1 overflow-hidden h-20 flex flex-col items-center justify-center cursor-pointer hover:border-indigo-400 hover:shadow-xs transition-all shrink-0"
                      title="คลิกเพื่อดูตัวอย่างเอกสาร/รูปภาพจริง"
                    >
                      {att.type === 'application/pdf' ? (
                        <div 
                          className="w-full h-12 bg-rose-50 rounded flex flex-col items-center justify-center text-rose-500 hover:scale-105 transition-transform"
                          onClick={() => setPreviewAttachment({ file: att, url: att.localUrl || att.previewUrl || att.fileUrl || att.dataUrl, title: att.name || att.fileName })}
                        >
                          <FileText className="w-4 h-4" />
                          <span className="text-[9px] font-bold mt-0.5">PDF</span>
                        </div>
                      ) : (
                        <AttachmentThumbnail 
                          img={att} 
                          imgIdx={i} 
                          sizeClass="w-full h-12" 
                          onClick={() => setPreviewAttachment({ file: att, url: att.localUrl || att.previewUrl || att.fileUrl || att.dataUrl, title: att.name || att.fileName })}
                        />
                      )}
                      <p className="text-[9px] text-slate-500 truncate w-full text-center mt-0.5 font-mono">
                        {att.name || att.fileName || `ไฟล์ ${i+1}`}
                      </p>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveAttachment(i);
                        }}
                        className="absolute top-1 right-1 p-0.5 bg-rose-600 hover:bg-rose-700 text-white rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer z-20"
                        title="ลบไฟล์"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── Summary Status Banner ── */}
          {summary.isFullyAccepted ? (
            <div className="w-full flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 py-2.5 rounded-xl border border-emerald-200 bg-emerald-50/80 text-emerald-800 text-xs font-medium mb-4">
              <div className="flex items-center gap-2">
                <span className="text-emerald-600 font-bold">✓</span>
                <span>ตรวจรับครบถ้วนสมบูรณ์ — บันทึกรับเข้าสต็อกและปิดเอกสาร PO</span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-auto font-mono">
                <span className="text-emerald-700">รับเข้าสต็อก:</span>
                <span className="px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-900 font-bold text-xs">
                  {totalAcceptedQty} รายการ
                </span>
              </div>
            </div>
          ) : summary.isClaimRequired ? (
            <div className="w-full flex flex-col gap-3 px-4 py-3.5 rounded-xl border border-amber-200 bg-amber-50/80 mb-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-amber-800 text-xs font-medium">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>พบสินค้าขาดส่งหรือชำรุด — {isOnlinePurchase ? 'บันทึกเฉพาะยอดสมบูรณ์เข้าคลัง และส่งเรื่องเคลมไปยังฝ่ายจัดซื้อ' : 'ระบุแนวทางการเคลมและจัดการผลลัพธ์ด้วยตนเอง'}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-auto font-mono text-xs">
                  <span className="text-slate-700">รับเข้าสต็อก:</span>
                  <span className="px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-900 font-bold text-xs">
                    {totalAcceptedQty} รายการ
                  </span>
                  {summary.totalDamaged > 0 && (
                    <span className="px-2 py-0.5 rounded-md bg-rose-100 text-rose-800 font-bold text-xs">
                      ชำรุด: {summary.totalDamaged}
                    </span>
                  )}
                  {summary.totalShortage > 0 && (
                    <span className="px-2 py-0.5 rounded-md bg-amber-100 text-amber-900 font-bold text-xs">
                      ยอดค้าง: {summary.totalShortage}
                    </span>
                  )}
                </div>
              </div>
              
              {!isOnlinePurchase && (
                <div className="mt-2 bg-white/60 border border-amber-200/60 rounded-lg p-3.5 animate-fade-in shadow-2xs">
                  <h4 className="text-xs font-bold text-slate-800 mb-2 flex items-center gap-1.5">
                    <span className="w-1.5 h-4 bg-amber-500 rounded-full inline-block"></span>
                    จัดการผลเคลมกับร้านค้า (Inline Claim Resolution)
                  </h4>
                  <div className="space-y-2">
                    <label className="flex items-start gap-2.5 p-2.5 rounded-lg border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/30 transition-colors cursor-pointer group">
                      <input 
                        type="radio" 
                        name="inlineClaimAction" 
                        value="PENDING" 
                        checked={inlineClaimAction === 'PENDING'} 
                        onChange={() => setInlineClaimAction('PENDING')}
                        className="mt-0.5" 
                      />
                      <div className="flex-1">
                        <p className="text-xs font-bold text-slate-700 group-hover:text-indigo-700">บันทึกปัญหาไว้ก่อน (รอประสานงานร้านค้า)</p>
                        <p className="text-[11px] text-slate-500">บันทึกรับดีเข้าคลัง และนำงานไปพักไว้ที่เมนู "ต้องดำเนินการ" เพื่อกลับมาบันทึกผลเจรจาในภายหลัง</p>
                      </div>
                    </label>

                    <label className="flex items-start gap-2.5 p-2.5 rounded-lg border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/30 transition-colors cursor-pointer group">
                      <input 
                        type="radio" 
                        name="inlineClaimAction" 
                        value="REPLACEMENT" 
                        checked={inlineClaimAction === 'REPLACEMENT'} 
                        onChange={() => setInlineClaimAction('REPLACEMENT')}
                        className="mt-0.5" 
                      />
                      <div className="flex-1">
                        <p className="text-xs font-bold text-slate-700 group-hover:text-indigo-700">ส่งสินค้าใหม่ทดแทน (Replacement)</p>
                        <p className="text-[11px] text-slate-500">ร้านค้ายินยอมส่งของมาทดแทนส่วนที่ขาด/ชำรุด งานจะแสดงปุ่ม "ตรวจรับรอบ 2" ทันที</p>
                        {inlineClaimAction === 'REPLACEMENT' && (
                          <div className="mt-2 flex items-center gap-2 animate-fade-in">
                            <span className="text-[11px] font-semibold text-slate-600">วันที่คาดว่าจะได้รับ:</span>
                            <input type="date" value={inlineExpectedDelivery} onChange={e => setInlineExpectedDelivery(e.target.value)} className="text-xs px-2 py-1 border border-slate-200 rounded-md outline-none focus:border-indigo-400" />
                          </div>
                        )}
                      </div>
                    </label>

                    <label className="flex items-start gap-2.5 p-2.5 rounded-lg border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/30 transition-colors cursor-pointer group">
                      <input 
                        type="radio" 
                        name="inlineClaimAction" 
                        value="REFUND" 
                        checked={inlineClaimAction === 'REFUND'} 
                        onChange={() => setInlineClaimAction('REFUND')}
                        className="mt-0.5" 
                      />
                      <div className="flex-1">
                        <p className="text-xs font-bold text-slate-700 group-hover:text-indigo-700">ได้รับเงินคืน / ปรับปรุงยอด (Refund)</p>
                        <p className="text-[11px] text-slate-500">ร้านค้าคืนเงินสำหรับส่วนที่ชำรุด/ขาด ระบบจะปิด PO และส่งยอดเงินคืนเข้าสมุดบัญชีงบประมาณ</p>
                        {inlineClaimAction === 'REFUND' && (
                          <div className="mt-2 flex items-center gap-2 animate-fade-in">
                            <span className="text-[11px] font-semibold text-slate-600">ยอดเงินคืน (บาท):</span>
                            <input type="number" min="0" step="0.01" placeholder="ระบุจำนวนเงินคืน" value={inlineRefundAmount} onChange={e => setInlineRefundAmount(e.target.value)} className="text-xs px-2 py-1 border border-slate-200 rounded-md outline-none focus:border-indigo-400 w-32" />
                          </div>
                        )}
                      </div>
                    </label>
                    
                    <label className="flex items-start gap-2.5 p-2.5 rounded-lg border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/30 transition-colors cursor-pointer group">
                      <input 
                        type="radio" 
                        name="inlineClaimAction" 
                        value="WRITE_OFF" 
                        checked={inlineClaimAction === 'WRITE_OFF'} 
                        onChange={() => setInlineClaimAction('WRITE_OFF')}
                        className="mt-0.5" 
                      />
                      <div className="flex-1">
                        <p className="text-xs font-bold text-slate-700 group-hover:text-indigo-700">ยอมรับสภาพ / ใช้งานตามจริง (Write-off)</p>
                        <p className="text-[11px] text-slate-500">ไม่สามารถเรียกร้องอะไรได้อีก ปิดงาน PO ตามสภาพความเป็นจริงที่ได้รับ</p>
                      </div>
                    </label>

                    {(inlineClaimAction !== 'PENDING') && (
                      <div className="mt-3 animate-fade-in">
                         <input type="text" placeholder="ระบุหมายเหตุ/ข้อตกลงเพิ่มเติมกับร้านค้า (ถ้ามี)" value={inlineClaimNote} onChange={e => setInlineClaimNote(e.target.value)} className="w-full text-xs px-3 py-2 border border-slate-200 rounded-md outline-none focus:border-indigo-400" />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="w-full flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 py-2.5 rounded-xl border border-indigo-200 bg-indigo-50/80 text-indigo-800 text-xs font-medium mb-4">
              <div className="flex items-center gap-2">
                <Truck className="w-4 h-4 text-indigo-600 shrink-0" />
                <span>พัสดุทยอยส่ง — บันทึกรับรอบที่ {currentRound} และรอพัสดุส่งรอบถัดไป</span>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-auto font-mono">
                <span className="text-indigo-700">รับเข้าสต็อก:</span>
                <span className="px-2 py-0.5 rounded-md bg-indigo-100 text-indigo-900 font-bold text-xs">
                  {totalAcceptedQty} รายการ
                </span>
              </div>
            </div>
          )}

        </div>

        {/* ── 4. MODAL FOOTER (Dynamic Action Button & Color Psychology) ── */}
        <div className="px-5 py-3.5 bg-slate-100/90 border-t border-slate-200 flex items-center justify-between shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="text-slate-600 hover:bg-slate-100 border border-slate-200 px-4 py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer shadow-2xs"
          >
            ยกเลิกและย้อนกลับ
          </button>

          {isSubmitting ? (
            <button
              type="button"
              disabled
              className="h-9 px-5 rounded-lg text-slate-500 text-xs sm:text-sm font-bold bg-slate-200 cursor-not-allowed flex items-center gap-2"
            >
              <span>กำลังบันทึกตรวจรับ...</span>
            </button>
          ) : TERMINAL_RECEIVE_STATUSES.includes(String(targetPO?.status || '').toUpperCase()) ? (
            /* ป้องกันการกดรับของซ้ำ (Double-Receipt Guard) */
            <div className="h-9 px-4 rounded-lg bg-emerald-50 text-emerald-800 border border-emerald-200 text-xs font-bold flex items-center gap-2 shadow-2xs">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>เอกสารนี้ตรวจรับเข้าคลังครบเรียบร้อยแล้ว (ปิด PO แล้ว)</span>
            </div>
          ) : (isFullyAccounted || summary.isFullyAccepted) ? (
            /* กรณีสินค้าทุกรายการตรวจรับหรือเคลมชดเชยครบถ้วนแล้ว: ปุ่มสีเขียว Emerald */
            <button
              type="button"
              onClick={handleConfirmReceiving}
              disabled={isSubmitting || isUploading}
              className="h-9 px-5 rounded-lg text-white text-xs sm:text-sm font-bold bg-emerald-600 hover:bg-emerald-700 active:scale-98 transition-all flex items-center gap-2 shadow-xs cursor-pointer"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>ยืนยันรับเข้าคลังสมบูรณ์ (ปิดงาน PO)</span>
            </button>
          ) : summary.isClaimRequired ? (
            /* กรณีมีสินค้าชำรุด หรือขาดส่งแจ้งเคลม: ปุ่มสีส้ม Amber (เปลี่ยนข้อความตาม Inline Claim Action) */
            <button
              type="button"
              onClick={handleConfirmReceiving}
              disabled={isSubmitting || isUploading || (!isOnlinePurchase && inlineClaimAction === 'REFUND' && (!inlineRefundAmount || Number(inlineRefundAmount) <= 0))}
              className={`h-9 px-5 rounded-lg text-white text-xs sm:text-sm font-bold active:scale-98 transition-all flex items-center gap-2 shadow-xs cursor-pointer ${(!isOnlinePurchase && inlineClaimAction === 'REFUND' && (!inlineRefundAmount || Number(inlineRefundAmount) <= 0)) ? 'bg-slate-300 cursor-not-allowed' : 'bg-amber-600 hover:bg-amber-700'}`}
            >
              <AlertTriangle className="w-4 h-4" />
              <span>
                {isOnlinePurchase 
                  ? '⚠️ บันทึกรับเข้าคลัง & ส่งเรื่องเคลม' 
                  : inlineClaimAction === 'REPLACEMENT' ? '⚠️ บันทึกรับเข้าคลัง & นัดรับสินค้าทดแทน'
                  : inlineClaimAction === 'REFUND' ? '⚠️ บันทึกรับเข้าคลัง & ปิดเอกสารรับเงินคืน'
                  : inlineClaimAction === 'WRITE_OFF' ? '⚠️ ยอมรับสภาพ & ปิดเอกสาร PO'
                  : '⚠️ บันทึกรับเข้าคลัง & พักรอผลเคลม'
                }
              </span>
            </button>
          ) : (
            /* กรณีรับบางส่วนแต่เป็นการทยอยส่ง (Split Delivery): ปุ่มสีน้ำเงิน Indigo */
            <button
              type="button"
              onClick={handleConfirmReceiving}
              disabled={isSubmitting || isUploading}
              className="h-9 px-5 rounded-lg text-white text-xs sm:text-sm font-bold bg-indigo-600 hover:bg-indigo-700 active:scale-98 transition-all flex items-center gap-2 shadow-xs cursor-pointer"
            >
              <Truck className="w-4 h-4" />
              <span>📦 ยืนยันรับพัสดุ (รอบที่ {currentRound})</span>
            </button>
          )}
        </div>

        {/* Real File Preview Modal */}
        {previewAttachment && (
          <AttachmentViewerModal
            file={previewAttachment.file}
            url={previewAttachment.url}
            title={previewAttachment.title}
            onClose={() => setPreviewAttachment(null)}
          />
        )}
      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return modalContent;
  }

  if (!isOpen || !targetPO) return null;

  return createPortal(
    <>
      {modalContent}
      {/* Loading Overlay — บล็อกหน้าจอตลอดระยะเวลา API บันทึกการรับสินค้าและอัปเดตสต็อค */}
      <LoadingOverlay
        isVisible={isSubmitting}
        message="กำลังบันทึกการรับสินค้าและอัปเดตสต็อค..."
      />
    </>,
    document.body
  );
}
