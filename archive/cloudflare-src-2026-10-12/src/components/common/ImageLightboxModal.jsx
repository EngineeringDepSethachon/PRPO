import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, Download, ExternalLink, Image as ImageIcon } from 'lucide-react';
import { resolveDriveImageUrl, getDriveFileViewUrl, handleDriveImageError } from '../../utils/driveHelper';

/**
 * ImageLightboxModal
 * High-definition Lightbox Preview Modal for viewing product and PR images.
 * Supports multi-image browsing, keyboard navigation (Left/Right/Esc), 
 * thumbnail filmstrip, and responsive centered rendering.
 */
export const resolveImageUrl = (urlOrId) => {
  if (!urlOrId) return '';
  if (urlOrId.startsWith('data:image')) return urlOrId; // Base64
  
  // ดึง Google Drive File ID จาก URL รูปแบบต่างๆ
  const match = urlOrId.match(/\/d\/([a-zA-Z0-9_-]+)/) || 
                urlOrId.match(/id=([a-zA-Z0-9_-]+)/) || 
                [null, urlOrId];
  const fileId = match[1];

  // แปลงเป็น Direct Thumbnail Endpoint ที่รองรับการแสดงผลใน <img>
  if (fileId && !urlOrId.startsWith('http')) {
    return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`;
  }
  if (fileId && urlOrId.includes('drive.google.com')) {
    return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`;
  }
  return urlOrId;
};

export default function ImageLightboxModal({
  isOpen,
  images = [],
  initialIndex = 0,
  title = '',
  onClose
}) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [imageErrors, setImageErrors] = useState({});
  const [base64Urls, setBase64Urls] = useState({});
  const [loadingBase64, setLoadingBase64] = useState({});

  // Sync initialIndex when modal opens or initialIndex changes
  useEffect(() => {
    if (isOpen) {
      setCurrentIndex(Math.max(0, Math.min(initialIndex, (images?.length || 1) - 1)));
    }
  }, [isOpen, initialIndex, images]);

  // Normalize image list into standard objects
  const normalizedImages = useMemoImages(images, title);

  const total = normalizedImages.length;
  const currentImage = normalizedImages[currentIndex] || normalizedImages[0];

  const handlePrev = useCallback(() => {
    if (total <= 1) return;
    setCurrentIndex(prev => (prev - 1 + total) % total);
  }, [total]);

  const handleNext = useCallback(() => {
    if (total <= 1) return;
    setCurrentIndex(prev => (prev + 1) % total);
  }, [total]);

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose?.();
      } else if (e.key === 'ArrowLeft') {
        handlePrev();
      } else if (e.key === 'ArrowRight') {
        handleNext();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handlePrev, handleNext, onClose]);

  if (!isOpen || !currentImage) return null;

  const modalElement = (
    <div
      className="fixed inset-0 z-[200] flex flex-col items-center justify-between p-4 sm:p-6 bg-slate-950/90 backdrop-blur-md animate-fade-in select-none"
      onClick={onClose}
    >
      {/* ── Top Bar ── */}
      <div 
        className="w-full max-w-5xl flex items-center justify-between py-2.5 px-4 rounded-2xl bg-slate-900/80 border border-slate-800/90 text-white shrink-0 z-10"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center text-indigo-400 shrink-0">
            <ImageIcon className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h4 className="text-sm font-bold text-white truncate max-w-sm sm:max-w-md md:max-w-lg" title={currentImage.name || title}>
              {currentImage.name || title || 'รูปภาพตัวอย่าง'}
            </h4>
            {title && currentImage.name && currentImage.name !== title && (
              <p className="text-[11px] text-slate-400 truncate max-w-sm">{title}</p>
            )}
          </div>
        </div>

        {/* Counter & Action Buttons */}
        <div className="flex items-center gap-2.5 shrink-0">
          {total > 1 && (
            <span className="text-xs font-mono font-bold px-2.5 py-1 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
              {currentIndex + 1} / {total}
            </span>
          )}

          {/* ปุ่มเปิดดูใน Google Drive */}
          {currentImage.driveViewUrl && (
            <a
              href={currentImage.driveViewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-xs transition-all hover:scale-105 cursor-pointer"
              title="เปิดดูใน Google Drive"
              onClick={e => e.stopPropagation()}
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">เปิดดูใน Google Drive</span>
              <span className="sm:hidden">Drive</span>
            </a>
          )}

          {currentImage.url && (
            <a
              href={currentImage.url}
              download={currentImage.name || 'image'}
              target="_blank"
              rel="noreferrer"
              className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
              title="ดาวน์โหลดรูปภาพ"
              onClick={e => e.stopPropagation()}
            >
              <Download className="w-4 h-4" />
            </a>
          )}

          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white hover:bg-rose-500/20 hover:text-rose-400 rounded-xl transition-colors cursor-pointer"
            title="ปิด (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* ── Main Image View Container ── */}
      <div 
        className="relative w-full max-w-5xl flex-1 flex items-center justify-center p-2 min-h-0 my-2"
        onClick={e => e.stopPropagation()}
      >
        {/* Left / Previous Button */}
        {total > 1 && (
          <button
            type="button"
            onClick={handlePrev}
            className="absolute left-2 sm:left-4 z-20 p-3 rounded-full bg-slate-900/80 hover:bg-indigo-600 text-white border border-slate-700 shadow-xl transition-all hover:scale-110 cursor-pointer"
            title="รูปก่อนหน้า (ลูกศรซ้าย)"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
        )}

        {/* The Image Itself */}
        <div className="relative max-h-[70vh] max-w-full flex items-center justify-center min-h-[300px] min-w-[300px]">
          {imageErrors[currentIndex] ? (
            <div className="flex flex-col items-center justify-center p-8 bg-slate-900 rounded-2xl shadow-2xl border border-slate-800 text-center space-y-4 min-w-[300px]">
              <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center text-slate-500">
                <ImageIcon className="w-8 h-8 opacity-50" />
              </div>
              <div>
                <p className="text-slate-300 font-medium mb-1">ไม่สามารถโหลดรูปภาพได้</p>
                <p className="text-slate-500 text-sm mb-4">รูปอาจถูกตั้งค่าเป็นส่วนตัวหรือเป็นไฟล์เอกสาร</p>
                {currentImage.driveViewUrl ? (
                  <a
                    href={currentImage.driveViewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                    <span>เปิดดูใน Google Drive</span>
                  </a>
                ) : (
                  <a
                    href={currentImage.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                    <span>เปิดไฟล์แนบต้นฉบับ</span>
                  </a>
                )}
              </div>
            </div>
          ) : (
            <>
              {loadingBase64[currentIndex] && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-900/50 rounded-2xl backdrop-blur-sm">
                  <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                </div>
              )}
              <img
                src={base64Urls[currentIndex] || currentImage.url}
                alt={currentImage.name || 'preview'}
                className={`max-h-[70vh] max-w-full object-contain rounded-2xl shadow-2xl border border-slate-800 bg-slate-900/50 transition-all duration-200 ${loadingBase64[currentIndex] ? 'opacity-50' : 'opacity-100'}`}
                onError={async (e) => {
                  const target = e.currentTarget;
                  
                  // 1. First fallback: Use Google UserContent (lh3)
                  if (!target.dataset.triedFallback) {
                    target.dataset.triedFallback = 'true';
                    const oldSrc = target.src;
                    handleDriveImageError(e, currentImage.raw || currentImage.url);
                    // If src actually changed, return and let browser retry
                    if (target.src !== oldSrc) return;
                  } 
                  
                  // 2. Second fallback: Fetch Base64 data securely via backend
                  if (!target.dataset.triedBase64 && currentImage.fileId && !base64Urls[currentIndex]) {
                    target.dataset.triedBase64 = 'true';
                    setLoadingBase64(prev => ({ ...prev, [currentIndex]: true }));
                    try {
                      const { apiService } = await import('../../services/apiService');
                      const b64 = await apiService.getImageBase64(currentImage.fileId);
                      if (b64 && (b64.startsWith('data:image/') || b64.startsWith('data:application/'))) {
                        setBase64Urls(prev => ({ ...prev, [currentIndex]: b64 }));
                      } else {
                        setImageErrors(prev => ({ ...prev, [currentIndex]: true }));
                      }
                    } catch (err) {
                      console.warn('Base64 fallback failed:', err);
                      setImageErrors(prev => ({ ...prev, [currentIndex]: true }));
                    } finally {
                      setLoadingBase64(prev => ({ ...prev, [currentIndex]: false }));
                    }
                  } 
                  // 3. Complete failure
                  else {
                    setImageErrors(prev => ({ ...prev, [currentIndex]: true }));
                  }
                }}
              />
            </>
          )}
        </div>

        {/* Right / Next Button */}
        {total > 1 && (
          <button
            type="button"
            onClick={handleNext}
            className="absolute right-2 sm:right-4 z-20 p-3 rounded-full bg-slate-900/80 hover:bg-indigo-600 text-white border border-slate-700 shadow-xl transition-all hover:scale-110 cursor-pointer"
            title="รูปถัดไป (ลูกศรขวา)"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        )}
      </div>

      {/* ── Bottom Filmstrip (if multiple images) ── */}
      {total > 1 && (
        <div 
          className="w-full max-w-2xl py-2 px-4 rounded-2xl bg-slate-900/80 border border-slate-800/90 flex items-center justify-center gap-2 overflow-x-auto shrink-0 z-10"
          onClick={e => e.stopPropagation()}
        >
          {normalizedImages.map((img, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => setCurrentIndex(idx)}
              className={`relative w-11 h-11 rounded-xl overflow-hidden border-2 transition-all cursor-pointer shrink-0 ${
                idx === currentIndex
                  ? 'border-indigo-500 ring-2 ring-indigo-500/40 scale-105'
                  : 'border-slate-700 opacity-60 hover:opacity-100 hover:border-slate-500'
              }`}
            >
              <img
                src={img.url}
                alt={img.name || `thumb-${idx}`}
                className="w-full h-full object-cover"
                onError={(e) => handleDriveImageError(e, img.raw || img.url)}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return typeof document !== 'undefined' && document.body
    ? createPortal(modalElement, document.body)
    : modalElement;
}

function useMemoImages(rawImages, defaultTitle) {
  return React.useMemo(() => {
    if (!rawImages) return [];
    const list = Array.isArray(rawImages) ? rawImages : [rawImages];
    return list.map((item, idx) => {
      const rawInput = typeof item === 'string' ? item : (item.previewUrl || item.url || item.dataUrl || item.directUrl || item.fileUrl || item);
      let resolvedUrl = resolveImageUrl(typeof rawInput === 'string' ? rawInput : rawInput?.url || '');
      
      // Fallback if resolveImageUrl didn't produce a full URL
      if (!resolvedUrl || !resolvedUrl.startsWith('http')) {
        resolvedUrl = resolveDriveImageUrl(rawInput, 'w1600');
      }
      
      const candidateUrl = typeof item === 'string' ? item : (item?.localUrl || item?.previewUrl || item?.dataUrl || item?.url || item?.fileUrl || '');
      const isLocal = typeof candidateUrl === 'string' && (candidateUrl.startsWith('blob:') || candidateUrl.startsWith('data:image/'));

      // Extract Google Drive File ID if present
      let fileId = null;
      if (!isLocal) {
        if (typeof item === 'object' && item !== null && item.fileId && typeof item.fileId === 'string' && !item.fileId.includes('BASE64') && !item.fileId.includes('STORED_IN_DRIVE')) {
          fileId = item.fileId;
        } else if (typeof rawInput === 'string') {
          const match = rawInput.match(/\/d\/([a-zA-Z0-9_-]{20,})/) || rawInput.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
          if (match) fileId = match[1];
        } else if (rawInput && typeof rawInput === 'object') {
          if (rawInput.fileId) fileId = rawInput.fileId;
          else if (rawInput.url) {
            const match = String(rawInput.url).match(/\/d\/([a-zA-Z0-9_-]{20,})/) || String(rawInput.url).match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
            if (match) fileId = match[1];
          }
        }
      }

      const driveViewUrl = fileId ? `https://drive.google.com/file/d/${fileId}/view` : getDriveFileViewUrl(rawInput);
      const name = (typeof item === 'object' && (item.name || item.fileName || item.title))
        ? (item.name || item.fileName || item.title)
        : (defaultTitle ? `${defaultTitle} (${idx + 1})` : `รูปที่ ${idx + 1}`);

      return {
        raw: item,
        url: isLocal ? candidateUrl : (resolvedUrl || (typeof item === 'string' ? item : (item.url || item.previewUrl || ''))),
        driveViewUrl,
        fileId,
        isLocal,
        name
      };
    }).filter(it => Boolean(it.url) || Boolean(it.fileId));
  }, [rawImages, defaultTitle]);
}
