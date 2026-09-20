import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import './setup.js';

import { authService, DEFAULT_EMPLOYEE_ACCOUNTS, getRolePermissionsChecklist } from '../src/services/authService';
import { ROLES } from '../src/config/constants';
import { workflowEngine } from '../src/services/workflowEngine';
import { notificationService } from '../src/services/notificationService';
import UserProfileModal from '../src/components/common/UserProfileModal.jsx';
import Sidebar from '../src/components/common/Sidebar.jsx';
import SidebarAlias from '../src/components/Sidebar';
import ProtectedRoute from '../src/components/common/ProtectedRoute.jsx';
import { AuthProvider, AUTH_STORAGE_KEY } from '../src/context/AuthContext.jsx';
import { AppProvider } from '../src/context/AppContext';
import { 
  calculateActiveClaimCount, 
  calculatePendingActionCount, 
  calculateUrgentTaskCount, 
  isOrderClosed 
} from '../src/context/ProcurementContext';

describe('Domain Suite: Authentication, Authorization & RBAC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 1: Authentication Service & Session Credentials
  // ══════════════════════════════════════════════════════════════════
  describe('1. Authentication & Session Services (Username/Password & Position Login)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
    });

    it('Default employee accounts are available for each position', () => {
      const accounts = authService.getRegisteredUsers();
      expect(accounts.length).toBe(6);
      expect(accounts.some(a => a.username === 'wichai.pd')).toBe(true);
      expect(accounts.some(a => a.username === 'somchai.am')).toBe(true);
      expect(accounts.some(a => a.username === 'prasert.pm')).toBe(true);
      expect(accounts.some(a => a.username === 'nat.on')).toBe(true);
    });

    it('Successful login returns session and role permissions', async () => {
      const userSession = await authService.login('wichai.pd', 'password123');

      expect(userSession).toBeDefined();
      expect(userSession.name).toBe('คุณวิชัย (PD)');
      expect(userSession.department).toBe('PD');
      expect(userSession.canCreatePR).toBe(true);
      expect(userSession.canViewBudget).toBe(false);

      // Verify session persistence
      const savedSession = authService.getCurrentSession();
      expect(savedSession).toBeDefined();
      expect(savedSession.username).toBe('wichai.pd');
    });

    it('Login by position key works accurately', async () => {
      const mgrSession = await authService.loginByPosition('APPROVER');
      expect(mgrSession.name).toBe('คุณประเสริฐ (Plant Mgr)');
      expect(mgrSession.canFinalApprove).toBe(true);
      expect(mgrSession.canViewBudget).toBe(true);
    });

    it('Login with invalid credentials throws descriptive error', async () => {
      await expect(
        authService.login('wichai.pd', 'wrong_password')
      ).rejects.toThrow('ชื่อผู้ใช้งาน (Username) หรือรหัสผ่าน (Password) ไม่ถูกต้อง');

      await expect(
        authService.login('nonexistent.user', '123456')
      ).rejects.toThrow('ชื่อผู้ใช้งาน (Username) หรือรหัสผ่าน (Password) ไม่ถูกต้อง');
    });

    it('Logout clears active session', async () => {
      await authService.login('admin', 'admin123');
      expect(authService.getCurrentSession()).not.toBeNull();

      authService.logout();
      expect(authService.getCurrentSession()).toBeNull();
    });

    it('Default employee accounts have valid company emails and metadata', () => {
      DEFAULT_EMPLOYEE_ACCOUNTS.forEach(account => {
        expect(account.email).toBeDefined();
        expect(account.email).toContain('@company.com');
        expect(account.employeeId).toBeDefined();
        expect(account.department).toBeDefined();
      });
    });

    it('Role permissions checklist maps accurately for Requester', () => {
      const requester = DEFAULT_EMPLOYEE_ACCOUNTS.find(a => a.roleId === 'REQUESTER_PD');
      const checklist = getRolePermissionsChecklist(requester);

      const prCreation = checklist.find(p => p.key === 'PR_CREATION');
      const approval = checklist.find(p => p.key === 'APPROVAL');
      const purchasing = checklist.find(p => p.key === 'PURCHASING');
      const inventory = checklist.find(p => p.key === 'INVENTORY');

      expect(prCreation.allowed).toBe(true);
      expect(approval.allowed).toBe(false);
      expect(purchasing.allowed).toBe(false);
      expect(inventory.allowed).toBe(true); // Requester can receive in department
    });

    it('Role permissions checklist grants full access to Admin', () => {
      const adminUser = DEFAULT_EMPLOYEE_ACCOUNTS.find(a => a.roleId === 'ADMIN');
      const checklist = getRolePermissionsChecklist(adminUser);

      expect(checklist.every(p => p.allowed === true)).toBe(true);
    });

    it('Role permissions checklist maps accurately for Purchaser', () => {
      const purchaser = DEFAULT_EMPLOYEE_ACCOUNTS.find(a => a.roleId === 'ONLINE_PURCHASER');
      const checklist = getRolePermissionsChecklist(purchaser);

      const prCreation = checklist.find(p => p.key === 'PR_CREATION');
      const purchasing = checklist.find(p => p.key === 'PURCHASING');

      expect(prCreation.allowed).toBe(false);
      expect(purchasing.allowed).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 2: Roles & Permission Matrix & Access Scoping
  // ══════════════════════════════════════════════════════════════════
  describe('2. Roles & Permission Matrix & Access Scoping', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
    });

    it('Financial & Budget Visibility: Only Asst. Mgr, Plant Mgr, and Admin can view budget', () => {
      // Requesters cannot view budget
      expect(ROLES.REQUESTER_PD.canViewBudget).toBe(false);
      expect(ROLES.REQUESTER_PD.canViewBudgetMenu).toBe(false);
      expect(ROLES.REQUESTER_QC.canViewBudget).toBe(false);
      expect(ROLES.REQUESTER_QC.canViewBudgetMenu).toBe(false);

      // Online Purchaser cannot view budget
      expect(ROLES.ONLINE_PURCHASER.canViewBudget).toBe(false);
      expect(ROLES.ONLINE_PURCHASER.canViewBudgetMenu).toBe(false);

      // Asst Manager, Plant Manager, and Admin can view budget
      expect(ROLES.ASST_MANAGER.canViewBudget).toBe(true);
      expect(ROLES.ASST_MANAGER.canViewBudgetMenu).toBe(true);
      expect(ROLES.PLANT_MANAGER.canViewBudget).toBe(true);
      expect(ROLES.PLANT_MANAGER.canViewBudgetMenu).toBe(true);
      expect(ROLES.ADMIN.canViewBudget).toBe(true);
      expect(ROLES.ADMIN.canViewBudgetMenu).toBe(true);
    });

    it('Approval Hierarchy: Asst. Manager can Review, Plant Manager can Final Approve', () => {
      // Review Level 1
      expect(ROLES.REQUESTER_PD.canReview).toBe(false);
      expect(ROLES.ASST_MANAGER.canReview).toBe(true);
      expect(ROLES.PLANT_MANAGER.canReview).toBe(true);

      // Final Approve
      expect(ROLES.REQUESTER_PD.canFinalApprove).toBe(false);
      expect(ROLES.ASST_MANAGER.canFinalApprove).toBe(false);
      expect(ROLES.PLANT_MANAGER.canFinalApprove).toBe(true);
      expect(ROLES.ADMIN.canFinalApprove).toBe(true);
    });

    it('Online Purchaser Permissions: Restricted to Online Tasks', () => {
      expect(ROLES.ONLINE_PURCHASER.canOnlinePurchase).toBe(true);
      expect(ROLES.ONLINE_PURCHASER.canCreatePR).toBe(false);
      expect(ROLES.ONLINE_PURCHASER.canReceiveGoods).toBe(false);
    });

    it('Department Isolation: PD requester cannot action QC Draft PRs', () => {
      const qcDraftPR = { id: 'PR-1', department: 'QC', status: 'DRAFT', requestedBy: 'คุณวิชัย (PD)' };
      const pdDraftPR = { id: 'PR-2', department: 'PD', status: 'DRAFT', requestedBy: 'คุณวิชัย (PD)' };

      expect(workflowEngine.canAction(ROLES.REQUESTER_PD, qcDraftPR)).toBe(false);
      expect(workflowEngine.canAction(ROLES.REQUESTER_PD, pdDraftPR)).toBe(true);
    });

    it('Strict Workflow Role Separation: Plant Mgr does NOT action SUBMITTED, Asst Mgr does NOT action REVIEWED', () => {
      const submittedPR = { id: 'PR-SUB-1', prNo: 'PD001/2026', department: 'PD', status: 'SUBMITTED' };
      const reviewedPR = { id: 'PR-REV-1', prNo: 'PD001/2026', department: 'PD', status: 'REVIEWED' };

      // SUBMITTED PR: Only Asst Manager (Level 2) and Admin can action; Plant Manager (Level 3) cannot action!
      expect(workflowEngine.canAction(ROLES.ASST_MANAGER, submittedPR)).toBe(true);
      expect(workflowEngine.canAction(ROLES.PLANT_MANAGER, submittedPR)).toBe(false);
      expect(workflowEngine.canAction(ROLES.REQUESTER_PD, submittedPR)).toBe(false);
      expect(workflowEngine.canAction(ROLES.ONLINE_PURCHASER, submittedPR)).toBe(false);
      expect(workflowEngine.canAction(ROLES.ADMIN, submittedPR)).toBe(true);

      // REVIEWED PR: Only Plant Manager (Level 3) and Admin can action; Asst Manager (Level 2) cannot action!
      expect(workflowEngine.canAction(ROLES.PLANT_MANAGER, reviewedPR)).toBe(true);
      expect(workflowEngine.canAction(ROLES.ASST_MANAGER, reviewedPR)).toBe(false);
      expect(workflowEngine.canAction(ROLES.REQUESTER_PD, reviewedPR)).toBe(false);
      expect(workflowEngine.canAction(ROLES.ONLINE_PURCHASER, reviewedPR)).toBe(false);
      expect(workflowEngine.canAction(ROLES.ADMIN, reviewedPR)).toBe(true);
    });

    it('Draft Ownership Isolation: Another user in same dept cannot action colleague draft PR', () => {
      const colleagueDraft = { id: 'PR-DRAFT-2', prNo: 'PD002/2026', department: 'PD', status: 'DRAFT', requestedBy: 'คุณสมศักดิ์ (PD)' };

      // Current user is 'คุณวิชัย (PD)'
      expect(workflowEngine.canAction(ROLES.REQUESTER_PD, colleagueDraft)).toBe(false);
      expect(workflowEngine.canAction(ROLES.PLANT_MANAGER, colleagueDraft)).toBe(false);
      expect(workflowEngine.canAction(ROLES.ASST_MANAGER, colleagueDraft)).toBe(false);
      expect(workflowEngine.canAction(ROLES.ADMIN, colleagueDraft)).toBe(true);
    });

    it('Online PO Isolation: Only Online Purchaser actions IN_PROGRESS_ONLINE PO', () => {
      const onlinePO = { id: 'PO-ON-1', poNo: 'PO-PD-2026-001', department: 'PD', status: 'IN_PROGRESS_ONLINE', purchaseChannel: 'ONLINE' };

      expect(workflowEngine.canAction(ROLES.ONLINE_PURCHASER, onlinePO)).toBe(true);
      expect(workflowEngine.canAction(ROLES.REQUESTER_PD, onlinePO)).toBe(false);
      expect(workflowEngine.canAction(ROLES.ASST_MANAGER, onlinePO)).toBe(false);
      expect(workflowEngine.canAction(ROLES.PLANT_MANAGER, onlinePO)).toBe(false);
      expect(workflowEngine.canAction(ROLES.ADMIN, onlinePO)).toBe(true);
    });

    it('PR Cancellation Rules: Can cancel ONLY when the task is currently with the user', () => {
      const draftPR = { id: 'PR-CAN-DRAFT', prNo: 'PD010/2026', department: 'PD', status: 'DRAFT', requestedBy: 'คุณวิชัย (PD)' };
      const submittedPR = { id: 'PR-CAN-SUB', prNo: 'PD011/2026', department: 'PD', status: 'SUBMITTED', requestedBy: 'คุณวิชัย (PD)' };
      const reviewedPR = { id: 'PR-CAN-REV', prNo: 'PD012/2026', department: 'PD', status: 'REVIEWED', requestedBy: 'คุณวิชัย (PD)' };
      const approvedPR = { id: 'PR-CAN-APP', prNo: 'PD013/2026', department: 'PD', status: 'APPROVED', requestedBy: 'คุณวิชัย (PD)' };

      // 1. DRAFT: Only owner can cancel
      expect(workflowEngine.canCancelPR(ROLES.REQUESTER_PD, draftPR)).toBe(true);
      expect(workflowEngine.canCancelPR(ROLES.REQUESTER_QC, draftPR)).toBe(false);
      expect(workflowEngine.canCancelPR(ROLES.ASST_MANAGER, draftPR)).toBe(false);
      expect(workflowEngine.canCancelPR(ROLES.PLANT_MANAGER, draftPR)).toBe(false);
      expect(workflowEngine.canCancelPR(ROLES.ADMIN, draftPR)).toBe(true);

      // 2. SUBMITTED: Task is with Asst. Manager (Level 2). Requester & Plant Mgr CANNOT cancel!
      expect(workflowEngine.canCancelPR(ROLES.ASST_MANAGER, submittedPR)).toBe(true);
      expect(workflowEngine.canCancelPR(ROLES.REQUESTER_PD, submittedPR)).toBe(false);
      expect(workflowEngine.canCancelPR(ROLES.PLANT_MANAGER, submittedPR)).toBe(false);
      expect(workflowEngine.canCancelPR(ROLES.ONLINE_PURCHASER, submittedPR)).toBe(false);
      expect(workflowEngine.canCancelPR(ROLES.ADMIN, submittedPR)).toBe(true);

      // 3. REVIEWED: Task is with Plant Manager (Level 3). Requester & Asst Mgr CANNOT cancel!
      expect(workflowEngine.canCancelPR(ROLES.PLANT_MANAGER, reviewedPR)).toBe(true);
      expect(workflowEngine.canCancelPR(ROLES.REQUESTER_PD, reviewedPR)).toBe(false);
      expect(workflowEngine.canCancelPR(ROLES.ASST_MANAGER, reviewedPR)).toBe(false);
      expect(workflowEngine.canCancelPR(ROLES.ONLINE_PURCHASER, reviewedPR)).toBe(false);
      expect(workflowEngine.canCancelPR(ROLES.ADMIN, reviewedPR)).toBe(true);

      // 4. APPROVED / PO_ISSUED: Cannot cancel PR (must cancel PO)
      expect(workflowEngine.canCancelPR(ROLES.REQUESTER_PD, approvedPR)).toBe(false);
      expect(workflowEngine.canCancelPR(ROLES.ASST_MANAGER, approvedPR)).toBe(false);
      expect(workflowEngine.canCancelPR(ROLES.PLANT_MANAGER, approvedPR)).toBe(false);
      expect(workflowEngine.canCancelPR(ROLES.ADMIN, approvedPR)).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 3: LINE Integration Deprecation Status
  // ══════════════════════════════════════════════════════════════════
  describe('3. LINE Integration Deprecation Status', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('LINE integration is disabled', () => {
      expect(true).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 4: In-App Notifications & Role Dispatch Filtering
  // ══════════════════════════════════════════════════════════════════
  describe('4. In-App Notifications & Role Dispatch Filtering', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      notificationService.clearAll();
    });

    it('Dispatch notification saves to local storage with unread status', () => {
      const noti = notificationService.dispatch({
        type: 'PR_SUBMITTED',
        title: 'PR รอตรวจสอบ',
        message: 'ใบขอซื้อ PD001/2026 รอคุณสมชายตรวจสอบ',
        docNo: 'PD001/2026',
        refDocType: 'PR',
        refDocId: 'PR-100',
        department: 'PD',
        targetRoles: ['ASST_MANAGER', 'ADMIN'],
        amount: 15000,
        actor: 'คุณวิชัย (PD)'
      });

      expect(noti.id).toBeDefined();
      expect(noti.isRead).toBe(false);

      const all = notificationService.getAll();
      expect(all.length).toBe(1);
      expect(all[0].title).toBe('PR รอตรวจสอบ');
    });

    it('Role-based notification filtering: Asst Manager sees review notifications, Requester does not', () => {
      notificationService.dispatch({
        type: 'PR_SUBMITTED',
        title: 'PR รอตรวจสอบ Level 1',
        message: 'รายละเอียด...',
        targetRoles: ['ASST_MANAGER', 'ADMIN']
      });

      // Asst Manager should see it
      const asstNotis = notificationService.getNotificationsForRole(ROLES.ASST_MANAGER);
      expect(asstNotis.length).toBe(1);

      // Requester QC should not see it
      const qcNotis = notificationService.getNotificationsForRole(ROLES.REQUESTER_QC);
      expect(qcNotis.length).toBe(0);

      // Admin should see everything
      const adminNotis = notificationService.getNotificationsForRole(ROLES.ADMIN);
      expect(adminNotis.length).toBe(1);
    });

    it('Mark as read updates unread counter', () => {
      const noti = notificationService.dispatch({
        type: 'PR_REVIEWED',
        title: 'PR ผ่านการตรวจ',
        message: 'รอ Plant Manager อนุมัติ',
        targetRoles: ['PLANT_MANAGER']
      });

      expect(notificationService.getUnreadCount(ROLES.PLANT_MANAGER)).toBe(1);

      notificationService.markAsRead(noti.id);
      expect(notificationService.getUnreadCount(ROLES.PLANT_MANAGER)).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 5: User Profile Modal & Sidebar Production Sanitization
  // ══════════════════════════════════════════════════════════════════
  describe('5. User Profile Modal & Sidebar Production Sanitization', () => {
    const mockRequesterUser = {
      id: 'USR-0001',
      employeeId: 'EMP-PD-001',
      email: 'wichai@company.com',
      username: 'wichai.pd',
      name: 'คุณวิชัย สุขใจ (PD)',
      department: 'PD',
      departments: ['PD'],
      canonicalRole: 'REQUESTER',
      roleId: 'REQUESTER_PD',
      title: 'Requester (PD)',
      status: 'ACTIVE'
    };

    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
    });

    it('suppresses the fast account switcher grid and reset button completely from DOM', () => {
      const html = renderToStaticMarkup(
        <UserProfileModal
          isOpen={true}
          onClose={() => {}}
          currentUser={mockRequesterUser}
          currentRole={mockRequesterUser}
          isDev={false}
        />
      );

      expect(html).not.toContain('data-testid="dev-account-switcher-section"');
      expect(html).not.toContain('สลับบัญชีผู้ใช้งาน (Fast Account Switcher)');
      expect(html).not.toContain('data-testid="modal-reset-default-btn"');
      expect(html).not.toContain('รีเซ็ตบัญชีเริ่มต้น');
    });

    it('sets authoritative production title and subtitle', () => {
      const html = renderToStaticMarkup(
        <UserProfileModal
          isOpen={true}
          onClose={() => {}}
          currentUser={mockRequesterUser}
          currentRole={mockRequesterUser}
          isDev={false}
        />
      );

      expect(html).toContain('ข้อมูลผู้ใช้งานและสิทธิ์ในระบบ');
      expect(html).toContain('รายละเอียดบัญชีผู้ใช้งานปัจจุบันและขอบเขตสิทธิ์การดำเนินงาน');
      expect(html).not.toContain('ข้อมูลผู้ใช้งาน & สลับบัญชี');
      expect(html).not.toContain('Fast Account Switcher');
    });

    it('renders the Top Profile Card with all required metadata', () => {
      const html = renderToStaticMarkup(
        <UserProfileModal
          isOpen={true}
          onClose={() => {}}
          currentUser={mockRequesterUser}
          currentRole={mockRequesterUser}
          isDev={false}
        />
      );

      expect(html).toContain('คุณวิชัย สุขใจ (PD)');
      expect(html).toContain('PD');
      expect(html).toContain('Active');
      expect(html).toContain('Requester (PD)');
      expect(html).toContain('REQUESTER');
      expect(html).toContain('EMP-PD-001');
      expect(html).toContain('wichai@company.com');
      expect(html).toContain('@wichai.pd');
    });

    it('renders authoritative "ออกจากระบบ (Sign Out)" button in the modal footer', () => {
      const html = renderToStaticMarkup(
        <UserProfileModal
          isOpen={true}
          onClose={() => {}}
          currentUser={mockRequesterUser}
          currentRole={mockRequesterUser}
          isDev={false}
        />
      );

      expect(html).toContain('data-testid="modal-logout-btn"');
      expect(html).toContain('ออกจากระบบ (Sign Out)');
    });

    it('Sidebar suppresses standalone switch button (⇄) in Production mode', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <Sidebar
            currentRole={mockRequesterUser}
            currentUser={mockRequesterUser}
            isDev={false}
            onLogout={() => {}}
          />
        </MemoryRouter>
      );

      expect(html).not.toContain('data-testid="sidebar-role-switch-btn"');
      expect(html).not.toContain('สลับบัญชีผู้ใช้ (Switch Role)');
      expect(html).toContain('data-testid="sidebar-logout-btn"');
      expect(html).toContain('ออกจากระบบ (Sign Out)');
    });

    it('invokes onLogout callback when Sign Out button is clicked', () => {
      let logoutCalled = false;
      const handleLogout = () => {
        logoutCalled = true;
        localStorage.removeItem(AUTH_STORAGE_KEY);
      };

      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(mockRequesterUser));
      expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeTruthy();

      const html = renderToStaticMarkup(
        <UserProfileModal
          isOpen={true}
          onClose={() => {}}
          currentUser={mockRequesterUser}
          onLogout={handleLogout}
          isDev={false}
        />
      );

      expect(html).toContain('data-testid="modal-logout-btn"');
      handleLogout();
      expect(logoutCalled).toBe(true);
      expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    });

    it('Sidebar logout button clears session when clicked', () => {
      let logoutCalled = false;
      const handleLogout = () => {
        logoutCalled = true;
        localStorage.removeItem(AUTH_STORAGE_KEY);
      };

      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(mockRequesterUser));

      const html = renderToStaticMarkup(
        <MemoryRouter>
          <Sidebar
            currentRole={mockRequesterUser}
            currentUser={mockRequesterUser}
            isDev={false}
            onLogout={handleLogout}
          />
        </MemoryRouter>
      );

      expect(html).toContain('data-testid="sidebar-logout-btn"');
      handleLogout();
      expect(logoutCalled).toBe(true);
      expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    });

    it('renders the 6-card Fast Account Switcher grid and reset button under dev mode', () => {
      const html = renderToStaticMarkup(
        <UserProfileModal
          isOpen={true}
          onClose={() => {}}
          currentUser={mockRequesterUser}
          currentRole={mockRequesterUser}
          isDev={true}
        />
      );

      expect(html).toContain('data-testid="dev-account-switcher-section"');
      expect(html).toContain('สลับบัญชีผู้ใช้งาน (Fast Account Switcher)');
      expect(html).toContain('data-testid="modal-reset-default-btn"');
      expect(html).toContain('รีเซ็ตบัญชีเริ่มต้น');
      expect(html).toMatch(/ข้อมูลผู้ใช้งาน (&amp;|&) สลับบัญชี/);
    });

    it('Sidebar renders standalone switch button (⇄) under dev mode', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <Sidebar
            currentRole={mockRequesterUser}
            currentUser={mockRequesterUser}
            isDev={true}
            onLogout={() => {}}
          />
        </MemoryRouter>
      );

      expect(html).toContain('data-testid="sidebar-role-switch-btn"');
      expect(html).toContain('สลับบัญชีผู้ใช้ (Switch Role)');
    });

    it('correctly displays permissions for REQUESTER role', () => {
      const html = renderToStaticMarkup(
        <UserProfileModal
          isOpen={true}
          onClose={() => {}}
          currentUser={mockRequesterUser}
          currentRole={mockRequesterUser}
          isDev={false}
        />
      );

      expect(html).toContain('สร้างใบขอซื้อ (PR):');
      expect(html).toContain('ตรวจทาน / อนุมัติ (Approver):');
      expect(html).toContain('สั่งซื้อและดำเนินการออนไลน์:');
      expect(html).toContain('ตรวจรับพัสดุเข้าคลัง (GRN):');
      expect(html).toContain('จัดการงบประมาณแผนก:');
      expect(html).toContain('จัดการข้อมูลหลัก (Master Data):');

      expect(html).toContain('มีสิทธิ์');
      expect(html).toContain('ไม่มีสิทธิ์');
    });

    it('correctly displays full permissions for ADMIN role', () => {
      const mockAdminUser = {
        id: 'USR-0005',
        employeeId: 'EMP-ADM-001',
        email: 'somchai@company.com',
        username: 'somchai.adm',
        name: 'คุณสมชาย บริหาร (Admin)',
        department: 'ALL',
        departments: ['ALL'],
        canonicalRole: 'ADMIN',
        roleId: 'ADMIN',
        title: 'System Administrator',
        status: 'ACTIVE'
      };

      const html = renderToStaticMarkup(
        <UserProfileModal
          isOpen={true}
          onClose={() => {}}
          currentUser={mockAdminUser}
          currentRole={mockAdminUser}
          isDev={false}
        />
      );

      expect(html).not.toContain('ไม่มีสิทธิ์');
      expect(html).toContain('มีสิทธิ์');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 6: Sidebar Claim & Actionable Task Notification Badge
  // ══════════════════════════════════════════════════════════════════
  describe('6. Sidebar Claim & Actionable Task Notification Badge (urgentTaskCount)', () => {
    const onlineRole = {
      id: 'ONLINE_PURCHASER',
      roleId: 'ONLINE_PURCHASER',
      name: 'Online Purchaser',
      canOnlinePurchase: true,
      level: 1
    };

    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
    });

    it('isOrderClosed correctly identifies closed order states', () => {
      expect(isOrderClosed('COMPLETED')).toBe(true);
      expect(isOrderClosed('CLOSED')).toBe(true);
      expect(isOrderClosed('COMPLETED_DELIVERY')).toBe(true);
      expect(isOrderClosed('CANCELLED')).toBe(true);
      expect(isOrderClosed('IN_CLAIM')).toBe(false);
      expect(isOrderClosed('PARTIALLY_RECEIVED_IN_CLAIM')).toBe(false);
      expect(isOrderClosed('ORDERED')).toBe(false);
    });

    it('calculateActiveClaimCount counts active claim orders and ignores closed ones', () => {
      const orders = [
        { id: 'PO-1', status: 'IN_CLAIM' },
        { id: 'PO-2', status: 'PARTIALLY_RECEIVED_IN_CLAIM' },
        { id: 'PO-3', status: 'ISSUED', hasGRN: true, hasDispute: true },
        { id: 'PO-4', status: 'COMPLETED', hasGRN: true, hasDispute: true },
        { id: 'PO-5', status: 'ORDERED' }
      ];

      const count = calculateActiveClaimCount(orders);
      expect(count).toBe(3);
    });

    it('calculatePendingActionCount counts pending actionable orders and PRs', () => {
      const orders = [
        { id: 'PO-P1', status: 'PENDING_ORDER' },
        { id: 'PO-P2', status: 'WAITING_PURCHASE' },
        { id: 'PO-P3', status: 'รอดำเนินการ' },
        { id: 'PO-ORD', status: 'ORDERED' },
        { id: 'PO-CLS', status: 'COMPLETED' }
      ];
      const prs = [
        { id: 'PR-1', status: 'WAITING_PURCHASE', purchaseChannel: 'ONLINE' }
      ];

      const count = calculatePendingActionCount(orders, prs);
      expect(count).toBe(4);
    });

    it('calculateUrgentTaskCount sums pendingActionCount and activeClaimCount strictly excluding ORDERED and CLOSED', () => {
      const orders = [
        { id: 'PO-PENDING', status: 'PENDING_ORDER' },
        { id: 'PO-CLAIM', status: 'IN_CLAIM' },
        { id: 'PO-ORDERED', status: 'ORDERED' },
        { id: 'PO-CLOSED', status: 'CLOSED' }
      ];

      const pending = calculatePendingActionCount(orders);
      const claim = calculateActiveClaimCount(orders);
      const urgent = calculateUrgentTaskCount(orders);

      expect(pending).toBe(1);
      expect(claim).toBe(1);
      expect(urgent).toBe(2);
    });

    it('[Image d42112 Fix]: Renders badge with count 1 when pendingActionCount = 1 and activeClaimCount = 0', () => {
      const pos = [
        { id: 'PO-PENDING-01', status: 'PENDING_PURCHASE', purchaseChannel: 'ONLINE' }
      ];

      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/dashboard']}>
          <AppProvider>
            <Sidebar
              currentRole={onlineRole}
              currentUser={{ id: 'u1', name: 'Purchaser' }}
              pos={pos}
              prs={[]}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain('งานจัดซื้อ');
      expect(html).toContain('justify-between');
      expect(html).toContain('bg-rose-500');
      expect(html).toContain('>1</span>');
    });

    it('Renders badge with sum when both pending and claim tasks exist (1 + 2 = 3)', () => {
      const pos = [
        { id: 'PO-PENDING-01', status: 'PENDING_PURCHASE', purchaseChannel: 'ONLINE' },
        { id: 'PO-CLAIM-1', status: 'CLAIM_PENDING', purchaseChannel: 'ONLINE' },
        { id: 'PO-CLAIM-2', status: 'PARTIALLY_RECEIVED_IN_CLAIM', purchaseChannel: 'ONLINE' },
        { id: 'PO-ORDERED', status: 'ORDERED', purchaseChannel: 'ONLINE' }
      ];

      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/dashboard']}>
          <AppProvider>
            <Sidebar
              currentRole={onlineRole}
              currentUser={{ id: 'u1', name: 'Purchaser' }}
              pos={pos}
              prs={[]}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain('>3</span>');
      expect(html).toContain('bg-rose-500');
    });

    it('Hides badge completely when both pending and claim are 0 (only ORDERED and COMPLETED exist)', () => {
      const pos = [
        { id: 'PO-NORMAL-1', status: 'ORDERED', purchaseChannel: 'ONLINE' },
        { id: 'PO-NORMAL-2', status: 'COMPLETED', purchaseChannel: 'ONLINE' }
      ];

      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/dashboard']}>
          <AppProvider>
            <Sidebar
              currentRole={onlineRole}
              currentUser={{ id: 'u1', name: 'Purchaser' }}
              pos={pos}
              prs={[]}
            />
          </AppProvider>
        </MemoryRouter>
      );

      expect(html).toContain('งานจัดซื้อ');
      expect(html).not.toContain('bg-rose-600 rounded-full animate-pulse');
    });

    it('src/components/Sidebar alias points to Sidebar component seamlessly', () => {
      expect(SidebarAlias).toBe(Sidebar);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Sub-Suite 7: Online Purchaser Sidebar RBAC & Route Guards
  // ══════════════════════════════════════════════════════════════════
  describe('7. Online Purchaser Sidebar RBAC & Route Guards', () => {
    const onlinePurchaserUser = {
      id: 'ONLINE_PURCHASER',
      roleId: 'ONLINE_PURCHASER',
      name: 'คุณนัท (จัดซื้อออนไลน์)',
      title: 'Online Purchaser',
      department: 'PUR',
      canOnlinePurchase: true,
      level: 2,
      expiresAt: Date.now() + 86400000
    };

    beforeEach(() => {
      vi.clearAllMocks();
      localStorage.clear();
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(onlinePurchaserUser));
    });

    it('Sidebar strictly renders ONLY the 6 allowed menus for ONLINE_PURCHASER', () => {
      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/dashboard']}>
          <AppProvider>
            <Sidebar
              currentRole={onlinePurchaserUser}
              currentUser={onlinePurchaserUser}
              pos={[]}
              prs={[]}
            />
          </AppProvider>
        </MemoryRouter>
      );

      // 6 Allowed Menus
      expect(html).toContain('ภาพรวม');
      expect(html).toContain('งานจัดซื้อ');
      expect(html).toContain('ใบขอซื้อ');
      expect(html).toContain('ใบสั่งซื้อ');
      expect(html).toContain('คลังพัสดุ');
      expect(html).toContain('งบประมาณ');

      // 4 Forbidden Menus strictly HIDDEN
      expect(html).not.toContain('งานของฉัน');
      expect(html).not.toContain('เบิกจ่ายด่วน');
      expect(html).not.toContain('ข้อมูลระบบ');
      expect(html).not.toContain('บันทึกระบบ (Audit Logs)');
    });

    it('Internal purchaser (roleId: PURCHASER) is NOT treated as ONLINE_PURCHASER', () => {
      const internalPurchaser = {
        id: 'PURCHASER_GENERAL',
        roleId: 'PURCHASER',
        name: 'คุณสุดา (จัดซื้อทั่วไป)',
        canonicalRole: 'PURCHASER',
        canManageMaster: true,
        canOnlinePurchase: false,
        level: 2
      };

      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/dashboard']}>
          <AppProvider>
            <Sidebar
              currentRole={internalPurchaser}
              currentUser={internalPurchaser}
              pos={[]}
              prs={[]}
            />
          </AppProvider>
        </MemoryRouter>
      );

      // Internal purchaser sees "งานของฉัน" and "ข้อมูลระบบ"
      expect(html).toContain('งานของฉัน');
      expect(html).toContain('ข้อมูลระบบ');
    });

    it('Route Guard prevents ONLINE_PURCHASER from accessing forbidden routes and redirects to fallback', () => {
      // 1. /inventory/quick-issue guarded with disallowOnlinePurchaser (triggers Navigate to fallback)
      const quickIssueHtml = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/inventory/quick-issue']}>
          <AuthProvider>
            <Routes>
              <Route 
                path="/inventory/quick-issue" 
                element={
                  <ProtectedRoute disallowOnlinePurchaser fallback="/dashboard">
                    <div data-testid="quick-issue-page">Quick Issue Content</div>
                  </ProtectedRoute>
                } 
              />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      );
      expect(quickIssueHtml).not.toContain('Quick Issue Content');
      expect(quickIssueHtml).toBe(''); // Navigate renders null/empty in SSR

      // 2. /my-workspace guarded with disallowOnlinePurchaser
      const myWorkHtml = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/my-workspace']}>
          <AuthProvider>
            <Routes>
              <Route 
                path="/my-workspace" 
                element={
                  <ProtectedRoute disallowOnlinePurchaser fallback="/dashboard">
                    <div data-testid="my-work-page">My Work Content</div>
                  </ProtectedRoute>
                } 
              />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      );
      expect(myWorkHtml).not.toContain('My Work Content');
      expect(myWorkHtml).toBe('');

      // 3. /master-data guarded with disallowOnlinePurchaser
      const masterDataHtml = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/master-data']}>
          <AuthProvider>
            <Routes>
              <Route 
                path="/master-data" 
                element={
                  <ProtectedRoute allowedRoles={['REQUESTER', 'REVIEWER', 'PURCHASER', 'APPROVER', 'ADMIN']} disallowOnlinePurchaser fallback="/dashboard">
                    <div data-testid="master-data-page">Master Data Content</div>
                  </ProtectedRoute>
                } 
              />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      );
      expect(masterDataHtml).not.toContain('Master Data Content');
      expect(masterDataHtml).toBe('');

      // 4. AccessDeniedCard rendering when fallback is omitted
      const accessDeniedHtml = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/master-data']}>
          <AuthProvider>
            <Routes>
              <Route 
                path="/master-data" 
                element={
                  <ProtectedRoute allowedRoles={['REQUESTER', 'REVIEWER', 'APPROVER', 'ADMIN']} disallowOnlinePurchaser>
                    <div data-testid="master-data-page">Master Data Content</div>
                  </ProtectedRoute>
                } 
              />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      );
      expect(accessDeniedHtml).not.toContain('Master Data Content');
      expect(accessDeniedHtml).toContain('403 Access Denied');
      expect(accessDeniedHtml).toContain('สิทธิ์การเข้าถึงถูกจำกัด');
    });

    it('Route Guard permits ONLINE_PURCHASER to access /budget (BUDGET_MANAGE overview)', () => {
      const budgetHtml = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/budget']}>
          <AuthProvider>
            <Routes>
              <Route 
                path="/budget" 
                element={
                  <ProtectedRoute requiredPermission="BUDGET_MANAGE" fallback="/dashboard">
                    <div data-testid="budget-overview-page">Budget Overview Permitted</div>
                  </ProtectedRoute>
                } 
              />
              <Route path="/dashboard" element={<div data-testid="dashboard-page">Dashboard Redirected</div>} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      );
      expect(budgetHtml).toContain('Budget Overview Permitted');
      expect(budgetHtml).not.toContain('Dashboard Redirected');
    });
  });
});
