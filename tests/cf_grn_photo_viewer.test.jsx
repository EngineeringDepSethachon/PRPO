// @vitest-environment jsdom
// TC-002 : GRN photo (R2 file, uuid fileId) opened in AttachmentViewerModal must not be read as a Google Drive id
import React, { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../src/services/modalService', () => ({
  modalService: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), alert: vi.fn(), confirm: vi.fn() }
}));

import AttachmentViewerModal from '../src/components/common/AttachmentViewerModal.jsx';
import { clearProxiedFileCache } from '../src/utils/cfAttachments.js';
import { registerBlobUrl } from '../src/utils/attachmentUrls.js';

const UUID = '3f2b8c1e-9a4d-4e7b-8c55-0123456789ab';
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('AttachmentViewerModal : GRN photos (R2)', () => {
  let root; let container; let fetchMock;
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    localStorage.setItem('prpo_auth_session', JSON.stringify({ token: 'tkn-1' }));
    clearProxiedFileCache();
    URL.createObjectURL = vi.fn(() => 'blob:http://localhost/proxied-1');
    URL.revokeObjectURL = vi.fn();
    fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); document.body.innerHTML = ''; vi.unstubAllEnvs(); vi.unstubAllGlobals(); localStorage.clear(); clearProxiedFileCache(); });

  const imgSrc = () => document.body.querySelector('img')?.getAttribute('src');

  it('just attached (blob preview + R2 fileId) : shows the blob, never a Drive URL', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    const blob = registerBlobUrl('blob:http://localhost/local-1'); // as ReceivingModal does right after createObjectURL
    const file = { name: 'a.png', type: 'image/png', fileId: UUID, fileUrl: `/api/files/${UUID}`, previewUrl: blob, localUrl: blob };
    await act(async () => { root.render(<AttachmentViewerModal file={file} url={file.localUrl} title="a.png" />); });
    await flush();
    expect(imgSrc()).toBe('blob:http://localhost/local-1');
    expect(document.body.innerHTML).not.toContain('drive.google.com');
  });

  it('saved (proxy path, no mime type) : fetched through /api/files with the token and drawn as an image', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    const file = { name: 'a.png', fileId: UUID, fileUrl: `/api/files/${UUID}`, previewUrl: `/api/files/${UUID}` };
    await act(async () => { root.render(<AttachmentViewerModal file={file} url={file.previewUrl} title="a.png" />); });
    await flush();
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([`/api/files/${UUID}`]);
    expect(imgSrc()).toBe('blob:http://localhost/proxied-1');
    expect(document.body.innerHTML).not.toContain('drive.google.com');
  });

  it('GAS mode : a Drive file still opens through the Drive preview, no /api/files', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'gas');
    const id = 'DRIVEID1234567890abcdefghij';
    const file = { name: 'a.png', type: 'image/png', fileId: id, fileUrl: `https://drive.google.com/file/d/${id}/view` };
    await act(async () => { root.render(<AttachmentViewerModal file={file} url={file.fileUrl} title="a.png" />); });
    await flush();
    expect(document.body.querySelector('iframe')?.getAttribute('src')).toContain(`/file/d/${id}/preview`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
