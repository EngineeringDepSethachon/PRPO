import React, { useState, useRef, useEffect } from 'react';
import { 
  Users, User, Plus, Search, X, Edit3, Trash2, Check, 
  PenTool, Upload, RefreshCw, CheckCircle2, AlertCircle, 
  Building2, UserCheck, Eraser, Sparkles
} from 'lucide-react';
import { apiService } from '../../services/apiService';
import { storageService } from '../../services/storageService';
import { modalService } from '../../services/modalService';
import Pagination from '../../components/common/Pagination';

const ROLE_OPTIONS = [
  { id: 'REQUESTER', label: 'Requester - ผู้ขอซื้อ (ตามแผนกที่ได้รับมอบหมาย)', title: 'Requester', level: 1, color: 'bg-blue-50 text-blue-700 border-blue-200' },
  { id: 'ASST_MANAGER', label: 'Reviewer - ผู้ตรวจทาน (Asst. Manager)', title: 'Assistant Manager', level: 2, color: 'bg-amber-50 text-amber-700 border-amber-200' },
  { id: 'PLANT_MANAGER', label: 'Approver - ผู้อนุมัติ (Plant Manager)', title: 'Plant Manager', level: 3, color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  { id: 'ONLINE_PURCHASER', label: 'Purchaser - จัดซื้อออนไลน์ (Online)', title: 'Online Purchaser', level: 2, color: 'bg-purple-50 text-purple-700 border-purple-200' },
  { id: 'ADMIN', label: 'Admin - ผู้ดูแลระบบ (System Admin)', title: 'System Administrator', level: 99, color: 'bg-rose-50 text-rose-700 border-rose-200' },
];

// Normalize legacy department-coupled role IDs to canonical form
function normalizeRoleId(roleId) {
  if (!roleId) return 'REQUESTER';
  if (roleId === 'REQUESTER_PD' || roleId === 'REQUESTER_QC') return 'REQUESTER';
  return roleId;
}

export default function UserMasterView({ users: propUsers, departments: propDepartments, currentRole, currentUser, onRefresh }) {
  const [usersList, setUsersList] = useState([]);
  const [departmentsList, setDepartmentsList] = useState(() => {
    if (propDepartments && propDepartments.length > 0) return propDepartments;
    return storageService.getDepartments?.() || [];
  });
  const [isLoading, setIsLoading] = useState(false);
  const isAdmin = currentUser?.role === 'admin' || 
                  currentUser?.roleId === 'ADMIN' || 
                  currentRole?.role === 'admin' || 
                  currentRole?.roleId === 'ADMIN' || 
                  currentRole?.id === 'ADMIN' || 
                  currentRole?.level >= 99;
  const [searchQuery, setSearchQuery] = useState('');
  const [deptFilter, setDeptFilter] = useState('ALL');
  const [roleFilter, setRoleFilter] = useState('ALL');
  const [sigFilter, setSigFilter] = useState('ALL');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Modal State
  const [selectedUser, setSelectedUser] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [previewingSig, setPreviewingSig] = useState(null);

  const fetchUsers = async () => {
    setIsLoading(true);
    try {
      const data = await apiService.getUsers(true);
      setUsersList(data || []);
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (propUsers && propUsers.length > 0) {
      setUsersList(propUsers);
    } else {
      fetchUsers();
    }
  }, [propUsers]);

  useEffect(() => {
    if (propDepartments && propDepartments.length > 0) {
      setDepartmentsList(propDepartments);
    } else {
      setDepartmentsList(storageService.getDepartments?.() || []);
    }
  }, [propDepartments]);

  // Reset pagination on filter change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, deptFilter, roleFilter, sigFilter, pageSize]);

  // Filtered Users
  const filteredUsers = usersList.filter(u => {
    // Dept filter — check assignedDepartments first, fallback to primaryDepartment
    const userDepts = Array.isArray(u.assignedDepartments) && u.assignedDepartments.length > 0
      ? u.assignedDepartments
      : [u.primaryDepartment || u.department].filter(Boolean);
    const matchesDept = deptFilter === 'ALL'
      || userDepts.includes('*') || userDepts.includes('ALL')
      || userDepts.includes(deptFilter);
    // Role filter — normalize legacy role IDs
    const matchesRole = roleFilter === 'ALL' || normalizeRoleId(u.roleId) === normalizeRoleId(roleFilter);
    // Signature filter
    const hasSig = Boolean(u.signature && u.signature.length > 50);
    const matchesSig = sigFilter === 'ALL' || (sigFilter === 'HAS_SIG' ? hasSig : !hasSig);

    // Search query
    const q = searchQuery.trim().toLowerCase();
    const matchesSearch = !q || (
      u.employeeId?.toLowerCase().includes(q) ||
      u.name?.toLowerCase().includes(q) ||
      u.employeeName?.toLowerCase().includes(q) ||
      u.username?.toLowerCase().includes(q) ||
      u.position?.toLowerCase().includes(q) ||
      u.title?.toLowerCase().includes(q) ||
      (u.assignedDepartments || [u.department]).join(' ').toLowerCase().includes(q)
    );

    return matchesDept && matchesRole && matchesSig && matchesSearch;
  });

  const totalPages = Math.ceil(filteredUsers.length / pageSize) || 1;
  const paginatedUsers = filteredUsers.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const handleOpenAdd = () => {
    if (!isAdmin) {
      return modalService.warning('ไม่มีสิทธิ์เข้าถึง', 'เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นที่สามารถเพิ่มผู้ใช้ได้');
    }
    setSelectedUser(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (user) => {
    if (!isAdmin) {
      return modalService.warning('ไม่มีสิทธิ์เข้าถึง', 'เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นที่สามารถแก้ไขผู้ใช้ได้');
    }
    setSelectedUser(user);
    setIsModalOpen(true);
  };

  const handleDeleteUser = async (user) => {
    if (user.roleId === 'ADMIN' || user.id === currentRole?.id) {
      return modalService.warning('ไม่สามารถลบได้', 'ไม่อนุญาตให้ลบบัญชีผู้ดูแลระบบ หรือบัญชีที่กำลังล็อกอินอยู่');
    }
    const confirmed = await modalService.confirm({
      title: 'ยืนยันการลบผู้ใช้',
      message: `คุณต้องการลบข้อมูลของ "${user.employeeName || user.name}" (${user.employeeId}) ออกจากระบบหรือไม่?`,
      type: 'danger',
      confirmText: 'ลบผู้ใช้',
      cancelText: 'ยกเลิก'
    });
    if (!confirmed) return;

    try {
      await apiService.deleteUser(user.id);
      await fetchUsers();
      if (onRefresh) onRefresh();
      modalService.success('ลบผู้ใช้เรียบร้อย');
    } catch (err) {
      modalService.error('ลบผู้ใช้ไม่สำเร็จ', err.message);
    }
  };

  // Metrics
  const totalCount = usersList.length;
  const signedCount = usersList.filter(u => u.signature && u.signature.length > 50).length;
  const pendingCount = totalCount - signedCount;

  return (
    <div className="w-full space-y-5 animate-fade-in">
      {/* ── Metric Summary Cards ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
        {/* Card 1: All Users */}
        <div className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-2xs flex items-start justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500">ผู้ใช้งานในระบบทั้งหมด</p>
            <div className="flex items-baseline gap-1.5 mt-2">
              <span className="text-2xl font-bold font-mono text-slate-900 tracking-tight">{totalCount}</span>
              <span className="text-xs font-medium text-slate-400">คน</span>
            </div>
          </div>
          <div className="w-9 h-9 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-100/60 shadow-2xs shrink-0">
            <Users className="w-4.5 h-4.5" />
          </div>
        </div>

        {/* Card 2: Registered E-Sig */}
        <div className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-2xs flex items-start justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500">ลงทะเบียนลายเซ็นแล้ว (E-Sig)</p>
            <div className="flex items-baseline gap-1.5 mt-2">
              <span className="text-2xl font-bold font-mono text-slate-900 tracking-tight">{signedCount}</span>
              <span className="text-xs font-medium text-slate-400">คน</span>
            </div>
          </div>
          <div className="w-9 h-9 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center border border-emerald-100/60 shadow-2xs shrink-0">
            <CheckCircle2 className="w-4.5 h-4.5" />
          </div>
        </div>

        {/* Card 3: Pending E-Sig */}
        <div className="bg-white border border-slate-200/80 rounded-2xl p-4 shadow-2xs flex items-start justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500">ยังไม่มีลายเซ็นดิจิทัล</p>
            <div className="flex items-baseline gap-1.5 mt-2">
              <span className="text-2xl font-bold font-mono text-slate-900 tracking-tight">{pendingCount}</span>
              <span className="text-xs font-medium text-slate-400">คน</span>
            </div>
          </div>
          <div className="w-9 h-9 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center border border-amber-100/60 shadow-2xs shrink-0">
            <PenTool className="w-4.5 h-4.5" />
          </div>
        </div>
      </div>

      {/* ── Control & Filter Bar ── */}
      <div className="bg-white p-2.5 rounded-2xl border border-slate-200/80 shadow-xs flex flex-col xl:flex-row items-stretch xl:items-center justify-between gap-3">
        {/* Left Side: Department Switcher + Secondary Filters */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* กลุ่มที่ 1: Department Switcher Capsule */}
          <div className="inline-flex items-center gap-1 bg-slate-100/80 p-1 rounded-xl overflow-x-auto custom-scrollbar">
            {[{ code: 'ALL', label: 'ทุกแผนก' }, ...departmentsList.filter(d => d.isActive).map(d => ({ code: d.code, label: d.code }))].map(dept => (
              <button
                key={dept.code}
                onClick={() => setDeptFilter(dept.code)}
                className={`h-7 px-2.5 rounded-lg text-xs font-semibold transition-all cursor-pointer whitespace-nowrap ${
                  deptFilter === dept.code 
                    ? 'bg-white text-slate-900 shadow-2xs font-bold' 
                    : 'text-slate-600 hover:text-slate-900 hover:bg-white/40'
                }`}
              >
                {dept.label}
              </button>
            ))}
          </div>

          <div className="h-5 w-px bg-slate-200 hidden sm:block" />

          {/* กลุ่มที่ 2: Secondary Dropdown Filters */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Role Filter */}
            <select
              value={roleFilter}
              onChange={e => setRoleFilter(e.target.value)}
              className="h-9 bg-slate-50 hover:bg-slate-100/80 border border-slate-200 rounded-xl px-3 text-xs font-semibold text-slate-700 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer transition-all"
            >
              <option value="ALL">ทุกบทบาทหน้าที่ (All Roles)</option>
              {ROLE_OPTIONS.map(r => (
                <option key={r.id} value={r.id}>{(r?.label || r?.id || '').split(' - ')[0]}</option>
              ))}
            </select>

            {/* Signature Filter */}
            <select
              value={sigFilter}
              onChange={e => setSigFilter(e.target.value)}
              className="h-9 bg-slate-50 hover:bg-slate-100/80 border border-slate-200 rounded-xl px-3 text-xs font-semibold text-slate-700 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer transition-all"
            >
              <option value="ALL">ทุกลายเซ็น (All)</option>
              <option value="HAS_SIG">✓ มีลายเซ็นดิจิทัลแล้ว</option>
              <option value="NO_SIG">⚠️ ยังไม่มีลายเซ็น</option>
            </select>
          </div>
        </div>

        {/* Right Side: Search & Actions */}
        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
          {/* กลุ่มที่ 3: Search Box */}
          <div className="relative min-w-[220px] flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              placeholder="ค้นหาชื่อ, รหัส, แผนก..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full h-9 bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-8 text-xs font-medium text-slate-800 placeholder-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
            />
            {searchQuery && (
              <button 
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 font-bold text-xs p-0.5 rounded-full cursor-pointer"
                title="ล้างคำค้นหา"
              >
                ✕
              </button>
            )}
          </div>

          {/* Refresh Button */}
          <button
            type="button"
            onClick={fetchUsers}
            disabled={isLoading}
            title="รีเฟรชข้อมูล"
            className="w-9 h-9 border border-slate-200 hover:bg-slate-50 text-slate-600 rounded-xl transition-all cursor-pointer flex items-center justify-center shrink-0 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-indigo-600' : ''}`} />
          </button>

          {/* Add User Button */}
          <button
            onClick={handleOpenAdd}
            className="h-9 px-4 bg-slate-900 hover:bg-slate-800 active:scale-95 text-white text-xs font-semibold rounded-xl flex items-center gap-2 shadow-xs transition-all cursor-pointer shrink-0"
          >
            <Plus className="w-4 h-4" />
            <span>เพิ่มผู้ใช้ใหม่</span>
          </button>
        </div>
      </div>

      {/* ── Users Table Card ── */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs sm:text-sm">
            <thead className="bg-slate-50/80 border-b border-slate-200/70 text-slate-500 font-bold text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-3.5 pl-5">รหัสพนักงาน</th>
                <th className="py-3.5 px-4">ชื่อ-นามสกุล / ข้อมูลผู้ใช้</th>
                <th className="py-3.5 px-3">ตำแหน่ง</th>
                <th className="py-3.5 px-3 text-center">แผนก</th>
                <th className="py-3.5 px-3">บทบาท (Role)</th>
                <th className="py-3.5 px-3 text-center">ตัวอย่างลายเซ็นดิจิทัล (E-Signature)</th>
                <th className="py-3.5 px-3 text-center">สถานะ</th>
                <th className="py-3.5 pr-5 text-right">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paginatedUsers.length === 0 ? (
                <tr>
                  <td colSpan="8" className="py-12 text-center text-slate-400">
                    <Users className="w-8 h-8 mx-auto text-slate-300 mb-2" />
                    <p className="font-semibold text-slate-600 text-sm">ไม่พบข้อมูลผู้ใช้งาน</p>
                    <p className="text-xs text-slate-400 mt-0.5">ลองปรับตัวกรองหรือล้างคำค้นหา</p>
                  </td>
                </tr>
              ) : (
                paginatedUsers.map(user => {
                  const roleCfg = ROLE_OPTIONS.find(r => r.id === user?.roleId) || {
                    label: user?.roleId || user?.role || user?.title || 'Staff',
                    color: 'bg-slate-100 text-slate-700 border-slate-200'
                  };
                  const hasSignature = Boolean(user.signature && user.signature.length > 50);

                  return (
                    <tr key={user.id} className="hover:bg-slate-50/80 transition-colors">
                      {/* 1. Employee ID */}
                      <td className="py-3.5 pl-5 font-mono text-xs font-bold text-slate-700">
                        <span className="bg-slate-100 px-2 py-1 rounded-md border border-slate-200/60">
                          {user.employeeId || '-'}
                        </span>
                      </td>

                      {/* 2. Full Name & Profile */}
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-2.5">
                          <div className="w-9 h-9 rounded-full bg-slate-100 border border-slate-200 text-slate-700 flex items-center justify-center font-bold text-xs shrink-0">
                            {user.name ? user.name.charAt(0) : <User className="w-4 h-4 text-slate-400" />}
                          </div>
                          <div className="min-w-0">
                            <p className="font-bold text-slate-900 text-xs sm:text-sm truncate">
                              {user.name || user.employeeName}
                            </p>
                            <p className="text-[11px] text-slate-400 font-mono mt-0.5">
                              @{user.username}
                            </p>
                          </div>
                        </div>
                      </td>

                      {/* 3. Position / Title */}
                      <td className="py-3.5 px-3 text-slate-700 font-medium text-xs">
                        {user.position || user.title || '-'}
                      </td>

                      {/* 4. Department(s) */}
                      <td className="py-3.5 px-3 text-center">
                        <div className="flex flex-wrap gap-1 justify-center">
                          {(() => {
                            const depts = Array.isArray(user.assignedDepartments) && user.assignedDepartments.length > 0
                              ? user.assignedDepartments
                              : [user.primaryDepartment || user.department].filter(Boolean);
                            const isAll = depts.includes('*') || depts.includes('ALL');
                            if (isAll) return (
                              <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full border bg-indigo-50 text-indigo-700 border-indigo-200">
                                <Building2 className="w-3 h-3" />ALL
                              </span>
                            );
                            return depts.map(d => (
                              <span key={d} className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full border bg-slate-100 text-slate-700 border-slate-200">
                                {d}
                              </span>
                            ));
                          })()}
                        </div>
                      </td>

                      {/* 5. Role */}
                      <td className="py-3.5 px-3">
                        <span className={`inline-block px-2.5 py-0.5 rounded-md text-[10.5px] font-bold border ${roleCfg?.color || 'bg-slate-100 text-slate-700 border-slate-200'}`}>
                          {((roleCfg?.label || user?.roleId || 'Staff') + '').split(' - ')[0]}
                        </span>
                      </td>

                      {/* 6. Signature Preview */}
                      <td className="py-3.5 px-3 text-center">
                        {hasSignature ? (
                          <div 
                            onClick={() => setPreviewingSig(user)}
                            className="inline-flex items-center gap-2 px-2.5 py-1 rounded-xl bg-slate-50 hover:bg-slate-100 border border-slate-200/80 cursor-pointer group transition-all"
                            title="คลิกเพื่อดูภาพขยายลายเซ็น"
                          >
                            <div className="w-14 h-7 bg-white rounded border border-slate-200/60 flex items-center justify-center p-0.5 overflow-hidden">
                              <img 
                                src={user.signature} 
                                alt="Signature" 
                                className="max-w-full max-h-full object-contain group-hover:scale-110 transition-transform" 
                              />
                            </div>
                            <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
                              ✓ มีลายเซ็น
                            </span>
                          </div>
                        ) : (
                          <button
                            onClick={() => handleOpenEdit(user)}
                            className="inline-flex items-center gap-1 text-[11px] text-amber-700 bg-amber-50 hover:bg-amber-100 px-2 py-1 rounded-lg border border-amber-200 transition-all cursor-pointer font-semibold"
                          >
                            <PenTool className="w-3 h-3" />
                            <span>+ เพิ่มลายเซ็น</span>
                          </button>
                        )}
                      </td>

                      {/* 7. Status */}
                      <td className="py-3.5 px-3 text-center">
                        <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${user.status === 'ACTIVE' ? 'bg-emerald-500' : 'bg-slate-300'}`}></span>
                        <span className="text-[11px] font-semibold text-slate-600">
                          {user.status === 'ACTIVE' ? 'ใช้งาน' : 'ระงับ'}
                        </span>
                      </td>

                      {/* 8. Actions */}
                      <td className="py-3.5 pr-5 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => handleOpenEdit(user)}
                            className="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all cursor-pointer"
                            title="แก้ไขข้อมูลและลายเซ็น"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteUser(user)}
                            disabled={user.roleId === 'ADMIN'}
                            className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg transition-all cursor-pointer"
                            title="ลบผู้ใช้"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={filteredUsers.length}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
          onPageSizeChange={setPageSize}
        />
      </div>

      {/* ── User & E-Signature CRUD Modal ── */}
      {isModalOpen && (
        <UserEditSignatureModal
          user={selectedUser}
          departments={departmentsList}
          onClose={() => setIsModalOpen(false)}
          onSaved={() => {
            setIsModalOpen(false);
            fetchUsers();
            if (onRefresh) onRefresh();
          }}
        />
      )}

      {/* ── Signature Large Zoom Modal ── */}
      {previewingSig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full border border-slate-200 shadow-2xl space-y-4 animate-zoom-in">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="flex items-center gap-2">
                <PenTool className="w-4 h-4 text-indigo-600" />
                <h4 className="font-bold text-slate-900 text-sm">ลายเซ็นดิจิทัล (Digital Signature)</h4>
              </div>
              <button 
                onClick={() => setPreviewingSig(null)}
                className="text-slate-400 hover:text-slate-700 p-1 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-1">
              <p className="text-xs font-semibold text-slate-700">{previewingSig.employeeName || previewingSig.name}</p>
              <p className="text-[11px] text-slate-400">{previewingSig.title} • {previewingSig.department}</p>
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex items-center justify-center min-h-[120px]">
              <img 
                src={previewingSig.signature} 
                alt="Signature Preview" 
                className="max-h-24 max-w-full object-contain"
              />
            </div>

            <div className="bg-emerald-50 text-emerald-800 border border-emerald-200 p-2.5 rounded-xl text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
              <span>ลายเซ็นนี้จะถูกประทับลงใน Audit Stamp ท้ายเอกสาร PO PDF อัตโนมัติ</span>
            </div>

            <button
              onClick={() => setPreviewingSig(null)}
              className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-semibold transition-all cursor-pointer"
            >
              ปิดหน้าต่าง
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * ── User & E-Signature CRUD Modal ──
 * User Add/Edit Modal with E-Signature Drawing & Upload
 */
function UserEditSignatureModal({ user, departments = [], onClose, onSaved }) {
  const isEdit = Boolean(user?.id);

  // Resolve initial assignedDepartments from user object
  const resolveInitialDepts = () => {
    if (Array.isArray(user?.assignedDepartments) && user.assignedDepartments.length > 0) {
      return user.assignedDepartments;
    }
    // Fallback: infer from allowedDepartments or primaryDepartment
    if (Array.isArray(user?.allowedDepartments) && user.allowedDepartments.length > 0) {
      if (user.allowedDepartments.includes('*') || user.allowedDepartments.includes('ALL')) {
        return ['ALL'];
      }
      return user.allowedDepartments;
    }
    const pd = user?.primaryDepartment || user?.department;
    if (pd && pd !== 'ALL' && pd !== '*') return [pd];
    if (pd === 'ALL' || pd === '*') return ['ALL'];
    return [];
  };

  // Form Fields
  const [employeeId, setEmployeeId] = useState(user?.employeeId || `EMP-${Date.now().toString().slice(-4)}`);
  const [name, setName] = useState(user?.name || '');
  const [employeeName, setEmployeeName] = useState(user?.employeeName || user?.name || '');
  const [username, setUsername] = useState(user?.username || '');
  const [password, setPassword] = useState(user?.password || '');
  const [position, setPosition] = useState(user?.position || user?.title || '');
  const [title, setTitle] = useState(user?.title || user?.position || '');
  const [assignedDepts, setAssignedDepts] = useState(resolveInitialDepts);
  const [roleId, setRoleId] = useState(normalizeRoleId(user?.roleId) || 'REQUESTER');
  const [status, setStatus] = useState(user?.status || 'ACTIVE');

  // Toggle a single dept in/out of assignedDepts array
  const toggleDept = (code) => {
    if (code === 'ALL') {
      setAssignedDepts(prev => prev.includes('ALL') ? [] : ['ALL']);
      return;
    }
    setAssignedDepts(prev => {
      const withoutAll = prev.filter(d => d !== 'ALL');
      if (withoutAll.includes(code)) {
        return withoutAll.filter(d => d !== code);
      }
      return [...withoutAll, code];
    });
  };

  // E-Signature State
  const [signatureDataUrl, setSignatureDataUrl] = useState(user?.signature || '');
  const [sigMode, setSigMode] = useState('DRAW'); // 'DRAW' or 'UPLOAD'
  const [penColor, setPenColor] = useState('#0F2370'); // Navy blue default
  const [penWidth, setPenWidth] = useState(2.5);
  const [isSaving, setIsSaving] = useState(false);
  const [hasDrawnOnCanvas, setHasDrawnOnCanvas] = useState(false);

  // Canvas Refs
  const canvasRef = useRef(null);
  const isDrawingRef = useRef(false);
  const lastPointRef = useRef({ x: 0, y: 0 });

  // Initialize Canvas
  useEffect(() => {
    if (sigMode !== 'DRAW') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // Smooth rendering
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = penColor;
    ctx.lineWidth = penWidth;
  }, [sigMode, penColor, penWidth]);

  // Canvas Drawing Handlers
  const startDrawing = (e) => {
    isDrawingRef.current = true;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    lastPointRef.current = {
      x: clientX - rect.left,
      y: clientY - rect.top
    };
  };

  const draw = (e) => {
    if (!isDrawingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const currentPoint = {
      x: clientX - rect.left,
      y: clientY - rect.top
    };

    ctx.beginPath();
    ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y);
    ctx.lineTo(currentPoint.x, currentPoint.y);
    ctx.strokeStyle = penColor;
    ctx.lineWidth = penWidth;
    ctx.stroke();

    lastPointRef.current = currentPoint;
    setHasDrawnOnCanvas(true);
  };

  const stopDrawing = () => {
    isDrawingRef.current = false;
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasDrawnOnCanvas(false);
  };

  const handleApplyCanvasSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!hasDrawnOnCanvas) {
      return modalService.warning('ยังไม่ได้วาดลายเซ็น', 'กรุณาวาดลายเซ็นลงบนกระดานก่อนบันทึก');
    }
    const dataUrl = canvas.toDataURL('image/png');
    setSignatureDataUrl(dataUrl);
    modalService.success('นำลายเซ็นไปใช้แล้ว', 'แปลงลายเซ็นเป็น Base64 เรียบร้อยแล้ว พร้อมบันทึก');
  };

  // Upload File Handler
  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      return modalService.warning('ไฟล์ไม่รองรับ', 'กรุณาเลือกไฟล์ภาพ PNG หรือ JPG');
    }

    if (file.size > 2 * 1024 * 1024) {
      return modalService.warning('ขนาดไฟล์เกิน', 'ขนาดภาพลายเซ็นไม่ควรเกิน 2MB');
    }

    const reader = new FileReader();
    reader.onload = (loadEvt) => {
      const result = loadEvt.target?.result;
      if (result) {
        setSignatureDataUrl(String(result));
        modalService.success('อัปโหลดรูปลายเซ็นแล้ว', 'พร้อมบันทึกลงในฐานข้อมูล');
      }
    };
    reader.readAsDataURL(file);
  };

  // Form Submit
  const handleSave = async (e) => {
    e.preventDefault();
    if (!name.trim() || !username.trim()) {
      return modalService.warning('ข้อมูลไม่ครบ', 'กรุณาระบุชื่อและ Username');
    }
    if (roleId !== 'ADMIN' && roleId !== 'PLANT_MANAGER' && roleId !== 'ONLINE_PURCHASER' && assignedDepts.length === 0) {
      return modalService.warning('ยังไม่ได้เลือกแผนก', 'กรุณาเลือกแผนกที่ผู้ใช้งานรับผิดชอบอย่างน้อย 1 แผนก');
    }

    // Derive primaryDepartment and allowedDepartments from assignedDepts
    const isAllDepts = assignedDepts.includes('ALL') || roleId === 'ADMIN' || roleId === 'PLANT_MANAGER' || roleId === 'ONLINE_PURCHASER';
    const defaultPrimaryDept = (roleId === 'ONLINE_PURCHASER') ? 'PUR' : (roleId === 'ADMIN' || roleId === 'PLANT_MANAGER') ? 'MGT' : (assignedDepts.find(d => d !== 'ALL') || 'MGT');
    const primaryDept = isAllDepts ? defaultPrimaryDept : (assignedDepts.find(d => d !== 'ALL') || defaultPrimaryDept);
    const finalAssigned = isAllDepts ? ['*'] : assignedDepts;
    const allowedForPerms = isAllDepts ? ['*'] : assignedDepts;
    const roleLevel = ROLE_OPTIONS.find(r => r.id === roleId)?.level || 1;

    setIsSaving(true);
    try {
      const payload = {
        ...(user || {}),
        id: user?.id || `USR-${Date.now().toString().slice(-4)}`,
        employeeId: employeeId.trim(),
        name: name.trim(),
        employeeName: employeeName.trim() || name.trim(),
        displayName: name.trim(),
        username: username.trim(),
        password: password || user?.password || '',
        position: position.trim(),
        title: position.trim() || title.trim() || (ROLE_OPTIONS.find(r => r.id === roleId)?.title || 'Officer'),
        primaryDepartment: primaryDept,
        department: primaryDept,
        assignedDepartments: finalAssigned,
        allowedDepartments: allowedForPerms,
        roleId,
        level: roleLevel,
        status,
        signature: signatureDataUrl || null,
        updatedAt: new Date().toISOString()
      };

      await apiService.saveUser(payload);
      modalService.success(
        isEdit ? 'แก้ไขข้อมูลผู้ใช้สำเร็จ' : 'เพิ่มผู้ใช้ใหม่สำเร็จ',
        `บันทึกข้อมูลและลายเซ็นของ "${payload.employeeName}" เรียบร้อยแล้ว`
      );
      onSaved();
    } catch (err) {
      modalService.error('เกิดข้อผิดพลาดในการบันทึก', err.message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-900/60 backdrop-blur-xs animate-fade-in overflow-y-auto">
      <div className="bg-white rounded-3xl border border-slate-200 max-w-2xl w-full shadow-2xl my-6 flex flex-col max-h-[92vh] overflow-hidden animate-zoom-in">
        {/* Modal Header */}
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0 bg-slate-50/70">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center shadow-xs">
              <Users className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">
                {isEdit ? 'แก้ไขข้อมูลผู้ใช้และลายเซ็นดิจิทัล' : 'เพิ่มผู้ใช้งานใหม่ (User Master)'}
              </h3>
              <p className="text-[11px] text-slate-500">
                จัดการข้อมูลระบุตัวตน สิทธิ์ในระบบ และลายเซ็นอิเล็กทรอนิกส์ (E-Signature Base64)
              </p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 p-1.5 rounded-xl hover:bg-slate-100 transition-all cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSave} className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar">
          {/* Section 1: General Info */}
          <div className="space-y-3.5">
            <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
              <UserCheck className="w-3.5 h-3.5 text-indigo-600" />
              <span>ข้อมูลทั่วไป (General Information)</span>
            </h4>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">รหัสพนักงาน</label>
                <input
                  type="text"
                  value={employeeId}
                  onChange={e => setEmployeeId(e.target.value)}
                  placeholder="เช่น EMP-PD-001"
                  required
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono font-semibold text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">ชื่อ-นามสกุล (จริง)</label>
                <input
                  type="text"
                  value={employeeName}
                  onChange={e => setEmployeeName(e.target.value)}
                  placeholder="เช่น คุณวิชัย สุขใจ"
                  required
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">ชื่อแสดงในระบบ (Display Name)</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="เช่น คุณวิชัย (PD)"
                  required
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">ชื่อผู้ใช้ (Username)</label>
                <input
                  type="text"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder="เช่น wichai.pd"
                  required
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">ตำแหน่ง (Position)</label>
                <input
                  type="text"
                  value={position}
                  onChange={e => {
                    setPosition(e.target.value);
                    setTitle(e.target.value);
                  }}
                  placeholder="เช่น วิศวกรฝ่ายผลิต หรือ เจ้าหน้าที่จัดซื้อ"
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-medium text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">สถานะผู้ใช้ (Account Status)</label>
                <select
                  value={status}
                  onChange={e => setStatus(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer"
                >
                  <option value="ACTIVE">เปิดใช้งาน (ACTIVE)</option>
                  <option value="INACTIVE">ระงับการใช้งาน (INACTIVE)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">รหัสผ่าน (Password)</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="รหัสผ่านเข้าใช้งาน"
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">บทบาทและสิทธิ์ในระบบ (Role & Permissions)</label>
                <select
                  value={roleId}
                  onChange={e => {
                    setRoleId(e.target.value);
                    const opt = ROLE_OPTIONS.find(r => r.id === e.target.value);
                    if (opt && !title) setTitle(opt.title);
                    // Auto-set ALL departments for admin/plant-mgr/purchaser roles
                    const newRole = e.target.value;
                    if (newRole === 'ADMIN' || newRole === 'PLANT_MANAGER' || newRole === 'ONLINE_PURCHASER') {
                      setAssignedDepts(['ALL']);
                    }
                  }}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer"
                >
                  {ROLE_OPTIONS.map(r => (
                    <option key={r.id} value={r.id}>{r.label}</option>
                  ))}
                </select>
              </div>

              {/* Multi-Select Department Assignment */}
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  แผนกที่รับผิดชอบ (Assigned Departments)
                  <span className="ml-1.5 text-[10px] font-normal text-slate-400">— เลือกได้หลายแผนก (Multi-select)</span>
                </label>
                <div className="flex flex-wrap gap-2 p-3 bg-slate-50 border border-slate-200 rounded-xl">
                  {/* ALL chip */}
                  <button
                    type="button"
                    onClick={() => toggleDept('ALL')}
                    className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                      assignedDepts.includes('ALL')
                        ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                        : 'bg-white text-slate-600 border-slate-300 hover:border-indigo-400 hover:text-indigo-700'
                    }`}
                  >
                    <Building2 className="w-3 h-3" />
                    ทุกแผนก (ALL)
                  </button>
                  {/* Per-department chips */}
                  {departments.filter(d => d.isActive).map(dept => (
                    <button
                      key={dept.code}
                      type="button"
                      onClick={() => toggleDept(dept.code)}
                      disabled={assignedDepts.includes('ALL')}
                      className={`px-3 py-1.5 rounded-xl border text-xs font-bold transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                        assignedDepts.includes(dept.code)
                          ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                          : 'bg-white text-slate-600 border-slate-300 hover:border-blue-400 hover:text-blue-700'
                      }`}
                    >
                      {dept.code}
                      <span className="ml-1 font-normal opacity-80 text-[10px]">({dept.name})</span>
                    </button>
                  ))}
                  {assignedDepts.length === 0 && (
                    <span className="text-[11px] text-amber-600 font-medium flex items-center gap-1">
                      ⚠️ กรุณาเลือกแผนกที่รับผิดชอบ
                    </span>
                  )}
                </div>
                {assignedDepts.length > 0 && !assignedDepts.includes('ALL') && (
                  <p className="text-[11px] text-slate-500 mt-1.5 pl-1">
                    เลือกแล้ว: <span className="font-semibold text-indigo-700">{assignedDepts.join(', ')}</span>
                  </p>
                )}
              </div>
            </div>
          </div>

          <hr className="border-slate-100" />

          {/* Section 2: E-Signature Management */}
          <div className="space-y-3.5">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
                <PenTool className="w-3.5 h-3.5 text-indigo-600" />
                <span>ลายเซ็นดิจิทัล (E-Signature Base64)</span>
              </h4>

              {/* Mode Switcher */}
              <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
                <button
                  type="button"
                  onClick={() => setSigMode('DRAW')}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                    sigMode === 'DRAW'
                      ? 'bg-white text-slate-900 shadow-xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <PenTool className="w-3 h-3" />
                  <span>วาดสด (Canvas Pad)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setSigMode('UPLOAD')}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                    sigMode === 'UPLOAD'
                      ? 'bg-white text-slate-900 shadow-xs font-bold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Upload className="w-3 h-3" />
                  <span>อัปโหลดไฟล์ (PNG/JPG)</span>
                </button>
              </div>
            </div>

            {/* Mode A: Canvas Drawing Pad */}
            {sigMode === 'DRAW' && (
              <div className="border border-slate-200 rounded-2xl p-3 bg-slate-50/50 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap text-xs text-slate-600">
                  <div className="flex items-center gap-3">
                    {/* Pen Color Choices */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-semibold text-slate-500">หมึกปากกา:</span>
                      {[
                        { color: '#0F2370', name: 'น้ำเงินกรมท่า' },
                        { color: '#1E293B', name: 'ดำสนิท' },
                        { color: '#2563EB', name: 'น้ำเงินสด' },
                      ].map(c => (
                        <button
                          key={c.color}
                          type="button"
                          onClick={() => setPenColor(c.color)}
                          style={{ backgroundColor: c.color }}
                          className={`w-5 h-5 rounded-full border transition-all cursor-pointer ${
                            penColor === c.color ? 'ring-2 ring-indigo-500 ring-offset-1 scale-110' : 'border-slate-300'
                          }`}
                          title={c.name}
                        />
                      ))}
                    </div>

                    {/* Pen Width */}
                    <div className="flex items-center gap-1.5 ml-2">
                      <span className="text-[11px] font-semibold text-slate-500">ขนาด:</span>
                      {[1.5, 2.5, 3.5].map(w => (
                        <button
                          key={w}
                          type="button"
                          onClick={() => setPenWidth(w)}
                          className={`px-2 py-0.5 rounded text-[10px] font-mono transition-all cursor-pointer ${
                            penWidth === w ? 'bg-indigo-600 text-white font-bold' : 'bg-slate-200 text-slate-700'
                          }`}
                        >
                          {w === 1.5 ? 'บาง' : w === 2.5 ? 'กลาง' : 'หนา'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={clearCanvas}
                    className="flex items-center gap-1 text-[11px] text-rose-600 hover:text-rose-700 bg-white hover:bg-rose-50 border border-rose-200 px-2.5 py-1 rounded-lg transition-all cursor-pointer"
                  >
                    <Eraser className="w-3 h-3" />
                    <span>ล้างกระดาน</span>
                  </button>
                </div>

                {/* Drawing Surface */}
                <div className="relative bg-white rounded-xl border border-slate-300 overflow-hidden shadow-inner cursor-crosshair">
                  <canvas
                    ref={canvasRef}
                    width={480}
                    height={140}
                    onMouseDown={startDrawing}
                    onMouseMove={draw}
                    onMouseUp={stopDrawing}
                    onMouseLeave={stopDrawing}
                    onTouchStart={startDrawing}
                    onTouchMove={draw}
                    onTouchEnd={stopDrawing}
                    className="w-full h-[140px] touch-none block"
                  />
                  {!hasDrawnOnCanvas && (
                    <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center text-slate-300 select-none">
                      <PenTool className="w-6 h-6 mb-1 opacity-50" />
                      <p className="text-xs font-medium">ใช้เมาส์หรือนิ้ววาดลายเซ็นสดที่นี่</p>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-slate-400">
                    * เมื่อวาดเสร็จให้กดปุ่ม "บันทึกลายเซ็นจากกระดาน" ด้านขวา
                  </span>
                  <button
                    type="button"
                    onClick={handleApplyCanvasSignature}
                    className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-xl flex items-center gap-1.5 shadow-xs transition-all cursor-pointer"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>บันทึกลายเซ็นจากกระดาน</span>
                  </button>
                </div>
              </div>
            )}

            {/* Mode B: Upload Image File */}
            {sigMode === 'UPLOAD' && (
              <div className="border-2 border-dashed border-slate-300 hover:border-indigo-400 rounded-2xl p-5 text-center bg-slate-50/60 transition-all">
                <input
                  type="file"
                  id="sig-file-upload"
                  accept="image/png, image/jpeg, image/jpg"
                  onChange={handleFileUpload}
                  className="hidden"
                />
                <label 
                  htmlFor="sig-file-upload"
                  className="cursor-pointer flex flex-col items-center justify-center gap-2"
                >
                  <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-100">
                    <Upload className="w-6 h-6" />
                  </div>
                  <div>
                    <p className="text-xs font-bold text-slate-800">คลิกเพื่อเลือกไฟล์ภาพลายเซ็น (PNG หรือ JPG)</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">แนะนำไฟล์ PNG พื้นหลังโปร่งใส เพื่อความสวยงามบนเอกสาร PDF</p>
                  </div>
                </label>
              </div>
            )}

            {/* Current Signature Display Box */}
            <div className="mt-3 p-3.5 bg-slate-50 border border-slate-200 rounded-2xl space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                  <span>ลายเซ็นที่ใช้งานอยู่ในระบบ (Active Signature Preview):</span>
                </span>
                {signatureDataUrl && (
                  <button
                    type="button"
                    onClick={() => setSignatureDataUrl('')}
                    className="text-rose-600 hover:text-rose-700 text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>ลบลายเซ็น</span>
                  </button>
                )}
              </div>

              {signatureDataUrl ? (
                <div className="bg-white border border-slate-200 rounded-xl p-3 flex items-center justify-between gap-4">
                  <div className="flex items-center justify-center bg-slate-100/60 p-2 rounded-lg min-w-[140px] max-w-[200px] border border-slate-200/60">
                    <img 
                      src={signatureDataUrl} 
                      alt="Current Signature" 
                      className="max-h-16 max-w-full object-contain"
                    />
                  </div>
                  <div className="flex-1 min-w-0 text-left">
                    <span className="inline-block px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded text-[10px] font-bold">
                      ✓ E-Signature Verified
                    </span>
                    <p className="text-[11px] text-slate-500 mt-1">
                      ลายเซ็นดิจิทัลพร้อมประทับลงบนกล่อง Audit Stamp ของเอกสาร PO PDF (ระบบจะสแกนและใส่ ISO Hash ให้โดยอัตโนมัติ)
                    </p>
                  </div>
                </div>
              ) : (
                <div className="py-5 text-center text-slate-400 bg-white rounded-xl border border-dashed border-slate-200">
                  <AlertCircle className="w-5 h-5 mx-auto mb-1 text-amber-500" />
                  <p className="text-xs font-medium text-slate-600">ยังไม่ได้ลงทะเบียนลายเซ็นดิจิทัล</p>
                  <p className="text-[11px] text-slate-400">กรุณาวาดลายเซ็นหรืออัปโหลดไฟล์ภาพเพื่อนำไปใช้งานบน PO PDF</p>
                </div>
              )}
            </div>
          </div>

          {/* Modal Footer Buttons */}
          <div className="flex items-center justify-end gap-2.5 pt-4 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-semibold transition-all cursor-pointer"
            >
              ยกเลิก
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 active:scale-95 disabled:opacity-60 text-white rounded-xl text-xs font-semibold shadow-sm transition-all cursor-pointer flex items-center gap-2"
            >
              {isSaving ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>กำลังบันทึก...</span>
                </>
              ) : (
                <>
                  <Check className="w-4 h-4" />
                  <span>{isEdit ? 'บันทึกการแก้ไข' : 'สร้างผู้ใช้ใหม่'}</span>
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
