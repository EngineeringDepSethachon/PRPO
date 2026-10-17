/**
 * Google Drive Image URL Resolver & Media Helper
 * 
 * Provides robust resolution for Google Drive images, resolving:
 * - Google Drive File ID or URL to high-speed CDN direct thumbnail URL
 * - Fallback to Google UserContent (lh3) CDN
 * - Direct Drive View URLs for opening in new tabs
 * - Native Base64 / Blob URLs support
 */

/**
 * Resolves a Google Drive URL, File ID, or Image Object into a direct CDN image URL.
 * 
 * @param {string|Object} input File ID, Drive URL, Base64 Data URL, or Object with directUrl/fileId
 * @param {string} [size='w1200'] CDN thumbnail resolution size (e.g. 'w400', 'w1200', 'w1600')
 * @returns {string} Direct image URL for <img src="..." />
 */
// path proxy ของไฟล์ที่เก็บใน R2 (เขียน regex เอง ไม่ import cfAttachments เพื่อกัน circular import กับ driveService)
const PROXY_FILE_PATH_RE = /^\/api\/files\/[A-Za-z0-9_-]{10,128}(?:\?download=1)?$/;

export function resolveDriveImageUrl(input, size = 'w1200') {
  if (!input) return '';

  // 1. If input is an object
  if (typeof input !== 'string') {
    if (input.directUrl && !input.directUrl.includes('BASE64_')) return input.directUrl;
    if (input.fileId) {
      if (typeof input.fileId === 'string' && (input.fileId.includes('BASE64_') || input.fileId.includes('STORED_IN_DRIVE'))) {
        return '';
      }
      return `https://drive.google.com/thumbnail?id=${encodeURIComponent(input.fileId)}&sz=${size}`;
    }
    if (input.url && typeof input.url === 'string') return resolveDriveImageUrl(input.url, size);
    if (input.previewUrl && typeof input.previewUrl === 'string') return resolveDriveImageUrl(input.previewUrl, size);
    if (input.fileUrl && typeof input.fileUrl === 'string') return resolveDriveImageUrl(input.fileUrl, size);
    return '';
  }

  const str = input.trim();
  if (!str) return '';

  // Guard against dummy/placeholder strings (e.g. BASE64_ATTACHMENT_STORED_IN_DRIVE)
  if (str.includes('BASE64_') || str.includes('STORED_IN_DRIVE') || str.includes('[BASE64_')) {
    return '';
  }

  // 2. Base64 (raster เท่านั้น : png/jpeg/webp/gif ; svg ไม่รับ) หรือ Blob Data URL
  if (/^data:image\/(png|jpe?g|webp|gif)[;,]/i.test(str) || str.startsWith('blob:')) {
    return str;
  }
  // data: อื่น ๆ และ scheme อื่นที่ไม่ใช่ http(s) (javascript:, file:, ...) ไม่รับ
  if (/^data:/i.test(str)) return '';

  // 3. external HTTP/HTTPS URL ที่ host ไม่ใช่ Google Drive (เช็ก hostname ไม่ใช่ substring) คืนค่าเดิม
  const isHttp = /^https?:\/\//i.test(str);
  if (isHttp && !isDriveHostUrl(str)) {
    return str;
  }
  // path proxy ของไฟล์ R2 (ตรงรูปแบบเป๊ะเท่านั้น) คืนค่าเดิม
  if (PROXY_FILE_PATH_RE.test(str)) return str;
  // path ของเซิร์ฟเวอร์อื่น และ scheme อื่นที่ไม่ใช่ http(s) ไม่รับ (คืน '' = placeholder เดิม)
  if (!isHttp && (str.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(str))) return '';

  // 4. Extract Drive File ID
  // Supports: /file/d/{id}/view, id={id}, googleusercontent.com/d/{id}, and raw 25+ char ID
  const match = str.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/) ||
                str.match(/[?&]id=([a-zA-Z0-9_-]{20,})/) ||
                str.match(/googleusercontent\.com\/d\/([a-zA-Z0-9_-]{20,})/) ||
                str.match(/[-\w]{25,}/);

  const fileId = match ? (match[1] || match[0]) : str;

  // Final Guard against placeholder matching [-\\w]{25,}
  if (!fileId || fileId.includes('BASE64_') || fileId.includes('STORED_IN_DRIVE')) {
    return '';
  }

  return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=${size}`;
}

/**
 * Returns Google UserContent CDN (lh3) URL for secondary fallback
 * 
 * @param {string|Object} input
 * @returns {string} lh3 URL
 */
export function getDriveLh3Url(input) {
  if (!input) return '';

  if (typeof input !== 'string') {
    if (input.lh3Url && !input.lh3Url.includes('BASE64_')) return input.lh3Url;
    if (input.fileId) {
      if (typeof input.fileId === 'string' && (input.fileId.includes('BASE64_') || input.fileId.includes('STORED_IN_DRIVE'))) {
        return '';
      }
      return `https://lh3.googleusercontent.com/d/${input.fileId}`;
    }
    if (input.url && typeof input.url === 'string') return getDriveLh3Url(input.url);
    if (input.previewUrl && typeof input.previewUrl === 'string') return getDriveLh3Url(input.previewUrl);
    if (input.fileUrl && typeof input.fileUrl === 'string') return getDriveLh3Url(input.fileUrl);
    return '';
  }

  const str = input.trim();
  if (!str || str.startsWith('data:image/') || str.startsWith('blob:')) return '';

  // Guard against placeholder strings
  if (str.includes('BASE64_') || str.includes('STORED_IN_DRIVE')) return '';

  const isDriveUrl = str.includes('drive.google.com') || str.includes('googleusercontent.com') || str.includes('docs.google.com');
  const isRawId = !str.startsWith('http://') && !str.startsWith('https://') && str.length >= 20;

  if (!isDriveUrl && !isRawId) {
    return '';
  }

  const match = str.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/) ||
                str.match(/[?&]id=([a-zA-Z0-9_-]{20,})/) ||
                str.match(/googleusercontent\.com\/d\/([a-zA-Z0-9_-]{20,})/) ||
                str.match(/[-\w]{25,}/);

  const fileId = match ? (match[1] || match[0]) : '';
  const cleanId = fileId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleanId || cleanId.includes('BASE64_') || cleanId.includes('STORED_IN_DRIVE')) return '';
  return cleanId.length >= 20 ? `https://lh3.googleusercontent.com/d/${cleanId}` : '';
}

/**
 * Resolves the Google Drive native view URL (for opening in a new tab)
 * 
 * @param {string|Object} input
 * @returns {string} Drive file view URL e.g. https://drive.google.com/file/d/{id}/view
 */
// hostname check (not substring) : "https://evil.test/?u=drive.google.com" is not a Drive URL. Mirrors isDriveUrl of services/driveService.js (kept local : this file has no imports)
const DRIVE_URL_HOSTS = ['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'];
function isDriveHostUrl(value) {
  if (!value || typeof value !== 'string') return false;
  const str = value.trim();
  try {
    const u = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(str) ? str : `https://${str}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    return DRIVE_URL_HOSTS.includes(host) || /^lh[3-6]\.googleusercontent\.com$/.test(host);
  } catch {
    return false;
  }
}

export function getDriveFileViewUrl(input) {
  if (!input) return '';

  if (typeof input !== 'string') {
    // a stored viewUrl / driveUrl is returned only when it really points at Drive ; otherwise fall through to the fileId (or '')
    if (typeof input.viewUrl === 'string' && input.viewUrl && !input.viewUrl.includes('BASE64_') && isDriveHostUrl(input.viewUrl)) return input.viewUrl;
    if (typeof input.driveUrl === 'string' && input.driveUrl && !input.driveUrl.includes('BASE64_') && isDriveHostUrl(input.driveUrl)) return input.driveUrl;
    if (input.fileId) {
      if (typeof input.fileId === 'string' && (input.fileId.includes('BASE64_') || input.fileId.includes('STORED_IN_DRIVE'))) {
        return '';
      }
      return `https://drive.google.com/file/d/${input.fileId}/view`;
    }
    if (input.url && typeof input.url === 'string') return getDriveFileViewUrl(input.url);
    if (input.previewUrl && typeof input.previewUrl === 'string') return getDriveFileViewUrl(input.previewUrl);
    if (input.fileUrl && typeof input.fileUrl === 'string') return getDriveFileViewUrl(input.fileUrl);
    return '';
  }

  const str = input.trim();
  if (!str || str.startsWith('data:image/') || str.startsWith('blob:')) return '';

  // Guard against placeholder strings
  if (str.includes('BASE64_') || str.includes('STORED_IN_DRIVE')) return '';

  // If already a standard Drive view URL
  if (str.startsWith('http') && isDriveHostUrl(str) && new URL(str).hostname.toLowerCase() === 'drive.google.com'
    && /^\/file\/d\/[^/]+\/view/.test(new URL(str).pathname)) {
    return str;
  }

  const isDriveUrl = isDriveHostUrl(str) && (str.startsWith('http://') || str.startsWith('https://') || /^[a-z0-9.-]+\//i.test(str));
  const isRawId = !str.startsWith('http://') && !str.startsWith('https://') && !/[/.:?]/.test(str) && str.length >= 20;

  if (!isDriveUrl && !isRawId) {
    return '';
  }

  const match = str.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/) ||
                str.match(/[?&]id=([a-zA-Z0-9_-]{20,})/) ||
                str.match(/googleusercontent\.com\/d\/([a-zA-Z0-9_-]{20,})/) ||
                str.match(/[-\w]{25,}/);

  const fileId = match ? (match[1] || match[0]) : '';
  const cleanId = fileId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleanId || cleanId.includes('BASE64_') || cleanId.includes('STORED_IN_DRIVE')) return '';
  return cleanId.length >= 20 ? `https://drive.google.com/file/d/${cleanId}/view` : '';
}

/**
 * Error handler for <img onError={...} />
 * Automatically falls back to Google UserContent (lh3) if thumbnail CDN is blocked or unavailable
 * 
 * @param {Event} event React SyntheticEvent on <img>
 * @param {string|Object} input Original image input
 */
export function handleDriveImageError(event, input) {
  if (!event || !event.currentTarget) return;
  const target = event.currentTarget;
  const fallback = getDriveLh3Url(input);

  if (fallback && target.src !== fallback) {
    target.src = fallback;
  }
}
