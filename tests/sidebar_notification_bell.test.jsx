// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import './setup.js';

import Sidebar from '../src/components/common/Sidebar.jsx';
import { notificationService } from '../src/services/notificationService';
import { workflowEngine } from '../src/services/workflowEngine';

const cf = vi.hoisted(() => ({ on: false, fetch: null }));
vi.mock('../src/config/backendMode', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isCloudflareMode: () => cf.on || actual.isCloudflareMode(),
    backendFetch: (...a) => (cf.fetch ? cf.fetch(...a) : actual.backendFetch(...a)),
  };
});

// S5: bell + popover restored in Sidebar as in v1.0.1 (c12ce08).
// 2026-10-15 : bell badge = UNREAD notifications shown in the popover (was taskCounts.total : the tester saw "1" on the bell with 13 rows inside).
// Pending tasks keep their own badge on "งานของฉัน".
const admin = { id: 'ADMIN', roleId: 'ADMIN', role: 'admin', name: 'Admin', level: 99, assignedDepartments: ['ALL'] };
const NOTIFS = [
  { id: 'n1', type: 'PR_SUBMITTED', title: 'PR รอตรวจสอบ', message: 'PR-1', targetRole: 'ALL', targetDepartment: 'ALL', timestamp: '2026-10-01T00:00:00Z' },
  { id: 'n2', type: 'PO_APPROVED', title: 'PO อนุมัติแล้ว', message: 'PO-1', targetRole: 'ALL', targetDepartment: 'ALL', timestamp: '2026-10-02T00:00:00Z' },
];

const renderSidebar = (props = {}) => render(
  <MemoryRouter initialEntries={['/dashboard']}>
    <Sidebar currentRole={admin} currentUser={admin} prs={[]} pos={[]} {...props} />
  </MemoryRouter>
);

describe('Sidebar notification bell (S5)', () => {
  beforeEach(() => {
    localStorage.clear();
    notificationService.saveAll(NOTIFS);
    vi.spyOn(workflowEngine, 'getUserTasks').mockReturnValue({ counts: { total: 3, prCount: 0, poCount: 0 } });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the bell next to the refresh button with badge = unread notifications (not the 3 pending tasks)', () => {
    renderSidebar();
    const bell = screen.getAllByTitle('การแจ้งเตือน (2 รายการใหม่)')[0];
    expect(bell).toBeTruthy();
    expect(bell.textContent).toContain('2');
    expect(screen.queryByTitle('การแจ้งเตือน (3 รายการใหม่)')).toBeNull();
    expect(screen.getAllByLabelText('รีเฟรชข้อมูลล่าสุด').length).toBeGreaterThan(0);
  });

  it('badge equals the popover "ยังไม่อ่าน" count and drops when one row is read', async () => {
    notificationService.saveAll([...NOTIFS, { id: 'n3', title: 'อ่านแล้ว', targetRole: 'ALL', targetDepartment: 'ALL', timestamp: '2026-10-03T00:00:00Z', status: 'read' }]);
    renderSidebar();
    expect(screen.getAllByTitle('การแจ้งเตือน (2 รายการใหม่)').length).toBeGreaterThan(0);
    notificationService.markNotificationAsReadForUser('Admin', 'n1');
    await waitFor(() => expect(screen.getAllByTitle('การแจ้งเตือน (1 รายการใหม่)').length).toBeGreaterThan(0));
  });

  it('opens the popover with notifications when the bell is clicked', () => {
    renderSidebar();
    expect(screen.queryByText('การแจ้งเตือน')).toBeNull();
    fireEvent.click(screen.getAllByTitle(/การแจ้งเตือน \(/)[0]);
    expect(screen.getByText('การแจ้งเตือน')).toBeTruthy();
    expect(screen.getByText('PR รอตรวจสอบ')).toBeTruthy();
    expect(screen.getByText('PO อนุมัติแล้ว')).toBeTruthy();
  });

  const clickItem = (title) => {
    fireEvent.click(screen.getAllByTitle(/การแจ้งเตือน \(/)[0]);
    fireEvent.click(screen.getByText(title));
  };
  const seed = (n) => notificationService.saveAll([{ targetRole: 'ALL', targetDepartment: 'ALL', timestamp: '2026-10-03T00:00:00Z', ...n }]);

  it('clicking an item calls markAsRead, navigates to the PR list and closes the popover', async () => {
    const markAsRead = vi.spyOn(notificationService, 'markAsRead').mockResolvedValue([]);
    const onNavigate = vi.fn();
    seed({ id: 'n1', title: 'PR รอตรวจสอบ', refDocType: 'PR' });
    renderSidebar({ onNavigate });
    clickItem('PR รอตรวจสอบ');
    await waitFor(() => expect(markAsRead).toHaveBeenCalledWith('n1', 'Admin'));
    expect(onNavigate).toHaveBeenCalledWith('pr-list');
    expect(screen.queryByText('PR รอตรวจสอบ')).toBeNull();
  });

  it('PR with refDocId calls onOpenPR; PO with refDocId calls onOpenPO', () => {
    const onOpenPR = vi.fn(); const onOpenPO = vi.fn();
    seed({ id: 'n1', title: 'เอกสาร PR', refDocType: 'PR', refDocId: 'PR-9' });
    renderSidebar({ onOpenPR, onOpenPO });
    clickItem('เอกสาร PR');
    expect(onOpenPR).toHaveBeenCalledWith('PR-9');
    cleanup();
    seed({ id: 'n2', title: 'เอกสาร PO', refDocType: 'PO', refDocId: 'PO-9' });
    renderSidebar({ onOpenPR, onOpenPO });
    clickItem('เอกสาร PO');
    expect(onOpenPO).toHaveBeenCalledWith('PO-9');
  });

  it('PO without id goes to po-list, ONLINE_TASK PO goes to online-tasks, STOCK goes to stock-card', () => {
    const onNavigate = vi.fn();
    seed({ id: 'n1', title: 'PO ทั่วไป', refDocType: 'PO' });
    renderSidebar({ onNavigate });
    clickItem('PO ทั่วไป');
    expect(onNavigate).toHaveBeenLastCalledWith('po-list');
    cleanup();
    seed({ id: 'n2', title: 'งานออนไลน์', refDocType: 'PO', type: 'ONLINE_TASK' });
    renderSidebar({ onNavigate });
    clickItem('งานออนไลน์');
    expect(onNavigate).toHaveBeenLastCalledWith('online-tasks');
    cleanup();
    seed({ id: 'n3', title: 'สต็อกต่ำ', refDocType: 'STOCK' });
    renderSidebar({ onNavigate });
    clickItem('สต็อกต่ำ');
    expect(onNavigate).toHaveBeenLastCalledWith('stock-card');
  });

  it('online purchaser always navigates to online-tasks', () => {
    const onNavigate = vi.fn();
    const onOpenPR = vi.fn();
    const purchaser = { id: 'ONLINE_PURCHASER', roleId: 'ONLINE_PURCHASER', name: 'Buyer', level: 1, canOnlinePurchase: true, assignedDepartments: ['ALL'] };
    seed({ id: 'n1', title: 'PR ของผู้ซื้อ', refDocType: 'PR', refDocId: 'PR-1' });
    renderSidebar({ currentRole: purchaser, currentUser: purchaser, onNavigate, onOpenPR });
    clickItem('PR ของผู้ซื้อ');
    expect(onNavigate).toHaveBeenCalledWith('online-tasks');
    expect(onOpenPR).not.toHaveBeenCalled();
  });

  it('CF mode: one click sends exactly one PUT /api/notifications/:id', async () => {
    cf.on = true;
    cf.fetch = vi.fn().mockResolvedValue({ ok: true });
    try {
      seed({ id: 'srv-1', title: 'จาก server', refDocType: 'PR' });
      renderSidebar({ onNavigate: vi.fn() });
      clickItem('จาก server');
      await waitFor(() => expect(cf.fetch).toHaveBeenCalled());
      await new Promise(r => setTimeout(r, 20));
      expect(cf.fetch).toHaveBeenCalledTimes(1);
      const [url, opts] = cf.fetch.mock.calls[0];
      expect(url).toBe('/api/notifications/srv-1');
      expect(opts.method).toBe('PUT');
    } finally {
      cf.on = false; cf.fetch = null;
    }
  });

  it('refresh button and "งานของฉัน" badge are still present', () => {
    renderSidebar();
    expect(screen.getAllByLabelText('รีเฟรชข้อมูลล่าสุด').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('งานของฉัน').length).toBeGreaterThan(0);
  });

  it('"อ่านทั้งหมด" calls notificationService.markAllAsRead', async () => {
    const markAllAsRead = vi.spyOn(notificationService, 'markAllAsRead').mockResolvedValue([]);
    renderSidebar();
    fireEvent.click(screen.getAllByTitle(/การแจ้งเตือน \(/)[0]);
    fireEvent.click(screen.getByText('อ่านทั้งหมด'));
    await waitFor(() => expect(markAllAsRead).toHaveBeenCalled());
    const [, ids, user] = markAllAsRead.mock.calls[0];
    expect(ids.sort()).toEqual(['n1', 'n2']);
    expect(user).toBe('Admin');
  });
});
