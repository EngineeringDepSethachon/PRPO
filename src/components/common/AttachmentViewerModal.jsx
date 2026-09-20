import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ZoomIn, ZoomOut, RotateCw, Download, ExternalLink, FileText, Image as ImageIcon, Globe, ShieldCheck } from 'lucide-react';
import { extractDriveFileId, isDriveUrl, getDriveDisplayUrl } from '../../services/driveService';

export default function AttachmentViewerModal({ file, url, title, onClose }) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);

  if (!file && !url) return null;

  const targetUrl = url || file?.previewUrl || file?.url || file?.dataUrl || file?.fileUrl || '';
  const fileName = title || file?.name || file?.fileName || 'เอกสารแนบ (Attachment)';
  
  const driveId = extractDriveFileId(targetUrl) || (file?.fileId ? extractDriveFileId(file.fileId) : null);
  const isDrive = Boolean(driveId) || isDriveUrl(targetUrl);

  const isPdf = (file?.type === 'application/pdf') || 
                (file?.mimeType === 'application/pdf') ||
                (typeof targetUrl === 'string' && targetUrl.toLowerCase().includes('.pdf')) ||
                (typeof fileName === 'string' && fileName.toLowerCase().endsWith('.pdf'));

  const isOnlineUrl = typeof targetUrl === 'string' && (targetUrl.startsWith('http://') || targetUrl.startsWith('https://'));
  
  const isShoppingStore = isOnlineUrl && !isDrive && (
    targetUrl.includes('shopee') || targetUrl.includes('lazada') || targetUrl.includes('tiktok') || targetUrl.includes('amazon')
  );

  const isImage = (file?.isImage) || 
                  (file?.type?.startsWith('image/')) || 
                  (file?.mimeType?.startsWith('image/')) ||
                  (typeof targetUrl === 'string' && targetUrl.match(/\.(jpeg|jpg|gif|png|webp|svg)($|\?)/i)) || 
                  (!isPdf && !isShoppingStore && (targetUrl.startsWith('blob:') || targetUrl.startsWith('data:image/'))) ||
                  (isDrive && !isPdf);

  // Resolved URLs
  const resolvedImageSrc = isDrive
    ? getDriveDisplayUrl(driveId || targetUrl, { type: 'image', size: 'w1600' })
    : targetUrl;

  const resolvedPdfSrc = isDrive
    ? getDriveDisplayUrl(driveId || targetUrl, { type: 'pdf' })
    : targetUrl;

  const downloadHref = isDrive
    ? getDriveDisplayUrl(driveId || targetUrl, { type: 'download' })
    : targetUrl;

  const handleZoomIn = () => setZoom(prev => Math.min(prev + 0.25, 3));
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 0.25, 0.5));
  const handleRotate = () => setRotation(prev => (prev + 90) % 360);
  const handleReset = () => {
    setZoom(1);
    setRotation(0);
  };

  return createPortal(
    <div 
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6 bg-slate-950/80 backdrop-blur-md animate-fade-in"
      onClick={onClose}
    >
      <div 
        className="bg-slate-900 border border-slate-700/80 rounded-xl shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden text-white animate-scale-up"
        onClick={e => e.stopPropagation()}
      >
        {/* Modal Top Header Bar */}
        <div className="px-6 py-4 bg-slate-800/90 border-b border-slate-700/80 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-10 h-10 rounded-lg bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center text-indigo-400 shrink-0">
              {isImage ? <ImageIcon className="w-5 h-5" /> : isShoppingStore ? <Globe className="w-5 h-5" /> : <FileText className="w-5 h-5" />}
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-bold text-white truncate max-w-md" title={fileName}>
                {fileName}
              </h3>
              <p className="text-xs text-slate-400 mt-0.5 font-medium flex items-center gap-2">
                <span>
                  {isDrive ? 'Google Drive Cloud Storage' : isImage ? 'รูปภาพแนบ (Image)' : isPdf ? 'เอกสาร PDF (Quotation/Doc)' : isShoppingStore ? 'ลิงก์ร้านค้าออนไลน์ (Online Store)' : 'เอกสารประกอบ'}
                </span>
                {file?.size ? <span>• {(file.size / 1024).toFixed(1)} KB</span> : null}
              </p>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-2">
            {isImage && (!isDrive || targetUrl.startsWith('blob:') || targetUrl.startsWith('data:')) && (
              <div className="hidden sm:flex items-center gap-1 bg-slate-700/60 p-1 rounded-lg border border-slate-600">
                <button
                  type="button"
                  onClick={handleZoomOut}
                  className="p-1.5 hover:bg-slate-600 rounded-md transition-colors text-slate-300 hover:text-white"
                  title="ย่อขนาด (Zoom Out)"
                >
                  <ZoomOut className="w-4 h-4" />
                </button>
                <span className="text-xs font-mono px-1 text-slate-300">{Math.round(zoom * 100)}%</span>
                <button
                  type="button"
                  onClick={handleZoomIn}
                  className="p-1.5 hover:bg-slate-600 rounded-md transition-colors text-slate-300 hover:text-white"
                  title="ขยายขนาด (Zoom In)"
                >
                  <ZoomIn className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={handleRotate}
                  className="p-1.5 hover:bg-slate-600 rounded-md transition-colors text-slate-300 hover:text-white ml-1"
                  title="หมุน 90 องศา (Rotate)"
                >
                  <RotateCw className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  className="px-2 py-1 hover:bg-slate-600 rounded-md transition-colors text-[11px] font-semibold text-slate-300 hover:text-white"
                >
                  รีเซ็ต
                </button>
              </div>
            )}

            {targetUrl && (
              <a
                href={downloadHref}
                target="_blank"
                rel="noopener noreferrer"
                download={!isOnlineUrl ? fileName : undefined}
                className="p-2 hover:bg-slate-700 bg-slate-800 border border-slate-600 rounded-lg transition-colors text-slate-300 hover:text-white"
                title={isShoppingStore ? 'เปิดลิงก์ในแท็บใหม่' : 'ดาวน์โหลด / เปิดไฟล์'}
              >
                {isShoppingStore ? <ExternalLink className="w-4.5 h-4.5" /> : <Download className="w-4.5 h-4.5" />}
              </a>
            )}

            <button
              type="button"
              onClick={onClose}
              className="p-2 hover:bg-rose-500/20 hover:text-rose-400 bg-slate-800 border border-slate-600 rounded-lg transition-colors text-slate-400"
              title="ปิดหน้าต่าง (Close)"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Content / Preview Area */}
        <div className="flex-1 overflow-auto p-4 sm:p-6 flex items-center justify-center min-h-[360px] max-h-[calc(92vh-140px)] bg-slate-950/60">
          {isImage ? (
            (isDrive && driveId && !targetUrl.startsWith('blob:') && !targetUrl.startsWith('data:')) ? (
              <div className="w-full h-[64vh] flex flex-col bg-slate-900 rounded-lg border border-slate-700 overflow-hidden shadow-inner">
                <iframe
                  src={`https://drive.google.com/file/d/${driveId}/preview`}
                  title={fileName}
                  className="w-full h-full border-0 rounded-lg bg-slate-900"
                  allow="autoplay"
                />
              </div>
            ) : (
              <div className="overflow-auto max-w-full max-h-full flex items-center justify-center p-2">
                <img
                  src={resolvedImageSrc}
                  alt={fileName}
                  style={{
                    transform: `scale(${zoom}) rotate(${rotation}deg)`,
                    transition: 'transform 0.2s ease-in-out'
                  }}
                  className="max-h-[64vh] max-w-full object-contain rounded-lg shadow-md select-none"
                  loading="lazy"
                />
              </div>
            )
          ) : isPdf ? (
            <div className="w-full h-[64vh] flex flex-col bg-slate-900/90 rounded-lg border border-slate-700 overflow-hidden shadow-inner">
              {isDrive ? (
                <iframe
                  src={resolvedPdfSrc}
                  title={fileName}
                  className="w-full h-full border-0 rounded-lg bg-white"
                  allow="autoplay"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center p-6 text-center space-y-4">
                  <div className="w-16 h-16 rounded-xl bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                    <FileText className="w-8 h-8" />
                  </div>
                  <div>
                    <h4 className="font-bold text-lg text-white">{fileName}</h4>
                    <p className="text-xs text-slate-400 mt-1 max-w-md">
                      เอกสาร Quotation / PDF พร้อมสำหรับการตรวจสอบและพิมพ์
                    </p>
                  </div>
                  <div className="flex items-center gap-2 pt-2">
                    <a
                      href={targetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-lg shadow-sm shadow-indigo-600/30 flex items-center gap-2 transition-all cursor-pointer"
                    >
                      <ExternalLink className="w-4 h-4" />
                      เปิดดูเอกสาร PDF เต็มหน้าจอ
                    </a>
                  </div>
                </div>
              )}
            </div>
          ) : isShoppingStore ? (
            <div className="w-full max-w-md bg-slate-800/90 border border-slate-700 rounded-xl p-6 text-center space-y-5 shadow-md">
              <div className="w-16 h-16 rounded-xl bg-purple-500/20 border border-purple-400/30 flex items-center justify-center text-purple-400 mx-auto">
                <Globe className="w-8 h-8" />
              </div>
              <div className="space-y-1.5">
                <h4 className="font-bold text-base text-white">ลิงก์สั่งซื้อสินค้าออนไลน์</h4>
                <p className="text-xs text-purple-300 font-mono break-all bg-slate-900/80 p-3 rounded-lg border border-slate-700/60">
                  {targetUrl}
                </p>
              </div>
              <a
                href={targetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="w-full py-3 bg-purple-600 hover:bg-purple-700 text-white font-bold text-sm rounded-lg shadow-sm shadow-purple-600/30 flex items-center justify-center gap-2 transition-all cursor-pointer"
              >
                <ExternalLink className="w-4 h-4" />
                เปิดหน้าเว็บร้านค้าภายนอก (Shopee / Lazada)
              </a>
            </div>
          ) : (
            <div className="text-center p-8 space-y-3">
              <FileText className="w-12 h-12 text-slate-500 mx-auto" />
              <p className="text-sm text-slate-400">ไฟล์เอกสาร: <span className="text-white font-semibold">{fileName}</span></p>
              {targetUrl && (
                <a
                  href={targetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded-lg border border-slate-600 transition-colors"
                >
                  <ExternalLink className="w-4 h-4" /> เปิดไฟล์
                </a>
              )}
            </div>
          )}
        </div>

        {/* Modal Bottom Footer */}
        <div className="px-6 py-3 bg-slate-800/80 border-t border-slate-700/80 flex items-center justify-between text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>ระบบรักษาความปลอดภัยเอกสารจัดซื้อ • Google Drive Verified</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 text-white font-bold rounded-lg transition-colors"
          >
            ปิด
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
