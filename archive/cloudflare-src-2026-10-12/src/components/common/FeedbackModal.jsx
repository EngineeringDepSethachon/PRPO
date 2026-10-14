import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { modalService } from '../../services/modalService';
import { 
  CheckCircle2, 
  AlertTriangle, 
  AlertOctagon, 
  Info, 
  HelpCircle, 
  X, 
  MessageSquareQuote,
  Sparkles,
  Loader2
} from 'lucide-react';

export default function FeedbackModal() {
  const [modalState, setModalState] = useState(null);
  const [promptInput, setPromptInput] = useState('');
  const [inputError, setInputError] = useState('');
  // Prevents double-click on confirm button — reset once modal closes
  const [isConfirming, setIsConfirming] = useState(false);
  const inputRef = useRef(null);
  const confirmButtonRef = useRef(null);

  useEffect(() => {
    const unsubscribe = modalService.subscribe((state) => {
      setModalState(state);
      // Always reset confirming state when modal changes (new modal or close)
      setIsConfirming(false);
      if (state?.mode === 'prompt') {
        setPromptInput(state.defaultValue || '');
        setInputError('');
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (modalState) {
      if (modalState.mode === 'prompt') {
        setTimeout(() => inputRef.current?.focus(), 50);
      } else {
        setTimeout(() => confirmButtonRef.current?.focus(), 50);
      }
    }
  }, [modalState]);

  // Handle Keyboard Navigation (Esc to close, Enter to submit)
  // Lock Esc and backdrop click while confirming to prevent race conditions
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!modalState) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        // Block Esc while confirm action is in-flight
        if (isConfirming) return;
        if (modalState.mode === 'confirm' || modalState.mode === 'prompt') {
          modalState.onCancel();
        } else {
          modalState.onClose();
        }
      } else if (e.key === 'Enter' && !e.shiftKey) {
        if (modalState.mode === 'prompt') {
          if (e.target.tagName !== 'TEXTAREA') {
            e.preventDefault();
            handlePromptSubmit();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [modalState, promptInput, isConfirming]);

  if (!modalState) return null;

  const handlePromptSubmit = () => {
    if (modalState.required && !promptInput.trim()) {
      setInputError('กรุณากรอกข้อมูลในช่องนี้');
      inputRef.current?.focus();
      return;
    }
    modalState.onConfirm(promptInput.trim());
  };

  /**
   * Handles confirm button click with double-click prevention.
   * Momentarily disables the button (setIsConfirming=true) then calls onConfirm.
   * Since modalService.confirm() resolves immediately on click (caller handles async),
   * we only need to prevent rapid double-clicks — the modal will close right after.
   */
  const handleConfirmClick = () => {
    if (isConfirming) return;
    if (modalState.mode === 'prompt') {
      handlePromptSubmit();
      return;
    }
    if (modalState.mode === 'confirm') {
      setIsConfirming(true);
    }
    // Call the original onConfirm — it will trigger modalService.close()
    modalState.onConfirm();
  };

  const getVariantStyles = () => {
    const type = modalState.type || 'info';
    switch (type) {
      case 'success':
        return {
          icon: CheckCircle2,
          iconBg: 'bg-emerald-50 text-emerald-600 border border-emerald-200',
          confirmBtn: 'bg-slate-900 hover:bg-slate-800 text-white shadow-sm',
          confirmBtnLoading: 'bg-slate-700 text-white shadow-sm',
          defaultTitle: 'ดำเนินการสำเร็จ'
        };
      case 'error':
      case 'danger':
        return {
          icon: AlertOctagon,
          iconBg: 'bg-rose-50 text-rose-600 border border-rose-200',
          confirmBtn: 'bg-rose-600 hover:bg-rose-700 text-white shadow-sm',
          confirmBtnLoading: 'bg-rose-500 text-white shadow-sm',
          defaultTitle: 'เกิดข้อผิดพลาด'
        };
      case 'warning':
        return {
          icon: AlertTriangle,
          iconBg: 'bg-amber-50 text-amber-600 border border-amber-200',
          confirmBtn: 'bg-amber-600 hover:bg-amber-700 text-white shadow-sm',
          confirmBtnLoading: 'bg-amber-500 text-white shadow-sm',
          defaultTitle: 'ข้อควรระวัง / แจ้งเตือน'
        };
      case 'info':
      default:
        return {
          icon: modalState.mode === 'prompt' ? MessageSquareQuote : Info,
          iconBg: 'bg-indigo-50 text-indigo-600 border border-indigo-200',
          confirmBtn: 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm',
          confirmBtnLoading: 'bg-indigo-500 text-white shadow-sm',
          defaultTitle: modalState.mode === 'prompt' ? 'ระบุรายละเอียด' : 'ข้อมูลระบบ'
        };
    }
  };

  const variant = getVariantStyles();
  const IconComponent = variant.icon;

  const handleBackdropClick = () => {
    // Block backdrop click while confirming
    if (isConfirming) return;
    if (modalState.mode === 'confirm' || modalState.mode === 'prompt') {
      modalState.onCancel();
    } else {
      modalState.onClose();
    }
  };

  const handleCloseButtonClick = () => {
    // Block close button while confirming
    if (isConfirming) return;
    if (modalState.mode === 'confirm' || modalState.mode === 'prompt') {
      modalState.onCancel();
    } else {
      modalState.onClose();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6 animate-fade-in">
      {/* Blurred Backdrop — blocked during confirming */}
      <div 
        className={`fixed inset-0 bg-slate-900/40 backdrop-blur-xs transition-opacity ${isConfirming ? 'cursor-not-allowed' : ''}`}
        onClick={handleBackdropClick}
      />

      {/* Modal Card */}
      <div className="relative w-full max-w-lg bg-white rounded-3xl shadow-xl border border-slate-200/90 overflow-hidden transform transition-all animate-zoom-in z-10">
        <div className="p-6 sm:p-7">
          {/* Header Area */}
          <div className="flex items-start gap-3.5">
            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 shadow-2xs ${variant.iconBg}`}>
              <IconComponent className="w-6 h-6" />
            </div>

            <div className="flex-1 min-w-0 pt-0.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-lg sm:text-xl font-bold text-slate-900 leading-snug tracking-tight">
                  {modalState.title || variant.defaultTitle}
                </h3>
                <button
                  onClick={handleCloseButtonClick}
                  disabled={isConfirming}
                  className={`p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition-colors ${isConfirming ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer'}`}
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Message Body */}
              <div className="mt-2 text-slate-600 text-sm leading-relaxed whitespace-pre-line font-normal">
                {modalState.message}
              </div>
            </div>
          </div>

          {/* Prompt Input Form */}
          {modalState.mode === 'prompt' && (
            <div className="mt-5 space-y-2">
              <div className="relative">
                <textarea
                  ref={inputRef}
                  value={promptInput}
                  onChange={(e) => {
                    setPromptInput(e.target.value);
                    if (inputError) setInputError('');
                  }}
                  placeholder={modalState.placeholder}
                  rows={modalState.rows || 3}
                  className={`w-full px-4 py-3 rounded-2xl border bg-slate-50 text-slate-900 text-sm focus:bg-white focus:outline-none focus:ring-2 transition-all resize-none ${
                    inputError 
                      ? 'border-rose-400 focus:ring-rose-400 focus:border-rose-400' 
                      : 'border-slate-200 focus:ring-indigo-500/20 focus:border-indigo-500'
                  }`}
                />
              </div>
              {inputError && (
                <p className="text-xs font-medium text-rose-600 flex items-center gap-1">
                  <AlertOctagon className="w-3.5 h-3.5 shrink-0" />
                  <span>{inputError}</span>
                </p>
              )}
            </div>
          )}

          {/* Action Buttons */}
          <div className="mt-6 pt-4 border-t border-slate-100 flex items-center justify-end gap-2.5">
            {(modalState.mode === 'confirm' || modalState.mode === 'prompt') && (
              <button
                type="button"
                onClick={() => { if (!isConfirming) modalState.onCancel(); }}
                disabled={isConfirming}
                className={`px-5 py-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold transition-all shadow-2xs active:scale-95 ${isConfirming ? 'opacity-40 cursor-not-allowed pointer-events-none' : 'cursor-pointer'}`}
              >
                {modalState.cancelText || 'ยกเลิก'}
              </button>
            )}

            <button
              ref={confirmButtonRef}
              type="button"
              id="feedback-modal-confirm-btn"
              onClick={handleConfirmClick}
              disabled={isConfirming}
              className={`px-5 py-2.5 rounded-xl text-xs font-semibold transition-all shadow-sm active:scale-95 flex items-center justify-center gap-2 min-w-[100px] ${
                isConfirming
                  ? `${variant.confirmBtnLoading} opacity-80 cursor-not-allowed pointer-events-none`
                  : `${variant.confirmBtn} cursor-pointer`
              }`}
            >
              {isConfirming ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                  <span>กำลังประมวลผล...</span>
                </>
              ) : (
                <span>{modalState.confirmText || 'ตกลง'}</span>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
