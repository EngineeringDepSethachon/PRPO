// @vitest-environment jsdom
// kla-security : AttachmentViewerModal frames only a proxy URL or a Drive URL built from an extracted driveId ; "Google Drive Verified" only for real, non-proxied Drive files
import React, { act } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../src/services/modalService', () => ({
  modalService: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), alert: vi.fn(), confirm: vi.fn() }
}));

import AttachmentViewerModal from '../src/components/common/AttachmentViewerModal.jsx';
import { clearProxiedFileCache } from '../src/utils/cfAttachments.js';

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('AttachmentViewerModal hardening', () => {
  let root; let container;
  beforeEach(() => {
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    clearProxiedFileCache();
    vi.stubEnv('VITE_BACKEND_MODE', 'gas');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); document.body.innerHTML = ''; vi.unstubAllEnvs(); vi.unstubAllGlobals(); clearProxiedFileCache(); });
  const render = async (props) => { await act(async () => { root.render(<AttachmentViewerModal {...props} />); }); await flush(); };

  it('PDF on a Drive host without an extractable driveId : no iframe with the raw URL', async () => {
    const raw = 'https://lh3.googleusercontent.com/some/path/q.pdf';
    await render({ file: { name: 'q.pdf', type: 'application/pdf', url: raw }, url: raw, title: 'q.pdf' });
    expect(document.body.querySelector('iframe')).toBeNull();
    expect(document.body.innerHTML).not.toContain('<iframe');
  });

  it('PDF with a driveId : iframe src is built from the id, not the raw URL', async () => {
    const id = 'DRIVEID1234567890abcdefghij';
    const raw = `https://drive.google.com/file/d/${id}/view?usp=sharing&evil=1`;
    await render({ file: { name: 'q.pdf', type: 'application/pdf', url: raw }, url: raw, title: 'q.pdf' });
    const src = document.body.querySelector('iframe')?.getAttribute('src') || '';
    expect(src).toContain(id);
    expect(src).not.toContain('evil=1');
    expect(document.body.innerHTML).toContain('Google Drive Verified');
  });

  it('R2 file through the proxy : no "Google Drive Verified" badge', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    const UUID = '3f2b8c1e-9a4d-4e7b-8c55-0123456789ab';
    await render({ file: { name: 'a.png', fileId: UUID, fileUrl: `/api/files/${UUID}` }, url: `/api/files/${UUID}`, title: 'a.png' });
    expect(document.body.innerHTML).not.toContain('Google Drive Verified');
  });

  it('non-Drive URL : no badge', async () => {
    await render({ file: { name: 'a.pdf', type: 'application/pdf', url: 'https://example.com/a.pdf' }, url: 'https://example.com/a.pdf', title: 'a.pdf' });
    expect(document.body.innerHTML).not.toContain('Google Drive Verified');
    expect(document.body.querySelector('iframe')).toBeNull();
  });
});
