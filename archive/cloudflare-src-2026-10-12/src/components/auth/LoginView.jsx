import React, { useState } from 'react';
import { authService, DEFAULT_EMPLOYEE_ACCOUNTS } from '../../services/authService';
import { 
  Factory, Lock, User, Eye, EyeOff, ShieldCheck, 
  AlertCircle, ArrowRight, CheckCircle2, Sparkles,
  Layers, ChevronRight, UserCheck, KeyRound, Monitor, Lightbulb
} from 'lucide-react';

export default function LoginView({ onLoginSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [activeTab, setActiveTab] = useState('position'); // 'position' | 'credentials'

  const handleManualLogin = async (e) => {
    e.preventDefault();
    setErrorMsg('');
    setLoading(true);

    try {
      if (!username.trim() || !password) {
        throw new Error('กรุณากรอกชื่อผู้ใช้งานและรหัสผ่านให้ครบถ้วน');
      }

      const userSession = await authService.login(username.trim(), password);
      if (onLoginSuccess) {
        onLoginSuccess(userSession);
      }
    } catch (err) {
      setErrorMsg(err.message || 'เข้าสู่ระบบไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  };

  const handleQuickLogin = async (acc) => {
    setErrorMsg('');
    setLoading(true);
    try {
      const userSession = await authService.login(acc.username, acc.password);
      if (onLoginSuccess) {
        onLoginSuccess(userSession);
      }
    } catch (err) {
      setErrorMsg(err.message || 'เข้าสู่ระบบไม่สำเร็จ');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full bg-slate-950 flex flex-col justify-center items-center p-4 sm:p-6 lg:p-8 relative overflow-hidden font-sans select-none">
      {/* Background Decorative Glows */}
      <div className="absolute -top-40 -left-40 w-96 h-96 bg-indigo-600/20 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-teal-600/15 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-indigo-950/30 rounded-full blur-[120px] pointer-events-none" />
      
      {/* Main Container */}
      <div className="w-full max-w-2xl bg-slate-900/90 backdrop-blur-xl border border-slate-800 rounded-sm p-6 sm:p-8 shadow-md relative z-10 animate-zoom-in">
        
        {/* Header & Logo */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-sm bg-gradient-to-tr from-indigo-500 to-indigo-600 text-white shadow-sm shadow-indigo-500/30 mb-3 ring-4 ring-indigo-500/10">
            <Factory className="w-7 h-7" />
          </div>
          <h1 className="text-xl sm:text-2xl font-black text-white tracking-tight">
            PR/PO & Inventory System
          </h1>
          <p className="text-xs text-indigo-300/80 mt-1 font-medium">
            ระบบจัดซื้อและคลังสินค้า ฝ่ายผลิต (PD) & ฝ่ายควบคุมคุณภาพ (QC)
          </p>

          {/* Localhost Environment Badge */}
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-950/70 border border-emerald-800/60 text-emerald-400 text-[11px] font-bold mt-3 shadow-inner">
            <Monitor className="w-3.5 h-3.5 text-emerald-400" />
            <span>Localhost Testing Mode (เข้าสู่ระบบตาม Position)</span>
          </div>
        </div>

        {/* Mode Selector Tabs */}
        <div className="flex bg-slate-950/80 p-1.5 rounded-sm border border-slate-800 mb-6">
          <button
            type="button"
            onClick={() => { setActiveTab('position'); setErrorMsg(''); }}
            className={`flex-1 py-2.5 text-xs font-bold rounded-sm transition-all flex items-center justify-center gap-2 ${
              activeTab === 'position'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="w-4 h-4" />
            <span>เลือกตาม Position (1-Click Test)</span>
          </button>
          <button
            type="button"
            onClick={() => { setActiveTab('credentials'); setErrorMsg(''); }}
            className={`flex-1 py-2.5 text-xs font-bold rounded-sm transition-all flex items-center justify-center gap-2 ${
              activeTab === 'credentials'
                ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <KeyRound className="w-4 h-4" />
            <span>กรอก Username / Password</span>
          </button>
        </div>

        {/* Error Alert */}
        {errorMsg && (
          <div className="mb-5 p-3.5 bg-rose-500/10 border border-rose-500/30 text-rose-300 rounded-sm text-xs font-semibold flex items-center gap-2.5 animate-shake">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* TAB 1: 1-Click Position Selector */}
        {activeTab === 'position' && (
          <div className="space-y-3 animate-fade-in">
            <div className="flex items-center justify-between px-1 mb-2">
              <span className="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                คลิกเลือกตำแหน่งเพื่อเข้าใช้งานระบบทันที:
              </span>
              <span className="text-[10px] text-slate-500 font-medium">6 ตำแหน่งทดสอบ</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {DEFAULT_EMPLOYEE_ACCOUNTS.map((acc) => {
                const badgeColor = acc.department === 'PD' 
                  ? 'bg-blue-950 text-blue-300 border-blue-800' 
                  : acc.department === 'QC' 
                    ? 'bg-amber-950 text-amber-300 border-amber-800' 
                    : 'bg-emerald-950 text-emerald-300 border-emerald-800';

                return (
                  <button
                    key={acc.id}
                    type="button"
                    disabled={loading}
                    onClick={() => handleQuickLogin(acc)}
                    className="p-3.5 rounded-sm bg-slate-950/60 hover:bg-indigo-950/40 border border-slate-800 hover:border-indigo-600/60 transition-all text-left group flex items-start justify-between relative overflow-hidden cursor-pointer hover:shadow-sm hover:shadow-indigo-950/50 active:scale-[0.98] disabled:opacity-50"
                  >
                    <div className="flex items-start gap-1.5 min-w-0">
                      <div className="w-10 h-10 rounded-full bg-slate-800 text-slate-200 border border-slate-700 flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">
                        {acc.name ? acc.name.charAt(0) : <User className="w-4 h-4" />}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-bold text-sm text-slate-100 group-hover:text-white truncate">
                            {acc.name}
                          </span>
                          <span className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded border ${badgeColor}`}>
                            {acc.department}
                          </span>
                        </div>
                        <div className="text-xs font-semibold text-indigo-400 mt-0.5 truncate">
                          {acc.title}
                        </div>
                        <p className="text-[11px] text-slate-400 mt-1 line-clamp-1 leading-snug">
                          {acc.description}
                        </p>
                      </div>
                    </div>

                    <div className="shrink-0 p-1.5 rounded-sm bg-slate-900 group-hover:bg-indigo-600 text-slate-400 group-hover:text-white transition-colors ml-2 mt-1">
                      <ChevronRight className="w-4 h-4" />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* TAB 2: Manual Credentials Form */}
        {activeTab === 'credentials' && (
          <form onSubmit={handleManualLogin} className="space-y-4 animate-fade-in">
            {/* Username */}
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">
                ชื่อผู้ใช้งาน (Username หรือรหัสพนักงาน)
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <User className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="เช่น siraphat.pd, natthinee.qc, kallayani.mgr, nat.on, prasert.pm, admin"
                  className="w-full bg-slate-950/80 border border-slate-700 text-slate-100 text-sm rounded-sm pl-10 pr-4 py-3 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all font-medium placeholder:text-slate-600"
                  autoComplete="username"
                  autoFocus
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1.5">
                รหัสผ่าน (Password)
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="รหัสผ่านของคุณ"
                  className="w-full bg-slate-950/80 border border-slate-700 text-slate-100 text-sm rounded-sm pl-10 pr-11 py-3 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all font-medium placeholder:text-slate-600"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-400 hover:text-slate-200 transition-colors"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 text-white font-bold py-3.5 px-4 rounded-sm shadow-sm shadow-indigo-600/30 transition-all transform active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2 text-sm mt-2 cursor-pointer"
            >
              {loading ? (
                <span>กำลังเข้าสู่ระบบ...</span>
              ) : (
                <>
                  <span>เข้าสู่ระบบ (Sign In)</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>
        )}
      </div>

      {/* Footer copyright */}
      <div className="mt-6 text-center text-xs text-slate-500 relative z-10">
        © 2026 Production & Quality Control System • Localhost Development
      </div>
    </div>
  );
}
