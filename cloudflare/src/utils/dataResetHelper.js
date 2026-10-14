import { STORAGE_KEYS } from '../config/constants.js';
import { initialProducts } from '../data/mockData.js';
import { storageService } from '../services/storageService.js';
import { logAuditEvent } from '../services/auditLogger.js';

export const TRANSACTION_KEYS = [
  'app_pos',
  'app_prs',
  'mock_pos',
  'mock_prs',
  'purchase_orders',
  'purchase_requisitions',
  'online_tasks',
  'stock_movements',
  'app_audit_logs',
  'app_online_orders',
  'app_claims',
  'pr_list',
  'po_list',
  'prpo_prs_data',
  'prpo_pos_data',
  'prpo_stock_logs',
  'prpo_budget_transactions',
  'prpo_audit_logs',
  'prpo_in_app_notifications',
  'prpo_notifications',
  'prpo_pr_counters',
  'pr_counter',
  'currentRunningIndex'
];

export const PROTECTED_MASTER_KEYS = [
  'master_items',
  'master_vendors',
  'master_users',
  'departments',
  'auth_user',
  'app_company_profile',
  'prpo_products_data',
  'prpo_vendors_data',
  'prpo_users_data',
  'prpo_departments_data',
  'prpo_budgets_data',
  'prpo_storage_locations_data',
  'prpo_usage_units_data',
  'prpo_current_role'
];

/**
 * Reset all mock transaction data (PR, PO, online orders, stock movements, claims, audit logs)
 * to empty arrays [] and set app_data_cleared flag to true so initial mock auto-seeder does not re-seed.
 * Master Data (items, vendors, users, departments) is strictly preserved.
 */
export function resetMockTransactions(options = { reload: true }) {
  if (typeof localStorage !== 'undefined') {
    // 1. Write explicit empty arrays [] for all transaction keys to prevent null fallback
    TRANSACTION_KEYS.forEach(key => {
      try {
        localStorage.setItem(key, JSON.stringify([]));
      } catch (e) {
        console.warn(`[dataResetHelper] Failed to reset key ${key}:`, e.message);
      }
    });

    // 2. Set cleared flag to prevent Initial Mock Auto-seed
    localStorage.setItem('app_data_cleared', 'true');

    // 3. Reset budget spent and pending to 0 while strictly preserving master monthlyBudget configurations
    try {
      const storedBudgets = localStorage.getItem(STORAGE_KEYS.BUDGETS);
      if (storedBudgets) {
        const parsedB = JSON.parse(storedBudgets);
        if (parsedB && typeof parsedB === 'object') {
          const resetB = {};
          for (const [dept, b] of Object.entries(parsedB)) {
            resetB[dept] = {
              ...b,
              spent: 0,
              pending: 0,
              variance: b.monthlyBudget || 0,
              historicalSpent: {}
            };
          }
          localStorage.setItem(STORAGE_KEYS.BUDGETS, JSON.stringify(resetB));
        }
      }
    } catch (e) {
      console.warn('[dataResetHelper] Failed to reset budget balances:', e.message);
    }

    // 4. Reset Product Stock levels back to starting defaults while preserving 100% of Master Items
    try {
      const storedProducts = localStorage.getItem(STORAGE_KEYS.PRODUCTS);
      const initialMap = new Map((initialProducts || []).map(p => [p.id || p.code, p]));

      if (storedProducts) {
        const products = JSON.parse(storedProducts);
        if (Array.isArray(products)) {
          const resetProducts = products.map(prod => {
            const spec = initialMap.get(prod.id) || initialMap.get(prod.code);
            const initStock = spec ? (spec.stockBalance ?? spec.currentStock ?? spec.onHand ?? 0) : 0;
            return {
              ...prod,
              stockBalance: initStock,
              currentStock: initStock,
              onHand: initStock,
              stockQty: initStock
            };
          });
          localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(resetProducts));
          localStorage.setItem('master_items', JSON.stringify(resetProducts));
        }
      }
    } catch (e) {
      console.warn('[dataResetHelper] Failed to reset product stock balances:', e.message);
    }
  }

  // 5. Clear in storageService memory cache
  try {
    if (storageService && typeof storageService.clearMockTransactions === 'function') {
      storageService.clearMockTransactions();
    }
  } catch (e) {
    console.warn('[dataResetHelper] storageService reset warning:', e.message);
  }

  // 6. Log audit event
  try {
    logAuditEvent({
      module: 'SYSTEM',
      action: 'RESET_TRANSACTIONS',
      details: 'ล้างข้อมูลจำลอง (PR, PO, สต็อก) และตั้งค่าสถานะเป็น 0 ทั้งระบบ',
      docNo: 'SYSTEM_RESET'
    });
  } catch (e) {}

  // 7. Reload page immediately to clear state in memory
  if (options?.reload !== false && typeof window !== 'undefined') {
    window.location.reload();
  }
}

export const clearMockTransactions = resetMockTransactions;
export default resetMockTransactions;

