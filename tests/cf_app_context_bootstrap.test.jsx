// @vitest-environment jsdom
import React, { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// AuthContext is replaced by a controllable stub : the tests drive login / logout / user switch through `authState`
const authState = { currentUser: null };
vi.mock('../src/context/AuthContext.jsx', () => ({
  useAuth: () => ({ currentUser: authState.currentUser, canonicalRole: 'REQUESTER' }),
  normalizeRole: () => 'REQUESTER'
}));
vi.mock('../src/services/modalService', () => ({
  modalService: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), confirm: vi.fn() }
}));

const U = (id, token, extra = {}) => ({
  id: 'REQUESTER_PD', userId: id, username: id.toLowerCase(), name: id, roleId: 'REQUESTER_PD', department: 'PD', level: 1,
  token, expiresAt: Date.now() + 3600_000, ...extra
});
const payloadFor = (code) => ({
  products: [{ id: `p-${code}`, code, name: code, department: 'PD', status: 'ACTIVE' }],
  departments: [{ id: 'D1', code: 'PD', name: 'PD' }],
  users: []
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

describe('cloudflare AppContext: bootstrap after login / user switch / in-flight race', () => {
  let container, root, ctx, AppProvider, useAppContext, fetchMock;

  const Probe = () => { ctx = useAppContext(); return null; };
  const render = async () => {
    await act(async () => {
      root.render(<MemoryRouter><AppProvider><Probe /></AppProvider></MemoryRouter>);
    });
  };
  const signIn = (user) => {
    authState.currentUser = user;
    if (user) localStorage.setItem('prpo_auth_session', JSON.stringify(user));
    else localStorage.removeItem('prpo_auth_session');
  };
  const bootstrapCalls = () => fetchMock.mock.calls.filter(c => String(c[0]) === '/api/bootstrap');

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    localStorage.clear();
    sessionStorage.clear();
    authState.currentUser = null;
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    ({ AppProvider, useAppContext } = await import('../src/context/AppContext.jsx'));
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

  it('before login: no bootstrap request and no sample data', async () => {
    await render();
    expect(bootstrapCalls()).toHaveLength(0);
    expect(ctx.products).toEqual([]);
    expect(ctx.departments).toEqual([]);
  });

  it('login -> bootstraps immediately and hydrates context', async () => {
    await render();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => payloadFor('A-1') });
    signIn(U('UA', 'tok-a'));
    await render();
    expect(bootstrapCalls().length).toBeGreaterThanOrEqual(1);
    expect(ctx.products.map(p => p.code)).toEqual(['A-1']);
    expect(localStorage.getItem('prpo_cf_cache_owner')).toBe('UA');
  });

  it('logout clears state and cache ; switching user never shows the previous user data', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => payloadFor('A-1') });
    signIn(U('UA', 'tok-a'));
    await render();
    expect(ctx.products.map(p => p.code)).toEqual(['A-1']);

    signIn(null);
    await render();
    expect(ctx.products).toEqual([]);

    // user B signs in : B's bootstrap is held back -> A's data must not be on screen meanwhile
    const d = deferred();
    fetchMock.mockImplementation(() => d.promise);
    signIn(U('UB', 'tok-b'));
    await render();
    expect(ctx.products).toEqual([]);
    await act(async () => { d.resolve({ ok: true, status: 200, json: async () => payloadFor('B-1') }); });
    expect(ctx.products.map(p => p.code)).toEqual(['B-1']);
    expect(localStorage.getItem('prpo_cf_cache_owner')).toBe('UB');
  });

  it('race : a response that arrives after logout is discarded (no state, no cache, no owner)', async () => {
    const d = deferred();
    fetchMock.mockImplementation(() => d.promise);
    signIn(U('UA', 'tok-a'));
    await render();
    expect(bootstrapCalls()).toHaveLength(1);

    signIn(null); // logout while A's request is in flight
    await render();
    await act(async () => { d.resolve({ ok: true, status: 200, json: async () => payloadFor('A-LATE') }); });

    expect(ctx.products).toEqual([]);
    expect(localStorage.getItem('prpo_products_data')).toBeNull();
    expect(localStorage.getItem('prpo_cf_cache_owner')).toBeNull();
  });

  it('race : A\'s late response must not overwrite B after a user switch', async () => {
    const dA = deferred();
    const dB = deferred();
    fetchMock.mockImplementationOnce(() => dA.promise).mockImplementationOnce(() => dB.promise);
    signIn(U('UA', 'tok-a'));
    await render();
    signIn(U('UB', 'tok-b'));
    await render();
    await act(async () => { dB.resolve({ ok: true, status: 200, json: async () => payloadFor('B-1') }); });
    await act(async () => { dA.resolve({ ok: true, status: 200, json: async () => payloadFor('A-LATE') }); });
    expect(ctx.products.map(p => p.code)).toEqual(['B-1']);
    expect(localStorage.getItem('prpo_cf_cache_owner')).toBe('UB');
    expect(String(localStorage.getItem('prpo_products_data'))).not.toContain('A-LATE');
  });

  it('session without userId : cache owner falls back to username (never the role id)', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => payloadFor('N-1') });
    signIn(U('X', 'tok-n', { userId: undefined, username: 'noid' }));
    await render();
    expect(ctx.products.map(p => p.code)).toEqual(['N-1']);
    expect(localStorage.getItem('prpo_cf_cache_owner')).toBe('noid');
  });
});
