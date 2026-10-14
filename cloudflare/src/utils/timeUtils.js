/**
 * Time and Date Utilities for Thailand Timezone (Asia/Bangkok: UTC+7)
 */

/**
 * Format timestamp strictly in Thailand time (Asia/Bangkok UTC+7)
 * Output format: YYYY-MM-DD HH:mm:ss
 * 
 * @param {Date|string|number} date
 * @returns {string} Formatted timestamp string e.g. "2026-09-14 14:03:00"
 */
/**
 * For raw display of server times : an ISO string (e.g. "2026-10-13T01:00:00.000Z") -> "YYYY-MM-DD HH:mm:ss" Thai time.
 * Anything else (already formatted, "13/10/2569 14:03:00", empty) is returned unchanged.
 */
export const formatIsoForDisplay = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value.trim())) return value;
  return formatLocalTimestamp(value.trim());
};

export const formatLocalTimestamp =(date = new Date()) => {
  if (!date) return '';
  // If already in YYYY-MM-DD HH:mm:ss format, return as is to prevent double shifting
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date.trim())) {
    return date.trim();
  }
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return String(date);
  // ใช้ locale 'sv-SE' ร่วมกับ timeZone 'Asia/Bangkok' เพื่อให้ได้รูปแบบ YYYY-MM-DD HH:mm:ss เวลาไทย
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(d).replace('T', ' ');
};
