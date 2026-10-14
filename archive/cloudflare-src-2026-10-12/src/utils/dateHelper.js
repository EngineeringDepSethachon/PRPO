/**
 * Date & Time Parsing and Formatting Utilities
 * Single Source of Truth for:
 * 1. Safe Date Parsing (Handling Thai Buddhist Era, ISO, Epoch, Slashes, NaN prevention)
 * 2. Safe Thai Date/Time Formatting (Asia/Bangkok: UTC+7)
 * 3. Guaranteeing NO 'Invalid Date' output anywhere in UI
 */

/**
 * Parses any date value safely into a valid JavaScript Date object.
 * Handles:
 * - ISO strings (e.g. "2026-09-16T12:00:00.000Z")
 * - Epoch timestamps in milliseconds or seconds (e.g. 1726488000000, 1726488000)
 * - Date objects (validating valid time)
 * - Thai Buddhist Era strings ("16/09/2569", "16/9/2569", "16/09/2569 เวลา 10:15 น.", etc.)
 * - Automatic conversion from Buddhist Era (year > 2400/2500) to Christian Era (-543)
 * - Fallback to fallbackDate (defaults to new Date()) if parsing fails or results in NaN
 *
 * @param {Date|string|number|null|undefined} dateVal
 * @param {Date} [fallbackDate=new Date()]
 * @returns {Date} Guaranteed valid Date object
 */
export function parseSafeDate(dateVal, fallbackDate = new Date()) {
  const safeFallback = fallbackDate instanceof Date && !isNaN(fallbackDate.getTime()) 
    ? fallbackDate 
    : new Date();

  if (dateVal === null || dateVal === undefined || dateVal === '' || dateVal === '-') {
    return safeFallback;
  }

  // 1. If already a Date object
  if (dateVal instanceof Date) {
    return !isNaN(dateVal.getTime()) ? dateVal : safeFallback;
  }

  // 2. If number (epoch timestamp)
  if (typeof dateVal === 'number') {
    if (isNaN(dateVal) || !isFinite(dateVal)) return safeFallback;
    const timestamp = dateVal < 10000000000 ? dateVal * 1000 : dateVal;
    const d = new Date(timestamp);
    return !isNaN(d.getTime()) ? d : safeFallback;
  }

  try {
    const rawStr = String(dateVal).trim();
    if (!rawStr || rawStr === '-' || rawStr.toLowerCase() === 'invalid date' || rawStr.includes('.....')) {
      return safeFallback;
    }

    // Check if numeric string e.g. "1726488000000"
    if (/^\d{10,13}$/.test(rawStr)) {
      const num = Number(rawStr);
      const timestamp = num < 10000000000 ? num * 1000 : num;
      const d = new Date(timestamp);
      if (!isNaN(d.getTime())) return d;
    }

    // Clean prefix like "วันที่ "
    const cleanStr = rawStr.replace(/^วันที่\s*/, '').trim();

    // 3. DD/MM/YYYY or DD/MM/BBBB format with optional time
    // Matches "16/09/2569", "16/9/2569", "16/09/2569 10:15", "16/09/2569, 10:15:00", "16/09/2569 เวลา 10:15 น."
    const slashMatch = cleanStr.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:[,\s]+(?:เวลา\s*)?(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\s*น\.?)?)?$/);
    if (slashMatch) {
      const [, day, month, rawYear, hh, mm, ss] = slashMatch;
      let year = parseInt(rawYear, 10);
      if (year > 2400) year -= 543;
      const d = parseInt(day, 10);
      const m = parseInt(month, 10) - 1;
      const hours = hh !== undefined ? parseInt(hh, 10) : 0;
      const minutes = mm !== undefined ? parseInt(mm, 10) : 0;
      const seconds = ss !== undefined ? parseInt(ss, 10) : 0;
      const parsedDate = new Date(year, m, d, hours, minutes, seconds);
      if (!isNaN(parsedDate.getTime())) return parsedDate;
    }

    // 4. YYYY-MM-DD or BBBB-MM-DD format (ISO style)
    const isoMatch = cleanStr.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.\d+)?)?(?:Z|[\+\-]\d{2}:?\d{2})?)?$/);
    if (isoMatch) {
      let year = parseInt(isoMatch[1], 10);
      if (year > 2400) {
        year -= 543;
        const d = parseInt(isoMatch[3], 10);
        const m = parseInt(isoMatch[2], 10) - 1;
        const hours = isoMatch[4] !== undefined ? parseInt(isoMatch[4], 10) : 0;
        const minutes = isoMatch[5] !== undefined ? parseInt(isoMatch[5], 10) : 0;
        const seconds = isoMatch[6] !== undefined ? parseInt(isoMatch[6], 10) : 0;
        const parsedDate = new Date(year, m, d, hours, minutes, seconds);
        if (!isNaN(parsedDate.getTime())) return parsedDate;
      }
    }

    // 5. Standard ISO / Date constructor parsing
    const standardDate = new Date(cleanStr);
    if (!isNaN(standardDate.getTime())) {
      return standardDate;
    }
  } catch (_e) {
    // Return fallback on any parsing exception
  }

  return safeFallback;
}

/**
 * Format a Date, ISO timestamp, or string into Thai format:
 * "DD/MM/BBBB เวลา HH:mm น." (or "DD/MM/BBBB" if date-only)
 * Handles Buddhist Era years (> 2400) converting down to Christian Era (e.g. 2569 -> 2026).
 * Strictly bound to Asia/Bangkok (UTC+7).
 * Guarantees NEVER returning "Invalid Date".
 *
 * @param {Date|string|number|null|undefined} dt
 * @returns {string} Formatted Thai date/time string, or "..... / ..... / ........." if empty/invalid
 */
export function formatThaiDateTime(dt) {
  if (dt === null || dt === undefined || dt === '' || dt === '-') {
    return '..... / ..... / .........';
  }

  try {
    const str = String(dt).trim();
    if (!str || str === '-' || str.toLowerCase() === 'invalid date') {
      return '..... / ..... / .........';
    }

    const cleanStr = str.replace(/^วันที่\s*/, '').trim();

    // 1. If it's a date-only Thai format string like "DD/MM/YYYY" or "DD/MM/BBBB" without time:
    const dateOnlyMatch = cleanStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (dateOnlyMatch) {
      const [, day, month, rawYear] = dateOnlyMatch;
      let year = Number(rawYear);
      if (year < 2400) year += 543;
      return `${String(Number(day)).padStart(2, '0')}/${String(Number(month)).padStart(2, '0')}/${year}`;
    }

    // 2. If it's a Thai string with time e.g. "12/09/2569 เวลา 10:15 น." or "12/09/2026 10:15"
    const thaiWithTimeMatch = cleanStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(?:เวลา\s*)?(\d{1,2}):(\d{1,2})(?::\d{1,2})?(?:\s*น\.)?)?$/);
    if (thaiWithTimeMatch && thaiWithTimeMatch[4] !== undefined) {
      const [, day, month, rawYear, hh, mm] = thaiWithTimeMatch;
      let year = Number(rawYear);
      if (year < 2400) year += 543;
      const dd = String(Number(day)).padStart(2, '0');
      const mmStr = String(Number(month)).padStart(2, '0');
      const hhStr = String(Number(hh)).padStart(2, '0');
      const minStr = String(Number(mm)).padStart(2, '0');
      return `${dd}/${mmStr}/${year} ${hhStr}:${minStr} น.`;
    }

    // 3. Parse with parseSafeDate and format with Intl strictly in Asia/Bangkok
    const d = parseSafeDate(cleanStr, null);
    if (d && !isNaN(d.getTime())) {
      const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });

      const parts = formatter.formatToParts(d);
      const partMap = {};
      for (const p of parts) {
        partMap[p.type] = p.value;
      }

      let year = Number(partMap.year);
      if (year < 2400) year += 543;

      const day = String(partMap.day).padStart(2, '0');
      const month = String(partMap.month).padStart(2, '0');
      const hours = String(partMap.hour).padStart(2, '0');
      const minutes = String(partMap.minute).padStart(2, '0');

      return `${day}/${month}/${year} ${hours}:${minutes} น.`;
    }

    return '..... / ..... / .........';
  } catch (_err) {
    return '..... / ..... / .........';
  }
}

/**
 * Format document date/time with authoritative "วันที่ " prefix.
 * e.g. "วันที่ 12/09/2569 เวลา 10:15 น." or "วันที่ ..... / ..... / ........."
 *
 * @param {Date|string|number|null|undefined} dt
 * @returns {string}
 */
export function formatDocDateTime(dt) {
  if (!dt || dt === '-') return 'วันที่ ..... / ..... / .........';
  const formatted = formatThaiDateTime(dt);
  if (formatted === '..... / ..... / .........') return 'วันที่ ..... / ..... / .........';
  return formatted.startsWith('วันที่') ? formatted : `วันที่ ${formatted}`;
}
