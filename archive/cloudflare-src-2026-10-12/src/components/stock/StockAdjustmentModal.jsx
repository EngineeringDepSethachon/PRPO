import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { SlidersHorizontal, AlertCircle, X, Check, ArrowDownCircle, ArrowUpCircle, MapPin } from 'lucide-react';
import { storageService } from '../../services/storageService';
import SearchableSelect from '../common/SearchableSelect';
import { safeStringCompare } from '../../utils/formatters';

export default function StockAdjustmentModal({ products = [], currentRole, onClose, onRefresh }) {
  const [selectedProductId, setSelectedProductId] = useState('');
  const [actionType, setActionType] = useState('OUT'); // 'IN' | 'OUT'
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('ปรับปรุงยอดคงเหลือ (Stock Adjustment)');
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
  const sUnit = selectedProduct?.stockUnit || selectedProduct?.unit || 'ชิ้น';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!selectedProductId) { setError('กรุณาเลือกสินค้า'); return; }
    const qtyNum = Number(qty);
    if (!qtyNum || qtyNum <= 0) { setError('จำนวนต้องมากกว่า 0'); return; }
    if (!reason) { setError('กรุณาระบุเหตุผล'); return; }

    const currentBalance = Number(selectedProduct.stockBalance || 0);

    if (actionType === 'OUT' && qtyNum > currentBalance) {
      setError(`ไม่สามารถปรับลด (${qtyNum}) ได้มากกว่ายอดคงเหลือปัจจุบัน (${currentBalance})`);
      return;
    }

    setSaving(true);
    try {
      const allProducts = storageService.getProducts();
      const stockLogs = storageService.getStockLogs();
      const timestamp = new Date().toLocaleString('th-TH');
      const docNo = `ADJ-${actionType}-${Date.now().toString().slice(-6)}`;

      const prodIndex = allProducts.findIndex(p => p.id === selectedProductId);
      if (prodIndex === -1) throw new Error('ไม่พบสินค้าในระบบ');

      const adjustAmount = actionType === 'IN' ? qtyNum : -qtyNum;
      const newBalance = Math.round((currentBalance + adjustAmount) * 10000) / 10000;
      allProducts[prodIndex].stockBalance = newBalance;

      stockLogs.unshift({
        id: `LOG-${Date.now()}`,
        date: timestamp,
        productId: selectedProductId,
        productCode: selectedProduct.code || '',
        productName: selectedProduct.name || '',
        name: selectedProduct.name || '',
        department: selectedProduct.department || selectedProduct.category || currentRole?.department || 'PD',
        type: actionType,
        docNo,
        documentNo: docNo,
        qty: qtyNum,
        balance: newBalance,
        user: `${currentRole.name} (${currentRole.title})`,
        note: `[ปรับปรุงสต็อก ${actionType === 'IN' ? '+ เพิ่ม' : '- ลด'}] ${reason}${customNote ? ` — ${customNote}` : ''}`,
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
            <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 border border-indigo-100/80 flex items-center justify-center shadow-2xs shrink-0">
              <SlidersHorizontal className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-slate-900 text-base tracking-tight">
                ปรับปรุงสต็อกสินค้า (Stock Adjustment)
              </h3>
              <p className="text-xs text-slate-500 font-normal truncate mt-0.5">
                ปรับเพิ่มหรือลดจำนวนสินค้าคงเหลือพร้อมลงบันทึกสาเหตุ
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
          <form id="stock-adjust-form" onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-2xl flex items-center gap-2 text-rose-700 text-xs font-semibold">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="bg-slate-50/70 border border-slate-200/60 rounded-2xl p-5 space-y-4">
              {/* Adjustment Mode Selector */}
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                  ประเภทการปรับปรุง <span className="text-rose-500">*</span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setActionType('OUT')}
                    className={`py-2.5 px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-2 transition-all cursor-pointer ${
                      actionType === 'OUT'
                        ? 'bg-rose-50 border-rose-200 text-rose-700 shadow-2xs'
                        : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <ArrowDownCircle className="w-4 h-4 text-rose-500" />
                    <span>ปรับลดสต็อก (-OUT)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActionType('IN')}
                    className={`py-2.5 px-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-2 transition-all cursor-pointer ${
                      actionType === 'IN'
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-700 shadow-2xs'
                        : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <ArrowUpCircle className="w-4 h-4 text-emerald-500" />
                    <span>ปรับเพิ่มสต็อก (+IN)</span>
                  </button>
                </div>
              </div>

              {/* Product Select */}
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
                      <span className="text-slate-500 font-sans">คงเหลือ: </span>
                      <span className="font-bold text-slate-900 tabular-nums">
                        {selectedProduct.stockBalance || 0} {sUnit}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              {/* Quantity */}
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                  จำนวนที่ต้องการปรับปรุง ({actionType === 'IN' ? '+เพิ่ม' : '-ลด'}) <span className="text-rose-500">*</span>
                </label>
                <div className="relative">
                  <input
                    type="number"
                    step="any"
                    min="0.0001"
                    placeholder="ระบุจำนวน..."
                    value={qty}
                    onChange={e => setQty(e.target.value)}
                    className="w-full h-11 px-3.5 bg-white border border-slate-200 rounded-xl text-sm font-mono font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all shadow-2xs"
                    required
                  />
                  {selectedProduct && (
                    <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-medium text-slate-400">
                      {sUnit}
                    </span>
                  )}
                </div>
              </div>

              {/* Reason */}
              <div>
                <label className="text-xs font-semibold text-slate-700 mb-1.5 block">
                  สาเหตุการปรับปรุง <span className="text-rose-500">*</span>
                </label>
                <select
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  className="w-full h-11 px-3.5 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all cursor-pointer shadow-2xs"
                >
                  <option value="ปรับปรุงยอดคงเหลือ (Stock Adjustment)">ปรับปรุงยอดคงเหลือ (Stock Adjustment)</option>
                  <option value="สินค้าชำรุด / เสียหาย (Damaged Stock)">สินค้าชำรุด / เสียหาย (Damaged Stock)</option>
                  <option value="สินค้าหมดอายุ (Expired Stock)">สินค้าหมดอายุ (Expired Stock)</option>
                  <option value="ตรวจพบสินค้าสูญหาย (Lost / Missing)">ตรวจพบสินค้าสูญหาย (Lost / Missing)</option>
                  <option value="ตรวจนับประจำปี (Physical Count Diff)">ตรวจนับประจำปี (Physical Count Diff)</option>
                  <option value="อื่นๆ (Other)">อื่นๆ (Other)</option>
                </select>
              </div>

              {/* Custom Note */}
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
              form="stock-adjust-form"
              disabled={saving}
              className={`px-5 py-2.5 rounded-xl text-white text-xs font-bold shadow-sm transition-all flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                actionType === 'OUT' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-indigo-600 hover:bg-indigo-700'
              }`}
            >
              <Check className="w-4 h-4" />
              <span>{saving ? 'กำลังบันทึก...' : 'ยืนยันปรับปรุงสต็อก'}</span>
            </button>
          </div>
        </div>

      </div>
    </div>,
    document.body
  );
}
