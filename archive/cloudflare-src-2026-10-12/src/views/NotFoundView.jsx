import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FileQuestion, ArrowLeft, LayoutDashboard, Search } from 'lucide-react';

export default function NotFoundView() {
  const navigate = useNavigate();

  return (
    <div className="min-h-[75vh] flex flex-col items-center justify-center p-6 text-center animate-fade-in">
      {/* Decorative Icon */}
      <div className="w-20 h-20 rounded-2xl bg-indigo-50 border border-indigo-100 flex items-center justify-center text-indigo-600 mb-6 shadow-xs">
        <FileQuestion className="w-10 h-10" />
      </div>

      {/* Technical Status Badge */}
      <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-100 border border-slate-200 text-slate-700 font-mono text-xs font-bold mb-4">
        <span>HTTP 404</span>
        <span className="text-slate-400">•</span>
        <span>PAGE_NOT_FOUND</span>
      </div>

      {/* Headings */}
      <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight mb-2">
        ไม่พบหน้าที่ท่านต้องการ
      </h1>
      <p className="text-sm text-slate-500 max-w-md mx-auto mb-8 leading-relaxed">
        หน้านี้อาจถูกย้าย ลบออกไปแล้ว หรือท่านอาจพิมพ์ URL ไม่ถูกต้อง กรุณาตรวจสอบเส้นทางหรือกลับสู่หน้าหลัก
      </p>

      {/* Action Buttons */}
      <div className="flex flex-col sm:flex-row items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="w-full sm:w-auto px-5 py-2.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs sm:text-sm font-semibold transition-all shadow-2xs flex items-center justify-center gap-2 cursor-pointer active:scale-98"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>ย้อนกลับ (Go Back)</span>
        </button>

        <Link
          to="/dashboard"
          className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-xs sm:text-sm font-semibold transition-all shadow-xs flex items-center justify-center gap-2 cursor-pointer active:scale-98"
        >
          <LayoutDashboard className="w-4 h-4" />
          <span>กลับสู่หน้าภาพรวม (Dashboard)</span>
        </Link>
      </div>

      {/* Quick Links Help */}
      <div className="mt-12 pt-6 border-t border-slate-200/80 max-w-md w-full">
        <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-3">
          เมนูแนะนำ (Quick Shortcuts)
        </span>
        <div className="flex flex-wrap justify-center gap-2 text-xs">
          <Link to="/prs" className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium transition-colors">
            ใบขอซื้อ (PR)
          </Link>
          <Link to="/pos" className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium transition-colors">
            ใบสั่งซื้อ (PO)
          </Link>
          <Link to="/inventory/stock-card" className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium transition-colors">
            คลังสินค้า (Stock)
          </Link>
          <Link to="/my-workspace" className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium transition-colors">
            งานของฉัน (Workspace)
          </Link>
        </div>
      </div>
    </div>
  );
}
