/**
 * Sanitizes an external URL to ensure it has a valid web protocol (http/https)
 * preventing relative URL resolution (e.g. localhost:5173/...)
 * 
 * @param {string} url 
 * @returns {string}
 */
export const sanitizeExternalUrl = (url) => {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
};

/**
 * Extracts raw product URL from item object using standard fallback chain
 * 
 * @param {Object} item 
 * @returns {string}
 */
export const getProductUrl = (item) => {
  if (!item || typeof item !== 'object') return '';
  const rawUrl = item.productUrl || item.link || item.url || item.itemUrl || item.onlineUrl;
  return typeof rawUrl === 'string' ? rawUrl.trim() : '';
};
