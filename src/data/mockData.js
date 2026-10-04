// Master Data is hosted and served directly from Cloudflare D1 SQL Database.
// Hardcoded mock fallback data has been removed for production security and integrity.

export const initialStorageLocations = [];
export const initialProducts = [];
export const initialVendors = [];
export const initialPRs = [];
export const initialPOs = [];
export const initialStockLogs = [];
export const initialBudgets = {};
export const initialCounters = {
  PD: { PR: 0, PO: 0 },
  QC: { PR: 0, PO: 0 }
};
