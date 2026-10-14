// Cloudflare-mode end-to-end on the local machine : built SPA (dist, build:cf) + real Pages Functions + local D1 (wrangler pages dev).
// The business steps are driven over real HTTP against the running functions with the role tokens that /api/auth/login issues
// (the same calls apiService/workflowEngine make) ; the UI is used for login, lockout, bootstrap rendering and the PR list.
import { test, expect } from '@playwright/test';
import { USERS, PASSWORD } from './seed.mjs';

const YEAR = new Date().getFullYear();
const tokens = {};
const state = {};
// 1x1 PNG as a data URL (small inline attachment ; the Drive upload route needs a real Google service account and is not exercised locally)
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function login(request, who, password = PASSWORD) {
  return request.post('/api/auth/login', { data: { username: USERS[who].username, password } });
}
const api = (request, who) => async (method, url, data) => {
  const res = await request.fetch(url, { method, data, headers: { Authorization: `Bearer ${tokens[who]}` } });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status(), body };
};

test.skip(!process.env.CF_E2E, 'Cloudflare e2e : run with npm run test:e2e:cf');
test.describe.configure({ mode: 'serial' });

test('1 login (API) : every role gets a token ; wrong password -> 401 ; no token -> 401', async ({ request }) => {
  for (const who of ['L1', 'L2', 'L3', 'ONLINE']) {
    const r = await login(request, who);
    expect(r.status(), who).toBe(200);
    const j = await r.json();
    expect(j.success).toBe(true);
    expect(j.user.password).toBeUndefined();
    tokens[who] = j.token;
  }
  expect((await login(request, 'L1', 'wrong-password')).status()).toBe(401);
  expect((await request.get('/api/bootstrap')).status()).toBe(401);
  const boot = await api(request, 'L1')('GET', '/api/bootstrap');
  expect(boot.status).toBe(200);
  expect(boot.body.products.map((p) => p.id)).toContain('E2E-P1');
  expect(boot.body.budgets.PD).toMatchObject({ monthlyBudget: 100000, spent: 1000 });
});

test('2 PR : L1 creates + submits (small image attached) -> L2 reviews -> L3 approves (PR_COMMITMENT) -> PO issued', async ({ request }) => {
  const L1 = api(request, 'L1'); const L2 = api(request, 'L2'); const L3 = api(request, 'L3');
  const items = [{ productId: 'E2E-P1', id: 'E2E-P1', code: 'E2E-P1', name: 'จาระบี E2E', qty: 2, purchaseQty: 2, price: 100, unit: 'กระป๋อง' }];
  const created = await L1('POST', '/api/prs', {
    id: 'PR-E2E-1', department: 'PD', status: 'SUBMITTED', items, totalAmount: 200, reason: 'e2e flow',
    attachments: [{ name: 'tiny.png', type: 'image/png', dataUrl: TINY_PNG }],
    timeline: [{ action: 'สร้างและส่ง PR', user: 'E2E Requester' }]
  });
  expect(created.status).toBe(200);
  expect(created.body.prNo).toMatch(new RegExp(`^PD\\d{3}/${YEAR}$`));
  state.prNo = created.body.prNo;

  // attachment survives the round trip through D1
  const boot1 = await L1('GET', '/api/bootstrap');
  const pr = boot1.body.prs.find((p) => p.id === 'PR-E2E-1');
  expect(pr.status).toBe('SUBMITTED');
  expect(pr.attachments[0].dataUrl).toBe(TINY_PNG);

  // requester cannot approve its own PR (checked here too, before review)
  expect((await L1('PUT', '/api/prs/PR-E2E-1', { status: 'REVIEWED' })).status).toBe(403);
  expect((await L2('PUT', '/api/prs/PR-E2E-1', { status: 'REVIEWED' })).status).toBe(200);
  expect((await L2('PUT', '/api/prs/PR-E2E-1', { status: 'PO_ISSUED' })).status).toBe(403); // L2 is not an approver
  expect((await L1('PUT', '/api/prs/PR-E2E-1', { status: 'PO_ISSUED' })).status).toBe(403);
  expect((await L3('PUT', '/api/prs/PR-E2E-1', { status: 'PO_ISSUED' })).status).toBe(200);

  const po = await L3('POST', '/api/pos', {
    id: 'PO-E2E-1', prId: 'PR-E2E-1', prNumber: state.prNo, department: 'PD', vendorName: 'E2E Vendor', status: 'ISSUED',
    items: items.map((i) => ({ ...i, receivedQty: 0 })), totalAmount: 200, vatAmount: 0, grandTotal: 200, timeline: [{ action: 'ออก PO' }]
  });
  expect(po.status).toBe(200);
  expect(po.body.poNo).toBe(`PO-PD-${YEAR}-001`);
  state.poNo = po.body.poNo;

  const ledger = await L3('GET', '/api/budget-transactions');
  const commit = ledger.body.filter((t) => String(t.type).toUpperCase() === 'PR_COMMITMENT' && t.docNo === state.prNo);
  expect(commit.length).toBe(1);
  expect(Math.abs(commit[0].amount)).toBe(200);
});

test('3 receive (GRN) by L1 -> stock +2 ; stock log IN ; then L1 closes PO with a 50 refund (settle) -> budget credited', async ({ request }) => {
  const L1 = api(request, 'L1');
  const rec = await L1('POST', '/api/pos/PO-E2E-1/receive', {
    receivingItems: [{ productId: 'E2E-P1', goodQty: 2, defectiveQty: 0, storageLocation: 'A1' }], grNumber: `GRN-${state.poNo}-01`
  });
  expect(rec.status).toBe(200);
  expect(rec.body.po.status).toBe('CLOSED'); // all lines received (web engine / GAS: CLOSED ; the ReceivingModal flow saves COMPLETED itself)
  const boot = await L1('GET', '/api/bootstrap');
  expect(boot.body.products.find((p) => p.id === 'E2E-P1').currentStock).toBe(12);
  expect(boot.body.stockLogs.some((l) => l.type === 'IN' && l.docNo === `GRN-${state.poNo}-01`)).toBe(true);
  // the client syncs stock with PUT /api/products/batch carrying the products of EVERY department (InventoryContext / warehouseService) :
  // for a PD user the QC row is skipped silently, the PD row is written, the request does not fail
  const stock = boot.body.products;
  expect(stock.map((p) => p.id)).toEqual(expect.arrayContaining(['E2E-P1', 'E2E-QC1']));
  const sync = await L1('PUT', '/api/products/batch', stock.map((p) => ({ ...p, currentStock: p.id === 'E2E-QC1' ? 999 : p.currentStock, ...(p.id === 'E2E-QC1' ? { name: 'edited by PD user' } : {}) })));
  expect(sync.status).toBe(200);
  expect(sync.body).toMatchObject({ success: true, skipped: ['E2E-QC1'] });
  const afterSync = (await L1('GET', '/api/bootstrap')).body.products;
  expect(afterSync.find((p) => p.id === 'E2E-QC1').currentStock).toBe(7); // untouched
  expect(afterSync.find((p) => p.id === 'E2E-P1').currentStock).toBe(12); // the PD row survived the sync
  // G : one GRN = ONE IN row per line ; the ReceivingModal stock call (stockOnly) repeated with the same GRN number adds nothing
  expect(boot.body.stockLogs.filter((l) => l.type === 'IN' && l.docNo === `GRN-${state.poNo}-01`).length).toBe(1);
  const stockAgain = await L1('POST', '/api/pos/PO-E2E-1/receive', { stockOnly: true, grNumber: `GRN-${state.poNo}-01`, receivingItems: [{ productId: 'E2E-P1', goodQty: 2 }] });
  expect(stockAgain.status).toBe(200);
  const bootAgain = await L1('GET', '/api/bootstrap');
  expect(bootAgain.body.products.find((p) => p.id === 'E2E-P1').currentStock).toBe(12);
  expect(bootAgain.body.stockLogs.filter((l) => l.type === 'IN' && l.docNo === `GRN-${state.poNo}-01`).length).toBe(1);
  // receiving the same (now terminal) PO again must not add stock twice
  const again = await L1('POST', '/api/pos/PO-E2E-1/receive', { receivingItems: [{ productId: 'E2E-P1', goodQty: 2 }] });
  expect(again.body.duplicate).toBe(true);

  const settle = await L1('POST', '/api/pos/PO-E2E-1/settle', { refundAmount: 50 });
  expect(settle.status).toBe(200);
  expect(settle.body.refundSkipped).toBeUndefined();
  const after = await L1('GET', '/api/bootstrap');
  // T4.6c: settle records settlementStatus and leaves the PO status as the receive set it (GAS apiSettlePO / client settlePO parity)
  expect(after.body.pos.find((p) => p.id === 'PO-E2E-1')).toMatchObject({ status: 'CLOSED', settlementStatus: 'SETTLED' });
  expect(after.body.budgets.PD).toMatchObject({ spent: 950, remainingBudget: 99050 });
  expect(after.body.budgetTransactions.filter((t) => t.actionType === 'REFUND_SETTLEMENT').length).toBe(1);
  // settling again is an edit (the UI's "edit actual amount") : accepted, but the same refund is never paid twice
  const dup = await L1('POST', '/api/pos/PO-E2E-1/settle', { refundAmount: 50 });
  expect(dup.status).toBe(200);
  expect(dup.body).toMatchObject({ resettled: true, refundedAmount: 0 });
  expect(dup.body.duplicate).toBeUndefined();
  expect((await L1('GET', '/api/bootstrap')).body.budgets.PD.spent).toBe(950);
});

test('4 stock issue : L1 issues 3 (stock 12 -> 9, OUT log) ; over-issue is refused', async ({ request }) => {
  const L1 = api(request, 'L1');
  const ok = await L1('POST', '/api/stock/issue', { productId: 'E2E-P1', quantity: 3, department: 'PD', issuedTo: 'Line-1', reason: 'e2e issue' });
  expect(ok.status).toBe(200);
  expect(ok.body.updatedProduct.currentStock).toBe(9);
  const boot = await L1('GET', '/api/bootstrap');
  expect(boot.body.products.find((p) => p.id === 'E2E-P1').currentStock).toBe(9);
  expect(boot.body.stockLogs.some((l) => l.type === 'OUT' && l.docType === 'ISSUE' && l.quantity === 3)).toBe(true);
  const over = await L1('POST', '/api/stock/issue', { productId: 'E2E-P1', quantity: 100, department: 'PD' });
  expect(over.status).toBe(400);
  expect((await L1('GET', '/api/bootstrap')).body.products.find((p) => p.id === 'E2E-P1').currentStock).toBe(9);
});

test('5 claim refund : online purchaser credits the PD budget (PUT budgets/PD) -> CLAIM_CREDIT row, once ; stale client gets 409', async ({ request }) => {
  const ON = api(request, 'ONLINE');
  const before = (await ON('GET', '/api/bootstrap')).body.budgets.PD;
  expect(before.spent).toBe(950);
  // T4.6: a refund without the budget permission names the PO it comes from (budgetService.creditDepartmentBudget sends docNo / transactionId)
  const noPo = await ON('PUT', '/api/budgets/PD', { monthlyBudget: 100000, spent: 930, actualExpense: 930, variance: 99070 });
  expect(noPo.status).toBe(400);
  const put = await ON('PUT', '/api/budgets/PD', { monthlyBudget: 100000, spent: 930, actualExpense: 930, variance: 99070, docNo: state.poNo, transactionId: `REFUND_${state.poNo}_S_20` });
  expect(put.status).toBe(200);
  expect(put.body).toMatchObject({ applied: true, credited: 20 });
  const boot = (await ON('GET', '/api/bootstrap')).body;
  expect(boot.budgets.PD).toMatchObject({ spent: 930, remainingBudget: 99070 });
  expect(boot.budgetTransactions.filter((t) => t.actionType === 'CLAIM_CREDIT').map((t) => t.amount)).toEqual([20]);
  // same request again : nothing left to credit
  const same = await ON('PUT', '/api/budgets/PD', { monthlyBudget: 100000, spent: 930, actualExpense: 930, variance: 99070, docNo: state.poNo });
  expect(same.body.applied).toBe(false);
  // the PO (200) already gave back 50 (settle) + 20 : a further 230 would exceed what it cut from the budget
  const over = await ON('PUT', '/api/budgets/PD', { monthlyBudget: 100000, spent: 700, actualExpense: 700, variance: 99300, docNo: state.poNo });
  expect(over.status).toBe(400);
  expect((await ON('GET', '/api/bootstrap')).body.budgets.PD.spent).toBe(930);
  // stale (spent above stored) -> 409, nothing written
  const stale = await ON('PUT', '/api/budgets/PD', { monthlyBudget: 100000, spent: 950, actualExpense: 950, variance: 99050, docNo: state.poNo });
  expect(stale.status).toBe(409);
  expect((await ON('GET', '/api/bootstrap')).body.budgets.PD.spent).toBe(930);
});

test('6 RBAC : L1 cannot do L2 / L3 / admin / budget actions ; L3 can', async ({ request }) => {
  const L1 = api(request, 'L1'); const L2 = api(request, 'L2'); const L3 = api(request, 'L3');
  const items = [{ productId: 'E2E-P1', id: 'E2E-P1', name: 'จาระบี E2E', qty: 1, purchaseQty: 1, price: 100 }];
  const c = await L1('POST', '/api/prs', { id: 'PR-E2E-2', department: 'PD', status: 'SUBMITTED', items, totalAmount: 100 });
  expect(c.status).toBe(200);
  expect((await L1('PUT', '/api/prs/PR-E2E-2', { status: 'REVIEWED' })).status).toBe(403);
  expect((await L1('PUT', '/api/prs/PR-E2E-2', { status: 'PO_ISSUED' })).status).toBe(403);
  expect((await L2('PUT', '/api/prs/PR-E2E-2', { status: 'REVIEWED' })).status).toBe(200);
  expect((await L1('PUT', '/api/prs/PR-E2E-2', { status: 'APPROVED' })).status).toBe(403);
  expect((await L1('POST', '/api/budgets/allocate', { dept: 'PD', amount: 1 })).status).toBe(403);
  expect((await L1('POST', '/api/users', { username: 'x', password: 'y' })).status).toBe(403);
  expect((await L1('PUT', '/api/budgets/PD', { monthlyBudget: 999999, spent: 0 })).status).toBe(403); // not a budget writer : allocation change refused
  expect((await L1('DELETE', '/api/prs/PR-E2E-2')).status).toBe(403);
  expect((await L3('PUT', '/api/prs/PR-E2E-2', { status: 'PO_ISSUED' })).status).toBe(200);
  // a PO cannot be created from a PR that was not approved
  const bad = await L1('POST', '/api/pos', { id: 'PO-E2E-X', prNumber: 'PD999/2000', department: 'PD', status: 'ORDERED', items: [], totalAmount: 1 });
  expect(bad.status).toBe(400);
});

test('7 lockout (API) : 5 wrong passwords -> 401 each ; the 6th attempt (even with the right password) -> 429', async ({ request }) => {
  for (let i = 1; i <= 5; i++) {
    expect((await login(request, 'LOCK_API', `bad-${i}`)).status(), `attempt ${i}`).toBe(401);
  }
  const locked = await login(request, 'LOCK_API');
  expect(locked.status()).toBe(429);
  expect((await locked.json()).error).toContain('15');
});

test('8 UI : login form -> dashboard ; wrong password message ; session survives reload ; PR from the flow is listed ; logout', async ({ page }) => {
  await page.goto('/#/login');
  await page.locator('#username-input').fill(USERS.L1.username);
  await page.locator('#password-input').fill('wrong-password');
  await page.locator('#login-submit-btn').click();
  await expect(page.getByText('ชื่อผู้ใช้งาน หรือ รหัสผ่าน ไม่ถูกต้อง')).toBeVisible();

  await page.locator('#password-input').fill(PASSWORD);
  await page.locator('#login-submit-btn').click();
  await expect(page).toHaveURL(/#\/dashboard/);
  await expect(page.getByText(USERS.L1.name).first()).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/#\/dashboard/);

  await page.goto('/#/prs');
  await expect(page.getByText(state.prNo).first()).toBeVisible({ timeout: 20000 });
});

test('10 UI : an admin-created account (mustChangePassword) is forced into the change-password modal, then works normally', async ({ page, request }) => {
  const NEW_PASSWORD = 'Chosen#Pass2027';
  // API view : the restricted token can do nothing but change the password
  const first = await login(request, 'MUST');
  expect(first.status()).toBe(200);
  const fj = await first.json();
  expect(fj.mustChangePassword).toBe(true);
  const restricted = await request.get('/api/bootstrap', { headers: { Authorization: `Bearer ${fj.token}` } });
  expect(restricted.status()).toBe(403);

  await page.goto('/#/login');
  await page.locator('#username-input').fill(USERS.MUST.username);
  await page.locator('#password-input').fill(PASSWORD);
  await page.locator('#login-submit-btn').click();
  const modal = page.getByTestId('change-password-modal');
  await expect(modal).toBeVisible();
  await expect(page.getByLabel('ปิดหน้าต่าง')).toHaveCount(0); // cannot be closed
  await page.reload();
  await expect(page.getByTestId('change-password-modal')).toBeVisible(); // still forced after a reload

  // wrong old password is refused by the server and the modal stays
  await page.locator('#current-password-input').fill('not-the-password');
  await page.locator('#new-password-input').fill(NEW_PASSWORD);
  await page.locator('#confirm-password-input').fill(NEW_PASSWORD);
  await page.locator('#change-password-submit').click();
  await expect(page.getByTestId('change-password-error')).toContainText('รหัสผ่านเดิมไม่ถูกต้อง');

  await page.locator('#current-password-input').fill(PASSWORD);
  await page.locator('#change-password-submit').click();
  await expect(page.getByTestId('change-password-modal')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/dashboard/);
  await expect(page.getByText(USERS.MUST.name).first()).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/#\/dashboard/);
  await expect(page.getByTestId('change-password-modal')).toHaveCount(0);

  // the old token is dead, the old password no longer logs in, the new one does and is not forced again
  expect((await request.get('/api/bootstrap', { headers: { Authorization: `Bearer ${fj.token}` } })).status()).toBe(401);
  expect((await login(request, 'MUST', PASSWORD)).status()).toBe(401);
  const again = await login(request, 'MUST', NEW_PASSWORD);
  expect(again.status()).toBe(200);
  expect((await again.json()).mustChangePassword).toBe(false);
});

test('11 R2 file : upload a real PNG (/api/upload -> local R2) -> save in a PR -> GET /api/files/:id 200 + content-type ; other department 404 ; no token 401', async ({ request }) => {
  const PNG = Buffer.from(TINY_PNG.split(',')[1], 'base64');
  const L1 = api(request, 'L1');
  const other = await login(request, 'OTHER');
  expect(other.status()).toBe(200);
  tokens.OTHER = (await other.json()).token;

  const up = await L1('POST', '/api/upload', { base64Data: TINY_PNG, mimeType: 'image/png', fileName: 'r2-proof.png', category: 'PR', department: 'PD', docType: 'PR' });
  expect(up.status).toBe(200);
  expect(up.body.success).toBe(true);
  const { fileId, attachmentId } = up.body;
  expect(fileId).toMatch(/^[0-9a-f-]{36}$/); // R2 file id = uuid (not a Drive id)
  expect(up.body.fileUrl).toBe(`/api/files/${fileId}`); // the authenticated proxy path, never a bucket / public URL
  expect(up.body.mimeType).toBe('image/png');
  expect(up.body.fileSize).toBe(PNG.length);

  // saved in a PR : the reference survives the write-side sanitizing (R2 proxy path + uuid id accepted)
  const att = { id: attachmentId, fileId, name: 'r2-proof.png', fileName: 'r2-proof.png', type: 'image/png', mimeType: 'image/png', url: up.body.fileUrl, previewUrl: up.body.fileUrl };
  const items = [{ productId: 'E2E-P1', id: 'E2E-P1', name: 'จาระบี E2E', qty: 1, purchaseQty: 1, price: 100 }];
  const created = await L1('POST', '/api/prs', { id: 'PR-E2E-R2', department: 'PD', status: 'SUBMITTED', items, totalAmount: 100, attachments: [att] });
  expect(created.status).toBe(200);
  const pr = (await L1('GET', '/api/bootstrap')).body.prs.find((p) => p.id === 'PR-E2E-R2');
  expect(pr.attachments[0]).toMatchObject({ fileId, url: `/api/files/${fileId}` });

  const get = (who, id = fileId) => request.get(`/api/files/${id}`, { headers: who ? { Authorization: `Bearer ${tokens[who]}` } : {} });
  const ok = await get('L1');
  expect(ok.status()).toBe(200);
  expect(ok.headers()['content-type']).toBe('image/png');
  expect(ok.headers()['x-content-type-options']).toBe('nosniff');
  expect(ok.headers()['content-disposition']).toContain('inline');
  expect(Buffer.compare(await ok.body(), PNG)).toBe(0); // the exact bytes that were uploaded
  expect((await get('L3')).status()).toBe(200); // approver with access to every department
  // a user of another department : same 404 as a file that does not exist
  const denied = await get('OTHER');
  expect(denied.status()).toBe(404);
  expect((await get('OTHER', '00000000-0000-4000-8000-000000000000')).status()).toBe(404);
  expect((await get(null)).status()).toBe(401);
  // ?download=1 -> attachment
  const dl = await request.get(`/api/files/${fileId}?download=1`, { headers: { Authorization: `Bearer ${tokens.L1}` } });
  expect(dl.headers()['content-disposition']).toContain('attachment');
});

test('9 UI : 6th wrong password on the login form shows the 15-minute lock message', async ({ page }) => {
  await page.goto('/#/login');
  for (let i = 1; i <= 6; i++) {
    await page.locator('#username-input').fill(USERS.LOCK_UI.username);
    await page.locator('#password-input').fill(`bad-${i}`);
    await page.locator('#login-submit-btn').click();
    if (i < 6) await expect(page.getByText('ชื่อผู้ใช้งาน หรือ รหัสผ่าน ไม่ถูกต้อง')).toBeVisible();
  }
  await expect(page.getByText('พยายามเข้าสู่ระบบผิดหลายครั้ง')).toBeVisible();
  // the correct password is refused while locked
  await page.locator('#password-input').fill(PASSWORD);
  await page.locator('#login-submit-btn').click();
  await expect(page.getByText('พยายามเข้าสู่ระบบผิดหลายครั้ง')).toBeVisible();
  await expect(page).toHaveURL(/#\/login/);
});

test('12 UI : fresh browser -> login page makes no bootstrap/storage call ; login loads server data without a reload (no sample catalogue)', async ({ page }) => {
  const calls = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) calls.push(`${r.method()} ${u.pathname}`); });
  await page.goto('/#/login');
  await expect(page.locator('#username-input')).toBeVisible();
  await page.waitForTimeout(800);
  expect(calls.filter((c) => c.endsWith('/api/bootstrap'))).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('prpo_data_version'))).toBeNull();

  await page.locator('#username-input').fill(USERS.L1.username);
  await page.locator('#password-input').fill(PASSWORD);
  await page.locator('#login-submit-btn').click();
  await expect(page.getByText(USERS.L1.name).first()).toBeVisible();
  await expect.poll(() => calls.filter((c) => c === 'GET /api/bootstrap').length, { timeout: 15000 }).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('prpo_products_data') || ''), { timeout: 15000 }).toContain('E2E-P1');
  const products = await page.evaluate(() => localStorage.getItem('prpo_products_data') || '');
  expect(products).not.toContain('PD-OIL-068');
  expect(calls.filter((c) => c.endsWith('/api/storage'))).toEqual([]);
});
