/**
 * fileUtils.js
 * Client-Side Image Compression & File Utilities
 *
 * Requirements:
 * - HTML Canvas compression before Base64 encoding
 * - Max dimension (width/height) <= 1280px (preserves aspect ratio)
 * - Initial compression quality: 0.70 - 0.75 (default 0.75)
 * - File size reduced to below 150 KB (< 153,600 bytes)
 */

export const MAX_IMAGE_DIMENSION = 1280;
export const DEFAULT_IMAGE_QUALITY = 0.75;
export const MAX_IMAGE_SIZE_BYTES = 150 * 1024; // 150 KB = 153,600 bytes

/**
 * Calculates byte size of a Base64 dataURL or raw Base64 string.
 * @param {string} base64String
 * @returns {number} Byte size
 */
export function getBase64SizeBytes(base64String) {
  if (!base64String || typeof base64String !== 'string') return 0;
  const commaIndex = base64String.indexOf(',');
  const rawBase64 = commaIndex >= 0 ? base64String.slice(commaIndex + 1) : base64String;
  const cleanBase64 = rawBase64.replace(/[\r\n\s]/g, '');
  if (!cleanBase64.length) return 0;
  const padding = cleanBase64.endsWith('==') ? 2 : (cleanBase64.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor((cleanBase64.length * 3) / 4) - padding);
}

/**
 * Format bytes to readable string (e.g. "124 KB", "1.2 MB")
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Check if a file or string is an image
 * @param {File|Blob|string} file
 * @returns {boolean}
 */
export function isImageFile(file) {
  if (!file) return false;
  if (typeof file === 'string') {
    return file.startsWith('data:image/') || /\.(jpe?g|png|gif|webp|bmp|svg|heic)$/i.test(file);
  }
  return Boolean(
    (file.type && file.type.startsWith('image/')) ||
    /\.(jpe?g|png|gif|webp|bmp|svg|heic)$/i.test(file.name || '')
  );
}

/**
 * Calculate scaled dimensions constrained to maxWidth and maxHeight while preserving aspect ratio.
 * @param {number} width - Original width
 * @param {number} height - Original height
 * @param {number} [maxWidth=1280] - Maximum allowable width
 * @param {number} [maxHeight=1280] - Maximum allowable height
 * @returns {{ width: number, height: number }}
 */
export function calculateScaledDimensions(width, height, maxWidth = MAX_IMAGE_DIMENSION, maxHeight = MAX_IMAGE_DIMENSION) {
  if (!width || !height) return { width: maxWidth, height: maxHeight };
  if (width <= maxWidth && height <= maxHeight) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const ratio = Math.min(maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio))
  };
}

/**
 * Helper to load an image element from File, Blob, or DataURL string
 * @param {File|Blob|string} source
 * @returns {Promise<HTMLImageElement>}
 */
function loadImageElement(source) {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      return reject(new Error('Image constructor not available'));
    }
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(new Error('Failed to load image: ' + (err?.message || 'invalid image data')));

    if (typeof source === 'string') {
      img.src = source;
    } else if (source instanceof Blob || (typeof File !== 'undefined' && source instanceof File)) {
      if (typeof URL !== 'undefined' && URL.createObjectURL) {
        let objectUrl = '';
        try {
          objectUrl = URL.createObjectURL(source);
          img.onload = () => {
            try { URL.revokeObjectURL(objectUrl); } catch (_) {}
            resolve(img);
          };
          img.onerror = () => {
            try { URL.revokeObjectURL(objectUrl); } catch (_) {}
            // Fallback to FileReader
            readViaFileReader(source, img, resolve, reject);
          };
          img.src = objectUrl;
        } catch (_) {
          readViaFileReader(source, img, resolve, reject);
        }
      } else {
        readViaFileReader(source, img, resolve, reject);
      }
    } else {
      reject(new Error('Unsupported image source type'));
    }
  });
}

function readViaFileReader(source, img, resolve, reject) {
  if (typeof FileReader === 'undefined') {
    return reject(new Error('FileReader not available'));
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    img.onload = () => resolve(img);
    img.onerror = (err) => reject(new Error('FileReader image load failed: ' + (err?.message || '')));
    img.src = e.target.result;
  };
  reader.onerror = reject;
  reader.readAsDataURL(source);
}

/**
 * Compresses an image (File, Blob, or base64 DataURL) using HTML Canvas.
 *
 * @param {File|Blob|string} source - Source image
 * @param {Object} [options]
 * @param {number} [options.maxWidth=1280] - Max width
 * @param {number} [options.maxHeight=1280] - Max height
 * @param {number} [options.quality=0.75] - Initial JPEG quality (0.7 - 0.75)
 * @param {number} [options.maxSizeBytes=153600] - Target max size (150 KB)
 * @param {string} [options.mimeType='image/jpeg'] - Target format
 * @returns {Promise<{ dataUrl: string, previewUrl: string, size: number, width: number, height: number, quality: number, originalSize: number, mimeType: string }>}
 */
export async function compressImage(source, options = {}) {
  const maxWidth = options.maxWidth || MAX_IMAGE_DIMENSION;
  const maxHeight = options.maxHeight || MAX_IMAGE_DIMENSION;
  const initialQuality = typeof options.quality === 'number' ? options.quality : DEFAULT_IMAGE_QUALITY;
  const maxSizeBytes = options.maxSizeBytes || MAX_IMAGE_SIZE_BYTES;
  const mimeType = options.mimeType || 'image/jpeg';

  const origSize = typeof source === 'string' ? getBase64SizeBytes(source) : (source?.size || 0);

  // Check if Canvas & DOM are available in the current environment
  const hasCanvasSupport = typeof document !== 'undefined' && typeof document.createElement === 'function';

  if (!hasCanvasSupport) {
    // Graceful fallback for non-browser/test environments without Canvas API
    let fallbackDataUrl = '';
    if (typeof source === 'string') {
      fallbackDataUrl = source;
    } else if (typeof FileReader !== 'undefined' && (source instanceof Blob || (typeof File !== 'undefined' && source instanceof File))) {
      fallbackDataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(source);
      });
    }
    const finalSize = origSize || getBase64SizeBytes(fallbackDataUrl);
    return {
      dataUrl: fallbackDataUrl,
      previewUrl: fallbackDataUrl,
      size: finalSize,
      width: maxWidth,
      height: maxHeight,
      quality: initialQuality,
      originalSize: origSize,
      mimeType
    };
  }

  // 1. Load image
  const img = await loadImageElement(source);
  const naturalWidth = img.naturalWidth || img.width || maxWidth;
  const naturalHeight = img.naturalHeight || img.height || maxHeight;

  // 2. Compute scaled dimensions (Max 1280px)
  let { width: curWidth, height: curHeight } = calculateScaledDimensions(naturalWidth, naturalHeight, maxWidth, maxHeight);

  // 3. Create Canvas and draw image
  const canvas = document.createElement('canvas');
  canvas.width = curWidth;
  canvas.height = curHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context could not be created');
  }

  // Fill canvas with white background (handles transparent PNG cleanly when converting to JPEG)
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, curWidth, curHeight);

  // High quality interpolation
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, curWidth, curHeight);

  // 4. Initial export with quality 0.70 - 0.75
  let curQuality = Math.min(0.75, Math.max(0.70, initialQuality));
  let dataUrl = canvas.toDataURL(mimeType, curQuality);
  let curSize = getBase64SizeBytes(dataUrl);

  // 5. If size > 150 KB, iteratively decrease quality and/or scale down dimensions
  let iteration = 0;
  const MAX_ITERATIONS = 8;
  const MIN_QUALITY = 0.35;

  while (curSize > maxSizeBytes && iteration < MAX_ITERATIONS) {
    iteration++;

    if (curQuality > MIN_QUALITY) {
      // Step quality down (e.g. 0.75 -> 0.65 -> 0.55 -> 0.45 -> 0.35)
      curQuality = Math.max(MIN_QUALITY, parseFloat((curQuality - 0.10).toFixed(2)));
      dataUrl = canvas.toDataURL(mimeType, curQuality);
      curSize = getBase64SizeBytes(dataUrl);
    } else {
      // Scale down canvas dimensions by 15% and redraw
      curWidth = Math.max(100, Math.round(curWidth * 0.85));
      curHeight = Math.max(100, Math.round(curHeight * 0.85));
      canvas.width = curWidth;
      canvas.height = curHeight;

      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, curWidth, curHeight);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, curWidth, curHeight);

      dataUrl = canvas.toDataURL(mimeType, curQuality);
      curSize = getBase64SizeBytes(dataUrl);
    }
  }

  return {
    dataUrl,
    previewUrl: dataUrl,
    size: curSize,
    width: curWidth,
    height: curHeight,
    quality: curQuality,
    originalSize: origSize,
    mimeType
  };
}

/**
 * Compress a single File object and return a metadata-rich object.
 *
 * @param {File} file
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
export async function compressImageFile(file, options = {}) {
  if (!isImageFile(file)) {
    return {
      file,
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      previewUrl: '',
      url: '',
      isImage: false,
      isCompressed: false
    };
  }

  const result = await compressImage(file, options);
  return {
    file,
    name: file.name,
    size: result.size,
    type: result.mimeType || 'image/jpeg',
    previewUrl: result.dataUrl,
    url: result.dataUrl,
    dataUrl: result.dataUrl,
    width: result.width,
    height: result.height,
    originalSize: file.size,
    isImage: true,
    isCompressed: true
  };
}
