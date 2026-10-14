import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { 
  FileText, X, Save, Edit3, Clock, User, Building2, MapPin, 
  AlertCircle, CheckCircle2, ShieldCheck, Tag
} from 'lucide-react';
import { apiService } from '../../services/apiService';
import { modalService } from '../../services/modalService';

export default function ProductRemarkDrawer({ isOpen, product, currentRole, onClose, onRefresh }) {
  const [remarkText, setRemarkText] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (product) {
      setRemarkText(product.remark || '');
      setIsEditing(false);
    }
  }, [product]);

  if (!isOpen || !product) return null;

  const isOnlinePurchaser = currentRole?.roleId === 'ONLINE_PURCHASER' || currentRole?.id === 'ONLINE_PURCHASER';

  const canEditRemark = !isOnlinePurchaser && (
    currentRole?.id === 'ADMIN' || 
    currentRole?.roleId === 'ADMIN' || 
    currentRole?.canManageMaster || 
    currentRole?.canReceiveGoods ||
    (currentRole?.department === product.category && currentRole?.level >= 2)
  );

  const handleSaveRemark = async () => {
    try {
      setIsSaving(true);
      const updatedProduct = {
        ...product,
        remark: remarkText.trim(),
        remarkUpdatedAt: new Date().toLocaleString('th-TH'),
        remarkUpdatedBy: currentRole?.name ? `${currentRole.name} (${currentRole.title || currentRole.department})` : 'System User'
      };

      await apiService.saveProduct(updatedProduct, currentRole);
      modalService.success('บันทึกหมายเหตุเรียบร้อย', `อัปเดตหมายเหตุสินค้า "${product.name}" สำเร็จ`);
      setIsEditing(false);
      if (onRefresh) onRefresh();
    } catch (err) {
      modalService.error('เกิดข้อผิดพลาดในการบันทึก', err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const deptBadgeClass = product.category === 'QC'
    ? 'bg-amber-50 text-amber-700 border-amber-200/80'
    : 'bg-blue-50 text-blue-700 border-blue-200/80';

  return createPortal(
    <>
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-slate-900/40 backdrop-blur-xs z-[100] animate-fade-in no-print"
        onClick={onClose}
      />

      {/* Slide-over Drawer Panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-md sm:max-w-lg bg-white shadow-2xl z-[105] flex flex-col border-l border-slate-200/90 animate-slide-left overflow-hidden text-slate-800 no-print">
        
        {/* ── 1. Sticky Drawer Header ── */}
        <div className="p-5 border-b border-slate-100 bg-white sticky top-0 z-20 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 shadow-2xs border ${
              product.remark 
                ? 'bg-amber-50 text-amber-600 border-amber-200/80' 
                : 'bg-indigo-50 text-indigo-600 border-indigo-200/80'
            }`}>
              <FileText className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-slate-900 text-base tracking-tight truncate">
                หมายเหตุสินค้า (Product Remark)
              </h3>
              <p className="text-xs text-slate-500 font-normal truncate mt-0.5">
                ข้อควรระวัง ข้อมูลทางเทคนิค และบันทึกเฉพาะรายการ
              </p>
            </div>
          </div>

          <button 
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
            title="ปิดหน้าต่าง"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── 2. Content Area ── */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5 custom-scrollbar bg-slate-50/30">
          {/* Product Overview Card */}
          <div className="p-4 bg-white rounded-2xl border border-slate-200/80 shadow-xs space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="font-mono font-bold text-xs bg-slate-100 text-slate-800 px-2.5 py-1 rounded-md border border-slate-200/70">
                {product.code}
              </span>
              <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full border ${deptBadgeClass}`}>
                ฝ่าย {product.category || 'PD'}
              </span>
            </div>

            <h4 className="font-bold text-slate-900 text-sm leading-snug">
              {product.name}
            </h4>

            <div className="flex items-center gap-2 pt-2 border-t border-slate-100 text-xs text-slate-600 flex-wrap">
              <span className="inline-flex items-center gap-1 bg-slate-100 text-slate-700 px-2 py-0.5 rounded-md border border-slate-200/60 font-medium text-[11px]">
                <MapPin className="w-3 h-3 text-indigo-600" />
                <span>{product.locationName || 'ไม่ระบุจุดจัดเก็บ'}</span>
              </span>
              <span>•</span>
              <span>คงเหลือ: <strong className="font-mono font-bold text-indigo-700">{Number(product.stockBalance || 0).toLocaleString()}</strong> {product.stockUnit || product.unit || 'ชิ้น'}</span>
            </div>
          </div>

          {/* Remark Box */}
          <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-xs space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5 text-indigo-600" />
                <span>ข้อความหมายเหตุ / รายละเอียดสำคัญ</span>
              </label>

              {canEditRemark && !isEditing && (
                <button
                  type="button"
                  onClick={() => setIsEditing(true)}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800 transition-colors cursor-pointer px-2 py-1 rounded-lg hover:bg-indigo-50"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>แก้ไขข้อความ</span>
                </button>
              )}
            </div>

            {isEditing ? (
              <div className="space-y-2">
                <textarea
                  value={remarkText}
                  onChange={e => setRemarkText(e.target.value)}
                  rows={6}
                  placeholder="ระบุหมายเหตุ เช่น เงื่อนไขการจัดเก็บเฉพาะ, ยี่ห้อที่แนะนำ, คุณสมบัติทางเคมี หรือประวัติการจัดซื้อ..."
                  className="w-full text-xs sm:text-sm p-3 border border-indigo-200 rounded-xl focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 outline-none transition-all resize-y custom-scrollbar leading-relaxed bg-indigo-50/10 font-normal"
                />
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setRemarkText(product.remark || '');
                      setIsEditing(false);
                    }}
                    className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-all cursor-pointer"
                  >
                    ยกเลิก
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveRemark}
                    disabled={isSaving}
                    className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-xs transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>{isSaving ? 'กำลังบันทึก...' : 'บันทึกหมายเหตุ'}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div>
                {product.remark ? (
                  <div className="p-3.5 bg-amber-50/40 border border-amber-200/60 rounded-xl text-xs sm:text-sm text-slate-800 whitespace-pre-wrap leading-relaxed">
                    {product.remark}
                  </div>
                ) : (
                  <div className="p-6 text-center border-2 border-dashed border-slate-200 rounded-xl text-slate-400 text-xs space-y-1">
                    <p className="font-semibold">ไม่มีหมายเหตุสำหรับสินค้านี้</p>
                    {canEditRemark && (
                      <p className="text-[11px] text-slate-400">
                        กดปุ่ม &ldquo;แก้ไขข้อความ&rdquo; ด้านบนเพื่อเพิ่มหมายเหตุ
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Timestamp & Author Meta */}
            {(product.remarkUpdatedAt || product.remarkUpdatedBy) && (
              <div className="pt-3 border-t border-slate-100 text-[11px] text-slate-500 space-y-1">
                {product.remarkUpdatedAt && (
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-3 h-3 text-slate-400" />
                    <span>อัปเดตล่าสุด: <span className="font-mono text-slate-700">{product.remarkUpdatedAt}</span></span>
                  </div>
                )}
                {product.remarkUpdatedBy && (
                  <div className="flex items-center gap-1.5">
                    <User className="w-3 h-3 text-slate-400" />
                    <span>ผู้บันทึก: <span className="font-medium text-slate-700">{product.remarkUpdatedBy}</span></span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── 3. Sticky Action Footer ── */}
        <div className="p-4 border-t border-slate-100 bg-slate-50/80 flex items-center justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-slate-800 hover:bg-slate-900 text-white text-xs font-bold transition-all cursor-pointer shadow-xs"
          >
            ปิด
          </button>
        </div>

      </div>
    </>,
    document.body
  );
}
