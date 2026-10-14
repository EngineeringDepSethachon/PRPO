import { matchDepartment } from './permissions.js';

/**
 * Document ID & Sequence Generator with Dynamic Max-ID Scanner and Collision Guard
 * 
 * Rules:
 * 1. Scans existing documents in memory & LocalStorage to find true maximum numeric sequence using Regex.
 *    (e.g., from 'PD004/2026' extracts '4' and avoids mixing with the year '2026')
 * 2. Next ID = currentMax + 1, padded with zeros (e.g., 'PD005/2026').
 * 3. Collision Guard: Ensures generated ID is never duplicated against existing list.
 */

/**
 * Calculate next PR Number from real documents (Dynamic Max-ID Scanner)
 * @param {Array} allPRs - List of PR objects (optional, falls back to localStorage)
 * @param {string} department - Department code (e.g. 'PD', 'QC')
 * @param {number|string} year - Document year (default: current year or 2026)
 * @returns {string} Next unique PR Number (e.g. 'PD005/2026')
 */
export const getNextPRNumber = (allPRs = [], department = 'PD', year = 2026) => {
  let list = allPRs;
  if (!list || list.length === 0) {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const local = window.localStorage.getItem('prpo_clean_v15_sanitized') || 
                      window.localStorage.getItem('prs') || 
                      window.localStorage.getItem('prpo_prs');
        if (local) list = JSON.parse(local);
      }
    } catch (e) {}
  }

  const prefix = `${(department || 'PD').toUpperCase().trim()}`;
  const docYear = year || new Date().getFullYear();
  const regex = new RegExp(`^${prefix}(\\d+)/${docYear}$`, 'i');

  const existingNumbers = (list || [])
    .map(item => {
      if (!item) return 0;
      const candidates = [item.prNo, item.prNumber, item.id].filter(Boolean);
      for (const val of candidates) {
        const match = String(val).trim().match(regex);
        if (match && match[1]) {
          const num = parseInt(match[1], 10);
          if (!isNaN(num) && num > 0) return num;
        }
      }
      return 0;
    })
    .filter(n => !isNaN(n) && n > 0);

  const maxNum = existingNumbers.length > 0 ? Math.max(...existingNumbers) : 0;
  let nextNum = maxNum + 1;
  let nextId = `${prefix}${String(nextNum).padStart(3, '0')}/${docYear}`;

  // Collision Guard: Ensure nextId does not collide with any existing PR id or prNo
  const existingSet = new Set(
    (list || []).flatMap(item => [item?.prNo, item?.prNumber, item?.id].filter(Boolean).map(s => String(s).toUpperCase().trim()))
  );

  while (existingSet.has(nextId.toUpperCase())) {
    nextNum++;
    nextId = `${prefix}${String(nextNum).padStart(3, '0')}/${docYear}`;
  }

  return nextId;
};

// Export generateNextPRId as alias to getNextPRNumber for full backward compatibility
export const generateNextPRId = getNextPRNumber;

/**
 * Generate next PO Number (e.g. PO-PD-2026-005)
 * @param {Array} allPOs - List of PO objects
 * @param {string} department - Department code (e.g. 'PD', 'QC')
 * @param {number|string} year - Document year (default: current year or 2026)
 * @param {number} offset - Optional offset for batch generation
 * @returns {string} Next unique PO Number
 */
export const getNextPONumber = (allPOs = [], department = 'PD', year = 2026, offset = 0) => {
  let list = allPOs;
  if (!list || list.length === 0) {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const local = window.localStorage.getItem('prpo_pos') || window.localStorage.getItem('pos');
        if (local) list = JSON.parse(local);
      }
    } catch (e) {}
  }

  const dept = (department || 'PD').toUpperCase().trim();
  const docYear = year || new Date().getFullYear();
  const regex = new RegExp(`^PO-${dept}-${docYear}-(\\d+)`, 'i');

  const existingNumbers = (list || [])
    .map(item => {
      if (!item) return 0;
      const candidates = [item.poNo, item.poNumber, item.id].filter(Boolean);
      for (const val of candidates) {
        const match = String(val).trim().match(regex);
        if (match && match[1]) {
          const num = parseInt(match[1], 10);
          if (!isNaN(num) && num > 0) return num;
        }
      }
      return 0;
    })
    .filter(n => !isNaN(n) && n > 0);

  const maxNum = existingNumbers.length > 0 ? Math.max(...existingNumbers) : 0;
  let nextNum = maxNum + 1 + offset;
  let nextId = `PO-${dept}-${docYear}-${String(nextNum).padStart(3, '0')}`;

  // Collision Guard
  const existingSet = new Set(
    (list || []).flatMap(item => [item?.poNo, item?.poNumber, item?.id].filter(Boolean).map(s => String(s).toUpperCase().trim()))
  );

  while (existingSet.has(nextId.toUpperCase())) {
    nextNum++;
    nextId = `PO-${dept}-${docYear}-${String(nextNum).padStart(3, '0')}`;
  }

  return nextId;
};

// Export generateNextPOId as alias to getNextPONumber for full backward compatibility
export const generateNextPOId = getNextPONumber;

/**
 * Calculate next Product SKU / Item Code scoped by department
 * @param {Array} products - List of product objects
 * @param {string} currentDept - Target department code (e.g. 'PD', 'QC')
 * @returns {string} Next unique numeric code string (e.g. '1', '2')
 */
export const generateNextProductCode = (products = [], currentDept = 'PD') => {
  const deptProducts = (products || []).filter(p => p && matchDepartment(p.department || p.category || p.dept, currentDept));
  const nextNumber = deptProducts.reduce((max, p) => {
    const num = parseInt(p.code || p.sku, 10);
    return !isNaN(num) && num > max ? num : max;
  }, 0) + 1;
  return String(nextNumber);
};

export const generateNextCode = generateNextProductCode;

/**
 * Calculate next Vendor Code scoped by department
 * @param {Array} vendors - List of vendor objects
 * @param {string} department - Target department scope (e.g. 'ALL', 'PD', 'QC')
 * @returns {string} Next unique vendor code (e.g. 'VND-01', 'VND-QC-01')
 */
export const generateNextVendorCode = (vendors = [], department = 'ALL') => {
  const currentDept = (department || 'ALL').toUpperCase().trim();
  const deptVendors = (vendors || []).filter(v => {
    if (!v) return false;
    const vDept = (v.department || 'ALL').toUpperCase().trim();
    if (currentDept === 'ALL' || vDept === 'ALL') return true;
    return matchDepartment(vDept, currentDept);
  });

  const numbers = deptVendors.map(v => {
    const code = String(v.code || v.vendorCode || '').trim();
    const match = code.match(/(\d+)$/);
    return match ? parseInt(match[1], 10) : 0;
  }).filter(n => !isNaN(n) && n > 0);

  const nextNumber = (numbers.length > 0 ? Math.max(...numbers) : 0) + 1;
  const prefix = currentDept === 'ALL' ? 'VND' : `VND-${currentDept}`;
  return `${prefix}-${String(nextNumber).padStart(2, '0')}`;
};

