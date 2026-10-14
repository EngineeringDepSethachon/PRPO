import React, { useState, useEffect, useMemo } from 'react';
import { 
  Package, ExternalLink, Copy, Check, 
  Store, AlertTriangle, ArrowRight, FileText, CheckCircle2,
  Clock, ChevronDown, ChevronUp, Paperclip, Eye, Download,
  Image as ImageIcon, X, Truck, Calendar
} from 'lucide-react';
import { sanitizeExternalUrl, getProductUrl } from '../../utils/urlHelper';
import { apiService } from '../../services/apiService';
import { modalService } from '../../services/modalService';
import { storageService } from '../../services/storageService';
import { useAppContext } from '../../context/AppContext';
import { budgetService } from '../../services/budgetService';
import { rollbackBudget as standaloneRollbackBudget, deductBudget as standaloneDeductBudget } from '../../context/BudgetContext';
import CollapsibleActivityTimeline from '../../components/common/CollapsibleActivityTimeline';
import { isOrderPending, isOrderInClaim, isOrderClosed } from '../../context/OnlineOrderContext';
import ImageLightboxModal from '../../components/common/ImageLightboxModal';
import { getFallbackAttachmentsForCode } from '../../services/workflowEngine';
import AttachmentViewerModal from '../../components/common/AttachmentViewerModal';
import AttachmentThumbnail from '../../components/common/AttachmentThumbnail';
import { formatCurrency } from '../../utils/formatters.js';
import { resolveDriveImageUrl, handleDriveImageError } from '../../utils/driveHelper';
import LoadingOverlay from '../../components/common/LoadingOverlay.jsx';

const formatMoney = (n) => formatCurrency(n);

// ✅ สูตรการสร้าง Unique Store Group Key (Precise Multi-Store Grouping)
export const getStoreGroupKey = (item, index) => {
  if (!item) return `Shopee_item_${index ?? 0}`;
  const platform = (item.storePlatform || item.platform || 'Shopee').trim();
  const storeName = (item.actualStoreName || item.storeName || '').trim();
  const productUrl = (item.productUrl || item.onlineUrl || item.url || '').trim();
  
  // ถ้ามีชื่อร้าน ให้จัดกลุ่มตาม Platform + StoreName
  if (storeName && !storeName.includes('ระบุร้านภายหลัง')) {
    return `${platform}_${storeName.toLowerCase()}`;
  }
  
  // ถ้าไม่มีชื่อร้านแต่มี URL ให้แยกตาม Host/Path หรือแยกเป็นรายรายการไม่ให้ชนกัน
  if (productUrl) {
    try {
      const parsed = new URL(productUrl);
      const segments = parsed.pathname.split('/').filter(Boolean);
      let shopIdentifier = '';
      if (segments.length > 0) {
        if (segments[0].toLowerCase() === 'product' && segments.length > 1) {
          shopIdentifier = segments[1];
        } else {
          shopIdentifier = segments[0];
        }
      }
      if (shopIdentifier && !shopIdentifier.toLowerCase().includes('item')) {
        return `${platform}_${shopIdentifier.toLowerCase()}`;
      }
      return `${platform}_item_${item.id || index}`;
    } catch {
      return `${platform}_item_${item.id || index}`;
    }
  }

  // กรณีไม่มีข้อมูลใดๆ ให้แยกอิสระ ไม่นำมารวมกันมั่ว
  return `${platform}_item_${item.id || index}`;
};

// ✅ ฟังก์ชันตรวจสอบการบันทึกผลเจรจาของร้านค้า (รองรับ Special Characters, single quotes, storeKey, storeName)
export const isStoreClaimResolved = (group, storeClaims = {}) => {
  if (!group) return true;
  if (!storeClaims || typeof storeClaims !== 'object') {
    return Boolean(group.isResolved || group.status === 'RESOLVED');
  }

  const normalize = (str) => String(str || '').trim().toLowerCase().replace(/['"`]/g, '');

  const storeKey = group.storeKey || '';
  const storeName = group.storeName || '';
  const normKey = normalize(storeKey);
  const normName = normalize(storeName);

  // 1. Direct key match: storeKey, storeName, lowercase, normalized
  const directClaim = storeClaims[storeKey] || 
                      storeClaims[storeName] || 
                      storeClaims[storeKey.toLowerCase()] || 
                      storeClaims[storeName.toLowerCase()] ||
                      storeClaims[normKey] ||
                      storeClaims[normName];

  if (directClaim) {
    if (directClaim.isResolved === false || directClaim.status === 'PENDING_CLAIM' || directClaim.claimStatus === 'PENDING_CLAIM') {
      return false;
    }
    if (directClaim.isResolved || directClaim.status === 'RESOLVED' || directClaim.status === 'COMPLETED') {
      return true;
    }
  }

  // 2. Iterate through storeClaims supporting normalized comparison and quotes removal
  for (const [key, claim] of Object.entries(storeClaims)) {
    if (!claim) continue;
    if (claim.isResolved === false || claim.status === 'PENDING_CLAIM' || claim.claimStatus === 'PENDING_CLAIM') {
      return false;
    }
    const isResolvedStatus = claim.isResolved || claim.status === 'RESOLVED' || claim.status === 'COMPLETED';
    if (!isResolvedStatus) continue;

    const kNorm = normalize(key);
    const claimStoreNameNorm = normalize(claim.storeName);
    const claimStoreKeyNorm = normalize(claim.storeKey);

    if (
      kNorm === normKey ||
      kNorm === normName ||
      claimStoreNameNorm === normName ||
      claimStoreKeyNorm === normKey ||
      (normName && kNorm.endsWith(normName)) ||
      (normName && claimStoreNameNorm === normName)
    ) {
      return true;
    }
  }

  // 3. Check group.claimData
  if (group.claimData) {
    if (group.claimData.isResolved === false || group.claimData.status === 'PENDING_CLAIM' || group.claimData.claimStatus === 'PENDING_CLAIM') {
      return false;
    }
    if (group.claimData.isResolved || group.claimData.status === 'RESOLVED' || group.claimData.status === 'COMPLETED') {
      return true;
    }
  }

  if (group.isResolved || group.status === 'RESOLVED') {
    return true;
  }

  return false;
};

// ✅ ฟังก์ชันตรวจสอบว่าร้านค้านี้มีปัญหาเคลมจริงและยังไม่ได้รับการเจรจาหรือไม่ (Directive 1)
export const isStorePendingClaim = (group, storeClaims = {}) => {
  if (!group || !Array.isArray(group.items) || group.items.length === 0) return false;

  // 1) มีปัญหาเคลมจริง: มี damagedQty > 0 หรือ shortageQty > 0 โดยที่ shortageAction === 'CLAIM_SHORTAGE' (หรือไม่ได้ระบุ WAIT_NEXT_ROUND)
  // ต้องไม่นับ WAIT_NEXT_ROUND หรือร้านที่รับครบสมบูรณ์
  const hasRealClaim = group.items.some(i => {
    const damaged = Number(i.damagedQty ?? i.defectQty ?? i.claimedQty ?? 0);
    const shortage = Number(i.shortageQty ?? 0);
    const isWaitNext = i.shortageAction === 'WAIT_NEXT_ROUND' || 
                       i.disputeAction === 'WAIT_NEXT_ROUND' || 
                       i.shortageReason === 'SPLIT_SHIPMENT';

    if (damaged > 0) return true;
    if (shortage > 0 && !isWaitNext) {
      return true;
    }
    return false;
  });

  if (!hasRealClaim) return false;

  // 2) ยังไม่ได้รับการเจรจา
  return !isStoreClaimResolved(group, storeClaims);
};

// ✅ สูตรคำนวณจำนวนที่ต้องเคลมที่ถูกต้อง (Item Disputed Quantity & Claim Amount Logic with Lifecycle Guard)
export const calculateDisputeMetrics = (item, poStatus = null, poHasGRN = null) => {
  if (!item) {
    return {
      orderedQty: 0,
      receivedQty: 0,
      shortageQty: 0,
      damagedQty: 0,
      disputedQty: 0,
      unitPrice: 0,
      claimableAmount: 0,
      hasDispute: false
    };
  }

  const ordered = Number(item.actualQty ?? item.quantity ?? item.qty ?? item.purchaseQty ?? item.orderedQty ?? 0);
  const unitPrice = Number(item.actualPrice ?? item.unitPrice ?? item.price ?? 0);

  // ตรวจสอบและระบุสถานะของ PO และข้อมูลการตรวจรับ GRN
  const statusUpper = String(poStatus || item.poStatus || item.status || '').toUpperCase();

  // ตรวจสอบว่า item มีข้อมูลการตรวจรับหรือตัวเลขที่บ่งชี้ว่าผ่านการตรวจรับจริงแล้วหรือไม่
  const hasItemInspection = Boolean(
    (item.receivedQty !== undefined && item.receivedQty !== null && item.receivedQty !== '' && Number(item.receivedQty) > 0) ||
    (item.grnReceivedQty !== undefined && item.grnReceivedQty !== null && item.grnReceivedQty !== '' && Number(item.grnReceivedQty) > 0) ||
    (item.accumulatedReceived !== undefined && item.accumulatedReceived !== null && item.accumulatedReceived !== '' && Number(item.accumulatedReceived) > 0) ||
    (item.goodQty !== undefined && item.goodQty !== null && item.goodQty !== '' && Number(item.goodQty) > 0) ||
    (item.acceptedQty !== undefined && item.acceptedQty !== null && item.acceptedQty !== '' && Number(item.acceptedQty) > 0) ||
    (Number(item.damagedQty) > 0) ||
    (Number(item.defectQty) > 0) ||
    (item.shortageQty !== undefined && item.shortageQty !== null && item.shortageQty !== '') ||
    Boolean(item.hasGRN) ||
    Boolean(item.grNumber) ||
    Boolean(item.grId) ||
    Boolean(item.grnNumber) ||
    (Array.isArray(item.grnHistory) && item.grnHistory.length > 0) ||
    Boolean(item.isInspectionDone) ||
    Boolean(item.claimStatus)
  );

  const effectiveHasGRN = Boolean(
    poHasGRN ||
    hasItemInspection ||
    item.hasGRN ||
    item.grNumber ||
    item.grId ||
    item.grnNumber ||
    (Array.isArray(item.grnHistory) && item.grnHistory.length > 0) ||
    item.isInspectionDone
  );

  // 🛡️ LIFECYCLE GUARD:
  // ถ้าสินค้าอยู่ในสถานะ PENDING, ORDERED, IN_TRANSIT และคลังยังไม่ได้ตรวจรับจริง (ไม่มี GRN)
  // ห้ามมองว่า receivedQty = 0 เป็นการขาดของเด็ดขาด!
  const isPreInspection = !effectiveHasGRN && !hasItemInspection && (
    statusUpper === 'PENDING' || 
    statusUpper === 'PENDING_ORDER' || 
    statusUpper === 'WAITING_ORDER' ||
    statusUpper === 'IN_PROGRESS_ONLINE' ||
    statusUpper === 'ORDERED' || 
    statusUpper === 'ORDERED_PENDING_DELIVERY' ||
    statusUpper === 'IN_TRANSIT' ||
    statusUpper === 'IN_DELIVERY' ||
    statusUpper === 'WAITING_DELIVERY' ||
    statusUpper === 'WAITING_DELIVERY_ROUND_2' ||
    statusUpper === 'ISSUED' ||
    statusUpper === ''
  );

  if (isPreInspection) {
    return {
      orderedQty: ordered,
      receivedQty: 0,
      shortageQty: 0,
      damagedQty: 0,
      disputedQty: 0,
      unitPrice,
      claimableAmount: 0,
      hasDispute: false
    };
  }

  // Directive 1: ตรวจสอบการอ่านค่ายอดรับจริงจากคลัง โดยต้องครอบคลุม Key ที่อาจแตกต่างกัน
  const received = Number(
    item.receivedQty ?? 
    item.grnReceivedQty ?? 
    item.accumulatedReceived ?? 
    item.goodQty ?? 
    item.acceptedQty ?? 
    item.receivedThisRound ?? 
    (item.isFullyReceived ? ordered : 0)
  );
  const damaged = Number(item.damagedQty ?? item.defectQty ?? item.accumulatedDamaged ?? item.damagedThisRound ?? item.claimedQty ?? 0);

  // Directive 1 & 3: สูตรของขาด: const shortage = item.shortageQty ?? Math.max(0, ordered - received - damaged);
  const shortage = (item.shortageQty !== undefined && item.shortageQty !== null && item.shortageQty !== '')
    ? Number(item.shortageQty)
    : Math.max(0, ordered - received - damaged);

  const shortageAction = item.shortageAction || (
    item.disputeAction === 'WAIT_NEXT_ROUND' || item.shortageReason === 'SPLIT_SHIPMENT' || item.action === 'WAIT_NEXT_ROUND'
      ? 'WAIT_NEXT_ROUND'
      : (item.disputeAction === 'CLAIM' || item.shortageReason === 'VENDOR_SHORTAGE' || item.hasDispute
          ? 'CLAIM_SHORTAGE'
          : (shortage > 0 ? 'CLAIM_SHORTAGE' : ''))
  );

  const isWaitingNextRound = shortage > 0 && (
    shortageAction === 'WAIT_NEXT_ROUND' ||
    item.disputeAction === 'WAIT_NEXT_ROUND' ||
    item.shortageReason === 'SPLIT_SHIPMENT' ||
    item.action === 'WAIT_NEXT_ROUND' ||
    (item.hasDispute === false && damaged === 0)
  );

  // Directive 1: หากยอดรับจริง + ยอดชำรุด เท่ากับยอดสั่งซื้อ (shortage === 0 && damaged === 0)
  // หรือรับของครบสมบูรณ์ ต้องบังคับให้ hasDispute = false เด็ดขาด เพื่อให้ร้านค้านั้นถูกยุบเป็น Slim Muted Row อัตโนมัติ
  if ((ordered > 0 && received + damaged >= ordered && damaged === 0) || (shortage <= 0 && damaged <= 0)) {
    return {
      orderedQty: ordered,
      receivedQty: received > 0 ? received : ordered,
      shortageQty: 0,
      damagedQty: 0,
      disputedQty: 0,
      unitPrice,
      claimableAmount: 0,
      hasDispute: false,
      isWaitingNextRound: false,
      waitingNextRoundQty: 0,
      pUnit: item.purchaseUnit || item.unit || 'ชิ้น'
    };
  }

  // หากเป็นกรณีรอส่งรอบถัดไป (WAIT_NEXT_ROUND): ของขาดไม่ถือเป็นยอดเคลม!
  if (isWaitingNextRound) {
    const disputedQty = Number(damaged || 0);
    return {
      orderedQty: ordered,
      receivedQty: received,
      shortageQty: Math.max(0, shortage),
      damagedQty: Math.max(0, damaged),
      disputedQty,
      unitPrice,
      claimableAmount: Math.round(disputedQty * unitPrice * 100) / 100,
      hasDispute: disputedQty > 0,
      isWaitingNextRound: true,
      waitingNextRoundQty: Math.max(0, shortage),
      pUnit: item.purchaseUnit || item.unit || 'ชิ้น'
    };
  }

  // Directive 3: คำนวณ disputedQty จาก Number(item.damagedQty || 0) + (item.shortageAction === 'CLAIM_SHORTAGE' ? Number(item.shortageQty || 0) : 0)
  const isShortageClaim = shortageAction === 'CLAIM_SHORTAGE' || !isWaitingNextRound;
  const disputedQty = Number(damaged || 0) + (isShortageClaim ? Number(shortage || 0) : 0);
  const claimableAmount = Math.round(disputedQty * unitPrice * 100) / 100;

  return {
    orderedQty: ordered,
    receivedQty: received,
    shortageQty: Math.max(0, shortage),
    damagedQty: Math.max(0, damaged),
    disputedQty,
    unitPrice,
    claimableAmount,
    hasDispute: disputedQty > 0,
    isWaitingNextRound: false,
    waitingNextRoundQty: 0,
    pUnit: item.purchaseUnit || item.unit || 'ชิ้น'
  };
};

// ✅ ฟังก์ชันดึงและจัดระเบียบข้อมูลหลักฐานจากหน้างาน (GRN Evidence Resolver)
export const resolveGRNEvidence = (po, group = null) => {
  if (!po) return null;
  const ev = po.claimEvidence || po.disputeInfo || po.claimData || {};
  const latestGRN = Array.isArray(po.grnHistory) && po.grnHistory.length > 0 
    ? po.grnHistory[po.grnHistory.length - 1] 
    : null;

  const inspectorName = ev.inspectorName || 
                        po.receivedBy || 
                        po.receiverName || 
                        latestGRN?.receivedBy || 
                        'ผู้ตรวจรับพัสดุ';

  const rawInspectedAt = ev.inspectedAt || 
                         ev.date || 
                         po.receivedAt || 
                         latestGRN?.date || 
                         '-';

  let formattedInspectedAt = '-';
  if (rawInspectedAt && rawInspectedAt !== '-') {
    try {
      const d = new Date(rawInspectedAt);
      formattedInspectedAt = isNaN(d.getTime()) ? String(rawInspectedAt) : d.toLocaleString('th-TH');
    } catch {
      formattedInspectedAt = String(rawInspectedAt);
    }
  }

  // Defect note
  const groupItemNotes = (group?.items || [])
    .map(i => i.defectReason || i.defectNote)
    .filter(Boolean);
  const allItemNotes = (po.items || [])
    .map(i => i.defectReason || i.defectNote)
    .filter(Boolean);

  const defectNote = ev.defectNote || 
                     ev.notes || 
                     (groupItemNotes.length > 0 ? groupItemNotes.join('; ') : '') || 
                     (allItemNotes.length > 0 ? allItemNotes.join('; ') : '') || 
                     latestGRN?.note || 
                     po.claimData?.reason || 
                     'พบสินค้าชำรุดหรือของขาดจากการตรวจรับ';

  // Attachments / Images
  const rawImages = ev.defectImages || 
                    ev.evidenceAttachments || 
                    ev.attachments || 
                    latestGRN?.attachments || 
                    po.attachments || 
                    [];

  const images = (Array.isArray(rawImages) ? rawImages : [rawImages])
    .filter(Boolean)
    .map((img, i) => {
      if (typeof img === 'string') {
        return { id: `ev-${i}`, url: img, viewUrl: img, name: `หลักฐานชำรุด ${i + 1}` };
      }
      return {
        ...img,
        url: img.url || img.viewUrl || img.previewUrl || img.dataUrl || '',
        name: img.name || img.fileName || `หลักฐานชำรุด ${i + 1}`
      };
    })
    .filter(img => Boolean(img.url));

  return {
    inspectorName,
    inspectedAt: formattedInspectedAt,
    defectNote,
    images
  };
};

export default function OnlineOrderCard({ 
  po, 
  activeTab,
  setActiveTab,
  currentRole, 
  onUpdate, 
  onViewAttachment, 
  onShowDetails,
  defaultExpanded
}) {
  const [isCardExpanded, setIsCardExpanded] = useState(() => {
    if (typeof defaultExpanded === 'boolean') return defaultExpanded;
    if (activeTab === 'COMPLETED' || activeTab === 'CLOSED' || po?.status === 'COMPLETED' || po?.status === 'CLOSED') return false;
    return true;
  });

  useEffect(() => {
    if (typeof defaultExpanded === 'boolean') {
      setIsCardExpanded(defaultExpanded);
    } else if (activeTab === 'COMPLETED' || activeTab === 'CLOSED' || po?.status === 'COMPLETED' || po?.status === 'CLOSED') {
      setIsCardExpanded(false);
    } else {
      setIsCardExpanded(true);
    }
  }, [activeTab, po?.status, defaultExpanded]);

  const getVendorStr = (p) => {
    if (!p) return '';
    if (typeof p.vendor === 'object' && p.vendor) return p.vendor.name || p.vendor.companyName || '';
    if (typeof p.vendor === 'string' && p.vendor && !p.vendor.includes('ระบุร้านภายหลัง')) return p.vendor;
    if (p.shopName && !p.shopName.includes('ระบุร้านภายหลัง')) return p.shopName;
    if (p.vendorName && !p.vendorName.includes('ระบุร้านภายหลัง')) return p.vendorName;
    return '';
  };

  const initialVendor = getVendorStr(po);
  const [_vendorName, _setVendorName] = useState(initialVendor);
  const [varianceNote, _setVarianceNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSaving, setIsSaving] = useState(false); // Blocking overlay สำหรับ "บันทึกผลเจรจา"
  const [copiedCode, setCopiedCode] = useState('');
  const [copiedPO, setCopiedPO] = useState(false);
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(false);
  const [invalidStoreIndices, setInvalidStoreIndices] = useState(new Set());
  const [prDocsModalOpen, setPrDocsModalOpen] = useState(false);
  const [viewingDoc, setViewingDoc] = useState(null);
  const [lightboxState, setLightboxState] = useState({
    isOpen: false,
    images: [],
    initialIndex: 0,
    title: ''
  });

  const openLightbox = (images, initialIndex = 0, title = '') => {
    setLightboxState({
      isOpen: true,
      images,
      initialIndex,
      title
    });
  };

  const closeLightbox = () => {
    setLightboxState(prev => ({ ...prev, isOpen: false }));
  };

  const getItemAttachments = (item) => {
    if (!item) return [];
    const cleanCode = String(item.code || item.sku || '').trim().toUpperCase();

    // ✅ ตรวจสอบรูปภาพจริงของผู้ใช้ก่อนเสมอ (User Upload First)
    const userAttachments = (Array.isArray(item.attachments) && item.attachments.length > 0)
      ? item.attachments
      : ((Array.isArray(item.images) && item.images.length > 0) ? item.images : null);

    // ดึง fallback เฉพาะเมื่อผู้ใช้ไม่ได้แนบรูปมาจริง ๆ เท่านั้น
    const rawList = userAttachments || getFallbackAttachmentsForCode(cleanCode) || [];

    return (Array.isArray(rawList) ? rawList : [rawList]).map((img, idx) => {
      if (typeof img === 'string') {
        return { url: img, previewUrl: img, name: item.name || `รูปที่ ${idx + 1}` };
      }
      const imgUrl = img?.previewUrl || img?.url || img?.dataUrl || '';
      return {
        url: imgUrl,
        previewUrl: imgUrl,
        name: img?.name || item.name || `รูปที่ ${idx + 1}`,
        type: img?.type || 'image/jpeg'
      };
    }).filter(img => Boolean(img.url));
  };

  // Derive all PR documents (Quotation, general attachments, prAttachments)
  const prDocs = useMemo(() => {
    if (!po) return [];
    const list = [
      ...(po.prAttachments || []),
      ...(po.attachments || []),
      ...(po.quotationFiles || []),
      ...(po.generalAttachments || [])
    ];
    const seen = new Set();
    return list.filter(item => {
      const key = item.url || item.previewUrl || item.name;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((item, idx) => {
      const isPdf = item.type === 'application/pdf' || (typeof (item.url || item.name) === 'string' && (item.url || item.name).toLowerCase().endsWith('.pdf')) || item.category === 'QUOTATION';
      return {
        id: item.id || idx,
        name: item.name || (isPdf ? `ใบเสนอราคา (${idx + 1})` : `เอกสารแนบ (${idx + 1})`),
        url: item.previewUrl || item.url || item.dataUrl || '',
        type: item.type || (isPdf ? 'application/pdf' : 'image/jpeg'),
        category: item.category || (isPdf ? 'QUOTATION' : 'GENERAL'),
        size: item.size
      };
    });
  }, [po]);

  const { currentUser, refundBudget: _refundBudget, rollbackBudget, deductBudget } = useAppContext();

  // ── Status Mapping & Strict Mode Flags (Directive 1) ──
  const statusStr = String(po?.status || '').toLowerCase();
  
  // Mode 1: Pending Order Placement (Strict Mode 1)
  const isPending = activeTab === 'PENDING' || (
    activeTab !== 'CLAIM' && activeTab !== 'ORDERED' && activeTab !== 'CLOSED' && isOrderPending(po?.status)
  );

  // Mode 2: Claim Mode (Strictly only when GRN reported issues and not pending or closed)
  const isClaimOrder = !isPending && (
    activeTab === 'CLAIM' || (
      activeTab !== 'CLOSED' && activeTab !== 'ORDERED' &&
      (po?.status === 'IN_CLAIM' || po?.status === 'PARTIALLY_RECEIVED_IN_CLAIM' || isOrderInClaim(po?.status)) &&
      !isOrderClosed(po?.status)
    )
  );

  const isClosed = !isPending && (activeTab === 'CLOSED' || (activeTab !== 'CLAIM' && isOrderClosed(po?.status)));
  const isPartialReceived = !isPending && ['partial', 'partially_received', 'partial_received', 'รับของแล้วบางส่วน'].includes(statusStr);
  const _isOrdered = !isPending && (activeTab === 'ORDERED' || ['ordered', 'ordered_pending_delivery', 'in_delivery', 'waiting_delivery', 'waiting_delivery_round_2'].includes(statusStr) || statusStr.startsWith('waiting_delivery'));

  // 🛡️ Pre-inspection / Goods Receipt Note (GRN) detection
  const poHasGRN = useMemo(() => {
    if (!po) return false;
    return Boolean(
      po.hasGRN ||
      po.grNumber ||
      po.grId ||
      po.grnNumber ||
      (Array.isArray(po.grnHistory) && po.grnHistory.length > 0) ||
      (Array.isArray(po.grAttachments) && po.grAttachments.length > 0) ||
      po.receivedAt ||
      po.receivingInfo ||
      po.isInspectionDone ||
      (Array.isArray(po.items) && po.items.some(it => 
        it.hasGRN || it.grNumber || (it.shortageQty !== undefined && it.shortageQty !== null && it.shortageQty !== '' && (it.receivedQty !== undefined || it.goodQty !== undefined)) || (Number(it.damagedQty) > 0)
      ))
    );
  }, [po]);

  // Format date-time helper (DD/MM/YYYY HH:mm format)
  const formatDateTime = (val) => {
    if (!val || val === '-') return '';
    const str = String(val).trim();
    const pad = (n) => String(n).padStart(2, '0');
    const matchDmy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*(\d{1,2}):(\d{2})/);
    if (matchDmy) {
      let p1 = parseInt(matchDmy[1], 10);
      let p2 = parseInt(matchDmy[2], 10);
      let yr = parseInt(matchDmy[3], 10);
      const hh = pad(matchDmy[4]);
      const mm = matchDmy[5];

      if (yr === 12 || yr === 26 || yr === 69) yr = 2026;
      else if (yr < 100) yr = 2000 + yr;
      else if (yr > 2400) yr -= 543;

      let day = p1;
      let month = p2;
      if (p1 <= 12 && p2 > 12) {
        day = p2;
        month = p1;
      }
      return `${pad(day)}/${pad(month)}/${yr} ${hh}:${mm}`;
    }
    try {
      const d = new Date(val);
      if (isNaN(d.getTime())) return str;
      const day = pad(d.getDate());
      const month = pad(d.getMonth() + 1);
      let year = d.getFullYear();
      if (year > 2400) year -= 543;
      const hours = pad(d.getHours());
      const minutes = pad(d.getMinutes());
      return `${day}/${month}/${year} ${hours}:${minutes}`;
    } catch {
      return str;
    }
  };

  // ── State for Items ──
  const [itemData, setItemData] = useState(() => 
    (po.items || []).map((item, idx) => ({
      ...item,
      id: item.id || item.sku || `item-${idx}`,
      code: item.code || item.sku || '',
      name: item.name || '',
      note: item.note || '',
      unit: item.unit || item.purchaseUnit || 'ชิ้น',
      purchaseUnit: item.purchaseUnit || item.unit || 'ชิ้น',
      attachments: (Array.isArray(item.attachments) && item.attachments.length > 0)
        ? item.attachments
        : (Array.isArray(item.images) ? item.images : []),
      images: (Array.isArray(item.images) && item.images.length > 0)
        ? item.images
        : (Array.isArray(item.attachments) ? item.attachments : []),
      actualStoreName: (item.actualStoreName && !item.actualStoreName.includes('ระบุร้านภายหลัง')) 
        ? item.actualStoreName 
        : (item.storeName && !item.storeName.includes('ระบุร้านภายหลัง')) 
        ? item.storeName 
        : '',
      storePlatform: item.storePlatform || item.platform || 'Shopee',
      actualPrice: item.actualPrice ?? item.unitPrice ?? item.estimatedPrice ?? item.price ?? 0,
      actualQty: item.actualQty ?? item.purchaseQty ?? item.qty ?? 1,
      unitPrice: item.actualPrice ?? item.unitPrice ?? item.estimatedPrice ?? item.price ?? 0,
      purchaseQty: item.actualQty ?? item.purchaseQty ?? item.qty ?? 1,
      actualTotal: item.actualTotal ?? ((item.actualQty ?? item.purchaseQty ?? item.qty ?? 1) * (item.actualPrice ?? item.unitPrice ?? item.estimatedPrice ?? item.price ?? 0)),
      originalEstimatedPrice: Number(item.originalEstimatedPrice ?? item.estimatedPrice ?? item.unitPrice ?? item.price) || 0,
      originalPurchaseQty: Number(item.originalPurchaseQty ?? item.qty ?? item.purchaseQty) || 1,
      orderRefNo: item.orderRefNo || ''
    }))
  );

  // Sync itemData when po.items or po.id updates
  useEffect(() => {
    setItemData(
      (po.items || []).map((item, idx) => ({
        ...item,
        id: item.id || item.sku || `item-${idx}`,
        code: item.code || item.sku || '',
        name: item.name || '',
        note: item.note || '',
        unit: item.unit || item.purchaseUnit || 'ชิ้น',
        purchaseUnit: item.purchaseUnit || item.unit || 'ชิ้น',
        attachments: (Array.isArray(item.attachments) && item.attachments.length > 0)
          ? item.attachments
          : (Array.isArray(item.images) ? item.images : []),
        images: (Array.isArray(item.images) && item.images.length > 0)
          ? item.images
          : (Array.isArray(item.attachments) ? item.attachments : []),
        actualStoreName: (item.actualStoreName && !item.actualStoreName.includes('ระบุร้านภายหลัง')) 
          ? item.actualStoreName 
          : (item.storeName && !item.storeName.includes('ระบุร้านภายหลัง')) 
          ? item.storeName 
          : '',
        storePlatform: item.storePlatform || item.platform || 'Shopee',
        actualPrice: item.actualPrice ?? item.unitPrice ?? item.estimatedPrice ?? item.price ?? 0,
        actualQty: item.actualQty ?? item.purchaseQty ?? item.qty ?? 1,
        unitPrice: item.actualPrice ?? item.unitPrice ?? item.estimatedPrice ?? item.price ?? 0,
        purchaseQty: item.actualQty ?? item.purchaseQty ?? item.qty ?? 1,
        actualTotal: item.actualTotal ?? ((item.actualQty ?? item.purchaseQty ?? item.qty ?? 1) * (item.actualPrice ?? item.unitPrice ?? item.estimatedPrice ?? item.price ?? 0)),
        originalEstimatedPrice: Number(item.originalEstimatedPrice ?? item.estimatedPrice ?? item.unitPrice ?? item.price) || 0,
        originalPurchaseQty: Number(item.originalPurchaseQty ?? item.qty ?? item.purchaseQty) || 1,
        orderRefNo: item.orderRefNo || ''
      }))
    );
  }, [po.id, po.items]);

  // ── Store-Level Inputs State (Directive 1: Unify Store-Level Inputs) ──
  const [storeInfo, setStoreInfo] = useState(() => {
    const initial = {};
    (po?.items || []).forEach((item, idx) => {
      const initialStore = (item.actualStoreName && !item.actualStoreName.includes('ระบุร้านภายหลัง'))
        ? item.actualStoreName
        : (item.storeName && !item.storeName.includes('ระบุร้านภายหลัง'))
        ? item.storeName
        : '';
      const key = getStoreGroupKey(item, idx);
      if (!initial[key]) {
        initial[key] = {
          storeName: initialStore.trim(),
          orderId: item.orderRefNo || ''
        };
      }
    });
    return initial;
  });

  // Sync storeInfo on PO changes
  useEffect(() => {
    const initial = {};
    (po?.items || []).forEach((item, idx) => {
      const initialStore = (item.actualStoreName && !item.actualStoreName.includes('ระบุร้านภายหลัง'))
        ? item.actualStoreName
        : (item.storeName && !item.storeName.includes('ระบุร้านภายหลัง'))
        ? item.storeName
        : '';
      const key = getStoreGroupKey(item, idx);
      if (!initial[key]) {
        initial[key] = {
          storeName: initialStore.trim(),
          orderId: item.orderRefNo || ''
        };
      }
    });
    setStoreInfo(initial);
  }, [po?.id]);

  const items = itemData;

  const handleItemChange = (index, field, value) => {
    setItemData(prev => {
      const next = [...prev];
      const target = { ...next[index], [field]: value };
      if (field === 'actualPrice') target.unitPrice = value;
      if (field === 'actualQty') target.purchaseQty = value;
      if (field === 'unitPrice') target.actualPrice = value;
      if (field === 'purchaseQty') target.actualQty = value;
      if (field === 'actualTotal') {
        const total = parseFloat(value) || 0;
        const qty = parseFloat(target.purchaseQty) || 1;
        const unit = qty > 0 ? (total / qty) : 0;
        target.unitPrice = unit;
        target.actualPrice = unit;
      }
      next[index] = target;
      return next;
    });
    if (field === 'actualStoreName' && invalidStoreIndices.has(index)) {
      const trimmed = (value || '').trim();
      if (trimmed && !trimmed.includes('ระบุร้านภายหลัง')) {
        const nextSet = new Set(invalidStoreIndices);
        nextSet.delete(index);
        setInvalidStoreIndices(nextSet);
      }
    }
  };

  const handleTotalChange = (index, val) => {
    const num = parseFloat(val);
    handleItemChange(index, 'actualTotal', isNaN(num) || num < 0 ? '' : num);
  };

  const _handleQtyChange = (index, val) => {
    const num = parseFloat(val);
    handleItemChange(index, 'actualQty', isNaN(num) || num <= 0 ? '' : num);
  };

  const _handleItemStoreChange = (index, value) => {
    handleItemChange(index, 'actualStoreName', value);
  };

  const _handleItemPlatformChange = (index, platform) => {
    handleItemChange(index, 'storePlatform', platform);
  };

  const _handleItemOrderRefChange = (index, refNo) => {
    handleItemChange(index, 'orderRefNo', refNo);
  };

  // ── Unified Store Header Updater (Directive 1) ──
  const handleUpdateStoreHeader = (storeKey, field, value) => {
    setStoreInfo(prev => ({
      ...prev,
      [storeKey]: {
        ...(prev[storeKey] || {}),
        [field]: value
      }
    }));

    // Synchronize to itemData for all items belonging to this store section
    const targetGroup = storesGroup.find(g => g.storeKey === storeKey);
    if (targetGroup && targetGroup.itemIndices) {
      setItemData(prev => {
        const next = [...prev];
        targetGroup.itemIndices.forEach(idx => {
          if (next[idx]) {
            if (field === 'storeName') {
              next[idx] = { ...next[idx], actualStoreName: value };
            } else if (field === 'orderId') {
              next[idx] = { ...next[idx], orderRefNo: value };
            }
          }
        });
        return next;
      });
    }

    if (field === 'storeName') {
      const trimmed = (value || '').trim();
      if (trimmed && !trimmed.includes('ระบุร้านภายหลัง')) {
        if (targetGroup && targetGroup.itemIndices) {
          setInvalidStoreIndices(prev => {
            const next = new Set(prev);
            targetGroup.itemIndices.forEach(idx => next.delete(idx));
            return next;
          });
        }
      }
    }
  };

  // Check if modified from original estimate
  const hasModifications = useMemo(() => {
    return items.some(it => 
      Number(it.unitPrice) !== Number(it.originalEstimatedPrice) ||
      Number(it.purchaseQty) !== Number(it.originalPurchaseQty)
    );
  }, [items]);

  // Real-time totals
  const totalEstimatedAmount = useMemo(() => {
    return items.reduce((sum, it) => sum + (Number(it.actualTotal) || 0), 0);
  }, [items]);

  const originalTotalAmount = useMemo(() => {
    return items.reduce((sum, it) => sum + ((Number(it.originalPurchaseQty) || 0) * (Number(it.originalEstimatedPrice) || 0)), 0);
  }, [items]);

  const totalRefundAmount = useMemo(() => {
    if (po?.totalRefunded !== undefined && po?.totalRefunded !== null) {
      return Number(po.totalRefunded);
    }
    if (po?.refundAmount !== undefined && po?.refundAmount !== null) {
      return Number(po.refundAmount);
    }
    let sum = 0;
    if (po?.storeClaims) {
      Object.values(po.storeClaims).forEach(c => {
        sum += Number(c?.refundAmount || 0);
      });
    }
    return sum;
  }, [po?.totalRefunded, po?.refundAmount, po?.storeClaims]);

  const priceDiff = totalEstimatedAmount - originalTotalAmount;

  const handleCopyText = (text, type = 'item') => {
    navigator.clipboard.writeText(text);
    if (type === 'po') {
      setCopiedPO(true);
      setTimeout(() => setCopiedPO(false), 2000);
    } else {
      setCopiedCode(text);
      setTimeout(() => setCopiedCode(''), 2000);
    }
  };

  // ── Group Items by Store (Directive 1, 2, 3 & 4) ──
  const storesGroup = useMemo(() => {
    const groups = {};
    const sourceList = isPending ? itemData : (po?.items || []);

    sourceList.forEach((item, itemIdx) => {
      const plat = item.storePlatform || item.platform || 'Shopee';
      
      let key;
      let sName;
      let hasRealStore;

      if (isPending) {
        // In pending mode, use a stable key based on initial PO item to prevent focus jumping
        const initialItem = po?.items?.[itemIdx] || item;
        key = getStoreGroupKey(initialItem, itemIdx);
        
        const initialStore = (initialItem.actualStoreName && !initialItem.actualStoreName.includes('ระบุร้านภายหลัง'))
          ? initialItem.actualStoreName
          : (initialItem.storeName && !initialItem.storeName.includes('ระบุร้านภายหลัง'))
          ? initialItem.storeName
          : '';
        const currentStoreName = storeInfo[key]?.storeName !== undefined
          ? storeInfo[key].storeName
          : (item.actualStoreName || initialStore || '');
        hasRealStore = Boolean(currentStoreName && !currentStoreName.includes('ระบุร้านภายหลัง'));
        sName = hasRealStore ? currentStoreName : '';
      } else {
        key = getStoreGroupKey(item, itemIdx);
        const rawStoreName = (item.actualStoreName || item.storeName || '').trim();
        hasRealStore = Boolean(rawStoreName && !rawStoreName.includes('ระบุร้านภายหลัง'));
        sName = hasRealStore ? rawStoreName : 'ตลาดออนไลน์ (Shopee/Lazada)';
      }
      
      if (!groups[key]) {
        groups[key] = {
          storeKey: key,
          platform: plat,
          storeName: sName,
          hasRealStore,
          items: [],
          itemIndices: [],
          totalAmount: 0,
          hasDispute: false,
          status: isPending ? 'PENDING' : 'COMPLETED',
          issueItems: [],
          defaultRefund: 0
        };
      }
      
      if (!Array.isArray(groups[key].items)) groups[key].items = [];
      groups[key].items.push(item);
      if (!Array.isArray(groups[key].itemIndices)) groups[key].itemIndices = [];
      groups[key].itemIndices.push(itemIdx);
      const price = Number(item.unitPrice ?? item.actualPrice ?? item.price ?? 0);
      const qty = Number(item.purchaseQty ?? item.actualQty ?? item.qty ?? 0);
      groups[key].totalAmount += (Number(item.actualTotal) || 0);
      
      // Directive 1 & 3: Dispute Detection Logic (Item-level with Lifecycle Guard)
      const metrics = calculateDisputeMetrics(item, po?.status, poHasGRN);
      const isDisputed = Boolean(
        isClaimOrder &&
        (po?.status === 'IN_CLAIM' || po?.status === 'PARTIALLY_RECEIVED_IN_CLAIM' || activeTab === 'CLAIM' || isOrderInClaim(po?.status)) &&
        (metrics.hasDispute || item.status === 'DISPUTED' || item.claimStatus === 'PENDING' || item.hasIssue || item.isDisputed)
      );
      
      if (isDisputed && metrics.hasDispute) {
        groups[key].hasDispute = true;
        groups[key].status = 'DISPUTED';
        groups[key].defaultRefund += metrics.claimableAmount;
        if (!Array.isArray(groups[key].issueItems)) groups[key].issueItems = [];
        groups[key].issueItems.push({
          ...item,
          ...metrics,
          issueQty: metrics.disputedQty,
          linePrice: metrics.unitPrice,
          refundAmt: metrics.claimableAmount
        });
      }
    });

    // Directive 1 (เงื่อนไข 2): ตรวจสอบข้อมูลเคลมใน po.claims หรือ po.storeClaims ที่ตรงกับ group.storeKey หรือ group.platform
    // รวมถึงข้อมูลเคลมระดับ PO เช่น po.claimInfo, po.disputeDetails
    const storeClaims = po?.storeClaims || {};
    const poClaims = po?.claims || [];
    const claimInfo = po?.claimInfo || po?.disputeDetails || null;

    Object.values(groups).forEach(g => {
      // 1. ค้นหาใน storeClaims
      let matchedClaim = storeClaims[g.storeKey] || 
        Object.entries(storeClaims).find(([k]) => k.toLowerCase() === g.storeKey.toLowerCase())?.[1];

      // 2. ค้นหาใน po.claims (ถ้าเป็น Array หรือ Object)
      if (!matchedClaim && Array.isArray(poClaims)) {
        matchedClaim = poClaims.find(c => 
          c && (
            c.storeKey === g.storeKey || 
            c.storeName === g.storeName || 
            (Object.keys(groups).length === 1 && c.platform && c.platform.toLowerCase() === g.platform.toLowerCase())
          )
        );
      } else if (!matchedClaim && poClaims && typeof poClaims === 'object') {
        matchedClaim = poClaims[g.storeKey] || 
          Object.entries(poClaims).find(([k, c]) => 
            k.toLowerCase() === g.storeKey.toLowerCase() || 
            (c && (c.storeName === g.storeName || (Object.keys(groups).length === 1 && c.platform && c.platform.toLowerCase() === g.platform.toLowerCase())))
          )?.[1];
      }

      // 3. ค้นหาใน claimInfo / disputeDetails
      if (!matchedClaim && claimInfo) {
        if (
          claimInfo.storeKey === g.storeKey || 
          claimInfo.storeName === g.storeName || 
          Object.keys(groups).length === 1
        ) {
          matchedClaim = claimInfo;
        }
      }

      if (matchedClaim) {
        g.claimData = matchedClaim;
        const isMatchedPending = matchedClaim.isResolved === false || matchedClaim.status === 'PENDING_CLAIM' || matchedClaim.claimStatus === 'PENDING_CLAIM';
        const isMatchedResolved = !isMatchedPending && (matchedClaim.isResolved || matchedClaim.status === 'RESOLVED' || matchedClaim.status === 'COMPLETED');
        const isReplacement = matchedClaim.type === 'REPLACEMENT' || matchedClaim.actionType === 'REPLACEMENT' || matchedClaim.type === 'RESEND' || matchedClaim.actionType === 'RESEND';
        const hasItemIssue = g.items.some(i => {
          const dam = Number(i.damagedQty ?? i.defectQty ?? i.claimedQty ?? 0);
          const isWait = i.shortageAction === 'WAIT_NEXT_ROUND' || i.disputeAction === 'WAIT_NEXT_ROUND' || i.shortageReason === 'SPLIT_SHIPMENT';
          const sho = Number(i.shortageQty ?? 0);
          return dam > 0 || (sho > 0 && !isWait) || Boolean(i.hasDispute && !isWait);
        });

        if (isMatchedResolved) {
          g.status = 'RESOLVED';
          g.isResolved = true;
        } else if (isClaimOrder || isMatchedPending) {
          g.hasDispute = true;
          g.status = 'DISPUTED';
          g.isResolved = false;
          if (!g.defaultRefund && Number(matchedClaim.refundAmount) > 0) {
            g.defaultRefund = Number(matchedClaim.refundAmount);
          }
        }
      }
    });

    // Directive 3: จัดการ Multi-Store Grouping ให้สะท้อน Dispute จริง
    Object.values(groups).forEach(g => {
      const storeDisputeMetrics = g.items.map(it => calculateDisputeMetrics(it, po?.status, poHasGRN));
      const hasAnyItemDispute = storeDisputeMetrics.some(m => m.hasDispute);
      const waitingItems = storeDisputeMetrics.filter(m => m.isWaitingNextRound && m.waitingNextRoundQty > 0);

      g.waitingNextRoundQty = waitingItems.reduce((sum, m) => sum + m.waitingNextRoundQty, 0);
      g.isWaitingNextRound = g.waitingNextRoundQty > 0 && !hasAnyItemDispute;
      if (waitingItems.length > 0) {
        g.waitingUnit = waitingItems[0].pUnit || waitingItems[0].unit || 'ชิ้น';
      }

      if (hasAnyItemDispute) {
        g.hasDispute = true;
        if (g.status !== 'RESOLVED' || g.isResolved === false) {
          g.status = 'DISPUTED';
          g.isResolved = false;
        }
        g.defaultRefund = storeDisputeMetrics
          .filter(m => m.hasDispute)
          .reduce((sum, m) => sum + m.claimableAmount, 0);

        g.issueItems = g.items
          .map((it, idx) => {
            const m = storeDisputeMetrics[idx];
            if (!m.hasDispute) return null;
            return {
              ...it,
              ...m,
              issueQty: m.disputedQty,
              linePrice: m.unitPrice,
              refundAmt: m.claimableAmount
            };
          })
          .filter(Boolean);
      } else {
        // Directive 1: หากยอดรับจริง + ยอดชำรุด เท่ากับยอดสั่งซื้อ (shortage === 0 && damaged === 0)
        // หรือสินค้าในร้านนี้ไม่มี dispute ใดๆ ต้องบังคับให้ hasDispute = false เด็ดขาด เพื่อให้ร้านค้านั้นถูกยุบเป็น Slim Muted Row อัตโนมัติ
        g.hasDispute = false;
        g.defaultRefund = 0;
        g.issueItems = [];
        if (g.status !== 'RESOLVED') {
          g.status = g.isWaitingNextRound ? 'WAITING_NEXT_ROUND' : 'COMPLETED';
        }
      }
    });

    // Directive 1 (เงื่อนไข 3): Safety Fallback
    // หาก activeTab === 'CLAIM' หรือ isClaimOrder เป็นจริง แต่ "ไม่มีร้านใดเลยที่ถูก flag ว่า hasDispute"
    // ให้บังคับแสดงผลทุกร้านเพื่อให้ผู้ใช้ตรวจสอบได้ แต่ไม่บังคับ issueQty = orderedQty
    // เพราะถ้าของขาดจริง calculateDisputeMetrics จะคำนวณออกมาถูกต้องอยู่แล้ว
    if ((activeTab === 'CLAIM' || isClaimOrder) && Object.values(groups).length > 0) {
      const anyDisputed = Object.values(groups).some(g => g.hasDispute && g.status !== 'RESOLVED');
      if (!anyDisputed) {
        // ✅ Bug Fix: ไม่มีร้านใดมี dispute จริง → แสดงทุกร้านในโหมด CLAIM
        // แต่ไม่ทำ issueQty = orderedQty อีกต่อไป ให้ใช้ค่าที่ calculateDisputeMetrics ให้มาจริงๆ
        Object.values(groups).forEach(g => {
          if (g.status !== 'RESOLVED') {
            // คำนวณ dispute metrics จากสินค้าจริงใน group
            const storeMetrics = g.items.map(it => calculateDisputeMetrics(it, po?.status, poHasGRN));
            const anyItemHasRealDispute = storeMetrics.some(m => m.hasDispute);

            if (anyItemHasRealDispute) {
              // มี dispute จริงจาก GRN → แสดงเป็น DISPUTED
              g.hasDispute = true;
              g.status = 'DISPUTED';
              g.issueItems = g.items
                .map((it, mIdx) => {
                  const m = storeMetrics[mIdx];
                  if (!m.hasDispute) return null;
                  return {
                    ...it, ...m,
                    issueQty: m.disputedQty,
                    linePrice: m.unitPrice,
                    refundAmt: m.claimableAmount
                  };
                })
                .filter(Boolean);
              g.defaultRefund = g.issueItems.reduce((sum, it) => sum + it.refundAmt, 0);
            } else {
              // ✅ Bug Fix Directive 1 (เงื่อนไข 2):
              // ไม่มี dispute จริง (เช่น รับของครบหมด) → แสดงเป็น COMPLETED (Slim Muted Row)
              // ไม่บังคับ hasDispute = true เพื่อให้แถวถูกยุบเป็น Slim Row โดยอัตโนมัติ
              g.hasDispute = false;
              g.status = g.isWaitingNextRound ? 'WAITING_NEXT_ROUND' : 'COMPLETED';
              g.defaultRefund = 0;
              g.issueItems = [];
            }
          }
        });
      }
    }

    return Object.values(groups);
  }, [isPending, itemData, po?.items, storeInfo, isClaimOrder, po?.status, activeTab, po?.storeClaims, po?.claims, po?.claimInfo, po?.disputeDetails, poHasGRN]);

  // Directive 1 & 2: คำนวณหาร้านค้าที่มีปัญหาเคลมจริงและ "ยังไม่ได้รับการเจรจา" (Fix Unresolved Claim Counter)
  const unresolvedStores = useMemo(() => {
    return storesGroup.filter(group => isStorePendingClaim(group, po?.storeClaims));
  }, [storesGroup, po?.storeClaims]);

  // Disputed stores count (strictly 0 if not in claim mode or if all stores are resolved)
  const disputedStoresCount = (isClaimOrder || activeTab === 'CLAIM') ? unresolvedStores.length : 0;
  const isAllResolved = (isClaimOrder || activeTab === 'CLAIM') && storesGroup.length > 0 && unresolvedStores.length === 0;

  // ── Store Accordion State (Directive 2: Interactive Accordion for CLAIM view) ──
  const [expandedStores, setExpandedStores] = useState({});

  const toggleStoreExpand = (storeKey) => {
    setExpandedStores(prev => {
      const targetGroup = storesGroup.find(g => g.storeKey === storeKey);
      const isStoreResolved = targetGroup ? Boolean(
        targetGroup.status === 'RESOLVED' ||
        targetGroup.isResolved ||
        po?.storeClaims?.[targetGroup.storeKey]?.isResolved ||
        po?.storeClaims?.[targetGroup.storeKey]?.status === 'RESOLVED'
      ) : false;
      const isDisputedPending = targetGroup ? Boolean(targetGroup.hasDispute && !isStoreResolved) : false;
      const currentVal = prev[storeKey] !== undefined ? prev[storeKey] : isDisputedPending;
      return {
        ...prev,
        [storeKey]: !currentVal
      };
    });
  };

  useEffect(() => {
    // ปรับ State เริ่มต้นของ expandedStores:
    // ร้านที่ hasDispute === false หรือเคลมแล้ว ต้องตั้งค่าเริ่มต้นเป็น false
    // ร้านที่มี dispute จริงและยังไม่ได้รับการเจรจา ให้เปิดกางออก
    const nextState = {};
    storesGroup.forEach(g => {
      const isStoreResolved = Boolean(
        g.status === 'RESOLVED' ||
        g.isResolved ||
        po?.storeClaims?.[g.storeKey]?.isResolved ||
        po?.storeClaims?.[g.storeKey]?.status === 'RESOLVED'
      );
      nextState[g.storeKey] = Boolean(g.hasDispute && !isStoreResolved);
    });
    setExpandedStores(nextState);
  }, [po?.id, activeTab, storesGroup, po?.storeClaims]);

  // Multi-Store Claim State Map
  const [storeClaimStates, setStoreClaimStates] = useState({});

  useEffect(() => {
    if (!isClaimOrder) {
      setStoreClaimStates({});
      return;
    }
    const initialStates = {};
    storesGroup.forEach(g => {
      const isStoreResolved = Boolean(
        g.status === 'RESOLVED' ||
        g.isResolved ||
        po?.storeClaims?.[g.storeKey]?.isResolved ||
        po?.storeClaims?.[g.storeKey]?.status === 'RESOLVED'
      );
      if (g.hasDispute) {
        initialStates[g.storeKey] = {
          showResolutionForm: !isStoreResolved,
          claimResolutionType: g.claimData?.type || 'REFUND',
          claimExpectedDate: g.claimData?.expectedDate || '',
          claimNote: g.claimData?.note || '',
          refundAmount: g.claimData?.refundAmount !== undefined ? g.claimData.refundAmount : (Math.round(g.defaultRefund * 100) / 100),
          newTrackingNo: g.claimData?.replacementTrackingNo || g.claimData?.newTrackingNo || ''
        };
      }
    });
    setStoreClaimStates(initialStates);
  }, [storesGroup, po?.storeClaims, isClaimOrder]);

  // Unique stores calculation
  const uniqueStores = useMemo(() => {
    if (isPending) {
      return Array.from(new Set(
        storesGroup
          .map(g => (storeInfo[g.storeKey]?.storeName || '').trim())
          .filter(s => s && !s.includes('ระบุร้านภายหลัง'))
      ));
    }
    return Array.from(new Set(items.map(it => (it.actualStoreName || it.storeName || '').trim()).filter(s => s && !s.includes('ระบุร้านภายหลัง'))));
  }, [isPending, storesGroup, storeInfo, items]);

  // Store validation status for unlocking confirm button (Directive 2: No Order ID required)
  const isAllStoresFilled = useMemo(() => {
    if (!storesGroup || storesGroup.length === 0) return false;
    return storesGroup.every(group => {
      const sName = (storeInfo[group.storeKey]?.storeName || group.storeName || '').trim();
      const hasValidStore = Boolean(sName && !sName.includes('ระบุร้านภายหลัง'));
      return hasValidStore;
    });
  }, [storesGroup, storeInfo]);

  const hasInvalidPrice = useMemo(() => {
    return items.some(it => it.actualTotal === '' || isNaN(Number(it.actualTotal)) || Number(it.actualTotal) < 0);
  }, [items]);

  const hasInvalidQty = useMemo(() => {
    return items.some(it => {
      const q = Number(it.purchaseQty ?? it.actualQty);
      return it.purchaseQty === '' || isNaN(q) || q < 1 || !Number.isInteger(q);
    });
  }, [items]);

  const isConfirmReady = isAllStoresFilled && !hasInvalidPrice && !hasInvalidQty && !isSubmitting;

  // Platform Branded Badge Helper (Directive 4)
  const getPlatformBadge = (platform = 'Shopee') => {
    const p = String(platform || '').toLowerCase();
    if (p === 'shopee') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-bold rounded-md bg-[#FFF2EE] text-[#EE4D2D] border border-[#FCD8CF] shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-[#EE4D2D]"></span>
          🛒 Shopee
        </span>
      );
    }
    if (p === 'lazada') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-bold rounded-md bg-[#EEF2FF] text-[#0F146D] border border-[#CAD5FF] shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-[#0F146D]"></span>
          🛍️ Lazada
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-bold rounded-md bg-slate-100 text-slate-700 border border-slate-200 shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
        🌐 {platform || 'Official'}
      </span>
    );
  };

  // ── Action: Confirm Order Placement (Mode 1: บันทึกการสั่งซื้อ) ──
  const handleAcknowledgeAndOrder = async () => {
    // 1. Price & Quantity validation (Directive 2)
    for (let it of items) {
      const q = Number(it.purchaseQty ?? it.actualQty);
      if (it.purchaseQty === '' || isNaN(q) || q < 1 || !Number.isInteger(q)) {
        return modalService.warning(`กรุณาระบุจำนวนสั่งซื้อของ "${it.name}" ให้เป็นจำนวนเต็มบวก (อย่างน้อย 1)`);
      }
      const p = Number(it.unitPrice ?? it.actualPrice);
      if (it.unitPrice === '' || isNaN(p) || p < 0) {
        return modalService.warning(`กรุณาระบุราคาต่อหน่วยของ "${it.name}" ให้ถูกต้อง`);
      }
    }

    // 2. Strict Pre-Order Validation Guard for Store Name (Directive 2)
    for (let g of storesGroup) {
      const sName = (storeInfo[g.storeKey]?.storeName || '').trim();
      if (!sName || sName.includes('ระบุร้านภายหลัง')) {
        return modalService.warning(`กรุณาระบุชื่อร้านค้าจริงบนแพลตฟอร์ม ${g.platform} ให้ครบถ้วน`);
      }
    }

    // 3. Over-Budget Guard Dialog (Directive 2)
    if (priceDiff > 0) {
      const overBudgetConfirmed = await modalService.confirm({
        title: '⚠️ ยืนยันการสั่งซื้อเกินงบประมาณ (Over-Budget Confirmation)',
        message: `ยอดสั่งซื้อจริงรวม (฿${formatMoney(totalEstimatedAmount)}) สูงกว่างบประเมิน PR เดิม (฿${formatMoney(originalTotalAmount)})\n\nส่วนต่างที่เกินงบประมาณ: +฿${formatMoney(priceDiff)}\n\nระบบจะทำการหักงบประมาณคงเหลือของแผนก ${po.department || ''} เพิ่มเติมตามยอดจริง\n\nต้องการยืนยันสั่งซื้อด้วยยอดนี้ใช่หรือไม่?`,
        confirmText: 'ยืนยันสั่งซื้อเกินงบ',
        cancelText: 'กลับไปแก้ไข'
      });
      if (!overBudgetConfirmed) return;
    }

    // 4. Resolve final Vendor Name
    const uniquePlatforms = Array.from(new Set(storesGroup.map(g => g.platform).filter(Boolean)));
    const isMultiStoreOrPlatform = uniqueStores.length > 1 || uniquePlatforms.length > 1;
    const finalVendorName = (!isMultiStoreOrPlatform && uniqueStores.length === 1)
      ? uniqueStores[0]
      : (uniqueStores.length > 1 ? `สั่งซื้อออนไลน์ ${uniqueStores.length} ร้านค้า (${uniqueStores.join(', ')})` : 'ตลาดออนไลน์ Shopee / Lazada');

    let confirmMsg = `ยืนยันบันทึกว่าสั่งซื้อสินค้าเรียบร้อยแล้วสำหรับ PO ${po.poNo || po.id}`;
    if (!isMultiStoreOrPlatform && uniqueStores.length === 1) {
      confirmMsg += `\nร้านค้า: "${uniqueStores[0]}"`;
    } else if (uniqueStores.length > 1) {
      confirmMsg += `\nร้านค้า: สั่งซื้อจาก ${uniqueStores.length} ร้านค้า (${uniqueStores.join(', ')})`;
    }
    confirmMsg += `\nยอดสั่งซื้อรวม: ฿${formatMoney(totalEstimatedAmount)}`;
    if (hasModifications) {
      if (priceDiff < 0) {
        confirmMsg += `\n\n🎉 ประหยัดงบได้ ฿${formatMoney(Math.abs(priceDiff))} (ระบบจะคืนเงินส่วนต่างเข้า Remaining Budget ของแผนก ${po.department || ''})`;
      } else if (priceDiff > 0) {
        confirmMsg += `\n\n⚠️ เกินงบ ฿${formatMoney(priceDiff)} (ระบบจะหักงบประมาณคงเหลือของแผนก ${po.department || ''} เพิ่มเติม)`;
      }
    }
    confirmMsg += `\n\nต้องการบันทึกและส่งต่องานใช่หรือไม่?`;

    const confirmed = await modalService.confirm({
      title: 'ยืนยันการสั่งซื้อสินค้าออนไลน์',
      message: confirmMsg,
      confirmText: 'ยืนยันสั่งซื้อแล้ว',
      cancelText: 'ยกเลิก'
    });

    if (!confirmed) return;

    setIsSubmitting(true);
    try {
      const finalItems = (po.items || []).map((originalItem, idx) => {
        const rowState = itemData[idx] || {};
        const finalQty = Number(rowState.actualQty ?? rowState.purchaseQty ?? originalItem.actualQty ?? originalItem.qty ?? 1);
        const finalTotal = Number(rowState.actualTotal ?? (finalQty * Number(rowState.actualPrice ?? rowState.unitPrice ?? originalItem.actualPrice ?? originalItem.price ?? 0)));
        const finalPrice = finalQty > 0 ? (finalTotal / finalQty) : 0;
        const lineTotal = finalTotal;
        
        const origPrice = Number(originalItem.originalEstimatedPrice ?? originalItem.estimatedPrice ?? originalItem.price ?? 0);
        const origQty = Number(originalItem.originalPurchaseQty ?? originalItem.qty ?? originalItem.purchaseQty ?? 1);
        const rate = Number(originalItem.conversionRate) > 0 ? Number(originalItem.conversionRate) : 1;
        const newStockQty = finalQty * rate;

        // Find which group this item belongs to
        const group = storesGroup.find(g => g.itemIndices && g.itemIndices.includes(idx));
        const sInfo = group ? storeInfo[group.storeKey] : null;

        const resolvedStoreName = (sInfo?.storeName || rowState.actualStoreName || originalItem.actualStoreName || '').trim();
        const resolvedOrderRef = (sInfo?.orderId || rowState.orderRefNo || originalItem.orderRefNo || '').trim();

        return {
          ...originalItem,
          originalEstimatedPrice: origPrice,
          originalPurchaseQty: origQty,
          actualQty: finalQty,
          purchaseQty: finalQty,
          orderedQty: finalQty,
          qty: finalQty,
          stockQty: newStockQty,
          actualTotal: finalTotal,
          actualUnitPrice: finalPrice,
          actualPrice: finalPrice,
          unitPrice: finalPrice,
          price: finalPrice,
          estimatedPrice: finalPrice,
          actUnitPrice: finalPrice,
          actualStoreName: resolvedStoreName,
          storePlatform: group?.platform || rowState.storePlatform || originalItem.storePlatform || 'Shopee',
          orderRefNo: resolvedOrderRef,
          lineTotal: lineTotal,
          total: lineTotal,
          claimStatus: null,
          shortageQty: 0,
          damagedQty: 0
        };
      });

      const grandTotal = finalItems.reduce((sum, itm) => sum + (Number(itm.lineTotal) || 0), 0);

      const updatedPO = await apiService.acknowledgeOnlineTask(
        po.id, 
        finalVendorName, 
        currentRole, 
        finalItems, 
        varianceNote.trim()
      );

      // Reconcile department budget in real-time
      if (priceDiff < 0) {
        const doRollback = rollbackBudget || standaloneRollbackBudget;
        if (doRollback) {
          try {
            await doRollback(
              po.department,
              Math.abs(priceDiff),
              `คืนงบประมาณส่วนต่างจากการสั่งซื้อออนไลน์ได้ราคา/จำนวนถูกลง (PO: ${po.poNo || po.id})`,
              {
                refDocNo: po.poNo || po.id,
                actor: currentUser?.name || currentRole?.name || 'Online Purchaser'
              }
            );
          } catch (bErr) {
            console.warn('[OnlineOrderCard] Rollback budget warning:', bErr);
          }
        }
      } else if (priceDiff > 0) {
        const doDeduct = deductBudget || standaloneDeductBudget;
        if (doDeduct) {
          try {
            await doDeduct(
              po.department,
              priceDiff,
              `หักงบประมาณเพิ่มเติมเนื่องจากยอดสั่งซื้อจริงเกินงบ PR (PO: ${po.poNo || po.id})`,
              {
                refDocNo: po.poNo || po.id,
                actor: currentUser?.name || currentRole?.name || 'Online Purchaser'
              }
            );
          } catch (bErr) {
            console.warn('[OnlineOrderCard] Deduct budget warning:', bErr);
          }
        }
      }
      
      const payload = {
        ...(updatedPO || po),
        status: 'ORDERED',
        vendor: finalVendorName,
        vendorName: finalVendorName,
        shopName: finalVendorName,
        orderedAt: new Date().toISOString(),
        orderedBy: currentUser?.name || currentRole?.name || 'Online Purchaser',
        items: finalItems,
        totalAmount: grandTotal,
        grandTotal: grandTotal,
        subtotal: grandTotal
      };

      if (onUpdate) onUpdate(payload);
      if (typeof setActiveTab === 'function') {
        setActiveTab('ORDERED');
      }
      await modalService.success(
        'บันทึกการสั่งซื้อเรียบร้อย', 
        `บันทึกการสั่งซื้อสำหรับ PO ${po.poNo || po.id} เรียบร้อยแล้ว! ระบบย้ายเอกสารไปที่แท็บ "สั่งซื้อแล้ว" และแจ้งเตือนฝ่ายตรวจรับสินค้า`
      );
    } catch (err) {
      modalService.error('เกิดข้อผิดพลาดในการบันทึก', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Action: Resolve Store Claim (Mode 2: จัดการเคลมเฉพาะร้านค้า) ──
  // ── Action: Resolve Store Claim (Mode 2: จัดการเคลมเฉพาะร้านค้า - Directive 4) ──
  const handleResolveStoreClaim = async (storeKey) => {
    const claimState = storeClaimStates[storeKey];
    if (!claimState) return;

    const { claimResolutionType, claimExpectedDate, claimNote, refundAmount, newTrackingNo } = claimState;

    if (!claimResolutionType) return;

    // Validation: ตรวจสอบยอดเงินสำหรับ REFUND และ CANCEL
    if (claimResolutionType === 'REFUND') {
      if (refundAmount === '' || isNaN(Number(refundAmount)) || Number(refundAmount) < 0) {
        return modalService.warning('กรุณาระบุยอดเงินที่ได้รับคืนจริงให้ถูกต้อง');
      }
      // 🛡️ Guard: ยอดคืนต้องไม่เกินมูลค่าสินค้าที่มีปัญหาจริง (max claimable)
      const storeObjCheck = storesGroup.find(g => g.storeKey === storeKey);
      const maxClaimable = storeObjCheck?.defaultRefund ?? storeObjCheck?.totalAmount ?? 0;
      if (maxClaimable > 0 && Number(refundAmount) > maxClaimable + 0.01) {
        return modalService.warning(
          `ยอดเงินคืนสูงเกินไป — ต้องไม่เกินมูลค่าสินค้าที่มีปัญหาจริง (สูงสุด ฿${maxClaimable.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`
        );
      }
    }
    if (claimResolutionType === 'CANCEL') {
      if (refundAmount === '' || isNaN(Number(refundAmount)) || Number(refundAmount) < 0) {
        return modalService.warning('กรุณาระบุยอดเงินที่ได้รับคืนจริงให้ถูกต้อง');
      }
    }

    // WRITE_OFF จงใจไม่คืนเงิน (0) แต่ยังบันทึก audit trail และปิดงาน
    const resolvedRefundNum = (claimResolutionType === 'REFUND' || claimResolutionType === 'CANCEL') ? Number(refundAmount) : 0;
    const storeObj = storesGroup.find(g => g.storeKey === storeKey);
    const storeName = storeObj ? storeObj.storeName : '';
    
    const trackingSuffix = (newTrackingNo || '').trim() ? ` (เลขพัสดุ: ${(newTrackingNo || '').trim()})` : '';
    const confirmMsg = (claimResolutionType === 'REFUND' || claimResolutionType === 'CANCEL')
      ? `ยืนยันบันทึกผลการเคลมเป็นคืนเงิน ฿${resolvedRefundNum.toLocaleString()} จากร้าน "${storeName}" คืนงบประมาณให้ฝ่าย ${po?.department || ''} และปิดงานของร้านนี้ ใช่หรือไม่?`
      : claimResolutionType === 'WRITE_OFF'
        ? `ยืนยันตัดจำหน่าย/ยกเว้นเคลมสินค้าที่ขาด/เสียหายจากร้าน "${storeName}" โดยไม่รับเงินคืน — ระบบจะบันทึก Audit Trail และปิดเคสของร้านนี้ทันที ใช่หรือไม่?`
        : `ยืนยันบันทึกผลการเคลมเป็นส่งของใหม่จากร้าน "${storeName}"${trackingSuffix} ใช่หรือไม่?`;

    const confirmed = await modalService.confirm({
      title: 'ยืนยันผลการดำเนินการเคลม',
      message: confirmMsg,
      confirmText: 'ยืนยันบันทึก',
      cancelText: 'ยกเลิก'
    });

    if (!confirmed) return;

    setIsSubmitting(true);
    setIsSaving(true); // แสดง LoadingOverlay บล็อกหน้าจอทันที
    try {
      const isReplacement = claimResolutionType === 'REPLACEMENT' || claimResolutionType === 'RESEND';
      const claimUpdateData = {
        status: isReplacement ? 'WAITING_REPLACEMENT' : 'RESOLVED',
        isResolved: true,
        type: claimResolutionType,
        actionType: claimResolutionType,
        resolutionType: claimResolutionType,
        claimStatus: isReplacement ? 'RESOLVED_REPLACEMENT' : 'RESOLVED',
        hasPendingClaim: false,
        refundAmount: resolvedRefundNum,
        replacementTrackingNo: (newTrackingNo || '').trim(),
        newTrackingNo: (newTrackingNo || '').trim(),
        note: (claimNote || '').trim(),
        expectedDate: claimExpectedDate || '',
        resolvedAt: new Date().toISOString(),
        resolvedBy: currentUser?.name || currentRole?.name || 'Online Purchaser'
      };

      const currentStoreClaims = po.storeClaims || {};
      const nextStoreClaims = {
        ...currentStoreClaims,
        [storeKey]: claimUpdateData
      };
      if (storeName && storeName !== storeKey) {
        nextStoreClaims[storeName] = claimUpdateData;
      }

      // Directive 2: คำนวณหาร้านค้าที่มีปัญหาและ "ยังไม่ได้รับการเจรจา"
      // ตรวจสอบว่ายังมีร้านค้าอื่นที่ติดปัญหาเคลมจริงและยังไม่เจรจาหรือไม่
      const remainingUnresolvedStores = storesGroup.filter(group => {
        if (group.storeKey === storeKey || group.storeName === storeName) return false;
        return isStorePendingClaim(group, nextStoreClaims);
      });
      const allOtherDisputesResolved = remainingUnresolvedStores.length === 0;
      
      // ตรวจสอบว่ายังมีสินค้าที่ต้องรอส่งมอบหรือไม่ (Directive 2):
      const hasPendingDeliveries = 
        storesGroup.some(g => g.items.some(i => i.shortageAction === 'WAIT_NEXT_ROUND' || i.disputeAction === 'WAIT_NEXT_ROUND' || i.isWaitingNextRound)) ||
        Object.values(nextStoreClaims || {}).some(c => c.actionType === 'REPLACEMENT' || c.actionType === 'RESEND' || c.type === 'REPLACEMENT' || c.type === 'RESEND') ||
        (claimResolutionType === 'REPLACEMENT' || claimResolutionType === 'RESEND');

      // Automated Budget Rollback (Directive 4 - Idempotent via budgetService)
      if ((claimResolutionType === 'REFUND' || claimResolutionType === 'CANCEL') && resolvedRefundNum > 0) {
        const targetDepartment = po?.department || po?.departmentId || po?.prDepartment || po?.dept || 'PD';
        const creditAmount = Number(resolvedRefundNum ?? 0);
        const rollbackReason = `จัดซื้อเจรจาเคลมสำเร็จ ได้รับเงินคืน ฿${creditAmount.toLocaleString()} เข้าแผนก (ร้าน: ${storeName}, PO: ${po?.poNo || po?.id})`;
        await budgetService.creditDepartmentBudget({
          departmentId: targetDepartment,
          department: targetDepartment,
          amount: creditAmount,
          referencePo: po?.poNo || po?.id,
          storeKey: storeKey,
          storeName: storeName,
          reason: rollbackReason,
          actor: currentUser?.name || 'Online Purchaser'
        });
      }

      const res = await apiService.resolveOnlineClaim(po?.id, {
        type: claimResolutionType || 'REFUND',
        actionType: claimResolutionType || 'REFUND',
        refundAmount: resolvedRefundNum,
        note: `[ร้าน ${storeName}]: ${(claimNote || '').trim()}`,
        expectedDate: claimExpectedDate || '',
        newTrackingNo: (newTrackingNo || '').trim(),
        storeKey: storeKey,
        storeName: storeName,
        allStoresResolved: allOtherDisputesResolved,
        hasPendingDeliveries: hasPendingDeliveries
      }, currentRole || currentUser);

      let nextOrderStatus = res?.status || po.status;
      let nextClaimStatus = res?.claimStatus || po.claimStatus;
      let nextHasDispute = res?.hasDispute !== undefined ? res.hasDispute : po.hasDispute;
      let nextIsInClaim = res?.isInClaim !== undefined ? res.isInClaim : po.isInClaim;

      // บันทึก Activity Timeline
      const timelineTitle = (claimResolutionType === 'REFUND' || claimResolutionType === 'CANCEL')
        ? `จัดซื้อเจรจาเคลมสำเร็จ ได้รับเงินคืน ฿${resolvedRefundNum.toLocaleString()} เข้าแผนก`
        : claimResolutionType === 'WRITE_OFF'
          ? `ตัดจำหน่าย/ยกเว้นเคลม (Write-off): ปิดเคสร้าน "${storeName}" — ไม่มีการคืนเงิน${(claimNote || '').trim() ? ` (${(claimNote || '').trim()})` : ''}`
          : `จัดซื้อเจรจาเคลมสำเร็จ ร้าน "${storeName}" ส่งสินค้าใหม่ทดแทน ${(newTrackingNo || '').trim() ? `(เลขพัสดุ: ${(newTrackingNo || '').trim()})` : ''}`;

      // Update items metadata for settled store (Directives D & E)
      const updatedItems = (res?.items || po?.items || []).map((item, idx) => {
        const itemStore = (item.actualStoreName || item.storeName || '').trim().toLowerCase();
        const normStoreName = String(storeName || '').trim().toLowerCase();
        const normStoreKey = String(storeKey || '').trim().toLowerCase();
        const itemStoreKey = String(item.storeKey || '').trim().toLowerCase();
        const platformKey = item.storePlatform ? `${item.storePlatform.toLowerCase()}_${itemStore}` : '';

        const isTarget = Boolean(
          (storeObj?.itemIndices && storeObj.itemIndices.includes(idx)) ||
          (itemStoreKey && (itemStoreKey === normStoreKey || normStoreKey.includes(itemStoreKey))) ||
          (normStoreName && itemStore === normStoreName) ||
          (normStoreKey && normStoreKey.includes(itemStore)) ||
          (normStoreName && normStoreName.includes(itemStore)) ||
          (itemStore && normStoreKey && itemStore.includes(normStoreKey)) ||
          (platformKey && (platformKey === normStoreKey || normStoreKey.includes(platformKey)))
        );

        if (!isTarget) return item;

        const ordered = Number(item.orderedQty ?? item.actualQty ?? item.quantity ?? item.purchaseQty ?? 0);
        const received = Number(item.accumulatedReceived ?? item.goodQty ?? item.receivedQty ?? 0);
        const disputeQty = Number(
          item.damagedQty ||
          item.shortageQty ||
          (item.orderedQty ? (item.orderedQty - (item.receivedQty || 0)) : 0) ||
          Math.max(0, ordered - received)
        );

        if (claimResolutionType === 'REFUND' || claimResolutionType === 'CANCEL') {
          const unitPrice = Number(item.actualPrice ?? item.unitPrice ?? item.price ?? 0);
          const itemRefundValue = (resolvedRefundNum > 0 && storeObj?.items?.length === 1)
            ? resolvedRefundNum
            : (Number(resolvedRefundNum) || Math.round(disputeQty * unitPrice * 100) / 100 || (disputeQty * unitPrice));
          return {
            ...item,
            claimResolution: 'REFUND',
            refundedQty: disputeQty,
            refundAmount: itemRefundValue,
            isSettled: true,
            hasDispute: false,
            damagedQty: 0,
            shortageQty: 0,
            remainingQty: 0
          };
        } else if (claimResolutionType === 'REPLACEMENT' || claimResolutionType === 'RESEND') {
          return {
            ...item,
            claimResolution: 'REPLACEMENT',
            replacementPendingQty: disputeQty,
            refundedQty: 0,
            isSettled: false, // Remains receivable in GRN
            hasDispute: false
          };
        } else if (claimResolutionType === 'WRITE_OFF') {
          // ตัดจำหน่าย: ปิดงานโดยไม่คืนเงิน — บันทึก audit trail ไว้สำหรับตรวจสอบ
          return {
            ...item,
            claimResolution: 'WRITE_OFF',
            refundedQty: 0,
            refundAmount: 0,
            isSettled: true,
            hasDispute: false,
            damagedQty: 0,
            shortageQty: 0,
            remainingQty: 0
          };
        }
        return item;
      });

      setItemData(updatedItems);

      const nextTotalRefunded = (claimResolutionType === 'REFUND' || claimResolutionType === 'CANCEL')
        ? Math.round(((Number(po?.totalRefunded) || 0) + resolvedRefundNum) * 100) / 100
        : po?.totalRefunded;

      const updatedOrder = {
        ...(res || po),
        items: updatedItems,
        totalRefunded: nextTotalRefunded,
        status: nextOrderStatus,
        claimStatus: nextClaimStatus,
        hasDispute: nextHasDispute,
        isInClaim: nextIsInClaim,
        storeClaims: nextStoreClaims,
        timeline: [
          ...(po.timeline || po.activityLog || []),
          {
            action: 'CLAIM_SETTLED',
            title: timelineTitle,
            actor: currentUser?.name || currentRole?.name || 'Online Purchaser',
            timestamp: new Date().toISOString(),
            note: (claimNote || '').trim()
          }
        ],
        activityLog: [
          ...(po.activityLog || []),
          {
            action: 'CLAIM_SETTLED',
            title: timelineTitle,
            user: currentUser?.name || currentRole?.name || 'Online Purchaser',
            timestamp: new Date().toLocaleString('th-TH'),
            note: `${timelineTitle} | ${(claimNote || '').trim()}`
          }
        ]
      };

      if (onUpdate) await onUpdate(updatedOrder);

      // Persist directly to storageService to guarantee atomic synchronization
      const allPos = storageService.getPOs() || [];
      const pIdx = allPos.findIndex(p => p.id === po.id || p.poNo === po.poNo || p.poNumber === po.poNumber);
      if (pIdx !== -1) {
        allPos[pIdx] = { ...allPos[pIdx], ...updatedOrder };
        storageService.savePOs(allPos);
      }

      setStoreClaimStates(prev => ({
        ...prev,
        [storeKey]: { ...prev[storeKey], showResolutionForm: false }
      }));

      // ยุบเก็บร้านที่บันทึกผลสำเร็จลงเป็นแถว Slim Muted Row
      setExpandedStores(prev => ({
        ...prev,
        [storeKey]: false
      }));

      await modalService.success(
        'บันทึกผลเจรจาสำเร็จ',
        allOtherDisputesResolved
          ? (updatedOrder.status === 'WAITING_DELIVERY_ROUND_2' 
              ? `บันทึกผลเจรจาสำเร็จ! PO ย้ายไปแท็บ "สั่งซื้อแล้ว" เพื่อรอจัดส่งสินค้าทดแทน`
              : `เจรจาเคลมครบทุกร้านแล้ว! PO ${po.poNo || po.id} ปิดงานสำเร็จและย้ายไปแท็บ "ปิดงานสำเร็จ"`)
          : `บันทึกผลการเจรจาสำหรับร้าน "${storeName}" เรียบร้อยแล้ว (ยังเหลือร้านค้ารอเคลมอีก ${remainingUnresolvedStores.length} ร้านค้า)`
      );
    } catch (err) {
      modalService.error('เกิดข้อผิดพลาดในการบันทึก', err?.message || 'ไม่สามารถบันทึกข้อมูลได้');
    } finally {
      setIsSubmitting(false);
      setIsSaving(false); // ซ่อน LoadingOverlay เมื่อเสร็จ / เกิดข้อผิดพลาด
    }
  };

  const hasOnlineUrl = po.onlineUrl && po.onlineUrl.trim().length > 0;

  // ── Render Status Badge (Directive 3: Adaptive Card Rendering & Explicit Color Codes) ──
  const renderStatusBadge = (status = po?.status) => {
    const rawStatus = String(status || po?.status || '').toUpperCase();

    // 1. PENDING_ORDER: สีเหลืองอำพัน (bg-amber-50 text-amber-700 border-amber-200)
    if (activeTab === 'PENDING' || isPending || rawStatus === 'PENDING_ORDER' || rawStatus === 'PENDING') {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-amber-50 text-amber-700 border border-amber-200 shadow-2xs whitespace-nowrap">
          <Clock className="w-3.5 h-3.5 text-amber-600 animate-pulse" />
          <span>รอดำเนินการสั่งซื้อ</span>
        </span>
      );
    }

    // 2. CLAIM / DISPUTE: สีแดงสด (bg-rose-50 text-rose-700 border-rose-200)
    // Directive 1: แสดงตัวเลขเฉพาะเมื่อมีร้านค้าที่รอเคลมจริง (disputedStoresCount > 0) หากเป็น 0 ต้องไม่แสดงเด็ดขาด
    if (disputedStoresCount > 0) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-50 text-rose-700 border border-rose-200 shadow-2xs whitespace-nowrap">
          <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse"></span>
          <span>🔴 รอเคลม ({disputedStoresCount} ร้านค้า)</span>
        </span>
      );
    }

    // 3. COMPLETED: สีเขียวมรกต (bg-emerald-50 text-emerald-700 border-emerald-200)
    if (activeTab === 'CLOSED' || isClosed || rawStatus === 'COMPLETED' || rawStatus === 'CLOSED' || isAllResolved) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-2xs whitespace-nowrap">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
          <span>✓ ปิดงานสำเร็จ 100%</span>
        </span>
      );
    }

    // 4. ORDERED / IN_TRANSIT: สีน้ำเงิน/คราม (bg-indigo-50 text-indigo-700 border-indigo-200)
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200 shadow-2xs whitespace-nowrap">
        <Truck className="w-3.5 h-3.5 text-indigo-600" />
        <span>{isPartialReceived ? 'รับของแล้วบางส่วน' : 'สั่งซื้อแล้ว (ระหว่างจัดส่ง)'}</span>
      </span>
    );
  };

  // Latest Activity summary for Micro-footer
  const latestActivityText = useMemo(() => {
    if (Array.isArray(po.activityLog) && po.activityLog.length > 0) {
      const last = po.activityLog[po.activityLog.length - 1];
      const timeStr = formatDateTime(last.timestamp || last.time);
      return `${last.action || last.title || 'อัปเดตสถานะ'} โดย ${last.user || last.actor || 'เจ้าหน้าที่'} ${timeStr ? `(${timeStr})` : ''}`;
    }
    if (po.orderedAt) {
      const timeStr = formatDateTime(po.orderedAt);
      return `รับทราบและสั่งซื้อแล้ว โดย ${po.orderedBy || 'ผู้จัดซื้อ'} (${timeStr})`;
    }
    return `ส่งมาจาก ${po.department || 'แผนก'} รอจัดซื้อออนไลน์`;
  }, [po.activityLog, po.orderedAt, po.orderedBy, po.department]);

  const vendorDisplay = useMemo(() => {
    if (uniqueStores.length === 1) return uniqueStores[0];
    if (uniqueStores.length > 1) return `${uniqueStores.length} ร้านค้า (Marketplace)`;
    return getVendorStr(po);
  }, [uniqueStores, po]);

  const completionDateTag = useMemo(() => {
    const rawDate = 
      po.completedAt || 
      po.receivedAt || 
      po.receivingInfo?.receivedAt || 
      po.orderDate || 
      po.issueDate || 
      po.orderedAt || 
      po.date || 
      po.createdAt || 
      po.updatedAt || 
      (Array.isArray(po.grnHistory) && po.grnHistory[0]?.date) ||
      (Array.isArray(po.timeline) && po.timeline[po.timeline.length - 1]?.timestamp) || 
      '';
    if (!rawDate) return '13/09/2026';
    try {
      const d = new Date(rawDate);
      if (isNaN(d.getTime())) {
        const parts = String(rawDate).split('T')[0].split('/');
        if (parts.length === 3) return `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[2]}`;
        const dashParts = String(rawDate).split('T')[0].split('-');
        if (dashParts.length === 3) return `${dashParts[2].padStart(2, '0')}/${dashParts[1].padStart(2, '0')}/${dashParts[0]}`;
        return String(rawDate);
      }
      const day = String(d.getDate()).padStart(2, '0');
      const month = String(d.getMonth() + 1).padStart(2, '0');
      let year = d.getFullYear();
      if (year > 2400) year -= 543;
      return `${day}/${month}/${year}`;
    } catch {
      return '13/09/2026';
    }
  }, [po.completedAt, po.receivedAt, po.receivingInfo, po.orderDate, po.issueDate, po.orderedAt, po.date, po.createdAt, po.updatedAt, po.grnHistory, po.timeline]);

  const storeChipsSummary = useMemo(() => {
    const items = Array.isArray(po.items) ? po.items : [];
    const platforms = {};
    const storeSet = new Set();
    items.forEach(it => {
      const p = (it.storePlatform || it.platform || 'Shopee').trim();
      const sName = (it.actualStoreName || it.storeName || '').trim();
      if (sName) storeSet.add(`${p}_${sName}`);
      platforms[p] = (platforms[p] || 0) + 1;
    });

    const storeCount = storeSet.size || uniqueStores.length || Object.keys(platforms).length || 1;
    const platParts = Object.entries(platforms).map(([plat, cnt]) => `${plat} ${cnt}`).join(', ');
    return {
      count: storeCount,
      text: platParts ? `${storeCount} ร้านค้า (${platParts})` : `${storeCount} ร้านค้า`
    };
  }, [po.items, uniqueStores]);

  const itemsSnippet = useMemo(() => {
    const items = Array.isArray(po.items) ? po.items : [];
    if (items.length === 0) return 'ไม่มีรายการสินค้า';
    const firstItemName = items[0]?.name || items[0]?.productName || 'สินค้า';
    if (items.length === 1) return firstItemName;
    return `${firstItemName} และอีก ${items.length - 1} รายการ`;
  }, [po.items]);

  const rawItemsTotal = totalEstimatedAmount || Number(po.grandTotal ?? po.totalAmount ?? 0);
  const rawOriginalBudget = originalTotalAmount || Number(po.estimatedAmount ?? po.grandTotal ?? po.totalAmount ?? 0);

  let actualSpent = Number(po.actualTotal ?? (rawItemsTotal - totalRefundAmount));
  if (actualSpent <= 0 || isNaN(actualSpent)) {
    actualSpent = Number(po.grandTotal ?? po.totalAmount ?? rawItemsTotal ?? 0);
  }

  let safeRefundAmount = Math.max(0, rawOriginalBudget - actualSpent);
  if (safeRefundAmount === 0 && Number(po.refundAmount) > 0 && actualSpent < rawOriginalBudget) {
    safeRefundAmount = Number(po.refundAmount);
  }

  const actualTotalValue = Math.max(0, actualSpent);
  const totalRefundedValue = Number(po.totalRefunded ?? safeRefundAmount);

  // ── Structured 2-Tier Micro Card (~58px) (When collapsed in Closed/Completed or Passive mode) ──
  if (!isCardExpanded) {
    const formattedActualSpent = formatMoney(actualTotalValue);
    const formattedOriginalBudget = formatMoney(originalTotalAmount);
    const formattedRefund = formatMoney(totalRefundedValue);
    const formattedPriceDiff = formatMoney(Math.abs(priceDiff));

    return (
      <div 
        onClick={() => setIsCardExpanded(true)}
        className="w-full bg-white hover:bg-slate-50/80 border border-slate-200/90 hover:border-slate-300 rounded-xl p-3 sm:px-4 sm:py-2.5 transition-all mb-2.5 shadow-sm duration-150 font-sans cursor-pointer select-none group text-xs"
      >
        {/* Tier 1: Primary Identifiers & High-Level Actions */}
        <div className="flex items-center justify-between gap-3 mb-1.5 flex-wrap sm:flex-nowrap">
          {/* Left: Document Identity & Meta Chips */}
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <div className="font-mono font-bold text-sm text-slate-800 tracking-tight flex items-center gap-1">
              <span>{po.poNo || po.poNumber || po.id}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopyText(po.poNo || po.poNumber || po.id, 'po');
                }}
                className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition-colors cursor-pointer"
                title="คัดลอกรหัส PO"
              >
                {copiedPO ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>

            <span className="px-2 py-0.5 text-[11px] font-semibold bg-slate-100 text-slate-700 rounded-md border border-slate-200">
              {po.department || 'PD'}
            </span>

            <span 
              onClick={(e) => {
                if (po.prNo && onShowDetails) {
                  e.stopPropagation();
                  onShowDetails(po);
                }
              }}
              className={`text-xs text-slate-400 font-mono ${po.prNo ? 'hover:text-indigo-600 cursor-pointer' : ''}`}
              title={po.prNo ? "คลิกเพื่อดูรายละเอียด PR" : undefined}
            >
              PR: {po.prNo || po.prNumber || '-'}
            </span>

            <span className="text-slate-300">•</span>

            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-md">
              <Store className="w-3 h-3 text-slate-400"/>
              <span>{storeChipsSummary.text}</span>
            </span>
          </div>

          {/* Right: Key Financial Total & Primary Status */}
          <div className="flex items-center gap-2.5 flex-shrink-0">
            <span className="text-xs text-slate-400">จ่ายจริง:</span>
            <span className="font-mono font-bold text-sm text-slate-900">
              <span className="sr-only">จ่ายจริง: ฿{formattedActualSpent}</span>
              ฿{formattedActualSpent}
            </span>
            {renderStatusBadge(po.status)}
          </div>
        </div>

        {/* Tier 2: Secondary Details, Item Snippet & Financial Breakdown */}
        <div className="flex items-center justify-between gap-3 text-xs pt-1.5 border-t border-slate-100 text-slate-500 flex-wrap sm:flex-nowrap">
          {/* Left: Goods Preview & Date */}
          <div className="flex items-center gap-2 truncate min-w-0">
            <Calendar className="w-3 h-3 text-slate-400 flex-shrink-0"/>
            <span className="text-[11px] font-mono text-slate-500">{completionDateTag}</span>
            <span className="text-slate-300">•</span>
            <span className="truncate text-slate-600 font-medium" title={itemsSnippet}>
              {itemsSnippet}
            </span>
          </div>

          {/* Right: Detailed Financial Diff & Interactive Controls */}
          <div className="flex items-center gap-3 flex-shrink-0">
            <div className="flex items-center gap-2 text-[11px] font-mono">
              <span className="text-slate-400">งบ: ฿{formattedOriginalBudget}</span>
              {totalRefundedValue > 0 ? (
                <span className="text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded font-semibold border border-emerald-100">
                  +คืน ฿{formattedRefund}
                </span>
              ) : priceDiff < 0 ? (
                <span className="text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded font-semibold border border-emerald-100">
                  +ประหยัด ฿{formattedPriceDiff}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-1.5 pl-2 border-l border-slate-200">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsCardExpanded(true);
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 hover:text-indigo-600 bg-slate-100 hover:bg-slate-200/70 rounded-md transition-colors cursor-pointer"
                title="ดูรายการสินค้า (ดูรายละเอียด)"
              >
                <span>👁️ ดูรายการสินค้า</span>
                <span className="sr-only">ดูรายละเอียด</span>
                <ChevronDown className="w-3.5 h-3.5 transition-transform duration-200 group-hover:translate-y-0.5"/>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (onShowDetails) onShowDetails(po);
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 border border-slate-200 rounded-md transition-colors cursor-pointer"
                title="เปิดดู PO ฉบับเต็ม"
              >
                <span>PO ฉบับเต็ม</span>
                <ExternalLink className="w-3 h-3 text-slate-400"/>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200/90 hover:border-slate-300 rounded-2xl p-3.5 shadow-xs transition-all mb-2.5 font-sans">
      {/* ── 1. Order Header Bar ── */}
      <div className="flex items-center justify-between gap-3 pb-2.5 border-b border-slate-100 flex-wrap sm:flex-nowrap">
        {/* Left: Meta Info */}
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <div className="font-mono font-bold text-slate-800 text-sm flex items-center gap-1.5">
            <span>{po.poNo || po.id}</span>
            <button
              type="button"
              onClick={() => handleCopyText(po.poNo || po.id, 'po')}
              className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition-colors cursor-pointer"
              title="คัดลอกรหัส PO"
            >
              {copiedPO ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          </div>

          <span className="text-slate-200 select-none">•</span>

          <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-xs font-bold">
            {po.department}
          </span>

          {po.prNo && (
            <>
              <span className="text-slate-200 select-none">•</span>
              <span 
                onClick={() => onShowDetails && onShowDetails(po)}
                className="text-xs font-mono text-slate-500 hover:text-indigo-600 cursor-pointer transition-colors"
                title="คลิกเพื่อดูรายละเอียด PR"
              >
                PR: {po.prNo}
              </span>
              {prDocs.length > 0 && (
                <button
                  type="button"
                  onClick={() => setPrDocsModalOpen(true)}
                  className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 hover:border-indigo-300 transition-colors cursor-pointer shadow-2xs shrink-0"
                  title="ดูเอกสารแนบทั้งหมดของ PR นี้"
                >
                  <Paperclip className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                  <span>เอกสาร PR ({prDocs.length})</span>
                </button>
              )}
            </>
          )}

          {Boolean(vendorDisplay) && (
            <>
              <span className="text-slate-200 select-none">•</span>
              <span className="inline-flex items-center gap-1 text-xs text-slate-500 truncate max-w-[220px]">
                <Store className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                <span className="truncate">{vendorDisplay}</span>
              </span>
            </>
          )}

          {hasModifications && isPending && (
            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-md ml-1">
              <AlertTriangle className="w-3 h-3 text-amber-600" />
              <span>ปรับยอด {priceDiff >= 0 ? '+' : ''}฿{priceDiff.toLocaleString()}</span>
            </span>
          )}
        </div>

        {/* Right: Status, Amount & Collapse Button */}
        <div className="flex items-center gap-2.5 shrink-0 self-start sm:self-auto">
          {renderStatusBadge(po.status)}
          <span className="text-sm sm:text-base font-mono font-black text-slate-900 ml-1 min-w-[70px] text-right">
            ฿{formatMoney(totalEstimatedAmount)}
          </span>
          <button
            type="button"
            onClick={() => setIsCardExpanded(false)}
            className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 px-2 py-1 rounded-lg border border-slate-200/80 transition-colors cursor-pointer ml-1"
            title="ย่อการ์ดสรุป"
          >
            <ChevronUp className="w-3.5 h-3.5" />
            <span className="hidden sm:inline text-[11px]">ย่อ</span>
          </button>
        </div>
      </div>

      {/* ── 2. Item Rows & Marketplace Tags: High-Density Grouped Manifest (Unified Container) ── */}
      <div className="rounded-xl border border-slate-200/90 bg-white overflow-hidden divide-y divide-slate-100 my-3">
        {storesGroup.map((group) => {
          const storeClaimState = storeClaimStates[group.storeKey] || {};
          const isStoreResolved = Boolean(
            group.status === 'RESOLVED' ||
            group.isResolved ||
            po?.storeClaims?.[group.storeKey]?.isResolved ||
            po?.storeClaims?.[group.storeKey]?.status === 'RESOLVED' ||
            group.claimData?.isResolved ||
            group.claimData?.status === 'RESOLVED'
          );
          const isStoreClaimActive = isClaimOrder && (group.hasDispute || storeClaimState.showResolutionForm || storeClaimState.isManualDispute) && (storeClaimState.showResolutionForm ?? true) && !isStoreResolved && !isClosed;
          const claimHistory = po?.storeClaims?.[group.storeKey] || group.claimData || Object.entries(po?.storeClaims || {}).find(([k]) => k.toLowerCase() === group.storeKey.toLowerCase())?.[1];
          const storeTotalFormatted = formatMoney(group.totalAmount);

          // Directive 2: ควบคุมการกาง/ยุบร้านค้า (Interactive Accordion) ในแท็บ "รอเคลม"
          const isDisputedPending = Boolean(group.hasDispute && !isStoreResolved);
          const isExpanded = expandedStores[group.storeKey] !== undefined 
            ? Boolean(expandedStores[group.storeKey]) 
            : isDisputedPending;

          // หากอยู่ในแท็บ "รอเคลม" หรือสถานะเคลม และร้านถูกย่อเก็บ (Collapsed)
          if ((activeTab === 'CLAIM' || isClaimOrder) && !isExpanded) {
            // ✅ Bug Fix: Collapsed row แสดงยอดเคลมจริง ไม่ใช่ยอดรวมทั้งร้าน
            // - ถ้าร้านมี dispute → แสดง claimableAmount (rose-colored)
            // - ถ้าร้านรับครบ หรือรอส่งรอบถัดไป หรือเคลมเสร็จสิ้นแล้ว → แสดงเป็น Slim Row
            const rowClaimAmt = group.hasDispute && !isStoreResolved
              ? group.issueItems.reduce((sum, it) => sum + (Number(it.refundAmt) || 0), 0)
              : 0;
            const rowClaimFmt = formatMoney(rowClaimAmt);

            if (!group.hasDispute || isStoreResolved) {
              const isWaiting = Boolean(group.isWaitingNextRound || group.waitingNextRoundQty > 0 || group.status === 'WAITING_NEXT_ROUND');
              const waitingQty = group.waitingNextRoundQty || 1;
              const waitingUnit = group.waitingNextRoundUnit || group.items?.[0]?.unit || 'ชิ้น';
              const effRefund = Number(group.claimData?.refundAmount ?? po?.storeClaims?.[group.storeKey]?.refundAmount ?? 0);
              const statusText = isStoreResolved 
                ? (isClosed || activeTab === 'CLOSED'
                    ? '✓ เคลมเสร็จสิ้น'
                    : (effRefund > 0 
                        ? `✓ บันทึกผลเจรจาเรียบร้อย: ได้รับเงินคืน ฿${formatMoney(effRefund)} เข้าแผนกแล้ว` 
                        : '✓ บันทึกผลเจรจาเรียบร้อย'))
                : (isWaiting ? `(รอส่งมอบเพิ่ม ${waitingQty} ${waitingUnit})` : '(รับของครบสมบูรณ์)');

              return (
                <div
                  key={group.storeKey}
                  className={`px-3.5 py-1.5 ${isStoreResolved ? 'bg-emerald-50/50 border-emerald-100' : isWaiting ? 'bg-amber-50/40 border-amber-100/60' : 'bg-emerald-50/40 border-emerald-100/60'} border-b text-xs flex items-center justify-between select-none`}
                >
                  <div className={`flex items-center gap-2 ${isStoreResolved ? 'text-emerald-800' : isWaiting ? 'text-amber-800' : 'text-emerald-700'}`}>
                    {getPlatformBadge(group.platform)}
                    <span className={`font-medium ${isStoreResolved ? 'text-emerald-900' : isWaiting ? 'text-amber-900' : 'text-emerald-800'}`}>ร้าน: {group.storeName || 'ทั่วไป'}</span>
                    <span className={`text-[11px] ${isStoreResolved ? 'text-emerald-700 bg-emerald-100 border-emerald-200' : isWaiting ? 'text-amber-700 bg-amber-100/80 border-amber-200' : 'text-emerald-600 bg-emerald-100 border-emerald-200'} px-1.5 py-0.5 rounded border font-semibold flex items-center gap-1`}>
                      {isStoreResolved && <CheckCircle2 className="w-3 h-3 text-emerald-600" />}
                      {statusText}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => toggleStoreExpand(group.storeKey)}
                    className="text-slate-400 hover:text-slate-600 font-semibold text-[11px] flex items-center gap-1 cursor-pointer"
                  >
                    เปิดดู / จัดการเคลม ▾
                  </button>
                </div>
              );
            }

            return (
              <div 
                key={group.storeKey}
                onClick={() => toggleStoreExpand(group.storeKey)}
                className="px-3.5 py-2 bg-rose-50/30 hover:bg-rose-50/60 cursor-pointer text-xs flex items-center justify-between transition-colors border-b border-rose-100/70 select-none"
              >
                <div className="flex items-center gap-2 text-slate-600">
                  {getPlatformBadge(group.platform)}
                  <span className="font-medium">ร้าน: {group.storeName || 'ทั่วไป'}</span>
                  <span className="text-[11px] text-rose-600 bg-rose-50 px-1.5 py-0.5 rounded border border-rose-200 font-semibold">
                    ⚠️ มีรายการติดปัญหา ({group.issueItems.length} รายการ)
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {rowClaimAmt > 0 && (
                    <span className="font-mono font-bold text-rose-600">
                      เคลม ฿{rowClaimFmt}
                    </span>
                  )}
                  <span className="text-indigo-600 hover:text-indigo-700 font-semibold text-[11px] flex items-center gap-1">
                    เปิดจัดการเคลม ▾
                  </span>
                </div>
              </div>
            );
          }
          
          return (
            <div key={group.storeKey} className={`divide-y divide-slate-100 ${(activeTab === 'CLAIM' || isClaimOrder) && group.hasDispute && !isStoreResolved ? 'bg-amber-50/15' : ''}`}>
              {/* Store Header Bar (Interactive Accordion Header in CLAIM view, Standard Header otherwise) */}
              {(activeTab === 'CLAIM' || isClaimOrder) ? (
                <div 
                  onClick={() => toggleStoreExpand(group.storeKey)}
                  className="px-3.5 py-2 bg-slate-50/90 hover:bg-slate-100/80 cursor-pointer text-xs flex items-center justify-between transition-colors border-b border-slate-100 select-none"
                >
                  <div className="flex items-center gap-2 text-slate-600">
                    {getPlatformBadge(group.platform)}
                    <span className="font-bold text-slate-800">ร้าน: {group.storeName || 'ทั่วไป'}</span>
                    <span className="text-[11px] text-slate-500">
                      {isStoreResolved
                        ? '✓ บันทึกผลเจรจาเรียบร้อย'
                        : group.hasDispute 
                        ? '⚠️ ร้านนี้มีรายการติดปัญหา' 
                        : (group.isWaitingNextRound ? `(รอส่งมอบเพิ่ม ${group.waitingNextRoundQty || 1} ${group.waitingUnit || 'ชิ้น'})` : '(รับของครบสมบูรณ์)')}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-slate-600 font-semibold">ยอดร้านนี้: ฿{storeTotalFormatted}</span>
                    <span className="text-indigo-600 hover:text-indigo-700 font-semibold text-[11px] flex items-center gap-1">
                      ย่อเก็บ ▴
                    </span>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between px-3.5 py-1.5 bg-slate-50 border-b border-slate-100 text-xs gap-2">
                  {/* ฝั่งซ้าย: Badge แพลตฟอร์ม (Shopee/Lazada) + ช่องกรอกหรือชื่อร้านค้า ร้าน: ... */}
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    {getPlatformBadge(group.platform)}

                    {isPending ? (
                      <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        <span className="text-[11px] font-semibold text-slate-500 shrink-0">ร้าน:</span>
                        <input
                          type="text"
                          placeholder="ระบุชื่อร้านค้าจริง..."
                          value={storeInfo[group.storeKey]?.storeName || ''}
                          onChange={(e) => handleUpdateStoreHeader(group.storeKey, 'storeName', e.target.value)}
                          className="h-7 px-2 text-xs bg-white border border-slate-200 rounded-lg w-48 sm:w-64 font-medium text-slate-800 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 placeholder:text-slate-400 shadow-2xs transition-all"
                        />
                      </div>
                    ) : group.hasRealStore ? (
                      <span className="font-bold text-xs text-slate-800 flex items-center gap-1.5 truncate">
                        <Store className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                        <span>ร้าน: {group.storeName}</span>
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200 shrink-0">
                        [ระบุร้านค้าตอนกดสั่งซื้อ]
                      </span>
                    )}

                    {/* Claim Status Pill - STRICTLY ONLY IN CLAIM MODE */}
                    {isClaimOrder && isStoreResolved && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-700 shrink-0">
                        <CheckCircle2 className="w-3 h-3 inline mr-0.5" /> {(isClosed || activeTab === 'CLOSED') ? 'เคลมเสร็จสิ้น' : 'บันทึกผลเจรจาเรียบร้อย'}
                      </span>
                    )}
                    {isClaimOrder && group.hasDispute && !isStoreResolved && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-700 shrink-0 animate-pulse">
                        มีปัญหารอเคลม
                      </span>
                    )}
                  </div>

                  {/* ฝั่งขวา: ยอดรวมของร้านค้านั้น */}
                  <div className="text-xs font-semibold text-slate-600 font-mono shrink-0">
                    ยอดร้านนี้: <span className="font-bold text-slate-900">฿{storeTotalFormatted}</span>
                  </div>
                </div>
              )}

              {/* แสดงแท็กผลการเจรจาในร้านค้านั้นเมื่อมีประวัติหรือบันทึกผลเจรจาสำเร็จ (po.storeClaims) */}
              {(isStoreResolved || isClosed || activeTab === 'CLOSED') && (po?.storeClaims?.[group.storeKey] || group.claimData || claimHistory || (storesGroup.length === 1 && Number(po?.refundAmount) > 0)) && (() => {
                const effClaim = po?.storeClaims?.[group.storeKey] || group.claimData || claimHistory || { type: 'REFUND', refundAmount: Number(po.refundAmount) };
                if (!effClaim || (!effClaim.isResolved && effClaim.status !== 'RESOLVED' && !isClosed && activeTab !== 'CLOSED')) return null;
                const refundAmountFormatted = formatMoney(effClaim.refundAmount || 0);
                return (
                  <div className="px-3 py-1 bg-emerald-50/50 border-b border-emerald-100 flex items-center justify-between text-[11px] text-emerald-800">
                    <div className="flex items-center gap-1.5">
                      <CheckCircle2 className="w-3 h-3 text-emerald-600 shrink-0" />
                      <span>
                        {(isClosed || activeTab === 'CLOSED')
                          ? (effClaim.type === 'REPLACEMENT'
                              ? `✓ เคลมสำเร็จ: ร้านส่งสินค้าใหม่ทดแทน (พัสดุ: ${effClaim.replacementTrackingNo || effClaim.newTrackingNo || '-'})`
                              : `✓ เคลมสำเร็จ: ได้รับเงินคืน ฿${refundAmountFormatted} เข้าแผนกแล้ว`)
                          : (effClaim.type === 'REPLACEMENT'
                              ? `✓ บันทึกผลเจรจาเรียบร้อย: ร้านส่งสินค้าใหม่ทดแทน ${(effClaim.replacementTrackingNo || effClaim.newTrackingNo) ? `(พัสดุ: ${effClaim.replacementTrackingNo || effClaim.newTrackingNo})` : ''}`
                              : `✓ บันทึกผลเจรจาเรียบร้อย: ได้รับเงินคืน ฿${refundAmountFormatted} เข้าแผนกแล้ว`)}
                      </span>
                    </div>
                    {effClaim.resolvedAt && (
                      <span className="text-[10px] text-emerald-600/80 font-mono">
                        {new Date(effClaim.resolvedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                );
              })()}

              {/* ── Store Items List: High-Density Compact Data Rows (Mode 1) or Read-Only Rows (Mode 2/3) ── */}
              {isPending ? (
                <div className="divide-y divide-slate-100">
                  {group.items.map((item, localIdx) => {
                    const actualIdx = isPending ? group.itemIndices[localIdx] : items.findIndex(it => it.id === item.id);
                    const resolvedIdx = actualIdx >= 0 ? actualIdx : localIdx;
                    const currentItem = isPending ? (itemData[resolvedIdx] || item) : item;
                    const currentItemWithMedia = {
                      ...item,
                      ...currentItem,
                      attachments: (Array.isArray(currentItem?.attachments) && currentItem.attachments.length > 0)
                        ? currentItem.attachments
                        : (Array.isArray(item?.attachments) && item.attachments.length > 0 ? item.attachments : (currentItem?.images || item?.images || [])),
                      images: (Array.isArray(currentItem?.images) && currentItem.images.length > 0)
                        ? currentItem.images
                        : (Array.isArray(item?.images) && item.images.length > 0 ? item.images : (currentItem?.attachments || item?.attachments || []))
                    };
                    const itemImages = getItemAttachments(currentItemWithMedia);

                    const pQty = currentItem.purchaseQty !== '' ? Number(currentItem.purchaseQty ?? currentItem.actualQty ?? currentItem.qty) : '';
                    const price = currentItem.unitPrice !== '' ? Number(currentItem.unitPrice ?? currentItem.actualPrice ?? currentItem.price) : '';
                    const lineTotal = Number(currentItem.actualTotal) || 0;
                    const pUnit = currentItem.purchaseUnit || currentItem.unit || 'ชิ้น';
                    const rawUrl = getProductUrl(currentItem);
                    const origPrice = Number(currentItem.originalEstimatedPrice ?? currentItem.estimatedPrice ?? currentItem.price ?? 0);
                    const origQty = Number(currentItem.originalPurchaseQty ?? currentItem.qty ?? currentItem.purchaseQty ?? 1);

                    return (
                      <div
                        key={currentItem.id || resolvedIdx}
                        className="flex items-center justify-between px-3.5 py-1.5 sm:py-2 bg-white hover:bg-slate-50/70 transition-colors gap-3 min-h-[44px] flex-wrap sm:flex-nowrap"
                      >
                        {/* ฝั่งซ้าย: [รูปภาพสินค้า] [รหัส SKU] [ชื่อสินค้า ↗] [Subtext อ้างอิง PR เดิม] */}
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          {/* Item Thumbnail */}
                          {itemImages.length > 0 ? (
                            <div 
                              className="flex items-center -space-x-1 shrink-0 group/stack"
                              title={`คลิกเพื่อดูรูปภาพขยาย (${itemImages.length} รูป)`}
                            >
                              {itemImages.slice(0, 2).map((img, imgIdx) => (
                                <AttachmentThumbnail
                                  key={imgIdx}
                                  img={img}
                                  imgIdx={imgIdx}
                                  onClick={() => openLightbox(itemImages, imgIdx, currentItem.name)}
                                  sizeClass="w-8 h-8"
                                />
                              ))}
                              {itemImages.length > 2 && (
                                <button
                                  type="button"
                                  onClick={() => openLightbox(itemImages, 2, currentItem.name)}
                                  className="w-8 h-8 rounded-lg bg-slate-800/90 hover:bg-indigo-600 text-white text-[10px] font-mono font-bold flex items-center justify-center border border-white shadow-2xs shrink-0 cursor-pointer transition-transform duration-150 hover:scale-110 hover:z-10 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                >
                                  +{itemImages.length - 2}
                                </button>
                              )}
                            </div>
                          ) : (
                            <div className="w-8 h-8 rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-400 shrink-0">
                              <Package className="w-4 h-4" />
                            </div>
                          )}

                          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-mono text-[11px] font-semibold shrink-0">
                            {currentItem.code || currentItem.sku || 'ITEM'}
                          </span>

                          <div className="flex items-center gap-1.5 min-w-0 flex-wrap sm:flex-nowrap">
                            <span className="text-xs font-semibold text-slate-800 truncate max-w-[220px] sm:max-w-md" title={currentItem.name}>
                              {currentItem.name}
                            </span>
                            {rawUrl && (
                              <a
                                href={sanitizeExternalUrl(rawUrl)}
                                target="_blank"
                                rel="noreferrer"
                                className="text-indigo-600 hover:text-indigo-800 bg-indigo-50/70 hover:bg-indigo-100 p-1 rounded text-xs font-medium shrink-0 inline-flex items-center gap-0.5 transition-colors"
                                title="เปิดลิงก์สินค้าจริง"
                              >
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            )}
                            <button
                              type="button"
                              onClick={() => handleCopyText(currentItem.name, 'item')}
                              className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition-colors cursor-pointer shrink-0"
                              title="คัดลอกชื่อสินค้า"
                            >
                              {copiedCode === currentItem.name ? (
                                <Check className="w-3 h-3 text-emerald-600" />
                              ) : (
                                <Copy className="w-3 h-3" />
                              )}
                            </button>
                            <span className="text-[11px] text-slate-400 font-mono shrink-0">
                              (PR: {origQty} {pUnit} @ ฿{formatMoney(origPrice)})
                            </span>
                          </div>
                        </div>

                        {/* ฝั่งขวา (ชุดกรอกข้อมูลจริงแบบ Compact): [สเต็ปเปอร์จำนวน] [หน่วยนับ] [ช่องราคาต่อหน่วย] [ราคารวมบรรทัด] */}
                        <div className="flex items-center gap-2 sm:gap-2.5 shrink-0 ml-auto">
                          {/* จำนวนจริง: สเต็ปเปอร์ขนาดกะทัดรัด h-8 w-22 p-0.5 border border-slate-200 rounded-lg bg-slate-50 */}
                          <div className="h-8 w-22 p-0.5 border border-slate-200 rounded-lg bg-slate-50 flex items-center justify-between shrink-0">
                            <button
                              type="button"
                              onClick={() => {
                                const currentQty = Number(pQty) || 1;
                                if (currentQty > 1) {
                                  handleItemChange(resolvedIdx, 'actualQty', currentQty - 1);
                                }
                              }}
                              disabled={Number(pQty) <= 1}
                              className="w-6 h-6 rounded bg-white border border-slate-200/80 shadow-2xs flex items-center justify-center text-slate-600 hover:bg-slate-100 active:scale-95 text-xs font-bold transition-all disabled:opacity-30 disabled:pointer-events-none cursor-pointer"
                              title="ลดจำนวน"
                            >
                              -
                            </button>
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={currentItem.purchaseQty === '' ? '' : currentItem.purchaseQty}
                              onChange={(e) => {
                                const val = e.target.value;
                                if (val === '') {
                                  handleItemChange(resolvedIdx, 'actualQty', '');
                                } else {
                                  const n = parseInt(val, 10);
                                  handleItemChange(resolvedIdx, 'actualQty', isNaN(n) ? '' : n);
                                }
                              }}
                              placeholder="1"
                              className="w-8 h-6 bg-transparent text-center font-mono text-xs font-bold text-slate-800 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                              title={`จำนวนสั่งซื้อจริง (${pUnit})`}
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const currentQty = Number(pQty) || 0;
                                handleItemChange(resolvedIdx, 'actualQty', currentQty + 1);
                              }}
                              className="w-6 h-6 rounded bg-white border border-slate-200/80 shadow-2xs flex items-center justify-center text-slate-600 hover:bg-slate-100 active:scale-95 text-xs font-bold transition-all cursor-pointer"
                              title="เพิ่มจำนวน"
                            >
                              +
                            </button>
                          </div>

                          {/* หน่วยนับ: text-xs text-slate-500 w-8 text-center */}
                          <span className="text-xs text-slate-500 w-8 text-center shrink-0 truncate" title={pUnit}>
                            {pUnit}
                          </span>

                          {/* ราคารวมที่จ่ายจริง: ช่อง Input */}
                          <div className="flex flex-col items-end shrink-0">
                            <div className="relative w-28 h-8">
                              <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-slate-400 text-[10px] font-mono select-none pointer-events-none">฿</span>
                              <input
                                type="number"
                                min="0"
                                step="any"
                                value={currentItem.actualTotal === '' ? '' : currentItem.actualTotal}
                                onChange={(e) => handleTotalChange(resolvedIdx, e.target.value)}
                                placeholder="0.00"
                                className="w-28 h-8 pl-4 pr-2 text-right font-mono text-xs bg-white border border-slate-200 rounded-lg focus:border-indigo-500 focus:outline-none transition-all tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                title="ราคารวมที่จ่ายจริง"
                              />
                            </div>
                            {Number(pQty) > 0 && currentItem.actualTotal !== '' && (
                              <span className="text-[10px] text-slate-500 font-medium mt-1 text-right">
                                เฉลี่ย @ ฿{((Number(currentItem.actualTotal) || 0) / Number(pQty)).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / {pUnit}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {group.items
                    .filter(item => {
                      if (activeTab === 'CLAIM') {
                        const itMetrics = calculateDisputeMetrics(item, po?.status, poHasGRN);
                        const itAction = item.shortageAction || (item.shortageReason === 'SPLIT_SHIPMENT' ? 'WAIT_NEXT_ROUND' : (item.disputeAction === 'WAIT_NEXT_ROUND' ? 'WAIT_NEXT_ROUND' : ''));
                        const hasDamage = Number(item.damagedQty || item.defectQty || 0) > 0;
                        // Directive 3: หากคลังเลือก WAIT_NEXT_ROUND ในแท็บ "รอเคลม" ให้กรองออก (Hidden 100%)
                        if ((itAction === 'WAIT_NEXT_ROUND' || itMetrics.isWaitingNextRound) && !hasDamage) {
                          return false;
                        }
                      }
                      return true;
                    })
                    .map((item, localIdx) => {
                    const actualIdx = isPending ? group.itemIndices[localIdx] : items.findIndex(it => it.id === item.id);
                    const resolvedIdx = actualIdx >= 0 ? actualIdx : localIdx;
                    const currentItem = isPending ? (itemData[resolvedIdx] || item) : item;
                    const currentItemWithMedia = {
                      ...item,
                      ...currentItem,
                      attachments: (Array.isArray(currentItem?.attachments) && currentItem.attachments.length > 0)
                        ? currentItem.attachments
                        : (Array.isArray(item?.attachments) && item.attachments.length > 0 ? item.attachments : (currentItem?.images || item?.images || [])),
                      images: (Array.isArray(currentItem?.images) && currentItem.images.length > 0)
                        ? currentItem.images
                        : (Array.isArray(item?.images) && item.images.length > 0 ? item.images : (currentItem?.attachments || item?.attachments || []))
                    };
                    const itemImages = getItemAttachments(currentItemWithMedia);

                    const pQty = Number(currentItem.purchaseQty ?? currentItem.actualQty ?? currentItem.qty) || 1;
                    const price = Number(currentItem.unitPrice ?? currentItem.actualPrice ?? currentItem.price) || 0;
                    const lineTotal = price * pQty;
                    const pUnit = currentItem.purchaseUnit || currentItem.unit || 'ชิ้น';
                    const rawUrl = getProductUrl(currentItem);
                    
                    return (
                      <div key={currentItem.id || resolvedIdx} className="py-1.5 px-3 bg-white hover:bg-slate-50/70 transition-colors flex items-center justify-between gap-2.5 min-h-[36px] text-xs">
                        {/* ฝั่งซ้าย: [Img] [รหัส] ชื่อสินค้า ↗ */}
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          {/* Item Thumbnail (28x28) */}
                          {itemImages.length > 0 ? (
                            <div 
                              className="flex items-center -space-x-1 shrink-0 group/stack"
                              title={`คลิกเพื่อดูรูปภาพขยาย (${itemImages.length} รูป)`}
                            >
                              {itemImages.slice(0, 2).map((img, imgIdx) => (
                                <AttachmentThumbnail
                                  key={imgIdx}
                                  img={img}
                                  imgIdx={imgIdx}
                                  onClick={() => openLightbox(itemImages, imgIdx, currentItem.name)}
                                  sizeClass="w-7 h-7"
                                />
                              ))}
                              {itemImages.length > 2 && (
                                <button
                                  type="button"
                                  onClick={() => openLightbox(itemImages, 2, currentItem.name)}
                                  className="w-7 h-7 rounded-md bg-slate-800/90 hover:bg-indigo-600 text-white text-[9px] font-mono font-bold flex items-center justify-center border border-white shadow-2xs shrink-0 cursor-pointer transition-transform duration-150 hover:scale-110 hover:z-10 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                >
                                  +{itemImages.length - 2}
                                </button>
                              )}
                            </div>
                          ) : (
                            <div className="w-7 h-7 rounded-md bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-400 shrink-0">
                              <Package className="w-3.5 h-3.5" />
                            </div>
                          )}

                          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-mono text-[11px] font-semibold shrink-0">
                            {currentItem.sku || currentItem.code || 'ITEM'}
                          </span>

                          <span className="text-xs font-semibold text-slate-800 truncate max-w-[180px] sm:max-w-xs md:max-w-md" title={currentItem.name}>
                            {currentItem.name}
                          </span>

                          {rawUrl && (
                            <a
                              href={sanitizeExternalUrl(rawUrl)}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs text-indigo-600 hover:text-indigo-800 inline-flex items-center gap-0.5 shrink-0"
                              title="เปิดลิงก์สินค้าจริง"
                            >
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}

                          <button
                            onClick={() => handleCopyText(currentItem.name, 'item')}
                            className="p-0.5 text-slate-400 hover:text-slate-600 rounded transition-colors cursor-pointer shrink-0"
                            title="คัดลอกชื่อสินค้า"
                          >
                            {copiedCode === currentItem.name ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                          </button>

                          {currentItem.orderRefNo && (
                            <span className="text-[10px] text-purple-700 font-bold bg-purple-50 px-1.5 py-0.2 rounded border border-purple-200 shrink-0">
                              Ref: {currentItem.orderRefNo}
                            </span>
                          )}

                          {/* Col 2 (Dispute / Settlement Tag) */}
                          {(() => {
                            const storeClaim = po?.storeClaims?.[group.storeKey] || group.claimData || Object.entries(po?.storeClaims || {}).find(([k]) => k.toLowerCase() === group.storeKey.toLowerCase())?.[1];
                            const isStoreSettled = Boolean(storeClaim?.isResolved || storeClaim?.status === 'RESOLVED' || isClosed || activeTab === 'CLOSED');
                            const effRefund = Number(currentItem.refundAmt || (storeClaim?.type === 'REFUND' ? storeClaim?.refundAmount : 0));

                            if (isStoreSettled && effRefund > 0 && (currentItem.refundAmt > 0 || currentItem.shortageQty > 0 || currentItem.damagedQty > 0 || currentItem.hasDispute || group.hasDispute || group.items.length === 1)) {
                              const timeStr = storeClaim?.resolvedAt ? new Date(storeClaim.resolvedAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : '';
                              return (
                                <span className="text-[11px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded font-medium shrink-0">
                                  ✓ ได้รับเงินคืน ฿{effRefund.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} เข้าแผนกแล้ว {timeStr ? `(${timeStr})` : ''}
                                </span>
                              );
                            }

                            const itemMetrics = calculateDisputeMetrics(currentItem, po?.status, poHasGRN);
                            const itemShortage = itemMetrics.shortageQty > 0 ? itemMetrics.shortageQty : (Number(currentItem.shortageQty) > 0 ? Number(currentItem.shortageQty) : 0);
                            const itemDamaged = itemMetrics.damagedQty > 0 ? itemMetrics.damagedQty : (Number(currentItem.damagedQty) > 0 ? Number(currentItem.damagedQty) : 0);
                            const itAction = currentItem.shortageAction || (currentItem.shortageReason === 'SPLIT_SHIPMENT' ? 'WAIT_NEXT_ROUND' : (currentItem.disputeAction === 'WAIT_NEXT_ROUND' ? 'WAIT_NEXT_ROUND' : ''));
                            const isWait = itAction === 'WAIT_NEXT_ROUND' || itemMetrics.isWaitingNextRound;

                            if (isClaimOrder) {
                              const isItemDisputed = itemMetrics.hasDispute;
                              if (!isItemDisputed) return null;
                              return (
                                <div className="flex items-center gap-1.5 shrink-0 font-sans">
                                  {itemShortage > 0 && !isWait && (
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-bold bg-rose-50 text-rose-700 border border-rose-200 shrink-0">
                                      🚨 ขาด {itemShortage} {pUnit}
                                    </span>
                                  )}
                                  {itemDamaged > 0 && (
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-bold bg-amber-50 text-amber-800 border border-amber-200 shrink-0">
                                      ⚠️ ชำรุด {itemDamaged} {pUnit}
                                    </span>
                                  )}
                                </div>
                              );
                            }

                            // Directive 3: ในแท็บ "สั่งซื้อแล้ว" (ORDERED) หรือแท็บอื่นๆ
                            if (isWait && itemShortage > 0) {
                              return (
                                <div className="flex items-center gap-1.5 shrink-0 font-sans">
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-bold bg-amber-50 text-amber-800 border border-amber-200 shrink-0">
                                    ⏳ รอส่งมอบเพิ่ม {itemShortage} {pUnit}
                                  </span>
                                </div>
                              );
                            }

                            return null;
                          })()}
                        </div>

                        {/* Col 3: ฝั่งขวา Monospace Equation */}
                        {isClaimOrder && (() => {
                          const itemMetrics = calculateDisputeMetrics(currentItem, po?.status, poHasGRN);
                          const isItemDisputed = itemMetrics.hasDispute;

                          if (isItemDisputed) {
                            return (
                              <div className="text-right shrink-0">
                                <div className="text-[10px] text-slate-400 font-medium">มูลค่าที่ต้องเคลม</div>
                                <div className="text-xs sm:text-sm font-mono font-bold text-rose-600">
                                  ฿{formatMoney(itemMetrics.claimableAmount)}
                                </div>
                              </div>
                            );
                          }
                          return (
                            <div className="flex items-center gap-2 shrink-0 font-mono text-xs text-slate-600">
                              <span>
                                {pQty.toLocaleString()} {pUnit} × ฿{formatMoney(price)} =
                              </span>
                              <strong className="text-slate-800 font-bold min-w-[75px] text-right">
                                ฿{formatMoney(lineTotal)}
                              </strong>
                            </div>
                          );
                        })()}
                        {!isClaimOrder && (
                          <div className="flex items-center gap-2 shrink-0 font-mono text-xs text-slate-600">
                            <span>
                              {pQty.toLocaleString()} {pUnit} × ฿{formatMoney(price)} =
                            </span>
                            <strong className="text-slate-800 font-bold min-w-[75px] text-right">
                              ฿{formatMoney(lineTotal)}
                            </strong>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {isClaimOrder && group.hasDispute && !isStoreClaimActive && !isStoreResolved && !isClosed && (
                <div className="p-3 bg-white border-t border-slate-100 flex justify-end">
                  <button 
                    type="button"
                    onClick={() => setStoreClaimStates(prev => ({ ...prev, [group.storeKey]: { ...prev[group.storeKey], showResolutionForm: true } }))} 
                    className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 px-3 py-1.5 rounded-lg border border-rose-200 cursor-pointer transition-colors"
                  >
                    <AlertTriangle className="w-3.5 h-3.5" /> จัดการผลการเคลมเฉพาะร้านค้านี้
                  </button>
                </div>
              )}

              {/* If in CLAIM tab and group has no dispute, but user opened it to claim or it's waiting replacement */}
              {activeTab === 'CLAIM' && !group.hasDispute && !isStoreResolved && group.status !== 'RESOLVED' && !isStoreClaimActive && !isClosed && (() => {
                const remainingQty = group.items.reduce((sum, item) => sum + Math.max(0, Number(item.orderedQty ?? item.actualQty ?? item.purchaseQty ?? item.quantity ?? 0) - Number(item.accumulatedReceived ?? item.goodQty ?? item.receivedQty ?? 0)), 0);
                const storeClaim = po?.storeClaims?.[group.storeKey] || group.claimData || Object.entries(po?.storeClaims || {}).find(([k]) => k.toLowerCase() === group.storeKey.toLowerCase())?.[1];
                const isWaitingReplacement = group.status === 'WAITING_REPLACEMENT' || storeClaim?.status === 'WAITING_REPLACEMENT' || storeClaim?.claimStatus === 'RESOLVED_REPLACEMENT';
                
                return (
                  <div className="p-3 bg-white border-t border-slate-100 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 text-xs text-slate-500">
                    {isWaitingReplacement ? (
                      <span className="font-semibold text-amber-700">📦 อยู่ระหว่างรอร้านค้าจัดส่งสินค้าทดแทน (ค้างรับ {remainingQty} รายการ)</span>
                    ) : (
                      <span>{remainingQty > 0 ? `ร้านนี้ยังมีสินค้าค้างรับ ${remainingQty} รายการ หากพบปัญหาสามารถกดเปิดดำเนินการเคลมได้` : 'ร้านนี้ตรวจรับครบสมบูรณ์แล้ว หากต้องการแจ้งปัญหาหรือเคลม สามารถกดเปิดดำเนินการเคลมได้'}</span>
                    )}
                    
                    {!isWaitingReplacement && (
                      <button 
                        type="button"
                        onClick={() => {
                          setStoreClaimStates(prev => ({ 
                            ...prev, 
                            [group.storeKey]: { 
                              ...prev[group.storeKey], 
                              showResolutionForm: true, 
                              isManualDispute: true 
                            } 
                          }));
                        }} 
                        className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 px-3 py-1.5 rounded-lg border border-rose-200 cursor-pointer transition-colors shrink-0"
                      >
                        <AlertTriangle className="w-3.5 h-3.5" /> เปิดดำเนินการเคลมสำหรับร้านนี้
                      </button>
                    )}
                  </div>
                );
              })()}
              
              {isStoreClaimActive && !isStoreResolved && (() => {
                const currentResolutionType = storeClaimState.claimResolutionType || group.claimData?.type || 'REFUND';
                const effectiveDefaultRefund = group.defaultRefund !== undefined ? group.defaultRefund : 0;
                // WRITE_OFF จงใจ = 0 เสมอ ห้ามแก้ไข
                const currentRefundAmount = currentResolutionType === 'WRITE_OFF'
                  ? 0
                  : storeClaimState.refundAmount !== undefined 
                    ? storeClaimState.refundAmount 
                    : (currentResolutionType === 'CANCEL' 
                        ? group.totalAmount 
                        : (effectiveDefaultRefund > 0 
                            ? (Math.round(effectiveDefaultRefund * 100) / 100) 
                            : (group.claimData?.refundAmount !== undefined ? group.claimData.refundAmount : 0)));
                const currentTrackingNo = storeClaimState.newTrackingNo !== undefined 
                  ? storeClaimState.newTrackingNo 
                  : (group.claimData?.replacementTrackingNo || group.claimData?.newTrackingNo || '');
                const currentClaimNote = storeClaimState.claimNote !== undefined 
                  ? storeClaimState.claimNote 
                  : (group.claimData?.note || '');

                return (
                  <div className="p-3 bg-white border-t border-slate-100">
                    {/* 4. กล่องหลักฐานจากหน้างาน (GRN Evidence Panel) เหนือแผงเครื่องมือเจรจา */}
                    {(() => {
                      const evData = resolveGRNEvidence(po, group);
                      if (!evData) return null;
                      return (
                        <div className="mb-3 p-3.5 bg-amber-50/70 border border-amber-200/90 rounded-xl space-y-2.5">
                          <div className="flex items-center justify-between gap-2 flex-wrap text-xs">
                            <div className="flex items-center gap-1.5 font-bold text-amber-950">
                              <span>📌 รายงานจาก:</span>
                              <span className="text-slate-800 font-semibold">{evData.inspectorName}</span>
                              <span className="text-amber-800/80 font-normal font-mono">({evData.inspectedAt})</span>
                            </div>
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-amber-100/90 text-amber-900 border border-amber-300/60 text-[11px] font-semibold">
                              <AlertTriangle className="w-3.5 h-3.5 text-amber-700 shrink-0" />
                              หลักฐานการตรวจรับ (GRN Evidence)
                            </span>
                          </div>

                          {/* แสดงหมายเหตุอาการชำรุด ในกล่องข้อความสีขาวอ่านง่าย */}
                          {evData.defectNote && (
                            <div className="p-2.5 bg-white border border-amber-200/80 rounded-lg text-xs text-slate-800 shadow-2xs">
                              <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                                หมายเหตุอาการชำรุด / ปัญหาที่พบ
                              </div>
                              <p className="whitespace-pre-wrap break-words font-medium text-slate-700 leading-relaxed">
                                {evData.defectNote}
                              </p>
                            </div>
                          )}

                          {/* แสดงแกลเลอรีรูปภาพ: แสดงรูปภาพ Thumbnail ที่ผู้ตรวจรับแนบมา */}
                          {evData.images && evData.images.length > 0 ? (
                            <div>
                              <div className="text-[11px] font-semibold text-slate-600 mb-1.5 flex items-center gap-1">
                                <ImageIcon className="w-3.5 h-3.5 text-amber-700" />
                                <span>รูปภาพหลักฐานความเสียหาย ({evData.images.length} รูป) — คลิกเพื่อดูรูปขนาดเต็ม</span>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {evData.images.map((img, imgIdx) => {
                                  const driveSrc = resolveDriveImageUrl(img.url);
                                  return (
                                    <div
                                      key={img.id || imgIdx}
                                      onClick={() => openLightbox(evData.images, imgIdx, `หลักฐานความเสียหาย: ${po?.poNo || po?.id} (ร้าน ${group.storeName || group.storeKey})`)}
                                      className="relative group w-16 h-16 sm:w-20 sm:h-20 rounded-lg border border-amber-200 bg-white overflow-hidden cursor-pointer shadow-2xs hover:shadow-md hover:border-amber-400 transition-all"
                                      title="คลิกเพื่อดูภาพขนาดเต็มและบันทึกรูปไปยื่นเคลมบน Shopee/Lazada"
                                    >
                                      <img
                                        src={driveSrc}
                                        alt={img.name || 'รูปหลักฐาน'}
                                        onError={handleDriveImageError}
                                        className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                                        loading="lazy"
                                      />
                                      <div className="absolute inset-0 bg-black/35 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                        <Eye className="w-4 h-4 text-white drop-shadow" />
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ) : (
                            <div className="text-[11px] text-slate-400 italic">
                              (ไม่มีรูปภาพแนบจากฟอร์มตรวจรับ)
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Unified Quick Settlement Action Bar (Modern Linear SaaS Style) */}
                    <div className="bg-slate-50/80 p-2.5 rounded-xl border border-slate-200/70">
                      <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 text-xs">
                        {/* Dropdown แนวทางแก้ไข */}
                        <select 
                          value={currentResolutionType} 
                          onChange={e => {
                            const val = e.target.value;
                            setStoreClaimStates(prev => ({
                              ...prev,
                              [group.storeKey]: {
                                ...prev[group.storeKey],
                                claimResolutionType: val,
                                refundAmount: val === 'REFUND'
                                  ? (prev[group.storeKey]?.refundAmount !== undefined ? prev[group.storeKey]?.refundAmount : effectiveDefaultRefund)
                                  : val === 'CANCEL'
                                    ? group.totalAmount
                                    : 0  // WRITE_OFF, REPLACEMENT = ไม่มีเงินคืน
                              }
                            }));
                          }}
                          className="h-8 px-2.5 rounded-lg border border-slate-200 bg-white font-medium text-slate-700 focus:border-indigo-500 shadow-2xs shrink-0 cursor-pointer"
                        >
                          <option value="REFUND">💰 คืนเงิน (Refund)</option>
                          <option value="REPLACEMENT">📦 ส่งของใหม่ชดเชย (Replacement)</option>
                          <option value="WRITE_OFF">✏️ ตัดจำหน่าย/ยกเว้นเคลม (Write-off)</option>
                          <option
                              value="CANCEL"
                              disabled={Boolean(po?.hasGRN || po?.grNumber || po?.grId || po?.grnNumber || (Array.isArray(po?.grnHistory) && po.grnHistory.length > 0) || po?.receivedAt || (Array.isArray(po?.items) && po.items.some(it => it.receivedQty !== undefined && it.receivedQty !== null && Number(it.receivedQty) > 0)))}
                              title={(po?.hasGRN || po?.grNumber || po?.grId || po?.grnNumber || (Array.isArray(po?.grnHistory) && po.grnHistory.length > 0) || po?.receivedAt || (Array.isArray(po?.items) && po.items.some(it => it.receivedQty !== undefined && Number(it.receivedQty) > 0))) ? 'ไม่สามารถใช้ได้: มีการรับของเข้าคลังแล้ว (GRN)' : 'ยกเลิกทั้งใบสั่งซื้อ (Full Cancellation)'}
                            >❌ ยกเลิกรายการ</option>
                        </select>

                        {/* ฟิลด์ตามเงื่อนไข (Conditional Input) */}
                        {/* WRITE_OFF: แสดง read-only badge ฿0.00 พร้อมข้อความช่วยเหลือ */}
                        {currentResolutionType === 'WRITE_OFF' && (
                          <div className="flex items-center gap-2 shrink-0">
                            <div className="flex items-center gap-1.5 h-8 px-3 bg-slate-100 border border-slate-200 rounded-lg shadow-2xs">
                              <span className="text-slate-400 font-mono text-xs">฿</span>
                              <span className="font-mono font-bold text-slate-400 text-xs">0.00</span>
                            </div>
                            <span className="text-[10px] text-slate-400 italic leading-tight max-w-[180px]">
                              ไม่ได้รับเงินคืน — ปิดเคสทันที
                            </span>
                          </div>
                        )}
                        {/* REFUND / CANCEL: แสดงช่องกรอกยอดเงินและปุ่มคืนเต็มจำนวน */}
                        {(currentResolutionType === 'REFUND' || currentResolutionType === 'CANCEL') && (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <div className="relative w-28 shrink-0">
                              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 font-mono text-xs">฿</span>
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={currentRefundAmount ?? ''}
                                onChange={e => setStoreClaimStates(prev => ({
                                  ...prev,
                                  [group.storeKey]: { ...prev[group.storeKey], refundAmount: e.target.value }
                                }))}
                                placeholder="0.00"
                                className="h-8 w-full pl-5 pr-2 text-right font-mono font-bold text-slate-800 bg-white border border-slate-200 rounded-lg focus:border-indigo-500 shadow-2xs"
                                title="ยอดเงินคืนจริง"
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => setStoreClaimStates(prev => ({
                                ...prev,
                                [group.storeKey]: {
                                  ...prev[group.storeKey],
                                  refundAmount: currentResolutionType === 'CANCEL' ? group.totalAmount : effectiveDefaultRefund
                                }
                              }))}
                              className="h-8 px-2 text-[11px] font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 rounded-lg border border-indigo-200 transition-colors whitespace-nowrap cursor-pointer shadow-2xs"
                              title="คลิกเพื่อกรอกยอดคืนเต็มจำนวน"
                            >
                              คืนเต็มจำนวน
                            </button>
                          </div>
                        )}

                        {currentResolutionType === 'REPLACEMENT' && (
                          <input
                            type="text"
                            placeholder="ระบุเลขพัสดุชดเชย (ถ้ามี)..."
                            value={currentTrackingNo}
                            onChange={e => setStoreClaimStates(prev => ({
                              ...prev,
                              [group.storeKey]: { ...prev[group.storeKey], newTrackingNo: e.target.value }
                            }))}
                            className="h-8 px-2.5 flex-1 min-w-[150px] bg-white border border-slate-200 rounded-lg text-slate-700 placeholder:text-slate-400 focus:border-indigo-500 shadow-2xs font-mono"
                          />
                        )}

                        {/* ช่องบันทึกความคืบหน้า */}
                        <input
                          type="text"
                          placeholder="บันทึกช่วยจำ (เช่น ทักแชทร้านค้าแล้ว)..."
                          value={currentClaimNote}
                          onChange={e => setStoreClaimStates(prev => ({
                            ...prev,
                            [group.storeKey]: { ...prev[group.storeKey], claimNote: e.target.value }
                          }))}
                          className="h-8 px-2.5 flex-1 min-w-[180px] bg-white border border-slate-200 rounded-lg text-slate-700 placeholder:text-slate-400 focus:border-indigo-500 shadow-2xs"
                        />

                        {/* ปุ่มบันทึก */}
                        <button
                          type="button"
                          onClick={() => handleResolveStoreClaim(group.storeKey)}
                          disabled={isSubmitting}
                          className="h-8 px-3.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold flex items-center justify-center shadow-xs transition-colors shrink-0 whitespace-nowrap cursor-pointer disabled:opacity-50"
                        >
                          <span>✓ บันทึกผลเจรจา</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>

      {/* ── 3. Smart Financial Summary Footer for Pending Orders (Mode 1: Directive 3) ── */}
      {isPending && (
        <div className="mt-3 border-t border-slate-200/80 bg-slate-50/80 -mx-5 -mb-5 px-4 py-2.5 rounded-b-2xl flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          {/* Left: 3 Financial Metrics */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="flex items-center gap-1.5 font-medium text-slate-600">
              <span className="text-slate-500">งบประเมิน PR:</span>
              <span className="font-mono font-bold text-slate-700">
                ฿{formatMoney(originalTotalAmount)}
              </span>
            </div>

            <span className="text-slate-300 select-none hidden sm:inline">•</span>

            <div className="flex items-center gap-1.5 font-medium text-slate-800">
              <span className="text-slate-600">ยอดสั่งซื้อจริง:</span>
              <span className="font-mono font-bold text-slate-950 text-xs sm:text-sm">
                ฿{formatMoney(totalEstimatedAmount)}
              </span>
            </div>

            <span className="text-slate-300 select-none hidden sm:inline">•</span>

            {/* ส่วนต่างงบประมาณ Badge */}
            <div>
              {priceDiff < 0 ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-bold shadow-2xs">
                  🎉 ประหยัดงบได้ ฿{formatMoney(Math.abs(priceDiff))}
                </span>
              ) : priceDiff > 0 ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-200 text-xs font-bold shadow-2xs">
                  ⚠️ เกินงบ ฿{formatMoney(priceDiff)}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 border border-slate-200 text-xs font-medium">
                  ✓ ตรงตามงบประเมิน
                </span>
              )}
            </div>
          </div>

          {/* Right: Main Confirm Button (Unlocked when store name is filled for all stores) */}
          <div className="flex flex-col sm:flex-row items-end sm:items-center gap-2 shrink-0">
            {!isAllStoresFilled && (
              <span className="text-[11px] text-amber-600 font-medium text-right">
                * ระบุชื่อร้านค้าจริงให้ครบ
              </span>
            )}
            {hasInvalidQty && (
              <span className="text-[11px] text-rose-600 font-medium text-right">
                * ระบุจำนวนให้เป็นจำนวนเต็มบวก
              </span>
            )}
            <button
              type="button"
              onClick={handleAcknowledgeAndOrder}
              disabled={!isConfirmReady}
              className={`h-8 px-3.5 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
                !isConfirmReady
                  ? 'bg-slate-200 text-slate-400 cursor-not-allowed border border-slate-300/60 shadow-none'
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs hover:shadow active:scale-[0.98] cursor-pointer'
              }`}
              title={
                !isAllStoresFilled
                  ? 'กรุณาระบุชื่อร้านค้าจริงให้ครบทุกร้านก่อนยืนยัน'
                  : hasInvalidQty
                  ? 'กรุณาระบุจำนวนสินค้าให้เป็นจำนวนเต็มบวก (อย่างน้อย 1)'
                  : hasInvalidPrice
                  ? 'กรุณาระบุราคาซื้อจริงให้ถูกต้อง'
                  : 'ยืนยันบันทึกการสั่งซื้อสินค้าออนไลน์'
              }
            >
              <Check className="w-3.5 h-3.5" />
              <span>
                {isSubmitting
                  ? 'กำลังบันทึก...'
                  : `ยืนยันการสั่งซื้อแล้ว (${items.length} รายการ)`}
              </span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* ── 3.2 Reconciliation Footer for Closed Orders (Directive 2) ── */}
      {(activeTab === 'CLOSED' || isClosed) && !isPending && (
        <div className="mt-2.5 px-3 py-1.5 bg-slate-50/90 rounded-xl border border-slate-200/80 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-2 font-mono">
            <span className="text-slate-500">งบเดิม ฿{formatMoney(rawOriginalBudget)}</span>
            <span className="text-slate-300">→</span>
            <span className="font-bold text-slate-800">จ่ายจริง ฿{formatMoney(actualTotalValue)}</span>
            {totalRefundedValue > 0 ? (
              <span className="font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                +คืนงบ ฿{formatMoney(totalRefundedValue)}
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-1.5 text-emerald-700 shrink-0 font-semibold text-xs">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
            <span>ปิดงานสำเร็จ 100%</span>
          </div>
        </div>
      )}

      {/* ── 4. Compact Micro-Footer ── */}
      <div className={`pt-2 mt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 text-xs ${
        isPending ? '' : 'border-t border-slate-100'
      }`}>
        <div className="flex items-center gap-2 text-slate-400 min-w-0">
          <span className="truncate text-[11px]">
            🕒 ล่าสุด: {latestActivityText}
          </span>
          {Array.isArray(po.activityLog) && po.activityLog.length > 0 && (
            <button
              type="button"
              onClick={() => setIsHistoryExpanded(!isHistoryExpanded)}
              className="text-indigo-600 hover:text-indigo-700 font-semibold text-[11px] inline-flex items-center gap-0.5 shrink-0 cursor-pointer"
            >
              <span>{isHistoryExpanded ? 'ย่อประวัติ' : 'ดูประวัติ'}</span>
              {isHistoryExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          )}
        </div>

        <div className="flex items-center gap-2.5 shrink-0 self-end sm:self-auto">
          {hasOnlineUrl && (
            <a
              href={sanitizeExternalUrl(po.onlineUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-600 hover:text-indigo-700 font-semibold text-xs inline-flex items-center gap-1 hover:underline"
            >
              <ExternalLink className="w-3 h-3" />
              <span>ลิงก์คำขอซื้อ</span>
            </a>
          )}

          {po.specUrl && onViewAttachment && (
            <button
              type="button"
              onClick={() => onViewAttachment({ name: 'เอกสาร/สเปกสินค้า', url: po.specUrl, type: 'link' })}
              className="text-slate-500 hover:text-slate-800 text-xs inline-flex items-center gap-1 cursor-pointer"
            >
              <FileText className="w-3 h-3" />
              <span>สเปก</span>
            </button>
          )}

          {onShowDetails && (
            <button
              type="button"
              onClick={() => onShowDetails(po)}
              className="text-slate-600 hover:text-indigo-600 font-semibold text-xs inline-flex items-center gap-0.5 cursor-pointer"
            >
              <span>เปิดดู PO ฉบับเต็ม</span>
              <span className="font-sans">↗</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setIsCardExpanded(false)}
            className="text-slate-400 hover:text-slate-600 text-xs inline-flex items-center gap-0.5 cursor-pointer border-l border-slate-200 pl-2 ml-1"
            title="ย่อการ์ดนี้"
          >
            <span>ย่อการ์ด</span>
            <ChevronUp className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Expanded Timeline (If toggled) */}
      {isHistoryExpanded && po.activityLog && po.activityLog.length > 0 && (
        <div className="mt-3 pt-2.5 border-t border-slate-100">
          <CollapsibleActivityTimeline
            events={po.activityLog}
            title="ประวัติการดำเนินงานคำสั่งซื้อ"
            defaultExpanded={true}
          />
        </div>
      )}

      {/* PR Attachments Modal (Phase 3 Directive 2) */}
      {prDocsModalOpen && (
        <div 
          className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-xs animate-fade-in"
          onClick={() => setPrDocsModalOpen(false)}
        >
          <div 
            className="bg-white border border-slate-200 rounded-2xl shadow-xl w-full max-w-lg overflow-hidden animate-scale-up"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-5 py-4 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600">
                  <Paperclip className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    เอกสารแนบ PR: {po.prNo || po.prNumber}
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    มีเอกสารและไฟล์แนบทั้งหมด {prDocs.length} รายการ
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPrDocsModalOpen(false)}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 rounded-xl transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Document list */}
            <div className="p-5 max-h-[60vh] overflow-y-auto space-y-2.5 divide-y divide-slate-100">
              {prDocs.map((doc, dIdx) => {
                const isPdf = doc.type === 'application/pdf' || doc.category === 'QUOTATION' || String(doc.name || doc.url).toLowerCase().endsWith('.pdf');
                const isImage = !isPdf && (doc.type?.startsWith('image/') || doc.category === 'IMAGE' || doc.category === 'GENERAL' || String(doc.name || doc.url).match(/\.(jpeg|jpg|png|gif|webp|svg)($|\?)/i));
                
                return (
                  <div key={dIdx} className="pt-2.5 first:pt-0 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${
                        isPdf ? 'bg-rose-50 border-rose-100 text-rose-600' : 'bg-indigo-50 border-indigo-100 text-indigo-600'
                      }`}>
                        {isPdf ? <FileText className="w-4 h-4" /> : <ImageIcon className="w-4 h-4" />}
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-slate-800 truncate" title={doc.name}>
                          {doc.name}
                        </p>
                        <div className="flex items-center gap-1.5 text-[10px] text-slate-400">
                          <span className={`px-1.5 py-0.2 rounded font-medium ${
                            doc.category === 'QUOTATION' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-600'
                          }`}>
                            {doc.category === 'QUOTATION' ? 'ใบเสนอราคา' : 'เอกสารประกอบรวม'}
                          </span>
                          {doc.size ? <span>• {(doc.size / 1024).toFixed(1)} KB</span> : null}
                        </div>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          if (isImage) {
                            openLightbox([doc], 0, doc.name);
                          } else if (onViewAttachment) {
                            onViewAttachment(doc);
                          } else {
                            setViewingDoc(doc);
                          }
                        }}
                        className="px-2.5 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 rounded-lg border border-indigo-200 transition-colors inline-flex items-center gap-1 cursor-pointer"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span>เปิดดู</span>
                      </button>

                      {doc.url && (
                        <a
                          href={doc.url}
                          download={doc.name || 'document'}
                          target="_blank"
                          rel="noreferrer"
                          className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
                          title="ดาวน์โหลดไฟล์"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 flex justify-end">
              <button
                type="button"
                onClick={() => setPrDocsModalOpen(false)}
                className="px-4 py-1.5 bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-semibold rounded-xl transition-colors cursor-pointer"
              >
                ปิดหน้าต่าง
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Viewing Doc in AttachmentViewerModal if non-image */}
      {viewingDoc && (
        <AttachmentViewerModal
          file={viewingDoc}
          url={viewingDoc.url}
          title={viewingDoc.name}
          onClose={() => setViewingDoc(null)}
        />
      )}

      {/* Lightbox Modal (Phase 3 Directive 3) */}
      <ImageLightboxModal
        isOpen={lightboxState.isOpen}
        images={lightboxState.images}
        initialIndex={lightboxState.initialIndex}
        title={lightboxState.title}
        onClose={closeLightbox}
      />

      {/* Loading Overlay — บล็อกหน้าจอขณะบันทึกผลเจรจาเคลม */}
      <LoadingOverlay
        isVisible={isSaving}
        message="กำลังบันทึกผลการเจรจาเคลมสินค้า..."
      />
    </div>
  );
}
