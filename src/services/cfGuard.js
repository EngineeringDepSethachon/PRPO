/**
 * Cloudflare-mode guards: no silent fallback to localStorage, no swallowed API errors.
 *
 * - mock / gas modes: every helper degrades to the legacy best-effort behaviour.
 * - cloudflare mode: failed core writes THROW (and are shown through the existing
 *   modalService.error), and local state touched by the failed action is rolled back.
 *   Secondary fire-and-forget syncs only console.warn.
 */
import { backendFetch, isCloudflareMode } from '../config/backendMode.js';
import { modalService } from './modalService';
import { storageService } from './storageService';

const readErrorMessage = async (res, fallback) => {
  try {
    const body = await res.json();
    const msg = body && (body.error || body.message);
    if (msg) return String(msg);
  } catch { /* non-JSON body */ }
  return fallback;
};

/** Throws (cloudflare mode only) when the response is missing or not ok. */
export const cfAssertOk = async (res, title = 'บันทึกข้อมูลไม่สำเร็จ') => {
  if (!isCloudflareMode()) return res;
  if (res && res.ok) return res;
  const status = res ? res.status : 0;
  const msg = res ? await readErrorMessage(res, `${title} (HTTP ${status})`) : title;
  const err = new Error(msg);
  err.status = status;
  throw err;
};

let reloadHandler = null;
/** AppContext registers a "reload from server" callback; returns an unregister fn. */
export const setCfReloadHandler = (fn) => {
  reloadHandler = fn;
  return () => { if (reloadHandler === fn) reloadHandler = null; };
};

/**
 * Hand back a well-formed Error for `throw`. The modal is NOT opened here: the caller's own catch
 * shows it (same UX as GAS). As a safety net for callers that show nothing, an automatic modal is
 * scheduled for the next tick; modalService.error drops it (cfAuto) if a modal was already shown.
 */
export const cfReport = (err, title = 'บันทึกข้อมูลไม่สำเร็จ') => {
  const e = err instanceof Error ? err : new Error(String(err));
  if (!e.cfReported) {
    e.cfReported = true;
    e.cfTitle = title;
    setTimeout(() => {
      try { modalService.error(title, e.message, { cfAuto: true }); } catch { /* UI optional */ }
    }, 0);
  }
  return e;
};

// Server routes that skip rows of other departments and answer `{ skipped: [...] }` (cloudflare mode only)
const SKIPPING_RE = /^\/api\/(products\/batch|stock-logs)(\?|$)/;
let skippedCount = 0;
let skippedTimer = null;
/**
 * cloudflare mode : when a write response lists `skipped` rows, tell the user with the existing warning modal.
 * Notices raised in the same moment (products/batch + stock-logs together) are merged into one modal. Never throws.
 */
export const cfNoticeSkipped = async (input, res) => {
  try {
    if (!isCloudflareMode() || !res || !res.ok || typeof input !== 'string' || !SKIPPING_RE.test(input)) return;
    if (typeof res.clone !== 'function') return;
    const body = await res.clone().json().catch(() => null);
    const n = body && Array.isArray(body.skipped) ? body.skipped.length : 0;
    if (!n) return;
    skippedCount += n;
    if (skippedTimer) return;
    skippedTimer = setTimeout(() => {
      const total = skippedCount;
      skippedCount = 0;
      skippedTimer = null;
      try { modalService.warning('แจ้งเตือน', `มีรายการของแผนกอื่น ${total} รายการที่ไม่ได้บันทึก`); } catch { /* UI optional */ }
    }, 300);
  } catch { /* notice is best effort */ }
};

/**
 * Core write. cloudflare: ok-check + throw + modal. other modes: legacy best-effort
 * (network errors swallowed, resolves to the Response or null).
 */
export const cfWrite = async (title, input, init) => {
  if (isCloudflareMode()) {
    try {
      const res = await backendFetch(input, init);
      await cfAssertOk(res, title);
      await cfNoticeSkipped(input, res);
      return res;
    } catch (e) {
      throw cfReport(e, title);
    }
  }
  try {
    return await backendFetch(input, init);
  } catch {
    // mock / gas: legacy best-effort behaviour (offline dev server is fine)
    return null;
  }
};

/**
 * Secondary fire-and-forget request (ledger sync, reconcile, notifications ...).
 * Never throws. cloudflare: console.warn on any failure. other modes: legacy silent.
 * Returns a promise that always resolves.
 */
export const cfBackground = (label, input, init) => {
  let p;
  try {
    p = Promise.resolve(backendFetch(input, init));
  } catch (e) {
    if (isCloudflareMode()) console.warn(`[cloudflare] ${label} failed:`, e && e.message);
    return Promise.resolve(null);
  }
  return p.then((res) => {
    if (isCloudflareMode() && res && !res.ok) {
      console.warn(`[cloudflare] ${label} failed: HTTP ${res.status}`);
    }
    if (isCloudflareMode() && res && res.ok) return cfNoticeSkipped(input, res).then(() => res);
    return res;
  }).catch((e) => {
    if (isCloudflareMode()) console.warn(`[cloudflare] ${label} failed:`, e && e.message);
    return null;
  });
};

/**
 * Run `fn`; in cloudflare mode restore local storage to its pre-action state if it throws.
 */
export const withCfRollback = async (fn) => {
  if (!isCloudflareMode()) return fn();
  let snap = null;
  try { snap = storageService.snapshotState(); } catch { snap = null; }
  try {
    return await fn();
  } catch (e) {
    try { if (snap) storageService.restoreState(snap); } catch { /* best effort */ }
    // Re-sync UI state from the server so stale optimistic data does not linger
    try {
      const r = reloadHandler && reloadHandler();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch { /* best effort */ }
    throw e;
  }
};
