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

/**
 * ชื่อแพลตฟอร์มที่รู้จัก (key = ชื่อ label ใน host หรือ platform ที่ normalize แล้ว)
 */
const LINK_PLATFORM_NAMES = {
  shopee: 'Shopee',
  lazada: 'Lazada',
  nocnoc: 'NocNoc',
  jd: 'JD Central',
  jdcentral: 'JD Central',
  amazon: 'Amazon',
  aliexpress: 'AliExpress',
  line: 'LINE Shopping',
  lineshopping: 'LINE Shopping',
  facebook: 'Facebook',
  tiktok: 'TikTok Shop',
  tiktokshop: 'TikTok Shop',
};

const LINK_HOST_KEYS = ['shopee', 'lazada', 'nocnoc', 'jd', 'jdcentral', 'amazon', 'aliexpress', 'facebook', 'tiktok'];
const LINK_DANGEROUS_SCHEME_RE = /^(javascript|data|vbscript|file|blob|about):/i;
const LINK_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const LINK_HOST_PORT_RE = /^[a-z0-9.-]+:\d+(?:[/?#]|$)/i;

/**
 * แยก hostname จาก url (ตัด www.) ; คืน '' ถ้า url ว่าง/พัง/ไม่ใช่ http(s)
 *
 * @param {string} url
 * @returns {string}
 */
const parseLinkHost = (url) => {
  let s = url.trim();
  if (!s || LINK_DANGEROUS_SCHEME_RE.test(s)) return '';
  if (!/^https?:\/\//i.test(s)) {
    // มี scheme อื่นที่ไม่ใช่ host:port (เช่น mailto:, ftp:) → ไม่รับ
    if (LINK_SCHEME_RE.test(s) && !LINK_HOST_PORT_RE.test(s)) return '';
    s = `https://${s}`;
  }
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  return parsed.hostname.toLowerCase().replace(/^www\./, '');
};

const LINK_SECOND_LEVEL_LABELS = new Set(['co', 'com', 'or', 'ac', 'go', 'in', 'net', 'org', 'gov', 'edu', 'ne']);

/**
 * โดเมนที่จดทะเบียน : 2 label สุดท้าย หรือ 3 เมื่อเป็น second-level ของ ccTLD (เช่น .co.th, .com.my, .co.jp)
 * ไม่ใช้ public suffix list เต็ม พอสำหรับจับแพลตฟอร์มที่รู้จัก
 *
 * @param {string} host
 * @returns {string}
 */
const registrableDomain = (host) => {
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const take = (tld.length === 2 && LINK_SECOND_LEVEL_LABELS.has(sld)) ? 3 : 2;
  return labels.slice(-take).join('.');
};

/**
 * จับชื่อแพลตฟอร์มจาก host (เทียบจากโดเมนที่จดทะเบียน ไม่ใช่ substring)
 *
 * @param {string} host
 * @returns {string} ชื่อแพลตฟอร์ม หรือ '' ถ้าจับไม่ได้
 */
const platformNameFromHost = (host) => {
  if (host === 'shop.line.me' || host.endsWith('.shop.line.me')) return LINK_PLATFORM_NAMES.line;
  // เทียบจาก "โดเมนที่จดทะเบียน" เท่านั้น (shopee.evil.com -> evil.com ไม่ใช่ Shopee ; m.facebook.com -> facebook.com ใช่)
  const brand = registrableDomain(host).split('.')[0];
  if (LINK_HOST_KEYS.includes(brand)) return LINK_PLATFORM_NAMES[brand];
  return '';
};

/**
 * คืน label และ host สำหรับแสดงลิงก์สินค้า
 * - host = hostname ของ url (ตัด www. ; ถ้าไม่มี protocol จะเติม https:// ก่อน parse)
 * - label = ชื่อแพลตฟอร์มที่รู้จักจาก "โดเมนที่จดทะเบียน" ของ host ; ถ้าไม่ใช่แพลตฟอร์มที่รู้จัก label = host (ไม่ใช้ platform มาขัดกับโดเมนจริง)
 * - url ว่าง/พัง/ไม่ใช่ http(s) → { label: '', host: '' }
 *
 * @param {string} url
 * @param {string} [_platform] ไม่ใช้ตัดสิน label (คงไว้เพื่อ signature เดิม)
 * @returns {{ label: string, host: string }}
 */
export function getLinkLabel(url, _platform) {
  const host = typeof url === 'string' ? parseLinkHost(url) : '';
  if (!host) return { label: '', host: '' };
  // host ที่ไม่ใช่แพลตฟอร์มที่รู้จัก → label = host (ไม่เอา platform ที่ผู้ใช้/ระบบ default มาขัดกับโดเมนจริง)
  const label = platformNameFromHost(host) || host;
  return { label, host };
}
