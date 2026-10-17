import React, { useState, useRef, useEffect } from 'react';
import { Package, Copy, Check } from 'lucide-react';
import AttachmentThumbnail from '../common/AttachmentThumbnail';
import ProductRemarkNote from '../common/ProductRemarkNote';
import { sanitizeExternalUrl, getLinkLabel } from '../../utils/urlHelper';

const formatNumber = (n) => {
  const num = Number(n);
  return Number.isFinite(num) ? num.toLocaleString('th-TH') : '-';
};

const formatBaht = (n) => {
  const num = Number(n);
  if (!Number.isFinite(num)) return '-';
  return `฿${num.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

// สำรองเมื่อไม่มี navigator.clipboard : เลือกข้อความใน textarea ชั่วคราวแล้ว execCommand('copy') ; คืน true ถ้าสำเร็จ
const legacyCopy = (text) => {
  try {
    if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return Boolean(ok);
  } catch {
    return false;
  }
};

/**
 * การ์ดสินค้าต่อรายการในงานจัดซื้อออนไลน์ (FR-03)
 * ซ้าย: รูปใหญ่ (คลิก = onOpenImage) · กลาง: ชื่อ/รหัส/หมายเหตุ/จำนวน-ราคาที่อนุมัติ/ปุ่มลิงก์ร้านค้า · ขวา-ล่าง: children (ส่วนควบคุมของแต่ละโหมด)
 *
 * props
 *  item        รายการสินค้า (ใช้ name/code/sku/productRemark)
 *  products    สินค้า master (สำหรับ ProductRemarkNote)
 *  url         ลิงก์สินค้าดิบ (ผ่าน sanitizeExternalUrl ก่อนเป็น href ; ไม่ใช่ http(s) = ไม่มีปุ่ม)
 *  platform    ชื่อแพลตฟอร์ม (ใช้เดาป้ายเมื่อ host ไม่รู้จัก)
 *  qty, unit   จำนวนที่ต้องซื้อ + หน่วย
 *  price       ราคาต่อหน่วยที่อนุมัติ
 *  code        รหัสที่แสดง (ไม่ส่ง = item.code || item.sku) ; ผู้เรียกเลือกลำดับ code/sku เองตามโหมดเดิม
 *  qtyLabel / priceLabel  ป้ายข้อความ (ค่าเริ่มต้น โหมดแก้ไข = จำนวนที่ต้องซื้อ / ราคาต่อหน่วยที่อนุมัติ ; readOnly = จำนวนที่สั่งจริง / ราคาต่อหน่วยจริง)
 *  images      รูปที่ normalize แล้ว [{url, previewUrl, name}] (ไม่ส่ง = ใช้ item.images / item.attachments)
 *  onOpenImage (images, index, title) => void
 *  badges      ป้ายสถานะใต้ชื่อ (ขาด/ชำรุด/รอส่งมอบ/Ref/คืนเงิน)
 *  nameExtra   ปุ่มเล็กต่อท้ายชื่อ (เช่น คัดลอกชื่อสินค้า)
 *  children    ส่วนควบคุมเดิมของแต่ละโหมด
 *  readOnly    โหมดอ่านอย่างเดียว/เคลม (ปรับพื้นหลัง/ตัวบ่งชี้ data-readonly เท่านั้น)
 */
export default function ProductActionCard({
  item,
  products = [],
  url = '',
  platform = '',
  qty,
  unit = 'ชิ้น',
  price,
  code,
  qtyLabel,
  priceLabel,
  images,
  onOpenImage,
  badges = null,
  nameExtra = null,
  children = null,
  readOnly = false
}) {
  const [copied, setCopied] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const timerRef = useRef(null);
  const manualRef = useRef(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  useEffect(() => {
    if (showManual && manualRef.current) {
      try { manualRef.current.focus(); manualRef.current.select(); } catch { /* ignore */ }
    }
  }, [showManual]);

  const name = String(item?.name || '');
  const imageList = (Array.isArray(images) ? images : (
    (Array.isArray(item?.images) && item.images.length > 0) ? item.images : (Array.isArray(item?.attachments) ? item.attachments : [])
  )).filter(Boolean);

  const rawUrl = typeof url === 'string' ? url.trim() : '';
  const { label, host } = getLinkLabel(rawUrl, platform);
  // host ว่าง = ไม่ใช่ http(s) ที่ใช้ได้ (เช่น javascript:, data:) → ไม่แสดงปุ่มลิงก์
  const safeUrl = host ? sanitizeExternalUrl(rawUrl) : '';
  const platformText = label && label !== host ? `${label} · ${host}` : host;

  const openImage = (idx) => { if (typeof onOpenImage === 'function') onOpenImage(imageList, idx, name); };

  const flashCopied = () => {
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  };

  const handleCopyLink = async () => {
    if (!safeUrl) return;
    let ok = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(safeUrl);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) ok = legacyCopy(safeUrl);
    if (ok) {
      setShowManual(false);
      flashCopied();
    } else {
      setShowManual(true);
    }
  };

  const shownCode = code || item?.code || item?.sku || 'ITEM';
  const qtyText = qtyLabel || (readOnly ? 'จำนวนที่สั่งจริง' : 'จำนวนที่ต้องซื้อ');
  const priceText = priceLabel || (readOnly ? 'ราคาต่อหน่วยจริง' : 'ราคาต่อหน่วยที่อนุมัติ');

  return (
    <div
      data-testid="product-action-card"
      data-readonly={readOnly ? 'true' : 'false'}
      className={`px-3.5 py-3 transition-colors flex flex-col sm:flex-row sm:items-start gap-3.5 ${readOnly ? 'bg-white hover:bg-slate-50/50' : 'bg-white hover:bg-slate-50/70'}`}
    >
      {/* ซ้าย: รูปสินค้า */}
      <div className="relative shrink-0 self-start" title={imageList.length > 0 ? `คลิกเพื่อดูรูปภาพขยาย (${imageList.length} รูป)` : undefined}>
        {imageList.length > 0 ? (
          <>
            <AttachmentThumbnail
              img={imageList[0]}
              imgIdx={0}
              onClick={() => openImage(0)}
              sizeClass="w-24 h-24 sm:w-28 sm:h-28"
              altText={name || undefined}
            />
            {imageList.length > 1 && (
              <button
                type="button"
                onClick={() => openImage(1)}
                title={`ดูรูปเพิ่มเติม (${imageList.length - 1} รูป)`}
                className="absolute bottom-1 right-1 min-w-[28px] h-6 px-1.5 rounded-full bg-slate-800/90 hover:bg-indigo-600 text-white text-[11px] font-mono font-bold flex items-center justify-center border border-white shadow-sm cursor-pointer focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                +{imageList.length - 1}
              </button>
            )}
          </>
        ) : (
          <div
            data-testid="product-card-no-image"
            className="w-24 h-24 sm:w-28 sm:h-28 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-400"
          >
            <Package className="w-8 h-8" />
          </div>
        )}
      </div>

      {/* กลาง: รายละเอียด + ลิงก์ */}
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-start gap-1.5 min-w-0">
          <h4 className="text-base font-bold text-slate-900 break-words line-clamp-2 min-w-0" title={name}>
            {name}
          </h4>
          {nameExtra}
        </div>

        <div className="flex items-center gap-2 flex-wrap text-[11px] text-slate-500">
          <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-mono font-semibold">{shownCode}</span>
          <span>หน่วย: {unit}</span>
        </div>

        <ProductRemarkNote item={item} products={products} />

        {badges && <div className="flex items-center gap-1.5 flex-wrap font-sans empty:hidden">{badges}</div>}

        <div className="flex flex-col gap-0.5">
          <div className="text-sm text-slate-600">
            {qtyText}{' '}
            <span className="text-lg font-bold text-indigo-700 tabular-nums" data-testid="product-card-qty">{formatNumber(qty)}</span>{' '}
            <span className="font-semibold text-slate-700">{unit}</span>
          </div>
          <div className="text-sm text-slate-600">
            {priceText}{' '}
            <span className="text-lg font-bold text-emerald-700 tabular-nums" data-testid="product-card-price">{formatBaht(price)}</span>
          </div>
        </div>

        {safeUrl ? (
          <div className="pt-1 space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <a
                href={safeUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="product-card-cta"
                className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-1"
              >
                เปิดลิงก์ร้านค้าออนไลน์ ↗
              </a>
              <button
                type="button"
                onClick={handleCopyLink}
                data-testid="product-card-copy"
                className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-sm font-semibold cursor-pointer transition-colors"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                {copied ? 'คัดลอกแล้ว' : 'คัดลอกลิงก์'}
              </button>
              <span
                data-testid="product-card-platform"
                className="inline-flex items-center px-2 py-1 rounded-md bg-orange-50 text-orange-700 border border-orange-200 text-xs font-semibold break-all"
              >
                {platformText}
              </span>
            </div>
            {showManual && (
              <input
                ref={manualRef}
                type="text"
                readOnly
                value={safeUrl}
                aria-label="ลิงก์สินค้า (กดเลือกเพื่อคัดลอกเอง)"
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.currentTarget.select()}
                className="w-full h-9 px-2 text-xs font-mono rounded-lg border border-slate-300 bg-slate-50 text-slate-700"
              />
            )}
          </div>
        ) : (
          <div className="pt-1 text-xs text-slate-400 italic" data-testid="product-card-no-link">ไม่มีลิงก์ร้านค้า</div>
        )}
      </div>

      {/* ขวา/ล่าง: ส่วนควบคุมเดิมของแต่ละโหมด */}
      {children && (
        <div className="sm:ml-auto shrink-0 w-full sm:w-auto sm:self-center">
          {children}
        </div>
      )}
    </div>
  );
}
