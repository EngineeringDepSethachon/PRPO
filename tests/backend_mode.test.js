// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getBackendMode,
  isGASMode,
  isCloudflareMode,
  isMockMode,
  getAuthToken,
  backendFetch
} from '../src/config/backendMode.js';
import { authService } from '../src/services/authService.js';

const setSession = (obj) => localStorage.setItem('prpo_auth_session', JSON.stringify(obj));

describe('backendMode selector', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_BACKEND_MODE', '');
    vi.stubEnv('VITE_USE_GAS', '');
    delete window.google;
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    delete window.google;
  });

  it('unset -> mock', () => {
    expect(getBackendMode()).toBe('mock');
    expect(isMockMode()).toBe(true);
    expect(isGASMode()).toBe(false);
  });

  it('unset + VITE_USE_GAS=true -> gas', () => {
    vi.stubEnv('VITE_USE_GAS', 'true');
    expect(getBackendMode()).toBe('gas');
  });

  it('unset + window.google.script.run -> gas', () => {
    window.google = { script: { run: {} } };
    expect(isGASMode()).toBe(true);
  });

  it('explicit cloudflare / gas / mock (case + whitespace tolerant)', () => {
    vi.stubEnv('VITE_BACKEND_MODE', ' Cloudflare ');
    expect(isCloudflareMode()).toBe(true);
    vi.stubEnv('VITE_BACKEND_MODE', 'GAS');
    expect(getBackendMode()).toBe('gas');
    vi.stubEnv('VITE_BACKEND_MODE', 'mock');
    expect(getBackendMode()).toBe('mock');
  });

  it('invalid value falls back to legacy detection', () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'bogus');
    expect(getBackendMode()).toBe('mock');
    vi.stubEnv('VITE_USE_GAS', 'true');
    expect(getBackendMode()).toBe('gas');
  });
});

describe('getAuthToken / backendFetch', () => {
  let fetchMock;
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_BACKEND_MODE', '');
    localStorage.clear();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('getAuthToken: empty on missing/corrupt/non-string token', () => {
    expect(getAuthToken()).toBe('');
    localStorage.setItem('prpo_auth_session', '{bad json');
    expect(getAuthToken()).toBe('');
    setSession({ token: 123 });
    expect(getAuthToken()).toBe('');
    setSession({ token: 'abc' });
    expect(getAuthToken()).toBe('abc');
  });

  it('non-cloudflare: pass-through, no Authorization even with token', async () => {
    setSession({ token: 'abc' });
    const init = { method: 'POST' };
    await backendFetch('/api/x', init);
    expect(fetchMock).toHaveBeenCalledWith('/api/x', init);
  });

  it('cloudflare: adds Bearer and preserves other headers/method', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    setSession({ token: 'abc' });
    await backendFetch('/api/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(init.headers.get('Authorization')).toBe('Bearer abc');
    expect(init.headers.get('Content-Type')).toBe('application/json');
  });

  it('cloudflare: does not override caller Authorization; no token -> untouched', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    setSession({ token: 'abc' });
    await backendFetch('/api/x', { headers: { Authorization: 'Bearer own' } });
    expect(fetchMock.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer own');
    localStorage.clear();
    const init = {};
    await backendFetch('/api/y', init);
    expect(fetchMock.mock.calls[1][1]).toBe(init);
  });

  it('cloudflare: works with no init argument', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    setSession({ token: 'abc' });
    await backendFetch('/api/x');
    expect(fetchMock.mock.calls[0][1].headers.get('Authorization')).toBe('Bearer abc');
  });
});

describe('authService.login in cloudflare mode', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('401 from server is rejected (no local fallback)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401, json: async () => ({ error: 'bad' })
    }));
    await expect(authService.login('admin', 'password123')).rejects.toThrow('bad');
    expect(localStorage.getItem('prpo_auth_session')).toBeNull();
  });

  it('success stores token in session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ token: 'tok1', user: { id: 'U1', username: 'u', name: 'U', roleId: 'REQUESTER_PD', department: 'PD', level: 1 } })
    }));
    const s = await authService.login('u', 'pw');
    expect(s.token).toBe('tok1');
    expect(JSON.parse(localStorage.getItem('prpo_auth_session')).token).toBe('tok1');
  });

  // SECURITY: these assert the SAFE behaviour; they FAIL today (local-credential fallback).
  it('network failure must NOT log in via local default accounts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')));
    await expect(authService.login('admin', 'password123')).rejects.toThrow();
    expect(localStorage.getItem('prpo_auth_session')).toBeNull();
  });

  it('server 500 must NOT log in via local default accounts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    await expect(authService.login('wichai.pd', '123456')).rejects.toThrow();
  });

  it('429 surfaces the server Thai error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 429, json: async () => ({ error: 'พยายามเข้าสู่ระบบมากเกินไป กรุณารอสักครู่' })
    }));
    await expect(authService.login('u', 'pw')).rejects.toThrow('พยายามเข้าสู่ระบบมากเกินไป กรุณารอสักครู่');
    expect(localStorage.getItem('prpo_auth_session')).toBeNull();
  });

  it('403 surfaces the server Thai error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 403, json: async () => ({ error: 'บัญชีนี้ถูกระงับการใช้งาน' })
    }));
    await expect(authService.login('u', 'pw')).rejects.toThrow('บัญชีนี้ถูกระงับการใช้งาน');
    expect(localStorage.getItem('prpo_auth_session')).toBeNull();
  });

  it('429/403 without error body fall back to the generic connection message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }));
    await expect(authService.login('u', 'pw')).rejects.toThrow('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้');
  });

  it('429 with non-string error field falls back to the generic connection message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 429, json: async () => ({ error: { code: 'RATE' } })
    }));
    await expect(authService.login('u', 'pw')).rejects.toThrow('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้');
  });

  it('5xx keeps the generic connection message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 503, json: async () => ({ error: 'server down' })
    }));
    await expect(authService.login('u', 'pw')).rejects.toThrow('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้');
  });
});

describe('cloudflare session guards (AuthContext)', () => {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const base = { id: 'U1', username: 'u', roleId: 'REQUESTER_PD' };

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('isSessionValid: no token = invalid in cloudflare, valid in mock', async () => {
    const { isSessionValid } = await import('../src/context/AuthContext.jsx');
    expect(isSessionValid({ ...base })).toBe(false);
    expect(isSessionValid({ ...base, token: '' })).toBe(false);
    vi.stubEnv('VITE_BACKEND_MODE', 'mock');
    expect(isSessionValid({ ...base })).toBe(true);
  });

  it('isSessionValid: checks exp in token payload; undecodable token is accepted', async () => {
    const { isSessionValid } = await import('../src/context/AuthContext.jsx');
    const now = Math.floor(Date.now() / 1000);
    expect(isSessionValid({ ...base, token: `${b64u({ exp: now + 3600 })}.sig` })).toBe(true);
    expect(isSessionValid({ ...base, token: `${b64u({ exp: now - 10 })}.sig` })).toBe(false);
    expect(isSessionValid({ ...base, token: 'opaque-token' })).toBe(true);
  });

  it('restore: tokenless stored session is cleared; switchRoleDev creates no session', async () => {
    const React = (await import('react')).default;
    const { renderToString } = await import('react-dom/server');
    const { AuthProvider, useAuth } = await import('../src/context/AuthContext.jsx');
    setSession({ ...base });
    let ctx;
    const Probe = () => { ctx = useAuth(); return null; };
    renderToString(React.createElement(AuthProvider, null, React.createElement(Probe)));
    expect(ctx.currentUser).toBeNull();
    expect(localStorage.getItem('prpo_auth_session')).toBeNull();
    expect(ctx.switchRoleDev('admin')).toBeNull();
    expect(localStorage.getItem('prpo_auth_session')).toBeNull();
  });
});
