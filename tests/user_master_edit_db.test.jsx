import { describe, it, expect, beforeEach, vi } from 'vitest';
import './setup.js';
import { apiService } from '../src/services/apiService';
import { storageService } from '../src/services/storageService';

describe('User Master Edit & Persistence Suite', () => {
  const initialUsers = [
    {
      id: 'USR-0001',
      employeeId: 'EMP-PD-001',
      username: 'wichai.pd',
      name: 'คุณวิชัย (PD)',
      employeeName: 'คุณวิชัย สุขใจ',
      displayName: 'Wichai (PD)',
      position: 'เจ้าหน้าที่ฝ่ายผลิต',
      department: 'PD',
      primaryDepartment: 'PD',
      allowedDepartments: ['PD'],
      assignedDepartments: ['PD'],
      roleId: 'REQUESTER_PD',
      level: 1,
      status: 'ACTIVE'
    },
    {
      id: 'USR-0002',
      employeeId: 'EMP-QC-001',
      username: 'somying.qc',
      name: 'คุณสมหญิง (QC)',
      employeeName: 'คุณสมหญิง รักดี',
      displayName: 'Somying (QC)',
      position: 'เจ้าหน้าที่ฝ่ายควบคุมคุณภาพ',
      department: 'QC',
      primaryDepartment: 'QC',
      allowedDepartments: ['QC'],
      assignedDepartments: ['QC'],
      roleId: 'REQUESTER_QC',
      level: 1,
      status: 'ACTIVE'
    }
  ];

  beforeEach(() => {
    localStorage.clear();
    storageService.saveUsers(initialUsers);
    vi.restoreAllMocks();
  });

  it('1. Updates username properly on API success and replaces old user record in memory & storage', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn().mockImplementation(async (url, opts) => {
      expect(url).toContain('/api/users/USR-0001');
      expect(opts.method).toBe('PUT');
      const body = JSON.parse(opts.body);
      expect(body.username).toBe('wichai_new');
      return {
        ok: true,
        json: async () => ({
          ...body,
          id: 'USR-0001',
          username: 'wichai_new',
          updatedAt: new Date().toISOString()
        })
      };
    });
    global.fetch = fetchMock;

    const payload = {
      ...initialUsers[0],
      username: 'wichai_new'
    };

    const saved = await apiService.saveUser(payload, 'Admin');
    expect(saved.username).toBe('wichai_new');

    const updatedUsers = storageService.getUsers();
    expect(updatedUsers).toHaveLength(2);
    const updatedUser = updatedUsers.find(u => u.id === 'USR-0001');
    expect(updatedUser).toBeDefined();
    expect(updatedUser.username).toBe('wichai_new');
    expect(updatedUsers.some(u => u.username === 'wichai.pd')).toBe(false);

    global.fetch = originalFetch;
  });

  it('2. Updates password and preserves password in payload on save', async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn().mockImplementation(async (url, opts) => {
      const body = JSON.parse(opts.body);
      expect(body.password).toBe('NewSecretPassword999');
      return {
        ok: true,
        json: async () => ({
          ...body,
          // Server deletes password in formatSafeUser
          password: undefined
        })
      };
    });
    global.fetch = fetchMock;

    const payload = {
      ...initialUsers[0],
      password: 'NewSecretPassword999'
    };

    const saved = await apiService.saveUser(payload, 'Admin');
    expect(saved.password).toBe('NewSecretPassword999');

    const updatedUsers = storageService.getUsers();
    const updatedUser = updatedUsers.find(u => u.id === 'USR-0001');
    expect(updatedUser.password).toBe('NewSecretPassword999');

    global.fetch = originalFetch;
  });

  it('3. Throws when server returns 400 Duplicate username error', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Username "somying.qc" มีอยู่ในระบบแล้ว กรุณาใช้ชื่ออื่น' })
    });

    const payload = {
      ...initialUsers[0],
      username: 'somying.qc'
    };

    await expect(apiService.saveUser(payload)).rejects.toThrow('มีอยู่ในระบบแล้ว');
    global.fetch = originalFetch;
  });

  it('4. Replaces active session in localStorage if current logged-in user is updated', async () => {
    localStorage.setItem('prpo_auth_session', JSON.stringify({
      id: 'USR-0001',
      username: 'wichai.pd',
      name: 'คุณวิชัย (PD)'
    }));

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'USR-0001',
        username: 'wichai_renamed',
        name: 'คุณวิชัย อัปเดต'
      })
    });

    await apiService.saveUser({
      ...initialUsers[0],
      username: 'wichai_renamed',
      name: 'คุณวิชัย อัปเดต'
    });

    const session = JSON.parse(localStorage.getItem('prpo_auth_session'));
    expect(session.username).toBe('wichai_renamed');
    expect(session.name).toBe('คุณวิชัย อัปเดต');

    global.fetch = originalFetch;
  });

  it('5. Offline fallback succeeds and updates storage when network fails with TypeError', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const payload = {
      ...initialUsers[0],
      position: 'Senior Production Supervisor'
    };

    const saved = await apiService.saveUser(payload);
    expect(saved.position).toBe('Senior Production Supervisor');

    const users = storageService.getUsers();
    const user = users.find(u => u.id === 'USR-0001');
    expect(user.position).toBe('Senior Production Supervisor');

    global.fetch = originalFetch;
  });
});
