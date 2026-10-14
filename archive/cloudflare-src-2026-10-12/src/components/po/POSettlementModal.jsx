import React, { useState, useMemo } from 'react';
import { 
  X, CheckCircle2, AlertCircle, DollarSign, 
  Receipt, ArrowRight, ExternalLink, ShieldCheck, 
  HelpCircle, Package, TrendingDown, TrendingUp
} from 'lucide-react';
import { apiService } from '../../services/apiService';
import { modalService } from '../../services/modalService';

export default function POSettlementModal({ po, currentUser, onClose, onSuccess }) {
  const originalTotal = Number(po.grandTotal || po.totalAmount || po.subtotal || 0);

  const [actualTotalInput, setActualTotalInput] = useState(
    po.actualTotalAmount !== undefined && po.actualTotalAmount !== null 
      ? String(po.actualTotalAmount) 
      : String(originalTotal)
  );
  const [settlementNote, setSettlementNote] = useState(po.settlementNote || '');
  const [settlementProofUrl, setSettlementProofUrl] = useState(po.settlementProofUrl || '');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Line item actual price overrides (optional per-item refinement)
  const initialItems = useMemo(() => {
    return (po.items || []).map(item => ({
      ...item,
      overrideUnitPrice: item.actualUnitPrice !== undefined ? String(item.actualUnitPrice) : ''
    }));
  }, [po.items]);

  const [lineItems, setLineItems] = useState(initialItems);

  const actualTotalNumber = parseFloat(actualTotalInput) || 0;
  const savingsAmount = originalTotal - actualTotalNumber;
  const costRatio = originalTotal > 0 ? (actualTotalNumber / originalTotal) : 1;

  const handleLinePriceChange = (index, value) => {
    setLineItems(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], overrideUnitPrice: value };
      return updated;
    });
  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    if (isNaN(actualTotalNumber) || actualTotalNumber < 0) {
      return modalService.warning('กรุณากรอกยอดจ่ายจริงที่ถูกต้อง', 'ยอดเงินต้องเป็นตัวเลขและไม่ต่ำกว่า 0 บาท');
    }

    const confirmMsg = savingsAmount > 0
      ? `ยอดอนุมัติเดิม: ฿${originalTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}\nยอดจ่ายจริง: ฿${actualTotalNumber.toLocaleString(undefined, { minimumFractionDigits: 2 })}\nส่วนต่างประหยัด: ฿${savingsAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })} (ระบบจะคืนงบประมาณให้ฝ่าย ${po.department || 'PD'} อัตโนมัติ)\n\nยืนยันบันทึกปิดยอดหรือไม่?`
      : `ยอดอนุมัติเดิม: ฿${originalTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}\nยอดจ่ายจริง: ฿${actualTotalNumber.toLocaleString(undefined, { minimumFractionDigits: 2 })}\n\nยืนยันบันทึกปิดยอดหรือไม่?`;

    const confirmed = await modalService.confirm({
      title: 'ยืนยันปิดยอดจ่ายจริง (Online Settlement)',
      message: confirmMsg,
      confirmText: 'ยืนยันปิดยอด',
      cancelText: 'ยกเลิก'
    });

    if (!confirmed) return;

    setIsSubmitting(true);
    try {
      // Build actualItems array with reconciled unit prices
      const actualItems = (po.items || []).map((item, idx) => {
        const lineOverride = lineItems[idx]?.overrideUnitPrice;
        const basePrice = Number(item.price || item.unitPrice || item.estimatedPrice || 0);
        const resolvedUnitPrice = (lineOverride !== undefined && lineOverride !== '' && !isNaN(parseFloat(lineOverride)))
          ? parseFloat(lineOverride)
          : Math.round((basePrice * costRatio) * 100) / 100;

        return {
          ...item,
          actualUnitPrice: resolvedUnitPrice,
          actualPrice: resolvedUnitPrice,
          unitPrice: resolvedUnitPrice
        };
      });

      const settlementPayload = {
        actualTotalAmount: actualTotalNumber,
        savingsAmount: savingsAmount,
        settlementNote: settlementNote.trim(),
        settlementProofUrl: settlementProofUrl.trim(),
        settledBy: currentUser?.name || currentUser?.employeeName || 'จัดซื้อ',
        settledAt: new Date().toISOString(),
        actualItems
      };

      const updatedPO = await apiService.settlePO(po.id, settlementPayload, currentUser);
      await modalService.success(
        'บันทึกปิดยอดสำเร็จ',
        `ปิดยอดจ่ายจริง PO ${po.poNo || po.id} เรียบร้อยแล้ว${savingsAmount > 0 ? ` (คืนงบประมาณ ฿${savingsAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })})` : ''}`
      );

      if (onSuccess) onSuccess(updatedPO);
      if (onClose) onClose();
    } catch (err) {
      modalService.error('เกิดข้อผิดพลาดในการปิดยอด', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/70 backdrop-blur-xs animate-fade-in font-sans">
      <div className="bg-white w-full max-w-2xl rounded-2xl shadow-2xl border border-slate-200 flex flex-col max-h-[90vh] overflow-hidden">
        
        {/* Header */}
        <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center">
              <Receipt className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold tracking-tight text-white flex items-center gap-2">
                บันทึกยอดซื้อจริง & ปิดยอด (Online Settlement)
                <span className="text-xs font-mono font-normal text-emerald-400 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-500/30">
                  {po.poNo || po.id}
                </span>
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                ปรับปรุงยอดชำระจริงจากสลิป/ใบเสร็จ คืนเงินงบประมาณส่วนต่าง และคำนวณราคาทุนสต็อกอัตโนมัติ
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5 custom-scrollbar">
          
          {/* Comparison Cards: Approved vs Actual */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            
            {/* Approved Baseline */}
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
              <div className="text-xs font-medium text-slate-500 flex items-center gap-1.5 mb-1">
                <span>ยอดที่อนุมัติเดิม (Approved Grand Total)</span>
              </div>
              <div className="text-2xl font-black font-mono text-slate-800">
                ฿{originalTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div className="text-[11px] text-slate-400 mt-1 flex items-center gap-1">
                <span>ฝ่าย: {po.department || 'PD'}</span>
                <span>•</span>
                <span>{po.purchaseChannel === 'ONLINE' ? 'สั่งซื้อออนไลน์' : 'จัดซื้อ'}</span>
              </div>
            </div>

            {/* Actual Amount Input */}
            <div className="p-4 rounded-xl bg-emerald-50/50 border border-emerald-200">
              <div className="text-xs font-bold text-emerald-800 flex items-center justify-between mb-1">
                <span>ยอดชำระจริง / สลิปโอน (Actual Paid) *</span>
                <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-bold">
                  บาท (THB)
                </span>
              </div>
              <div className="relative mt-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-bold">฿</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  value={actualTotalInput}
                  onChange={(e) => setActualTotalInput(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 text-xl font-bold font-mono text-emerald-900 bg-white border border-emerald-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-600 transition-all"
                  placeholder="0.00"
                />
              </div>
            </div>
          </div>

          {/* Dynamic Reconciliation Summary Banner */}
          <div className={`p-4 rounded-xl border flex items-start gap-3 transition-all ${
            savingsAmount > 0 
              ? 'bg-emerald-50/90 border-emerald-200 text-emerald-900' 
              : savingsAmount < 0 
                ? 'bg-amber-50/90 border-amber-200 text-amber-900'
                : 'bg-slate-50 border-slate-200 text-slate-700'
          }`}>
            <div className="mt-0.5">
              {savingsAmount > 0 ? (
                <TrendingDown className="w-5 h-5 text-emerald-600" />
              ) : savingsAmount < 0 ? (
                <TrendingUp className="w-5 h-5 text-amber-600" />
              ) : (
                <CheckCircle2 className="w-5 h-5 text-slate-500" />
              )}
            </div>
            <div className="flex-1 text-xs leading-relaxed">
              {savingsAmount > 0 ? (
                <>
                  <div className="font-bold text-sm text-emerald-800 flex items-center gap-1.5">
                    <span>ประหยัดงบประมาณ: ฿{savingsAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    <span className="text-[10px] bg-emerald-600 text-white font-semibold px-2 py-0.5 rounded-full">
                      คืนงบประมาณอัตโนมัติ
                    </span>
                  </div>
                  <p className="mt-1 text-emerald-700">
                    ระบบจะบันทึก Transaction ประเภท <strong>BUDGET_ROLLBACK</strong> เพื่อคืนเงิน ฿{savingsAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })} เข้าโควตางบประมาณฝ่าย {po.department || 'PD'} ทันที
                  </p>
                </>
              ) : savingsAmount < 0 ? (
                <>
                  <div className="font-bold text-sm text-amber-800">
                    ยอดจ่ายจริงสูงกว่ายอดอนุมัติ: +฿{Math.abs(savingsAmount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                  <p className="mt-1 text-amber-700">
                    ยอดซื้อจริงสูงกว่า PO อนุมัติ (เช่น มีค่าจัดส่งเพิ่มเติม) กรุณาระบุเหตุผลในช่องหมายเหตุด้านล่าง
                  </p>
                </>
              ) : (
                <div className="font-medium text-slate-700">
                  ยอดจ่ายจริงตรงกับยอดที่อนุมัติใน PO (ไม่มีส่วนต่างงบประมาณ)
                </div>
              )}
            </div>
          </div>

          {/* Line Items Pricing Valuation Table */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                <Package className="w-3.5 h-3.5 text-slate-500" />
                การกระจายต้นทุนเข้าพัสดุ (Inventory Valuation)
              </span>
              <span className="text-[11px] text-slate-400">
                สัดส่วนต้นทุน: {(costRatio * 100).toFixed(1)}% ของราคาประเมิน
              </span>
            </div>

            <div className="border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-100/80 border-b border-slate-200 text-slate-600 font-semibold">
                  <tr>
                    <th className="py-2 px-3">รายการ</th>
                    <th className="py-2 px-2 text-center w-16">จำนวน</th>
                    <th className="py-2 px-2 text-right w-24">ราคาเดิม/หน่วย</th>
                    <th className="py-2 px-3 text-right w-32">ราคาทุนจริง/หน่วย</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(po.items || []).map((item, idx) => {
                    const basePrice = Number(item.price || item.unitPrice || item.estimatedPrice || 0);
                    const lineOverride = lineItems[idx]?.overrideUnitPrice;
                    const calculatedUnit = (lineOverride !== undefined && lineOverride !== '' && !isNaN(parseFloat(lineOverride)))
                      ? parseFloat(lineOverride)
                      : Math.round((basePrice * costRatio) * 100) / 100;

                    return (
                      <tr key={item.id || idx} className="hover:bg-slate-50/70">
                        <td className="py-2 px-3">
                          <div className="font-medium text-slate-800 truncate max-w-[220px]" title={item.name}>
                            {item.name}
                          </div>
                          <div className="text-[10px] font-mono text-slate-400">
                            {item.code || '-'}
                          </div>
                        </td>
                        <td className="py-2 px-2 text-center font-mono text-slate-700">
                          {item.qty || 1} {item.unit || ''}
                        </td>
                        <td className="py-2 px-2 text-right font-mono text-slate-500">
                          ฿{basePrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </td>
                        <td className="py-2 px-3 text-right">
                          <div className="flex items-center justify-end gap-1 font-mono font-bold text-emerald-700">
                            <span>฿</span>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={lineOverride !== undefined ? lineOverride : calculatedUnit.toFixed(2)}
                              onChange={(e) => handleLinePriceChange(idx, e.target.value)}
                              className="w-20 text-right py-0.5 px-1.5 border border-slate-200 rounded font-mono font-bold text-emerald-800 focus:outline-none focus:border-emerald-500 text-xs bg-white"
                              title="ปรับแก้ราคาต่อหน่วยจริงเฉพาะรายการนี้"
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Proof URL & Note */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                ลิงก์หลักฐาน / สลิปโอนเงิน (Proof URL)
              </label>
              <div className="relative">
                <input
                  type="url"
                  value={settlementProofUrl}
                  onChange={(e) => setSettlementProofUrl(e.target.value)}
                  placeholder="https://drive.google.com/... หรือ URL สลิป"
                  className="w-full text-xs px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 text-slate-800 placeholder:text-slate-400"
                />
                {settlementProofUrl && (
                  <a
                    href={settlementProofUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-indigo-600 hover:text-indigo-800"
                    title="เปิดดูหลักฐาน"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                หมายเหตุการปิดยอด (Settlement Note)
              </label>
              <input
                type="text"
                value={settlementNote}
                onChange={(e) => setSettlementNote(e.target.value)}
                placeholder="เช่น ได้โค้ดส่วนลด 50 บาท, รวมค่าส่ง 35 บาท"
                className="w-full text-xs px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 text-slate-800 placeholder:text-slate-400"
              />
            </div>
          </div>
        </form>

        {/* Sticky Footer */}
        <div className="px-6 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-200/70 rounded-xl transition-colors cursor-pointer"
          >
            ยกเลิก
          </button>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white text-xs font-bold rounded-xl flex items-center gap-2 cursor-pointer transition-all shadow-sm"
          >
            <ShieldCheck className="w-4 h-4" />
            <span>{isSubmitting ? 'กำลังบันทึก...' : 'ยืนยันปิดยอดจ่ายจริง'}</span>
          </button>
        </div>

      </div>
    </div>
  );
}
