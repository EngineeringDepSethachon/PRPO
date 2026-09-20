import React, { useMemo } from 'react';
import { Menu } from 'lucide-react';
import UserProfileModal from './UserProfileModal';
import { useAppContext } from '../../context/AppContext';
import { workflowEngine } from '../../services/workflowEngine';

/**
 * @deprecated Navbar is kept for backward compatibility if any legacy component imports it.
 * The primary layout now uses Sidebar-integrated Notification & User Profile without a top banner.
 */
export default function Navbar({ 
  currentRole, 
  onNavigate, 
  onOpenPR, 
  onOpenPO, 
  onLogout,
  onRefresh,
  onToggleMobileSidebar
}) {
  const [showProfileModal, setShowProfileModal] = React.useState(false);

  const context = useAppContext();
  const prs = context?.prs;
  const pos = context?.pos;
  const taskCounts = useMemo(() => {
    if (!prs && !pos) return null;
    const userTasks = workflowEngine.getUserTasks(currentRole, prs, pos);
    return userTasks.counts;
  }, [prs, pos, currentRole]);

  return (
    <header className="bg-white border-b border-slate-200/80 sticky top-0 z-30 no-print">
      <div className="w-full px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3 overflow-hidden">
          <button 
            onClick={onToggleMobileSidebar}
            className="md:hidden p-2 -ml-1 text-slate-700 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all cursor-pointer active:scale-95 shrink-0"
            aria-label="Open Navigation Menu"
            title="เปิดเมนูการใช้งาน"
          >
            <Menu className="w-5 h-5" />
          </button>
          
          <div className="overflow-hidden">
            <div className="flex items-center gap-2">
              <h2 className="font-bold text-slate-900 text-sm sm:text-base truncate tracking-tight">
                <span className="sm:hidden">ระบบ PR/PO & คลัง</span>
                <span className="hidden sm:inline">ระบบขอซื้อและคลังสินค้า (PR/PO & Inventory)</span>
              </h2>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">

          <button
            onClick={() => setShowProfileModal(true)}
            className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-full hover:bg-slate-50 border border-transparent hover:border-slate-200/60 transition-all text-xs group cursor-pointer"
          >
            <span className="font-bold text-slate-900">{currentRole?.name || 'User'}</span>
          </button>
        </div>
      </div>

      <UserProfileModal
        isOpen={showProfileModal}
        onClose={() => setShowProfileModal(false)}
        currentRole={currentRole}
        onLogout={onLogout}
      />
    </header>
  );
}
