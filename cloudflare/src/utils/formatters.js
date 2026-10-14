/**
 * Centralized Formatting Utilities
 * Single Source of Truth for:
 * 1. Timezone-bound Thai Date/Time (Asia/Bangkok: UTC+7)
 * 2. Currency & Number Formatting (THB / ฿)
 */

export { parseSafeDate, formatThaiDateTime, formatDocDateTime } from './dateHelper.js';

/**
 * Format a number as currency (THB) with customizable decimals and prefix.
 *
 * @param {number|string} amount - Numerical value
 * @param {object} [options]
 * @param {number} [options.minimumFractionDigits=2]
 * @param {number} [options.maximumFractionDigits=2]
 * @param {boolean} [options.withSymbol=false] - Whether to prefix with ฿
 * @returns {string} e.g. "1,250.00" or "฿1,250.00"
 */
export function formatCurrency(amount, options = {}) {
  const num = (amount === null || amount === undefined || amount === '' || isNaN(Number(amount))) ? 0 : Number(amount);
  const minDec = options.minimumFractionDigits ?? 2;
  const maxDec = options.maximumFractionDigits ?? 2;

  const formatted = num.toLocaleString('th-TH', {
    minimumFractionDigits: minDec,
    maximumFractionDigits: maxDec
  });

  return options.withSymbol ? `฿${formatted}` : formatted;
}

/**
 * Convenience helper to format monetary amounts with ฿ symbol.
 * e.g. formatTHB(500) -> "฿500.00"
 *
 * @param {number|string} amount
 * @returns {string}
 */
export function formatTHB(amount) {
  return formatCurrency(amount, { withSymbol: true });
}

/**
 * Format general numbers with thousands separator.
 *
 * @param {number|string} num
 * @param {number} [maxDecimals=2]
 * @returns {string}
 */
export function formatNumber(num, maxDecimals = 2) {
  const n = Number(num) || 0;
  return n.toLocaleString('th-TH', {
    maximumFractionDigits: maxDecimals
  });
}

/**
 * Safe string comparison for sorting alphanumeric identifiers, codes, or strings.
 * Safely handles numbers, null, undefined, and objects without throwing TypeError.
 * Natural sorting via `{ numeric: true }` so numeric codes order properly (e.g. 1, 2, 10).
 *
 * @param {*} a
 * @param {*} b
 * @param {string} [locale='th']
 * @param {object} [options={ numeric: true }]
 * @returns {number}
 */
export const safeStringCompare = (a, b, locale = 'th', options = { numeric: true }) => {
  return String(a ?? '').localeCompare(String(b ?? ''), locale, options);
};

// Re-export Google Drive image resolvers for seamless developer ergonomics
export {
  resolveDriveImageUrl,
  getDriveLh3Url,
  getDriveFileViewUrl,
  handleDriveImageError
} from './driveHelper.js';

