import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import './setup.js';

const load = async (mode) => {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (mode) vi.stubEnv('VITE_BACKEND_MODE', mode);
  const { apiService } = await import('../src/services/apiService.js');
  const { storageService } = await import('../src/services/storageService.js');
  return { apiService, storageService };
};
const setSession = (token) => localStorage.setItem('prpo_auth_session', JSON.stringify({ id: 'REQUESTER_PD', userId: 'U1', username: 'u1', token }));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

describe('cloudflare cache hardening (kla follow-ups)', () => {
  const originalFetch = global.fetch;
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { global.fetch = originalFetch; vi.unstubAllEnvs(); });

  const GETTERS = [
    ['getUsers', '/api/users', [{ id: 'X', username: 'old-user' }], 'prpo_users_data'],
    ['getPRs', '/api/prs', [{ id: 'PR1', prNo: 'OLD-PR' }], 'prpo_prs_data'],
    ['getPOs', '/api/pos', [{ id: 'PO1', poNo: 'OLD-PO' }], 'prpo_pos_data'],
    ['getStockLogs', '/api/stock-logs', [{ id: 'L1', note: 'OLD-LOG' }], 'prpo_stock_logs_data'],
    ['getBudgets', '/api/budgets', { PD: { monthlyBudget: 999 } }, 'prpo_budgets_data'],
    ['getBudgetTransactions', '/api/budget-transactions', [{ id: 'T1', note: 'OLD-TX' }], 'prpo_budget_transactions']
  ];

  for (const [method, url, body] of GETTERS) {
    it(`${method}: response arriving after logout is not cached`, async () => {
      const { apiService, storageService } = await load('cloudflare');
      const before = JSON.stringify(Object.entries(localStorage));
      setSession('tok-a');
      const d = deferred();
      global.fetch = vi.fn().mockImplementation(() => d.promise);
      const p = apiService[method](true);
      localStorage.removeItem('prpo_auth_session'); // logout while in flight
      d.resolve({ ok: true, status: 200, json: async () => body });
      await p;
      const after = JSON.stringify(Object.entries(localStorage).filter(([k]) => k !== 'prpo_auth_session'));
      expect(after).not.toMatch(/OLD-|old-user|999/);
      expect(before).toBeDefined();
      expect(storageService).toBeDefined();
    });

    it(`${method}: response arriving after a user switch is not cached`, async () => {
      const { apiService } = await load('cloudflare');
      setSession('tok-a');
      const d = deferred();
      global.fetch = vi.fn().mockImplementation(() => d.promise);
      const p = apiService[method](true);
      setSession('tok-b');
      d.resolve({ ok: true, status: 200, json: async () => body });
      await p;
      expect(JSON.stringify(Object.entries(localStorage))).not.toMatch(/OLD-|old-user|999/);
    });
  }

  it('getUsers: same session still caches normally', async () => {
    const { apiService, storageService } = await load('cloudflare');
    setSession('tok-a');
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => [{ id: 'U9', username: 'fine' }] });
    const data = await apiService.getUsers(true);
    expect(data[0].username).toBe('fine');
    expect(storageService.getUsers().some(u => u.username === 'fine')).toBe(true);
  });

  it('clearCloudflareDataCache also drops prpo_budgets and per-user read-notification lists', async () => {
    const { storageService } = await load('cloudflare');
    // the shared in-memory localStorage mock has no key()/length : give it the standard enumeration API
    localStorage.key = (i) => Object.keys(localStorage.store)[i] ?? null;
    Object.defineProperty(localStorage, 'length', { configurable: true, get: () => Object.keys(localStorage.store).length });
    localStorage.setItem('prpo_budgets', JSON.stringify({ PD: 1 }));
    localStorage.setItem('prpo_read_notifications_alice', '["n1"]');
    localStorage.setItem('prpo_read_notifications_bob', '["n2"]');
    storageService.clearCloudflareDataCache();
    expect(localStorage.getItem('prpo_budgets')).toBeNull();
    expect(localStorage.getItem('prpo_read_notifications_alice')).toBeNull();
    expect(localStorage.getItem('prpo_read_notifications_bob')).toBeNull();
  });

  it('setCurrentRole: cloudflare never stores the bearer token in prpo_current_role', async () => {
    const { storageService } = await load('cloudflare');
    storageService.setCurrentRole({ id: 'R', username: 'u1', token: 'secret-token', name: 'U1' });
    const raw = localStorage.getItem('prpo_current_role');
    expect(raw).not.toContain('secret-token');
    expect(JSON.parse(raw)).toMatchObject({ username: 'u1', name: 'U1' });
  });

  it('setCurrentRole: mock mode keeps the object as before', async () => {
    const { storageService } = await load('mock');
    storageService.setCurrentRole({ id: 'R', username: 'u1', token: 'tok-mock' });
    expect(JSON.parse(localStorage.getItem('prpo_current_role')).token).toBe('tok-mock');
  });
});
