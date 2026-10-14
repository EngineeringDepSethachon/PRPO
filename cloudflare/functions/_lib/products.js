// Product rows for the UI (D-2). D1 stores products under its own column names (usageUnit, standardPrice, currentStock, minStock,
// defaultLocationId, isActive 0/1 ...) ; the screens, written for the GAS sheet, read price / stockBalance / reorderPoint / unit / stockUnit /
// avgCost / averageCost / totalValue / locationId / status / isActive (boolean). Every product leaving the server goes through productView(),
// which keeps the D1 names AND adds the UI names (alias), so neither side has to change. The inbound mapping (UI names -> D1 columns) is already in
// the products POST / PUT handlers (they accept both spellings).

import { utcIsoRow } from './timefmt.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export function productView(row, latestInPrice) {
  if (!row || typeof row !== 'object') return row;
  const stock = num(row.currentStock ?? row.stockBalance);
  let cost = num(row.avgCost ?? row.averageCost);
  let total = num(row.totalValue);
  // GAS applyProductCostFailSafe : stock > 0 and no cost -> latest IN price (positive) ; total value filled when empty
  if (stock > 0 && cost <= 0 && latestInPrice > 0) cost = latestInPrice;
  if (cost > 0 && total <= 0) total = Math.round(stock * cost * 100) / 100;
  const status = String(row.status || '').toUpperCase() || (row.isActive === 0 || row.isActive === false ? 'INACTIVE' : 'ACTIVE');
  const isActive = !(row.isActive === 0 || row.isActive === false || String(row.isActive).toLowerCase() === 'false' || status === 'INACTIVE');
  const usageUnit = row.usageUnit || row.stockUnit || row.unit || row.purchaseUnit || '';
  return {
    ...row,
    unit: usageUnit,
    stockUnit: usageUnit,
    purchaseUnit: row.purchaseUnit || usageUnit,
    conversionRate: num(row.conversionRate) || 1,
    price: num(row.standardPrice ?? row.price),
    stockBalance: stock,
    currentStock: stock,
    reorderPoint: num(row.minStock ?? row.reorderPoint),
    minStock: num(row.minStock ?? row.reorderPoint),
    avgCost: cost,
    averageCost: cost,
    totalValue: total,
    leadTimeDays: row.leadTimeDays == null || row.leadTimeDays === '' ? 7 : num(row.leadTimeDays),
    locationId: row.defaultLocationId || row.locationId || '',
    locationName: row.locationName || '',
    status,
    isActive
  };
}

// latest positive IN unit price per product (by productId, else by code) - only for the rows that need the GAS fail-safe, in small batches
async function latestInPrices(db, rows) {
  const need = rows.filter((r) => num(r.currentStock) > 0 && num(r.avgCost) <= 0);
  const byId = new Map();
  if (!db || !need.length) return byId;
  const CH = 30;
  for (let i = 0; i < need.length; i += CH) {
    const part = need.slice(i, i + CH);
    const ids = part.map((r) => String(r.id));
    const codes = part.map((r) => String(r.code || '').trim().toLowerCase()).filter(Boolean);
    const q = `SELECT productId, productCode, unitPrice, unitCost FROM stock_logs WHERE UPPER(type) = 'IN' AND quantity > 0 AND (productId IN (${ids.map(() => '?').join(',')})${codes.length ? ` OR LOWER(TRIM(productCode)) IN (${codes.map(() => '?').join(',')})` : ''}) ORDER BY createdAt DESC, rowid DESC`;
    const logs = (await db.prepare(q).bind(...ids, ...codes).all().catch(() => ({ results: [] }))).results || [];
    const byCode = new Map(part.map((r) => [String(r.code || '').trim().toLowerCase(), String(r.id)]));
    for (const l of logs) {
      const price = num(l.unitPrice) > 0 ? num(l.unitPrice) : num(l.unitCost);
      if (!(price > 0)) continue;
      const pid = ids.includes(String(l.productId)) ? String(l.productId) : byCode.get(String(l.productCode || '').trim().toLowerCase());
      if (pid && !byId.has(pid)) byId.set(pid, price); // rows come newest first
    }
  }
  return byId;
}

export async function productViews(db, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const prices = await latestInPrices(db, list);
  return list.map((r) => productView(utcIsoRow(r), prices.get(String(r.id))));
}
