import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { KeyRound, X, LogOut } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { backendFetch } from '../../config/backendMode';

const MIN_LENGTH = 6;

/**
 * Change-password modal (cloudflare mode only ; same look as UserProfileModal).
 * forced = the account must change its password (mustChangePassword) : no close button, only "change" or "sign out".
 */
export default function ChangePasswordModal({ isOpen, forced = false, onClose, onLogout }) {
  const auth = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!isOpen) return null;

  const submit = async (e) => {
    if (e) e.preventDefault();
    if (busy) return;
    if (!current) return setError('กรุณากรอกรหัสผ่านเดิม');
    if (next.length < MIN_LENGTH) return setError(`รหัสผ่านใหม่ต้องมีอย่างน้อย ${MIN_LENGTH} ตัวอักษร`);
    if (next !== confirm) return setError('ยืนยันรหัสผ่านใหม่ไม่ตรงกัน');
    if (next === current) return setError('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม');
    setError('');
    setBusy(true);
    try {
      const res = await backendFetch('/api/me/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: current, newPassword: next })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || typeof data.token !== 'string' || !data.token) {
        setError((data && data.error) || 'เปลี่ยนรหัสผ่านไม่สำเร็จ กรุณาลองใหม่อีกครั้ง');
        return;
      }
      auth.completePasswordChange?.(data.token);
      setCurrent(''); setNext(''); setConfirm('');
      if (onClose) onClose(true);
    } catch {
      setError('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ กรุณาลองใหม่อีกครั้ง');
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = () => {
    if (onLogout) onLogout();
    else auth.logout?.();
  };

  const inputCls = 'w-full px-3 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400';

  const content = (
    <div
      data-testid="change-password-backdrop"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50 backdrop-blur-xs animate-fade-in print:hidden"
    >
      <form
        onSubmit={submit}
        data-testid="change-password-modal"
        className="w-full max-w-md flex flex-col rounded-3xl bg-white shadow-2xl border border-slate-200/80 overflow-hidden text-slate-800 animate-zoom-in"
      >
        <div className="shrink-0 px-6 py-4 border-b border-slate-100 bg-white flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 border border-indigo-100/80 flex items-center justify-center shadow-2xs shrink-0">
              <KeyRound className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-slate-900 text-base tracking-tight">เปลี่ยนรหัสผ่าน</h3>
              <p className="text-xs text-slate-500 font-normal mt-0.5">
                {forced ? 'กรุณาตั้งรหัสผ่านใหม่ก่อนเริ่มใช้งานระบบ' : 'ตั้งรหัสผ่านใหม่สำหรับบัญชีของคุณ'}
              </p>
            </div>
          </div>
          {!forced && (
            <button
              type="button"
              onClick={() => onClose && onClose(false)}
              className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
              aria-label="ปิดหน้าต่าง"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        <div className="p-6 space-y-4 bg-slate-50/30">
          <label className="block space-y-1.5">
            <span className="text-xs font-bold text-slate-700">รหัสผ่านเดิม</span>
            <input
              id="current-password-input"
              data-testid="current-password-input"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-bold text-slate-700">รหัสผ่านใหม่ (อย่างน้อย {MIN_LENGTH} ตัวอักษร)</span>
            <input
              id="new-password-input"
              data-testid="new-password-input"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-bold text-slate-700">ยืนยันรหัสผ่านใหม่</span>
            <input
              id="confirm-password-input"
              data-testid="confirm-password-input"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={inputCls}
            />
          </label>
          {error && (
            <p data-testid="change-password-error" role="alert" className="text-xs font-semibold text-rose-600 bg-rose-50 border border-rose-200/70 rounded-xl px-3 py-2">
              {error}
            </p>
          )}
        </div>

        <div className="shrink-0 px-6 py-4 bg-slate-50/80 border-t border-slate-100 flex items-center justify-between gap-3">
          {forced ? (
            <button
              type="button"
              onClick={handleLogout}
              data-testid="change-password-logout"
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-rose-600 hover:text-rose-700 bg-rose-50 hover:bg-rose-100/80 border border-rose-200/70 rounded-xl transition-colors duration-150 cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              <span>ออกจากระบบ (Sign Out)</span>
            </button>
          ) : <span />}
          <button
            type="submit"
            id="change-password-submit"
            data-testid="change-password-submit"
            disabled={busy}
            className="px-5 py-2 rounded-xl bg-slate-800 hover:bg-slate-900 disabled:opacity-60 text-white text-xs font-bold transition-all cursor-pointer"
          >
            {busy ? 'กำลังบันทึก...' : 'เปลี่ยนรหัสผ่าน'}
          </button>
        </div>
      </form>
    </div>
  );

  if (typeof document !== 'undefined' && document.body) return createPortal(content, document.body);
  return content;
}
