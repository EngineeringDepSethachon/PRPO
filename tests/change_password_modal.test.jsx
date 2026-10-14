// @vitest-environment jsdom
import React, { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const warning = vi.fn();
vi.mock('../src/services/modalService', () => ({
  modalService: { error: vi.fn(), success: vi.fn(), warning: (...a) => warning(...a), info: vi.fn() }
}));

import ChangePasswordModal from '../src/components/common/ChangePasswordModal.jsx';
import { AuthProvider, useAuth } from '../src/context/AuthContext.jsx';
import { SESSION_INVALID_EVENT, backendFetch } from '../src/config/backendMode.js';

const setInput = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const q = (id) => document.querySelector(`[data-testid="${id}"]`);
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

const SESSION = { id: 'U1', username: 'u', name: 'U', roleId: 'REQUESTER_PD', department: 'PD', level: 1, token: 'old-token', mustChangePassword: true, expiresAt: Date.now() + 3600000 };

describe('ChangePasswordModal (cloudflare mode)', () => {
  let container; let root; let authRef; let onClose;
  const Spy = () => { authRef = useAuth(); return null; };
  const mount = (props = {}) => act(() => {
    root.render(
      <AuthProvider>
        <Spy />
        <ChangePasswordModal isOpen onClose={onClose} {...props} />
      </AuthProvider>
    );
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('prpo_auth_session', JSON.stringify(SESSION));
    warning.mockClear();
    onClose = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('forced mode : no close button, has sign-out ; not rendered when closed', () => {
    mount({ forced: true });
    expect(q('change-password-modal')).toBeTruthy();
    expect(document.querySelector('[aria-label="ปิดหน้าต่าง"]')).toBeNull();
    expect(q('change-password-logout')).toBeTruthy();
    act(() => root.render(<AuthProvider><ChangePasswordModal isOpen={false} /></AuthProvider>));
    expect(q('change-password-modal')).toBeNull();
  });

  it('optional mode has the close button and no sign-out', () => {
    mount({ forced: false });
    expect(document.querySelector('[aria-label="ปิดหน้าต่าง"]')).toBeTruthy();
    expect(q('change-password-logout')).toBeNull();
  });

  it('validates on the client before calling the server', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    mount({ forced: true });
    const submit = () => act(() => { q('change-password-submit').click(); });
    submit();
    expect(q('change-password-error').textContent).toContain('รหัสผ่านเดิม');
    act(() => setInput(q('current-password-input'), 'OldPass1'));
    act(() => setInput(q('new-password-input'), '123'));
    submit();
    expect(q('change-password-error').textContent).toContain('อย่างน้อย 6');
    act(() => setInput(q('new-password-input'), 'BrandNew77'));
    act(() => setInput(q('confirm-password-input'), 'Different77'));
    submit();
    expect(q('change-password-error').textContent).toContain('ไม่ตรงกัน');
    act(() => setInput(q('new-password-input'), 'OldPass1'));
    act(() => setInput(q('confirm-password-input'), 'OldPass1'));
    submit();
    expect(q('change-password-error').textContent).toContain('ไม่ซ้ำ');
    expect(f.mock.calls.filter(([u]) => String(u).startsWith('/api'))).toEqual([]);
  });

  it('server error is shown and the session is untouched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'รหัสผ่านเดิมไม่ถูกต้อง' }) }));
    mount({ forced: true });
    act(() => setInput(q('current-password-input'), 'wrong'));
    act(() => setInput(q('new-password-input'), 'BrandNew77'));
    act(() => setInput(q('confirm-password-input'), 'BrandNew77'));
    await act(async () => { q('change-password-submit').click(); });
    await flush();
    expect(q('change-password-error').textContent).toBe('รหัสผ่านเดิมไม่ถูกต้อง');
    expect(JSON.parse(localStorage.getItem('prpo_auth_session'))).toMatchObject({ token: 'old-token', mustChangePassword: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('success : posts currentPassword/newPassword with the Bearer token, stores the NEW token and clears mustChangePassword', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, token: 'new-token', mustChangePassword: false }) });
    vi.stubGlobal('fetch', f);
    mount({ forced: true });
    act(() => setInput(q('current-password-input'), 'OldPass1'));
    act(() => setInput(q('new-password-input'), 'BrandNew77'));
    act(() => setInput(q('confirm-password-input'), 'BrandNew77'));
    await act(async () => { q('change-password-submit').click(); });
    await flush();
    const [url, init] = f.mock.calls.find(([u]) => String(u).startsWith('/api'));
    expect(url).toBe('/api/me/password');
    expect(JSON.parse(init.body)).toEqual({ currentPassword: 'OldPass1', newPassword: 'BrandNew77' });
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer old-token');
    expect(JSON.parse(localStorage.getItem('prpo_auth_session'))).toMatchObject({ token: 'new-token', mustChangePassword: false });
    expect(authRef.currentUser).toMatchObject({ token: 'new-token', mustChangePassword: false });
    expect(onClose).toHaveBeenCalled();
  });

  it('a 401 on a call that carried the token (changed elsewhere) -> "กรุณาเข้าสู่ระบบใหม่" once and the session is dropped ; login calls never trigger it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));
    mount({ forced: false });
    await act(async () => { await backendFetch('/api/auth', { method: 'POST' }); });
    expect(warning).not.toHaveBeenCalled();
    await act(async () => { await backendFetch('/api/bootstrap'); await backendFetch('/api/prs'); });
    await flush();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toBe('กรุณาเข้าสู่ระบบใหม่');
    expect(localStorage.getItem('prpo_auth_session')).toBeNull();
    expect(SESSION_INVALID_EVENT).toBe('prpo_session_invalid');
  });

  it('token expired vs revoked : different messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ code: 'TOKEN_EXPIRED' }), clone() { return this; } }));
    mount({ forced: false });
    await act(async () => { await backendFetch('/api/bootstrap'); });
    await flush();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0].join(' ')).toContain('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  });

  it('two tabs : a 401 for the OLD token while storage already holds a newer one -> adopt the newer session, no sign-out, nothing deleted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ code: 'TOKEN_REVOKED' }), clone() { return this; } }));
    mount({ forced: false });
    await flush();
    // the request leaves with the token that is in storage NOW ('old-token') ; before the answer arrives another tab stores a new session
    const pending = backendFetch('/api/bootstrap');
    localStorage.setItem('prpo_auth_session', JSON.stringify({ ...SESSION, token: 'tab2-token', mustChangePassword: false }));
    await act(async () => { await pending; });
    await flush();
    expect(warning).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('prpo_auth_session')).token).toBe('tab2-token');
    expect(authRef.currentUser.token).toBe('tab2-token');
  });

  it('logout() of a tab with an old token does not remove the newer session of another tab', async () => {
    mount({ forced: false });
    await flush();
    expect(authRef.currentUser.token).toBe('old-token');
    localStorage.setItem('prpo_auth_session', JSON.stringify({ ...SESSION, token: 'tab2-token' }));
    act(() => authRef.logout());
    expect(authRef.currentUser).toBeNull();
    expect(JSON.parse(localStorage.getItem('prpo_auth_session')).token).toBe('tab2-token');
    // the same tab with an up-to-date token does clear the session
    localStorage.setItem('prpo_auth_session', JSON.stringify(SESSION));
    act(() => root.render(<AuthProvider><Spy /></AuthProvider>));
    await flush();
    act(() => authRef.logout());
    expect(localStorage.getItem('prpo_auth_session')).toBeNull();
  });

  it('storage sync : the SAME user with a new token / mustChangePassword / expiresAt updates this tab', async () => {
    mount({ forced: false });
    await flush();
    expect(authRef.currentUser).toMatchObject({ token: 'old-token', mustChangePassword: true });
    const next = { ...SESSION, token: 'tab2-token', mustChangePassword: false, expiresAt: SESSION.expiresAt + 1000 };
    localStorage.setItem('prpo_auth_session', JSON.stringify(next));
    await act(async () => { window.dispatchEvent(new Event('storage')); });
    expect(authRef.currentUser).toMatchObject({ token: 'tab2-token', mustChangePassword: false, expiresAt: next.expiresAt });
  });

  it('another tab signed out : a revalidation does not write a session back and this tab goes back to signed-out', async () => {
    const { isStoredSessionGone, announceSessionGone } = await import('../src/config/backendMode.js');
    mount({ forced: false });
    await flush();
    expect(isStoredSessionGone()).toBe(false);
    localStorage.removeItem('prpo_auth_session'); // the other tab's logout
    expect(isStoredSessionGone()).toBe(true);
    await act(async () => { announceSessionGone(); });
    expect(authRef.currentUser).toBeNull();
    expect(localStorage.getItem('prpo_auth_session')).toBeNull(); // nothing written back
    vi.stubEnv('VITE_BACKEND_MODE', 'mock');
    expect(isStoredSessionGone()).toBe(false);
  });

  it('storage event : the session key was removed by another tab -> this tab signs out at once', async () => {
    mount({ forced: false });
    await flush();
    expect(authRef.currentUser).not.toBeNull();
    localStorage.removeItem('prpo_auth_session');
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: 'prpo_auth_session', newValue: null })); });
    expect(authRef.currentUser).toBeNull();
    expect(localStorage.getItem('prpo_auth_session')).toBeNull();
  });

  it('withLatestStoredToken : a revalidation never writes an older token over a newer stored one', async () => {
    const { withLatestStoredToken } = await import('../src/config/backendMode.js');
    localStorage.setItem('prpo_auth_session', JSON.stringify({ ...SESSION, token: 'newer', mustChangePassword: false }));
    expect(withLatestStoredToken({ ...SESSION, token: 'older' })).toMatchObject({ token: 'newer', mustChangePassword: false });
    expect(withLatestStoredToken({ ...SESSION, token: 'newer' }).token).toBe('newer');
    vi.stubEnv('VITE_BACKEND_MODE', 'mock');
    expect(withLatestStoredToken({ ...SESSION, token: 'older' }).token).toBe('older');
  });

  it('cloudflare client session lifetime = server token TTL (8 h), not 24 h', async () => {
    const { authService } = await import('../src/services/authService.js');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ token: 't', user: { id: 'U9', username: 'u9', name: 'N', roleId: 'REQUESTER_PD', department: 'PD', level: 1 } }) }));
    const s = await authService.login('u9', 'whatever1');
    const ttl = s.expiresAt - Date.now();
    expect(ttl).toBeGreaterThan(7.9 * 3600 * 1000);
    expect(ttl).toBeLessThanOrEqual(8 * 3600 * 1000);
  });

  it('mock mode : a 401 never notifies', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'mock');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));
    mount({ forced: false });
    await act(async () => { await backendFetch('/api/bootstrap'); });
    expect(warning).not.toHaveBeenCalled();
  });
});
