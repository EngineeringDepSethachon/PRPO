// @vitest-environment jsdom
// M7-1b : Audit Log view in cloudflare mode reads GET /api/audit-logs (no seed, no localStorage fallback, token change drops the result).
import React, { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/services/modalService', () => ({
  modalService: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), confirm: vi.fn() }
}));

import AuditLogView from '../src/views/admin/AuditLogView.jsx';

const SESSION = (over = {}) => ({
  id: 'U1', userId: 'U1', username: 'u1', name: 'U1', roleId: 'ADMIN', department: 'PD', level: 1,
  token: 'tok-old', expiresAt: Date.now() + 3600_000, ...over
});

const ROW = (over = {}) => ({
  id: 'AL-1', timestamp: '2026-10-10T03:00:00.000Z', createdAt: '2026-10-10T03:00:00.000Z',
  action: 'CREATE', module: 'PURCHASE', targetRef: 'PR-001', docNo: 'PR-001',
  actor: { id: 'U1', name: 'สมชาย', role: 'Staff', department: 'PD' },
  actorName: 'สมชาย', actorRole: 'Staff', summary: 'สร้าง PR ทดสอบ', details: '', comment: '', changes: [],
  ...over
});

const flush = async () => {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
};

describe('AuditLogView : cloudflare mode reads the server', () => {
  let container, root;
  beforeEach(() => {
    vi.unstubAllEnvs();
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('prpo_auth_session', JSON.stringify(SESSION()));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const mount = async () => {
    await act(async () => { root.render(<AuditLogView currentRole="ADMIN" currentUser={{ id: 'U1' }} />); });
    await flush();
  };

  it('calls GET /api/audit-logs?limit=2000 with the bearer token and shows the server rows', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [ROW()] });
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/audit-logs?limit=2000');
    expect(new Headers(init && init.headers).get('Authorization')).toBe('Bearer tok-old');
    expect(container.textContent).toContain('สร้าง PR ทดสอบ');
    expect(container.textContent).toContain('PR-001');
  });

  it('does NOT seed sample rows and does NOT write localStorage in cloudflare mode', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [] }));
    await mount();
    expect(localStorage.getItem('app_audit_logs')).toBeNull();
    expect(localStorage.getItem('prpo_audit_logs')).toBeNull();
    expect(container.textContent).toContain('ไม่พบรายการบันทึกประวัติ');
  });

  it('request failure shows an empty list, logs an error and never falls back to localStorage rows', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    localStorage.setItem('app_audit_logs', JSON.stringify([ROW({ id: 'LOCAL-1', summary: 'แถวจาก localStorage' })]));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await mount();
    expect(container.textContent).not.toContain('แถวจาก localStorage');
    expect(container.textContent).toContain('ไม่พบรายการบันทึกประวัติ');
    expect(errSpy).toHaveBeenCalled();
  });

  it('drops the response when the session token changed while the request was in flight', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    let resolveFetch;
    const pending = new Promise((r) => { resolveFetch = r; });
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending));
    await mount();
    // another user signs in while the old request is still pending
    localStorage.setItem('prpo_auth_session', JSON.stringify(SESSION({ token: 'tok-new' })));
    await act(async () => { resolveFetch({ ok: true, status: 200, json: async () => [ROW({ summary: 'ของผู้ใช้เก่า' })] }); });
    await flush();
    expect(container.textContent).not.toContain('ของผู้ใช้เก่า');
    expect(container.textContent).toContain('ไม่พบรายการบันทึกประวัติ');
  });

  it('mock mode keeps the existing localStorage path (no server request)', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'mock');
    localStorage.setItem('app_audit_logs', JSON.stringify([ROW({ id: 'LOCAL-1', summary: 'แถว mock' })]));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/audit-logs'))).toBe(false);
    expect(container.textContent).toContain('แถว mock');
  });
});
