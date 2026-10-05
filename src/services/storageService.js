import { STORAGE_KEYS, ROLES, INITIAL_USAGE_UNITS, INITIAL_DEPARTMENTS } from '../config/constants.js';
import { modalService } from './modalService.js';
import { normalizePR, normalizePO } from '../utils/dataNormalizer.js';
import { matchDepartment } from '../utils/permissions.js';
const DATA_VERSION = 'prpo_clean_v16_empty_state';
const API_URL = '/api/storage';

/**
 * Retrieves configured Google Apps Script Web App API URL.
 * Checks import.meta.env, window.__GAS_API_URL__, and localStorage.
 */
export const getGasApiUrl = () => {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GAS_API_URL) {
    return import.meta.env.VITE_GAS_API_URL;
  }
  if (typeof window !== 'undefined' && window.__GAS_API_URL__) {
    return window.__GAS_API_URL__;
  }
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem('prpo_gas_api_url') || '';
  }
  return '';
};

/**
 * Environment detection: Checks if running inside Google Apps Script Web App or connected to GAS Web API
 */
export const isGAS = () => {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_USE_GAS === 'true') {
    return true;
  }
  if (Boolean(getGasApiUrl())) {
    return true;
  }
  return (
    typeof window !== 'undefined' &&
    typeof window.google !== 'undefined' &&
    typeof window.google.script !== 'undefined' &&
    typeof window.google.script.run !== 'undefined'
  );
};

/**
 * Recursively strips non-serializable Browser objects (File, Blob, ArrayBuffer)
 * from any payload before sending it across the google.script.run RPC boundary.
 * Also removes any plain-object key named "file" or "rawFile" that holds a DOM File.
 *
 * @param {*} data - Any value to sanitize
 * @returns {*} A clean, JSON-serializable version of the data
 */
export const sanitizePayloadForGAS = (data) => {
  if (data === null || data === undefined) return data;
  if (data instanceof Date) return data.toISOString();
  if (typeof File !== 'undefined' && data instanceof File) return undefined;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return undefined;
  if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return undefined;
  if (typeof data !== 'object') return data;

  if (Array.isArray(data)) {
    return data
      .map(sanitizePayloadForGAS)
      .filter(v => v !== undefined);
  }

  const clean = {};
  for (const [key, value] of Object.entries(data)) {
    // Drop browser File/Blob instances stored under any key
    if (typeof File !== 'undefined' && value instanceof File) continue;
    if (typeof Blob !== 'undefined' && value instanceof Blob) continue;
    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) continue;
    // Also drop keys literally named 'file' or 'rawFile' holding plain objects that
    // act as wrappers around a File (e.g. { file: File, name: '...' })
    if ((key === 'file' || key === 'rawFile') && value && typeof value === 'object' &&
        typeof value.size === 'number' && typeof value.name === 'string' &&
        typeof value.type === 'string') {
      continue;
    }
    const sanitizedVal = sanitizePayloadForGAS(value);
    if (sanitizedVal !== undefined) clean[key] = sanitizedVal;
  }
  return clean;
};

/**
 * HTTP POST Client for decoupled Frontend (GitHub Pages -> GAS Web App API).
 * Uses text/plain Content-Type to prevent CORS preflight OPTIONS request.
 * Automatically attaches HMAC session token and API secret key.
 * 
 * @param {string} functionName Name of GAS function in Code.gs
 * @param  {...any} args Arguments to pass to GAS function
 * @returns {Promise<any>}
 */
export const callGASHttp = async (functionName, ...args) => {
  const gasUrl = getGasApiUrl();
  if (!gasUrl) {
    throw new Error(`GAS_URL_NOT_CONFIGURED: VITE_GAS_API_URL is not configured.`);
  }

  let currentUser = null;
  let authToken = null;
  try {
    if (typeof localStorage !== 'undefined') {
      const authData = localStorage.getItem('prpo_auth_session') || localStorage.getItem('prpo_current_user');
      if (authData) currentUser = JSON.parse(authData);
      authToken = localStorage.getItem('prpo_auth_token') || (currentUser && currentUser.token) || null;
    }
  } catch (e) {}

  const safeArgs = args.map(sanitizePayloadForGAS);

  const payload = {
    action: functionName,
    args: safeArgs,
    currentUser: currentUser,
    token: authToken,
    apiKey: (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_SECRET_KEY) || undefined
  };

  try {
    const response = await fetch(gasUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP_STATUS_${response.status}: Failed to reach Google Apps Script API`);
    }

    const resJson = await response.json();
    if (resJson && typeof resJson === 'object' && 'success' in resJson) {
      if (resJson.success) {
        if (functionName === 'apiLogin' && resJson.data && resJson.data.token) {
          try {
            localStorage.setItem('prpo_auth_token', resJson.data.token);
          } catch (e) {}
        }
        return resJson.data;
      } else {
        const errMsg = resJson.error || resJson.message || 'GAS Request Failed';
        console.error(`[GAS HTTP Server Error] ${functionName}:`, errMsg);
        modalService.error('ข้อผิดพลาดจากระบบหลังบ้าน', errMsg);
        const err = new Error(errMsg);
        err.code = resJson.error || 'GAS_ERROR';
        throw err;
      }
    }
    return resJson;
  } catch (netErr) {
    const errMsg = netErr instanceof Error ? netErr.message : String(netErr);
    console.error(`[GAS HTTP Request Error] ${functionName}:`, netErr);
    modalService.error('ข้อผิดพลาดการเชื่อมต่อระบบ', errMsg);
    throw netErr instanceof Error ? netErr : new Error(errMsg);
  }
};

/**
 * Universal Promise wrapper for GAS calls.
 * Automatically delegates to native google.script.run when running inside Apps Script iframe,
 * or routes through callGASHttp when running externally on GitHub Pages.
 * 
 * @param {string} functionName Name of GAS function in Code.gs
 * @param  {...any} args Arguments to pass to GAS function
 * @returns {Promise<any>}
 */
export const callGAS = (functionName, ...args) => {
  // Path 1: Running inside Google Apps Script iframe with google.script.run
  if (typeof window !== 'undefined' && typeof window.google?.script?.run?.[functionName] === 'function') {
    return new Promise((resolve, reject) => {
      let currentUser = null;
      try {
        if (typeof localStorage !== 'undefined') {
          const authData = localStorage.getItem('prpo_auth_session') || localStorage.getItem('prpo_current_user');
          if (authData) currentUser = JSON.parse(authData);
        }
      } catch (e) {}

      const enrichedArgs = args.map(arg => {
        if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
          if (!arg.currentUser && !arg.user && currentUser) {
            return { ...arg, currentUser };
          }
        }
        return arg;
      });

      let finalArgs = enrichedArgs;
      if (currentUser) {
        if (finalArgs.length === 0) {
          finalArgs = [{}, currentUser];
        } else if (finalArgs.length === 1) {
          finalArgs = [finalArgs[0], currentUser];
        } else if (finalArgs.length === 2 && typeof finalArgs[0] === 'string') {
          finalArgs = [finalArgs[0], finalArgs[1], currentUser];
        }
      }

      const safeArgs = finalArgs.map(sanitizePayloadForGAS);

      window.google.script.run
        .withSuccessHandler((response) => {
          if (response && typeof response === 'object' && 'success' in response) {
            if (response.success) {
              resolve(response.data);
            } else {
              const errMsg = response.error || response.message || 'GAS Request Failed';
              console.error(`[GAS Server Error] ${functionName}:`, errMsg);
              modalService.error('ข้อผิดพลาดจากระบบหลังบ้าน', errMsg);
              const err = new Error(errMsg);
              err.code = response.error || 'GAS_ERROR';
              reject(err);
            }
          } else {
            resolve(response);
          }
        })
        .withFailureHandler((error) => {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`[GAS RPC Error] ${functionName}:`, error);
          modalService.error('ข้อผิดพลาดการเชื่อมต่อระบบ', errMsg);
          reject(error instanceof Error ? error : new Error(String(error)));
        })
        [functionName](...safeArgs);
    });
  }

  // Path 2: Decoupled Web API via HTTP POST (GitHub Pages / External Web App)
  if (getGasApiUrl()) {
    return callGASHttp(functionName, ...args);
  }

  return Promise.reject(new Error(`GAS_UNAVAILABLE: google.script.run is not available and VITE_GAS_API_URL is not configured for calling "${functionName}".`));
};

// ── Permanent Blacklist Guard against Test / Mock Artifacts ──
export const DUMMY_BLACKLIST = new Set(['P01', 'P02', 'PROD-01', 'PROD-02']);
export const isBlacklistedProduct = (item) => {
  if (!item || typeof item !== 'object') return false;
  const actual = item.product || item.item || item;
  const code = String(actual.code || actual.id || '').trim().toUpperCase();
  const id = String(actual.id || '').trim().toUpperCase();
  const name = String(actual.name || actual.itemName || actual.title || '').trim().toLowerCase();
  return DUMMY_BLACKLIST.has(code) || DUMMY_BLACKLIST.has(id) || name === 'item 1' || name === 'item 2';
};

/**
 * B. Runtime Migration & Self-Healing for Existing Records
 * Normalizes legacy document numbers (bare PO numbers e.g. PO-PD-2026-001)
 * into canonical GRN format: GRN-${poNumber}-${String(round).padStart(2, '0')}
 */
export const normalizeDocNumber = (record) => {
  if (!record) return '';
  if (typeof record === 'string') {
    const trimmed = record.trim();
    if (/^PO-[A-Z0-9]+-\d{4}-\d{3,}$/i.test(trimmed)) {
      return `GRN-${trimmed}-01`;
    }
    return trimmed;
  }
  let docNo = record.grnNumber || record.grnNo || record.grNumber || record.documentNo || record.docNo || '';
  docNo = String(docNo).trim();
  // If the document number is a bare PO number (e.g. PO-PD-2026-001) without GRN prefix:
  if (/^PO-[A-Z0-9]+-\d{4}-\d{3,}$/i.test(docNo)) {
    const round = record.roundNumber || record.round || 1;
    return `GRN-${docNo}-${String(round).padStart(2, '0')}`;
  }
  return docNo;
};

/**
 * Resilient Temporal Date Normalizer
 * Parses any date format (ISO YYYY-MM-DD, Thai/Standard DD/MM/YYYY, timestamps)
 * and extracts canonical year, month, and ymKey (e.g. "2026-09").
 */
export const parseOrderYearMonth = (dateInput) => {
  if (!dateInput) return { year: null, month: null, ymKey: null };
  const str = String(dateInput).trim();
  if (!str) return { year: null, month: null, ymKey: null };
  
  // Case 1: DD/MM/YYYY or DD/MM/YYYY HH:mm:ss or DD/MM/YY
  const dmyMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (dmyMatch) {
    let year = parseInt(dmyMatch[3], 10);
    if (year === 69 || year === 26) year = 2026;
    else if (year < 100) year = 2000 + year;
    else if (year > 2400) year -= 543; // Convert Thai Buddhist Era (e.g. 2569 -> 2026)
    const month = String(parseInt(dmyMatch[2], 10)).padStart(2, '0');
    return { year, month, ymKey: `${year}-${month}` };
  }

  // Case 2: ISO YYYY-MM-DD or YYYY-MM or ISO timestamp
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})/);
  if (isoMatch) {
    let year = parseInt(isoMatch[1], 10);
    if (year > 2400) year -= 543;
    const month = String(parseInt(isoMatch[2], 10)).padStart(2, '0');
    return { year, month, ymKey: `${year}-${month}` };
  }

  // Fallback: Date object parse
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    let year = parsed.getFullYear();
    if (year > 2400) year -= 543;
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    return { year, month, ymKey: `${year}-${month}` };
  }

  return { year: null, month: null, ymKey: null };
};

// In-Memory Storage Cache backed by Local File API Server
let _cache = {};
let _apiReady = false;

/**
 * Post-migration Result Cache (Performance Layer)
 * Stores the fully-sanitized, migration-complete output of hot getters.
 * Invalidated via _dirtyKeys whenever _setItem writes to a storage key.
 * This ensures repeated renders skip O(n) migration loops entirely.
 */
const _resultCache = new Map();
const _dirtyKeys = new Set();

const _syncApi = async () => {
  if (isGAS()) return;
  if (!_apiReady) return;
  try {
    await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_cache)
    });
  } catch (e) {
    console.warn('[StorageService] Local API Sync warning:', e.message);
  }
};

const _migrateLocalStorageCache = () => {
  if (typeof localStorage === 'undefined') return;
  try {
    // Always purge dummy blacklisted products & stock logs from local storage
    const storedProds = localStorage.getItem(STORAGE_KEYS.PRODUCTS);
    if (storedProds) {
      try {
        const parsedP = JSON.parse(storedProds);
        if (Array.isArray(parsedP)) {
          const cleanP = parsedP
            .flatMap(p => Array.isArray(p) ? p : [p])
            .filter(p => p && typeof p === 'object' && !isBlacklistedProduct(p));
          if (cleanP.length !== parsedP.length) {
            localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(cleanP));
          }
        }
      } catch (e) {}
    }
    const storedLogs = localStorage.getItem(STORAGE_KEYS.STOCK_LOGS);
    if (storedLogs) {
      try {
        const parsedL = JSON.parse(storedLogs);
        if (Array.isArray(parsedL)) {
          const cleanL = parsedL.filter(l => {
            const pId = String(l.productId || '').trim().toUpperCase();
            const pCode = String(l.productCode || '').trim().toUpperCase();
            return !DUMMY_BLACKLIST.has(pId) && !DUMMY_BLACKLIST.has(pCode);
          });
          if (cleanL.length !== parsedL.length) {
            localStorage.setItem(STORAGE_KEYS.STOCK_LOGS, JSON.stringify(cleanL));
          }
        }
      } catch (e) {}
    }

    const currentVersion = localStorage.getItem('prpo_data_version');
    if (currentVersion !== DATA_VERSION) {
      // 1. Reset all Transactional Data to empty arrays []
      localStorage.setItem(STORAGE_KEYS.PRS, JSON.stringify([]));
      localStorage.setItem(STORAGE_KEYS.POS, JSON.stringify([]));
      localStorage.setItem(STORAGE_KEYS.STOCK_LOGS, JSON.stringify([]));
      localStorage.setItem(STORAGE_KEYS.BUDGET_TRANSACTIONS, JSON.stringify([]));
      localStorage.setItem(STORAGE_KEYS.AUDIT_LOGS, JSON.stringify([]));
      localStorage.setItem('prpo_in_app_notifications', JSON.stringify([]));
      localStorage.setItem('prpo_notifications', JSON.stringify([]));

      // 2. Reset counters to 0
      try {
        localStorage.removeItem(STORAGE_KEYS.PR_COUNTERS);
        localStorage.removeItem('pr_counter');
        localStorage.removeItem('currentRunningIndex');
      } catch (e) {}

      // 3. Reset budget spent and pending to 0 while strictly preserving master monthlyBudget configurations
      const storedBudgets = localStorage.getItem(STORAGE_KEYS.BUDGETS);
      if (storedBudgets) {
        try {
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
        } catch (e) {}
      }

      // Master Data (Vendors, Products, Users, Locations, Usage Units, Signatures, Departments) is 100% PRESERVED!

      localStorage.setItem('app_data_cleared', 'true');
      localStorage.setItem('prpo_data_version', DATA_VERSION);
    }
  } catch (e) {
    console.warn('[StorageService] LocalStorage migration error:', e.message);
  }
};

// Immediately run migration if in browser environment
_migrateLocalStorageCache();



const _getItem = (key) => {
  if (_apiReady && _cache[key] !== undefined) {
    return _cache[key];
  }
  // Reading raw from sessionStorage / localStorage means the result cache is stale for this key
  _dirtyKeys.add(key);
  let local = null;
  if (typeof sessionStorage !== 'undefined') {
    local = sessionStorage.getItem(key);
  }
  if (!local && typeof localStorage !== 'undefined') {
    local = localStorage.getItem(key);
  }
  return local ? JSON.parse(local) : null;
};

const _setItem = (key, value, syncWithBackend = false) => {
  _cache[key] = value;
  // Invalidate the post-migration result cache for this key
  _resultCache.delete(key);
  _dirtyKeys.add(key);
  const serialized = JSON.stringify(value);
  if (typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.setItem(key, serialized);
    } catch (e) {
      // ignore quota error
    }
  }
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(key, serialized);
    } catch (e) {
      // ignore quota error
    }
  }
  if (syncWithBackend) {
    _syncApi();
  }
};

const isDataCleared = () => typeof localStorage !== 'undefined' && localStorage.getItem('app_data_cleared') === 'true';

export const storageService = {
  // Fast hydration from sessionStorage / localStorage (instant 0ms client startup)
  hydrateFromClientStorage() {
    if (typeof sessionStorage === 'undefined' && typeof localStorage === 'undefined') return;
    const keys = [
      STORAGE_KEYS.PRODUCTS,
      STORAGE_KEYS.VENDORS,
      STORAGE_KEYS.STORAGE_LOCATIONS,
      STORAGE_KEYS.USAGE_UNITS,
      STORAGE_KEYS.DEPARTMENTS,
      STORAGE_KEYS.USERS,
      STORAGE_KEYS.BUDGETS,
      STORAGE_KEYS.SIGNATURES,
      STORAGE_KEYS.PRS,
      STORAGE_KEYS.POS,
      STORAGE_KEYS.STOCK_LOGS,
      STORAGE_KEYS.BUDGET_TRANSACTIONS,
      STORAGE_KEYS.AUDIT_LOGS,
      'prpo_notifications',
      'prpo_summary_stats'
    ];
    keys.forEach(k => {
      try {
        let raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(k) : null;
        if (!raw && typeof localStorage !== 'undefined') {
          raw = localStorage.getItem(k);
        }
        if (raw) {
          _cache[k] = JSON.parse(raw);
        }
      } catch (e) {}
    });
    _apiReady = true;
  },

  // Check if running in Google Apps Script mode
  isGASMode() {
    return isGAS();
  },

  // Subscriber pattern for Stale-While-Revalidate and real-time state synchronization
  _listeners: new Set(),
  subscribe(callback) {
    if (typeof callback !== 'function') return () => {};
    this._listeners.add(callback);
    return () => {
      this._listeners.delete(callback);
    };
  },
  _notifySubscribers(event, data) {
    this._listeners.forEach(cb => {
      try {
        cb(event, data);
      } catch (err) {
        console.warn('[StorageService] subscriber callback error:', err);
      }
    });
  },

  // Apply consolidated batch payload from apiGetInitialPayload
  applyInitialPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (Array.isArray(payload.products)) this.saveProducts(payload.products);
    if (Array.isArray(payload.vendors)) this.saveVendors(payload.vendors);
    if (Array.isArray(payload.storageLocations)) this.saveStorageLocations(payload.storageLocations);
    if (Array.isArray(payload.usageUnits)) this.saveUsageUnits(payload.usageUnits);
    if (Array.isArray(payload.departments)) this.saveDepartments(payload.departments);
    if (Array.isArray(payload.users)) this.saveUsers(payload.users);
    if (Array.isArray(payload.prs)) this.savePRs(payload.prs);
    if (Array.isArray(payload.pos)) this.savePOs(payload.pos);
    if (Array.isArray(payload.stockLogs)) this.saveStockLogs(payload.stockLogs);
    if (payload.budgets && typeof payload.budgets === 'object') {
      const isArr = Array.isArray(payload.budgets);
      const hasContent = isArr ? payload.budgets.length > 0 : Object.keys(payload.budgets).length > 0;
      if (hasContent) this.saveBudgets(payload.budgets);
    }
    if (Array.isArray(payload.budgetTransactions) && payload.budgetTransactions.length > 0) {
      this.saveBudgetTransactions(payload.budgetTransactions);
    }
    if (Array.isArray(payload.auditLogs)) this.saveAuditLogs(payload.auditLogs);
    if (Array.isArray(payload.notifications)) this.saveNotifications(payload.notifications);
    if (Array.isArray(payload.signatures) && typeof this.saveSignatures === 'function') {
      this.saveSignatures(payload.signatures);
    }
    return true;
  },

  // Synchronize entire dataset from Google Sheets backend into local memory cache via Batch RPC
  async syncAllFromGAS() {
    if (!isGAS()) return false;
    try {
      console.info('[StorageService] Syncing all collections via Batch RPC (apiGetInitialPayload)...');
      const payload = await callGAS('apiGetInitialPayload');
      if (payload && typeof payload === 'object') {
        this.applyInitialPayload(payload);
        this._notifySubscribers('revalidate', payload);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('prpo_data_revalidated', { detail: payload }));
        }
        console.info('[StorageService] Google Sheets batch sync complete.');
        return payload;
      }
      return false;
    } catch (err) {
      console.warn('[StorageService] syncAllFromGAS batch error:', err.message);
      return false;
    }
  },

  // Initialize storage from Google Sheets backend or Local Node.js Backend with fallback to LocalStorage
  // Supports Stale-While-Revalidate: Instant render with cached state + background sync
  async init() {
    this.hydrateFromClientStorage();
    _migrateLocalStorageCache();

    if (isGAS()) {
      const hasCachedData = Boolean(
        (_cache[STORAGE_KEYS.PRODUCTS]?.length > 0) ||
        (_cache[STORAGE_KEYS.USERS]?.length > 0)
      );

      // Start background sync from Google Sheets via consolidated batch RPC
      const syncPromise = this.syncAllFromGAS().then(payload => {
        _apiReady = true;
        return payload;
      });

      if (hasCachedData) {
        // Stale-While-Revalidate: Return immediately to allow sub-second instant UI render
        _apiReady = true;
        return;
      }

      // Cold start: await single batch payload before rendering
      await syncPromise;
      _apiReady = true;
      return;
    }

    // Local Node.js Backend API
    try {
      const res = await fetch(API_URL);
      if (res.ok) {
        const data = await res.json();
        _cache = data || {};
        _apiReady = true;
        return;
      }
    } catch (e) {
      console.warn('[StorageService] Local API not reachable. Using in-memory / ClientStorage fallback.');
    }
  },

  // ── Lazy-Fetching for Heavy Transactional Records ──
  async fetchPRs(force = false) {
    return this.getPRs();
  },

  async fetchPOs(force = false) {
    return this.getPOs();
  },

  async fetchStockLogs(force = false) {
    return this.getStockLogs();
  },

  async fetchBudgetTransactions(force = false) {
    return this.getBudgetTransactions();
  },

  async fetchAuditLogs(force = false) {
    return this.getAuditLogs();
  },

  // Flush all in-memory and browser storage caches
  invalidateAllClientCache() {
    _cache = {};
    _resultCache.clear();
    _dirtyKeys.clear();
    _apiReady = false;
    const ALL_KEYS = Object.values(STORAGE_KEYS).concat([
      'prpo_notifications', 'prpo_in_app_notifications',
      'prpo_audit_logs', 'prpo_budget_transactions', 'prpo_summary_stats',
      'prpo_registered_users', 'prpo_users_cache'
    ]);
    ALL_KEYS.forEach(k => {
      try { if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(k); } catch(e){}
      try { if (typeof localStorage !== 'undefined') localStorage.removeItem(k); } catch(e){}
    });
  },

  // Reset local browser cache only (Strictly NEVER overwrites server SSOT files)
  resetData() {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('prpo_data_version', DATA_VERSION);
    }
    _setItem(STORAGE_KEYS.CURRENT_ROLE, ROLES.REQUESTER_PD, false);
    _setItem(STORAGE_KEYS.PRODUCTS, [], false);
    _setItem(STORAGE_KEYS.VENDORS, [], false);
    _setItem(STORAGE_KEYS.STORAGE_LOCATIONS, [], false);
    _setItem(STORAGE_KEYS.USAGE_UNITS, INITIAL_USAGE_UNITS, false);
    _setItem(STORAGE_KEYS.DEPARTMENTS, INITIAL_DEPARTMENTS, false);
    _setItem(STORAGE_KEYS.USERS, [], false);
    _setItem(STORAGE_KEYS.BUDGETS, {}, false);
    _setItem(STORAGE_KEYS.PR_COUNTERS, { PD: { PR: 0, PO: 0 }, QC: { PR: 0, PO: 0 } }, false);
    _setItem(STORAGE_KEYS.SIGNATURES, {}, false);
    _setItem(STORAGE_KEYS.PRS, [], false);
    _setItem(STORAGE_KEYS.POS, [], false);
    _setItem(STORAGE_KEYS.STOCK_LOGS, [], false);
    _setItem(STORAGE_KEYS.BUDGET_TRANSACTIONS, [], false);
    _setItem(STORAGE_KEYS.AUDIT_LOGS, [], false);
    _setItem('prpo_notifications', [], false);
    _setItem('prpo_in_app_notifications', [], false);
    _setItem('prpo_summary_stats', null, false);
  },

  clearTransactions() {
    _setItem(STORAGE_KEYS.PRS, []);
    _setItem(STORAGE_KEYS.POS, []);
    _setItem(STORAGE_KEYS.STOCK_LOGS, []);
    _setItem(STORAGE_KEYS.BUDGET_TRANSACTIONS, []);
    _setItem(STORAGE_KEYS.AUDIT_LOGS, []);
    _setItem('prpo_notifications', []);
    _setItem('prpo_in_app_notifications', []);
    _setItem('app_prs', []);
    _setItem('app_pos', []);
    _setItem('app_stock_logs', []);
  },

  // Role
  getCurrentRole() {
    const data = _getItem(STORAGE_KEYS.CURRENT_ROLE);
    return data || ROLES.REQUESTER_PD;
  },
  setCurrentRole(role) {
    _setItem(STORAGE_KEYS.CURRENT_ROLE, role);
  },

  // Products (with Lazy Migration & Cache Sanitization)
  // Performance: returns cached post-migration result if the key has not been written since last call.
  getProducts() {
    const _cacheKey = STORAGE_KEYS.PRODUCTS;
    if (!_dirtyKeys.has(_cacheKey) && _resultCache.has(_cacheKey)) {
      return _resultCache.get(_cacheKey);
    }
    let data = _getItem(STORAGE_KEYS.PRODUCTS);

    // Directive 3: Flatten nested arrays and sanitize cache
    if (Array.isArray(data)) {
      data = data
        .flatMap(p => Array.isArray(p) ? p : [p])
        .filter(p => p && typeof p === 'object' && !isBlacklistedProduct(p));
      const validNamed = data.filter(p => {
        const actual = p.product || p.item || p;
        const name = actual.name || actual.itemName || actual.nameTh || actual.title;
        return Boolean(name && name !== 'สินค้าไม่มีชื่อ');
      });
      data = validNamed.length > 0 ? validNamed : null;
    } else {
      data = null;
    }

    // Clean legacy inventory or products keys in localStorage if corrupted
    if (typeof localStorage !== 'undefined') {
      try {
        ['inventory', 'products'].forEach(key => {
          const item = localStorage.getItem(key);
          if (item) {
            try {
              const parsed = JSON.parse(item);
              if (Array.isArray(parsed) && parsed.some(x => Array.isArray(x) || !x?.name || isBlacklistedProduct(x))) {
                localStorage.removeItem(key);
              }
            } catch (err) {}
          }
        });
      } catch (e) {}
    }

    const products = data !== null && data !== undefined ? data : [];

    if (!products || products.length === 0) {
      _resultCache.set(_cacheKey, []);
      _dirtyKeys.delete(_cacheKey);
      return [];
    }
    
    let needsSave = false;
    const migrated = products.map(p => {
      const actual = p.product || p.item || p;
      let item = { ...actual };
      // Normalize identity fields to String
      if (item.id !== undefined && item.id !== null) item.id = String(item.id);
      if (item.code !== undefined && item.code !== null) item.code = String(item.code);
      if (item.sku !== undefined && item.sku !== null) item.sku = String(item.sku);
      if (item.name !== undefined && item.name !== null) item.name = String(item.name);
      if (item.itemCode !== undefined && item.itemCode !== null) item.itemCode = String(item.itemCode);

      const cat = item.category || item.department || 'PD';
      if (!item.category || !item.department || item.category !== cat || item.department !== cat) {
        needsSave = true;
        item.category = cat;
        item.department = cat;
      }
      // Migrate legacy 'คู่' unit to 'ชิ้น'
      if (item.stockUnit === 'คู่' || item.unit === 'คู่' || item.code === 'PD-GLV-NBR') {
        if (item.stockUnit === 'คู่' || item.unit === 'คู่') {
          needsSave = true;
          item.stockUnit = 'ชิ้น';
          item.unit = 'ชิ้น';
          if (item.purchaseUnit === 'กล่อง (100 ชิ้น)' && (item.conversionRate === 50 || item.conversionRate === 1)) {
            item.conversionRate = 100;
          }
        }
      }
      // Ensure Dual-UOM attributes: purchaseUom, baseUom, conversionRatio
      const pUom = item.purchaseUom || item.purchaseUnit || item.unit || 'ชิ้น';
      const bUom = item.baseUom || item.stockUnit || item.unit || 'ชิ้น';
      const convRatio = Number(item.conversionRatio ?? item.conversionRate ?? 1) > 0 ? Number(item.conversionRatio ?? item.conversionRate ?? 1) : 1;

      if (!item.purchaseUom || !item.baseUom || item.conversionRatio === undefined || item.purchaseUom !== pUom || item.baseUom !== bUom || item.conversionRatio !== convRatio) {
        needsSave = true;
        item = {
          ...item,
          purchaseUom: pUom,
          baseUom: bUom,
          conversionRatio: convRatio,
          purchaseUnit: pUom,
          stockUnit: bUom,
          conversionRate: convRatio,
          unit: bUom
        };
      }

      // Explicit Dual-UOM matrix presets for primary items
      if (item.code === 'PD-OIL-068') {
        if (item.conversionRatio !== 200 || item.baseUom !== 'ลิตร' || item.purchaseUom !== 'ถัง (200L)') {
          needsSave = true;
          item.conversionRatio = 200;
          item.conversionRate = 200;
          item.baseUom = 'ลิตร';
          item.stockUnit = 'ลิตร';
          item.purchaseUom = 'ถัง (200L)';
          item.purchaseUnit = 'ถัง (200L)';
        }
      } else if (item.code === 'PD-BOX-002') {
        if (item.conversionRatio !== 1 || item.baseUom !== 'ใบ' || item.purchaseUom !== 'ใบ') {
          needsSave = true;
          item.conversionRatio = 1;
          item.conversionRate = 1;
          item.baseUom = 'ใบ';
          item.stockUnit = 'ใบ';
          item.purchaseUom = 'ใบ';
          item.purchaseUnit = 'ใบ';
        }
      }

      return item;
    });

    // Strip duplicate codes per department, keeping the most complete record
    const deduped = [];
    const seenCodes = new Set();
    migrated.forEach(p => {
      const dept = String(p.department || p.category || p.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
      const codeKey = p.id ? String(p.id).toUpperCase() : `${dept}_${String(p.code || '').trim().toUpperCase()}`;
      if (!seenCodes.has(codeKey)) {
        seenCodes.add(codeKey);
        deduped.push(p);
      }
    });

    if (needsSave || deduped.length !== products.length) {
      this.saveProducts(deduped);
    }
    // Cache the fully-sanitized result and mark key as clean
    _resultCache.set(_cacheKey, deduped);
    _dirtyKeys.delete(_cacheKey);
    return deduped;
  },
  saveProducts(products) {
    const sanitized = (Array.isArray(products) ? products : [])
      .flatMap(p => Array.isArray(p) ? p : [p])
      .filter(p => p && typeof p === 'object' && (p.name || p.itemName || p.title) && !isBlacklistedProduct(p));
    const map = new Map();
    sanitized.forEach(item => {
      const actual = item.product || item.item || item;
      const dept = String(actual.department || actual.category || actual.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
      const code = String(actual.code || actual.sku || '').trim().toUpperCase();
      const id = String(actual.id || '').trim().toUpperCase();
      const uniqueKey = id ? id : (code ? `${dept}_${code}` : Math.random());
      if (uniqueKey && !map.has(uniqueKey)) {
        const pUom = actual.purchaseUom || actual.purchaseUnit || actual.unit || 'ชิ้น';
        const bUom = actual.baseUom || actual.stockUnit || actual.unit || 'ชิ้น';
        const convRatio = Number(actual.conversionRatio ?? actual.conversionRate ?? 1) > 0 ? Number(actual.conversionRatio ?? actual.conversionRate ?? 1) : 1;
        map.set(uniqueKey, {
          ...actual,
          id: actual.id !== undefined && actual.id !== null ? String(actual.id) : '',
          code: actual.code !== undefined && actual.code !== null ? String(actual.code) : '',
          sku: actual.sku !== undefined && actual.sku !== null ? String(actual.sku) : '',
          name: actual.name !== undefined && actual.name !== null ? String(actual.name) : (actual.itemName ? String(actual.itemName) : ''),
          itemCode: actual.itemCode !== undefined && actual.itemCode !== null ? String(actual.itemCode) : '',
          purchaseUom: pUom,
          baseUom: bUom,
          conversionRatio: convRatio,
          purchaseUnit: pUom,
          stockUnit: bUom,
          conversionRate: convRatio,
          unit: bUom
        });
      }
    });
    _setItem(STORAGE_KEYS.PRODUCTS, Array.from(map.values()), true);
  },
  saveProduct(prodObj, mode = null) {
    if (!prodObj || typeof prodObj !== 'object') return null;
    const products = this.getProducts();
    const isEdit = mode === 'EDIT' || prodObj._mode === 'EDIT' || (Boolean(prodObj.isEdit) && Boolean(prodObj.id));
    const targetId = String(prodObj.id || '').trim().toLowerCase();
    const targetCode = String(prodObj.code || prodObj.sku || '').trim().toLowerCase();
    const prodDept = String(prodObj.department || prodObj.category || prodObj.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();

    // In CREATE mode, check if code already exists in the same department
    if (!isEdit && targetCode) {
      const duplicate = products.find(p => {
        const isSameDept = matchDepartment(p.department || p.category || p.dept, prodDept);
        return isSameDept && String(p.code || p.sku || '').trim().toLowerCase() === targetCode;
      });
      if (duplicate) {
        throw new Error(`รหัสสินค้านี้มีอยู่ในระบบแล้ว กรุณาใช้รหัสอื่น (${targetCode})`);
      }
    }

    const idx = products.findIndex(p => {
      const pId = String(p.id || '').trim().toLowerCase();
      const pCode = String(p.code || p.sku || '').trim().toLowerCase();
      const isSameDept = matchDepartment(p.department || p.category || p.dept, prodDept);
      if (isEdit) {
        return (targetId && pId === targetId) || (isSameDept && targetCode && pCode === targetCode);
      }
      return targetId && pId === targetId;
    });

    let updated;
    if (idx !== -1 && isEdit) {
      updated = [...products];
      updated[idx] = { ...updated[idx], ...prodObj };
    } else {
      updated = [prodObj, ...products];
    }
    this.saveProducts(updated);

    if (isGAS()) {
      callGAS('apiSaveMasterItem', 'Products', prodObj).catch(e => console.warn('[StorageService] GAS apiSaveMasterItem background error:', e.message));
    }

    return prodObj;
  },
  deleteProduct(productId, department = null) {
    const targetStr = String(productId || '').trim().toLowerCase();
    const targetDept = department ? String(department).replace(/^DEPT-/, '').trim().toUpperCase() : null;
    const current = this.getProducts();
    const filtered = current.filter(p => {
      if (isBlacklistedProduct(p)) return false;
      const pId = String(p.id || '').trim().toLowerCase();
      if (pId && pId === targetStr) return false;
      const pCode = String(p.code || '').trim().toLowerCase();
      const pDept = String(p.department || p.category || p.dept || '').replace(/^DEPT-/, '').trim().toUpperCase();
      if (pCode && pCode === targetStr) {
        if (!targetDept || !pDept || pDept === targetDept) return false;
      }
      return true;
    });
    this.saveProducts(filtered);

    if (isGAS()) {
      callGAS('apiDeleteMasterItem', 'Products', productId).catch(e => console.warn('[StorageService] GAS apiDeleteMasterItem background error:', e.message));
    }

    // Also clean up any stock logs tied to this product
    const stockLogs = this.getStockLogs();
    const cleanLogs = stockLogs.filter(l => {
      const pId = String(l.productId || '').trim().toLowerCase();
      const pCode = String(l.productCode || '').trim().toLowerCase();
      return pId !== targetStr && pCode !== targetStr;
    });
    if (cleanLogs.length !== stockLogs.length) {
      this.saveStockLogs(cleanLogs);
    }
    return true;
  },

  // Storage Locations (Simple Name & Department)
  getStorageLocations() {
    const data = _getItem(STORAGE_KEYS.STORAGE_LOCATIONS);
    return Array.isArray(data) ? data : [];
  },
  saveStorageLocations(locations) {
    _setItem(STORAGE_KEYS.STORAGE_LOCATIONS, locations, true);
  },

  // Usage Units (Department-Scoped Rooms / Units)
  getUsageUnits(department) {
    const data = _getItem(STORAGE_KEYS.USAGE_UNITS);
    let list;
    if (!data) {
      if (isGAS()) {
        list = [];
      } else {
        this.saveUsageUnits(INITIAL_USAGE_UNITS);
        list = INITIAL_USAGE_UNITS;
      }
    } else {
      list = data;
    }
    if (department && department !== 'ALL') {
      return list.filter(u => u.department === department);
    }
    return list;
  },
  saveUsageUnits(units) {
    _setItem(STORAGE_KEYS.USAGE_UNITS, units, true);
  },
  saveUsageUnit(unitObj) {
    const units = [...this.getUsageUnits()];
    let updatedUnit = { ...unitObj };
    const isUpdate = Boolean(updatedUnit.id);
    if (!isUpdate) {
      const dept = updatedUnit.department || 'PD';
      updatedUnit.id = `UNIT-${dept}-${Date.now().toString().slice(-6)}`;
      updatedUnit.status = updatedUnit.status || 'ACTIVE';
      units.push(updatedUnit);
    } else {
      const idx = units.findIndex(u => u.id === updatedUnit.id);
      if (idx !== -1) {
        units[idx] = { ...units[idx], ...updatedUnit };
      } else {
        units.push(updatedUnit);
      }
    }
    this.saveUsageUnits(units);

    if (isGAS()) {
      callGAS('apiSaveMasterItem', 'UsageUnits', updatedUnit).catch(e => console.warn('[StorageService] GAS apiSaveMasterItem error:', e.message));
    }

    return updatedUnit;
  },
  deleteUsageUnit(unitId) {
    const units = this.getUsageUnits();
    const filtered = units.filter(u => u.id !== unitId);
    this.saveUsageUnits(filtered);

    if (isGAS()) {
      callGAS('apiDeleteMasterItem', 'UsageUnits', unitId).catch(e => console.warn('[StorageService] GAS apiDeleteMasterItem error:', e.message));
    }

    return true;
  },

  // Departments Master Data
  getDepartments() {
    const data = _getItem(STORAGE_KEYS.DEPARTMENTS);
    if (!data || !Array.isArray(data) || data.length === 0) {
      if (isGAS()) {
        return [];
      }
      this.saveDepartments(INITIAL_DEPARTMENTS);
      return INITIAL_DEPARTMENTS;
    }
    return data.filter(d => {
      const code = String(d?.code || '').trim().toUpperCase();
      const id = String(d?.id || '').trim().toUpperCase();
      const name = String(d?.name || '');
      return code !== 'ALL' && id !== 'DEPT-ALL' && !name.includes('ส่วนกลาง') && !name.includes('ทุกฝ่าย');
    });
  },
  saveDepartments(departments) {
    _setItem(STORAGE_KEYS.DEPARTMENTS, departments, true);
  },
  saveDepartment(deptObj) {
    const depts = [...this.getDepartments()];
    let updatedDept = { ...deptObj };
    const code = (updatedDept.code || '').toUpperCase().trim();
    if (!updatedDept.id) {
      updatedDept.id = `DEPT-${code || Date.now().toString().slice(-4)}`;
      updatedDept.code = code;
      updatedDept.isActive = updatedDept.isActive !== undefined ? updatedDept.isActive : true;
      updatedDept.createdAt = new Date().toISOString();
      updatedDept.updatedAt = new Date().toISOString();
      depts.push(updatedDept);
    } else {
      const idx = depts.findIndex(d => d.id === updatedDept.id || d.code === updatedDept.code);
      updatedDept.code = code;
      updatedDept.updatedAt = new Date().toISOString();
      if (idx !== -1) {
        depts[idx] = { ...depts[idx], ...updatedDept };
      } else {
        depts.push(updatedDept);
      }
    }
    this.saveDepartments(depts);

    if (isGAS()) {
      callGAS('apiUpsertDepartment', updatedDept).catch(e => console.warn('[StorageService] GAS apiUpsertDepartment error:', e.message));
    }

    return updatedDept;
  },
  deleteDepartment(deptId) {
    const depts = this.getDepartments();
    const filtered = depts.filter(d => d.id !== deptId && d.code !== deptId);
    this.saveDepartments(filtered);
    return true;
  },

  // Users & Access Management
  getUsers() {
    const data = _getItem(STORAGE_KEYS.USERS);
    return Array.isArray(data) ? data : [];
  },
  saveUsers(users) {
    _setItem(STORAGE_KEYS.USERS, users);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('prpo_registered_users', JSON.stringify(users));
    }
  },
  saveUser(userObj) {
    const users = [...this.getUsers()];
    let updatedUser = { ...userObj };
    const isUpdate = Boolean(updatedUser.id);
    const primaryDept = updatedUser.primaryDepartment || updatedUser.department || 'PD';
    const allowedDepts = Array.isArray(updatedUser.allowedDepartments) && updatedUser.allowedDepartments.length > 0
      ? updatedUser.allowedDepartments
      : (primaryDept === 'ALL' ? ['*'] : [primaryDept]);

    updatedUser = {
      ...updatedUser,
      primaryDepartment: primaryDept,
      department: primaryDept,
      allowedDepartments: allowedDepts
    };

    if (!isUpdate) {
      updatedUser.id = `USR-${Date.now().toString().slice(-4)}`;
      updatedUser.status = updatedUser.status || 'ACTIVE';
      users.push(updatedUser);
    } else {
      const idx = users.findIndex(u => u.id === updatedUser.id);
      if (idx !== -1) {
        users[idx] = { ...users[idx], ...updatedUser };
      } else {
        users.push(updatedUser);
      }
    }
    this.saveUsers(users);

    if (isGAS()) {
      callGAS('apiUpsertUser', updatedUser).catch(e => console.warn('[StorageService] GAS apiUpsertUser error:', e.message));
    }

    return updatedUser;
  },
  deleteUser(userId) {
    const users = this.getUsers();
    const filtered = users.filter(u => u.id !== userId);
    this.saveUsers(filtered);

    if (isGAS()) {
      callGAS('apiDeleteUser', userId).catch(e => console.warn('[StorageService] GAS apiDeleteUser error:', e.message));
    }

    return true;
  },
  saveStorageLocation(locationObj) {
    const locations = this.getStorageLocations();
    let updatedLoc = { ...locationObj };
    const isUpdate = Boolean(updatedLoc.id);

    if (!isUpdate) {
      const dept = updatedLoc.department || 'ALL';
      updatedLoc.id = `LOC-${dept}-${Date.now().toString().slice(-6)}`;
      locations.unshift(updatedLoc);
    } else {
      const idx = locations.findIndex(l => l.id === updatedLoc.id);
      if (idx !== -1) {
        locations[idx] = { ...locations[idx], ...updatedLoc };
      } else {
        locations.unshift(updatedLoc);
      }
    }
    this.saveStorageLocations(locations);

    if (isGAS()) {
      callGAS('apiSaveMasterItem', 'StorageLocations', updatedLoc).catch(e => console.warn('[StorageService] GAS apiSaveMasterItem error:', e.message));
    }

    // Cascading Sync on Update: sync all products referencing this locationId
    if (isUpdate) {
      const products = this.getProducts();
      let productsNeedUpdate = false;
      const updatedProducts = products.map(p => {
        if (p.locationId === updatedLoc.id) {
          productsNeedUpdate = true;
          return {
            ...p,
            locationName: updatedLoc.name
          };
        }
        return p;
      });
      if (productsNeedUpdate) {
        this.saveProducts(updatedProducts);
      }
    }

    return updatedLoc;
  },
  deleteStorageLocation(locationId, { reassignToLocationId = null, unlinkProducts = false } = {}) {
    const products = this.getProducts();
    const locations = this.getStorageLocations();
    const assignedProducts = products.filter(p => p.locationId === locationId);

    if (assignedProducts.length > 0 && !unlinkProducts && !reassignToLocationId) {
      throw new Error(`ไม่สามารถลบจุดเก็บนี้ได้ เนื่องจากมีสินค้าผูกอยู่ ${assignedProducts.length} รายการ กรุณาย้ายหรือเปลี่ยนจุดเก็บของสินค้าออกก่อน`);
    }

    if (assignedProducts.length > 0) {
      let targetLoc = null;
      if (reassignToLocationId) {
        targetLoc = locations.find(l => l.id === reassignToLocationId);
      }

      const updatedProducts = products.map(p => {
        if (p.locationId === locationId) {
          if (reassignToLocationId && targetLoc) {
            return {
              ...p,
              locationId: targetLoc.id,
              locationName: targetLoc.name
            };
          } else if (unlinkProducts) {
            return {
              ...p,
              locationId: null,
              locationName: null
            };
          }
        }
        return p;
      });

      this.saveProducts(updatedProducts);
    }

    const filtered = locations.filter(l => l.id !== locationId);
    this.saveStorageLocations(filtered);

    if (isGAS()) {
      callGAS('apiDeleteMasterItem', 'StorageLocations', locationId).catch(e => console.warn('[StorageService] GAS apiDeleteMasterItem error:', e.message));
    }

    return true;
  },

  getVendors() {
    const data = _getItem(STORAGE_KEYS.VENDORS);
    return Array.isArray(data) ? data : [];
  },
  saveVendors(vendors) {
    _setItem(STORAGE_KEYS.VENDORS, vendors, true);
  },
  saveVendor(vendorObj) {
    if (!vendorObj || typeof vendorObj !== 'object') return null;
    const vendors = this.getVendors();
    const targetId = String(vendorObj.id || '').trim().toLowerCase();
    const targetCode = String(vendorObj.code || vendorObj.vendorCode || '').trim().toLowerCase();
    const targetDept = String(vendorObj.department || 'ALL').trim().toUpperCase();
    const idx = vendors.findIndex(v => {
      const vId = String(v.id || '').trim().toLowerCase();
      const vCode = String(v.code || v.vendorCode || '').trim().toLowerCase();
      const vDept = String(v.department || 'ALL').trim().toUpperCase();
      const isSameScope = (targetDept === 'ALL' || vDept === 'ALL' || matchDepartment(vDept, targetDept));
      return (targetId && vId === targetId) || (isSameScope && targetCode && vCode === targetCode);
    });
    let updated;
    if (idx !== -1) {
      updated = [...vendors];
      updated[idx] = { ...updated[idx], ...vendorObj };
    } else {
      updated = [vendorObj, ...vendors];
    }
    this.saveVendors(updated);

    if (isGAS()) {
      callGAS('apiSaveMasterItem', 'Vendors', vendorObj).catch(e => console.warn('[StorageService] GAS apiSaveMasterItem error:', e.message));
    }

    return vendorObj;
  },
  deleteVendor(vendorId) {
    const targetStr = String(vendorId || '').trim().toLowerCase();
    const current = this.getVendors();
    const filtered = current.filter(v => {
      const vId = String(v.id || '').trim().toLowerCase();
      const vCode = String(v.code || '').trim().toLowerCase();
      return vId !== targetStr && vCode !== targetStr;
    });
    this.saveVendors(filtered);

    if (isGAS()) {
      callGAS('apiDeleteMasterItem', 'Vendors', vendorId).catch(e => console.warn('[StorageService] GAS apiDeleteMasterItem error:', e.message));
    }

    return true;
  },

  // PRs (with Lazy Migration)
  // Performance: returns cached post-migration result if the key has not been written since last call.
  getPRs() {
    const _cacheKey = STORAGE_KEYS.PRS;
    if (!_dirtyKeys.has(_cacheKey) && _resultCache.has(_cacheKey)) {
      return _resultCache.get(_cacheKey);
    }
    const data = _getItem(STORAGE_KEYS.PRS);
    const prs = Array.isArray(data) ? data : [];
    const filtered = prs.map(normalizePR);
    
    let needsSave = false;
    const migrated = filtered.map(pr => {
      let itemsMigrated = false;
      const items = (pr.items || []).map(item => {
        if (!item.purchaseUnit || !item.stockUnit || item.purchaseQty === undefined || item.stockQty === undefined) {
          itemsMigrated = true;
          needsSave = true;
          const pQty = Number(item.purchaseQty ?? item.qty) || 1;
          const rate = Number(item.conversionRate) > 0 ? Number(item.conversionRate) : 1;
          const sQty = Number(item.stockQty) || (pQty * rate);
          const pUnit = item.purchaseUnit || item.unit || 'ชิ้น';
          const sUnit = item.stockUnit || item.unit || 'ชิ้น';
          return {
            ...item,
            purchaseQty: pQty,
            stockQty: sQty,
            qty: pQty,
            purchaseUnit: pUnit,
            stockUnit: sUnit,
            unit: pUnit,
            conversionRate: rate
          };
        }
        return item;
      });
      return itemsMigrated ? { ...pr, items } : pr;
    });

    // Auto-heal / cascade sync: if a PR has a PO that is already closed/completed, sync PR status to 'completed'
    const posData = _getItem(STORAGE_KEYS.POS);
    const pos = Array.isArray(posData) ? posData : [];
    const syncedPRs = migrated.map(pr => {
      // Sanitize legacy test fixture PR-1789100542800-9OZ: Strictly detach from PO-PD-2026-001 and preserve WAITING_REVIEW status
      if (pr.id === 'PR-1789100542800-9OZ' || (pr.prNo === 'PD002/2026' && (pr.poNo === 'PO-PD-2026-001' || pr.poNumber === 'PO-PD-2026-001'))) {
        if (pr.poNumber || pr.poNo || pr.poId || pr.status === 'completed' || pr.status === 'CLOSED') {
          needsSave = true;
          const cleaned = { ...pr };
          delete cleaned.poNumber;
          delete cleaned.poNo;
          delete cleaned.poId;
          if (cleaned.status === 'completed' || cleaned.status === 'CLOSED') {
            cleaned.status = 'WAITING_REVIEW';
          }
          return cleaned;
        }
      }

      // Only cascade sync if PR has already been approved/processed (Never sync pending or review-stage PRs)
      const isPRApproved = ['approved', 'ordered', 'completed', 'closed', 'po_issued', 'in_progress_online'].includes(String(pr.status).toLowerCase());
      if (isPRApproved) {
        const relatedPO = pos.find(po =>
          (po.prId && (po.prId === pr.id || po.prId === pr.prNo)) ||
          (po.prNo && (po.prNo === pr.prNo || po.prNo === pr.id)) ||
          (po.prNumber && (po.prNumber === pr.id || po.prNumber === pr.prNo)) ||
          (pr.poNo && (po.poNo === po.poNo || pr.id === po.poNo)) ||
          (po.poNumber && (po.poNo === po.poNumber || po.poNumber === po.poNumber))
        );
        if (relatedPO) {
          const poIsDone = ['closed', 'cancelled', 'received', 'completed', 'fully_received'].includes(String(relatedPO.status).toLowerCase());
          if (poIsDone && !['closed', 'cancelled', 'completed'].includes(String(pr.status).toLowerCase())) {
            needsSave = true;
            return {
              ...pr,
              status: 'completed',
              poNumber: relatedPO.poNo || relatedPO.poNumber || pr.poNumber || pr.poNo,
              poNo: relatedPO.poNo || relatedPO.poNumber || pr.poNumber || pr.poNo,
              fullyReceivedAt: relatedPO.fullyReceivedAt || new Date().toISOString()
            };
          }
        }
      }
      return pr;
    });

    if (needsSave) {
      _setItem(STORAGE_KEYS.PRS, syncedPRs);
    }
    // Cache the fully-migrated result and mark key as clean
    _resultCache.set(_cacheKey, syncedPRs);
    _dirtyKeys.delete(_cacheKey);
    return syncedPRs;
  },
  savePRs(prs) {
    _resultCache.delete(STORAGE_KEYS.PRS);
    _dirtyKeys.add(STORAGE_KEYS.PRS);
    _setItem(STORAGE_KEYS.PRS, prs);
  },
  savePR(pr) {
    if (!pr || typeof pr !== 'object') return null;
    const normalized = normalizePR(pr);
    const prs = this.getPRs();
    const id = normalized.id || normalized.prNo || normalized.prNumber;
    const index = prs.findIndex(p => (id && (p.id === id || p.prNo === id || p.prNumber === id)));
    if (index >= 0) {
      prs[index] = { ...prs[index], ...normalized };
    } else {
      prs.unshift(normalized);
    }
    this.savePRs(prs);
    return prs[index >= 0 ? index : 0];
  },
  upsertPR(pr) {
    return this.savePR(pr);
  },
  updatePRStatus(prId, status, user, note = '') {
    const prs = this.getPRs();
    const index = prs.findIndex(p => p.id === prId || p.prNo === prId || p.prNumber === prId);
    if (index === -1) return null;
    const pr = normalizePR(prs[index]);
    pr.status = status;
    if (!Array.isArray(pr.history)) {
      pr.history = [];
    }
    pr.history.push({
      action: `เปลี่ยนสถานะเป็น ${status}`,
      by: user?.name || user?.username || 'System',
      timestamp: new Date().toISOString(),
      note: note || ''
    });
    prs[index] = pr;
    this.savePRs(prs);
    return pr;
  },

  // POs (with Lazy Migration & Deduplication)
  // Performance: returns cached post-migration result if the key has not been written since last call.
  getPOs() {
    const _cacheKey = STORAGE_KEYS.POS;
    if (!_dirtyKeys.has(_cacheKey) && _resultCache.has(_cacheKey)) {
      return _resultCache.get(_cacheKey);
    }
    const data = _getItem(STORAGE_KEYS.POS);
    const pos = Array.isArray(data) ? data : [];
    const filtered = pos.map(normalizePO).filter(po => po.department === 'PD' || po.department === 'QC');

    // Deduplicate POs by unique identifier
    const seen = new Set();
    const deduplicated = filtered.filter(p => {
      const key = p.poNo || p.poNumber || p.id;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    let needsSave = deduplicated.length !== filtered.length;
    const migrated = deduplicated.map(po => {
      let poUpdated = false;
      let items = po.items || [];

      // If PO has legacy VAT, reset it so it matches PR exactly
      let vat = po.vat;
      let grandTotal = po.grandTotal;
      if (vat > 0) {
        vat = 0;
        grandTotal = po.subtotal || po.totalAmount || grandTotal;
        poUpdated = true;
        needsSave = true;
      }

      items = items.map(item => {
        const needsUnitMigration = !item.purchaseUnit || !item.stockUnit || item.purchaseQty === undefined || item.stockQty === undefined;
        const needsQtyMigration = item.orderedQty === undefined || item.receivedQty === undefined || item.damagedQty === undefined || item.shortageQty === undefined || item.remainingQty === undefined;

        const pQty = Number(item.purchaseQty ?? item.qty) || 1;
        const rate = Number(item.conversionRate) > 0 ? Number(item.conversionRate) : 1;
        const sQty = Number(item.stockQty) || (pQty * rate);
        const pUnit = item.purchaseUnit || item.unit || 'ชิ้น';
        const sUnit = item.stockUnit || item.unit || 'ชิ้น';
        const orderedQty = Number(item.orderedQty ?? pQty);
        const receivedQty = Number(item.receivedQty) || 0;
        const damagedQty = Number(item.damagedQty ?? item.claimedQty ?? item.ngQty) || 0;
        const shortageQty = Number(item.shortageQty ?? Math.max(0, orderedQty - receivedQty));

        if (needsUnitMigration || needsQtyMigration) {
          poUpdated = true;
          needsSave = true;
          return {
            ...item,
            purchaseQty: pQty,
            stockQty: sQty,
            qty: pQty,
            purchaseUnit: pUnit,
            stockUnit: sUnit,
            unit: pUnit,
            conversionRate: rate,
            orderedQty,
            receivedQty,
            damagedQty,
            shortageQty,
            remainingQty: item.remainingQty ?? shortageQty,
            receivedStockQty: item.receivedStockQty ?? (receivedQty * rate)
          };
        }
        return {
          ...item,
          orderedQty,
          receivedQty,
          damagedQty,
          shortageQty,
          remainingQty: item.remainingQty ?? shortageQty
        };
      });

      // Sanitize PO-PD-2026-001: Ensure it points to PD001/2026 (Hydraulic Oil)
      let prNo = po.prNo;
      let prNumber = po.prNumber || po.prNo;
      let prId = po.prId;
      if ((po.poNo === 'PO-PD-2026-001' || po.id === 'PO-1789003809083-1') && (prNo === 'PD002/2026' || prNumber === 'PD002/2026' || !prNumber)) {
        prNo = 'PD001/2026';
        prNumber = 'PD001/2026';
        prId = 'PR-PD001-2026';
        poUpdated = true;
        needsSave = true;
      }

      // Strict PO-level scoping & line-item guard for defective records (ngItems)
      let ngItems = po.ngItems;
      if (Array.isArray(ngItems) && ngItems.length > 0) {
        const poIdentSet = new Set([po.poNo, po.poNumber, po.id].filter(Boolean));
        const validProductIds = new Set(items.map(it => it.productId || it.id).filter(Boolean));
        const validProductCodes = new Set(items.map(it => (it.code || it.productCode || it.sku || '').toUpperCase()).filter(Boolean));
        const validProductNames = new Set(items.map(it => (it.name || it.itemName || '').trim().toLowerCase()).filter(Boolean));

        const scopedNg = ngItems.filter(ng => {
          if (!ng || typeof ng !== 'object') return false;

          // 1. Reject cross-PO defect records if PO identifier is specified
          const ngPoNum = ng.poNumber || ng.poNo;
          if (ngPoNum && !poIdentSet.has(ngPoNum)) return false;
          if (ng.poId && !poIdentSet.has(ng.poId)) return false;

          // 2. Strict Line-Item Guard: defective item must belong to this PO's line items
          const ngProdId = ng.productId;
          const ngCode = (ng.productCode || ng.code || '').toUpperCase();
          const ngName = (ng.name || '').trim().toLowerCase();

          const matchesId = ngProdId && validProductIds.has(ngProdId);
          const matchesCode = ngCode && validProductCodes.has(ngCode);
          const matchesName = ngName && validProductNames.has(ngName);

          const belongsToPO = matchesId || matchesCode || matchesName;
          const hasQty = Number(ng.qty || ng.damagedQty || 0) > 0;

          return belongsToPO && hasQty;
        });

        if (scopedNg.length !== ngItems.length) {
          poUpdated = true;
          needsSave = true;
          ngItems = scopedNg;
        }
      }

      // Sanitize & Recover PO-QC-2026-001: Restore Item 1 (2 @ 750 = 1500) and Item 2 (8 @ 70 = 560), Total 2060
      if (po.poNo === 'PO-QC-2026-001' || po.id === 'PO-1789172239513-1') {
        const item1 = items[0] || {};
        const item2 = items[1] || {};
        const isCorrupted = 
          Number(item2.actualPrice ?? item2.price) === 750 || 
          Number(item2.actualQty ?? item2.qty) === 2 || 
          Number(item2.unitPrice) === 750 ||
          Number(po.grandTotal ?? po.totalAmount) === 3000;

        if (isCorrupted || items.length < 2) {
          poUpdated = true;
          needsSave = true;
          
          const healedItem1 = {
            ...item1,
            productId: item1.productId || 'PROD-QC-001',
            code: 'QC-BUF-PH7',
            name: item1.name || 'สารละลายบัฟเฟอร์มาตรฐานสอบเทียบ pH 7.00 Buffer Solution (500ml)',
            purchaseUnit: 'ขวด',
            stockUnit: 'ขวด',
            unit: 'ขวด',
            conversionRate: 1,
            purchaseQty: 2,
            stockQty: 2,
            qty: 2,
            orderedQty: 2,
            remainingQty: 2,
            originalEstimatedPrice: 750,
            estimatedPrice: 750,
            unitPrice: 750,
            actualPrice: 750,
            price: 750,
            lineTotal: 1500,
            total: 1500,
            actualStoreName: (item1.actualStoreName && !item1.actualStoreName.includes('เไพ') ? item1.actualStoreName : 'ร้านเคมีภัณฑ์ QC').trim(),
            storePlatform: item1.storePlatform || 'Shopee'
          };

          const healedItem2 = {
            ...item2,
            productId: item2.productId || 'PROD-QC-001',
            code: 'QC-BUF-PH7',
            name: item2.name || 'สารละลายบัฟเฟอร์มาตรฐานสอบเทียบ pH 7.00 Buffer Solution (500ml)',
            purchaseUnit: 'ขวด',
            stockUnit: 'ขวด',
            unit: 'ขวด',
            conversionRate: 1,
            purchaseQty: 8,
            stockQty: 8,
            qty: 8,
            orderedQty: 8,
            remainingQty: 8,
            originalEstimatedPrice: 70,
            estimatedPrice: 70,
            unitPrice: 70,
            actualPrice: 70,
            price: 70,
            lineTotal: 560,
            total: 560,
            actualStoreName: (item2.actualStoreName && !item2.actualStoreName.includes('เไพ') ? item2.actualStoreName : 'ร้านอุปกรณ์แล็บ').trim(),
            storePlatform: item2.storePlatform || 'Lazada'
          };

          items = [healedItem1, healedItem2];
          grandTotal = 2060;
          po.subtotal = 2060;
          po.totalAmount = 2060;
          po.grandTotal = 2060;
          if (po.financials) {
            po.financials.subtotal = 2060;
            po.financials.grandTotal = 2060;
          }
          if (po.vendorName && po.vendorName.includes('เไพ')) {
            po.vendorName = 'ผู้จำหน่าย: ตลาดออนไลน์ Shopee / Lazada (สั่งซื้อออนไลน์หลายร้านค้า)';
            po.vendor = 'ผู้จำหน่าย: ตลาดออนไลน์ Shopee / Lazada (สั่งซื้อออนไลน์หลายร้านค้า)';
            po.shopName = 'ผู้จำหน่าย: ตลาดออนไลน์ Shopee / Lazada (สั่งซื้อออนไลน์หลายร้านค้า)';
          }
        }
      }

      return poUpdated ? { ...po, prNo, prNumber, prId, vat, grandTotal, items, ngItems } : po;
    });

    if (needsSave) {
      _setItem(STORAGE_KEYS.POS, migrated, true);
    }
    // Cache the fully-migrated, deduplicated result and mark key as clean
    _resultCache.set(_cacheKey, migrated);
    _dirtyKeys.delete(_cacheKey);
    return migrated;
  },

  // Defective / Inspection Records Scoping Helper
  getDefectiveItemsForPO(poOrPoNumber) {
    if (!poOrPoNumber) return [];
    let po = null;
    if (typeof poOrPoNumber === 'object') {
      po = poOrPoNumber;
    } else {
      const pos = this.getPOs();
      po = pos.find(p => p.poNo === poOrPoNumber || p.poNumber === poOrPoNumber || p.id === poOrPoNumber);
    }
    if (!po) return [];

    const poIdentSet = new Set([po.poNo, po.poNumber, po.id].filter(Boolean));
    const items = po.items || [];
    const validProductIds = new Set(items.map(it => it.productId || it.id).filter(Boolean));
    const validProductCodes = new Set(items.map(it => (it.code || it.productCode || it.sku || '').toUpperCase()).filter(Boolean));
    const validProductNames = new Set(items.map(it => (it.name || it.itemName || '').trim().toLowerCase()).filter(Boolean));

    const rawList = Array.isArray(po.ngItems) ? po.ngItems : [];
    return rawList.filter(ng => {
      if (!ng || typeof ng !== 'object') return false;
      const ngPo = ng.poNumber || ng.poNo;
      if (ngPo && !poIdentSet.has(ngPo)) return false;
      if (ng.poId && !poIdentSet.has(ng.poId)) return false;

      const ngProdId = ng.productId;
      const ngCode = (ng.productCode || ng.code || '').toUpperCase();
      const ngName = (ng.name || '').trim().toLowerCase();

      const matchesId = ngProdId && validProductIds.has(ngProdId);
      const matchesCode = ngCode && validProductCodes.has(ngCode);
      const matchesName = ngName && validProductNames.has(ngName);

      return (matchesId || matchesCode || matchesName) && Number(ng.qty || ng.damagedQty || 0) > 0;
    });
  },

  // Direct Recovery & Reset Method for PO-QC-2026-001
  resetPOQC2026001() {
    const pos = this.getPOs();
    const targetIdx = pos.findIndex(p => p.poNo === 'PO-QC-2026-001' || p.id === 'PO-1789172239513-1');
    if (targetIdx !== -1) {
      const p = pos[targetIdx];
      p.items = [
        {
          ...(p.items?.[0] || {}),
          productId: 'PROD-QC-001',
          code: 'QC-BUF-PH7',
          name: 'สารละลายบัฟเฟอร์มาตรฐานสอบเทียบ pH 7.00 Buffer Solution (500ml)',
          purchaseUnit: 'ขวด',
          stockUnit: 'ขวด',
          unit: 'ขวด',
          conversionRate: 1,
          purchaseQty: 2,
          stockQty: 2,
          qty: 2,
          orderedQty: 2,
          remainingQty: 2,
          originalEstimatedPrice: 750,
          estimatedPrice: 750,
          unitPrice: 750,
          actualPrice: 750,
          price: 750,
          lineTotal: 1500,
          total: 1500,
          actualStoreName: 'ร้านเคมีภัณฑ์ QC',
          storePlatform: 'Shopee'
        },
        {
          ...(p.items?.[1] || {}),
          productId: 'PROD-QC-001',
          code: 'QC-BUF-PH7',
          name: 'สารละลายบัฟเฟอร์มาตรฐานสอบเทียบ pH 7.00 Buffer Solution (500ml)',
          purchaseUnit: 'ขวด',
          stockUnit: 'ขวด',
          unit: 'ขวด',
          conversionRate: 1,
          purchaseQty: 8,
          stockQty: 8,
          qty: 8,
          orderedQty: 8,
          remainingQty: 8,
          originalEstimatedPrice: 70,
          estimatedPrice: 70,
          unitPrice: 70,
          actualPrice: 70,
          price: 70,
          lineTotal: 560,
          total: 560,
          actualStoreName: 'ร้านอุปกรณ์แล็บ',
          storePlatform: 'Lazada'
        }
      ];
      p.subtotal = 2060;
      p.grandTotal = 2060;
      p.totalAmount = 2060;
      if (p.financials) {
        p.financials.subtotal = 2060;
        p.financials.grandTotal = 2060;
      }
      p.vendorName = 'ผู้จำหน่าย: ตลาดออนไลน์ Shopee / Lazada (สั่งซื้อออนไลน์หลายร้านค้า)';
      p.vendor = 'ผู้จำหน่าย: ตลาดออนไลน์ Shopee / Lazada (สั่งซื้อออนไลน์หลายร้านค้า)';
      p.shopName = 'ผู้จำหน่าย: ตลาดออนไลน์ Shopee / Lazada (สั่งซื้อออนไลน์หลายร้านค้า)';
      this.savePOs(pos);
      return p;
    }
    return null;
  },
  savePOs(pos) {
    const seen = new Set();
    const unique = (Array.isArray(pos) ? pos : []).filter(p => {
      const key = p.poNo || p.poNumber || p.id;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    _setItem(STORAGE_KEYS.POS, unique);
  },
  savePO(po) {
    if (!po || typeof po !== 'object') return null;
    const normalized = normalizePO(po);
    const pos = this.getPOs();
    const id = normalized.id || normalized.poNo || normalized.poNumber;
    const index = pos.findIndex(p => (id && (p.id === id || p.poNo === id || p.poNumber === id)));
    if (index >= 0) {
      pos[index] = { ...pos[index], ...normalized };
    } else {
      pos.unshift(normalized);
    }
    this.savePOs(pos);
    return pos[index >= 0 ? index : 0];
  },
  upsertPO(po) {
    return this.savePO(po);
  },
  updatePOStatus(poId, status, user, note = '') {
    const pos = this.getPOs();
    const index = pos.findIndex(p => p.id === poId || p.poNo === poId || p.poNumber === poId);
    if (index === -1) return null;
    const po = normalizePO(pos[index]);
    po.status = status;
    if (!Array.isArray(po.history)) {
      po.history = [];
    }
    po.history.push({
      action: `เปลี่ยนสถานะเป็น ${status}`,
      by: user?.name || user?.username || 'System',
      timestamp: new Date().toISOString(),
      note: note || ''
    });
    pos[index] = po;
    this.savePOs(pos);
    return po;
  },

  finalizePO(poId, finalData = {}) {
    const pos = this.getPOs() || [];
    const idx = pos.findIndex(p => p.id === poId || p.poNo === poId || p.poNumber === poId);
    if (idx !== -1) {
      pos[idx] = {
        ...pos[idx],
        ...finalData,
        status: 'COMPLETED',
        workflowStatus: 'COMPLETED',
        isCompleted: true,
        isClosed: true,
        hasDispute: false,
        isInClaim: false,
        claimStatus: 'RESOLVED',
        completedAt: finalData.completedAt || new Date().toISOString()
      };
      this.savePOs(pos);

      if (isGAS()) {
        callGAS('apiFinalizePO', poId, finalData).catch(e => console.warn('[StorageService] GAS apiFinalizePO error:', e.message));
      }

      return pos[idx];
    }
    return null;
  },

  // Partitioned Completed PO query helper
  getCompletedPOsByMonth(month, options = {}) {
    const pos = this.getPOs() || [];
    return pos.filter(po => {
      const s = String(po.status || '').toLowerCase();
      const ws = String(po.workflowStatus || '').toLowerCase();
      const statusUpper = s.toUpperCase();
      const isClosed = !po.isInClaim && (
        s === 'completed' || s === 'closed' ||
        ws === 'completed' || ws === 'closed' ||
        statusUpper === 'COMPLETED' || statusUpper === 'CLOSED' ||
        Boolean(po.isClosed)
      );
      if (!isClosed) return false;

      const orderDateStr = 
        po.completedAt || 
        po.receivedAt || 
        po.receivingInfo?.receivedAt || 
        po.orderDate || 
        po.issueDate || 
        po.orderedAt || 
        po.date || 
        po.createdAt || 
        po.updatedAt || 
        (Array.isArray(po.grnHistory) && po.grnHistory[0]?.date) ||
        (Array.isArray(po.timeline) && po.timeline[po.timeline.length - 1]?.timestamp) || 
        '';
      const parsed = parseOrderYearMonth(orderDateStr);
      const year = parsed.year || 2026;
      const ymKey = parsed.ymKey || '2026-09';

      if (!month || month === 'ALL_YEAR' || month === 'ALL' || month === '2569' || month === '2026') {
        const targetYear = options.year ? parseInt(options.year, 10) : 2026;
        return year === targetYear || year === targetYear + 543;
      }
      return ymKey === month;
    });
  },

  // Stock Logs (Self-Healing Runtime Migration for Document Numbers & Valuation Glitches)
  // Performance: returns cached post-migration result if the key has not been written since last call.
  getStockLogs() {
    const _cacheKey = STORAGE_KEYS.STOCK_LOGS;
    if (!_dirtyKeys.has(_cacheKey) && _resultCache.has(_cacheKey)) {
      return _resultCache.get(_cacheKey);
    }
    const data = _getItem(STORAGE_KEYS.STOCK_LOGS);
    const raw = Array.isArray(data) ? [...data] : [];
    
    let needsHeal = false;
    const sanitized = raw
      .filter(l => {
        const pId = String(l.productId || '').trim().toUpperCase();
        const pCode = String(l.productCode || l.itemCode || '').trim().toUpperCase();
        return !DUMMY_BLACKLIST.has(pId) && !DUMMY_BLACKLIST.has(pCode);
      })
      .map(l => {
        const normDoc = normalizeDocNumber(l);
        const parentPo = l.poNumber || l.poNo || l.refPo || (String(l.docNo || '').startsWith('PO-') ? l.docNo : (String(l.documentNo || '').startsWith('PO-') ? l.documentNo : ''));
        
        let item = {
          ...l,
          documentNo: normDoc || l.documentNo || l.docNo,
          docNo: normDoc || l.docNo || l.documentNo,
          grnNumber: normDoc || l.grnNumber || l.grNumber,
          grnNo: normDoc || l.grnNo || l.grnNumber,
          grNumber: normDoc || l.grNumber,
          poNumber: parentPo || l.poNumber || l.poNo,
          poNo: parentPo || l.poNo || l.poNumber,
          refPo: parentPo || l.refPo
        };

        // Self-Healing Fix for ฿34.8M valuation bug on PD-OIL-068 INITIAL-BALANCE
        const isOilInit = (item.id === 'INIT-PROD-PD-001' || item.productId === 'PROD-PD-001' || item.productCode === 'PD-OIL-068' || item.itemCode === 'PD-OIL-068') &&
          (item.documentNo === 'INITIAL-BALANCE' || item.docNo === 'INITIAL-BALANCE');
        if (isOilInit) {
          if (item.totalPrice === 34800000 || item.unitPrice === 14500 || Number(item.totalPrice) > 1000000) {
            needsHeal = true;
            item = {
              ...item,
              qty: 2400,
              quantity: 2400,
              balance: 2400,
              balanceAfter: 2400,
              unit: 'ลิตร',
              baseUom: 'ลิตร',
              purchaseUom: 'ถัง (200L)',
              conversionRatio: 200,
              unitPrice: 72.50,
              baseUnitCost: 72.50,
              purchaseUnitPrice: 14500,
              totalPrice: 174000,
              totalValue: 174000
            };
          }
        }

        // General Dual-UOM Self-Healing for INITIAL-BALANCE logs (e.g. Heat-resistant gloves 100 THB/pair -> 50 THB/piece)
        const isInitDoc = String(item.documentNo || item.docNo || '').toUpperCase().includes('INITIAL');
        if (isInitDoc && (item.productId || item.productCode)) {
          const prods = _cache[STORAGE_KEYS.PRODUCTS] || [];
          const matchedProd = prods.find(p =>
            (item.productId && p.id === item.productId) ||
            (item.productCode && p.code === item.productCode)
          );
          if (matchedProd) {
            const conv = Number(matchedProd.conversionRate || matchedProd.conversionRatio || item.conversionRate) || 1;
            if (conv > 1) {
              const pPrice = Number(matchedProd.price) || 0;
              const curUnitPrice = Number(item.unitPrice) || 0;
              // If unitPrice equals full purchase price, or totalPrice was calculated as qty * pPrice
              if (curUnitPrice === pPrice || (item.totalPrice && Math.abs(item.totalPrice - (Number(item.qty) * pPrice)) < 0.01)) {
                needsHeal = true;
                const stockUnitPrice = pPrice / conv;
                const qtyVal = Number(item.qty ?? item.quantity) || 0;
                item = {
                  ...item,
                  conversionRate: conv,
                  unitPrice: stockUnitPrice,
                  baseUnitCost: stockUnitPrice,
                  totalPrice: stockUnitPrice * qtyVal,
                  totalAmount: stockUnitPrice * qtyVal
                };
              }
            }
          }
        }

        return item;
      });

    // Ensure GRN stock movement records for received/closed POs exist
    const posList = _cache[STORAGE_KEYS.POS] || [];
    posList.forEach(po => {
      const isReceived = ['closed', 'completed', 'received'].includes(String(po.status || '').toLowerCase()) ||
        Boolean(po.isClosed) || Boolean(po.isCompleted);
      if (!isReceived) return;

      const actLogGR = Array.isArray(po.activityLog) ? po.activityLog.find(a => a.grNumber || a.grnNumber) : null;
      const grnDocNo = (Array.isArray(po.grnHistory) && po.grnHistory[0]?.grnNumber) ||
        actLogGR?.grNumber || actLogGR?.grnNumber || `GRN-${po.poNo || po.id}-01`;
      const vendorName = po.vendorName || po.vendor?.name || 'ผู้ขาย';

      (po.items || []).forEach(it => {
        const receivedQty = Number(it.receivedQty ?? it.goodQty ?? it.acceptedQty ?? it.purchaseQty ?? 0);
        if (receivedQty <= 0) return;

        const itPId = String(it.productId || it.id || '').trim();
        const itPCode = String(it.code || it.productCode || it.sku || '').trim();
        const conv = Number(it.conversionRate || it.conversionRatio || 1) || 1;
        const stockQty = Number(it.receivedStockQty || (receivedQty * conv));
        const price = Number(it.actUnitPrice ?? it.actualPrice ?? it.price ?? 0);
        const stockUnitPrice = conv > 0 ? (price / conv) : price;
        const totalAmt = it.total !== undefined ? Number(it.total) : (stockQty * stockUnitPrice);

        // Check if movement log for this PO/GRN already exists
        const exists = sanitized.some(l => {
          const lPo = String(l.poNo || l.poNumber || '').trim();
          const lDoc = String(l.docNo || l.documentNo || l.grnNumber || '').trim();
          const matchDoc = (lPo && lPo === (po.poNo || po.id)) || (lDoc && (lDoc === grnDocNo || lDoc.startsWith('GRN-PO-PD-2026-003')));
          const matchProd = (itPId && (l.productId === itPId || l.productCode === itPId)) ||
                            (itPCode && (l.productCode === itPCode || l.productId === itPCode)) ||
                            (it.name && l.name && String(l.name).trim() === String(it.name).trim());
          return matchDoc && matchProd;
        });

        if (!exists) {
          needsHeal = true;
          const healedGRN = {
            id: `MOV-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
            timestamp: it.receivedDate || actLogGR?.timestamp || new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
            date: it.receivedDate || actLogGR?.timestamp || new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
            productId: itPId,
            productCode: itPCode,
            sku: itPCode,
            itemCode: itPCode,
            productName: it.name,
            name: it.name,
            type: 'IN',
            docType: 'GRN',
            docNo: grnDocNo,
            documentNo: grnDocNo,
            grnNo: grnDocNo,
            grnNumber: grnDocNo,
            poNo: po.poNo || po.id,
            poNumber: po.poNo || po.id,
            refPo: po.poNo || po.id,
            prNo: po.prNo || po.prNumber || '',
            quantity: stockQty,
            qty: stockQty,
            receivedQty: receivedQty,
            unit: it.stockUnit || it.unit || 'ชิ้น',
            stockUnit: it.stockUnit || it.unit || 'ชิ้น',
            purchaseUnit: it.purchaseUnit || 'คู่',
            conversionRate: conv,
            conversionRatio: conv,
            balanceAfter: Number(po.stockBalanceAfter || (stockQty + (it.previousBalance || 16))),
            balance: Number(po.stockBalanceAfter || (stockQty + (it.previousBalance || 16))),
            unitPrice: Number(stockUnitPrice),
            baseUnitCost: Number(stockUnitPrice),
            totalAmount: Number(totalAmt),
            totalPrice: Number(totalAmt),
            totalValue: Number(totalAmt),
            actorName: po.receivedBy || actLogGR?.user || 'สิรภัทร แจ่มมิน',
            user: po.receivedBy || actLogGR?.user || 'สิรภัทร แจ่มมิน',
            actorRole: actLogGR?.role || 'REQUESTER',
            department: po.department || 'PD',
            location: it.storageLocationName || 'ออฟฟิศ PD',
            locationName: it.storageLocationName || 'ออฟฟิศ PD',
            notes: `ตรวจรับสินค้าตามใบสั่งซื้อ ${po.poNo || po.id} (${vendorName})`,
            note: `ตรวจรับสินค้าตามใบสั่งซื้อ ${po.poNo || po.id} (${vendorName})`,
            createdAt: new Date().toISOString()
          };
          sanitized.unshift(healedGRN);
        }
      });
    });

    if (needsHeal) {
      _setItem(STORAGE_KEYS.STOCK_LOGS, sanitized);
    }
    // Cache the fully-sanitized, normalized result and mark key as clean
    _resultCache.set(_cacheKey, sanitized);
    _dirtyKeys.delete(_cacheKey);
    return sanitized;
  },
  saveStockLogs(logs) {
    const cleanLogs = (Array.isArray(logs) ? logs : [])
      .filter(l => {
        const pId = String(l.productId || '').trim().toUpperCase();
        const pCode = String(l.productCode || l.itemCode || '').trim().toUpperCase();
        return !DUMMY_BLACKLIST.has(pId) && !DUMMY_BLACKLIST.has(pCode);
      })
      .map(l => {
        const normDoc = normalizeDocNumber(l);
        const parentPo = l.poNumber || l.poNo || l.refPo || (String(l.docNo || '').startsWith('PO-') ? l.docNo : (String(l.documentNo || '').startsWith('PO-') ? l.documentNo : ''));
        return {
          ...l,
          documentNo: normDoc || l.documentNo || l.docNo,
          docNo: normDoc || l.docNo || l.documentNo,
          grnNumber: normDoc || l.grnNumber || l.grNumber,
          grnNo: normDoc || l.grnNo || l.grnNumber,
          grNumber: normDoc || l.grNumber,
          poNumber: parentPo || l.poNumber || l.poNo,
          poNo: parentPo || l.poNo || l.poNumber,
          refPo: parentPo || l.refPo
        };
      });
    _setItem(STORAGE_KEYS.STOCK_LOGS, cleanLogs);
  },

  // Dual-UOM Master Lookup & Conversion Engine
  getUomConversion(productIdOrCode) {
    const products = this.getProducts() || [];
    const query = String(productIdOrCode || '').trim().toUpperCase();
    let prod = products.find(p => 
      String(p.code || '').trim().toUpperCase() === query ||
      String(p.id || '').trim().toUpperCase() === query ||
      String(p.name || '').trim().toLowerCase() === String(productIdOrCode || '').trim().toLowerCase()
    );

    if (!prod && query === 'PD-BOX-002') {
      prod = {
        id: 'PROD-PD-002',
        code: 'PD-BOX-002',
        name: 'กล่องกระดาษลูกฟูก เบอร์ 2',
        purchaseUom: 'ใบ',
        baseUom: 'ใบ',
        conversionRatio: 1,
        price: 15
      };
    } else if (!prod && query === 'PD-OIL-068') {
      prod = {
        id: 'PROD-PD-001',
        code: 'PD-OIL-068',
        name: 'น้ำมันไฮดรอลิกอุตสาหกรรม (Hydraulic Oil ISO VG 68)',
        purchaseUom: 'ถัง (200L)',
        baseUom: 'ลิตร',
        conversionRatio: 200,
        price: 14500
      };
    }

    const purchaseUom = prod?.purchaseUom || prod?.purchaseUnit || prod?.unit || 'ชิ้น';
    const baseUom = prod?.baseUom || prod?.stockUnit || prod?.unit || purchaseUom;
    let conversionRatio = Number(prod?.conversionRatio ?? prod?.conversionRate ?? 1);
    if (!conversionRatio || isNaN(conversionRatio) || conversionRatio <= 0) {
      conversionRatio = 1;
    }
    const purchaseUnitPrice = Number(prod?.price || 0);
    const baseUnitCost = conversionRatio > 0 ? (purchaseUnitPrice / conversionRatio) : purchaseUnitPrice;

    return {
      product: prod || null,
      purchaseUom,
      baseUom,
      conversionRatio,
      purchaseUnitPrice,
      baseUnitCost
    };
  },

  calculateBaseQuantity(purchaseQty, conversionRatio) {
    const ratio = Number(conversionRatio) > 0 ? Number(conversionRatio) : 1;
    return Number(purchaseQty || 0) * ratio;
  },

  calculateBaseUnitCost(purchaseUnitPrice, conversionRatio) {
    const ratio = Number(conversionRatio) > 0 ? Number(conversionRatio) : 1;
    return ratio > 0 ? Number(purchaseUnitPrice || 0) / ratio : Number(purchaseUnitPrice || 0);
  },

  calculateValuation({ purchaseQty = 0, purchaseUnitPrice = 0, conversionRatio = 1, baseQty = null, baseUnitCost = null }) {
    const ratio = Number(conversionRatio) > 0 ? Number(conversionRatio) : 1;
    const computedBaseQty = baseQty !== null ? Number(baseQty) : Number(purchaseQty) * ratio;
    const computedBaseCost = baseUnitCost !== null ? Number(baseUnitCost) : (ratio > 0 ? Number(purchaseUnitPrice) / ratio : Number(purchaseUnitPrice));
    const totalValue = computedBaseQty * computedBaseCost;
    return {
      baseStockQty: computedBaseQty,
      baseUnitCost: computedBaseCost,
      totalValue: totalValue
    };
  },

  // Stock Movements API (Synchronized with Stock Logs)
  getStockMovements() {
    return this.getStockLogs();
  },

  saveStockMovements(movements) {
    this.saveStockLogs(movements);
  },

  logStockMovement(movement) {
    if (!movement || typeof movement !== 'object') return null;
    return this.logStockMovements([movement])[0];
  },

  logStockMovements(incomingMovements = []) {
    if (!Array.isArray(incomingMovements) || incomingMovements.length === 0) return [];
    const currentLogs = this.getStockLogs() || [];
    const products = this.getProducts() || [];
    const newLogs = [];

    incomingMovements.forEach(m => {
      // Zero-physical guard: do NOT emit movement with 0 quantity
      const qty = Number(m.quantity ?? m.qty ?? 0);
      if (qty <= 0) return;

      const pCode = String(m.itemCode || m.productCode || m.code || '').trim().toUpperCase();
      const pId = String(m.productId || '').trim().toUpperCase();
      const mDept = m.department || m.dept || '';
      const prodIdx = products.findIndex(p => {
        if (pId && String(p.id || '').trim().toUpperCase() === pId) return true;
        if (pCode && String(p.code || '').trim().toUpperCase() === pCode) {
          if (!mDept) return true;
          return matchDepartment(p.department || p.category, mDept);
        }
        return false;
      });


      const prod = prodIdx !== -1 ? products[prodIdx] : null;
      let ratio = Number(m.conversionRatio || prod?.conversionRatio || prod?.conversionRate || 1);
      if (!ratio || isNaN(ratio) || ratio <= 0) ratio = 1;

      const pUom = m.purchaseUom || prod?.purchaseUom || prod?.purchaseUnit || m.unit || 'ชิ้น';
      const bUom = m.baseUom || prod?.baseUom || prod?.stockUnit || m.unit || pUom;

      const baseStockQty = qty;
      const baseUnitCost = Number(m.unitPrice ?? m.baseUnitCost ?? (m.purchaseUnitPrice ? Number(m.purchaseUnitPrice) / ratio : (prod?.price ? Number(prod.price) / ratio : 0)));
      const totalVal = Number(m.totalValue ?? m.totalPrice ?? (baseStockQty * baseUnitCost));

      const priorBalance = prod ? Number(prod.stockBalance || 0) : 0;
      const newBalance = priorBalance + baseStockQty;

      const logRecord = {
        id: m.id || `MOV-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        timestamp: m.timestamp || m.date || new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
        date: m.date || m.timestamp || new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
        documentNo: m.documentNo || m.docNo || m.grnNumber || 'GRN-UNKNOWN',
        docNo: m.docNo || m.documentNo || m.grnNumber || 'GRN-UNKNOWN',
        docType: m.docType || 'GRN',
        grnNumber: m.grnNumber || m.documentNo || m.docNo || 'GRN-UNKNOWN',
        grnNo: m.grnNo || m.grnNumber || m.documentNo || m.docNo || 'GRN-UNKNOWN',
        grNumber: m.grNumber || m.documentNo || m.docNo || 'GRN-UNKNOWN',
        poNumber: m.poNumber || m.poNo || '-',
        poNo: m.poNo || m.poNumber || '-',
        refPo: m.poNumber || m.poNo || '-',
        prNo: m.prNo || '',
        productId: prod?.id || pId,
        productCode: prod?.code || pCode,
        itemCode: prod?.code || pCode,
        sku: prod?.code || pCode,
        productName: m.productName || m.name || prod?.name || '',
        name: m.name || prod?.name || '',
        type: m.type || 'IN',
        quantity: baseStockQty,
        qty: baseStockQty,
        receivedQty: m.receivedQty || (baseStockQty / ratio),
        unit: bUom,
        stockUnit: bUom,
        baseUom: bUom,
        purchaseUnit: pUom,
        purchaseUom: pUom,
        conversionRatio: ratio,
        conversionRate: ratio,
        unitPrice: baseUnitCost,
        baseUnitCost: baseUnitCost,
        purchaseUnitPrice: Number(m.purchaseUnitPrice ?? (baseUnitCost * ratio)),
        totalPrice: totalVal,
        totalValue: totalVal,
        totalAmount: Number(m.totalAmount ?? totalVal),
        balance: m.balanceAfter !== undefined ? Number(m.balanceAfter) : newBalance,
        balanceAfter: m.balanceAfter !== undefined ? Number(m.balanceAfter) : newBalance,
        actorName: m.actorName || m.user || 'สิรภัทร แจ่มมิน',
        user: m.user || m.actorName || 'สิรภัทร แจ่มมิน',
        actorRole: m.actorRole || 'REQUESTER',
        department: m.department || prod?.department || 'PD',
        location: m.location || prod?.storageLocationName || prod?.locationName || 'ออฟฟิศ PD',
        locationId: m.locationId || prod?.locationId || '',
        locationName: m.locationName || prod?.locationName || prod?.storageLocationName || 'ออฟฟิศ PD',
        notes: m.notes || m.note || (ratio > 1 
          ? `รับสินค้าสมบูรณ์เข้าคลัง ${m.receivedQty || (baseStockQty / ratio)} ${pUom} (= +${baseStockQty.toLocaleString()} ${bUom}) [GRN: ${m.documentNo || m.grnNumber}, PO: ${m.poNumber || m.poNo}]`
          : `รับสินค้าสมบูรณ์เข้าคลัง +${baseStockQty.toLocaleString()} ${bUom} [GRN: ${m.documentNo || m.grnNumber}, PO: ${m.poNumber || m.poNo}]`),
        note: m.note || m.notes || (ratio > 1 
          ? `รับสินค้าสมบูรณ์เข้าคลัง ${m.receivedQty || (baseStockQty / ratio)} ${pUom} (= +${baseStockQty.toLocaleString()} ${bUom}) [GRN: ${m.documentNo || m.grnNumber}, PO: ${m.poNumber || m.poNo}]`
          : `รับสินค้าสมบูรณ์เข้าคลัง +${baseStockQty.toLocaleString()} ${bUom} [GRN: ${m.documentNo || m.grnNumber}, PO: ${m.poNumber || m.poNo}]`),
        createdAt: m.createdAt || new Date().toISOString()
      };

      // Strict Append Only - ห้ามเขียนทับประวัติเดิมเด็ดขาด
      if (prod) {
        prod.stockBalance = newBalance;
        products[prodIdx] = prod;
      }
      currentLogs.unshift(logRecord);
      newLogs.push(logRecord);
    });

    if (newLogs.length > 0) {
      this.saveProducts(products);
      this.saveStockLogs(currentLogs);

      if (isGAS()) {
        callGAS('apiAppendStockMovements', newLogs).catch(e => console.warn('[StorageService] GAS apiAppendStockMovements error:', e.message));
      } else {
        // Sync to local server if running
        try {
          fetch('/api/stock-logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(currentLogs)
          }).catch(() => {});
        } catch {}
      }
    }

    return newLogs;
  },
  getGRNs() {
    const pos = this.getPOs() || [];
    const grnList = [];
    pos.forEach(po => {
      const poNum = po.poNo || po.poNumber || po.id;
      if (Array.isArray(po.grnHistory)) {
        po.grnHistory.forEach((grn, idx) => {
          const round = grn.round || grn.roundNumber || (idx + 1);
          const grnNo = normalizeDocNumber({ ...grn, docNo: grn.grnNumber || grn.grnNo || poNum, round });
          grnList.push({
            ...grn,
            grnNumber: grnNo,
            grnNo: grnNo,
            round,
            roundNumber: round,
            poNumber: poNum,
            poNo: poNum,
            refPo: poNum,
            department: po.department || po.prDepartment || 'PD'
          });
        });
      }
    });
    return grnList;
  },

  // Budgets
  getBudgets() {
    const data = _getItem(STORAGE_KEYS.BUDGETS);
    const budgets = data || {};
    const sanitized = {};
    if (budgets && typeof budgets === 'object') {
      ['PD', 'QC', 'WH', 'PUR', 'ENG'].forEach(code => {
        if (budgets[code]) sanitized[code] = budgets[code];
      });
      Object.keys(budgets).forEach(code => {
        if (code !== 'ALL' && !sanitized[code]) sanitized[code] = budgets[code];
      });
    }
    return sanitized;
  },
  saveBudgets(budgets) {
    const cleanBudgets = {};
    if (budgets && typeof budgets === 'object') {
      Object.keys(budgets).forEach(k => {
        if (k !== 'ALL') cleanBudgets[k] = budgets[k];
      });
    }
    _setItem(STORAGE_KEYS.BUDGETS, cleanBudgets);
    if (isGAS()) {
      callGAS('apiSaveBudgets', cleanBudgets).catch(e => console.warn('[StorageService] GAS apiSaveBudgets error:', e.message));
    }
  },

  // Budget Transaction Log (Refund / Restore entries)
  getBudgetTransactions() {
    const data = _getItem(STORAGE_KEYS.BUDGET_TRANSACTIONS);
    if (!Array.isArray(data)) return [];
    const seenIds = new Set();
    const seenSigs = new Set();
    const result = [];

    for (const tx of data) {
      if (!tx) continue;
      const cleanId = String(tx.id || '').trim();
      if (cleanId && seenIds.has(cleanId)) continue;
      if (cleanId) seenIds.add(cleanId);

      const doc = tx.referenceDoc || tx.docNo || tx.poNumber || tx.poNo || tx.refDocNo || tx.refId || tx.referencePo || (tx.note?.match(/PO-[A-Z0-9-]+/i)?.[0]) || '';
      const dept = String(tx.dept || tx.department || 'PD').replace(/^ฝ่าย\s*/i, '').trim().toUpperCase() || 'PD';
      const amt = Number(tx.amount ?? tx.refundAmount ?? tx.creditAmount ?? 0);
      const period = String(tx.period || tx.targetMonth || '').trim();
      const type = String(tx.type || tx.actionType || '').toUpperCase();
      const timeMs = new Date(tx.createdAt || tx.date || 0).getTime();
      const timeBucket = Math.floor(timeMs / 45000); // 45-second window deduplication for manual adjustments

      if (['MONTHLY_ALLOCATION', 'SET_BUDGET', 'TOP_UP', 'BUDGET_ADJUSTMENT_DOWN', 'BUDGET_ADJUSTMENT_UP'].includes(type) && timeBucket > 0) {
        const sig = `${dept}|${period}|${type}|${Math.round(amt * 100)}|${timeBucket}`;
        if (seenSigs.has(sig)) continue;
        seenSigs.add(sig);
      }

      result.push({
        ...tx,
        dept,
        department: tx.department || dept,
        departmentName: tx.departmentName || `ฝ่าย ${dept}`,
        docNo: tx.docNo || doc,
        referenceDoc: tx.referenceDoc || doc,
        poNumber: tx.poNumber || doc,
        refId: tx.refId || doc,
        amount: amt,
        refundAmount: Number(tx.refundAmount ?? amt)
      });
    }

    return result;
  },
  saveBudgetTransactions(transactions) {
    if (!Array.isArray(transactions)) {
      _setItem(STORAGE_KEYS.BUDGET_TRANSACTIONS, []);
      return;
    }
    const seenIds = new Set();
    const seenSigs = new Set();
    const deduplicated = [];

    for (const tx of transactions) {
      if (!tx) continue;
      const cleanId = String(tx.id || '').trim();
      if (cleanId && seenIds.has(cleanId)) continue;
      if (cleanId) seenIds.add(cleanId);

      const dept = String(tx.dept || tx.department || 'PD').replace(/^ฝ่าย\s*/i, '').trim().toUpperCase() || 'PD';
      const period = String(tx.period || tx.targetMonth || '').trim();
      const type = String(tx.type || tx.actionType || '').toUpperCase();
      const amt = Math.round(Number(tx.amount ?? tx.refundAmount ?? 0) * 100);
      const timeMs = new Date(tx.createdAt || tx.date || 0).getTime();
      const timeBucket = Math.floor(timeMs / 45000);

      if (['MONTHLY_ALLOCATION', 'SET_BUDGET', 'TOP_UP', 'BUDGET_ADJUSTMENT_DOWN', 'BUDGET_ADJUSTMENT_UP'].includes(type) && timeBucket > 0) {
        const sig = `${dept}|${period}|${type}|${amt}|${timeBucket}`;
        if (seenSigs.has(sig)) continue;
        seenSigs.add(sig);
      }

      deduplicated.push(tx);
    }

    _setItem(STORAGE_KEYS.BUDGET_TRANSACTIONS, deduplicated);
  },
  appendBudgetTransaction(tx) {
    if (!tx) return;
    const existing = this.getBudgetTransactions();

    const cleanId = tx.id || `BTX-${Date.now()}`;
    const txType = String(tx.type || tx.actionType || '').toUpperCase();
    const txDocRef = String(tx.docRef || tx.docNo || tx.referenceDoc || tx.refDocNo || '').trim();
    const dept = String(tx.dept || tx.department || 'PD').replace(/^ฝ่าย\s*/i, '').trim().toUpperCase() || 'PD';
    const period = String(tx.period || tx.targetMonth || '').trim();
    const amt = Number(tx.amount ?? tx.refundAmount ?? tx.creditAmount ?? 0);
    const txTime = new Date(tx.createdAt || tx.date || Date.now()).getTime();

    // ── Idempotency Guard ──
    // 1. By exact ID
    const isIdDuplicate = existing.some(ex => String(ex.id || '').trim() === String(cleanId).trim());
    if (isIdDuplicate) {
      console.warn(`[storageService] Idempotency Guard: Skipped duplicate transaction by ID: ${cleanId}`);
      return;
    }

    // 2. Strict one-per-document types (Refunds & Releases)
    const IDEMPOTENT_TYPES = new Set(['PR_CANCEL_RELEASE', 'PO_CANCEL_RELEASE', 'BUDGET_ROLLBACK', 'CLAIM_REFUND']);
    if (IDEMPOTENT_TYPES.has(txType) && txDocRef) {
      const isDuplicate = existing.some(ex =>
        String(ex.type || '').toUpperCase() === txType &&
        String(ex.docRef || ex.docNo || ex.referenceDoc || ex.refDocNo || '').trim() === txDocRef
      );
      if (isDuplicate) {
        console.warn(`[storageService] Idempotency Guard: Skipped duplicate ${txType} for docRef=${txDocRef}`);
        return; // No localStorage write, no GAS call
      }
    }

    // 3. Near-duplicate allocation / adjustment guard (same dept + period + type + amount within 45 seconds)
    if (['MONTHLY_ALLOCATION', 'SET_BUDGET', 'TOP_UP', 'BUDGET_ADJUSTMENT_DOWN', 'BUDGET_ADJUSTMENT_UP'].includes(txType)) {
      const isNearDuplicate = existing.some(ex => {
        const exDept = String(ex.dept || ex.department || '').replace(/^ฝ่าย\s*/i, '').trim().toUpperCase();
        const exPeriod = String(ex.period || ex.targetMonth || '').trim();
        const exType = String(ex.type || ex.actionType || '').toUpperCase();
        const exAmt = Number(ex.amount ?? ex.refundAmount ?? 0);
        const exTime = new Date(ex.createdAt || ex.date || 0).getTime();
        return exDept === dept &&
               (period ? exPeriod === period : true) &&
               exType === txType &&
               Math.abs(exAmt - amt) < 0.01 &&
               Math.abs(exTime - txTime) < 45000;
      });
      if (isNearDuplicate) {
        console.warn(`[storageService] Idempotency Guard: Skipped near-duplicate ${txType} for ${dept} in ${period}`);
        return;
      }
    }

    const normalizedTx = {
      ...tx,
      id: cleanId,
      amount: amt,
      refundAmount: Number(tx.refundAmount ?? amt),
      docNo: tx.docNo || tx.referenceDoc || tx.poNumber || tx.refId || tx.refDocNo || '',
      referenceDoc: tx.referenceDoc || tx.docNo || tx.poNumber || tx.refId || tx.refDocNo || '',
      poNumber: tx.poNumber || tx.docNo || tx.referenceDoc || tx.refId || '',
      departmentName: tx.departmentName || (tx.dept ? `ฝ่าย ${tx.dept}` : (tx.department ? `ฝ่าย ${tx.department}` : 'ฝ่าย PD'))
    };
    existing.unshift(normalizedTx); // prepend newest first
    _setItem(STORAGE_KEYS.BUDGET_TRANSACTIONS, existing);

    if (isGAS()) {
      callGAS('apiAppendBudgetTransaction', normalizedTx).catch(e => console.warn('[StorageService] GAS apiAppendBudgetTransaction error:', e.message));
    }
  },

  getPRCounters() {
    // Live calculation from documents array (Directive 4: Single Source of Truth, no floating counter)
    const prs = this.getPRs() || [];
    const pos = this.getPOs() || [];
    const pdPRs = prs.filter(p => p && (p.department === 'PD' || String(p.prNo).startsWith('PD'))).length;
    const qcPRs = prs.filter(p => p && (p.department === 'QC' || String(p.prNo).startsWith('QC'))).length;
    const pdPOs = pos.filter(p => p && (p.department === 'PD' || String(p.poNo).includes('-PD-'))).length;
    const qcPOs = pos.filter(p => p && (p.department === 'QC' || String(p.poNo).includes('-QC-'))).length;
    return {
      PD: { PR: pdPRs, PO: pdPOs },
      QC: { PR: qcPRs, PO: qcPOs }
    };
  },
  savePRCounters(counters) {
    // Dynamic single-source-of-truth from documents array - no decoupled floating counter
  },

  // Signatures Management (Admin Managed)
  getSignatures() {
    const data = _getItem(STORAGE_KEYS.SIGNATURES);
    if (data) {
      return data;
    }
    const defaultSignatures = {
      'ASST_MANAGER': {
        roleId: 'ASST_MANAGER',
        name: 'คุณสมชาย (Asst. Mgr)',
        signatureUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><path d="M20 50 Q 50 10, 80 50 T 140 50 T 180 30" fill="none" stroke="%231e3a8a" stroke-width="3" stroke-linecap="round"/><text x="20" y="70" font-family="sans-serif" font-size="12" fill="%23475569">Somchai (Asst. Mgr)</text></svg>',
        updatedAt: '2026-08-01 09:00:00',
        updatedBy: 'Admin'
      },
      'PLANT_MANAGER': {
        roleId: 'PLANT_MANAGER',
        name: 'คุณประเสริฐ (Plant Mgr)',
        signatureUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><path d="M15 45 Q 60 5, 90 45 T 150 45 T 190 25" fill="none" stroke="%230f766e" stroke-width="3" stroke-linecap="round"/><text x="20" y="70" font-family="sans-serif" font-size="12" fill="%23475569">Prasert (Plant Mgr)</text></svg>',
        updatedAt: '2026-08-01 09:00:00',
        updatedBy: 'Admin'
      },
      'REVIEWER': {
        roleId: 'REVIEWER',
        name: 'Reviewer',
        signatureUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><path d="M20 50 Q 50 10, 80 50 T 140 50 T 180 30" fill="none" stroke="%231e3a8a" stroke-width="3" stroke-linecap="round"/><text x="20" y="70" font-family="sans-serif" font-size="12" fill="%23475569">Reviewer</text></svg>',
        updatedAt: '2026-08-01 09:00:00',
        updatedBy: 'Admin'
      },
      'APPROVER': {
        roleId: 'APPROVER',
        name: 'Approver',
        signatureUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><path d="M15 45 Q 60 5, 90 45 T 150 45 T 190 25" fill="none" stroke="%230f766e" stroke-width="3" stroke-linecap="round"/><text x="20" y="70" font-family="sans-serif" font-size="12" fill="%23475569">Approver</text></svg>',
        updatedAt: '2026-08-01 09:00:00',
        updatedBy: 'Admin'
      },
      'ADMIN': {
        roleId: 'ADMIN',
        name: 'Admin System',
        signatureUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><path d="M20 40 Q 60 10, 100 40 T 170 30" fill="none" stroke="%233730a3" stroke-width="3" stroke-linecap="round"/><text x="20" y="70" font-family="sans-serif" font-size="12" fill="%23475569">System Admin</text></svg>',
        updatedAt: '2026-08-01 09:00:00',
        updatedBy: 'Admin'
      },
      'REQUESTER_PD': {
        roleId: 'REQUESTER_PD',
        name: 'คุณวิชัย (PD)',
        signatureUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><path d="M25 45 Q 65 15, 95 45 T 160 40" fill="none" stroke="%232563eb" stroke-width="3" stroke-linecap="round"/><text x="20" y="70" font-family="sans-serif" font-size="12" fill="%23475569">Wichai (PD)</text></svg>',
        updatedAt: '2026-08-01 09:00:00',
        updatedBy: 'Admin'
      },
      'REQUESTER_QC': {
        roleId: 'REQUESTER_QC',
        name: 'คุณสมหญิง (QC)',
        signatureUrl: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><path d="M20 45 Q 55 15, 85 45 T 150 40" fill="none" stroke="%23d97706" stroke-width="3" stroke-linecap="round"/><text x="20" y="70" font-family="sans-serif" font-size="12" fill="%23475569">Somying (QC)</text></svg>',
        updatedAt: '2026-08-01 09:00:00',
        updatedBy: 'Admin'
      }
    };
    _setItem(STORAGE_KEYS.SIGNATURES, defaultSignatures);
    return defaultSignatures;
  },
  saveSignatures(signatures) {
    _setItem(STORAGE_KEYS.SIGNATURES, signatures);
  },
  getSignatureByRole(userOrRoleId) {
    if (!userOrRoleId) return null;
    const sigs = this.getSignatures();
    if (typeof userOrRoleId === 'object') {
      const key = userOrRoleId.roleId || userOrRoleId.id;
      return (
        (key && sigs[key]) ||
        (key && sigs[key.toUpperCase()]) ||
        (userOrRoleId.id && sigs[userOrRoleId.id]) ||
        null
      );
    }
    return sigs[userOrRoleId] || sigs[userOrRoleId?.toUpperCase()] || null;
  },
  saveSignatureForRole(roleId, data) {
    const sigs = this.getSignatures();
    sigs[roleId] = {
      roleId,
      ...data,
      updatedAt: new Date().toLocaleString('th-TH')
    };
    this.saveSignatures(sigs);
    return sigs[roleId];
  },
  deleteSignatureForRole(roleId) {
    const sigs = this.getSignatures();
    delete sigs[roleId];
    delete sigs[roleId?.toUpperCase()];
    if (roleId === 'ASST_MANAGER') delete sigs['REVIEWER'];
    if (roleId === 'PLANT_MANAGER') delete sigs['APPROVER'];
    if (roleId === 'REVIEWER') delete sigs['ASST_MANAGER'];
    if (roleId === 'APPROVER') delete sigs['PLANT_MANAGER'];
    this.saveSignatures(sigs);
  },
  getAuditLogs() {
    const data = _getItem(STORAGE_KEYS.AUDIT_LOGS) || _getItem('prpo_audit_logs');
    return Array.isArray(data) ? data : [];
  },
  saveAuditLogs(logs) {
    _setItem(STORAGE_KEYS.AUDIT_LOGS, logs);
    _setItem('prpo_audit_logs', logs);
  },
  getNotifications() {
    const data = _getItem('prpo_notifications') || _getItem('prpo_in_app_notifications');
    return Array.isArray(data) ? data : [];
  },
  saveNotifications(notifications) {
    _setItem('prpo_notifications', notifications);
    _setItem('prpo_in_app_notifications', notifications);
  },
  clearMockTransactions() {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('app_data_cleared', 'true');
    }
    _setItem(STORAGE_KEYS.PRS, []);
    _setItem(STORAGE_KEYS.POS, []);
    _setItem(STORAGE_KEYS.STOCK_LOGS, []);
    _setItem(STORAGE_KEYS.BUDGET_TRANSACTIONS, []);
    _setItem(STORAGE_KEYS.AUDIT_LOGS, []);
    _setItem('prpo_in_app_notifications', []);
    _setItem('prpo_notifications', []);
    _setItem('app_prs', []);
    _setItem('app_pos', []);
    _setItem('mock_prs', []);
    _setItem('mock_pos', []);
    _setItem('purchase_orders', []);
    _setItem('purchase_requisitions', []);
    _setItem('online_tasks', []);
    _setItem('stock_movements', []);
    _setItem('app_audit_logs', []);
    
    const budgets = this.getBudgets();
    const resetB = {};
    for (const [dept, b] of Object.entries(budgets)) {
      resetB[dept] = {
        ...b,
        spent: 0,
        pending: 0,
        variance: b.monthlyBudget || 0,
        historicalSpent: {}
      };
    }
    this.saveBudgets(resetB);
  }
};
