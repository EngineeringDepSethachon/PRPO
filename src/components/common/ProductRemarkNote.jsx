import React from 'react';

/**
 * หมายเหตุ/สเปกของสินค้า (FR-02)
 * ลำดับการหา: item.productRemark (คัดลอกตอนสร้าง PR) → product.remark ของสินค้าที่ productId ตรงกัน (รอง: code) → ''
 * PR เก่าที่ item ไม่มี productRemark ก็ยังเห็นหมายเหตุจาก products ได้
 */
export const getItemRemark = (item, products = []) => {
  const own = typeof item?.productRemark === 'string' ? item.productRemark.trim() : '';
  if (own) return own;
  if (!item || !Array.isArray(products) || products.length === 0) return '';

  let prod = null;
  if (item.productId !== undefined && item.productId !== null && item.productId !== '') {
    const pid = String(item.productId);
    prod = products.find(p => p && p.id !== undefined && p.id !== null && String(p.id) === pid) || null;
  }
  if (!prod && item.code) {
    const code = String(item.code).trim().toUpperCase();
    if (code) {
      prod = products.find(p => p && String(p.code ?? '').trim().toUpperCase() === code) || null;
    }
  }
  return String(prod?.remark ?? '').trim();
};

/**
 * กล่องแสดงหมายเหตุสินค้า: ข้อความธรรมดา (whitespace-pre-line) ไม่มีหมายเหตุ → render null
 * className เพิ่มได้เฉพาะการจัดวางภายนอก (margin / border) ของผู้เรียก
 */
export default function ProductRemarkNote({ item, products = [], className = '' }) {
  const remark = getItemRemark(item, products);
  if (!remark) return null;

  return (
    <div
      className={`rounded-lg border border-amber-200/80 bg-amber-50/60 px-2.5 py-1.5 text-xs leading-relaxed text-slate-700 whitespace-pre-line break-words ${className}`.trim()}
    >
      <span className="font-semibold text-amber-800">สเปก/หมายเหตุ:</span>{' '}
      {remark}
    </div>
  );
}
