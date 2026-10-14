import React from 'react';
import { createPortal } from 'react-dom';
import { PO_STATUS } from '../../config/constants';
import { Layers, X, Printer, ExternalLink, Building, DollarSign, Package, Info } from 'lucide-react';
import { storageService } from '../../services/storageService';

export default function POSplitModal({ pr, pos = [], onClose, onSelectPO }) {
  if (!pr) return null;

  // Filter POs created from this PR
  const allPOs = pos.length > 0 ? pos : (storageService.getPOs() || []);
  const splitPOs = allPOs.filter(po => !pr || po.prId === pr.id || po.prNo === pr.prNo || po.prId === pr.prNo || po.prNo === pr.id || pos.length > 0);

  const totalAmountAllPOs = splitPOs.reduce((sum, p) => sum + (p.grandTotal || p.subtotal || 0), 0);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs animate-fade-in print:hidden">
      <div className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-3xl bg-white shadow-2xl border border-slate-200/80 overflow-hidden text-slate-800 animate-zoom-in">
        
        {/* ── 1. Fixed Header (Sticky Top / Non-scrollable) ── */}
        <div className="shrink-0 px-6 py-4 border-b border-slate-100 bg-white flex items-center justify-between gap-4 sticky top-0 z-20">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 border border-indigo-100/80 flex items-center justify-center shadow-2xs shrink-0">
              <Layers className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-bold text-slate-900 text-base tracking-tight">
                  รายละเอียดการแยกใบสั่งซื้อ (Split PO Details)
                </h3>
                <span className="text-xs font-mono font-bold px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
                  {pr.prNo}
                </span>
              </div>
              <p className="text-xs text-slate-500 font-normal truncate mt-0.5">
                อ้างอิงใบขอซื้อ (PR): <span className="font-mono font-semibold text-slate-800">{pr?.prNo}</span> • ฝ่าย: <strong className="text-slate-800 font-semibold">{pr?.department}</strong>
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

        {/* ── Overview Summary Banner ── */}
        <div className="shrink-0 bg-indigo-50/70 border-b border-indigo-100 px-6 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-3 flex-wrap">
            <div>
              <span className="text-slate-500">จำนวนใบสั่งซื้อที่แยกออก:</span>{' '}
              <span className="font-bold text-slate-900 font-mono">{splitPOs.length} ใบ</span>
            </div>
            <div className="h-3 w-px bg-indigo-200"></div>
            <div>
              <span className="text-slate-500">ยอดรวมทุกใบ (Grand Total):</span>{' '}
              <span className="font-bold text-slate-900 font-mono text-sm">฿{totalAmountAllPOs.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            </div>
          </div>
          <span className="text-[11px] text-indigo-700 font-medium flex items-center gap-1">
            <Info className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
            <span>ระบบแยก PO อัตโนมัติตาม Supplier ของสินค้าแต่ละรายการ</span>
          </span>
        </div>

        {/* ── 2. Scrollable Content Body (Flex-1 / Dynamic Height) ── */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 min-h-0 custom-scrollbar bg-slate-50/30">
          {splitPOs.length === 0 ? (
            <div className="p-12 text-center text-slate-400">
              <Package className="w-10 h-10 stroke-[1.5] mx-auto text-slate-300 mb-2" />
              <p className="font-semibold text-slate-600 text-sm">ยังไม่มีรายการ PO สำหรับ PR ฉบับนี้</p>
              <p className="text-xs text-slate-400 mt-1">PO จะถูกสร้างอัตโนมัติเมื่อ PR ได้รับการอนุมัติ (Final Approval)</p>
            </div>
          ) : (
            splitPOs.map((po, index) => {
              const statusConfig = PO_STATUS[po.status] || { label: po.status, color: 'bg-slate-100 text-slate-700 border-slate-200' };
              
              return (
                <div key={po.id} className="bg-white border border-slate-200/90 rounded-2xl shadow-2xs overflow-hidden">
                  {/* PO Card Header */}
                  <div className="p-4 bg-slate-50/60 border-b border-slate-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="w-7 h-7 rounded-xl bg-indigo-600 text-white font-bold text-xs flex items-center justify-center shadow-2xs shrink-0 font-mono">
                        {index + 1}
                      </span>
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-bold text-slate-900 font-mono text-sm sm:text-base">{po.poNo}</h4>
                          <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-bold border ${statusConfig.color}`}>
                            {statusConfig.label}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5">
                          <Building className="w-3.5 h-3.5 text-slate-400" />
                          <span>ผู้ขาย: <strong className="text-slate-800 font-semibold">{po.vendorName}</strong></span>
                          {po.vendorId && po.vendorId !== 'ONLINE' && (
                            <span className="text-slate-400 font-mono text-[11px]">({po.vendorId})</span>
                          )}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 self-end sm:self-auto">
                      {onSelectPO && (
                        <button
                          type="button"
                          onClick={() => { onSelectPO(po.id); onClose(); }}
                          className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition-all shadow-2xs cursor-pointer flex items-center gap-1.5"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          <span>ดูรายละเอียด PO</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* PO Items Table */}
                  <div className="p-4">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-100 text-slate-400 font-semibold text-[11px]">
                          <th className="pb-2 pl-2">รายการสินค้า</th>
                          <th className="pb-2 text-right">จำนวน</th>
                          <th className="pb-2 text-right">ราคาต่อหน่วย</th>
                          <th className="pb-2 text-right pr-2">ราคารวม</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-slate-700 font-medium">
                        {(po.items || []).map((item, idx) => (
                          <tr key={idx}>
                            <td className="py-2 pl-2 font-semibold text-slate-900">{item.name}</td>
                            <td className="py-2 text-right font-mono tabular-nums">{item.qty || item.quantity} {item.unit || item.stockUnit || 'ชิ้น'}</td>
                            <td className="py-2 text-right font-mono tabular-nums">฿{(item.price || item.unitPrice || 0).toLocaleString()}</td>
                            <td className="py-2 text-right pr-2 font-mono font-bold text-slate-900 tabular-nums">฿{((item.qty || item.quantity || 0) * (item.price || item.unitPrice || 0)).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between text-xs">
                      <span className="text-slate-400 font-mono text-[11px]">ออกเมื่อ: {po.issuedDate || po.createdAt || '-'}</span>
                      <div className="text-right">
                        <span className="text-slate-500 font-medium">ยอดรวม PO ใบนี้: </span>
                        <span className="font-mono font-bold text-slate-900 text-sm tabular-nums">฿{(po.grandTotal || po.subtotal || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* ── 3. Sticky Action Footer (Non-scrollable) ── */}
        <div className="shrink-0 px-6 py-4 bg-slate-50/80 border-t border-slate-100 flex items-center justify-between gap-3 sticky bottom-0 z-20">
          <span className="text-xs text-slate-500 font-medium">
            รวม {splitPOs.length} ใบสั่งซื้อย่อย
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 text-xs font-bold transition-all cursor-pointer"
          >
            ปิดหน้าต่าง
          </button>
        </div>

      </div>
    </div>,
    document.body
  );
}
