import React from 'react';
import { storageService } from '../../services/storageService.js';
import { SC_LOGO_BASE64 } from '../../utils/logoBase64.js';

/**
 * Thai Unicode Text Normalizer
 * Enforces NFC normalization and fixes any misordered tone marks/vowels
 */
function cleanThaiText(rawText) {
  if (rawText === null || rawText === undefined) return '';
  let text = String(rawText).normalize('NFC');
  text = text.replace(/([\u0E48-\u0E4C])([\u0E31\u0E34-\u0E37\u0E47\u0E4D])/g, '$2$1');
  text = text.replace(/([\u0E31\u0E34-\u0E37\u0E47\u0E4D])\1+/g, '$1');
  text = text.replace(/([\u0E48-\u0E4C])\1+/g, '$1');
  return text;
}

import { formatThaiDateTime, formatDocDateTime } from '../../utils/formatters.js';
export { formatThaiDateTime, formatDocDateTime };

export default function PrintablePO({ po }) {
  if (!po) return null;

  let prData = null;
  try {
    const prs = storageService.getPRs();
    prData = prs.find(p => p.id === po.prId || p.prNo === po.prNo);
  } catch { }

  let users = [];
  try {
    users = storageService.getUsers() || [];
  } catch { }

  const reviewedLog = Array.isArray(prData?.approvalHistory)
    ? prData.approvalHistory.find(h => h.action === 'REVIEWED')
    : null;

  const approvedLog = Array.isArray(prData?.approvalHistory)
    ? prData.approvalHistory.find(h => h.action === 'APPROVED')
    : null;

  const requesterUser = users.find(u =>
    u.name === (po.requestedBy || prData?.requestedBy) ||
    u.employeeName === (po.requestedBy || prData?.requestedBy) ||
    u.displayName === (po.requestedBy || prData?.requestedBy) ||
    u.id === (po.requesterId || prData?.requesterId) ||
    (po.department === 'QC' ? u.roleId === 'REQUESTER_QC' : u.roleId === 'REQUESTER')
  );
  let requesterName = po.createdBy || po.createdByName || po.requesterName || po.requestedBy || prData?.requestedBy || requesterUser?.employeeName || requesterUser?.name || 'คุณวิชัย สุขใจ';
  if (requesterName === 'Admin System') {
    requesterName = po.department === 'QC' ? 'คุณสมหญิง รักดี' : 'คุณวิชัย สุขใจ';
  }
  const requesterSig = po.requesterSignature ||
    prData?.requesterSignature ||
    requesterUser?.signature ||
    storageService.getSignatureByRole?.(po.department === 'QC' ? 'REQUESTER_QC' : 'REQUESTER_PD')?.signatureUrl ||
    null;

  // ดึงเวลาเปิด PR จาก Log แรก หรือ submittedAt / createdAt ของ PR
  const submitLog = Array.isArray(prData?.approvalHistory)
    ? prData.approvalHistory.find(h => h.action === 'SUBMITTED' || h.action === 'CREATED')
    : null;

  // ดึงเวลาของ PR เท่านั้น ห้ามดึง po.createdAt หรือ approverDate มาทับ
  const requesterDate = submitLog?.timestamp || 
                        prData?.submittedAt || 
                        prData?.createdAt || 
                        prData?.date || 
                        po.prCreatedAt || 
                        '';

  const isReviewed = Boolean(
    po.reviewedAt ||
    po.reviewerName ||
    po.reviewerSignature ||
    prData?.reviewedBy ||
    reviewedLog ||
    ['REVIEWED', 'APPROVED', 'PO_ISSUED', 'IN_PROGRESS_ONLINE', 'CLOSED', 'COMPLETED'].includes(String(prData?.status || '').toUpperCase())
  );

  const reviewerUser = users.find(u =>
    u.id === prData?.reviewedBy?.id ||
    u.roleId === 'ASST_MANAGER' ||
    u.positionKey === 'REVIEWER' ||
    u.name === 'คุณสมชาย (Asst. Mgr)' ||
    u.employeeName === 'คุณสมชาย มุ่งมั่น'
  );

  let reviewerName = po.reviewerName ||
    (prData?.reviewedBy && typeof prData.reviewedBy === 'object' ? prData.reviewedBy.name : null) ||
    (typeof po.reviewedBy === 'string' && po.reviewedBy !== 'Admin System' ? po.reviewedBy : null) ||
    reviewedLog?.actorName ||
    (isReviewed ? 'คุณสมชาย มุ่งมั่น' : '');
  if (!reviewerName || reviewerName === 'Admin System') {
    reviewerName = isReviewed ? 'คุณสมชาย มุ่งมั่น' : '';
  }

  const reviewerSig = po.reviewerSignature ||
    (prData?.reviewedBy && typeof prData.reviewedBy === 'object' ? prData.reviewedBy.signature : null) ||
    reviewerUser?.signature ||
    storageService.getSignatureByRole?.('ASST_MANAGER')?.signatureUrl ||
    null;

  const reviewerDate = po.reviewedAt ||
    (prData?.reviewedBy && typeof prData.reviewedBy === 'object' ? prData.reviewedBy.timestamp : null) ||
    reviewedLog?.date ||
    reviewedLog?.timestamp ||
    po.reviewedDate ||
    '';

  const isApproved = Boolean(
    po.approvedAt ||
    po.approvedBy ||
    po.approverName ||
    approvedLog ||
    ['APPROVED', 'PO_ISSUED', 'IN_PROGRESS_ONLINE', 'CLOSED', 'COMPLETED'].includes(String(po.status || prData?.status || '').toUpperCase())
  );

  const approverUser = users.find(u =>
    u.roleId === 'PLANT_MANAGER' ||
    u.positionKey === 'APPROVER' ||
    u.name === 'คุณประเสริฐ (Plant Mgr)' ||
    u.employeeName === 'คุณประเสริฐ ยิ่งยง'
  );

  let approverName = po.approvedBy || po.approverName || approvedLog?.actorName || approverUser?.employeeName || approverUser?.name || (isApproved ? 'คุณประเสริฐ ยิ่งยง' : '');
  if (approverName === 'Admin System') {
    approverName = 'คุณประเสริฐ ยิ่งยง';
  }

  const approverSig = po.approverSignature ||
    approverUser?.signature ||
    storageService.getSignatureByRole?.('PLANT_MANAGER')?.signatureUrl ||
    null;

  const approverDate = po.approvedAt || approvedLog?.timestamp || approvedLog?.date || po.createdAt || '';

  const isReceived = Boolean(
    po.receiverSignature ||
    po.receivedAt ||
    po.receiverName ||
    po.receivingInfo?.receivedAt ||
    po.receivingInfo?.receiverSignature ||
    ['COMPLETED', 'CLOSED', 'RECEIVED', 'PARTIALLY_RECEIVED', 'PARTIALLY_RECEIVED_IN_CLAIM', 'WAITING_DELIVERY_ROUND_2', 'ตรวจรับครบ', 'ปิดงาน'].includes(String(po.status || '').toUpperCase()) ||
    (Array.isArray(po.grnHistory) && po.grnHistory.length > 0)
  );

  const receiverUser = users.find(u =>
    (po.receivingInfo?.receiverId && u.id === po.receivingInfo.receiverId) ||
    (po.receiverId && u.id === po.receiverId) ||
    (po.receivedById && u.id === po.receivedById) ||
    (po.receivingInfo?.receiverName && (u.name === po.receivingInfo.receiverName || u.employeeName === po.receivingInfo.receiverName)) ||
    (po.receiverName && (u.name === po.receiverName || u.employeeName === po.receiverName)) ||
    (po.receivedBy && (u.name === po.receivedBy || u.employeeName === po.receivedBy))
  );

  let receiverName = po.receivingInfo?.receiverName ||
    po.receiverName ||
    po.receivedBy ||
    po.receiver?.name ||
    receiverUser?.employeeName ||
    receiverUser?.name ||
    '';
  if (receiverName === 'Admin System' || receiverName === 'System User') {
    receiverName = '';
  }

  const defaultReceiverSig = receiverUser?.signature ||
    storageService.getSignatureByRole?.(receiverUser?.roleId || 'REQUESTER_PD')?.signatureUrl ||
    storageService.getSignatures?.()?.[receiverUser?.roleId || 'REQUESTER_PD']?.signatureUrl ||
    null;

  const receiverSig = (po.receivingInfo?.receiverSignature && po.receivingInfo.receiverSignature.indexOf('/signatures/receiver-default.png') === -1)
    ? po.receivingInfo.receiverSignature
    : (po.receiverSignature && po.receiverSignature.indexOf('/signatures/receiver-default.png') === -1
        ? po.receiverSignature
        : (po.receiver?.signature || po.receiver?.signatureUrl || (isReceived ? (defaultReceiverSig || po.receivingInfo?.receiverSignature || po.receiverSignature || null) : null)));

  const receiverDate = po.receivingInfo?.receivedAt ||
    po.receivedAt ||
    po.receiver?.receivedAt ||
    po.receivedDate ||
    (po.grnHistory?.length > 0 ? po.grnHistory[po.grnHistory.length - 1].date : '') ||
    '';

  const calculatedItemsTotal = (po.items || []).reduce((sum, item) => {
    const q = Number(item.actualQty ?? item.qty ?? item.purchaseQty) || 0;
    const p = Number(item.actualPrice ?? item.price ?? item.unitPrice ?? item.estimatedPrice) || 0;
    return sum + (q * p);
  }, 0);

  const subtotal = calculatedItemsTotal > 0
    ? calculatedItemsTotal
    : ((po.financials?.subtotal !== undefined && Number(po.financials.subtotal) > 0)
      ? Number(po.financials.subtotal)
      : ((po.subtotal !== undefined && Number(po.subtotal) > 0) ? Number(po.subtotal) : 0));

  const hasVat = po.hasVat !== undefined
    ? Boolean(po.hasVat)
    : (po.financials?.hasVat !== undefined
      ? Boolean(po.financials.hasVat)
      : (po.financials?.vatMode ? po.financials.vatMode !== 'NONE' : Number(po.vat) > 0));

  const vatAmount = hasVat
    ? (po.financials?.vatAmount !== undefined
      ? Number(po.financials.vatAmount)
      : (po.vat !== undefined && Number(po.vat) > 0 ? Number(po.vat) : parseFloat((subtotal * 0.07).toFixed(2))))
    : 0;

  const grandTotal = hasVat ? parseFloat((subtotal + vatAmount).toFixed(2)) : subtotal;

  const hasSettlement = Boolean(
    po.settlementStatus === 'SETTLED' ||
    (po.actualTotalAmount !== undefined && po.actualTotalAmount !== null && po.actualTotalAmount !== '' && Number(po.actualTotalAmount) >= 0)
  );
  const actualTotal = hasSettlement ? Number(po.actualTotalAmount || 0) : grandTotal;
  const savingsAmount = hasSettlement
    ? (po.savingsAmount !== undefined ? Number(po.savingsAmount) : (grandTotal - actualTotal))
    : 0;

  // Online PO & Store Resolution (Directive 1 & 2)
  const isOnline = Boolean(
    po.purchaseChannel === 'ONLINE' || 
    po.orderType === 'ONLINE' ||
    po.channel === 'online'
  );

  const isOnlinePO = isOnline;

  const validItemStores = (po.items || [])
    .map(it => (it.actualStoreName || it.storeName || '').trim())
    .filter(name => name && !name.includes('ระบุร้านภายหลัง'));
  const distinctStores = Array.from(new Set(validItemStores));
  const distinctPlatforms = Array.from(new Set((po.items || []).map(it => (it.storePlatform || '').trim()).filter(Boolean)));

  const isMultiStoreOrPlatform = distinctStores.length > 1 || distinctPlatforms.length > 1;

  const cleanVendorPrefix = (str) => {
    if (!str) return '-';
    let val = String(str).trim();
    if (val.startsWith('ผู้จำหน่าย:')) {
      val = val.replace(/^ผู้จำหน่าย:\s*/, '');
    }
    return val || '-';
  };

  let resolvedVendorName = po.vendorName || po.vendorDetails?.name || '-';
  if (isOnline) {
    if (distinctStores.length === 1 && distinctPlatforms.length <= 1) {
      resolvedVendorName = distinctStores[0];
    } else if (isMultiStoreOrPlatform) {
      resolvedVendorName = 'ตลาดออนไลน์ Shopee / Lazada (สั่งซื้อออนไลน์หลายร้านค้า)';
    } else if (po.storeName && !po.storeName.includes('ระบุร้านภายหลัง')) {
      resolvedVendorName = po.storeName;
    } else if (po.vendorName && !po.vendorName.includes('ระบุร้านภายหลัง')) {
      resolvedVendorName = po.vendorName;
    } else {
      resolvedVendorName = 'ตลาดออนไลน์ Shopee / Lazada (สั่งซื้อออนไลน์หลายร้านค้า)';
    }
  }

  const displayVendorName = cleanVendorPrefix(
    isMultiStoreOrPlatform
      ? 'ตลาดออนไลน์ Shopee / Lazada (สั่งซื้อออนไลน์หลายร้านค้า)'
      : resolvedVendorName
  );

  return (
    <div
      className="font-sarabun text-slate-900 bg-white p-8 print:p-0 max-w-[210mm] print:max-w-none print:w-full mx-auto print:m-0 text-sm thai-doc-container"
      style={{
        fontFamily: "'TH Sarabun New', 'Sarabun', 'Prompt', 'Noto Sans Thai', -apple-system, BlinkMacSystemFont, sans-serif",
        letterSpacing: '0px',
        fontVariantLigatures: 'normal',
        fontFeatureSettings: '"liga" 1, "kern" 1',
        textRendering: 'optimizeLegibility',
        wordBreak: 'normal',
        overflowWrap: 'break-word',
        WebkitPrintColorAdjust: 'exact',
        printColorAdjust: 'exact',
      }}
    >
      {/* HEADER BLOCK: Clean Flow with generous line heights to prevent overlapping */}
      <div className="w-full mb-6 pb-4 border-b border-black">
        <div className="flex justify-between items-start">
          {/* Left Column: Logo + Company Info */}
          <div className="flex items-start gap-4">
            <img
              src={SC_LOGO_BASE64}
              alt="Logo"
              className="h-16 w-auto object-contain shrink-0 mt-1"
            />
            <div className="flex flex-col space-y-1.5">
              <h1 className="text-base font-bold text-slate-900 leading-normal">
                {cleanThaiText('บริษัท เศรษฐชล จำกัด (สำนักงานใหญ่)')}
              </h1>
              <p className="text-xs text-slate-700 leading-relaxed">
                {cleanThaiText('ที่อยู่ 225 หมู่ที่ 12 ถนนเทพารักษ์ ตำบลบางพลีใหญ่ อำเภอบางพลี จังหวัดสมุทรปราการ 10540')}
              </p>
              <p className="text-xs text-slate-700 leading-relaxed">
                {cleanThaiText('เลขประจำตัวผู้เสียภาษี (TAX ID):')} <span className="font-mono font-medium">0-10553-2104-63-7</span>
              </p>
              <div className="pt-1">
                <span className="text-sm font-bold text-blue-900 block leading-normal">
                  {cleanThaiText('ใบสั่งซื้อสินค้า / PURCHASE ORDER')}
                </span>
                <span className="text-xs text-slate-600 leading-relaxed block mt-0.5">
                  {cleanThaiText('อ้างอิงใบขอซื้อ (PR):')} <strong className="text-slate-900 font-mono">{po.prNumber || po.prId || '-'}</strong> | {cleanThaiText('แผนกผู้ขอ:')} <strong className="text-slate-900">{po.department || '-'}</strong>
                </span>
              </div>
            </div>
          </div>

          {/* Right Column: PO Number Box (Aligned to top) */}
          <div className="border border-black rounded p-2.5 bg-gray-50 shrink-0 w-52 text-xs leading-relaxed">
            <div className="flex justify-between mb-1">
              <span className="text-slate-600 font-medium">{cleanThaiText('เลขที่ PO:')}</span>
              <span className="font-mono font-bold text-slate-900">{po.id || po.poNumber}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600 font-medium">{cleanThaiText('วันที่ออก PO:')}</span>
              <span className="font-mono text-slate-800">{po.issuedDate || po.createdAt ? new Date(po.issuedDate || po.createdAt).toLocaleDateString('th-TH') : '2026-09-11'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* VENDOR DETAILS BLOCK: Clean Stacked Grid with Natural Flow */}
      <div className="mb-6 p-3 border border-black rounded bg-gray-50/50 text-xs leading-relaxed">
        <div className="font-bold text-slate-900 border-b border-black pb-1 mb-2 flex justify-between items-center">
          <span>{cleanThaiText('ข้อมูลคู่ค้า / ผู้จำหน่าย (Vendor Details)')}</span>
          <span className="font-mono font-normal text-slate-700">{cleanThaiText('รหัสผู้ขาย:')} {po.vendorCode || po.vendorDetails?.code || '-'}</span>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
          <div>
            <span className="font-medium text-slate-600">{cleanThaiText('ชื่อบริษัท/ร้านค้า:')}</span>{' '}
            <span className="text-slate-900 font-semibold break-words">
              {cleanThaiText(displayVendorName)}
            </span>
          </div>
          <div>
            <span className="font-medium text-slate-600">{cleanThaiText('ผู้ติดต่อ:')}</span>{' '}
            <span className="text-slate-800 break-words">{cleanThaiText(po.vendorDetails?.contactPerson || '-')}</span>
          </div>
          <div>
            <span className="font-medium text-slate-600">{cleanThaiText('เลขประจำตัวผู้เสียภาษี:')}</span>{' '}
            <span className="font-mono text-slate-800">{po.vendorDetails?.taxId || '-'}</span>
          </div>
          <div>
            <span className="font-medium text-slate-600">{cleanThaiText('โทรศัพท์:')}</span>{' '}
            <span className="font-mono text-slate-800">{po.vendorDetails?.phone || '-'}</span>
          </div>
          <div className="col-span-2">
            <span className="font-medium text-slate-600">{cleanThaiText('ที่อยู่:')}</span>{' '}
            <span className="text-slate-800 break-words leading-relaxed">{cleanThaiText(po.vendorDetails?.address || '-')}</span>
          </div>
        </div>
      </div>

      {/* Items Table */}
      <table 
        className="w-full border-collapse border border-black mb-6 po-items-table"
        style={{
          pageBreakInside: 'auto',
          breakInside: 'auto',
        }}
      >
        <thead
          className="table-header-group"
          style={{ display: 'table-header-group' }}
        >
          <tr className="bg-gray-100 break-inside-avoid print:break-inside-avoid" style={{ breakInside: 'avoid', pageBreakInside: 'avoid' }}>
            <th className="border border-black p-4 w-12 text-center">{cleanThaiText('ลำดับ')}<br />(No.)</th>
            <th className="border border-black p-4 w-24 text-center">{cleanThaiText('รหัสสินค้า')}<br />(Code)</th>
            <th className="border border-black p-4 text-left">{cleanThaiText('รายการสินค้า')}<br />(Description)</th>
            <th className="border border-black p-4 w-20 text-center">{cleanThaiText('จำนวน')}<br />(Qty)</th>
            <th className="border border-black p-4 w-24 text-right">{cleanThaiText('ราคา/หน่วย')}<br />(Unit Price)</th>
            <th className="border border-black p-4 w-32 text-right">{cleanThaiText('รวมเงิน (บาท)')}<br />(Amount)</th>
          </tr>
        </thead>
        <tbody style={{ display: 'table-row-group' }}>
          {(po.items || []).map((item, index) => {
            const itemQty = Number(item.originalPurchaseQty ?? item.orderedQty ?? item.qty ?? item.purchaseQty ?? item.actualQty) || 0;
            const itemPrice = Number(item.originalEstimatedPrice ?? item.price ?? item.unitPrice ?? item.actualPrice ?? item.estimatedPrice) || 0;
            const itemTotal = itemQty * itemPrice;

            return (
              <tr 
                key={item.id || item.sku || index}
                className="break-inside-avoid print:break-inside-avoid"
                style={{ breakInside: 'avoid', pageBreakInside: 'avoid' }}
              >
                <td className="border border-black p-4 text-center">{index + 1}</td>
                <td className="border border-black p-4 text-center font-mono text-sm">{cleanThaiText(item.code || item.sku || '-')}</td>
                <td className="border border-black p-4 break-words whitespace-normal text-xs leading-relaxed">
                  <div className="font-medium text-slate-900">{cleanThaiText(item.name)}</div>
                  {item.specification && (
                    <div className="text-[11px] text-slate-600 mt-0.5">{cleanThaiText(item.specification)}</div>
                  )}
                  {isOnline && (item.actualStoreName || item.storePlatform) && (
                    <div className="text-[11px] text-slate-500 font-sans italic mt-0.5">
                      [ช่องทาง: {item.storePlatform || 'ออนไลน์'} • ร้านค้า: {item.actualStoreName || '-'}]
                    </div>
                  )}
                </td>
                <td className="border border-black p-4 text-center">{itemQty} {cleanThaiText(item.unit || item.purchaseUnit || 'หน่วย')}</td>
                <td className="border border-black p-4 text-right font-mono">{itemPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td className="border border-black p-4 text-right font-mono">{itemTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              </tr>
            );
          })}

          {(po.items || []).length < 5 && Array.from({ length: 5 - (po.items || []).length }).map((_, i) => (
            <tr 
              key={`empty-${i}`}
              className="break-inside-avoid print:break-inside-avoid"
              style={{ breakInside: 'avoid', pageBreakInside: 'avoid' }}
            >
              <td className="border-x border-black p-4 h-8"></td>
              <td className="border-x border-black p-4"></td>
              <td className="border-x border-black p-4 break-words whitespace-normal text-xs leading-relaxed"></td>
              <td className="border-x border-black p-4"></td>
              <td className="border-x border-black p-4"></td>
              <td className="border-x border-black p-4"></td>
            </tr>
          ))}
          <tr className="break-inside-avoid print:break-inside-avoid" style={{ breakInside: 'avoid', pageBreakInside: 'avoid' }}>
            <td colSpan="6" className="border-t border-black"></td>
          </tr>
        </tbody>
      </table>

      {/* ── Atomic Financial & Signature Section (Page-Break Avoid Container) ── */}
      <div
        className="po-atomic-summary-signatures break-inside-avoid print:break-inside-avoid mt-4"
        style={{
          breakInside: 'avoid',
          pageBreakInside: 'avoid',
        }}
      >
        {/* Financial Summary Breakdown */}
        <div className="flex justify-between items-start my-3 text-xs">
          <div className="w-1/2 align-top text-slate-700 pr-4">
            <span className="font-semibold text-xs text-slate-900">{cleanThaiText('หมายเหตุ (Remarks):')}</span>
            <p className="mt-0.5 leading-relaxed text-[11px] text-slate-600">{cleanThaiText('1. โปรดระบุเลขที่ใบสั่งซื้อ (PO No.) ในเอกสารใบกำกับภาษีทุกครั้ง')}</p>
            <p className="leading-relaxed text-[11px] text-slate-600">{cleanThaiText('2. กรณีส่งมอบล่าช้ากว่ากำหนด บริษัทขอสงวนสิทธิ์ในการคิดค่าปรับตามระเบียบบริษัท')}</p>
            {po.note && (
              <p className="mt-1 text-slate-800 leading-relaxed font-medium break-words whitespace-normal text-[11px]">
                <strong>{cleanThaiText('ข้อความเพิ่มเติม: ')}</strong>{cleanThaiText(po.note)}
              </p>
            )}
          </div>
          <div className="flex justify-end pt-3.5 pb-1" style={{ paddingTop: '12px' }}>
            <div className="w-64 space-y-1 text-right">
              {/* แถว Subtotal & VAT: บังคับฟอนต์ 10px */}
              <div style={{ fontSize: '10px', lineHeight: '14px' }} className="flex justify-between items-center text-[10px] leading-tight text-slate-600">
                <span className="font-medium">{cleanThaiText('รวมมูลค่าสินค้า (Subtotal):')}</span>
                <span style={{ fontFamily: 'monospace' }} className="text-[10px] font-mono text-slate-800">
                  ฿{subtotal.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>

              <div style={{ fontSize: '10px', lineHeight: '14px' }} className="flex justify-between items-center text-[10px] leading-tight text-slate-600">
                <span className="font-medium">{cleanThaiText('ภาษีมูลค่าเพิ่ม 7% (VAT 7%):')}</span>
                <span style={{ fontFamily: 'monospace' }} className="text-[10px] font-mono text-slate-700">
                  {hasVat && vatAmount > 0
                    ? `฿${vatAmount.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : cleanThaiText('ไม่มี VAT (0%)')}
                </span>
              </div>

              {/* เส้นคั่นบาง */}
              <div style={{ borderTop: '1px solid #E2E8F0', margin: '3px 0' }} />

              {/* แถว Grand Total: บังคับฟอนต์ 11px ตัวหนา */}
              <div style={{ fontSize: '11px', lineHeight: '16px', fontWeight: 'bold' }} className="flex justify-between items-center text-[11px] leading-tight font-bold text-slate-900">
                <span>{cleanThaiText('ยอดเงินรวมสุทธิ (Grand Total):')}</span>
                <span style={{ fontFamily: 'monospace', color: '#047857' }} className="text-[11px] font-mono font-bold">
                  ฿{grandTotal.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Actual Settlement Summary Box (Rendered when PO has settled actual amount) */}
        {hasSettlement && (
          <div
            className="settlement-summary-box border border-emerald-600 bg-emerald-50/50 rounded p-2.5 my-3 break-inside-avoid print:break-inside-avoid text-xs"
            style={{ breakInside: 'avoid', pageBreakInside: 'avoid' }}
          >
            <div className="flex items-center justify-between font-bold text-emerald-900 border-b border-emerald-200 pb-1 mb-1.5">
              <span>{cleanThaiText('สรุปการตรวจรับและปิดยอดจ่ายจริง (Actual Settlement Summary)')}</span>
              {savingsAmount > 0 && (
                <span className="text-[11px] bg-emerald-700 text-white px-2 py-0.2 rounded font-sans font-medium">
                  {cleanThaiText('คืนงบประมาณแล้ว')}
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2 font-mono text-[11px] text-slate-800">
              <div>
                <span className="text-slate-500 block font-sans text-[10px]">{cleanThaiText('ยอดอนุมัติเดิม (Approved Total):')}</span>
                <span className="font-bold">฿{grandTotal.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
              <div>
                <span className="text-slate-500 block font-sans text-[10px]">{cleanThaiText('ยอดจ่ายจริง (Actual Payment):')}</span>
                <span className="font-bold text-emerald-800">฿{actualTotal.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              </div>
              <div>
                <span className="text-slate-500 block font-sans text-[10px]">{cleanThaiText('ส่วนต่างงบ (Savings / Variance):')}</span>
                <span className={`font-bold ${savingsAmount >= 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
                  {savingsAmount >= 0 ? '+' : ''}฿{savingsAmount.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            </div>
            {po.settlementNote && (
              <div className="mt-1.5 pt-1 border-t border-emerald-100 text-[10px] text-slate-600 font-sans">
                <strong>{cleanThaiText('หมายเหตุการปิดยอด: ')}</strong>{cleanThaiText(po.settlementNote)}
              </div>
            )}
          </div>
        )}

        {/* Electronic Approvals & Acknowledgement */}
        <table 
          className="w-full table-fixed border-collapse border border-black text-center mt-6 break-inside-avoid print:break-inside-avoid"
          style={{
            breakInside: 'avoid',
            pageBreakInside: 'avoid',
          }}
        >
          <thead>
            <tr className="bg-slate-50 border-b border-black break-inside-avoid print:break-inside-avoid" style={{ breakInside: 'avoid', pageBreakInside: 'avoid' }}>
              {[
                { role: 'ผู้ขอซื้อ' },
                { role: 'ผู้ทบทวน' },
                { role: 'ผู้อนุมัติ' }
              ].map((stamp, idx) => (
                <th key={idx} className={`w-1/3 py-1.5 px-2 ${idx < 2 ? 'border-r border-black' : ''} text-[11px] font-bold text-slate-800`}>
                  {cleanThaiText(stamp.role)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="break-inside-avoid print:break-inside-avoid" style={{ breakInside: 'avoid', pageBreakInside: 'avoid' }}>
            <td className="w-1/3 p-2 align-top border-r border-black">
              <div className="flex flex-col items-center justify-start min-h-[120px] w-full">
                <div className="h-14 flex items-center justify-center">
                  {requesterSig ? (
                    <img
                      src={requesterSig}
                      alt="Requester Signature"
                      className="h-12 max-h-12 max-w-[120px] object-contain"
                    />
                  ) : null}
                </div>
                <p className="text-[11px] font-medium text-slate-800">
                  ( {cleanThaiText(requesterName)} )
                </p>
                <p className="text-[10px] text-slate-500 mt-1">
                  {cleanThaiText(formatDocDateTime(requesterDate) || 'วันที่ ..... / ..... / .........')}
                </p>
              </div>
            </td>

            <td className="w-1/3 p-2 align-top border-r border-black">
              <div className="flex flex-col items-center justify-start min-h-[120px] w-full">
                {isReviewed ? (
                  <>
                    <div className="h-14 flex items-center justify-center">
                      {reviewerSig ? (
                        <img
                          src={reviewerSig}
                          alt="Reviewer Signature"
                          className="h-12 max-h-12 max-w-[120px] object-contain"
                        />
                      ) : null}
                    </div>
                    <p className="text-[11px] font-medium text-slate-800">
                      ( {cleanThaiText(reviewerName || 'คุณสมชาย มุ่งมั่น')} )
                    </p>
                    <p className="text-[10px] text-slate-500 mt-1">
                      {cleanThaiText(formatDocDateTime(reviewerDate) || 'วันที่ ..... / ..... / .........')}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="h-14 flex items-center justify-center"></div>
                    <p className="text-xs text-slate-600">( ............................................................ )</p>
                    <p className="text-[11px] text-slate-400 mt-1">วันที่ ..... / ..... / .........</p>
                  </>
                )}
              </div>
            </td>

            <td className="w-1/3 p-2 align-top">
              <div className="flex flex-col items-center justify-start min-h-[120px] w-full">
                {isApproved ? (
                  <>
                    <div className="h-14 flex items-center justify-center">
                      {approverSig ? (
                        <img
                          src={approverSig}
                          alt="Approver Signature"
                          className="h-12 max-h-12 max-w-[120px] object-contain"
                        />
                      ) : null}
                    </div>
                    <p className="text-[11px] font-medium text-slate-800">
                      ( {cleanThaiText(approverName || 'คุณประเสริฐ ยิ่งยง')} )
                    </p>
                    <p className="text-[10px] text-slate-500 mt-1">
                      {cleanThaiText(formatDocDateTime(approverDate) || 'วันที่ ..... / ..... / .........')}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="h-14 flex items-center justify-center"></div>
                    <p className="text-xs text-slate-600">( ............................................................ )</p>
                    <p className="text-[11px] text-slate-400 mt-1">วันที่ ..... / ..... / .........</p>
                  </>
                )}
              </div>
            </td>

            <td className="w-1/4 p-2 align-top">
              <div className="flex flex-col items-center justify-start min-h-[120px] w-full">
                {isReceived && (receiverSig || receiverName) ? (
                  <>
                    <div className="h-14 flex items-center justify-center">
                      {receiverSig ? (
                        <img
                          src={receiverSig}
                          alt="Receiver Signature"
                          className="h-12 max-h-12 max-w-[120px] object-contain"
                        />
                      ) : null}
                    </div>
                    <p className="text-[11px] font-medium text-slate-800">
                      {receiverName ? `( ${cleanThaiText(receiverName)} )` : '( ........................................... )'}
                    </p>
                    <p className="text-[10px] text-slate-500 mt-1">
                      {receiverDate ? `วันที่ ${formatThaiDateTime(receiverDate)}` : 'วันที่ ..... / ..... / .........'}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="h-14 flex items-center justify-center"></div>
                    <p className="text-xs text-slate-600">( ........................................... )</p>
                    <p className="text-[11px] text-slate-400 mt-1">วันที่ ..... / ..... / .........</p>
                  </>
                )}
                {hasSettlement && (
                  <p className="text-[10px] font-bold text-emerald-800 mt-1 font-mono">
                    {cleanThaiText(`* ยืนยันยอดตรวจรับและจ่ายจริง ฿${actualTotal.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)}
                  </p>
                )}
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
    </div>
  );
}