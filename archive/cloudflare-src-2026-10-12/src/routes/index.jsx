import React from 'react';
import { createHashRouter, Navigate, Outlet } from 'react-router-dom';
import { AppProvider, useAppContext } from '../context/AppContext';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { ProcurementProvider } from '../context/ProcurementContext';
import { BudgetProvider } from '../context/BudgetContext';
import { InventoryProvider } from '../context/InventoryContext';
import MainLayout from '../layouts/MainLayout';
import LoginView from '../views/auth/LoginView';
import ProtectedRoute from '../components/common/ProtectedRoute';

// View Imports
import DashboardView from '../views/DashboardView';
import MyWorkView from '../views/MyWorkView';
import PRListView from '../views/PRListView';
import PRCreateView from '../views/PRCreateView';
import POListView from '../views/POListView';
import StockCardView from '../views/StockCardView';
import QuickIssueView from '../views/QuickIssueView';
import BudgetView from '../views/BudgetView';
import MasterDataView from '../views/MasterDataView';
import OnlineTaskView from '../views/OnlineTaskView';
import UserMasterView from '../views/admin/UserMasterView';
import AuditLogView from '../views/admin/AuditLogView';

// Technical Loading Screen during initial session hydration
function AppLoadingScreen() {
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4">
      <div className="w-12 h-12 rounded-xl bg-indigo-600 flex items-center justify-center text-white mb-4 animate-pulse shadow-lg shadow-indigo-600/30">
        <svg className="animate-spin h-6 w-6 text-white" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
      </div>
      <p className="text-xs font-semibold text-slate-400 font-mono tracking-wider uppercase">
        กำลังโหลดระบบ PR/PO & Inventory...
      </p>
    </div>
  );
}

// Root Layout wrapping the router with AuthProvider, AppProvider, and domain providers
function AppRootLayout() {
  return (
    <AuthProvider>
      <AppProvider>
        <ProcurementProvider>
          <BudgetProvider>
            <InventoryProvider>
              <Outlet />
            </InventoryProvider>
          </BudgetProvider>
        </ProcurementProvider>
      </AppProvider>
    </AuthProvider>
  );
}

// Direct Layout with session validation (Non-blocking rendering)
function DirectAppLayout() {
  const auth = useAuth();

  // Only show full-screen spinner if auth is actively initializing and we have no cached session
  if (auth?.isLoading && !auth?.currentUser) {
    return <AppLoadingScreen />;
  }

  // If user is not authenticated, redirect to /login
  if (!auth?.isAuthenticated && !auth?.currentUser) {
    return <Navigate to="/login" replace />;
  }

  return <MainLayout />;
}

// Role-based Guard for protected sub-paths
function RoleGuard({ allowed, children, fallback = '/dashboard' }) {
  const { currentRole } = useAppContext();
  if (!allowed(currentRole)) {
    return <Navigate to={fallback} replace />;
  }
  return children;
}

// Root Index Redirect: Always redirect root path / to /dashboard
function RootIndexRedirect() {
  return <Navigate to="/dashboard" replace />;
}

// Safe Fallback Route: Redirects unauthenticated users to /login, authenticated users to /dashboard (preventing 404 freeze)
function SafeFallbackRedirect() {
  const auth = useAuth();

  if (auth?.isLoading && !auth?.currentUser) {
    return <AppLoadingScreen />;
  }

  if (!auth?.isAuthenticated && !auth?.currentUser) {
    return <Navigate to="/login" replace />;
  }

  return <Navigate to="/dashboard" replace />;
}

// ── View Wrapper Components (Inject exact props from Context) ──

function DashboardRoute() {
  const { prs, pos, products, budgetSummary, currentRole, currentUser, onNavigate, handleQuickPR, handleOpenPRById, handleOpenPOById, isLoading, isDataLoading } = useAppContext();
  return (
    <DashboardView
      prs={prs}
      pos={pos}
      products={products}
      budgetSummary={budgetSummary?.current || budgetSummary}
      currentRole={currentRole}
      currentUser={currentUser || currentRole}
      onNavigate={onNavigate}
      onQuickPR={handleQuickPR}
      onOpenPR={handleOpenPRById}
      onOpenPO={handleOpenPOById}
      isLoading={isLoading || isDataLoading}
    />
  );
}

function MyWorkRoute() {
  const { prs, pos, products, vendors, currentRole, onNavigate, refreshData, handleEditPR } = useAppContext();
  return (
    <MyWorkView
      prs={prs}
      pos={pos}
      products={products}
      vendors={vendors}
      currentRole={currentRole}
      onNavigate={onNavigate}
      onRefresh={refreshData}
      onEditPR={handleEditPR}
    />
  );
}

function PRListRoute() {
  const { prs, currentRole, refreshData, onNavigate, handleEditPR, departments } = useAppContext();
  return (
    <PRListView
      prs={prs}
      currentRole={currentRole}
      departments={departments}
      onRefresh={refreshData}
      onNavigate={onNavigate}
      onEditPR={handleEditPR}
    />
  );
}

function PRCreateRoute() {
  const { products, inventory, departments, currentRole, onNavigate, refreshData, preselectedProduct, clearPreselectedProduct, editingPR, clearEditingPR, createPR, handleSavePR, updatePR } = useAppContext();
  return (
    <PRCreateView
      products={products}
      inventory={inventory}
      departments={departments}
      currentRole={currentRole}
      onNavigate={onNavigate}
      onRefresh={refreshData}
      preselectedProduct={preselectedProduct}
      clearPreselectedProduct={clearPreselectedProduct}
      editingPR={editingPR}
      clearEditingPR={clearEditingPR}
      createPR={createPR}
      handleSavePR={handleSavePR}
      updatePR={updatePR}
    />
  );
}

function POListRoute() {
  const { pos, products, vendors, currentRole, refreshData, departments } = useAppContext();
  return (
    <POListView
      pos={pos}
      products={products}
      vendors={vendors}
      currentRole={currentRole}
      departments={departments}
      onRefresh={refreshData}
    />
  );
}

function StockCardRoute() {
  const { products, storageLocations, stockLogs, pos, currentRole, handleQuickPR, refreshData, departments } = useAppContext();
  return (
    <StockCardView
      products={products}
      storageLocations={storageLocations}
      stockLogs={stockLogs}
      pos={pos}
      departments={departments}
      currentRole={currentRole}
      onQuickPR={handleQuickPR}
      onRefresh={refreshData}
    />
  );
}

function QuickIssueRoute() {
  const { products, stockLogs, currentRole, currentUser, usageUnits, departments, refreshData, handleIssueStock, onNavigate } = useAppContext();
  return (
    <QuickIssueView
      products={products}
      stockLogs={stockLogs}
      currentRole={currentRole}
      currentUser={currentUser}
      usageUnits={usageUnits}
      departments={departments}
      onRefresh={refreshData}
      onIssueStock={handleIssueStock}
      onNavigate={onNavigate}
    />
  );
}

function BudgetRoute() {
  const { budgetSummary, currentRole, currentUser, prs, pos, departments, refreshData } = useAppContext();
  const isOnlinePurchaser = Boolean(
    currentRole?.roleId === 'ONLINE_PURCHASER' || 
    currentRole?.id === 'ONLINE_PURCHASER' || 
    currentUser?.roleId === 'ONLINE_PURCHASER' ||
    currentUser?.id === 'ONLINE_PURCHASER'
  );
  return (
    <RoleGuard allowed={(role) => role?.canViewBudget || isOnlinePurchaser}>
      <BudgetView
        budgetSummary={budgetSummary}
        currentRole={currentRole}
        currentUser={currentUser}
        prs={prs}
        pos={pos}
        departments={departments}
        onRefresh={refreshData}
      />
    </RoleGuard>
  );
}

function MasterDataRoute() {
  const { 
    products, 
    vendors, 
    storageLocations, 
    usageUnits, 
    departments,
    users, 
    prs,
    pos,
    currentRole, 
    currentUser,
    refreshData, 
    deleteProduct,
    deleteVendor,
    saveProduct,
    saveVendor,
    saveUsageUnit, 
    deleteUsageUnit, 
    saveDepartment,
    deleteDepartment,
    saveUser, 
    deleteUser 
  } = useAppContext();

  return (
    <MasterDataView
      products={products}
      vendors={vendors}
      storageLocations={storageLocations}
      usageUnits={usageUnits}
      departments={departments}
      users={users}
      prs={prs}
      pos={pos}
      currentRole={currentRole}
      currentUser={currentUser}
      onRefresh={refreshData}
      onDeleteProduct={deleteProduct}
      onDeleteVendor={deleteVendor}
      onSaveProduct={saveProduct}
      onSaveVendor={saveVendor}
      onSaveUsageUnit={saveUsageUnit}
      onDeleteUsageUnit={deleteUsageUnit}
      onSaveDepartment={saveDepartment}
      onDeleteDepartment={deleteDepartment}
      onSaveUser={saveUser}
      onDeleteUser={deleteUser}
    />
  );
}

function OnlineTaskRoute() {
  const { currentRole, refreshData } = useAppContext();
  return (
    <RoleGuard allowed={(role) => role?.canOnlinePurchase}>
      <OnlineTaskView
        currentRole={currentRole}
        onRefresh={refreshData}
      />
    </RoleGuard>
  );
}

function UserMasterRoute() {
  const { users, departments, currentRole, currentUser, refreshData } = useAppContext();
  const isAdmin = currentUser?.role === 'admin' || 
                  currentUser?.roleId === 'ADMIN' || 
                  currentRole?.role === 'admin' || 
                  currentRole?.id === 'ADMIN';

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-6 bg-white rounded-3xl border border-slate-200 shadow-sm my-6">
        <div className="w-16 h-16 bg-rose-50 text-rose-500 rounded-2xl flex items-center justify-center mb-4 text-2xl font-bold">🔒</div>
        <h2 className="text-xl font-bold text-slate-800 mb-2">สิทธิ์การเข้าถึงถูกจำกัด (Restricted Access)</h2>
        <p className="text-sm text-slate-500 max-w-md">หน้าจัดการข้อมูลหลัก (Master Data) สงวนสิทธิ์สำหรับผู้ดูแลระบบ (System Admin) เท่านั้น</p>
      </div>
    );
  }

  return (
    <div className="w-full space-y-6 pb-10">
      <UserMasterView 
        users={users} 
        departments={departments}
        currentRole={currentRole} 
        currentUser={currentUser}
        onRefresh={refreshData}
      />
    </div>
  );
}

function AuditLogRoute() {
  const { currentRole, currentUser, refreshData } = useAppContext();
  const isAdmin = currentUser?.role === 'admin' || 
                  currentUser?.roleId === 'ADMIN' || 
                  currentRole?.role === 'admin' || 
                  currentRole?.roleId === 'ADMIN' || 
                  currentRole?.id === 'ADMIN' || 
                  (currentRole?.level && currentRole.level >= 99);

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-6 bg-white rounded-3xl border border-slate-200 shadow-sm my-6">
        <div className="w-16 h-16 bg-rose-50 text-rose-500 rounded-2xl flex items-center justify-center mb-4 text-2xl font-bold">🔒</div>
        <h2 className="text-xl font-bold text-slate-800 mb-2">สิทธิ์การเข้าถึงถูกจำกัด (Restricted Access)</h2>
        <p className="text-sm text-slate-500 max-w-md">หน้าบันทึกประวัติระบบ (Audit Logs) สงวนสิทธิ์สำหรับผู้ดูแลระบบ (System Admin) เท่านั้น</p>
      </div>
    );
  }

  return (
    <div className="w-full space-y-6 pb-10">
      <AuditLogView 
        currentRole={currentRole} 
        currentUser={currentUser}
        onRefresh={refreshData}
      />
    </div>
  );
}

// ── Router Definition with Semantic Paths (HashRouter for SPA Refresh Resilience) ──
export const router = createHashRouter([
  {
    element: <AppRootLayout />,
    children: [
      {
        path: '/login',
        element: <LoginView />
      },
      {
        path: '/',
        element: <DirectAppLayout />,
        children: [
          { index: true, element: <RootIndexRedirect /> },
          { path: 'dashboard', element: <DashboardRoute /> },
          
          // Workspace
          { 
            path: 'my-workspace', 
            element: (
              <ProtectedRoute disallowOnlinePurchaser fallback="/dashboard">
                <MyWorkRoute />
              </ProtectedRoute>
            ) 
          },
          { path: 'my-work', element: <Navigate to="/my-workspace" replace /> },
          
          // PRs
          { path: 'prs', element: <PRListRoute /> },
          { path: 'pr-list', element: <Navigate to="/prs" replace /> },
          { 
            path: 'prs/create', 
            element: (
              <ProtectedRoute requiredPermission="PR_CREATE" fallback="/dashboard">
                <PRCreateRoute />
              </ProtectedRoute>
            ) 
          },
          { path: 'pr-create', element: <Navigate to="/prs/create" replace /> },
          
          // POs
          { path: 'pos', element: <POListRoute /> },
          { path: 'po-list', element: <Navigate to="/pos" replace /> },
          
          // Inventory
          { path: 'inventory/stock-card', element: <StockCardRoute /> },
          { path: 'stock-card', element: <Navigate to="/inventory/stock-card" replace /> },
          { 
            path: 'inventory/quick-issue', 
            element: (
              <ProtectedRoute disallowOnlinePurchaser fallback="/dashboard">
                <QuickIssueRoute />
              </ProtectedRoute>
            ) 
          },
          { path: 'quick-issue', element: <Navigate to="/inventory/quick-issue" replace /> },
          
          // Administrative & Business Control
          { 
            path: 'budget', 
            element: (
              <ProtectedRoute requiredPermission="BUDGET_MANAGE">
                <BudgetRoute />
              </ProtectedRoute>
            ) 
          },
          { 
            path: 'master-data', 
            element: (
              <ProtectedRoute allowedRoles={['REQUESTER', 'REVIEWER', 'PURCHASER', 'APPROVER', 'ADMIN']} disallowOnlinePurchaser fallback="/dashboard">
                <MasterDataRoute />
              </ProtectedRoute>
            ) 
          },
          { path: 'admin/master-data', element: <Navigate to="/master-data" replace /> },
          { 
            path: 'master-data/users', 
            element: (
              <ProtectedRoute requiredPermission="SYSTEM_ADMIN" fallback="/dashboard">
                <UserMasterRoute />
              </ProtectedRoute>
            ) 
          },
          { 
            path: 'admin/users', 
            element: (
              <ProtectedRoute requiredPermission="SYSTEM_ADMIN" fallback="/dashboard">
                <UserMasterRoute />
              </ProtectedRoute>
            ) 
          },
          { 
            path: 'admin/audit-logs', 
            element: (
              <ProtectedRoute requiredPermission="SYSTEM_ADMIN" fallback="/dashboard">
                <AuditLogRoute />
              </ProtectedRoute>
            ) 
          },
          { path: 'audit-logs', element: <Navigate to="/admin/audit-logs" replace /> },
          { 
            path: 'online-tasks', 
            element: (
              <ProtectedRoute requiredPermission="ONLINE_PROCURE">
                <OnlineTaskRoute />
              </ProtectedRoute>
            ) 
          },
          { path: 'online-procurement', element: <Navigate to="/online-tasks" replace /> },
          { path: 'procurement/online', element: <Navigate to="/online-tasks" replace /> },

          // Safe Fallback Inside Layout (Wildcard *)
          { path: '*', element: <SafeFallbackRedirect /> }
        ]
      },
      // Global Safe Fallback Catch-All (Wildcard *)
      {
        path: '*',
        element: <SafeFallbackRedirect />
      }
    ]
  }
]);
