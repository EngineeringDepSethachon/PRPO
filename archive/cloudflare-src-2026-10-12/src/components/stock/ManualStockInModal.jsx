import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { PackagePlus, AlertCircle, X, Check, Boxes, FileText, MapPin } from 'lucide-react';
import { STOCK_IN_REASONS } from '../../config/constants';
import { storageService } from '../../services/storageService';
import SearchableSelect from '../common/SearchableSelect';
import { safeStringCompare } from '../../utils/formatters';

export default function ManualStockInModal({ products = [], currentRole, onClose, onRefresh }) {
  const [selectedProductId, setSelectedProductId] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState(STOCK_IN_REASONS[0]);
  const [customNote, setCustomNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Only show products matching this role's dept
  const availableProducts = useMemo(() => {
    return (currentRole.canViewAllDepts
      ? products
      : products.filter(p => (p.category || p.department) === currentRole.department)
    ).sort((a, b) => safeStringCompare(a?.code, b?.code));
  }, [products, currentRole]);

  const productOptions = useMemo(() => {
    return availableProducts.map(p => {
      const sUnit = p.stockUnit || p.unit || 'ชิ้น';
      const pCat = p.category || p.department || 'PD';
      return {
        value: p.id,
        label: p.name,
        code: p.code,
        subLabel: `คงเหลือ: ${Number(p.stockBalance || 0).toLocaleString()} ${sUnit} • ROP: ${Number(p.reorderPoint || 0).toLocaleString()} ${sUnit}`,
        badge: pCat === 'PD' ? 'ฝ่ายผลิต' : 'ฝ่าย QC',
        keywords: `${p.code} ${p.name} ${sUnit} ${pCat}`
      };
    });
  }, [availableProducts]);

  const selectedProduct = availableProducts.find(p => p.id === selectedProductId);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!selectedProductId) { setError('กรุณาเลือกสินค้า'); return; }
    const qtyNum = Number(qty);
    if (!qtyNum || qtyNum <= 0) { setError('จำนวนต้องมากกว่า 0'); return; }
    if (!reason) { setError('กรุณาระบุเหตุผล'); return; }

    setSaving(true);
    try {
      const allProducts = storageService.getProducts();
      const stockLogs = storageService.getStockLogs();
      const timestamp = new Date().toLocaleString('th-TH');
      const docNo = `MAN-IN-${Date.now().toString().slice(-6)}`;

      const prodIndex = allProducts.findIndex(p => p.id === selectedProductId);
      if (prodIndex === -1) throw new Error('ไม่พบสินค้าในระบบ');

      const newBalance = Math.round(((allProducts[prodIndex].stockBalance || 0) + qtyNum) * 10000) / 10000;
      allProducts[prodIndex].stockBalance = newBalance;

      stockLogs.unshift({
        id: `LOG-${Date.now()}`,
        date: timestamp,
        productId: selectedProductId,
        productCode: selectedProduct?.code || '',
        productName: selectedProduct?.name || '',
        name: selectedProduct?.name || '',
        department: selectedProduct?.department || selectedProduct?.category || currentRole?.department || 'PD',
        type: 'IN',
        docNo,
        documentNo: docNo,
        qty: qtyNum,
        balance: newBalance,
        user: `${currentRole.name} (${currentRole.title})`,
        note: `[รับเข้าด้วยตนเอง] ${reason}${customNote ? ` — ${customNote}` : ''}`,
        isManual: true,
        reason
      });


      storageService.saveProducts(allProducts);
      storageService.saveStockLogs(stockLogs);

      onClose();
      onRefresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs animate-fade-in print:hidden">
      <div className="w-full max-w-xl max-h-[90vh] flex flex-col rounded-3xl bg-white shadow-2xl border border-slate-200/80 overflow-hidden text-slate-800 animate-zoom-in">
        
        {/* ── 1. Fixed Header (Sticky Top / Non-scrollable) ── */}
        <div className="shrink-0 px-6 py-4 border-b border-slate-100 bg-white flex items-center justify-between gap-4 sticky top-0 z-20">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-emerald-50 text-emerald-600 border border-emerald-100/80 flex items-center justify-center shadow-2xs shrink-0">
              <PackagePlus className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-slate-900 text-base tracking-tight">
                รับสินค้าเข้าคลัง (Manual Stock-In)
              </h3>
              <p className="text-xs text-slate-500 font-normal truncate mt-0.5">
                บันทึกประวัติ Audit Log และเพิ่มจำนวนคงเหลือในคลังโดยตรง
              </p>
            </div>
          </div>

          <button 
            type="button" 
            onClick={onClose} 
            className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* ── 2. Scrollable Content Body (Flex-1 / Dynamic Height) ── */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 min-h-0 custom-scrollbar bg-slate-50/30">
          <form id="manual-stockin-form" onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-2xl flex items-center gap-2 text-rose-700 text-xs font-semibold">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="bg-slate-50/70 border border-slate-200/60 rounded-2xl p-5 space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                  เลือกรายการสินค้า <span className="text-rose-500">*</span>
                </label>
                <SearchableSelect
                  options={productOptions}
                  value={selectedProductId}
                  onChange={setSelectedProductId}
                  placeholder="ค้นหาชื่อ หรือรหัสสินค้า..."
                  buttonClassName="h-11 text-xs font-medium"
                />
                {selectedProduct && (
                  <div className="mt-2.5 p-3 bg-white border border-slate-200/80 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs shadow-2xs">
                    <div className="flex items-center gap-1.5 text-slate-600">
                      <MapPin className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                      <span>จุดจัดเก็บ: <b className="text-slate-900 font-semibold">{selectedProduct.locationName || 'ไม่ระบุจุดจัดเก็บ'}</b></span>
                    </div>
                    <div className="font-mono">
                      <span className="text-slate-500 font-sans">ยอดคงเหลือ: </span>
                      <span className="font-bold text-slate-900 tabular-nums">
                        {selectedProduct.stockBalance || 0} {selectedProduct.stockUnit || selectedProduct.unit || 'ชิ้น'}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                  จำนวนที่รับเข้าคลัง <span className="text-rose-500">*</span>
                </label>
                <div className="relative">
                  <input
                    type="number"
                    step="any"
                    min="0.0001"
                    placeholder="ระบุจำนวนที่รับเข้า..."
                    value={qty}
                    onChange={e => setQty(e.target.value)}
                    className="w-full h-11 px-3.5 bg-white border border-slate-200 rounded-xl text-sm font-mono font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all shadow-2xs"
                    required
                  />
                  {selectedProduct && (
                    <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-medium text-slate-400">
                      {selectedProduct.stockUnit || selectedProduct.unit || 'ชิ้น'}
                    </span>
                  )}
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                  เหตุผลในการรับเข้า <span className="text-rose-500">*</span>
                </label>
                <select
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  className="w-full h-11 px-3.5 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all cursor-pointer shadow-2xs"
                >
                  {STOCK_IN_REASONS.map(r => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                  หมายเหตุเพิ่มเติม (ถ้ามี)
                </label>
                <textarea
                  rows={2}
                  placeholder="ระบุรายละเอียดเพิ่มเติม..."
                  value={customNote}
                  onChange={e => setCustomNote(e.target.value)}
                  className="w-full p-3 bg-white border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all resize-none shadow-2xs"
                />
              </div>
            </div>
          </form>
        </div>

        {/* ── 3. Sticky Action Footer (Non-scrollable) ── */}
        <div className="shrink-0 px-6 py-4 bg-slate-50/80 border-t border-slate-100 flex items-center justify-between gap-3 sticky bottom-0 z-20">
          <span className="text-xs text-slate-500 font-medium">
            <span className="text-rose-500 font-bold">*</span> จำเป็นต้องระบุข้อมูล
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 text-xs font-bold transition-all cursor-pointer"
            >
              ยกเลิก
            </button>
            <button
              type="submit"
              form="manual-stockin-form"
              disabled={saving}
              className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold shadow-sm transition-all flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Check className="w-4 h-4" />
              <span>{saving ? 'กำลังบันทึก...' : 'ยืนยันรับเข้าสต็อก'}</span>
            </button>
          </div>
        </div>

      </div>
    </div>,
    document.body
  );
}
