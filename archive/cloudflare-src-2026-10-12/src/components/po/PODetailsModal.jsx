import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { PO_STATUS } from '../../config/constants';
import { apiService } from '../../services/apiService';
import { storageService } from '../../services/storageService';
import { modalService } from '../../services/modalService';
import { useAppContext } from '../../context/AppContext';
import { 
  Printer, Download, XCircle, AlertTriangle, 
  ExternalLink, ShoppingCart, X, FileText, 
  CheckCircle2, Store, Truck, AlertOctagon,
  Camera, Trash2, ShieldAlert, Check, Package,
  ArrowLeft, Receipt
} from 'lucide-react';
import PrintablePO from './PrintablePO';
import AttachmentViewerModal from '../common/AttachmentViewerModal';
import CollapsibleActivityTimeline from '../common/CollapsibleActivityTimeline';
import POSettlementModal from './POSettlementModal';
import { generatePoPdf } from '../../utils/generatePoPdf';
import { sanitizeExternalUrl, getProductUrl } from '../../utils/urlHelper';
import ReceivingModal, { resolveRefundedQtyAndAmount } from '../../views/inventory/ReceivingModal';
import { getValidConversionRate, toStockQuantity } from '../../utils/uomEngine.js';
import { resolveDriveImageUrl, handleDriveImageError } from '../../utils/driveHelper';

const getVendorDisplayName = (vendorData) => {
  if (!vendorData) return '';
  if (typeof vendorData === 'string') return vendorData;
  if (typeof vendorData === 'object') {
    return vendorData.name || vendorData.companyName || vendorData.code || '-';
  }
  return String(vendorData);
};

export default function PODetailsModal({ selectedPO, currentRole, onClose, onRefresh, initialView = 'DETAIL' }) {
  let context = null;
  try {
    context = useAppContext();
  } catch {
    context = null;
  }
  const currentUser = context?.currentUser;
  const rawRole = typeof currentUser?.role === 'object' 
    ? (currentUser?.role?.id || currentUser?.role?.name || '') 
    : (currentUser?.role || currentRole?.roleId || currentRole?.id || '');
  const role = String(rawRole).toLowerCase();

  const isOperational = ['requester', 'asst_mgr', 'supervisor'].some(r => role.includes(r));
  const isPlantManager = role.includes('plant_mgr') || role.includes('plant manager');
  const isPurchaser = role.includes('purchaser');

  // Multi-store resolution for Online PO (Directive 3)
  const isOnlinePO = Boolean(
    selectedPO.purchaseChannel === 'ONLINE' || 
    selectedPO.orderType === 'ONLINE' ||
    selectedPO.channel === 'online'
  );
  const onlineStores = Array.from(new Set(
    (selectedPO.items || [])
      .map(it => (it.actualStoreName || it.storeName || '').trim())
      .filter(s => s && !s.includes('ระบุร้านภายหลัง'))
  ));

  const rawVendorName = selectedPO.vendorName && !selectedPO.vendorName.includes('ระบุร้านภายหลัง') ? selectedPO.vendorName : '';
  let resolvedDisplayVendor = getVendorDisplayName(selectedPO.vendor || selectedPO.shopName || rawVendorName);
  if (isOnlinePO) {
    if (onlineStores.length === 1) {
      resolvedDisplayVendor = onlineStores[0];
    } else if (onlineStores.length > 1) {
      resolvedDisplayVendor = 'แพลตฟอร์ม Shopee / Lazada Marketplace (สั่งซื้อออนไลน์)';
    }
  }
  const displayVendor = resolvedDisplayVendor;
  const hasAssignedVendor = Boolean((selectedPO.vendorId && selectedPO.vendorId !== 'ONLINE') || (displayVendor && displayVendor.trim().length > 0) || (selectedPO.vendorId === 'ONLINE' && displayVendor));

  const [isReceiving, setIsReceiving] = useState(false);
  const [showReceivingModal, setShowReceivingModal] = useState(false);
  const [showSettlementModal, setShowSettlementModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Unified View-Swapping State: 'DETAIL' | 'CLAIM'
  const [activeView, setActiveView] = useState(initialView);
  const [receivingQtys, setReceivingQtys] = useState({});
  const [problematicItems, setProblematicItems] = useState({});
  const [grAttachments, setGrAttachments] = useState([]);
  const [_isUploading, setIsUploading] = useState(false);
  const [receiveNote, _setReceiveNote] = useState('');
  const [isAssigning, setIsAssigning] = useState(false);
  const [selectedVendorId, setSelectedVendorId] = useState('');
  const [customVendorName, setCustomVendorName] = useState('');
  const [vendors, setVendors] = useState([]);
  const [viewingAttachment, setViewingAttachment] = useState(null);
  const [_isShortClosing, setIsShortClosing] = useState(false);
  const [claimReason, setClaimReason] = useState('สินค้าชำรุด/เสียหาย');
  const [claimDescription, setClaimDescription] = useState('');
  const [claimPhoto, setClaimPhoto] = useState(null);
  const [isSubmittingClaim, setIsSubmittingClaim] = useState(false);
  const claimFileInputRef = useRef(null);
  // Self-buy Claim Resolution state
  const [showSelfClaimResolution, setShowSelfClaimResolution] = useState(() => ['CLAIM_REPORTED', 'CLAIM_IN_PROGRESS'].includes(selectedPO?.status) && selectedPO?.purchaseChannel === 'SELF');
  const [selfClaimResolutionType, setSelfClaimResolutionType] = useState('RESEND');
  const [selfClaimNote, setSelfClaimNote] = useState('');
  const [selfClaimExpectedDate, setSelfClaimExpectedDate] = useState('');
  const [selfClaimRefundAmount, setSelfClaimRefundAmount] = useState('');
  const [_isResolvingSelfClaim, setIsResolvingSelfClaim] = useState(false);
  const fileInputRef = useRef(null);

  // Pre-fill receiving qtys, locations, and problematic items state
  const initReceivingQtys = (fillAll = false) => {
    const qtys = {};
    const problems = {};
    selectedPO.items.forEach(item => {
      const ordered = Number(item.orderedQty ?? item.purchaseQty ?? item.qty) || 0;
      const received = Number(item.receivedQty) || 0;
      const remaining = Math.max(0, ordered - received);
      qtys[item.productId] = fillAll ? remaining : remaining;
      problems[item.productId] = {
        isProblematic: false,
        claimedQty: remaining || 1,
        reason: 'DAMAGED',
        description: '',
        photo: null
      };
    });
    setReceivingQtys(qtys);
    setProblematicItems(problems);
  };

  useEffect(() => {
    setVendors(storageService.getVendors());
    if (selectedPO?.items) {
      initReceivingQtys(true);
    }
  }, [selectedPO]);

  const _handleFillAll = () => initReceivingQtys(true);

  // Compress image file via HTML Canvas
  const compressImageFile = (file) => {
    return new Promise((resolve, reject) => {
      if (!file.type.startsWith('image/')) {
        resolve(file);
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;
          const maxDimension = 1400;
          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height * maxDimension) / width);
              width = maxDimension;
            } else {
              width = Math.round((width * maxDimension) / height);
              height = maxDimension;
            }
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
          resolve({
            name: file.name,
            size: Math.round(dataUrl.length * (3/4)),
            type: 'image/jpeg',
            previewUrl: dataUrl,
            dataUrl: dataUrl,
            uploadedAt: new Date().toLocaleString('th-TH')
          });
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  // Process and validate attachments (PDF max 2MB, Images compressed)
  const _handleFileUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setIsUploading(true);

    try {
      const processed = [];
      for (const file of files) {
        if (file.type === 'application/pdf') {
          if (file.size > 2 * 1024 * 1024) {
            modalService.warning('ขนาดไฟล์ PDF เกินกำหนด', `ไฟล์ "${file.name}" มีขนาดเกิน 2MB กรุณาลดขนาดไฟล์ก่อนแนบ`);
            continue;
          }
          const reader = new FileReader();
          const p = await new Promise((res) => {
            reader.onload = (re) => res({
              name: file.name,
              size: file.size,
              type: 'application/pdf',
              previewUrl: re.target.result,
              dataUrl: re.target.result,
              uploadedAt: new Date().toLocaleString('th-TH')
            });
            reader.readAsDataURL(file);
          });
          processed.push(p);
        } else if (file.type.startsWith('image/')) {
          const compressed = await compressImageFile(file);
          processed.push(compressed);
        } else {
          modalService.warning('รูปแบบไฟล์ไม่รองรับ', `ไฟล์ "${file.name}" ไม่ใช่รูปภาพหรือ PDF`);
        }
      }

      setGrAttachments(prev => [...prev, ...processed]);
    } catch (err) {
      console.error('[Workflow Error Stack]:', err.stack || err);
      modalService.error('เกิดข้อผิดพลาดในการอัปโหลดไฟล์', err.message);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const _handleRemoveAttachment = (index) => {
    setGrAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const _handleSubmitReceiving = async () => {
    // 1. Immediate Double-Click Guard
    if (isSubmitting || isReceiving) return;
    setIsSubmitting(true);

    const receivingItems = selectedPO.items.map(item => ({
      productId: item.productId,
      receivedThisTime: Number(receivingQtys[item.productId]) || 0
    }));

    const hasProblematic = Object.values(problematicItems).some(p => p.isProblematic);
    const totalReceiving = receivingItems.reduce((s, r) => s + r.receivedThisTime, 0);

    // If no normal items received and no claims filed, reject
    if (totalReceiving <= 0 && !hasProblematic) {
      setIsSubmitting(false);
      return modalService.warning('กรุณาระบุจำนวนที่รับ หรือทำเครื่องหมายรายการที่มีปัญหา');
    }

    // 2. Validate Defect Details & Quantity Boundaries (receivedQty + incomingQty <= orderedQty)
    for (const item of selectedPO.items) {
      const prob = problematicItems[item.productId];
      if (prob?.isProblematic) {
        const cQty = Number(prob.claimedQty) || 0;
        if (cQty <= 0) {
          setIsSubmitting(false);
          return modalService.warning('กรุณาระบุจำนวนที่มีปัญหา/เคลม', `สำหรับรายการ "${item.name}"`);
        }
        if (!prob.description?.trim() && !prob.defectReason?.trim()) {
          setIsSubmitting(false);
          return modalService.warning('กรุณาระบุรายละเอียดปัญหาของสินค้า', `สำหรับรายการ "${item.name}" ที่ทำเครื่องหมายว่าสินค้ามีปัญหา`);
        }
      }

      const ordered = Number(item.orderedQty ?? item.purchaseQty ?? item.qty) || 0;
      const alreadyReceived = Number(item.receivedQty) || 0;
      const incoming = Number(receivingQtys[item.productId]) || 0;

      if (incoming < 0) {
        setIsSubmitting(false);
        return modalService.warning('จำนวนรับไม่ถูกต้อง', `จำนวนรับสำหรับรายการ "${item.name}" ต้องไม่ติดลบ`);
      }

      if (alreadyReceived + incoming > ordered) {
        setIsSubmitting(false);
        return modalService.warning(
          'จำนวนรับเกินยอดสั่งซื้อ (Quantity Boundary Exceeded)',
          `รายการ "${item.name}" สั่งซื้อ ${ordered} ${item.purchaseUnit || item.unit || 'ชิ้น'} รับไปแล้ว ${alreadyReceived} จะรับเพิ่ม ${incoming} (ยอดรวม ${alreadyReceived + incoming} เกินกว่าจำนวนที่สั่งซื้อใน PO)`
        );
      }
    }

    const allRemaining = selectedPO.items.every(item => {
      const ordered = Number(item.orderedQty ?? item.purchaseQty ?? item.qty) || 0;
      const received = Number(item.receivedQty) || 0;
      const remaining = ordered - received;
      const thisReceive = Number(receivingQtys[item.productId]) || 0;
      return thisReceive >= remaining;
    });

    const confirmTitle = hasProblematic ? 'ยืนยันการตรวจรับพร้อมแจ้งเคลมสินค้า' : 'ยืนยันการตรวจรับสินค้า';
    const confirmMsg = hasProblematic
      ? `รายการที่ไม่มีปัญหาจะถูกบันทึกรับเข้าสต็อกปกติ ส่วนรายการที่ระบุ "มีปัญหา/เคลม" จะถูกส่งเข้าขั้นตอนการเคลม (สถานะ PO จะเปลี่ยนเป็น "CLAIM_REPORTED" เพื่อรอการแก้ไข)\n\nยืนยันบันทึกการตรวจรับและแจ้งเคลมใช่หรือไม่?`
      : allRemaining
        ? `ยืนยันตรวจรับสินค้าครบทุกรายการ และปิด PO ${selectedPO.poNo} หรือไม่?`
        : `ยืนยันตรวจรับสินค้าบางส่วนสำหรับ PO ${selectedPO.poNo} หรือไม่? (สถานะจะเป็น PARTIAL และยังมียอดค้างส่ง)`;

    const confirmed = await modalService.confirm({
      title: confirmTitle,
      message: confirmMsg,
      type: hasProblematic ? 'danger' : (allRemaining ? 'success' : 'warning'),
      confirmText: hasProblematic ? 'บันทึกรับของ & ส่งเรื่องเคลม' : (allRemaining ? 'ตรวจรับครบและปิด PO' : 'บันทึกการรับของ'),
      cancelText: 'ยกเลิก'
    });
    if (!confirmed) {
      setIsSubmitting(false);
      return;
    }

    setIsReceiving(true);
    // 3. Unique GR Identifier Generation
    const grNumber = `GR-${selectedPO.poNo || selectedPO.id}-${Date.now()}`;

    try {
      const receiveAction = context?.receivePOItems || context?.receiveGoods || apiService.receiveGoods;
      await receiveAction(
        selectedPO.id, 
        receivingItems, 
        receiveNote.trim(),
        {
          grNumber,
          grId: grNumber,
          problematicItems,
          grAttachments
        }
      );
      if (hasProblematic) {
        await modalService.success(
          'บันทึกตรวจรับและส่งเรื่องเคลมแล้ว',
          `บันทึกรับของเข้าสต็อกบางส่วน และส่งเคสสินค้ามีปัญหาสำหรับ PO ${selectedPO.poNo} เรียบร้อยแล้ว (สถานะ: CLAIM_REPORTED)`
        );
      } else {
        // Cascading Completion on 100% Goods Receipt
        if (allRemaining) {
          const recAt = new Date().toISOString();
          const recName = (currentUser?.name && currentUser.name !== 'Admin System') 
            ? currentUser.name 
            : (currentUser?.employeeName || 'คุณวิชัย สุขใจ');
          const recSig = currentUser?.signatureUrl || currentUser?.signature || '/signatures/receiver-default.png';

          if (context?.updatePO) {
            context.updatePO(selectedPO.id, { 
              status: 'COMPLETED', 
              fullyReceivedAt: recAt,
              receivingInfo: {
                receiverName: recName,
                receiverSignature: recSig,
                receivedAt: recAt
              },
              receivedBy: recName,
              receiverName: recName,
              receiverSignature: recSig,
              receivedAt: recAt
            });
          }
          const prTarget = selectedPO.prNumber || selectedPO.prNo || selectedPO.prId;
          if (prTarget && context?.updatePR) {
            context.updatePR(prTarget, { status: 'completed' });
          }
        }
        await modalService.success(
          'ตรวจรับสินค้าสำเร็จ',
          `บันทึกการตรวจรับเข้าสต็อกสำหรับ PO ${selectedPO.poNo} เรียบร้อยแล้ว (เลขที่อ้างอิง: ${grNumber})`
        );
      }
      onRefresh();
      onClose();
    } catch (err) {
      console.error('[Workflow Error Stack]:', err.stack || err);
      modalService.error('เกิดข้อผิดพลาดในการตรวจรับ', err.message);
    } finally {
      setIsSubmitting(false);
      setIsReceiving(false);
    }
  };

  const _handleShortClosePO = async () => {
    const reason = await modalService.prompt({
      title: 'ปิดใบสั่งซื้อก่อนได้รับของครบ (Short-Close PO)',
      message: `ระบุเหตุผลในการปิด PO ${selectedPO.poNo} ที่ได้ของไม่ครบ (เช่น ร้านค้าเลิกผลิต/ไม่ส่งของที่เหลือแล้ว):`,
      placeholder: 'ระบุเหตุผลจำเป็นในการปิด PO ก่อนกำหนด...',
      required: true,
      confirmText: 'ยืนยันปิด PO ทันที',
      cancelText: 'ยกเลิก',
      type: 'warning'
    });
    if (!reason || !reason.trim()) return;

    setIsShortClosing(true);
    try {
      await apiService.shortClosePO(selectedPO.id, reason.trim(), currentRole);
      await modalService.success('ปิด PO เรียบร้อย', `ปิดใบสั่งซื้อ ${selectedPO.poNo} พร้อมบันทึกประวัติเรียบร้อยแล้ว`);
      if (onRefresh) onRefresh();
      onClose();
    } catch (err) {
      console.error('[Workflow Error Stack]:', err.stack || err);
      modalService.error('เกิดข้อผิดพลาดในการปิด PO', err.message);
    } finally {
      setIsShortClosing(false);
    }
  };

  const handleAssignVendor = async () => {
    let finalVendorId = null;
    let finalVendorName = '';

    if (selectedPO.purchaseChannel === 'ONLINE') {
      if (!customVendorName.trim()) return modalService.warning('กรุณาระบุชื่อร้านค้าออนไลน์');
      finalVendorName = customVendorName.trim();
      finalVendorId = 'ONLINE';
    } else {
      if (!selectedVendorId) return modalService.warning('กรุณาเลือกผู้ขาย');
      finalVendorId = selectedVendorId;
      finalVendorName = vendors.find(v => v.id === selectedVendorId)?.name;
    }

    setIsAssigning(true);
    try {
      await apiService.assignVendorToPO(selectedPO.id, finalVendorId, finalVendorName, currentRole);
      selectedPO.vendor = finalVendorName;
      selectedPO.vendorName = finalVendorName;
      selectedPO.shopName = finalVendorName;
      selectedPO.vendorId = finalVendorId;
      if (context?.updatePO) {
        context.updatePO(selectedPO.id, {
          vendor: finalVendorName,
          vendorName: finalVendorName,
          shopName: finalVendorName,
          vendorId: finalVendorId
        });
      }
      await modalService.success('ระบุผู้ขายสำเร็จ', `กำหนดผู้จัดจำหน่ายสำหรับ PO ${selectedPO.poNo} เรียบร้อย`);
      onRefresh();
      onClose();
    } catch (err) {
      console.error('[Workflow Error Stack]:', err.stack || err);
      modalService.error('เกิดข้อผิดพลาด', err.message);
    } finally {
      setIsAssigning(false);
    }
  };

  const handleCancelPO = async () => {
    const reason = await modalService.prompt({
      title: 'ยกเลิกใบสั่งซื้อ (PO)',
      message: `กรุณาระบุเหตุผลในการยกเลิกใบสั่งซื้อเลขที่ ${selectedPO.poNo}:`,
      placeholder: 'ระบุเหตุผลในการยกเลิก...',
      required: true,
      confirmText: 'ยืนยันยกเลิก PO',
      cancelText: 'ปิด',
      type: 'danger'
    });
    if (!reason || !reason.trim()) return;

    setIsCancelling(true);
    try {
      await apiService.cancelPO(selectedPO.id, currentRole, reason.trim());
      await modalService.success('ยกเลิกสำเร็จ', `ยกเลิกใบสั่งซื้อ ${selectedPO.poNo} เรียบร้อยแล้ว`);
      if (onRefresh) onRefresh();
      onClose();
    } catch (err) {
      console.error('[Workflow Error Stack]:', err.stack || err);
      modalService.error('เกิดข้อผิดพลาดในการยกเลิก', err.message);
    } finally {
      setIsCancelling(false);
    }
  };

  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const handlePrint = async () => {
    if (isGeneratingPdf) return;
    setIsGeneratingPdf(true);
    try {
      await generatePoPdf(selectedPO);
    } catch (err) {
      console.error('Failed to generate PO PDF:', err);
      modalService.error('สร้าง PDF ไม่สำเร็จ', err?.message || 'เกิดข้อผิดพลาดในการดาวน์โหลดเอกสาร PDF');
    } finally {
      setIsGeneratingPdf(false);
    }
  };
  const [isCancelling, setIsCancelling] = useState(false);

  const isOnlinePurchaser = currentRole?.roleId === 'ONLINE_PURCHASER' || currentRole?.id === 'ONLINE_PURCHASER';
  const isPOCancellable = !['CLOSED', 'RECEIVED', 'CANCELLED'].includes(selectedPO.status);
  const canCancelPO = !isOnlinePurchaser && (
    currentRole?.id === 'ADMIN' ||
    currentRole?.roleId === 'ADMIN' ||
    (currentRole?.level && currentRole?.level >= 2) ||
    currentRole?.canFinalApprove ||
    currentRole?.canReview ||
    (currentRole?.canReceiveGoods && (currentRole?.canViewAllDepts || currentRole?.department === selectedPO.department))
  );

  // Requester / Supervisor can receive goods (level 1, same dept, or admin)
  const canReceiveGoods = !isOnlinePurchaser && (
    currentRole?.id === 'ADMIN' ||
    currentRole?.roleId === 'ADMIN' ||
    (Number(currentRole?.level) === 1 && (currentRole?.department === 'ALL' || currentRole?.department === selectedPO.department))
  );
  const TERMINAL_PO_STATUSES = ['CLOSED', 'CANCELLED', 'RECEIVED', 'COMPLETED', 'COMPLETED_WITH_REFUND'];
  const hasRemainingItems = (selectedPO?.items || []).some(item => {
    const qty = Number(item.orderedQty ?? item.quantity ?? item.purchaseQty ?? item.qty ?? 0);
    const rcv = Number(item.receivedQty ?? item.goodQty ?? item.accumulatedReceived ?? 0);
    const rem = item.remainingQty !== undefined ? Number(item.remainingQty) : Math.max(0, qty - rcv);
    return rem > 0;
  });
  const isReceivable = !TERMINAL_PO_STATUSES.includes(selectedPO.status) && 
    ['ISSUED', 'ORDERED', 'ORDERED_PENDING_DELIVERY', 'IN_DELIVERY', 'SHIPPED', 'PARTIAL', 'PARTIAL_RECEIVED', 'WAITING_DELIVERY_ROUND_2'].includes(selectedPO.status) &&
    hasRemainingItems;

  // ─── Online PO Settlement Permission Guard ───
  const canSettlePO = !isPlantManager && 
    (isPurchaser || role === 'admin' || currentRole?.id === 'ADMIN' || currentRole?.canOnlinePurchase);
  const hasSettlement = Boolean(
    selectedPO.settlementStatus === 'SETTLED' || 
    (selectedPO.actualTotalAmount !== undefined && selectedPO.actualTotalAmount !== null && selectedPO.actualTotalAmount !== '')
  );

  // ─── Claim Permission Guard ───
  // Whether the current user can file a claim (report problem) on this PO
  const isClaimStatus = ['CLAIM_REPORTED', 'CLAIM_IN_PROGRESS'].includes(selectedPO.status);
  const canFileClaim = !isOnlinePurchaser &&
    !['CLOSED', 'CANCELLED'].includes(selectedPO.status) &&
    !isClaimStatus &&
    (currentRole?.canReceiveGoods || currentRole?.id === 'ADMIN' || currentRole?.roleId === 'ADMIN' ||
     currentRole?.department === selectedPO.department || currentRole?.canViewAllDepts);

  // Lifecycle State Guard: ตรวจสอบว่าผ่านขั้นตอนสั่งซื้อไปแล้วหรือยัง (ต้องเริ่มจัดส่งหรือตรวจรับแล้วเท่านั้น)
  const po = selectedPO;
  const eligibleClaimStatuses = ['in_delivery', 'delivery', 'delivered', 'received', 'partial', 'partially_received', 'completed'];
  const isDeliveredOrBeyond = eligibleClaimStatuses.some(st => String(po?.status).toLowerCase().includes(st));

  // อนุญาตเฉพาะ Operational Role และสถานะต้องถึงขั้นส่งของ/รับของแล้วเท่านั้น
  const canReportClaim = isOperational && isDeliveredOrBeyond && canFileClaim;

  // Whether the current user can resolve a Self-buy Claim on this PO
  const canResolveSelfClaim = isClaimStatus &&
    selectedPO.purchaseChannel === 'SELF' &&
    (
      currentRole?.id === 'ADMIN' ||
      currentRole?.roleId === 'ADMIN' ||
      currentRole?.id === selectedPO.requesterId ||
      currentRole?.roleId === selectedPO.requesterId ||
      (currentRole?.canReceiveGoods && currentRole?.department === selectedPO.department) ||
      (currentRole?.canReview && (currentRole?.department === selectedPO.department || currentRole?.canViewAllDepts))
    );

  const _handleResolveSelfClaim = async () => {
    if (selfClaimResolutionType === 'RESEND' && !selfClaimExpectedDate) {
      return modalService.warning('กรุณาระบุวันที่คาดว่าจะได้รับสินค้าใหม่');
    }
    // CLOSE_WITH_REFUND: validate refundAmount
    if (selfClaimResolutionType === 'CLOSE_WITH_REFUND') {
      const amt = Number(selfClaimRefundAmount);
      if (!selfClaimRefundAmount || isNaN(amt) || amt <= 0) {
        return modalService.warning('กรุณาระบุยอดเงินที่ได้รับคืน', 'ยอดเงินต้องมากกว่า 0 บาท');
      }
      const maxRefund = Number(selectedPO.grandTotal) || 0;
      if (maxRefund > 0 && amt > maxRefund) {
        return modalService.warning(
          'ยอดเงินคืนเกินยอดรวม PO',
          `ยอดเงินที่กรอก (฿${amt.toLocaleString()}) สูงกว่ายอดรวมใบสั่งซื้อ (฿${maxRefund.toLocaleString()}) กรุณาตรวจสอบอีกครั้ง`
        );
      }
    }
    if (!selfClaimNote.trim()) {
      return modalService.warning('กรุณาระบุหมายเหตุ/วิธีการดำเนินการ');
    }
    const refundDisplay = selfClaimResolutionType === 'CLOSE_WITH_REFUND'
      ? `\n\n💰 ยอดเงินคืน: ฿${Number(selfClaimRefundAmount).toLocaleString()} (จะถูกคืนงบประมาณให้ฝ่าย ${selectedPO.department} อัตโนมัติ)`
      : '';
    const confirmed = await modalService.confirm({
      title: 'ยืนยันผลการดำเนินการเคลม',
      message: `ยืนยันบันทึกผลการแก้ไขปัญหาสินค้า สำหรับ PO ${selectedPO.poNo} ใช่หรือไม่?${refundDisplay}`,
      confirmText: 'ยืนยันบันทึก',
      cancelText: 'ยกเลิก'
    });
    if (!confirmed) return;
    setIsResolvingSelfClaim(true);
    try {
      await apiService.resolveClaim(selectedPO.id, {
        type: selfClaimResolutionType,
        note: selfClaimNote.trim(),
        expectedDate: selfClaimExpectedDate,
        refundAmount: selfClaimResolutionType === 'CLOSE_WITH_REFUND'
          ? Math.round(Number(selfClaimRefundAmount) * 100) / 100
          : 0
      }, currentRole);
      await modalService.success('ดำเนินการเรียบร้อย', 'บันทึกการแก้ไขปัญหาสินค้าสำเร็จ');
      if (onRefresh) onRefresh();
      onClose();
    } catch (err) {
      modalService.error('เกิดข้อผิดพลาด', err.message);
    } finally {
      setIsResolvingSelfClaim(false);
    }
  };

  const rawStatus = String(selectedPO.workflowStatus || selectedPO.status || '').trim().toUpperCase();
  const isCompletedOrClosed = (
    rawStatus === 'COMPLETED' || 
    rawStatus === 'CLOSED' || 
    Boolean(selectedPO.isCompleted) || 
    Boolean(selectedPO.isClosed)
  );

  const statusInfo = PO_STATUS[selectedPO.status] || 
    (isCompletedOrClosed ? PO_STATUS.CLOSED : null) || 
    { label: selectedPO.status, color: 'bg-slate-100 text-slate-700 border-slate-200' };

  // ─── PO Lifecycle Steps ───
  const lifecycleSteps = [
    { key: 'ISSUED',                    label: 'ออก PO' },
    { key: 'ORDERED_PENDING_DELIVERY',  label: 'สั่งซื้อแล้ว' },
    { key: 'IN_DELIVERY',               label: 'กำลังส่ง' },
    { key: 'PARTIAL',                   label: 'รับบางส่วน' },
    { key: 'RECEIVED',                  label: 'รับครบ' },
    { key: 'CLOSED',                    label: 'ปิด PO' },
  ];

  const resolveCurrentStepIndex = (po) => {
    if (!po) return 0;
    const s = String(po.status || '').trim().toLowerCase();
    const ws = String(po.workflowStatus || '').trim().toLowerCase();
    
    // Step 5: "ปิด PO" (COMPLETED / CLOSED)
    if (
      s === 'completed' || s === 'closed' ||
      ws === 'completed' || ws === 'closed' ||
      Boolean(po.isCompleted) || Boolean(po.isClosed)
    ) {
      return 5;
    }

    if (s === 'cancelled' || ws === 'cancelled') return -1;

    // Step 4: "รับครบ" (RECEIVED)
    if (
      s === 'received' || ws === 'received' ||
      s === 'goods_received' || s === 'inspected' ||
      Boolean(po.isAllReceived)
    ) {
      return 4;
    }

    // Step 3: "รับบางส่วน" (PARTIAL)
    if (
      s === 'partial' || ws === 'partial' ||
      s === 'partially_received' || ws === 'partially_received' ||
      s.includes('partial') || ws.includes('partial')
    ) {
      return 3;
    }

    // Step 2: "กำลังส่ง" (SHIPPED / IN_DELIVERY / IN_TRANSIT)
    if (
      s === 'in_delivery' || ws === 'in_delivery' ||
      s === 'in_transit' || ws === 'in_transit' ||
      s === 'shipped' || ws === 'shipped' ||
      s.includes('transit') || (s.includes('delivery') && !s.includes('pending_delivery'))
    ) {
      return 2;
    }

    // Step 1: "สั่งซื้อแล้ว" (ORDERED / WAITING_DELIVERY_ROUND_2)
    // กฎสำคัญ: WAITING_DELIVERY_ROUND_2 ต้องอยู่ที่ step 1 เสมอ
    // เพราะของยังไม่มาถึงมือผู้รับ — Online Purchaser กำลังรอร้านค้าส่งของรอบ 2
    if (
      s === 'ordered' || ws === 'ordered' ||
      s === 'ordered_pending_delivery' || ws === 'ordered_pending_delivery' ||
      s === 'waiting_delivery' || ws === 'waiting_delivery' ||
      s === 'waiting_delivery_round_2' || ws === 'waiting_delivery_round_2' ||
      s.startsWith('ordered') || ws.startsWith('ordered')
    ) {
      return 1;
    }

    // Step 0: "ออก PO" (ISSUED)
    return 0;
  };

  const specialStatuses = ['CANCELLED', 'CLAIM_REPORTED', 'CLAIM_IN_PROGRESS'];
  const isSpecial = !isCompletedOrClosed && specialStatuses.includes(rawStatus);
  const currentStepIndex = isSpecial ? -1 : resolveCurrentStepIndex(selectedPO);

  // Seamless Modal Swapping: Eliminate Stacking Modals Anti-pattern
  // When user clicks "ตรวจรับพัสดุ", swap view completely to ReceivingModal without double backdrops
  if (showReceivingModal) {
    return (
      <ReceivingModal
        po={selectedPO}
        isOpen={true}
        onBack={() => setShowReceivingModal(false)}
        onBackToPO={() => setShowReceivingModal(false)}
        onClose={() => setShowReceivingModal(false)}
        onSuccess={(result) => {
          setShowReceivingModal(false);
          if (result?.po && context?.updatePO) {
            context.updatePO(result.po.id, result.po);
          }
          if (onRefresh) onRefresh(result?.po);
          onClose();
        }}
        currentRole={currentUser || currentRole}
      />
    );
  }

  const itemsSubtotal = (selectedPO.items || []).reduce((sum, item) => {
    const p = parseFloat(item.price ?? item.actualPrice ?? item.unitPrice ?? item.estimatedPrice) || 0;
    const q = parseFloat(item.qty ?? item.actualQty ?? item.purchaseQty) || 1;
    return sum + (p * q);
  }, 0);

  const subtotalAmount = (selectedPO.financials?.subtotal !== undefined && Number(selectedPO.financials.subtotal) > 0)
    ? Number(selectedPO.financials.subtotal)
    : ((selectedPO.subtotal !== undefined && Number(selectedPO.subtotal) > 0) ? Number(selectedPO.subtotal) : itemsSubtotal);

  const hasVat = selectedPO.hasVat !== undefined
    ? Boolean(selectedPO.hasVat)
    : (selectedPO.financials?.hasVat !== undefined
        ? Boolean(selectedPO.financials.hasVat)
        : (selectedPO.financials?.vatMode ? selectedPO.financials.vatMode !== 'NONE' : Number(selectedPO.vat) > 0));

  const vatAmount = hasVat
    ? (selectedPO.financials?.vatAmount !== undefined
        ? Number(selectedPO.financials.vatAmount)
        : (selectedPO.vat !== undefined && Number(selectedPO.vat) > 0 ? Number(selectedPO.vat) : parseFloat((subtotalAmount * 0.07).toFixed(2))))
    : 0;

  const grandTotalAmount = (selectedPO.financials?.grandTotal !== undefined && Number(selectedPO.financials.grandTotal) > 0)
    ? Number(selectedPO.financials.grandTotal)
    : (selectedPO.grandTotal !== undefined && Number(selectedPO.grandTotal) > 0
        ? Number(selectedPO.grandTotal)
        : parseFloat((subtotalAmount + vatAmount).toFixed(2)));

  const modalContent = (
    <>
      <div className="hidden print:block font-sarabun">
        <PrintablePO po={selectedPO} />
      </div>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/50 backdrop-blur-xs animate-fade-in print:hidden">
        {activeView === 'CLAIM' ? (
          /* ══════════════════════════════════════════════════════════════
             DEDICATED CLAIM VIEW (View-Swapping Mode / No Duplicate CTA)
             ══════════════════════════════════════════════════════════════ */
          <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-3xl bg-white shadow-2xl border border-slate-200/80 overflow-hidden text-slate-800 animate-zoom-in">
            {/* Header */}
            <div className="shrink-0 px-6 py-4 border-b border-slate-100 bg-white flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setActiveView('DETAIL')}
                  className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-50 transition-colors cursor-pointer shadow-2xs"
                  title="กลับไปที่หน้าต่างรายละเอียด PO"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>← กลับไปหน้า PO</span>
                </button>
                <div>
                  <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                    <span className="p-1 bg-rose-100 text-rose-600 rounded-lg">
                      <AlertTriangle className="w-4 h-4" />
                    </span>
                    <span>แจ้งปัญหา / รายงานเคลมสินค้า</span>
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    PO: <strong className="font-mono text-slate-800">{selectedPO.poNo || selectedPO.id}</strong> • {displayVendor || getVendorDisplayName(selectedPO.vendorName) || '-'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="w-8 h-8 rounded-xl hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-all cursor-pointer"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <div className="p-6 space-y-4 overflow-y-auto max-h-[70vh] bg-slate-50/40" style={{ scrollbarWidth: 'thin' }}>
              {/* PO Items Summary Card */}
              <div className="bg-white rounded-xl border border-slate-200 p-3.5 text-xs space-y-2 shadow-2xs">
                <span className="font-bold text-slate-700 flex items-center gap-1.5">
                  <Package className="w-3.5 h-3.5 text-slate-400" />
                  รายการสินค้าในเอกสาร ({selectedPO.items?.length || 0} รายการ)
                </span>
                <div className="divide-y divide-slate-100">
                  {selectedPO.items?.map((item, idx) => {
                    const ordered = Number(item.qty || item.actualQty || item.purchaseQty || item.orderedQty || 0);
                    const received = Number(item.receivedQty || item.goodQty || item.accumulatedReceived || 0);
                    const damaged = Number(item.damagedQty || 0);
                    const remainingQty = Math.max(0, ordered - received);
                    const claimableQty = remainingQty + damaged;
                    
                    if (claimableQty <= 0) return null;
                    
                    return (
                    <div key={idx} className="flex justify-between items-center text-slate-600 py-1">
                      <span className="truncate max-w-sm"><strong className="font-mono text-slate-800">[{item.code || '-'}]</strong> {item.name}</span>
                      <span className="font-mono shrink-0 ml-2 font-semibold text-slate-700">
                        {claimableQty} {item.unit || item.purchaseUnit || 'ชิ้น'} <span className="text-[10px] text-slate-400 font-sans">(ค้างรับ/ชำรุด)</span>
                      </span>
                    </div>
                  )})}
                </div>
              </div>

              {/* Claim Form Fields */}
              <div className="bg-white rounded-xl border border-rose-200 p-4 space-y-3.5 shadow-2xs">
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">
                    หัวข้อปัญหา <span className="text-rose-500">*</span>
                  </label>
                  <select
                    value={claimReason}
                    onChange={e => setClaimReason(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-xs font-medium outline-none cursor-pointer focus:bg-white focus:ring-2 focus:ring-rose-400/20 focus:border-rose-500"
                  >
                    <option value="สินค้าชำรุด/เสียหาย">💥 สินค้าชำรุด / เสียหาย</option>
                    <option value="สินค้าไม่ตรงสเปก/ผิดรุ่น">⚠️ สินค้าไม่ตรงสเปก / ผิดรุ่น</option>
                    <option value="ได้รับสินค้าไม่ครบ">📦 ได้รับสินค้าไม่ครบ</option>
                    <option value="อื่นๆ (ระบุในรายละเอียด)">📝 อื่นๆ (ระบุในรายละเอียด)</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">
                    รายละเอียดปัญหา <span className="text-rose-500">*</span>
                  </label>
                  <textarea
                    value={claimDescription}
                    onChange={e => setClaimDescription(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-xs outline-none h-28 resize-none font-medium focus:bg-white focus:ring-2 focus:ring-rose-400/20 focus:border-rose-500"
                    placeholder="อธิบายปัญหาที่พบอย่างละเอียด เช่น สินค้าบุบ แตก หัก ไม่ตรงสเปก หรือได้รับจำนวนไม่ครบตาม PO..."
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1.5">
                    รูปภาพหลักฐาน (ถ้ามี)
                  </label>
                  <input
                    type="file"
                    accept="image/*"
                    ref={claimFileInputRef}
                    onChange={async (e) => {
                      if (e.target.files?.[0]) {
                        const c = await compressImageFile(e.target.files[0]);
                        setClaimPhoto(c);
                      }
                    }}
                    className="hidden"
                  />
                  <div className="flex gap-3 items-center">
                    <button
                      type="button"
                      onClick={() => claimFileInputRef.current?.click()}
                      className="px-3.5 py-2 bg-white text-rose-700 border border-rose-300 hover:bg-rose-50 rounded-xl text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-all shadow-2xs"
                    >
                      <Camera className="w-3.5 h-3.5" />
                      <span>{claimPhoto ? 'เปลี่ยนรูปภาพ' : '+ อัปโหลดรูปภาพหลักฐาน'}</span>
                    </button>
                    {claimPhoto && (
                      <div className="relative group rounded-xl overflow-hidden border border-rose-300 w-14 h-14 shadow-2xs">
                        <img src={claimPhoto.previewUrl} alt="Claim photo" className="w-full h-full object-cover" />
                        <button
                          type="button"
                          onClick={() => setClaimPhoto(null)}
                          className="absolute inset-0 bg-black/50 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                          title="ลบรูปภาพ"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Footer (Single Unified Action Row) */}
            <div className="shrink-0 bg-white border-t border-slate-100 px-6 py-4 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setActiveView('DETAIL')}
                className="px-4 py-2 bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 rounded-xl text-xs font-semibold transition-all cursor-pointer shadow-2xs"
              >
                ← ยกเลิกและย้อนกลับ
              </button>

              <button
                type="button"
                disabled={isSubmittingClaim || !claimDescription.trim()}
                onClick={async () => {
                  setIsSubmittingClaim(true);
                  try {
                    await apiService.fileOnlineClaim(selectedPO.id, { reason: claimReason, description: claimDescription, photo: claimPhoto }, currentRole);
                    await modalService.success('ส่งเรื่องเคลมสำเร็จ', 'ระบบได้แจ้งเตือนไปยังผู้รับผิดชอบแล้ว');
                    if (onRefresh) onRefresh();
                    onClose();
                  } catch (err) {
                    modalService.error('เกิดข้อผิดพลาด', err.message);
                  } finally {
                    setIsSubmittingClaim(false);
                  }
                }}
                className="px-5 py-2.5 bg-rose-600 hover:bg-rose-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold rounded-xl flex items-center gap-2 cursor-pointer transition-all shadow-sm"
              >
                <AlertOctagon className="w-4 h-4" />
                <span>
                  {isSubmittingClaim 
                    ? 'กำลังส่งข้อมูล...' 
                    : (selectedPO.procurementType === 'INTERNAL' || selectedPO.channel === 'DIRECT' || selectedPO.purchaseChannel === 'SELF')
                      ? '⚠️ บันทึกเรื่องเคลม / ติดต่อร้านค้าเอง'
                      : '⚠️ ยืนยันส่งเรื่องแจ้งเคลมไปยังจัดซื้อ'}
                </span>
              </button>
            </div>
          </div>
        ) : (
          /* ══════════════════════════════════════════════════════════════
             STANDARD PO DETAIL VIEW
             ══════════════════════════════════════════════════════════════ */
          <div className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-3xl bg-white shadow-2xl border border-slate-200/80 overflow-hidden text-slate-800 animate-zoom-in">
            {/* ── ZONE 1: Modern High-End Header & Slim Stepper ── */}
            <div className="shrink-0 px-6 py-4 border-b border-slate-100 bg-white sticky top-0 z-20">
              {/* Top Action Bar */}
              <div className="flex items-start sm:items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h2 className="text-xl font-black font-mono tracking-tight text-slate-900">
                      {selectedPO.poNo || selectedPO.id}
                    </h2>
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                      selectedPO.status === 'CLOSED'
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200 shadow-2xs'
                        : `${statusInfo.color} shadow-2xs`
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        selectedPO.status === 'CLOSED' ? 'bg-emerald-500' : 'bg-current opacity-80'
                      } animate-pulse`}></span>
                      {statusInfo.label}
                    </span>
                  </div>
                  <p className="mt-1 text-xs font-medium text-slate-500 flex items-center gap-2 flex-wrap">
                    <span>อ้างอิง {selectedPO.prNo || '-'}</span>
                    <span className="text-slate-300">•</span>
                    <span>ฝ่าย {selectedPO.department}</span>
                    <span className="text-slate-300">•</span>
                    {selectedPO.purchaseChannel === 'ONLINE' ? (
                      <span className="text-purple-600 font-semibold">จัดซื้อออนไลน์</span>
                    ) : (
                      <span className="text-slate-600 font-semibold">จัดซื้อทั่วไป</span>
                    )}
                    {selectedPO.issueDate && (
                      <>
                        <span className="text-slate-300">•</span>
                        <span className="font-mono text-slate-400">{selectedPO.issueDate}</span>
                      </>
                    )}
                  </p>
                </div>

                {/* Top Controls */}
                <div className="flex items-center gap-2 shrink-0">
                  <button 
                    type="button"
                    onClick={handlePrint} 
                    disabled={isGeneratingPdf}
                    className="h-8 px-3 rounded-xl border border-slate-200 hover:bg-slate-50 disabled:opacity-60 disabled:cursor-not-allowed text-xs font-semibold text-slate-700 transition-all shadow-2xs flex items-center gap-1.5 cursor-pointer"
                    title="พิมพ์ PO / ดาวน์โหลด PDF"
                  >
                    {isGeneratingPdf ? (
                      <>
                        <span className="w-3.5 h-3.5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></span>
                        <span className="hidden sm:inline text-indigo-600">กำลังสร้าง PDF...</span>
                      </>
                    ) : (
                      <>
                        <Printer className="w-3.5 h-3.5 text-slate-600" />
                        <span className="hidden sm:inline">พิมพ์ PO</span>
                      </>
                    )}
                  </button>
                  <button 
                    type="button"
                    onClick={onClose} 
                    className="w-8 h-8 rounded-xl hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-all cursor-pointer"
                    aria-label="Close modal"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Slim Modern Stepper (Compact Indicator Bar < h-8) */}
              {!isSpecial && (
                <div className="h-8 bg-slate-50 border border-slate-200/80 rounded-xl px-3 mt-3 flex items-center overflow-x-auto scrollbar-none shadow-2xs">
                  <div className="flex items-center justify-between w-full gap-1 min-w-[480px] sm:min-w-0">
                    {lifecycleSteps.map((step, i) => {
                      const isCompletedOrder = currentStepIndex === 5;
                      const isStepDone = isCompletedOrder ? (i <= 5) : (currentStepIndex >= 0 && i < currentStepIndex);
                      const isStepCurrent = !isCompletedOrder && (i === currentStepIndex);
                      const isConnectorActive = currentStepIndex >= 0 && i < currentStepIndex;
                      const isLast = i === lifecycleSteps.length - 1;

                      return (
                        <React.Fragment key={step.key}>
                          <div className="flex items-center gap-1.5 min-w-0 shrink-0">
                            {isStepDone ? (
                              <span className="w-3.5 h-3.5 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0 shadow-2xs">
                                <Check className="w-2 h-2 stroke-[3]" />
                              </span>
                            ) : isStepCurrent ? (
                              <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-indigo-600"></span>
                              </span>
                            ) : (
                              <span className="w-2 h-2 rounded-full bg-slate-300 shrink-0"></span>
                            )}
                            <span className={`text-[11px] truncate ${
                              isStepCurrent 
                                ? 'text-indigo-700 font-bold' 
                                : isStepDone 
                                  ? (isCompletedOrder ? 'text-emerald-700 font-bold' : 'text-slate-800 font-semibold')
                                  : 'text-slate-400 font-medium'
                            }`}>
                              {step.label}
                            </span>
                          </div>
                          {!isLast && (
                            <div className={`flex-1 h-0.5 mx-1.5 rounded-full transition-colors ${
                              isConnectorActive ? 'bg-emerald-500' : 'bg-slate-200'
                            }`} />
                          )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Special Status Banner */}
              {isSpecial && (
                <div className={`mt-3 px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 ${
                  selectedPO.status === 'CANCELLED'
                    ? 'bg-slate-100 text-slate-600 border border-slate-200'
                    : 'bg-rose-50 text-rose-800 border border-rose-200'
                }`}>
                  <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500" />
                  <span>
                    {selectedPO.status === 'CANCELLED' ? 'ใบสั่งซื้อนี้ถูกยกเลิกแล้ว' :
                     selectedPO.status === 'CLAIM_REPORTED' ? '🚨 มีการแจ้งปัญหาสินค้า — รอดำเนินการแก้ไข' :
                     '🔧 อยู่ระหว่างดำเนินการแก้ไขปัญหาสินค้า'}
                  </span>
                </div>
              )}
            </div>

            {/* ════ ZONE 2 — SCROLLABLE BODY ════ */}
            <div className="flex-1 overflow-y-auto bg-slate-50/40" style={{ scrollbarWidth: 'thin' }}>
              <div className="p-4 sm:p-5 space-y-4">

                {/* Vendor + Delivery 2-col grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-2.5 shadow-2xs">
                    <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 uppercase tracking-widest">
                      <Store className="w-3.5 h-3.5 text-indigo-500" />
                      ผู้ขาย / Vendor
                    </div>
                    {hasAssignedVendor ? (
                      <div>
                        <div className="font-semibold text-slate-800 flex items-center gap-2">
                          <span>🏪</span>
                          <span>{displayVendor || getVendorDisplayName(selectedPO.vendorName) || selectedPO.vendorId}</span>
                        </div>
                        <p className="text-[11px] text-slate-400 font-mono mt-0.5">
                          {selectedPO.purchaseChannel === 'ONLINE' ? 'สั่งซื้อออนไลน์' : (selectedPO.vendorId || 'ผู้ขาย')}
                        </p>
                      </div>
                    ) : (isPurchaser || role === 'admin') ? (
                      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
                        <p className="text-xs font-semibold text-amber-800 flex items-center gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />รอระบุผู้ขาย
                        </p>
                        <div className="flex gap-2">
                          {selectedPO.purchaseChannel === 'ONLINE' ? (
                            <input type="text" value={customVendorName} onChange={e => setCustomVendorName(e.target.value)}
                              placeholder="ชื่อร้านค้าออนไลน์ (Shopee / Lazada...)"
                              className="flex-1 text-xs bg-white border border-amber-300 rounded-lg px-2.5 py-1.5 focus:ring-2 focus:ring-amber-400/30 outline-none" />
                          ) : (
                            <select value={selectedVendorId} onChange={e => setSelectedVendorId(e.target.value)}
                              className="flex-1 text-xs bg-white border border-amber-300 rounded-lg px-2.5 py-1.5 focus:ring-2 focus:ring-amber-400/30 outline-none">
                              <option value="">-- เลือกผู้ขาย --</option>
                              {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                            </select>
                          )}
                          <button onClick={handleAssignVendor}
                            disabled={isAssigning || (selectedPO.purchaseChannel === 'ONLINE' ? !customVendorName.trim() : !selectedVendorId)}
                            className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white text-xs font-bold px-3 py-1.5 rounded-lg transition-all cursor-pointer">
                            {isAssigning ? 'บันทึก...' : 'บันทึก'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 px-3 py-2 rounded-lg font-medium">รอฝ่ายจัดซื้อระบุร้านค้า</p>
                    )}
                  </div>

                  <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-2.5 shadow-2xs">
                    <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 uppercase tracking-widest">
                      <Truck className="w-3.5 h-3.5 text-indigo-500" />
                      การจัดส่ง & อ้างอิง
                    </div>
                    <div className="space-y-1.5 text-xs">
                      <div className="flex justify-between text-slate-500">
                        <span>วันที่ออก PO</span>
                        <span className="font-mono font-semibold text-slate-800">{selectedPO.issueDate}</span>
                      </div>
                      <div className="flex justify-between text-slate-500">
                        <span>ช่องทางการซื้อ</span>
                        <span className="font-semibold text-slate-800">{selectedPO.purchaseChannel === 'ONLINE' ? 'ออนไลน์' : 'จัดซื้อตรง'}</span>
                      </div>
                      {selectedPO.specUrl && (
                        <button type="button"
                          onClick={() => setViewingAttachment({ url: selectedPO.specUrl, title: 'เอกสารอ้างอิง / ลิงก์สินค้า' })}
                          className="w-full flex items-center gap-2 bg-indigo-50 hover:bg-indigo-100/70 border border-indigo-100 p-2 rounded-lg transition-colors cursor-pointer text-left mt-1">
                          <ExternalLink className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-indigo-800">ดูเอกสารอ้างอิง PR</p>
                            <p className="text-[10px] text-indigo-400 truncate">{selectedPO.specUrl}</p>
                          </div>
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Active Claim Banner */}
                {isClaimStatus && selectedPO.claimData && (
                  <div className="bg-rose-50 border border-rose-200 rounded-xl p-3.5 space-y-2 shadow-2xs">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2.5">
                        <div className="p-1.5 bg-rose-100 rounded-lg shrink-0 mt-0.5">
                          <AlertTriangle className="w-4 h-4 text-rose-600" />
                        </div>
                        <div>
                          <p className="text-xs font-bold text-rose-900">
                            🚨 พบสินค้ามีปัญหา: {selectedPO.claimData.reason}
                            {selectedPO.claimRound > 0 && (
                              <span className="ml-2 text-[10px] font-bold bg-rose-200 text-rose-800 px-2 py-0.5 rounded-full font-mono">รอบที่ {selectedPO.claimRound}</span>
                            )}
                          </p>
                          <p className="text-xs text-rose-700 mt-0.5">{selectedPO.claimData.description}</p>
                        </div>
                      </div>
                      <div className="text-right text-[10px] text-rose-400 shrink-0">
                        <span>{selectedPO.claimData.reportedBy || '-'}</span>
                        <span className="block font-mono mt-0.5">{selectedPO.claimData.reportedAt || '-'}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Self-buy Claim Resolution Panel */}
                {isClaimStatus && selectedPO.purchaseChannel === 'SELF' && showSelfClaimResolution && (
                  <div className="bg-white border-2 border-rose-200 rounded-xl p-4 space-y-4 shadow-2xs">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                      <div className="flex items-center gap-2">
                        <div className="p-1.5 bg-rose-100 rounded-lg"><ShieldAlert className="w-4 h-4 text-rose-600" /></div>
                        <div>
                          <h3 className="text-sm font-bold text-slate-900">🔧 จัดการเคสสินค้ามีปัญหา</h3>
                          <p className="text-[11px] text-slate-400 mt-0.5">เลือกแนวทางแก้ไขและระบุรายละเอียด</p>
                        </div>
                      </div>
                      <button type="button" onClick={() => setShowSelfClaimResolution(false)}
                        className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 cursor-pointer">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    {canResolveSelfClaim ? (
                      <div className="space-y-3">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          {[
                            { value: 'RESEND', icon: '🔄', label: 'จัดซื้อใหม่ / ส่งทดแทน', desc: 'รอสินค้าชิ้นใหม่ → PO กลับสู่สถานะ "รอตรวจรับ"' },
                            { value: 'CLOSE_WITH_REFUND', icon: '💰', label: 'ได้รับเงินคืน / ปิดงาน', desc: 'ร้านค้าโอนเงินคืน → ปิด PO (CLOSED)' },
                            { value: 'CLOSE_NO_ACTION', icon: '❌', label: 'ยอมรับสภาพ / ปิดงาน', desc: 'ไม่เคลม หรือยอมรับของ → ปิด PO (CLOSED)' },
                          ].map(opt => (
                            <label key={opt.value} className={`flex flex-col p-3 rounded-xl border-2 cursor-pointer transition-all ${
                              selfClaimResolutionType === opt.value ? 'bg-rose-50 border-rose-400' : 'bg-white border-slate-200 hover:border-slate-300'
                            }`}>
                              <div className="flex items-start gap-2">
                                <input type="radio" name="selfClaimRes" value={opt.value}
                                  checked={selfClaimResolutionType === opt.value}
                                  onChange={() => setSelfClaimResolutionType(opt.value)}
                                  className="w-3.5 h-3.5 mt-0.5 cursor-pointer text-rose-600" />
                                <div>
                                  <p className="text-xs font-bold text-slate-800">{opt.icon} {opt.label}</p>
                                  <p className="text-[10px] text-slate-400 mt-0.5 leading-snug">{opt.desc}</p>
                                </div>
                              </div>
                            </label>
                          ))}
                        </div>
                        {selfClaimResolutionType === 'RESEND' && (
                          <div>
                            <label className="text-xs font-semibold text-slate-700 block mb-1">วันที่คาดว่าจะได้รับสินค้าใหม่ <span className="text-rose-500">*</span></label>
                            <input type="date" value={selfClaimExpectedDate} onChange={e => setSelfClaimExpectedDate(e.target.value)}
                              className="w-full sm:w-56 bg-slate-50 border border-slate-300 rounded-lg px-3 py-2 text-xs font-medium focus:bg-white outline-none focus:ring-2 focus:ring-rose-400/20 focus:border-rose-400" />
                          </div>
                        )}
                        {selfClaimResolutionType === 'CLOSE_WITH_REFUND' && (
                          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 space-y-2">
                            <label className="text-xs font-semibold text-emerald-900 block">💰 ยอดเงินที่ได้รับคืน <span className="text-rose-500">*</span></label>
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-emerald-700">฿</span>
                              <input type="number" min="0.01" step="0.01" value={selfClaimRefundAmount}
                                onChange={e => setSelfClaimRefundAmount(e.target.value)}
                                placeholder={`0.00 (รวม PO: ฿${(selectedPO.grandTotal || 0).toLocaleString()})`}
                                className="w-full pl-7 pr-3 py-2 bg-white border border-emerald-300 rounded-lg text-xs font-mono font-medium outline-none focus:ring-2 focus:ring-emerald-400/20 focus:border-emerald-500" />
                            </div>
                            <p className="text-[10px] text-emerald-700 font-medium">ยอดนี้จะถูกคืนกลับเข้างบประมาณฝ่าย {selectedPO.department} อัตโนมัติ</p>
                          </div>
                        )}
                        <div>
                          <label className="text-xs font-semibold text-slate-700 block mb-1">บันทึกผลการประสานงาน <span className="text-rose-500">*</span></label>
                          <textarea value={selfClaimNote} onChange={e => setSelfClaimNote(e.target.value)}
                            className="w-full bg-slate-50 border border-slate-300 rounded-xl px-3.5 py-2.5 text-xs text-slate-800 outline-none focus:bg-white focus:ring-2 focus:ring-rose-400/20 focus:border-rose-400 h-20 resize-none"
                            placeholder="ระบุผลการติดต่อร้านค้า ข้อตกลง หรือเหตุผลที่ตัดสินใจ..." />
                        </div>
                        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
                          <button
                            type="button"
                            onClick={() => setShowSelfClaimResolution(false)}
                            className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-xl flex items-center gap-1.5 cursor-pointer transition-all border border-slate-200"
                          >
                            <span>ยกเลิก</span>
                          </button>
                          <button
                            type="button"
                            onClick={_handleResolveSelfClaim}
                            disabled={_isResolvingSelfClaim}
                            className="px-4 py-2 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white text-xs font-bold rounded-xl flex items-center gap-1.5 cursor-pointer transition-all shadow-2xs"
                          >
                            <CheckCircle2 className="w-4 h-4" />
                            <span>{_isResolvingSelfClaim ? 'กำลังบันทึก...' : '✓ ยืนยันบันทึกผลการจัดการเคส'}</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
                        <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                        <div>
                          <p className="text-xs font-bold text-amber-900">อยู่ระหว่างผู้จัดซื้อดำเนินการแก้ไข</p>
                          <p className="text-[11px] text-amber-700 mt-0.5">PO นี้อยู่ในสถานะ CLAIM — รอผู้จัดซื้อต้นทางประสานงานแก้ไขปัญหา</p>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Items Section: High-Density Item Cards (Kill the Table Desert) ── */}
                <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-2xs">
                  <div className="bg-slate-50/80 px-4 py-3 border-b border-slate-200 flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-800 flex items-center gap-2">
                      <Package className="w-4 h-4 text-indigo-500" />
                      <span>รายการสินค้าที่สั่งซื้อ</span>
                      <span className="text-[10px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200/80 px-2 py-0.5 rounded-full font-mono">
                        {selectedPO.items?.length || 0} รายการ
                      </span>
                    </span>
                  </div>

                  <div className="divide-y divide-slate-100">
                    {selectedPO.items?.map((item, idx) => {
                      const pQty = Number(item.actualQty ?? item.purchaseQty ?? item.qty ?? 0);
                      const price = Number(item.actualPrice ?? item.unitPrice ?? item.estimatedPrice ?? item.price ?? 0);
                      const lineTotal = item.total !== undefined ? Number(item.total) : (price * pQty);

                      // Resolve refund and receipt details
                      const refInfo = typeof resolveRefundedQtyAndAmount === 'function' 
                        ? resolveRefundedQtyAndAmount(item, selectedPO) 
                        : { refundedQty: Number(item.refundedQty || 0) };
                      const refundedQty = Number(item.refundedQty ?? refInfo?.refundedQty ?? 0);
                      const receivedQty = Number(item.receivedQty ?? item.goodQty ?? 0);
                      const _isOrderResolved = (receivedQty + refundedQty) >= pQty;
                      const isFullyReceived = receivedQty >= pQty;

                      // Dual-UOM Master Lookup
                      const uom = storageService?.getUomConversion ? storageService.getUomConversion(item.code || item.productId || item.id) : null;
                      const ratio = getValidConversionRate(item.conversionRatio || item.conversionRate || uom?.conversionRatio || 1);
                      const purchaseUom = item.purchaseUom || item.purchaseUnit || item.pUnit || uom?.purchaseUom || item.unit || 'ชิ้น';
                      const baseUom = item.baseUom || item.stockUnit || item.sUnit || uom?.baseUom || purchaseUom;
                      const baseStockQty = toStockQuantity(pQty, ratio);
                      const baseUnitCost = ratio > 0 ? (price / ratio) : price;

                      return (
                        <div key={idx} className="p-3.5 sm:p-4 hover:bg-slate-50/60 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                          {/* Left: SKU, Item Name, Platform & Store Link */}
                          <div className="flex-1 min-w-0 space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono text-xs font-bold bg-slate-100 text-slate-700 border border-slate-200/80 px-2 py-0.5 rounded-lg shrink-0 shadow-2xs">
                                {item.code || '-'}
                              </span>
                              <h4 className="text-sm font-bold text-slate-800 leading-snug break-words">
                                {item.name}
                              </h4>
                            </div>

                            {/* Platform Tag, Dual-UOM badge & External Link */}
                            <div className="flex items-center gap-2 flex-wrap text-xs pt-0.5">
                              {item.storePlatform && (
                                <span className={`px-2 py-0.5 rounded-md font-semibold text-[11px] ${
                                  String(item.storePlatform).toLowerCase().includes('shopee')
                                    ? 'bg-orange-50 text-orange-700 border border-orange-200'
                                    : String(item.storePlatform).toLowerCase().includes('lazada')
                                      ? 'bg-blue-50 text-blue-700 border border-blue-200'
                                      : 'bg-purple-50 text-purple-700 border border-purple-200'
                                }`}>
                                  {item.storePlatform}
                                </span>
                              )}
                              {ratio > 1 && (
                                <span className="px-2 py-0.5 rounded-md font-semibold text-[11px] bg-indigo-50 text-indigo-700 border border-indigo-200">
                                  1 {purchaseUom} = {ratio.toLocaleString()} {baseUom}
                                </span>
                              )}
                              {(item.actualStoreName || item.storeName) && (
                                <span className="text-slate-500 font-medium text-[11px] truncate">
                                  ร้าน: <strong className="text-slate-700 font-semibold">{item.actualStoreName || item.storeName}</strong>
                                </span>
                              )}
                              {(() => {
                                const rawUrl = getProductUrl(item);
                                if (!rawUrl) return null;
                                return (
                                  <a
                                    href={sanitizeExternalUrl(rawUrl)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 hover:underline transition-colors shrink-0"
                                    title="เปิดลิงก์หน้าร้านค้าภายนอก"
                                  >
                                    <span>เปิดร้านค้า</span>
                                    <ExternalLink className="w-3 h-3 text-indigo-500" />
                                  </a>
                                );
                              })()}
                            </div>
                          </div>

                          {/* Right: Grouped Numbers */}
                          <div className="flex items-center justify-between sm:justify-end gap-3 sm:gap-5 shrink-0 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-100 font-mono">
                            <div className="text-left sm:text-right text-xs space-y-1">
                              {/* Receipt & Refund Badges */}
                              {refundedQty > 0 ? (
                                <div className="flex items-center gap-1.5 flex-wrap sm:justify-end">
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-800 border border-emerald-200 text-[11px] font-semibold">
                                    รับแล้ว: {receivedQty.toLocaleString()}
                                  </span>
                                  <span className="text-slate-400 font-bold text-[11px]">+</span>
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-200 text-[11px] font-semibold">
                                    คืนเงินแล้ว: {refundedQty.toLocaleString()} {purchaseUom} (ปิดรับ)
                                  </span>
                                </div>
                              ) : (
                                <div className="text-slate-500 text-[11px]">
                                  สั่ง: <span className="font-bold text-slate-800">{pQty.toLocaleString()}</span> {purchaseUom}
                                  <span className="mx-1.5 text-slate-300">|</span>
                                  รับแล้ว: <span className={`font-bold ${isFullyReceived ? 'text-emerald-700' : 'text-slate-700'}`}>
                                    {receivedQty.toLocaleString()}
                                  </span>
                                  {isFullyReceived && <Check className="w-3 h-3 text-emerald-500 inline ml-0.5" />}
                                </div>
                              )}

                              {/* Item Specifications: Dual-UOM if applicable */}
                              {ratio > 1 ? (
                                <div className="text-[11px] text-slate-600 font-sans sm:text-right">
                                  <span className="font-semibold text-slate-800">{pQty.toLocaleString()} {purchaseUom}</span>{' '}
                                  <span className="text-indigo-600 font-mono font-medium">({baseStockQty.toLocaleString()} {baseUom})</span>{' '}
                                  <span className="text-slate-400">@</span>{' '}
                                  <span className="font-mono text-slate-700 font-semibold">฿{price.toLocaleString()} / {purchaseUom}</span>{' '}
                                  <span className="text-slate-500 font-mono text-[11px]">(฿{baseUnitCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / {baseUom})</span>
                                </div>
                              ) : (
                                <div className="text-[11px] text-slate-400">
                                  @ ฿{price.toLocaleString()} / {purchaseUom}
                                </div>
                              )}
                            </div>

                            <div className="text-right shrink-0 pl-3 sm:border-l sm:border-slate-100">
                              <span className="text-[10px] text-slate-400 block uppercase font-sans font-medium">รวม</span>
                              <span className="font-mono text-sm font-bold text-slate-900">
                                ฿{lineTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Clean Financial Summary (Replaces Harsh Black Bar) */}
                  <div className="p-4 bg-slate-50/70 border-t border-slate-200 flex justify-end">
                    <div className="w-full sm:w-80 space-y-1.5 font-mono">
                      <div className="flex justify-between items-center text-xs text-slate-500">
                        <span>รวมมูลค่าสินค้า (Subtotal):</span>
                        <span className="font-bold text-slate-700">
                          ฿{subtotalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </div>

                      <div className="flex justify-between items-center text-xs text-slate-500">
                        <span>ภาษีมูลค่าเพิ่ม 7% (VAT 7%):</span>
                        <span className="font-bold text-slate-700">
                          {hasVat && vatAmount > 0
                            ? `฿${vatAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                            : 'ไม่มี VAT (0%)'}
                        </span>
                      </div>

                      <div className="flex justify-between items-center bg-emerald-50/80 border border-emerald-200 text-emerald-800 rounded-lg px-3 py-1.5 mt-1">
                        <span className="text-xs font-bold font-sans">ยอดเงินรวมสุทธิ (Grand Total):</span>
                        <span className="text-sm font-bold font-mono text-emerald-900">
                          ฿{grandTotalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </div>

                      {/* Financial Reconciliation Breakdown (3-Way Balance) */}
                      {(() => {
                        let totalRefundVal = 0;
                        if (selectedPO.totalRefunded !== undefined && selectedPO.totalRefunded !== null) {
                          totalRefundVal = Number(selectedPO.totalRefunded);
                        } else if (selectedPO.refundAmount !== undefined && selectedPO.refundAmount !== null) {
                          totalRefundVal = Number(selectedPO.refundAmount);
                        } else if (selectedPO.storeClaims && typeof selectedPO.storeClaims === 'object') {
                          Object.values(selectedPO.storeClaims).forEach(c => {
                            if (c?.isResolved && (c.type === 'REFUND' || c.resolutionType === 'REFUND' || c.actionType === 'REFUND' || String(c.note || '').includes('คืนเงิน'))) {
                              totalRefundVal += Number(c.refundAmount || 0);
                            }
                          });
                        }
                        if (totalRefundVal === 0 && Array.isArray(selectedPO.items)) {
                          selectedPO.items.forEach(it => {
                            if (it.refundAmount) totalRefundVal += Number(it.refundAmount);
                            else if (it.claimResolution === 'REFUND') {
                              const q = Number(it.refundedQty || it.damagedQty || it.shortageQty || 0);
                              const p = Number(it.actualPrice || it.unitPrice || it.price || 0);
                              totalRefundVal += (q * p);
                            }
                          });
                        }

                        if (totalRefundVal <= 0) return null;
                        const originalBudgetVal = grandTotalAmount;
                        const actualSpentVal = Math.max(0, originalBudgetVal - totalRefundVal);

                        return (
                          <div className="bg-slate-100/90 border border-slate-200 rounded-lg p-2.5 mt-2 space-y-1 text-xs">
                            <div className="text-[11px] font-bold text-slate-700 flex items-center justify-between">
                              <span>กระทบยอดงบประมาณ (Reconciliation):</span>
                              <span className="text-emerald-700 font-bold font-mono">ประหยัดงบ PR ฿{totalRefundVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                            </div>
                            <div className="text-[11px] font-mono text-slate-600 flex items-center justify-between gap-1 flex-wrap pt-0.5 border-t border-slate-200/60">
                              <span>งบเดิม ฿{originalBudgetVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                              <span className="text-slate-400">→</span>
                              <span className="font-bold text-slate-800">จ่ายจริง ฿{actualSpentVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                              <span className="text-emerald-600 font-bold">(ประหยัดงบ PR ฿{totalRefundVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</span>
                            </div>
                          </div>
                        );
                      })()}

                      {/* Online Settlement Breakdown */}
                      {hasSettlement && (
                        <div className="bg-emerald-50/90 border border-emerald-300 rounded-lg p-2.5 mt-2 space-y-1.5 text-xs">
                          <div className="text-[11px] font-bold text-emerald-900 flex items-center justify-between">
                            <span className="flex items-center gap-1">
                              <Receipt className="w-3.5 h-3.5 text-emerald-700" />
                              สรุปการปิดยอดจ่ายจริง (Settlement):
                            </span>
                            {selectedPO.savingsAmount > 0 && (
                              <span className="text-emerald-700 font-bold font-mono">
                                ประหยัดงบ PR ฿{Number(selectedPO.savingsAmount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] font-mono text-slate-700 flex items-center justify-between gap-1 flex-wrap pt-1 border-t border-emerald-200/70">
                            <span>ยอดอนุมัติ: ฿{grandTotalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                            <span className="text-slate-400">→</span>
                            <span className="font-bold text-emerald-900">
                              จ่ายจริง: ฿{Number(selectedPO.actualTotalAmount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </div>
                          {selectedPO.settlementNote && (
                            <div className="text-[11px] text-emerald-800 pt-0.5">
                              <span className="font-semibold">หมายเหตุ:</span> {selectedPO.settlementNote}
                            </div>
                          )}
                          {selectedPO.settlementProofUrl && (
                            <div className="pt-0.5">
                              <a 
                                href={selectedPO.settlementProofUrl} 
                                target="_blank" 
                                rel="noopener noreferrer" 
                                className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 hover:text-emerald-900 underline"
                              >
                                <ExternalLink className="w-3 h-3" /> ดูหลักฐาน/สลิปโอนเงิน
                              </a>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Short Close Banner */}
                {selectedPO.closedEarly && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3.5 flex items-start gap-2.5 shadow-2xs">
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <div>
                      <h4 className="font-semibold text-xs text-amber-900">ปิด PO ก่อนรับของครบ (Short-Closed)</h4>
                      <p className="text-xs text-amber-700 mt-0.5"><strong>เหตุผล:</strong> {selectedPO.shortCloseReason || 'ไม่ระบุ'}</p>
                    </div>
                  </div>
                )}

                {/* NG Items */}
                {(() => {
                  const scopedNgItems = storageService.getDefectiveItemsForPO(selectedPO);
                  if (!scopedNgItems || scopedNgItems.length === 0) return null;
                  return (
                    <div className="po-defective-items-section bg-rose-50 border border-rose-200 rounded-xl p-4 space-y-2 shadow-2xs">
                      <div className="flex items-center gap-2 font-semibold text-xs text-rose-800">
                        <ShieldAlert className="w-4 h-4 text-rose-600" />
                        บันทึกสินค้าชำรุด (Defective Items)
                      </div>
                      <div className="divide-y divide-rose-200/50">
                        {scopedNgItems.map((ng, i) => (
                          <div key={i} className="py-2 flex flex-col sm:flex-row sm:items-center justify-between text-xs gap-1.5">
                            <div className="font-medium text-rose-900">
                              <span className="font-semibold font-mono">[{ng.code || ng.productCode || ng.productId}]</span> {ng.name}
                              <span className="text-rose-600 ml-2 font-mono">{ng.qty} {ng.unit}</span>
                            </div>
                            <div className="text-slate-700 bg-white px-2.5 py-1 rounded-lg border border-rose-200/70 text-[11px]">
                              <span className="text-rose-700 font-semibold">อาการ:</span> {ng.defectReason}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* GR & Evidence Attachments */}
                {(() => {
                  const allGrAttachments = [
                    ...(Array.isArray(selectedPO.grAttachments) ? selectedPO.grAttachments : []),
                    ...(Array.isArray(selectedPO.grnHistory)
                      ? selectedPO.grnHistory.flatMap(grn => Array.isArray(grn.attachments) ? grn.attachments : [])
                      : [])
                  ];

                  const claimPhotos = [
                    ...(Array.isArray(selectedPO.claimEvidence) ? selectedPO.claimEvidence : []),
                    ...(selectedPO.claimPhoto ? [{ previewUrl: selectedPO.claimPhoto, name: 'ภาพหลักฐานเคลมสินค้า' }] : [])
                  ];

                  const seenUrls = new Set();
                  const uniqueAttachments = allGrAttachments.filter(att => {
                    const key = att.fileId || att.previewUrl || att.url || att.dataUrl || att.fileUrl;
                    if (!key || seenUrls.has(key)) return false;
                    seenUrls.add(key);
                    return true;
                  });

                  if (uniqueAttachments.length === 0 && claimPhotos.length === 0) return null;

                  return (
                    <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 shadow-2xs">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 font-semibold text-xs text-slate-700">
                          <Camera className="w-4 h-4 text-indigo-500" />
                          <span>ภาพถ่ายและเอกสารการตรวจรับ / หลักฐานเคลม</span>
                        </div>
                        <span className="text-[11px] text-slate-400 font-mono">
                          {uniqueAttachments.length + claimPhotos.length} ไฟล์
                        </span>
                      </div>
                      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                        {uniqueAttachments.map((att, i) => (
                          <button key={`grn-att-${i}`} type="button"
                            onClick={() => setViewingAttachment({ file: att, url: att.previewUrl || att.fileUrl || att.dataUrl || att.url, title: att.name || att.fileName })}
                            className="group bg-slate-50 border border-slate-200 rounded-xl p-1.5 hover:border-indigo-300 hover:shadow-sm transition-all cursor-pointer flex flex-col items-center">
                            {att.type === 'application/pdf' ? (
                              <div className="w-full h-16 bg-rose-50 rounded-lg flex flex-col items-center justify-center text-rose-500">
                                <FileText className="w-5 h-5" /><span className="text-[9px] font-bold mt-0.5">PDF</span>
                              </div>
                            ) : (
                              <img 
                                src={resolveDriveImageUrl(att.previewUrl || att.fileUrl || att.dataUrl || att.url, 'w400')} 
                                alt={att.name || 'attachment'} 
                                className="w-full h-16 object-cover rounded-lg group-hover:scale-105 transition-transform" 
                                onError={(e) => handleDriveImageError(e, att)}
                              />
                            )}
                            <p className="text-[10px] font-medium text-slate-600 truncate w-full mt-1 text-center font-mono">{att.name || att.fileName || `เอกสาร #${i + 1}`}</p>
                          </button>
                        ))}
                        {claimPhotos.map((att, i) => (
                          <button key={`claim-att-${i}`} type="button"
                            onClick={() => setViewingAttachment({ file: att, url: att.previewUrl || att.fileUrl || att.dataUrl || att.url, title: att.name || 'หลักฐานเคลม' })}
                            className="group bg-rose-50/60 border border-rose-200 rounded-xl p-1.5 hover:border-rose-400 hover:shadow-sm transition-all cursor-pointer flex flex-col items-center">
                            <img 
                              src={resolveDriveImageUrl(att.previewUrl || att.fileUrl || att.dataUrl || att.url, 'w400')} 
                              alt={att.name || 'claim evidence'} 
                              className="w-full h-16 object-cover rounded-lg group-hover:scale-105 transition-transform" 
                              onError={(e) => handleDriveImageError(e, att)}
                            />
                            <p className="text-[10px] font-medium text-rose-700 truncate w-full mt-1 text-center font-mono">{att.name || `หลักฐาน #${i + 1}`}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* Activity Log (Collapsible & Compact) */}
                {selectedPO.activityLog && selectedPO.activityLog.length > 0 && (
                  <CollapsibleActivityTimeline
                    events={selectedPO.activityLog}
                    title="ประวัติการดำเนินงาน (Activity Timeline)"
                    defaultExpanded={selectedPO.activityLog.length < 2}
                  />
                )}

              </div>
            </div>

            {/* ════ ZONE 3 — STICKY FOOTER ACTION DOCK (Clear Action Priority) ════ */}
            <div className="shrink-0 bg-white border-t border-slate-100 z-20">
              <div className="px-4 sm:px-6 py-3.5 flex items-center justify-between flex-wrap gap-2.5">
                {/* Left: Close button (Ghost button Slate) */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={onClose}
                    className="bg-white border border-slate-200 text-slate-600 hover:bg-slate-100 px-4 py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer shadow-2xs"
                  >
                    ✕ ปิดหน้าต่าง
                  </button>
                </div>

                {/* Center / Subtle: Cancel PO */}
                {!isPlantManager && isPOCancellable && canCancelPO && (
                  <button
                    type="button"
                    onClick={handleCancelPO}
                    disabled={isCancelling}
                    className="text-xs font-medium text-slate-400 hover:text-rose-600 px-2.5 py-1.5 transition-colors cursor-pointer flex items-center gap-1 disabled:opacity-50"
                    title="ยกเลิกใบสั่งซื้อ"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    <span>{isCancelling ? 'กำลังยกเลิก...' : 'ยกเลิก PO'}</span>
                  </button>
                )}

                {/* Right: Prioritized Action Buttons */}
                <div className="flex items-center gap-2.5 ml-auto flex-wrap">
                  {/* Settlement Button */}
                  {canSettlePO && !['CANCELLED'].includes(selectedPO.status) && (
                    <button
                      type="button"
                      onClick={() => setShowSettlementModal(true)}
                      className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-xl flex items-center gap-1.5 cursor-pointer transition-all shadow-2xs"
                      title="บันทึกยอดซื้อจริง คืนงบประมาณ และคำนวณราคาทุนสต็อก"
                    >
                      <Receipt className="w-3.5 h-3.5" />
                      <span>{hasSettlement ? 'แก้ไขยอดจ่ายจริง' : 'บันทึกยอดซื้อจริง'}</span>
                    </button>
                  )}

                  {/* Purchaser Action: Mark Ordered */}
                  {!isPlantManager && (selectedPO.status === 'ISSUED' || selectedPO.status === 'IN_PROGRESS_ONLINE') &&
                    (isPurchaser || role === 'admin' || currentRole?.id === 'ADMIN' || currentRole?.canOnlinePurchase) && (
                    <button
                      onClick={async () => {
                        const targetStatus = selectedPO.purchaseChannel === 'ONLINE' ? 'ORDERED_PENDING_DELIVERY' : 'IN_DELIVERY';
                        const confirmed = await modalService.confirm({ title: 'ยืนยันการสั่งซื้อสินค้า', message: `ยืนยันสั่งซื้อ PO ${selectedPO.poNo}?`, confirmText: 'ยืนยันสั่งซื้อแล้ว', cancelText: 'ยกเลิก' });
                        if (confirmed) {
                          try {
                            const updated = await apiService.updatePOStatus(selectedPO.id, targetStatus, currentRole);
                            const updatedPayload = updated || { ...selectedPO, status: targetStatus };
                            if (context?.updatePO) context.updatePO(selectedPO.id, updatedPayload);
                            if (onRefresh) onRefresh(updatedPayload);
                            await modalService.success('บันทึกสั่งซื้อแล้ว', `PO ${selectedPO.poNo} เปลี่ยนสถานะเป็นกำลังจัดส่ง`);
                            onClose();
                          } catch (err) { modalService.error('เกิดข้อผิดพลาด', err.message); }
                        }
                      }}
                      disabled={!hasAssignedVendor}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white text-xs font-bold rounded-xl flex items-center gap-2 cursor-pointer transition-all shadow-2xs"
                    >
                      <ShoppingCart className="w-3.5 h-3.5" />บันทึกสั่งซื้อแล้ว
                    </button>
                  )}

                  {/* Self Claim Resolution button */}
                  {isOperational && isClaimStatus && selectedPO.purchaseChannel === 'SELF' && canResolveSelfClaim && !showSelfClaimResolution && (
                    <button
                      onClick={() => setShowSelfClaimResolution(true)}
                      className="px-4 py-2 text-xs font-bold rounded-xl flex items-center gap-1.5 cursor-pointer transition-all shadow-2xs bg-rose-600 text-white hover:bg-rose-700"
                    >
                      <ShieldAlert className="w-3.5 h-3.5" />
                      <span>จัดการเคสปัญหา</span>
                    </button>
                  )}

                  {/* Secondary Outline: [ 🚨 แจ้งปัญหา / ติดตามร้าน ] */}
                  {isOperational && canReceiveGoods && isReceivable && canReportClaim && (
                    <button
                      type="button"
                      onClick={() => setActiveView('CLAIM')}
                      className="border border-rose-200 text-rose-700 bg-rose-50/60 hover:bg-rose-100 px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-all shadow-2xs"
                    >
                      <span>🚨 แจ้งปัญหา / ติดตามร้าน</span>
                    </button>
                  )}

                  {/* Primary Solid CTA: [ 📥 บันทึกตรวจรับสินค้า (+IN) ➔ ] */}
                  {isOperational && canReceiveGoods && isReceivable && (
                    <button
                      type="button"
                      onClick={() => setShowReceivingModal(true)}
                      className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold px-5 py-2.5 rounded-xl shadow-sm text-xs flex items-center gap-2 cursor-pointer transition-all"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>📥 บันทึกตรวจรับสินค้า (+IN) ➔</span>
                    </button>
                  )}

                  {['CLOSED', 'COMPLETED', 'RECEIVED'].includes(selectedPO.status) && (
                    <div className="inline-flex items-center gap-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200 px-3.5 py-2 rounded-xl text-xs font-bold">
                      <CheckCircle2 className="w-3.5 h-3.5" />รับเข้าคลังครบแล้ว (+IN)
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* AttachmentViewerModal */}
      {viewingAttachment && (
        <AttachmentViewerModal
          file={viewingAttachment.file}
          url={viewingAttachment.url}
          title={viewingAttachment.title}
          onClose={() => setViewingAttachment(null)}
        />
      )}

      {/* POSettlementModal */}
      {showSettlementModal && (
        <POSettlementModal
          po={selectedPO}
          currentUser={currentUser || currentRole}
          onClose={() => setShowSettlementModal(false)}
          onSuccess={(updatedPO) => {
            setShowSettlementModal(false);
            if (context?.updatePO) context.updatePO(selectedPO.id, updatedPO);
            if (onRefresh) onRefresh(updatedPO);
          }}
        />
      )}
    </>
  );

  if (typeof document === 'undefined') {
    return modalContent;
  }

  return createPortal(modalContent, document.body);
}
