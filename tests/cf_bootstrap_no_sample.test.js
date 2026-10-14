import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import './setup.js';

// Bug A/B: cloudflare mode must not seed sample data, must not hit /api/storage, and logout clears cached real data.
const loadStorage = async (mode) => {
  vi.resetModules();
  vi.unstubAllEnvs();
  if (mode) vi.stubEnv('VITE_BACKEND_MODE', mode);
  return import('../src/services/storageService.js');
};

describe('cloudflare mode: no sample seed / no /api/storage (bugs A, B)', () => {
  let fetchMock;
  const originalFetch = global.fetch;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    global.fetch = fetchMock;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('does not seed sample catalogue on first open', async () => {
    const { storageService } = await loadStorage('cloudflare');
    expect(storageService.getProducts()).toEqual([]);
    expect(storageService.getDepartments()).toEqual([]);
    expect(storageService.getBudgets()).toEqual({});
    expect(storageService.getVendors()).toEqual([]);
    expect(storageService.getStorageLocations()).toEqual([]);
    expect(storageService.getUsageUnits()).toEqual([]);
    expect(storageService.getUsers()).toEqual([]);
    expect(localStorage.getItem('prpo_data_version')).toBeNull();
  });

  it('purges sample data left by an older build, once', async () => {
    localStorage.setItem('prpo_auth_session', JSON.stringify({ id: 'REQUESTER_PD', userId: 'U1', token: 'tok' }));
    localStorage.setItem('prpo_data_version', 'prpo_clean_v16_empty_state');
    localStorage.setItem('prpo_products_data', JSON.stringify([{ id: 'x', code: 'PD-OIL-068', name: 'sample' }]));
    localStorage.setItem('prpo_departments_data', JSON.stringify([{ id: 'D', code: 'PD', name: 'PD' }]));
    const { storageService } = await loadStorage('cloudflare');
    expect(storageService.getProducts()).toEqual([]);
    expect(storageService.getDepartments()).toEqual([]);
    // real data cached afterwards survives a reload (marker already set)
    storageService.saveProducts([{ id: 'p1', code: 'REAL-1', name: 'real item', department: 'PD', status: 'ACTIVE' }]);
    storageService.setCloudflareCacheOwner('U1');
    const again = await loadStorage('cloudflare');
    expect(again.storageService.getProducts().map(p => p.code)).toEqual(['REAL-1']);
  });

  it('never POSTs /api/storage when state changes', async () => {
    const { storageService } = await loadStorage('cloudflare');
    storageService.hydrateFromClientStorage();
    storageService.saveDepartments([{ id: 'D1', code: 'PD', name: 'PD' }]);
    storageService.saveVendors([{ id: 'V1', name: 'v' }]);
    storageService.saveBudgets({ PD: { monthlyBudget: 1 } });
    await new Promise(r => setTimeout(r, 10));
    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls.filter(u => u.includes('/api/storage') && !u.includes('storage-locations'))).toEqual([]);
  });

  it('logout cache clear removes real data of the previous user', async () => {
    const { storageService } = await loadStorage('cloudflare');
    storageService.saveProducts([{ id: 'p1', code: 'REAL-1', name: 'real item', department: 'PD', status: 'ACTIVE' }]);
    storageService.saveBudgets({ PD: { monthlyBudget: 5 } });
    expect(storageService.getProducts().length).toBe(1);
    storageService.clearCloudflareDataCache();
    expect(storageService.getProducts()).toEqual([]);
    expect(storageService.getBudgets()).toEqual({});
    expect(localStorage.getItem('prpo_products_data')).toBeNull();
  });

  it('apiService.getBootstrapData: no token -> no request ; token -> uses server data', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    const { apiService } = await import('../src/services/apiService.js');
    const { storageService } = await import('../src/services/storageService.js');
    expect(await apiService.getBootstrapData()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    localStorage.setItem('prpo_auth_session', JSON.stringify({ token: 'tok' }));
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ products: [{ id: 'p9', code: 'E2E-1', name: 'server item', department: 'PD', status: 'ACTIVE' }], departments: [{ id: 'D1', code: 'PD', name: 'PD' }] })
    });
    const data = await apiService.getBootstrapData();
    expect(data.products[0].code).toBe('E2E-1');
    expect(storageService.getProducts().map(p => p.code)).toEqual(['E2E-1']);
    const call = global.fetch.mock.calls[0];
    expect(String(call[0])).toBe('/api/bootstrap');
  });

  it('bootstrap failure (500) throws instead of serving cached/sample data', async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    const { apiService } = await import('../src/services/apiService.js');
    localStorage.setItem('prpo_auth_session', JSON.stringify({ token: 'tok' }));
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(apiService.getBootstrapData()).rejects.toThrow();
  });

  it('mock mode still seeds and syncs as before', async () => {
    const { storageService } = await loadStorage('mock');
    expect(storageService.getProducts().length).toBeGreaterThan(0);
    expect(storageService.getDepartments().length).toBeGreaterThan(0);
    expect(localStorage.getItem('prpo_data_version')).toBe('prpo_clean_v16_empty_state');
    storageService.hydrateFromClientStorage();
    storageService.saveVendors([{ id: 'V1', name: 'v' }]);
    await new Promise(r => setTimeout(r, 10));
    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls).toContain('/api/storage');
  });
});
