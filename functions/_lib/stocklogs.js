// Stock log rows for the UI (TC-007). D1 stores a movement under its own column names (createdAt, quantity, changeQty, notes ...) while the
// screens (QuickIssue statistics / history, stock tables) were written for the GAS sheet and read timestamp / date / qty / note. Every stock-log
// row leaving the server goes through stockLogView(), which KEEPS the D1 names and ADDS the UI names only where the row has none (alias, like
// productView). Apply it AFTER utcIsoRows() so the time aliases are already ISO-Z.

const hasVal = (v) => v !== undefined && v !== null && v !== '';

export function stockLogView(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  const when = row.createdAt || row.timestamp || row.date;
  if (!hasVal(row.timestamp) && hasVal(when)) out.timestamp = when;
  if (!hasVal(row.date) && hasVal(when)) out.date = when;
  if (!hasVal(row.qty)) {
    const q = Number(row.quantity ?? row.changeQty);
    if (Number.isFinite(q)) out.qty = Math.abs(q);
  }
  if (!hasVal(row.note) && hasVal(row.notes)) out.note = row.notes;
  if (!hasVal(row.name) && hasVal(row.productName)) out.name = row.productName;
  if (!hasVal(row.balanceAfter) && hasVal(row.balance)) out.balanceAfter = row.balance;
  return out;
}

export const stockLogViews = (rows) => (Array.isArray(rows) ? rows.map(stockLogView) : rows);
