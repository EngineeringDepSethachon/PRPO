import React from 'react';
import { Outlet } from 'react-router-dom';
import { Menu } from 'lucide-react';
import Sidebar from '../components/common/Sidebar';
import PRDetailsModal from '../components/pr/PRDetailsModal';
import PODetailsModal from '../components/po/PODetailsModal';
import FeedbackModal from '../components/common/FeedbackModal';
import { useAppContext } from '../context/AppContext';

export default function MainLayout() {
  const {
    currentRole,
    currentUser,
    prs,
    pos,
    isMobileSidebarOpen,
    setIsMobileSidebarOpen,
    onNavigate,
    handleOpenPRById,
    handleOpenPOById,
    handleLogout,
    refreshData,
    selectedPRForModal,
    setSelectedPRForModal,
    selectedPOForModal,
    setSelectedPOForModal,
    handleEditPR
  } = useAppContext();

  return (
    <div className="min-h-screen flex flex-row overflow-hidden bg-slate-50 font-sans text-slate-900">
      {/* ── Fixed Sidebar Menu (Desktop) & Overlay Drawer (Mobile) with integrated Notifications & Profile ── */}
      <Sidebar
        currentRole={currentRole}
        currentUser={currentUser}
        prs={prs}
        pos={pos}
        isMobileOpen={isMobileSidebarOpen}
        onCloseMobile={() => setIsMobileSidebarOpen(false)}
        onNavigate={onNavigate}
        onOpenPR={handleOpenPRById}
        onOpenPO={handleOpenPOById}
        onLogout={handleLogout}
        onRefresh={refreshData}
      />

      {/* Floating Mobile Menu Button (Minimal non-intrusive button without white header strip) */}
      <button 
        onClick={() => setIsMobileSidebarOpen(true)}
        className="md:hidden fixed top-3 left-3 z-30 p-2 text-slate-700 bg-white/90 backdrop-blur-md hover:text-indigo-600 hover:bg-white rounded-xl transition-all cursor-pointer shadow-sm border border-slate-200/80 active:scale-95 no-print"
        aria-label="Open Navigation Menu"
        title="เปิดเมนูการใช้งาน"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* ── Main Content Area (Clean layout starting directly from top edge) ── */}
      <div className="flex-1 flex flex-col min-w-0 md:ml-64 transition-all duration-300">
        {/* Dynamic Content View Area with maximized vertical space */}
        <main className="flex-1 p-4 sm:p-6 lg:p-8 w-full max-w-full mx-auto">
          <Outlet />
        </main>
      </div>

      {/* Global Deep-Linked PR Details Modal */}
      {selectedPRForModal && (
        <PRDetailsModal
          selectedPR={prs.find(p => p.id === selectedPRForModal.id) || selectedPRForModal}
          currentRole={currentRole}
          onClose={() => setSelectedPRForModal(null)}
          onRefresh={refreshData}
          onEditPR={handleEditPR}
        />
      )}

      {/* Global Deep-Linked PO Details Modal */}
      {selectedPOForModal && (
        <PODetailsModal
          selectedPO={pos.find(p => p.id === selectedPOForModal.id) || selectedPOForModal}
          currentRole={currentRole}
          onClose={() => setSelectedPOForModal(null)}
          onRefresh={refreshData}
        />
      )}

      {/* Global In-App Feedback & Alert Modal System */}
      <FeedbackModal />
    </div>
  );
}
