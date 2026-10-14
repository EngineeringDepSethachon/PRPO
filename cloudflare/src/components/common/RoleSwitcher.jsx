import React from 'react';
import { ROLES } from '../../config/constants';
import { Shield } from 'lucide-react';

export default function RoleSwitcher({ currentRole, onRoleChange }) {
  return (
    <div className="flex items-center gap-1.5 bg-slate-800 text-slate-100 px-3 py-1.5 rounded-sm border border-slate-700 shadow-sm">
      <Shield className="w-4 h-4 text-amber-400 shrink-0" />
      <span className="text-sm text-slate-400 font-medium hidden sm:inline whitespace-nowrap">สลับบทบาท:</span>
      <select
        value={currentRole.id}
        onChange={(e) => {
          const selected = Object.values(ROLES).find(r => r.id === e.target.value);
          if (selected) onRoleChange(selected);
        }}
        className="bg-slate-900 text-amber-300 font-semibold text-sm py-1 px-2.5 rounded-sm border border-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-400 cursor-pointer"
      >
        {Object.values(ROLES).map(role => (
          <option key={role.id} value={role.id}>
            {role.title} — ({role.name})
          </option>
        ))}
      </select>
    </div>
  );
}
