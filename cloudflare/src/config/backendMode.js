/**
 * Backend mode selector (single source of truth).
 *
 * VITE_BACKEND_MODE = mock | gas | cloudflare
 *
 * When VITE_BACKEND_MODE is NOT set, legacy auto-detection is preserved:
 *   - 'gas'  if VITE_USE_GAS === 'true' or window.google.script.run exists
 *   - 'mock' otherwise (local express/mock server at /api/*, localStorage fallback)
 */

export const BACKEND_MODES = Object.freeze({
  MOCK: 'mock',
  GAS: 'gas',
  CLOUDFLARE: 'cloudflare'
});

const VALID_MODES = Object.values(BACKEND_MODES);
const AUTH_SESSION_KEY = 'prpo_auth_session';

const readEnvMode = () => {
  if (typeof import.meta === 'undefined') return '';
  return String(import.meta.env?.VITE_BACKEND_MODE || '').trim().toLowerCase();
};

const detectGASRuntime = () => {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_USE_GAS === 'true') {
    return true;
  }
  return (
    typeof window !== 'undefined' &&
    typeof window.google !== 'undefined' &&
    typeof window.google.script !== 'undefined' &&
    typeof window.google.script.run !== 'undefined'
  );
};

/** Returns 'mock' | 'gas' | 'cloudflare'. Evaluated at call time. */
export const getBackendMode = () => {
  const explicit = readEnvMode();
  if (VALID_MODES.includes(explicit)) return explicit;
  return detectGASRuntime() ? BACKEND_MODES.GAS : BACKEND_MODES.MOCK;
};

export const isGASMode = () => getBackendMode() === BACKEND_MODES.GAS;
export const isCloudflareMode = () => getBackendMode() === BACKEND_MODES.CLOUDFLARE;
export const isMockMode = () => getBackendMode() === BACKEND_MODES.MOCK;

/** Bearer token stored with the auth session (set by /api/auth login), or ''. */
export const getAuthToken = () => {
  try {
    if (typeof localStorage === 'undefined') return '';
    const raw = localStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) return '';
    const session = JSON.parse(raw);
    return (session && typeof session.token === 'string') ? session.token : '';
  } catch {
    return '';
  }
};

/**
 * fetch wrapper: in cloudflare mode adds `Authorization: Bearer <token>` when a
 * token exists. In other modes it is a plain pass-through to fetch.
 */
export const SESSION_INVALID_EVENT = 'prpo_session_invalid';

/**
 * cloudflare mode : a 401 on a call that carried our token means the server no longer accepts it (password changed / reset elsewhere,
 * account closed, expired). Tell the app once so it can ask the user to sign in again. Never fires for login calls or token-less calls.
 */
const notifyIfSessionInvalid = (res, input, tokenUsed) => {
  try {
    if (res && res.status === 401 && typeof window !== 'undefined' && !/^\/api\/(auth|login)(\/|$|\?)/.test(String(input))) {
      // the event carries the token that was sent and the server's reason code (TOKEN_EXPIRED / TOKEN_REVOKED / TOKEN_INVALID), read without
      // delaying or consuming the caller's response
      Promise.resolve().then(async () => {
        let code = '';
        try {
          if (typeof res.clone === 'function') { const b = await res.clone().json(); code = (b && typeof b.code === 'string') ? b.code : ''; }
        } catch { /* body is optional */ }
        window.dispatchEvent(new CustomEvent(SESSION_INVALID_EVENT, { detail: { token: tokenUsed, code } }));
      });
    }
  } catch { /* notification is best effort */ }
  return res;
};

const readStoredSession = () => {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(AUTH_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

/**
 * Several tabs share one stored session. True when the stored session carries a DIFFERENT token than `token` (another tab signed in again or changed
 * the password after this tab's state was built) : this tab must neither remove nor overwrite that newer session.
 */
export const storedSessionBelongsToOther = (token) => {
  if (!isCloudflareMode() || !token) return false;
  const stored = readStoredSession();
  return Boolean(stored && typeof stored.token === 'string' && stored.token && stored.token !== token);
};

/** cloudflare mode : give back `session` carrying the newest stored token (never write an older token over a newer one). */
export const withLatestStoredToken = (session) => {
  if (!isCloudflareMode() || !session || !storedSessionBelongsToOther(session.token)) return session;
  const stored = readStoredSession();
  return { ...session, token: stored.token, mustChangePassword: stored.mustChangePassword === true, expiresAt: stored.expiresAt ?? session.expiresAt };
};

export { readStoredSession };

/**
 * cloudflare mode : stable per-user key identifying whose data the client cache holds.
 * NOT session.id : in a login session `id` is overwritten by the role id (rolePermissions.id), so users of one role would share it.
 * userId (users.id, set at login) -> username -> employeeId.
 */
export const sessionOwnerKey = (session) => {
  if (!session || typeof session !== 'object') return '';
  const k = session.userId || session.username || session.employeeId || '';
  return String(k).trim();
};

export const SESSION_GONE_EVENT = 'prpo_session_gone';

/** cloudflare mode : no stored session any more (another tab signed out). A revalidation must not write one back. */
export const isStoredSessionGone = () => isCloudflareMode() && readStoredSession() === null;

/** Announce that the stored session is gone so AuthContext drops this tab's state (back to the login page). */
export const announceSessionGone = () => {
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(SESSION_GONE_EVENT));
  } catch { /* best effort */ }
};

export const backendFetch = (input, init) => {
  if (!isCloudflareMode()) return fetch(input, init);
  const token = getAuthToken();
  if (!token) return fetch(input, init);
  const headers = new Headers((init && init.headers) || undefined);
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  const p = fetch(input, { ...(init || {}), headers });
  return p && typeof p.then === 'function' ? p.then((res) => notifyIfSessionInvalid(res, input, token)) : p;
};

/** Replace the stored session token (and mustChangePassword flag) after a successful password change. Returns the updated session or null. */
export const updateStoredSessionToken = (token, mustChangePassword = false) => {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) return null;
    const session = { ...JSON.parse(raw), token, mustChangePassword: Boolean(mustChangePassword) };
    const json = JSON.stringify(session);
    localStorage.setItem(AUTH_SESSION_KEY, json);
    localStorage.setItem('prpo_auth_session', json);
    return session;
  } catch {
    return null;
  }
};
