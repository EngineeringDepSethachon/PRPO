import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw, X, Tag, AlertTriangle, XCircle } from 'lucide-react';

export const REVISION_PRESETS = [
  'สเปกไม่ชัดเจน',
  'งบประมาณไม่พอ',
  'มีสต็อกในคลัง',
  'ราคาผิดปกติ',
  'เอกสารแนบไม่ครบถ้วน',
  'จำนวนสั่งซื้อไม่เหมาะสม'
];

export default function RejectPRModal({
  isOpen,
  onClose,
  onConfirm,
  initialReason = '',
  pr = {}
}) {
  const [reason, setReason] = useState('');
  const [selectedPreset, setSelectedPreset] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Sync initialReason whenever the modal opens
  useEffect(() => {
    if (isOpen) {
      setReason(initialReason || '');
      setSelectedPreset('');
      setIsSubmitting(false);
    }
  }, [isOpen, initialReason]);

  if (!isOpen) return null;

  const handleSelectPreset = (preset) => {
    setSelectedPreset(preset);
    if (!reason.trim()) {
      setReason(preset);
    } else if (!reason.includes(preset)) {
      setReason(prev => `${prev.trim()} / ${preset}`);
    }
  };

  const handleConfirm = async () => {
    const trimmed = reason.trim();
    if (!trimmed || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onConfirm(trimmed);
    } finally {
      setIsSubmitting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
      <div 
        className="fixed inset-0" 
        onClick={() => !isSubmitting && onClose()} 
      />
      <div className="relative w-full max-w-lg bg-white rounded-3xl shadow-2xl border border-rose-100 overflow-hidden z-10 animate-scale-in">
        
        {/* Header Strip */}
        <div className="bg-rose-50/80 px-6 py-4 border-b border-rose-100 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-rose-100/90 border border-rose-200 text-rose-600 flex items-center justify-center shadow-2xs">
              <RotateCcw className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <span>ระบุเหตุผลการส่งกลับแก้ไข</span>
                {pr.prNo && (
                  <span className="text-xs font-mono font-semibold text-rose-600 bg-rose-100/70 px-2 py-0.5 rounded-full border border-rose-200/60">
                    {pr.prNo}
                  </span>
                )}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Send Back for Revision • แจ้งเตือนไปยัง {pr.requestedBy || 'ผู้ขอซื้อ'}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-1.5 rounded-xl hover:bg-white/80 transition-colors cursor-pointer"
            title="ปิดหน้าต่าง"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-4">
          
          {/* Information banner */}
          <div className="p-3 bg-amber-50/60 border border-amber-200/70 rounded-xl text-xs text-amber-800 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <span>ระบบจะบันทึกเหตุผลนี้ลงในประวัติการอนุมัติ (Approval History) และส่งใบขอซื้อกลับให้ผู้ขอซื้อนำไปปรับปรุงแก้ไข</span>
          </div>

          {/* Quick Presets */}
          <div className="space-y-2">
            <span className="text-xs font-bold text-slate-700 block">แท็กเหตุผลด่วน (Quick Presets):</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {REVISION_PRESETS.map((preset) => {
                const isSelected = selectedPreset === preset || reason.includes(preset);
                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => handleSelectPreset(preset)}
                    className={`px-3 py-1 rounded-full text-xs transition-all cursor-pointer border flex items-center gap-1.5 ${
                      isSelected
                        ? 'bg-rose-50 text-rose-700 border-rose-300 font-semibold shadow-2xs ring-1 ring-rose-300'
                        : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-white hover:border-slate-300 hover:text-slate-900'
                    }`}
                  >
                    <Tag className="w-3 h-3 text-rose-500 opacity-80" />
                    <span>{preset}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Reason Textarea */}
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-slate-700 block">
              รายละเอียดเหตุผลการส่งกลับ: <span className="text-rose-500">*</span>
            </label>
            <textarea
              rows={4}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="พิมพ์รายละเอียดหรือคำแนะนำเพิ่มเติมที่ต้องการให้ผู้ขอซื้อแก้ไข..."
              className="w-full bg-white border border-slate-300 rounded-2xl p-3.5 text-xs sm:text-sm text-slate-800 placeholder-slate-400 focus:ring-2 focus:ring-rose-500/20 focus:border-rose-500 outline-none transition-all shadow-inner resize-none"
              autoFocus
            />
            <div className="flex items-center justify-between text-[11px] text-slate-400 px-1">
              <span>* จำเป็นต้องระบุเหตุผลเพื่อประกอบการส่งกลับ</span>
              <span className="font-mono">{reason.length} ตัวอักษร</span>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="bg-slate-50 px-6 py-4 border-t border-slate-100 flex items-center justify-end gap-2.5">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={onClose}
            className="px-4 py-2 bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 text-xs sm:text-sm font-semibold rounded-xl transition-all cursor-pointer shadow-2xs"
          >
            ยกเลิก
          </button>
          <button
            type="button"
            disabled={!reason.trim() || isSubmitting}
            onClick={handleConfirm}
            className={`px-5 py-2 bg-rose-600 hover:bg-rose-700 text-white text-xs sm:text-sm font-semibold rounded-xl transition-all flex items-center gap-2 shadow-xs cursor-pointer ${
              !reason.trim() || isSubmitting ? 'opacity-50 cursor-not-allowed' : 'active:scale-95'
            }`}
          >
            <XCircle className="w-4 h-4" />
            <span>{isSubmitting ? 'กำลังส่งกลับ...' : 'ยืนยันการส่งกลับ'}</span>
          </button>
        </div>

      </div>
    </div>,
    document.body
  );
}
