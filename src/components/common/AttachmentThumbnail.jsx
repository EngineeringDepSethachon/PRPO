import React, { useState } from 'react';
import { Paperclip } from 'lucide-react';
import { resolveDriveImageUrl, handleDriveImageError } from '../../utils/driveHelper';
import { pickAttachmentUrl } from '../../utils/attachmentUrls';
import { useProxiedFileUrl } from '../../utils/cfAttachments';

export default function AttachmentThumbnail({ img, imgIdx, onClick, sizeClass = "w-8 h-8", altText, title }) {
  const [hasError, setHasError] = useState(false);
  // a blob: URL from another session is dead -> falls through to fileUrl / url / directUrl
  // cloudflare mode : a Drive file is read through GET /api/files/:id (blob: URL). While it loads nothing is requested from Drive ; if the proxy
  // does not serve it (an old link that is not a project file) the original URL logic below is used. Other modes : state is 'off' = unchanged.
  const proxied = useProxiedFileUrl(img, { imagesOnly: true });
  const src = pickAttachmentUrl(img, ['localUrl', 'previewUrl', 'dataUrl', 'fileUrl', 'url', 'directUrl']);
  const resolvedThumb = proxied.url || (proxied.state === 'loading' ? '' : resolveDriveImageUrl(src, 'w400'));
  const defaultName = (typeof img === 'object' && (img.name || img.fileName)) ? (img.name || img.fileName) : `ไฟล์แนบ ${imgIdx + 1}`;
  const finalAlt = altText || defaultName;
  const finalTitle = title || defaultName;

  // sizeClass ใหญ่ (w-20 ขึ้นไป เช่น การ์ดสินค้า w-24/w-28) : ไอคอน fallback ขยายตาม มุมโค้งใหญ่ขึ้น ไม่ขยาย hover ; ขนาดเล็กเหมือนเดิมทุกประการ
  const isLarge = /(^|\s)(?:[a-z]+:)?w-(?:20|24|28|32|36|40|44|48)(?=\s|$)/.test(sizeClass);

  if (hasError || !resolvedThumb) {
    const isSmall = sizeClass.includes('w-8') || sizeClass.includes('w-7') || sizeClass.includes('w-6');
    return (
      <button
        type="button"
        onClick={onClick}
        title={finalTitle}
        className={`relative ${sizeClass} ${isLarge ? 'rounded-xl' : 'rounded-lg'} border border-slate-200 bg-slate-100 flex flex-col items-center justify-center p-1 hover:bg-slate-200 transition-colors shrink-0 overflow-hidden text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer group/thumb`}
      >
        <Paperclip className={`${isLarge ? 'w-8 h-8' : isSmall ? 'w-3.5 h-3.5' : 'w-4 h-4'} text-slate-400 shrink-0`} />
        {!isSmall && (
          <span className={`${isLarge ? 'text-[10px] mt-1' : 'text-[8px] mt-0.5'} font-mono text-slate-500 truncate max-w-full px-0.5 leading-tight`}>
            {defaultName}
          </span>
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative ${sizeClass} ${isLarge ? 'rounded-xl' : 'rounded-lg'} border border-slate-200 shadow-2xs overflow-hidden bg-slate-100 transition-transform duration-150 ${isLarge ? '' : 'hover:scale-110 hover:z-10'} cursor-pointer shrink-0 focus:outline-none focus:ring-1 focus:ring-indigo-500 group/thumb`}
      title={finalTitle}
    >
      <img
        src={resolvedThumb}
        alt={finalAlt}
        className="w-full h-full object-cover"
        onError={(e) => {
          if (resolvedThumb.startsWith('blob:') || resolvedThumb.startsWith('data:')) {
            setHasError(true);
            return;
          }
          const target = e.currentTarget;
          if (!target.dataset.triedFallback) {
            target.dataset.triedFallback = 'true';
            handleDriveImageError(e, img);
          } else {
            setHasError(true);
          }
        }}
      />
      <div className="absolute inset-0 bg-black/20 opacity-0 group-hover/thumb:opacity-100 transition-opacity flex items-center justify-center text-white text-[10px]">
        🔍
      </div>
    </button>
  );
}
