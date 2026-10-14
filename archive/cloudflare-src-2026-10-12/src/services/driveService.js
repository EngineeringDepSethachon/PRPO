/**
 * Document Routing & Upload Service
 * 
 * Manages automated routing and file uploads into structured ERP categories:
 * - 01_PR_Attachments/{YYYY-MM}/
 * - 02_PO_Documents/{YYYY-MM}/
 * - 03_GRN_Evidence/{YYYY-MM}/{PO_NUMBER}/
 * - 04_Claim_Evidence/{YYYY-MM}/{PO_NUMBER}/
 * 
 * Dual-Mode Client Adapter:
 * - In Google Apps Script mode (isGAS): delegates to `callGAS('apiUploadFile', payload)`
 * - In Local Dev: uploads to Express backend (/api/upload) with local storage & Base64 fallback.
 */

import { isGAS, callGAS } from './storageService.js';

export const DRIVE_ROOT_FOLDER = '[ERP] PR-PO-Stock-System';

export const DRIVE_CATEGORIES = {
  PR: '01_PR_Attachments',
  PO: '02_PO_Documents',
  GRN: '03_GRN_Evidence',
  CLAIM: '04_Claim_Evidence'
};

/**
 * Normalizes category code to canonical folder segment name
 */
export const normalizeCategory = (category = '') => {
  const cat = String(category).toUpperCase().trim();
  if (cat.startsWith('01') || cat.includes('PR')) return DRIVE_CATEGORIES.PR;
  if (cat.startsWith('02') || cat.includes('PO')) return DRIVE_CATEGORIES.PO;
  if (cat.startsWith('03') || cat.includes('GRN') || cat.includes('RECEIV')) return DRIVE_CATEGORIES.GRN;
  if (cat.startsWith('04') || cat.includes('CLAIM') || cat.includes('DISPUTE')) return DRIVE_CATEGORIES.CLAIM;
  return DRIVE_CATEGORIES.PR;
};

/**
 * Resolves the structured folder hierarchy path string
 * 
 * @param {string} category 'PR' | 'PO' | 'GRN' | 'CLAIM'
 * @param {string} [poNumber] Optional PO number for GRN and Claim evidence
 * @param {Date|string} [date] Optional date for YYYY-MM stamping
 * @returns {string} Fully qualified folder path
 */
export const resolveDriveFolderPath = (category, poNumber = '', date = new Date()) => {
  const d = date instanceof Date ? date : new Date(date);
  const yearMonth = !isNaN(d.getTime()) 
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    : new Date().toISOString().slice(0, 7);

  const folderCategory = normalizeCategory(category);
  const cleanPo = String(poNumber || '').trim();

  if (cleanPo && (folderCategory === DRIVE_CATEGORIES.GRN || folderCategory === DRIVE_CATEGORIES.CLAIM)) {
    return `${DRIVE_ROOT_FOLDER}/${folderCategory}/${yearMonth}/${cleanPo}`;
  }

  return `${DRIVE_ROOT_FOLDER}/${folderCategory}/${yearMonth}`;
};

/**
 * Extracts Google Drive file ID from various Drive URL formats or raw ID string.
 * Supports:
 * - https://drive.google.com/file/d/{id}/view...
 * - https://drive.google.com/open?id={id}
 * - https://drive.google.com/uc?id={id}
 * - https://drive.google.com/thumbnail?id={id}
 * - https://lh3.googleusercontent.com/d/{id}
 * 
 * @param {string} urlOrId
 * @returns {string|null} Google Drive File ID or null
 */
export const extractDriveFileId = (urlOrId = '') => {
  if (!urlOrId || typeof urlOrId !== 'string') return null;
  const str = urlOrId.trim();

  // Pattern 1: /file/d/{id}
  const fileDMatch = str.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/);
  if (fileDMatch) return fileDMatch[1];

  // Pattern 2: id={id}
  const idParamMatch = str.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (idParamMatch) return idParamMatch[1];

  // Pattern 3: googleusercontent.com/d/{id}
  const lh3Match = str.match(/googleusercontent\.com\/d\/([a-zA-Z0-9_-]{20,})/);
  if (lh3Match) return lh3Match[1];

  // Pattern 4: Bare Drive file ID (25-50 chars, no slashes or protocols)
  if (!str.includes('/') && !str.includes(':') && /^[a-zA-Z0-9_-]{25,50}$/.test(str)) {
    return str;
  }

  return null;
};

/**
 * Checks if a given string represents a Google Drive file or URL
 * 
 * @param {string} urlOrId
 * @returns {boolean}
 */
export const isDriveUrl = (urlOrId = '') => {
  if (!urlOrId || typeof urlOrId !== 'string') return false;
  return Boolean(
    urlOrId.includes('drive.google.com') ||
    urlOrId.includes('googleusercontent.com') ||
    extractDriveFileId(urlOrId)
  );
};

/**
 * Generates an optimized Google Drive display or preview URL
 * 
 * @param {string} urlOrId Drive URL or File ID
 * @param {Object} [options]
 * @param {'image'|'pdf'|'preview'|'download'} [options.type='image'] Target embed type
 * @param {string} [options.size='w1600'] Thumbnail resolution size
 * @returns {string} Direct embeddable URL
 */
export const getDriveDisplayUrl = (urlOrId, { type = 'image', size = 'w1600' } = {}) => {
  if (!urlOrId) return '';
  const fileId = extractDriveFileId(urlOrId);
  if (!fileId) return urlOrId;

  if (type === 'pdf' || type === 'preview') {
    return `https://drive.google.com/file/d/${fileId}/preview`;
  }
  if (type === 'download') {
    return `https://drive.google.com/uc?export=download&id=${fileId}`;
  }
  // High-res direct image thumbnail URL
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=${size}`;
};

export const getDrivePreviewUrl = (urlOrId) => getDriveDisplayUrl(urlOrId, { type: 'preview' });
export const getDriveDownloadUrl = (urlOrId) => getDriveDisplayUrl(urlOrId, { type: 'download' });
export const getDriveThumbnailUrl = (urlOrId, size = 'w1600') => getDriveDisplayUrl(urlOrId, { type: 'image', size });

/**
 * Converts a browser File or Blob to a clean Base64 string
 * Strips data URI header (e.g. data:image/png;base64,) if present
 * 
 * @param {File|Blob} file 
 * @returns {Promise<{ base64Data: string, mimeType: string, fileName: string, size: number }>}
 */
export const fileToBase64 = (file) => {
  return new Promise((resolve, reject) => {
    if (!file) {
      return reject(new Error('No file provided for Base64 conversion'));
    }

    const isImage = file.type.startsWith('image/') && !file.type.includes('svg');
    const reader = new FileReader();
    
    reader.onload = (e) => {
      if (isImage) {
        const img = new Image();
        img.onload = () => {
          const MAX_WIDTH = 1200;
          const MAX_HEIGHT = 1200;
          let width = img.width;
          let height = img.height;

          if (width > height) {
            if (width > MAX_WIDTH) {
              height = Math.round((height *= MAX_WIDTH / width));
              width = MAX_WIDTH;
            }
          } else {
            if (height > MAX_HEIGHT) {
              width = Math.round((width *= MAX_HEIGHT / height));
              height = MAX_HEIGHT;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          // Compress to JPEG 70%
          const mimeType = 'image/jpeg';
          const dataUrl = canvas.toDataURL(mimeType, 0.7);
          const pureBase64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
          
          resolve({
            base64Data: pureBase64,
            mimeType: mimeType,
            fileName: file.name ? file.name.replace(/\.[^/.]+$/, "") + ".jpg" : `image_${Date.now()}.jpg`,
            size: Math.round(pureBase64.length * 3 / 4) // Estimate base64 decoded size
          });
        };
        img.onerror = () => reject(new Error('Failed to process image for compression'));
        img.src = e.target.result;
      } else {
        const result = reader.result || '';
        const base64Index = result.indexOf(';base64,');
        let pureBase64 = '';
        let mimeType = file.type || 'application/octet-stream';

        if (base64Index !== -1) {
          pureBase64 = result.substring(base64Index + 8);
          mimeType = result.substring(5, base64Index);
        } else {
          pureBase64 = result.replace(/^data:[^;]+;base64,/, '');
        }

        resolve({
          base64Data: pureBase64,
          mimeType: mimeType || file.type || 'application/octet-stream',
          fileName: file.name || `file_${Date.now()}`,
          size: file.size || 0
        });
      }
    };

    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
};

/**
 * Uploads a document or evidence image via Google Apps Script RPC, Express /api/upload, or Base64 fallback.
 * 
 * @param {Object} options
 * @param {File|Blob} [options.file] Browser file instance
 * @param {string} [options.base64Data] Raw base64 string if already converted
 * @param {string} [options.fileName] File name (e.g. 'damaged_item_1.jpg')
 * @param {string} [options.mimeType] MIME type (e.g. 'image/jpeg')
 * @param {string} options.category 'PR' | 'PO' | 'GRN' | 'CLAIM'
 * @param {string} [options.poNumber] Relevant Purchase Order number
 * @param {string} [options.docNo] Relevant document number
 * @param {string} [options.docType] Document type (e.g. 'RECEIPT_PHOTO', 'INVOICE')
 * @param {string} [options.description] Human-readable description
 * @returns {Promise<{ success: boolean, fileId: string, fileUrl: string, viewUrl?: string, downloadUrl?: string, fileName: string, folderPath: string, uploadedAt: string }>}
 */
export const uploadFileToDrive = async ({
  file,
  base64Data,
  fileName,
  mimeType,
  category = 'PR',
  poNumber = '',
  docNo = '',
  docType = '',
  description = ''
}) => {
  let resolvedBase64 = base64Data || '';
  let resolvedMime = mimeType || 'image/jpeg';
  let resolvedName = fileName || 'attachment.jpg';

  if (file) {
    const converted = await fileToBase64(file);
    resolvedBase64 = converted.base64Data;
    resolvedMime = converted.mimeType;
    resolvedName = converted.fileName;
  }

  if (!resolvedBase64) {
    throw new Error('ไม่พบข้อมูลไฟล์ (Base64 data is empty)');
  }

  const folderPath = resolveDriveFolderPath(category, poNumber);

  const payload = {
    base64Data: resolvedBase64,
    mimeType: resolvedMime,
    fileName: resolvedName,
    category: normalizeCategory(category),
    poNumber: poNumber || '',
    docNo: docNo || poNumber || '',
    docType: docType || category || 'OTHER',
    folderPath,
    description: description || ''
  };

  // 1. Google Apps Script Production Mode
  if (isGAS()) {
    try {
      const gasResult = await callGAS('apiUploadFile', payload);
      const fileId = gasResult?.fileId || `FILE-GAS-${Date.now()}`;
      const viewUrl = gasResult?.viewUrl || `https://drive.google.com/file/d/${fileId}/view`;
      const downloadUrl = gasResult?.downloadUrl || `https://drive.google.com/uc?export=download&id=${fileId}`;
      const previewUrl = getDriveDisplayUrl(fileId, { type: resolvedMime.includes('pdf') ? 'pdf' : 'image' });

      return {
        success: true,
        attachmentId: gasResult?.attachmentId || `ATT-${Date.now()}`,
        fileId,
        fileUrl: previewUrl || viewUrl,
        viewUrl,
        downloadUrl,
        previewUrl,
        fileName: gasResult?.fileName || resolvedName,
        mimeType: gasResult?.mimeType || resolvedMime,
        fileSize: gasResult?.fileSize || 0,
        folderPath: gasResult?.folderPath || folderPath,
        uploadedAt: gasResult?.uploadedAt || new Date().toISOString()
      };
    } catch (gasErr) {
      console.error('[driveService] Google Drive upload via GAS failed:', gasErr.message);
      throw gasErr;
    }
  }

  // 2. Local Dev: Try upload to Express backend
  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      const data = await res.json();
      return {
        success: true,
        fileId: data.fileId || `FILE-${Date.now()}`,
        fileUrl: data.fileUrl || `data:${resolvedMime};base64,${resolvedBase64}`,
        previewUrl: data.fileUrl || `data:${resolvedMime};base64,${resolvedBase64}`,
        fileName: data.fileName || resolvedName,
        mimeType: data.mimeType || resolvedMime,
        folderPath: data.folderPath || folderPath,
        uploadedAt: data.uploadedAt || new Date().toISOString()
      };
    }
  } catch (err) {
    console.warn('[driveService] Backend upload offline, using Base64 fallback:', err.message);
  }

  // 3. Fallback: Base64 data URL stored locally
  const fileId = `FILE-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const dataUrl = `data:${resolvedMime};base64,${resolvedBase64}`;

  return {
    success: true,
    fileId,
    fileUrl: dataUrl,
    previewUrl: dataUrl,
    fileName: resolvedName,
    mimeType: resolvedMime,
    folderPath,
    uploadedAt: new Date().toISOString()
  };
};

export {
  resolveDriveImageUrl,
  getDriveLh3Url,
  getDriveFileViewUrl,
  handleDriveImageError
} from '../utils/driveHelper.js';

import {
  resolveDriveImageUrl,
  getDriveLh3Url,
  getDriveFileViewUrl,
  handleDriveImageError
} from '../utils/driveHelper.js';

export async function makeAllDriveFilesPublic() {
  if (isGAS()) {
    return callGAS('apiMakeAllDriveFilesPublic');
  }
  return { success: true, message: 'Simulated Drive Public Read Migration' };
}

export const driveService = {
  DRIVE_ROOT_FOLDER,
  DRIVE_CATEGORIES,
  normalizeCategory,
  resolveDriveFolderPath,
  extractDriveFileId,
  isDriveUrl,
  getDriveDisplayUrl,
  getDrivePreviewUrl,
  getDriveDownloadUrl,
  getDriveThumbnailUrl,
  resolveDriveImageUrl,
  getDriveLh3Url,
  getDriveFileViewUrl,
  handleDriveImageError,
  fileToBase64,
  uploadFileToDrive,
  makeAllDriveFilesPublic
};

export default driveService;
