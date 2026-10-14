// @vitest-environment jsdom
// QA edge cases for TC-002 (AttachmentViewerModal with R2 / Drive / PDF files)
import React, { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../src/services/modalService', () => ({
  modalService: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), alert: vi.fn(), confirm: vi.fn() }
}));

import AttachmentViewerModal from '../src/components/common/AttachmentViewerModal.jsx';
import { clearProxiedFileCache } from '../src/utils/cfAttachments.js';

const UUID = '3f2b8c1e-9a4d-4e7b-8c55-0123456789ab';
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('AttachmentViewerModal QA edge', () => {
  let root; let container; let fetchMock; let ctype;
  beforeEach(() => {
    ctype = 'image/png';
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    localStorage.setItem('prpo_auth_session', JSON.stringify({ token: 'tkn-1' }));
    clearProxiedFileCache();
    URL.createObjectURL = vi.fn(() => 'blob:http://localhost/proxied-1');
    URL.revokeObjectURL = vi.fn();
    fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': ctype } }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); document.body.innerHTML = ''; vi.unstubAllEnvs(); vi.unstubAllGlobals(); localStorage.clear(); clearProxiedFileCache(); });

  const render = async (props) => { await act(async () => { root.render(<AttachmentViewerModal {...props} />); }); await flush(); };

  it('row with only a uuid fileId (no url) and image name : still drawn through /api/files', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    await render({ file: { name: 'a.jpg', fileId: UUID }, url: '', title: 'a.jpg' });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([`/api/files/${UUID}`]);
    expect(document.body.querySelector('img')?.getAttribute('src')).toBe('blob:http://localhost/proxied-1');
  });

  it('R2 PDF : iframe uses the proxied blob, no Drive', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    ctype = 'application/pdf';
    await render({ file: { name: 'q.pdf', type: 'application/pdf', fileId: UUID, fileUrl: `/api/files/${UUID}` }, url: `/api/files/${UUID}`, title: 'q.pdf' });
    expect(document.body.querySelector('iframe')?.getAttribute('src')).toBe('blob:http://localhost/proxied-1');
    expect(document.body.innerHTML).not.toContain('drive.google.com');
  });

  it('R2 docx : offers open-file button, no Drive, no img/iframe', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    await render({ file: { name: 'a.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileId: UUID, fileUrl: `/api/files/${UUID}` }, url: `/api/files/${UUID}`, title: 'a.docx' });
    expect(document.body.querySelector('img')).toBeNull();
    expect(document.body.querySelector('iframe')).toBeNull();
    expect(document.body.innerHTML).not.toContain('drive.google.com');
    expect(document.body.textContent).toContain('เปิดไฟล์');
  });

  it('R2 fetch fails (403) : no Drive iframe is shown', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    fetchMock.mockImplementation(async () => new Response('x', { status: 403 }));
    await render({ file: { name: 'a.png', fileId: UUID, fileUrl: `/api/files/${UUID}` }, url: `/api/files/${UUID}`, title: 'a.png' });
    expect(document.body.innerHTML).not.toContain('drive.google.com');
  });

  it('cloudflare mode, legacy Drive file : proxy first, no crash', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    const id = 'DRIVEID1234567890abcdefghij';
    await render({ file: { name: 'a.png', type: 'image/png', fileId: id, fileUrl: `https://drive.google.com/file/d/${id}/view` }, url: `https://drive.google.com/file/d/${id}/view`, title: 'a.png' });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([`/api/files/${id}`]);
    expect(document.body.querySelector('img')?.getAttribute('src')).toBe('blob:http://localhost/proxied-1');
  });

  it('GAS mode PDF on Drive : iframe Drive preview', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'gas');
    const id = 'DRIVEID1234567890abcdefghij';
    await render({ file: { name: 'q.pdf', type: 'application/pdf', fileId: id, fileUrl: `https://drive.google.com/file/d/${id}/view` }, url: `https://drive.google.com/file/d/${id}/view`, title: 'q.pdf' });
    expect(document.body.querySelector('iframe')?.getAttribute('src')).toContain(id);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('data: image shown directly in any mode', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'gas');
    await render({ file: { name: 'a.png' }, url: 'data:image/png;base64,AAAA', title: 'a.png' });
    expect(document.body.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });
});
