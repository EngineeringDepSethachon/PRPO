import React, { useCallback, useState } from 'react';
import { UploadCloud, File as FileIcon, X, Image as ImageIcon } from 'lucide-react';
import { compressImageFile } from '../../utils/fileUtils';

export default function FileUploader({ 
  label, 
  required, 
  accept = "image/*,application/pdf", 
  multiple = false, 
  files = [], 
  setFiles,
  helperText = '',
  compact = false
}) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDrag = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setIsDragging(true);
    else if (e.type === 'dragleave') setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(Array.from(e.target.files));
    }
  };

  const handleFiles = async (newFiles) => {
    const validFilesPromises = Array.from(newFiles).map(async (file) => {
      const isImg = file.type ? file.type.startsWith('image/') : /\.(jpe?g|png|webp|gif)$/i.test(file.name);
      if (isImg) {
        try {
          const comp = await compressImageFile(file, {
            maxWidth: 1280,
            maxHeight: 1280,
            quality: 0.75,
            maxSizeBytes: 150 * 1024
          });
          return {
            file,
            id: Math.random().toString(36).substring(7),
            name: file.name,
            size: comp.size,
            type: comp.type || 'image/jpeg',
            previewUrl: comp.previewUrl,
            url: comp.previewUrl,
            dataUrl: comp.previewUrl,
            isImage: true
          };
        } catch (err) {
          console.warn('[FileUploader] Auto compression fallback:', err);
        }
      }

      // Non-image (e.g. PDF) or compression fallback
      let dataUrl = '';
      try {
        dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      } catch (err) {
        console.warn('[FileUploader] Failed to convert to base64:', err);
      }

      let previewUrl = '';
      try {
        previewUrl = URL.createObjectURL(file);
      } catch (_) {}

      return {
        file,
        id: Math.random().toString(36).substring(7),
        name: file.name,
        size: file.size,
        type: file.type,
        previewUrl: previewUrl || dataUrl,
        url: dataUrl || previewUrl,
        dataUrl: dataUrl,
        isImage: Boolean(file.type && file.type.startsWith('image/'))
      };
    });

    const validFiles = await Promise.all(validFilesPromises);

    if (multiple) {
      setFiles(prev => [...prev, ...validFiles]);
    } else {
      // If not multiple, revoke old URL if it was a blob URL and replace
      if (files.length > 0 && files[0].previewUrl && files[0].previewUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(files[0].previewUrl); } catch (_) {}
      }
      setFiles([validFiles[0]]);
    }
  };

  const removeFile = (idToRemove) => {
    const fileToRemove = files.find(f => f.id === idToRemove);
    if (fileToRemove && fileToRemove.previewUrl && fileToRemove.previewUrl.startsWith('blob:')) {
      try { URL.revokeObjectURL(fileToRemove.previewUrl); } catch (_) {}
    }
    setFiles(prev => prev.filter(f => f.id !== idToRemove));
  };

  const formatSize = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  if (compact) {
    return (
      <div className="w-full space-y-2">
        <div
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          className={`relative border border-dashed rounded-xl px-3.5 py-2.5 h-[62px] transition-all flex items-center justify-between gap-3 cursor-pointer group select-none ${
            isDragging 
              ? 'border-indigo-500 bg-indigo-50/70 shadow-xs ring-2 ring-indigo-500/10' 
              : 'border-slate-300 bg-slate-50/50 hover:bg-white hover:border-indigo-300 shadow-2xs'
          }`}
        >
          <input 
            type="file" 
            accept={accept}
            multiple={multiple}
            onChange={handleFileChange}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
          />
          
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
              isDragging 
                ? 'bg-indigo-600 text-white' 
                : 'bg-white text-slate-400 group-hover:text-indigo-600 border border-slate-200 shadow-2xs'
            }`}>
              <UploadCloud className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-800 truncate">
                {label} {required && <span className="text-rose-500">*</span>}
              </p>
              <p className="text-[11px] text-slate-400 truncate">
                {helperText || `คลิกหรือลากไฟล์มาวาง (${accept.includes('pdf') ? 'PDF/รูป' : 'รูปภาพ'})`}
              </p>
            </div>
          </div>

          <span className="text-[11px] font-semibold text-indigo-600 bg-indigo-50/80 group-hover:bg-indigo-100/70 border border-indigo-100 px-2.5 py-1 rounded-lg shrink-0 transition-colors pointer-events-none">
            แนบไฟล์
          </span>
        </div>

        {/* Compact File Pills */}
        {files && files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {files.map(f => (
              <div 
                key={f.id || f.name} 
                className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-white border border-slate-200 rounded-lg text-xs shadow-2xs group/item"
              >
                {f.isImage || (f.type && f.type.startsWith('image/')) ? (
                  <ImageIcon className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                ) : (
                  <FileIcon className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                )}
                <span className="font-medium text-slate-700 max-w-[140px] truncate" title={f.name}>
                  {f.name}
                </span>
                {f.size ? (
                  <span className="text-[10px] text-slate-400 font-mono">({formatSize(f.size)})</span>
                ) : null}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); removeFile(f.id); }}
                  className="w-4 h-4 flex items-center justify-center rounded-full text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer ml-0.5"
                  title="ลบไฟล์นี้"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="w-full animate-fade-in">
      <div className="flex justify-between items-end mb-2">
        <label className="text-[13px] font-bold text-slate-700">
          {label} {required && <span className="text-rose-500">*</span>}
        </label>
        {helperText && <span className="text-[11px] text-slate-500">{helperText}</span>}
      </div>

      <div
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        className={`relative border-2 border-dashed rounded-sm p-6 transition-all duration-300 flex flex-col items-center justify-center text-center cursor-pointer overflow-hidden group
          ${isDragging 
            ? 'border-indigo-500 bg-indigo-50 shadow-inner' 
            : 'border-slate-300 bg-white/50 hover:bg-white hover:border-indigo-300'
          }`}
      >
        <input 
          type="file" 
          accept={accept}
          multiple={multiple}
          onChange={handleFileChange}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
        />
        
        <div className={`p-3 rounded-full mb-3 transition-colors ${isDragging ? 'bg-indigo-100 text-indigo-600' : 'bg-white text-slate-400 group-hover:text-indigo-500 group-hover:bg-indigo-50 shadow-sm border border-slate-100'}`}>
          <UploadCloud className={`w-6 h-6 ${isDragging ? 'animate-bounce-slight' : ''}`} />
        </div>
        
        <h4 className="text-sm font-bold text-slate-700 mb-1">
          {isDragging ? 'วางไฟล์ที่นี่เลย!' : 'ลากไฟล์มาวาง หรือ คลิกเพื่อเลือก'}
        </h4>
        <p className="text-xs text-slate-500 font-medium max-w-xs leading-relaxed">
          รองรับไฟล์ {accept.replace(/image\/\*/g, 'รูปภาพ').replace(/application\/pdf/g, 'PDF')} {multiple && '(แนบได้หลายไฟล์)'}
        </p>
      </div>

      {/* Preview Gallery */}
      {files.length > 0 && (
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5 animate-fade-in-up">
          {files.map(f => (
            <div key={f.id} className="relative group rounded-sm border border-slate-200 bg-white overflow-hidden shadow-sm hover:shadow-md transition-shadow">
              {f.isImage ? (
                <div className="aspect-square bg-slate-100 w-full">
                  <img src={f.previewUrl} alt={f.name} className="w-full h-full object-cover" />
                </div>
              ) : (
                <div className="aspect-square bg-white flex flex-col items-center justify-center p-3 text-center">
                  <FileIcon className="w-8 h-8 text-indigo-400 mb-2" />
                  <span className="text-[10px] font-bold text-slate-600 line-clamp-2 w-full break-all">{f.name}</span>
                </div>
              )}
              
              {/* Overlay on hover */}
              <div className="absolute inset-0 bg-slate-900/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-between p-2">
                <button 
                  onClick={(e) => { e.stopPropagation(); removeFile(f.id); }}
                  className="self-end p-1.5 bg-rose-500 text-white rounded-full hover:bg-rose-600 shadow-sm transform hover:scale-110 transition-all cursor-pointer"
                  title="ลบไฟล์"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
                <div className="text-[10px] font-semibold text-white/90 truncate">
                  {formatSize(f.size)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
