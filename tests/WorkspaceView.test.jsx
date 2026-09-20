/** @vitest-environment jsdom */
/**
 * Integration Test: WorkspaceView — REQUESTER Task Routing Isolation
 *
 * กฎเหล็ก:
 *   REQUESTER + PO ที่มีสถานะ CLAIM_PENDING หรือ WAITING_DELIVERY_ROUND_2
 *   → To Do   = 0 รายการ (ห้ามเห็นการ์ดตรวจรับรอบ 2 เด็ดขาด)
 *   → In Prog = มีการ์ดแสดง (รอฝ่ายจัดซื้อดำเนินการ)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import './setup.js';

// ─── Mock modules that depend on browser/external APIs ──────────────────────
vi.mock('../src/services/workflowEngine', () => ({
  workflowEngine: {
    canAction: vi.fn(() => false), // Requester ไม่มีสิทธิ์ action บน PO เคลม
  },
}));

vi.mock('../src/context/AppContext', () => ({
  useAppContext: vi.fn(() => ({
    prs: [],
    pos: [],
    currentRole: null,
    currentUser: null,
    onNavigate: vi.fn(),
    refreshData: vi.fn(),
    handleEditPR: vi.fn(),
  })),
}));

vi.mock('../src/utils/permissions', () => ({
  hasDepartmentAccess: vi.fn((user, dept) => {
    return user?.department === dept || user?.departmentId === dept;
  }),
}));

vi.mock('../src/components/workspace/TaskCard', () => ({
  default: ({ task }) => (
    React.createElement('div', {
      'data-testid': 'task-card',
      'data-status': task.status,
      'data-doctype': task.docType,
    }, task.poNo || task.prNo || task.id)
  ),
}));

vi.mock('../src/components/pr/PRDetailsModal', () => ({ default: () => null }));
vi.mock('../src/components/po/PODetailsModal', () => ({ default: () => null }));
vi.mock('../src/utils/sortUtils', () => ({
  sortByNewestFirst: () => 0,
}));

// ─── Setup & Teardown ────────────────────────────────────────────────────────
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ─── Mock Data ───────────────────────────────────────────────────────────────

/** ผู้ขอซื้อ: สิรภัทร แจ่มมิน — Role: REQUESTER (USER) แผนก QC */
const mockRequester = {
  id: 'USR-SIRAPHAT-01',
  name: 'สิรภัทร แจ่มมิน',
  role: 'USER',
  roleId: 'USER',
  department: 'QC',
  departmentId: 'QC',
  level: 1,
};

/** PO ที่รอเคลม — สถานะ CLAIM_PENDING */
const mockClaimPendingPO = {
  id: 'PO-CLAIM-INTEG-001',
  poNo: 'PO-2026-CLAIM-INTEG-01',
  docType: 'PO',
  status: 'CLAIM_PENDING',
  purchaseChannel: 'ONLINE',
  department: 'QC',
  requestedBy: 'สิรภัทร แจ่มมิน',
  requesterId: 'USR-SIRAPHAT-01',
  hasUnresolvedClaim: true,
  createdAt: new Date().toISOString(),
  items: [{ name: 'สินค้าติดเคลม', orderedQty: 10, receivedQty: 8, shortageQty: 2 }],
};

/** PO ที่รอสินค้าทดแทนรอบ 2 — สถานะ WAITING_DELIVERY_ROUND_2 */
const mockRound2PO = {
  id: 'PO-ROUND2-INTEG-002',
  poNo: 'PO-2026-ROUND2-INTEG-02',
  docType: 'PO',
  status: 'WAITING_DELIVERY_ROUND_2',
  purchaseChannel: 'ONLINE',
  department: 'QC',
  requestedBy: 'สิรภัทร แจ่มมิน',
  requesterId: 'USR-SIRAPHAT-01',
  hasUnresolvedClaim: false,
  createdAt: new Date().toISOString(),
  items: [{ name: 'สินค้ารอทดแทน', orderedQty: 10, receivedQty: 8, shortageQty: 2 }],
};

// ─── Integration Tests ───────────────────────────────────────────────────────
describe('WorkspaceView Integration: REQUESTER Task Routing Isolation', async () => {
  // Dynamic import ต้องอยู่หลัง vi.mock
  const { default: WorkspaceView } = await import('../src/views/WorkspaceView');

  /**
   * Helper: Render WorkspaceView พร้อม mock data
   */
  function renderWorkspace({ pos = [], prs = [] } = {}) {
    return render(
      React.createElement(WorkspaceView, {
        prs,
        pos,
        currentUser: mockRequester,
        currentRole: mockRequester,
        onNavigate: vi.fn(),
        onRefresh: vi.fn(),
        onEditPR: vi.fn(),
      })
    );
  }

  describe('แท็บ "ต้องดำเนินการ (To Do)" — กฎเหล็ก REQUESTER', () => {
    it('ไม่แสดง CLAIM_PENDING PO ใน To-Do ของ REQUESTER เด็ดขาด', () => {
      renderWorkspace({ pos: [mockClaimPendingPO] });

      const todoCards = screen.queryAllByTestId('task-card');
      const claimCards = todoCards.filter(
        c => c.getAttribute('data-status') === 'CLAIM_PENDING'
      );
      expect(claimCards).toHaveLength(0);
    });

    it('ไม่แสดง WAITING_DELIVERY_ROUND_2 PO ใน To-Do ของ REQUESTER เด็ดขาด', () => {
      renderWorkspace({ pos: [mockRound2PO] });

      const todoCards = screen.queryAllByTestId('task-card');
      const round2Cards = todoCards.filter(
        c => c.getAttribute('data-status') === 'WAITING_DELIVERY_ROUND_2'
      );
      expect(round2Cards).toHaveLength(0);
    });

    it('To-Do = 0 รายการ เมื่อ REQUESTER มีเฉพาะ PO ที่ติดเคลม/รอรอบ 2', () => {
      renderWorkspace({ pos: [mockClaimPendingPO, mockRound2PO] });

      // To-Do tab = default — ต้องไม่มีการ์ดใดแสดงเลย
      const todoCards = screen.queryAllByTestId('task-card');
      expect(todoCards).toHaveLength(0);
    });
  });

  describe('แท็บ "รอผู้อื่นดำเนินการ (In Progress)" — REQUESTER ต้องเห็นการ์ด', () => {
    it('แสดง CLAIM_PENDING PO ใน In Progress ของ REQUESTER', () => {
      renderWorkspace({ pos: [mockClaimPendingPO] });

      // คลิก In Progress tab
      const inProgressTab = screen.getByRole('button', {
        name: /รอผู้อื่น|in.?progress|waiting/i,
      });
      fireEvent.click(inProgressTab);

      const inProgressCards = screen.queryAllByTestId('task-card');
      const claimCards = inProgressCards.filter(
        c => c.getAttribute('data-status') === 'CLAIM_PENDING'
      );
      expect(claimCards.length).toBeGreaterThanOrEqual(1);
    });

    it('แสดง WAITING_DELIVERY_ROUND_2 PO ใน In Progress ของ REQUESTER', () => {
      renderWorkspace({ pos: [mockRound2PO] });

      const inProgressTab = screen.getByRole('button', {
        name: /รอผู้อื่น|in.?progress|waiting/i,
      });
      fireEvent.click(inProgressTab);

      const inProgressCards = screen.queryAllByTestId('task-card');
      const round2Cards = inProgressCards.filter(
        c => c.getAttribute('data-status') === 'WAITING_DELIVERY_ROUND_2'
      );
      expect(round2Cards.length).toBeGreaterThanOrEqual(1);
    });

    it('แสดงการ์ดทั้ง CLAIM_PENDING และ WAITING_DELIVERY_ROUND_2 ใน In Progress พร้อมกัน', () => {
      renderWorkspace({ pos: [mockClaimPendingPO, mockRound2PO] });

      const inProgressTab = screen.getByRole('button', {
        name: /รอผู้อื่น|in.?progress|waiting/i,
      });
      fireEvent.click(inProgressTab);

      const inProgressCards = screen.queryAllByTestId('task-card');
      expect(inProgressCards.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Smoke Test: PO สถานะปกติ (ไม่มีเคลม)', () => {
    it('PO สถานะ ORDERED ไม่โผล่ To-Do เมื่อ workflowEngine.canAction = false', () => {
      const orderedPO = {
        id: 'PO-ORDERED-003',
        poNo: 'PO-2026-ORDERED-03',
        docType: 'PO',
        status: 'ORDERED',
        purchaseChannel: 'ONLINE',
        department: 'QC',
        requestedBy: 'สิรภัทร แจ่มมิน',
        requesterId: 'USR-SIRAPHAT-01',
        hasUnresolvedClaim: false,
        createdAt: new Date().toISOString(),
        items: [],
      };

      renderWorkspace({ pos: [orderedPO] });

      // workflowEngine.canAction mock = false → ต้องไม่อยู่ใน To-Do
      const todoCards = screen.queryAllByTestId('task-card');
      expect(todoCards).toHaveLength(0);
    });
  });
});
