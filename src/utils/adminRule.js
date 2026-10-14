// Single place for "is this user an administrator" on the client.
//
// Cloudflare mode : exactly the server rule (functions/_lib/rbac.js normalizeUser, T4.6) - level >= 99 OR roleId === 'ADMIN' (the server also sends
//   isAdmin in the login response). A username 'admin', a title / positionKey / canonicalRole that merely contains the word ADMIN, or a
//   lower-case legacy role === 'admin' do NOT make an admin, so the UI never offers what the server will refuse.
// mock / gas mode : unchanged - the caller passes the legacy expression it always used (`legacy`), because those backends have no server-side rule
//   and their sample / sheet users may rely on username 'admin' or on role text.
import { isCloudflareMode } from '../config/backendMode';

export function isAdminUser(user, legacy = false) {
  if (!user) return false;
  if (isCloudflareMode()) {
    const roleId = String(user.roleId || user.role_id || user.id || '').toUpperCase(); // role objects carry the role id in `id`
    return user.isAdmin === true || Number(user.level) >= 99 || roleId === 'ADMIN';
  }
  return Boolean(legacy);
}
