// @vitest-environment jsdom
// S1 client : in cloudflare mode both stock modals call the server (never localStorage) ; mock mode keeps the localStorage behaviour
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../src/components/common/SearchableSelect', () => ({
  default: ({ options, value, onChange }) => (
    <select data-testid="prod" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">-</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}));

import StockAdjustmentModal from '../src/components/stock/StockAdjustmentModal';
import ManualStockInModal from '../src/components/stock/ManualStockInModal';
import { storageService } from '../src/services/storageService';

const PRODUCTS = [{ id: 'P1', code: 'C1', name: 'Glue', department: 'PD', category: 'PD', stockBalance: 10, stockUnit: 'pcs' }];
const ROLE = { name: 'wh', title: 'Warehouse', department: 'PD', canViewAllDepts: true };

const fill = (container, qty) => {
  fireEvent.change(screen.getByTestId('prod'), { target: { value: 'P1' } });
  fireEvent.change(document.body.querySelector('input[type="number"]'), { target: { value: String(qty) } });
};

describe('stock modals (S1)', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('cloudflare : adjust posts /api/stock/adjust (no localStorage write), then closes and reloads', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return new Response(JSON.stringify({ success: true }), { status: 200 }); }));
    const saveP = vi.spyOn(storageService, 'saveProducts');
    const saveL = vi.spyOn(storageService, 'saveStockLogs');
    const onClose = vi.fn(); const onRefresh = vi.fn();
    const { container } = render(<StockAdjustmentModal products={PRODUCTS} currentRole={ROLE} onClose={onClose} onRefresh={onRefresh} />);
    fill(container, 3);
    fireEvent.click(screen.getByText('ยืนยันปรับปรุงสต็อก'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/stock/adjust');
    expect(calls[0].body).toMatchObject({ productId: 'P1', direction: 'OUT', quantity: 3 });
    expect(calls[0].body.requestId).toBeTruthy();
    expect(onRefresh).toHaveBeenCalled();
    expect(saveP).not.toHaveBeenCalled();
    expect(saveL).not.toHaveBeenCalled();
  });

  it('cloudflare : requestId is kept on an untouched re-click and renewed when the form changes', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    const ids = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => { ids.push(JSON.parse(init.body).requestId); return new Response(JSON.stringify({ error: 'x' }), { status: 400 }); }));
    const { container } = render(<ManualStockInModal products={PRODUCTS} currentRole={ROLE} onClose={vi.fn()} onRefresh={vi.fn()} />);
    fill(container, 2);
    fireEvent.click(screen.getByText('ยืนยันรับเข้าสต็อก'));
    await waitFor(() => expect(ids).toHaveLength(1));
    await waitFor(() => expect(screen.getByText('ยืนยันรับเข้าสต็อก')).toBeTruthy());
    fireEvent.click(screen.getByText('ยืนยันรับเข้าสต็อก'));
    await waitFor(() => expect(ids).toHaveLength(2));
    expect(ids[1]).toBe(ids[0]);
    fireEvent.change(document.body.querySelector('input[type="number"]'), { target: { value: '3' } });
    fireEvent.click(screen.getByText('ยืนยันรับเข้าสต็อก'));
    await waitFor(() => expect(ids).toHaveLength(3));
    expect(ids[2]).not.toBe(ids[0]);
  });

  it('cloudflare : manual-in posts /api/stock/manual-in ; a server error stays in the form (modal not closed, message shown)', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'ไม่มีสิทธิ์ดำเนินการนี้' }), { status: 403 })));
    const onClose = vi.fn(); const onRefresh = vi.fn();
    const { container } = render(<ManualStockInModal products={PRODUCTS} currentRole={ROLE} onClose={onClose} onRefresh={onRefresh} />);
    fill(container, 2);
    fireEvent.click(screen.getByText('ยืนยันรับเข้าสต็อก'));
    await waitFor(() => expect(screen.getByText('ไม่มีสิทธิ์ดำเนินการนี้')).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0][0]).toBe('/api/stock/manual-in');
  });

  it('mock mode : unchanged (localStorage products + logs, no request)', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'mock');
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    storageService.saveProducts([{ id: 'P1', code: 'C1', name: 'Glue', department: 'PD', stockBalance: 10 }]);
    const onClose = vi.fn(); const onRefresh = vi.fn();
    const { container } = render(<ManualStockInModal products={PRODUCTS} currentRole={ROLE} onClose={onClose} onRefresh={onRefresh} />);
    fill(container, 2);
    fireEvent.click(screen.getByText('ยืนยันรับเข้าสต็อก'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(storageService.getProducts().find((p) => p.id === 'P1').stockBalance).toBe(12);
    expect(storageService.getStockLogs()[0]).toMatchObject({ type: 'IN', qty: 2, balance: 12, isManual: true });
    const calledStockApi = f.mock.calls.some((c) => String(c[0]).startsWith('/api/stock/'));
    expect(calledStockApi).toBe(false);
  });
});
