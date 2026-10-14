// @vitest-environment jsdom
// Anyone-with-link closed (2026-10-13) : every place that shows / opens a Drive file goes through GET /api/files/:id in cloudflare mode,
// GAS / mock mode unchanged ; and a new user must pick a role (UserCRUDModal + UserMasterView).
import React, { act } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const warning = vi.fn();
const success = vi.fn();
vi.mock('../src/services/modalService', () => ({
  modalService: { error: vi.fn(), success: (...a) => success(...a), warning: (...a) => warning(...a), info: vi.fn(), alert: vi.fn(), confirm: vi.fn() }
}));
const saveUser = vi.fn(async (u) => u);
vi.mock('../src/services/apiService', () => ({
  apiService: { saveUser: (...a) => saveUser(...a), getUsers: vi.fn(async () => []) }
}));

import ProxiedImg from '../src/components/common/ProxiedImg.jsx';
import FileUploader from '../src/components/common/FileUploader.jsx';
import UserCRUDModal from '../src/components/admin/UserCRUDModal.jsx';
import UserMasterView from '../src/views/admin/UserMasterView.jsx';
import { clearProxiedFileCache } from '../src/utils/cfAttachments.js';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const FID = 'FILEID1234567890abcd';
const DRIVE_THUMB = `https://drive.google.com/thumbnail?id=${FID}&sz=w400`;
const att = { fileId: FID, name: 'a.png', mimeType: 'image/png', url: `https://drive.google.com/thumbnail?id=${FID}&sz=w1200`, previewUrl: `https://drive.google.com/thumbnail?id=${FID}&sz=w1200` };
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('client : Drive files are shown through the proxy (cloudflare) and unchanged elsewhere', () => {
  let container; let root; let fetchMock;
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    localStorage.setItem('prpo_auth_session', JSON.stringify({ token: 'tkn-1' }));
    clearProxiedFileCache();
    URL.createObjectURL = vi.fn(() => 'blob:http://localhost/proxied-1');
    URL.revokeObjectURL = vi.fn();
    fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); localStorage.clear(); clearProxiedFileCache(); });

  it('ProxiedImg (PRCreateView gallery / preview, PODetailsModal evidence, OnlineOrderCard damage photos) : cloudflare -> /api/files/:id blob, no Drive URL requested', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    await act(async () => { root.render(<ProxiedImg att={att} size="w400" alt="x" />); });
    await flush();
    const img = container.querySelector('img');
    expect(img.getAttribute('src')).toBe('blob:http://localhost/proxied-1');
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([`/api/files/${FID}`]);
    expect(container.innerHTML).not.toContain('drive.google.com');
  });

  it('ProxiedImg : GAS and mock mode keep the old Drive thumbnail URL and never call /api/files', async () => {
    for (const mode of ['gas', 'mock']) {
      vi.stubEnv('VITE_BACKEND_MODE', mode);
      await act(async () => { root.render(<ProxiedImg att={att} urlInput={att.previewUrl} size="w400" alt="x" />); });
      await flush();
      expect(container.querySelector('img').getAttribute('src')).toBe(DRIVE_THUMB);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ProxiedImg : a local preview (blob:/data:) is shown from memory, no request', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    await act(async () => { root.render(<ProxiedImg att={{ ...att, previewUrl: 'data:image/png;base64,AAAA' }} urlInput="data:image/png;base64,AAAA" alt="x" />); });
    await flush();
    expect(container.querySelector('img').getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('FileUploader : an older draft holding a Drive file is shown through the proxy in cloudflare mode', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    const file = { id: 'f1', name: 'a.png', size: 10, isImage: true, ...att };
    await act(async () => { root.render(<FileUploader label="x" files={[file]} setFiles={() => {}} />); });
    await flush();
    const imgs = [...container.querySelectorAll('img')];
    expect(imgs.length).toBe(1);
    expect(imgs[0].getAttribute('src')).toBe('blob:http://localhost/proxied-1');
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([`/api/files/${FID}`]);
  });

  it('FileUploader : outside cloudflare the thumbnail is the stored previewUrl as before', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'mock');
    const file = { id: 'f1', name: 'a.png', size: 10, isImage: true, previewUrl: 'blob:http://localhost/local' };
    await act(async () => { root.render(<FileUploader label="x" files={[file]} setFiles={() => {}} />); });
    expect(container.querySelector('img').getAttribute('src')).toBe('blob:http://localhost/local');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no component shows a Drive file with a raw <img src={resolveDriveImageUrl(...)}> or an <a href> to Drive any more (all go through ProxiedImg / the viewers)', () => {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
    const files = walk(path.join(here, '..', 'src')).filter((f) => /\.jsx$/.test(f));
    const offenders = files.filter((f) => !f.endsWith('ProxiedImg.jsx') && /src=\{\s*resolveDriveImageUrl\(/.test(fs.readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
    // the sites the lead listed use the proxy
    const read = (...p) => fs.readFileSync(path.join(here, '..', 'src', ...p), 'utf8');
    expect(read('views', 'PRCreateView.jsx')).toContain('<ProxiedImg');
    expect(read('views', 'PRCreateView.jsx')).toContain('openProxiedFile');
    expect(read('views', 'procurement', 'OnlineOrderCard.jsx')).toContain('<ProxiedImg');
    expect(read('components', 'po', 'PODetailsModal.jsx')).toContain('<ProxiedImg');
    expect(read('components', 'pr', 'PRDetailsModal.jsx')).toContain('openProxiedFile');
    expect(read('components', 'common', 'FileUploader.jsx')).toContain('useProxiedFileUrl');
    expect(read('components', 'common', 'AttachmentViewerModal.jsx')).toContain('openProxiedFile');
    expect(read('components', 'common', 'ImageLightboxModal.jsx')).toContain('openViaProxy');
  });
});

describe('openProxiedFile : refusals and file types (cloudflare)', () => {
  let fetchMock;
  beforeEach(() => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    localStorage.setItem('prpo_auth_session', JSON.stringify({ token: 'tkn-1' }));
    clearProxiedFileCache(); warning.mockClear();
    URL.createObjectURL = vi.fn(() => 'blob:http://localhost/p');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); localStorage.clear(); clearProxiedFileCache(); vi.restoreAllMocks(); });

  it('403 / 5xx : the user is told and the Drive link is not tried (returns true) ; 404 : returns false so legacy files keep their old link', async () => {
    const { openProxiedFile } = await import('../src/utils/cfAttachments.js');
    window.open = vi.fn(() => ({ close: vi.fn(), location: {} }));
    // [status, returns, modal shown] : 401 is silent (AuthContext shows the session notice) ; 429 / 403 / 5xx are told ; 404 falls back
    for (const [status, expected, modals] of [[403, true, 1], [429, true, 1], [500, true, 1], [401, true, 0], [404, false, 0]]) {
      clearProxiedFileCache(); warning.mockClear();
      fetchMock = vi.fn(async () => new Response('{}', { status }));
      vi.stubGlobal('fetch', fetchMock);
      expect(await openProxiedFile(att), `status ${status}`).toBe(expected);
      expect(warning, `status ${status}`).toHaveBeenCalledTimes(modals);
    }
  });

  it('a Word / Excel file is saved with its name (download), an image / PDF opens in a tab', async () => {
    const { openProxiedFile } = await import('../src/utils/cfAttachments.js');
    fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const opened = { close: vi.fn(), location: {} };
    window.open = vi.fn(() => opened);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    expect(await openProxiedFile({ ...att, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'q.docx' })).toBe(true);
    expect(window.open).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
    clearProxiedFileCache();
    expect(await openProxiedFile({ ...att, mimeType: 'application/pdf', name: 'q.pdf' })).toBe(true);
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(opened.location.href).toBe('blob:http://localhost/p');
  });
});

describe('user form : the role is required for a new user', () => {
  let container; let root;
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    warning.mockClear(); success.mockClear(); saveUser.mockClear();
    vi.stubEnv('VITE_BACKEND_MODE', 'mock');
    // jsdom has no canvas : the signature pad only needs a 2d context object
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ lineCap: '', lineJoin: '', strokeStyle: '', lineWidth: 0, clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() }));
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllEnvs(); });

  const setInput = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const setSelect = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const byPlaceholder = (root_, ph) => root_.querySelector(`input[placeholder="${ph}"]`);

  it('UserCRUDModal : no role selected -> the same inline error as the other required fields, nothing is saved ; after choosing one it saves', async () => {
    await act(async () => { root.render(<UserCRUDModal user={null} users={[]} departments={[{ code: 'PD', name: 'PD' }]} currentRole={{ id: 'ADMIN' }} onClose={() => {}} onSaved={() => {}} />); });
    const body = document.body;
    const select = [...body.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'ADMIN'));
    expect(select.value).toBe('');                                  // placeholder, no silent default
    expect([...select.options].map((o) => o.value)).toContain('');
    await act(async () => { setInput(byPlaceholder(body, 'เช่น คุณวิชัย (PD)'), 'New User'); setInput(byPlaceholder(body, 'เช่น wichai.pd หรือ user@company.com'), 'new.user'); });
    const form = body.querySelector('form');
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(body.textContent).toContain('กรุณาเลือกบทบาทหน้าที่ของผู้ใช้งาน');
    expect(saveUser).not.toHaveBeenCalled();

    await act(async () => { setSelect(select, 'REQUESTER'); });
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    expect(saveUser).toHaveBeenCalledTimes(1);
    expect(saveUser.mock.calls[0][0].roleId).toBe('REQUESTER');
  });

  it('UserCRUDModal : editing an existing user keeps their role preselected (no forced re-pick)', async () => {
    const u = { id: 'U1', name: 'A', username: 'a', roleId: 'ASST_MANAGER', department: 'PD', allowedDepartments: ['PD'] };
    await act(async () => { root.render(<UserCRUDModal user={u} users={[u]} departments={[{ code: 'PD', name: 'PD' }]} currentRole={{ id: 'ADMIN' }} onClose={() => {}} onSaved={() => {}} />); });
    const select = [...document.body.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'ADMIN'));
    expect(select.value).toBe('ASST_MANAGER');
    expect([...select.options].map((o) => o.value)).not.toContain('');
  });

  it('UserCRUDModal : an existing user whose roleId is empty gets an empty role field and must choose (no silent REQUESTER)', async () => {
    const u = { id: 'U9', name: 'A', username: 'a', roleId: '', department: 'PD', allowedDepartments: ['PD'] };
    await act(async () => { root.render(<UserCRUDModal user={u} users={[u]} departments={[{ code: 'PD', name: 'PD' }]} currentRole={{ id: 'ADMIN' }} onClose={() => {}} onSaved={() => {}} />); });
    const select = [...document.body.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'ADMIN'));
    expect(select.value).toBe('');
    await act(async () => { document.body.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(document.body.textContent).toContain('กรุณาเลือกบทบาทหน้าที่ของผู้ใช้งาน');
    expect(saveUser).not.toHaveBeenCalled();
  });

  it('UserMasterView : "add user" form warns when no role is chosen and does not save ; with a role it saves', async () => {
    const admin = { id: 'ADMIN', roleId: 'ADMIN', level: 99 };
    await act(async () => { root.render(<UserMasterView users={[{ id: 'U0', name: 'X', username: 'x', roleId: 'REQUESTER', department: 'PD' }]} departments={[{ code: 'PD', name: 'PD' }]} currentRole={admin} currentUser={admin} onRefresh={() => {}} />); });
    const addBtn = [...document.body.querySelectorAll('button')].find((b) => b.textContent.includes('เพิ่มผู้ใช้ใหม่'));
    await act(async () => { addBtn.click(); });
    const body = document.body;
    const select = [...body.querySelectorAll('form select')].find((s) => [...s.options].some((o) => o.value === 'PLANT_MANAGER'));
    expect(select.value).toBe('');
    await act(async () => { setInput(byPlaceholder(body, 'เช่น คุณวิชัย (PD)'), 'New User'); setInput(byPlaceholder(body, 'เช่น wichai.pd'), 'new.user'); });
    const form = [...body.querySelectorAll('form')].find((f) => f.contains(select));
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(warning).toHaveBeenCalledWith('ยังไม่ได้เลือกบทบาท', expect.any(String));
    expect(saveUser).not.toHaveBeenCalled();

    await act(async () => { setSelect(select, 'ADMIN'); });
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await flush();
    expect(saveUser).toHaveBeenCalledTimes(1);
    expect(saveUser.mock.calls[0][0].roleId).toBe('ADMIN');
  });
});
