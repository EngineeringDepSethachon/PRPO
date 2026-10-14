// @vitest-environment jsdom
import React, { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/services/modalService', () => ({
  modalService: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
}));

import { AuthProvider } from '../src/context/AuthContext.jsx';
import { SESSION_INVALID_EVENT, SESSION_GONE_EVENT } from '../src/config/backendMode.js';

const SESSION = (over = {}) => ({
  id: 'U1', userId: 'U1', username: 'u1', name: 'U1', roleId: 'REQUESTER_PD', department: 'PD', level: 1,
  token: 'tok-old', expiresAt: Date.now() + 3600_000, ...over
});
const seedData = () => {
  localStorage.setItem('prpo_products_data', JSON.stringify([{ id: 'p1', code: 'REAL-1', name: 'real' }]));
  localStorage.setItem('prpo_budgets_data', JSON.stringify({ PD: { monthlyBudget: 5 } }));
  localStorage.setItem('prpo_cf_cache_owner', 'U1');
  // one-time sample-cache purge marker already set (cache written by the current build)
  localStorage.setItem('prpo_cf_cache_ver', 'cf1-no-sample');
};

describe('cloudflare: every session-end path drops the cached real data', () => {
  let container, root;
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
    localStorage.setItem('prpo_auth_session', JSON.stringify(SESSION()));
    seedData();
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
  const mount = async () => {
    await act(async () => {
      root.render(<MemoryRouter><AuthProvider><div /></AuthProvider></MemoryRouter>);
    });
  };

  it('401 / expired token (SESSION_INVALID_EVENT) clears session and cache', async () => {
    await mount();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(SESSION_INVALID_EVENT, { detail: { token: 'tok-old', code: 'TOKEN_EXPIRED' } }));
      await Promise.resolve();
    });
    expect(localStorage.getItem('prpo_auth_session')).toBeNull();
    expect(localStorage.getItem('prpo_products_data')).toBeNull();
    expect(localStorage.getItem('prpo_budgets_data')).toBeNull();
    expect(localStorage.getItem('prpo_cf_cache_owner')).toBeNull();
  });

  it('401 on an OLD token while another tab holds a newer session keeps the data', async () => {
    await mount();
    localStorage.setItem('prpo_auth_session', JSON.stringify(SESSION({ token: 'tok-new' })));
    await act(async () => {
      window.dispatchEvent(new CustomEvent(SESSION_INVALID_EVENT, { detail: { token: 'tok-old', code: 'TOKEN_INVALID' } }));
      await Promise.resolve();
    });
    expect(localStorage.getItem('prpo_products_data')).not.toBeNull();
    expect(localStorage.getItem('prpo_auth_session')).not.toBeNull();
  });

  it('signed out in another tab (SESSION_GONE_EVENT, no stored session) clears the cache', async () => {
    await mount();
    localStorage.removeItem('prpo_auth_session');
    seedData(); // what this tab still holds
    await act(async () => {
      window.dispatchEvent(new CustomEvent(SESSION_GONE_EVENT));
      await Promise.resolve();
    });
    expect(localStorage.getItem('prpo_products_data')).toBeNull();
    expect(localStorage.getItem('prpo_cf_cache_owner')).toBeNull();
  });

  it('SESSION_GONE_EVENT while a newer session exists does nothing', async () => {
    await mount();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(SESSION_GONE_EVENT));
      await Promise.resolve();
    });
    expect(localStorage.getItem('prpo_products_data')).not.toBeNull();
  });

  it('a cache that belongs to another user id is dropped before anything can render it', async () => {
    localStorage.setItem('prpo_cf_cache_owner', 'U-OTHER');
    vi.resetModules();
    const { storageService } = await import('../src/services/storageService.js');
    expect(storageService.getProducts()).toEqual([]);
    expect(localStorage.getItem('prpo_products_data')).toBeNull();
  });

  it('same user keeps the cache across a reload', async () => {
    vi.resetModules();
    const { storageService } = await import('../src/services/storageService.js');
    expect(storageService.getProducts().map(p => p.code)).toEqual(['REAL-1']);
  });
});
