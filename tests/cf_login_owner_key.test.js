import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import './setup.js';

// Real authService.login (cloudflare) : session.id is overwritten by the role id, so the cache owner key must come from userId, never id.
const loginAs = async (user) => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
  global.fetch = vi.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ token: `tok-${user.id}`, user })
  });
  const { authService } = await import('../src/services/authService.js');
  const { sessionOwnerKey } = await import('../src/config/backendMode.js');
  const session = await authService.login(user.username, 'secret-pass');
  return { session, key: sessionOwnerKey(session), sessionOwnerKey };
};
const USER = (id, username) => ({
  id, username, employeeId: `E-${id}`, name: username, roleId: 'REQUESTER_PD', department: 'PD', level: 1
});

describe('cloudflare login : cache owner key identifies the user, not the role', () => {
  const originalFetch = global.fetch;
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { global.fetch = originalFetch; vi.unstubAllEnvs(); });

  it('owner key = users.id even though session.id is the role id', async () => {
    const { session, key } = await loginAs(USER('U-100', 'somchai'));
    expect(session.userId).toBe('U-100');
    expect(key).toBe('U-100');
    expect(key).not.toBe(session.roleId);
  });

  it('two users with the same role get different keys', async () => {
    const a = await loginAs(USER('U-100', 'somchai'));
    const b = await loginAs(USER('U-200', 'somying'));
    expect(a.session.roleId).toBe(b.session.roleId);
    expect(a.key).not.toBe(b.key);
    expect(a.key).toBeTruthy();
    expect(b.key).toBeTruthy();
  });

  it('a session stored without userId falls back to username (never the role id)', async () => {
    const { sessionOwnerKey } = await loginAs(USER('U-100', 'somchai'));
    expect(sessionOwnerKey({ id: 'REQUESTER_PD', username: 'somying' })).toBe('somying');
    expect(sessionOwnerKey({ id: 'REQUESTER_PD' })).toBe('');
  });
});
