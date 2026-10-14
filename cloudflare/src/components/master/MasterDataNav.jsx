import React from 'react';
import { Package, Store, MapPin, DoorClosed, Users, Building2 } from 'lucide-react';

export const MASTER_DATA_TABS = [
  { id: 'catalog', label: 'แคตตาล็อกสินค้า', adminOnly: false, icon: Package, iconColor: 'text-indigo-600', countKey: 'products' },
  { id: 'vendors', label: 'รายชื่อผู้ขาย / ร้านค้า', adminOnly: false, icon: Store, iconColor: 'text-emerald-600', countKey: 'vendors' },
  { id: 'locations', label: 'จุดจัดเก็บสินค้า', adminOnly: false, icon: MapPin, iconColor: 'text-violet-600', countKey: 'locations' },
  { id: 'rooms', label: 'หน่วยเบิกใช้งาน / ห้อง', adminOnly: false, icon: DoorClosed, iconColor: 'text-cyan-600', countKey: 'rooms' },
  { id: 'users', label: 'ผู้ใช้งานและสิทธิ์', adminOnly: true, icon: Users, iconColor: 'text-sky-600', countKey: 'users' },
  { id: 'departments', label: 'แผนก / ฝ่าย', adminOnly: true, icon: Building2, iconColor: 'text-blue-600', countKey: 'departments' },
];

export function normalizeTabId(tab) {
  if (!tab) return 'catalog';
  const t = String(tab).trim();
  if (t === 'products' || t === 'catalog') return 'catalog';
  if (t === 'usageUnits' || t === 'rooms') return 'rooms';
  if (['vendors', 'locations', 'users', 'departments'].includes(t)) return t;
  return 'catalog';
}

export function isTabActive(currentTab, tabId) {
  const normCurrent = normalizeTabId(currentTab);
  const normTarget = normalizeTabId(tabId);
  return normCurrent === normTarget;
}

export default function MasterDataNav({
  activeTab = 'catalog',
  onTabChange,
  isAdmin = false,
  counts = {}
}) {
  const visibleTabs = MASTER_DATA_TABS.filter(tab => !tab.adminOnly || isAdmin);

  return (
    <div 
      data-testid="master-data-nav"
      className="flex gap-1.5 bg-slate-100/80 p-1.5 rounded-2xl w-fit border border-slate-200/60 shadow-2xs overflow-x-auto custom-scrollbar"
    >
      {visibleTabs.map(tab => {
        const Icon = tab.icon;
        const active = isTabActive(activeTab, tab.id);
        const count = counts[tab.id] ?? counts[tab.countKey] ?? 0;

        return (
          <button
            key={tab.id}
            type="button"
            data-testid={`tab-${tab.id}`}
            aria-label={tab.label}
            aria-selected={active}
            onClick={() => onTabChange && onTabChange(tab.id)}
            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer whitespace-nowrap ${
              active
                ? 'bg-white text-slate-900 shadow-xs font-bold'
                : 'text-slate-600 hover:text-slate-900 hover:bg-white/50'
            }`}
          >
            <Icon className={`w-4 h-4 ${tab.iconColor}`} />
            <span>{tab.label}</span>
            <span className="px-1.5 py-0.5 rounded-full text-[11px] font-mono bg-slate-100 text-slate-600">
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
