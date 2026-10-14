import React from 'react';
import { FileSearch } from 'lucide-react';

export default function EmptyState({ title = 'ไม่พบข้อมูล', description = 'ยังไม่มีข้อมูลในส่วนนี้ หรือลองเปลี่ยนเงื่อนไขการค้นหา', icon: Icon = FileSearch, actionButton = null }) {
  return (
    <div className="w-full py-16 flex flex-col items-center justify-center text-center space-y-4 animate-zoom-in">
      <div className="w-20 h-20 bg-white text-slate-300 rounded-full flex items-center justify-center mb-2 shadow-sm border border-slate-100">
        <Icon className="w-10 h-10" />
      </div>
      <div>
        <h3 className="text-lg font-bold text-slate-700">{title}</h3>
        <p className="text-sm text-slate-500 mt-1 max-w-sm mx-auto">{description}</p>
      </div>
      {actionButton && (
        <div className="pt-2">
          {actionButton}
        </div>
      )}
    </div>
  );
}
