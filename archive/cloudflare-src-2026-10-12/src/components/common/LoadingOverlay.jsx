import React from 'react';
import { createPortal } from 'react-dom';

/**
 * LoadingOverlay — Full-screen blocking overlay shown during async API operations.
 *
 * Renders at z-[200] via portal so it sits above all modals (z-50, z-60, z-100).
 * Blocks ALL pointer events while visible (prevents double-submission).
 *
 * @param {boolean}  isVisible - Whether the overlay is shown
 * @param {string}   [message] - Status text shown below the spinner (e.g. "กำลังบันทึก PO...")
 */
export default function LoadingOverlay({ isVisible, message = 'กำลังประมวลผล...' }) {
  if (!isVisible) return null;

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      aria-label={message}
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ pointerEvents: 'all' }}
    >
      {/* Dark semi-transparent backdrop */}
      <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" />

      {/* Floating card */}
      <div className="relative flex flex-col items-center gap-4 bg-white rounded-3xl shadow-2xl border border-slate-200/80 px-10 py-8 mx-4 max-w-xs w-full animate-fade-in">

        {/* Spinner ring */}
        <div className="relative w-14 h-14">
          {/* Outer track */}
          <div className="absolute inset-0 rounded-full border-4 border-indigo-100" />
          {/* Spinning arc */}
          <div
            className="absolute inset-0 rounded-full border-4 border-transparent border-t-indigo-600 border-r-indigo-400"
            style={{ animation: 'spin 0.75s linear infinite' }}
          />
          {/* Inner pulse dot */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-2.5 h-2.5 bg-indigo-500 rounded-full animate-pulse" />
          </div>
        </div>

        {/* Status text */}
        <div className="text-center space-y-1">
          <p className="text-sm font-semibold text-slate-800 leading-snug">
            {message}
          </p>
          <p className="text-xs text-slate-400 font-normal">
            กรุณารอสักครู่ อย่าปิดหน้าต่างนี้
          </p>
        </div>

        {/* Animated dots progress indicator */}
        <div className="flex items-center gap-1.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-indigo-400"
              style={{
                animation: 'pulse 1.2s ease-in-out infinite',
                animationDelay: `${i * 0.2}s`
              }}
            />
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
