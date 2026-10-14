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
export function resolveDriveImageUrl(input, size = 'w1200') {
  if (!input) return '';

  // 1. If input is an object
  if (typeof input !== 'string') {
    if (input.directUrl && !input.directUrl.includes('BASE64_')) return input.directUrl;
    if (input.fileId) {
      if (typeof input.fileId === 'string' && (input.fileId.includes('BASE64_') || input.fileId.includes('STORED_IN_DRIVE'))) {
        return '';
      }
      return `https://drive.google.com/thumbnail?id=${input.fileId}&sz=${size}`;
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

  // 2. Base64 or Blob Data URL
  if (str.startsWith('data:image/') || str.startsWith('blob:')) {
    return str;
  }

  // 3. If external HTTP/HTTPS URL and not Google Drive/GoogleUserContent
  const isDriveUrl = str.includes('drive.google.com') || str.includes('googleusercontent.com') || str.includes('docs.google.com');
  if ((str.startsWith('http://') || str.startsWith('https://')) && !isDriveUrl) {
    return str;
  }

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

  return `https://drive.google.com/thumbnail?id=${fileId}&sz=${size}`;
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
export function getDriveFileViewUrl(input) {
  if (!input) return '';

  if (typeof input !== 'string') {
    if (input.viewUrl && !input.viewUrl.includes('BASE64_')) return input.viewUrl;
    if (input.driveUrl && !input.driveUrl.includes('BASE64_')) return input.driveUrl;
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
  if (str.startsWith('http') && str.includes('drive.google.com/file/d/') && str.includes('/view')) {
    return str;
  }

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
