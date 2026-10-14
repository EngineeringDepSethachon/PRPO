import React, { useState, useEffect, useMemo } from 'react';
import { X, SendToBack, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { apiService } from '../../services/apiService';

const DEFAULT_REASONS = [
  'เบิกใช้ในสายการผลิต (Production Line)',
  'เบิกสำหรับสุ่มทดสอบ QC / Lab Test',
  'เบิกสำหรับงานซ่อมบำรุง (Maintenance / PM)',
  'เบิกใช้ทั่วไปภายในแผนก',
  'ปรับปรุงยอดสินค้าชำรุด / เสื่อมสภาพ',
  'อื่นๆ (ระบุในหมายเหตุ)'
];

export default function FastIssueModal({
  isOpen,
  onClose,
  product,
  usageUnits = [],
  onSuccess,
  onIssueStock,
  currentRole,
  currentUser
}) {
  const [quantity, setQuantity] = useState(1);
  const [issuedTo, setIssuedTo] = useState('');
  const [reason, setReason] = useState(DEFAULT_REASONS[0]);
  const [note, setNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const user = currentUser || currentRole;

  useEffect(() => {
    if (isOpen) {
      setQuantity(1);
      setIssuedTo('');
      setReason(DEFAULT_REASONS[0]);
      setNote('');
      setErrorMsg('');
      setSuccessMsg('');
    }
  }, [isOpen, product]);

  const currentBalance = Number(product?.stockBalance || 0);
  const unit = product?.stockUnit || product?.unit || 'ชิ้น';
  const qtyNumber = Number(quantity || 0);
  const postBalance = Math.round((currentBalance - qtyNumber) * 10000) / 10000;

  const filteredUnits = useMemo(() => {
    if (!Array.isArray(usageUnits)) return [];
    if (!product?.department && !product?.category) return usageUnits;
    const pDept = product.department || product.category;
    return usageUnits.filter(u => !u.department || u.department === pDept || u.department === 'ALL');
  }, [usageUnits, product]);

  if (!isOpen || !product) return null;

  const handleSubmit = async (e) => {
    e?.preventDefault();
    setErrorMsg('');
    setSuccessMsg('');

    if (qtyNumber <= 0) {
      return setErrorMsg('จำนวนที่ต้องการเบิกต้องมากกว่า 0');
    }

    if (currentBalance < qtyNumber) {
      return setErrorMsg(`จำนวนที่ขอเบิก (${qtyNumber} ${unit}) เกินกว่ายอดคงเหลือ (${currentBalance} ${unit})`);
    }

    setIsSubmitting(true);
    try {
      const fullNote = `${reason}${note.trim() ? ` — ${note.trim()}` : ''}`;
      const payload = {
        productId: product.id,
        productCode: product.code,
        department: product.department || product.category || user?.department || 'PD',
        quantity: qtyNumber,
        issuedTo: issuedTo || 'หน่วยงานทั่วไป',
        reason: fullNote,
        requesterId: user?.id || user?.username,
        requesterName: user?.name,
        user
      };

      let result;
      if (onIssueStock) {
        result = await onIssueStock(payload);
      } else {
        result = await apiService.issueStock(payload);
      }

      setSuccessMsg(`เบิกจ่ายสำเร็จ! ยอดคงเหลือ: ${postBalance} ${unit}`);
      if (onSuccess) {
        onSuccess(result || payload);
      }
      setTimeout(() => {
        onClose?.();
      }, 700);
    } catch (err) {
      setErrorMsg(err.message || 'เกิดข้อผิดพลาดในการเบิกจ่าย');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
      <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl border border-slate-200 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-100 bg-slate-50/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-amber-100 text-amber-600 flex items-center justify-center shadow-2xs">
              <SendToBack className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-800">เบิกจ่ายสินค้าด่วน (Fast Issue)</h3>
              <p className="text-xs text-slate-500 font-mono mt-0.5">{product.code} - {product.name}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {errorMsg && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 font-medium flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 text-rose-500" />
              <span>{errorMsg}</span>
            </div>
          )}

          {successMsg && (
            <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-700 font-medium flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-500" />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Current Stock Banner */}
          <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200/80 flex items-center justify-between">
            <div>
              <span className="text-xs text-slate-400 font-bold block uppercase">สต็อกคงเหลือปัจจุบัน</span>
              <span className="text-xl font-bold text-slate-800 tabular-nums">
                {currentBalance.toLocaleString()} <span className="text-xs font-normal text-slate-500">{unit}</span>
              </span>
            </div>
            <div className="text-right">
              <span className="text-xs text-slate-400 font-bold block uppercase">คงเหลือหลังเบิก</span>
              <span className={`text-xl font-bold tabular-nums ${postBalance < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                {postBalance.toLocaleString()} <span className="text-xs font-normal text-slate-500">{unit}</span>
              </span>
            </div>
          </div>

          {/* Quantity */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              จำนวนที่ต้องการเบิก ({unit}) <span className="text-rose-500">*</span>
            </label>
            <input
              type="number"
              min="0.01"
              max={currentBalance}
              step="any"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none text-sm font-bold text-slate-800"
            />
          </div>

          {/* Issued To (Unit / Room) */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">หน่วยงาน / ห้องที่เบิกไปใช้</label>
            {filteredUnits.length > 0 ? (
              <select
                value={issuedTo}
                onChange={(e) => setIssuedTo(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none text-sm text-slate-800 bg-white"
              >
                <option value="">-- เลือกหน่วยงาน / พื้นที่ใช้งาน --</option>
                {filteredUnits.map((u) => (
                  <option key={u.id || u.name} value={u.name}>{u.name}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                placeholder="เช่น ห้อง K1, ฝ่ายผลิตไลน์ A"
                value={issuedTo}
                onChange={(e) => setIssuedTo(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none text-sm text-slate-800"
              />
            )}
          </div>

          {/* Reason */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">วัตถุประสงค์การเบิก</label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none text-sm text-slate-800 bg-white"
            >
              {DEFAULT_REASONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>

          {/* Note */}
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">หมายเหตุเพิ่มเติม</label>
            <input
              type="text"
              placeholder="ระบุรายละเอียดเพิ่มเติม (ถ้ามี)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full px-4 py-2.5 rounded-xl border border-slate-200 focus:border-amber-500 focus:ring-2 focus:ring-amber-200 outline-none text-sm text-slate-800"
            />
          </div>

          {/* Footer Actions */}
          <div className="pt-4 flex items-center justify-end gap-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl transition-colors"
            >
              ยกเลิก
            </button>
            <button
              type="submit"
              disabled={isSubmitting || qtyNumber <= 0 || currentBalance < qtyNumber}
              className="px-5 py-2.5 bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-xs font-bold rounded-xl shadow-xs transition-all flex items-center gap-1.5"
            >
              {isSubmitting ? 'กำลังตัดสต็อก...' : 'ยืนยันตัดสต็อก'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
