/**
 * LoginView Component
 * 
 * Standard Unified Authentication Interface for Localhost and Google Apps Script Production.
 * Pure Username & Password credential authentication with quick-access Personas for rapid testing.
 */

import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth, CANONICAL_ROLES } from '../../context/AuthContext';
import { useAppContext } from '../../context/AppContext';

export default function LoginView() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, isAuthenticated, isLoading: authLoading, authError } = useAuth();
  const appContext = useAppContext?.();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [localError, setLocalError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const passwordInputRef = useRef(null);

  // If already authenticated, redirect to destination or dashboard
  useEffect(() => {
    if (isAuthenticated) {
      const destination = location.state?.from?.pathname || '/dashboard';
      navigate(destination, { replace: true });
    }
  }, [isAuthenticated, location.state, navigate]);

  // Credentials Sign-In Handler
  const performLogin = async (targetUser, targetPass) => {
    setLocalError('');

    const cleanUser = String(targetUser || '').trim();
    const cleanPass = String(targetPass || '').trim();

    if (!cleanUser) {
      setLocalError('กรุณาระบุ Username หรือ Employee ID');
      return;
    }

    if (!cleanPass) {
      setLocalError('กรุณาระบุ Password');
      if (passwordInputRef.current) passwordInputRef.current.focus();
      return;
    }

    setIsSubmitting(true);

    try {
      const session = await login(cleanUser, cleanPass);

      // Synchronize legacy AppContext state if present
      if (appContext?.handleSwitchUser && session?.id) {
        appContext.handleSwitchUser(session.id);
      }

      const destination = location.state?.from?.pathname || 
        (session?.canonicalRole === CANONICAL_ROLES.PURCHASER ? '/online-tasks' : '/dashboard');
      
      navigate(destination, { replace: true });
    } catch (err) {
      setLocalError(err.message || 'Username หรือ Password ไม่ถูกต้อง');
      if (passwordInputRef.current) passwordInputRef.current.select();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    await performLogin(username, password);
  };

  const errorMessage = localError || authError;

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col justify-center items-center p-4 sm:p-6 relative overflow-hidden selection:bg-indigo-500 selection:text-white">
      {/* Background Ambient Glows */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-indigo-600/15 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-10 right-10 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full max-w-md relative z-10">
        {/* Brand Header */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-tr from-indigo-600 to-violet-500 text-white shadow-xl shadow-indigo-500/25 mb-3.5 border border-indigo-400/30">
            <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white font-sans">
            PR-PO & Stock System
          </h1>
          <p className="text-xs text-slate-400 mt-1 font-mono">
            Production & Quality Control System
          </p>
        </div>

        {/* Main Card */}
        <div className="bg-white rounded-3xl shadow-2xl border border-slate-100 p-6 sm:p-8">
          <div className="mb-6">
            <h2 className="text-lg font-bold text-slate-900 tracking-tight">
              เข้าสู่ระบบ (Sign In)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              กรอก Username และ Password เพื่อยืนยันตัวตนเข้าสู่ระบบ
            </p>
          </div>

          {/* Error Alert Box */}
          {errorMessage && (
            <div className="mb-5 p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start gap-2.5 animate-shake">
              <span className="text-base leading-none">⚠️</span>
              <div className="flex-1 font-medium">{errorMessage}</div>
            </div>
          )}

          {/* Standard Credentials Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Username Input */}
            <div>
              <label htmlFor="username-input" className="block text-xs font-semibold text-slate-700 mb-1.5 font-mono uppercase tracking-wider">
                Username / รหัสพนักงาน
              </label>
              <div className="relative">
                <input
                  id="username-input"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="เช่น wichai.pd หรือ admin"
                  autoComplete="username"
                  className="w-full px-4 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all font-mono"
                  required
                />
                <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-slate-400 text-sm">
                  👤
                </div>
              </div>
            </div>

            {/* Password Input */}
            <div>
              <div className="flex justify-between items-center mb-1.5">
                <label htmlFor="password-input" className="block text-xs font-semibold text-slate-700 font-mono uppercase tracking-wider">
                  Password / รหัสผ่าน
                </label>
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="text-[11px] text-indigo-600 hover:text-indigo-800 font-medium cursor-pointer"
                >
                  {showPassword ? 'ซ่อน Password' : 'แสดง Password'}
                </button>
              </div>
              <div className="relative">
                <input
                  id="password-input"
                  ref={passwordInputRef}
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="รหัสผ่านของคุณ"
                  autoComplete="current-password"
                  className="w-full px-4 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all font-mono tracking-wide"
                  required
                />
                <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-slate-400 text-sm">
                  🔑
                </div>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              id="login-submit-btn"
              disabled={isSubmitting || authLoading}
              className="w-full mt-2 py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:scale-[0.99] text-white text-sm font-semibold shadow-lg shadow-indigo-600/30 transition-all duration-150 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {isSubmitting || authLoading ? (
                <>
                  <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  <span>กำลังตรวจสอบ...</span>
                </>
              ) : (
                <span>เข้าสู่ระบบ →</span>
              )}
            </button>
          </form>
        </div>

        {/* Security & System Info Footer */}
        <div className="mt-6 text-center text-xs text-slate-400 font-mono space-y-1">
          <p>🔒 เซสชันปลอดภัย อายุการใช้งาน 24 ชั่วโมง</p>
          <p className="text-[11px] text-slate-400">Enterprise Resource Planning System</p>
        </div>
      </div>
    </div>
  );
}
