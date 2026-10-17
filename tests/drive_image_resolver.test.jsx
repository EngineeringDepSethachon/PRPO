import { describe, it, expect, vi } from 'vitest';
import { 
  resolveDriveImageUrl, 
  getDriveLh3Url, 
  getDriveFileViewUrl, 
  handleDriveImageError 
} from '../src/utils/driveHelper';
import { 
  resolveDriveImageUrl as formattersResolveDriveImageUrl,
  getDriveLh3Url as formattersGetDriveLh3Url,
  getDriveFileViewUrl as formattersGetDriveFileViewUrl,
  handleDriveImageError as formattersHandleDriveImageError
} from '../src/utils/formatters';
import { 
  driveService, 
  resolveDriveImageUrl as driveServiceResolve,
  getDriveLh3Url as driveServiceLh3,
  getDriveFileViewUrl as driveServiceViewUrl,
  handleDriveImageError as driveServiceHandleError
} from '../src/services/driveService';

describe('Google Drive Image Resolver & Helper Functions', () => {
  const sampleFileId = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OIvE2up00';
  const sampleDriveViewUrl = `https://drive.google.com/file/d/${sampleFileId}/view?usp=sharing`;
  const sampleDriveOpenUrl = `https://drive.google.com/open?id=${sampleFileId}`;
  const sampleDriveLh3Url = `https://lh3.googleusercontent.com/d/${sampleFileId}`;

  describe('resolveDriveImageUrl', () => {
    it('returns empty string for empty, null, or undefined inputs', () => {
      expect(resolveDriveImageUrl(null)).toBe('');
      expect(resolveDriveImageUrl(undefined)).toBe('');
      expect(resolveDriveImageUrl('')).toBe('');
      expect(resolveDriveImageUrl('   ')).toBe('');
    });

    it('preserves native Base64 Data URLs and Blob URLs as-is', () => {
      const base64Str = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
      expect(resolveDriveImageUrl(base64Str)).toBe(base64Str);

      const blobStr = 'blob:http://localhost:5173/3d0fbdf3-a1f9-4d6b-b46f-2b28cf9db039';
      expect(resolveDriveImageUrl(blobStr)).toBe(blobStr);
    });

    it('handles image objects with directUrl, fileId, or nested url properties', () => {
      const directObj = {
        fileId: sampleFileId,
        directUrl: `https://drive.google.com/thumbnail?id=${sampleFileId}&sz=w1200`
      };
      expect(resolveDriveImageUrl(directObj)).toBe(`https://drive.google.com/thumbnail?id=${sampleFileId}&sz=w1200`);

      const fileIdObj = { fileId: sampleFileId };
      expect(resolveDriveImageUrl(fileIdObj)).toBe(`https://drive.google.com/thumbnail?id=${sampleFileId}&sz=w1200`);
      expect(resolveDriveImageUrl(fileIdObj, 'w400')).toBe(`https://drive.google.com/thumbnail?id=${sampleFileId}&sz=w400`);

      const urlObj = { url: sampleDriveViewUrl };
      expect(resolveDriveImageUrl(urlObj, 'w800')).toBe(`https://drive.google.com/thumbnail?id=${sampleFileId}&sz=w800`);

      const previewObj = { previewUrl: sampleDriveOpenUrl };
      expect(resolveDriveImageUrl(previewObj)).toBe(`https://drive.google.com/thumbnail?id=${sampleFileId}&sz=w1200`);

      const fileUrlObj = { fileUrl: sampleDriveViewUrl };
      expect(resolveDriveImageUrl(fileUrlObj)).toBe(`https://drive.google.com/thumbnail?id=${sampleFileId}&sz=w1200`);
    });

    it('resolves various Google Drive URL patterns to CDN thumbnail direct URLs', () => {
      // /file/d/ID/view format
      expect(resolveDriveImageUrl(sampleDriveViewUrl))
        .toBe(`https://drive.google.com/thumbnail?id=${sampleFileId}&sz=w1200`);

      // ?id=ID format
      expect(resolveDriveImageUrl(sampleDriveOpenUrl))
        .toBe(`https://drive.google.com/thumbnail?id=${sampleFileId}&sz=w1200`);

      // googleusercontent.com format
      expect(resolveDriveImageUrl(sampleDriveLh3Url, 'w1600'))
        .toBe(`https://drive.google.com/thumbnail?id=${sampleFileId}&sz=w1600`);

      // Pure raw File ID string
      expect(resolveDriveImageUrl(sampleFileId, 'w400'))
        .toBe(`https://drive.google.com/thumbnail?id=${sampleFileId}&sz=w400`);
    });

    it('rejects mock or placeholder strings containing BASE64_ or STORED_IN_DRIVE', () => {
      const dummyPlaceholder = 'BASE64_ATTACHMENT_STORED_IN_DRIVE';
      const bracketDummy = '[BASE64_ATTACHMENT_STORED_IN_DRIVE]';
      const inlineDummy = '[INLINE_BASE64_STORED_IN_DRIVE]';

      expect(resolveDriveImageUrl(dummyPlaceholder)).toBe('');
      expect(resolveDriveImageUrl(bracketDummy)).toBe('');
      expect(resolveDriveImageUrl(inlineDummy)).toBe('');
      expect(resolveDriveImageUrl({ fileId: dummyPlaceholder })).toBe('');
      expect(resolveDriveImageUrl({ url: dummyPlaceholder })).toBe('');
      expect(resolveDriveImageUrl({ directUrl: bracketDummy })).toBe('');
    });

    it('keeps external non-Google Drive HTTP URLs untouched', () => {
      const extUrl = 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809';
      expect(resolveDriveImageUrl(extUrl)).toBe(extUrl);
    });

    it('keeps the R2 proxy file path (exact shape) untouched', () => {
      const proxyPath = '/api/files/3f2a9c1e-7b4d-4e8a-9c1f-0123456789ab';
      expect(resolveDriveImageUrl(proxyPath)).toBe(proxyPath);
      expect(resolveDriveImageUrl({ url: proxyPath })).toBe(proxyPath);
    });
  });

  describe('getDriveLh3Url', () => {
    it('returns empty string for empty inputs', () => {
      expect(getDriveLh3Url(null)).toBe('');
      expect(getDriveLh3Url('')).toBe('');
    });

    it('generates lh3.googleusercontent.com fallback URLs', () => {
      expect(getDriveLh3Url(sampleDriveViewUrl)).toBe(`https://lh3.googleusercontent.com/d/${sampleFileId}`);
      expect(getDriveLh3Url(sampleFileId)).toBe(`https://lh3.googleusercontent.com/d/${sampleFileId}`);
      expect(getDriveLh3Url({ fileId: sampleFileId })).toBe(`https://lh3.googleusercontent.com/d/${sampleFileId}`);
      expect(getDriveLh3Url({ lh3Url: sampleDriveLh3Url })).toBe(sampleDriveLh3Url);
    });

    it('rejects placeholder strings containing BASE64_ or STORED_IN_DRIVE', () => {
      expect(getDriveLh3Url('BASE64_ATTACHMENT_STORED_IN_DRIVE')).toBe('');
      expect(getDriveLh3Url('[BASE64_ATTACHMENT_STORED_IN_DRIVE]')).toBe('');
      expect(getDriveLh3Url({ fileId: 'BASE64_ATTACHMENT_STORED_IN_DRIVE' })).toBe('');
    });
  });

  describe('getDriveFileViewUrl', () => {
    it('returns empty string for empty or non-drive inputs', () => {
      expect(getDriveFileViewUrl(null)).toBe('');
      expect(getDriveFileViewUrl('')).toBe('');
      expect(getDriveFileViewUrl('https://example.com/other')).toBe('');
      expect(getDriveFileViewUrl('data:image/png;base64,1234')).toBe('');
      expect(getDriveFileViewUrl('BASE64_ATTACHMENT_STORED_IN_DRIVE')).toBe('');
      expect(getDriveFileViewUrl('[BASE64_ATTACHMENT_STORED_IN_DRIVE]')).toBe('');
      expect(getDriveFileViewUrl({ fileId: 'BASE64_ATTACHMENT_STORED_IN_DRIVE' })).toBe('');
    });

    it('returns the standard Google Drive preview/view URL', () => {
      expect(getDriveFileViewUrl(sampleDriveViewUrl)).toBe(sampleDriveViewUrl);
      expect(getDriveFileViewUrl(sampleDriveOpenUrl)).toBe(`https://drive.google.com/file/d/${sampleFileId}/view`);
      expect(getDriveFileViewUrl(sampleFileId)).toBe(`https://drive.google.com/file/d/${sampleFileId}/view`);
      expect(getDriveFileViewUrl({ fileId: sampleFileId })).toBe(`https://drive.google.com/file/d/${sampleFileId}/view`);
      expect(getDriveFileViewUrl({ viewUrl: sampleDriveViewUrl })).toBe(sampleDriveViewUrl);
    });
  });

  describe('handleDriveImageError', () => {
    it('sets target.src to lh3 fallback on error event', () => {
      const target = { src: `https://drive.google.com/thumbnail?id=${sampleFileId}&sz=w1200` };
      const event = { currentTarget: target };

      handleDriveImageError(event, sampleFileId);
      expect(target.src).toBe(`https://lh3.googleusercontent.com/d/${sampleFileId}`);
    });

    it('gracefully handles missing or invalid event parameters', () => {
      expect(() => handleDriveImageError(null, sampleFileId)).not.toThrow();
      expect(() => handleDriveImageError({}, sampleFileId)).not.toThrow();
    });
  });

  describe('Integration & Seamless Re-exports', () => {
    it('re-exports functions identically in formatters.js and driveService.js', () => {
      expect(formattersResolveDriveImageUrl).toBe(resolveDriveImageUrl);
      expect(formattersGetDriveLh3Url).toBe(getDriveLh3Url);
      expect(formattersGetDriveFileViewUrl).toBe(getDriveFileViewUrl);
      expect(formattersHandleDriveImageError).toBe(handleDriveImageError);

      expect(driveServiceResolve).toBe(resolveDriveImageUrl);
      expect(driveServiceLh3).toBe(getDriveLh3Url);
      expect(driveServiceViewUrl).toBe(getDriveFileViewUrl);
      expect(driveServiceHandleError).toBe(handleDriveImageError);

      expect(driveService.resolveDriveImageUrl).toBe(resolveDriveImageUrl);
      expect(driveService.getDriveLh3Url).toBe(getDriveLh3Url);
      expect(driveService.getDriveFileViewUrl).toBe(getDriveFileViewUrl);
      expect(driveService.handleDriveImageError).toBe(handleDriveImageError);
    });

    it('exposes makeAllDriveFilesPublic migration function on driveService', async () => {
      expect(typeof driveService.makeAllDriveFilesPublic).toBe('function');
      const res = await driveService.makeAllDriveFilesPublic();
      expect(res).toBeDefined();
      expect(res.success).toBe(true);
    });
  });
});
