import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, AlertTriangle, X, Check, ArrowRight, Layers, Package, MapPin } from 'lucide-react';
import { apiService } from '../../services/apiService';
import { modalService } from '../../services/modalService';

export default function DeleteLocationModal({
  location,
  products = [],
  storageLocations = [],
  currentRole,
  onClose,
  onDeleted
}) {

  // Find all products currently assigned to this location
  const assignedProducts = useMemo(() => {
    return products.filter(p => p.locationId === location.id);
  }, [products, location]);

  const hasAssigned = assignedProducts.length > 0;

  // Other available locations to reassign to
  const otherLocations = useMemo(() => {
    return storageLocations.filter(l => l.id !== location.id);
  }, [storageLocations, location]);

  const [resolutionMode, setResolutionMode] = useState(otherLocations.length > 0 ? 'REASSIGN' : 'UNLINK'); // 'REASSIGN' | 'UNLINK'
  const [targetLocationId, setTargetLocationId] = useState(otherLocations[0]?.id || '');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState('');

  if (!location) return null;

  const handleDelete = async () => {
    setError('');
    setIsDeleting(true);

    try {
      let options = {};
      if (hasAssigned) {
        if (resolutionMode === 'REASSIGN') {
          if (!targetLocationId) {
            setError('กรุณาเลือกจุดจัดเก็บปลายทางที่ต้องการย้ายสินค้าไป');
            setIsDeleting(false);
            return;
          }
          options = { reassignToLocationId: targetLocationId };
        } else {
          options = { unlinkProducts: true };
        }
      }

      await apiService.deleteStorageLocation(location.id, options, `${currentRole.name} (${currentRole.title})`);

      modalService.success(
        'ลบจุดจัดเก็บสำเร็จ',
        hasAssigned
          ? (resolutionMode === 'REASSIGN'
              ? `ย้ายสินค้า ${assignedProducts.length} รายการ และลบจุดจัดเก็บ "${location.name}" เรียบร้อยแล้ว`
              : `ปลดสินค้า ${assignedProducts.length} รายการ และลบจุดจัดเก็บ "${location.name}" เรียบร้อยแล้ว`)
          : `ลบจุดจัดเก็บ "${location.name}" เรียบร้อยแล้ว`
      );

      if (onDeleted) onDeleted(location.id);
      onClose();
    } catch (err) {
      setError(err.message || 'เกิดข้อผิดพลาดในการลบจุดจัดเก็บ');
    } finally {
      setIsDeleting(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs animate-fade-in print:hidden">
      <div className="w-full max-w-lg rounded-3xl bg-white shadow-2xl border border-slate-200/80 overflow-hidden text-slate-800 animate-zoom-in">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-100 bg-white flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-rose-50 text-rose-600 border border-rose-100 flex items-center justify-center shadow-2xs shrink-0">
              <Trash2 className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-slate-900 text-base tracking-tight">
                ยืนยันการลบจุดจัดเก็บสินค้า
              </h3>
              <p className="text-xs text-slate-500 font-normal truncate mt-0.5">
                {location.name}
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

        {/* Content Body */}
        <div className="p-6 space-y-4 bg-slate-50/30">
          {error && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-2xl flex items-center gap-2 text-rose-700 text-xs font-semibold">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {!hasAssigned ? (
            /* Scenario 1: Clean Delete (No products attached) */
            <div className="bg-white border border-slate-200/80 rounded-2xl p-5 space-y-3 shadow-2xs text-center">
              <div className="w-12 h-12 rounded-2xl bg-rose-50 text-rose-600 mx-auto flex items-center justify-center border border-rose-100 shadow-2xs">
                <Trash2 className="w-6 h-6" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-800">
                  คุณต้องการลบจุดจัดเก็บ <b className="text-slate-900">"{location.name}"</b> ใช่หรือไม่?
                </p>
                <p className="text-xs text-slate-500 mt-1 font-normal">
                  ไม่มีสินค้าผูกอยู่กับจุดเก็บนี้ ข้อมูลจะถูกลบออกจากระบบทันที
                </p>
              </div>
            </div>
          ) : (
            /* Scenario 2: Products attached - Interactive Resolution */
            <div className="space-y-4">
              <div className="bg-amber-50/90 border border-amber-200 rounded-2xl p-4 flex items-start gap-3 shadow-2xs">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-xs text-amber-950 min-w-0">
                  <div className="font-bold text-amber-900 text-sm">
                    มีสินค้าผูกอยู่กับจุดเก็บนี้ {assignedProducts.length} รายการ
                  </div>
                  <p className="mt-0.5 text-amber-800 font-normal">
                    กรุณาเลือกวิธีการจัดการสินค้าก่อนทำการลบจุดจัดเก็บ
                  </p>
                </div>
              </div>

              {/* Preview of Assigned Products */}
              <div className="bg-white border border-slate-200/80 rounded-2xl p-3.5 shadow-2xs space-y-2">
                <div className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <Package className="w-3.5 h-3.5 text-indigo-600" />
                  <span>ตัวอย่างสินค้าที่ผูกอยู่:</span>
                </div>
                <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto custom-scrollbar pr-1">
                  {assignedProducts.slice(0, 6).map(p => (
                    <span
                      key={p.id}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-slate-100 text-slate-700 border border-slate-200"
                    >
                      <span className="font-mono font-bold text-indigo-700">[{p.code}]</span>
                      <span className="truncate max-w-[140px]">{p.name}</span>
                    </span>
                  ))}
                  {assignedProducts.length > 6 && (
                    <span className="inline-flex items-center px-2 py-1 rounded-lg text-[11px] font-semibold text-slate-500 bg-slate-50 border border-slate-200">
                      +{assignedProducts.length - 6} รายการเพิ่มเติม
                    </span>
                  )}
                </div>
              </div>

              {/* Resolution Radio Cards */}
              <div className="space-y-2.5">
                {otherLocations.length > 0 && (
                  <label
                    onClick={() => setResolutionMode('REASSIGN')}
                    className={`p-3.5 rounded-2xl border flex items-start gap-3 cursor-pointer transition-all ${
                      resolutionMode === 'REASSIGN'
                        ? 'bg-indigo-50/60 border-indigo-300 ring-2 ring-indigo-500/20 shadow-2xs'
                        : 'bg-white border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="resolution"
                      checked={resolutionMode === 'REASSIGN'}
                      onChange={() => setResolutionMode('REASSIGN')}
                      className="mt-1 text-indigo-600 focus:ring-indigo-500"
                    />
                    <div className="flex-1 min-w-0 space-y-2">
                      <div>
                        <div className="font-bold text-slate-900 text-xs">
                          ย้ายสินค้าทั้งหมด ({assignedProducts.length} รายการ) ไปยังจุดจัดเก็บอื่น
                        </div>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          อัปเดตจุดเก็บใหม่ให้กับสินค้าทุกตัว แล้วลบจุดเก็บนี้
                        </p>
                      </div>

                      {resolutionMode === 'REASSIGN' && (
                        <div className="pt-1">
                          <label className="text-[11px] font-bold text-slate-700 mb-1 block">
                            เลือกจุดจัดเก็บปลายทาง:
                          </label>
                          <select
                            value={targetLocationId}
                            onChange={e => setTargetLocationId(e.target.value)}
                            className="w-full h-10 px-3 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 shadow-2xs cursor-pointer"
                          >
                            {otherLocations.map(l => (
                              <option key={l.id} value={l.id}>
                                📍 {l.name} ({l.department === 'ALL' ? 'ส่วนกลาง' : l.department})
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  </label>
                )}

                <label
                  onClick={() => setResolutionMode('UNLINK')}
                  className={`p-3.5 rounded-2xl border flex items-start gap-3 cursor-pointer transition-all ${
                    resolutionMode === 'UNLINK'
                      ? 'bg-rose-50/60 border-rose-300 ring-2 ring-rose-500/20 shadow-2xs'
                      : 'bg-white border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="resolution"
                    checked={resolutionMode === 'UNLINK'}
                    onChange={() => setResolutionMode('UNLINK')}
                    className="mt-1 text-rose-600 focus:ring-rose-500"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-slate-900 text-xs">
                      ปลดจุดจัดเก็บออกจากสินค้าทั้งหมด ({assignedProducts.length} รายการ)
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      ตั้งค่าสินค้าเป็น "ยังไม่ระบุจุดจัดเก็บ" แล้วลบจุดเก็บนี้ทันที
                    </p>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isDeleting}
              className="px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 text-xs font-bold transition-all cursor-pointer disabled:opacity-50"
            >
              ยกเลิก
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={isDeleting}
              className="px-5 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow-sm transition-all flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Trash2 className="w-4 h-4" />
              <span>{isDeleting ? 'กำลังลบ...' : (hasAssigned ? 'ยืนยันการลบและจัดการสินค้า' : 'ลบจุดจัดเก็บ')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
