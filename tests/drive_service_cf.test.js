// @vitest-environment jsdom
// T2.1c client side : driveService in cloudflare mode calls /api/upload with the Bearer token and keeps only what the server returns
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/services/modalService', () => ({ modalService: { alert: vi.fn(), error: vi.fn(), confirm: vi.fn() } }));

import { uploadFileToDrive } from '../src/services/driveService.js';

const SERVER = {
  success: true, attachmentId: 'ATT-1', fileId: 'FILEID1234567890abcd',
  fileUrl: 'https://drive.google.com/thumbnail?id=FILEID1234567890abcd&sz=w1200',
  directUrl: 'https://drive.google.com/thumbnail?id=FILEID1234567890abcd&sz=w1200',
  viewUrl: 'https://drive.google.com/file/d/FILEID1234567890abcd/view',
  downloadUrl: 'https://drive.google.com/uc?export=download&id=FILEID1234567890abcd',
  lh3Url: 'https://lh3.googleusercontent.com/d/FILEID1234567890abcd',
  fileName: 'a.jpg', mimeType: 'image/jpeg', fileSize: 12, folderPath: '03_GRN_Evidence/2026-10/PO-1', uploadedAt: '2026-10-12T00:00:00.000Z'
};

describe('driveService.uploadFileToDrive (cloudflare mode)', () => {
  let fetchMock;
  beforeEach(() => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    localStorage.setItem('prpo_auth_session', JSON.stringify({ token: 'tkn' }));
    fetchMock = vi.fn(async () => new Response(JSON.stringify(SERVER), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); localStorage.clear(); });

  const args = { base64Data: 'QUJD', mimeType: 'image/jpeg', fileName: 'a.jpg', category: 'GRN', poNumber: 'PO-1', docNo: 'PO-1', docType: 'GRN_EVIDENCE' };

  it('POSTs JSON to /api/upload with Bearer token and uses the server URLs (no data: URL)', async () => {
    const r = await uploadFileToDrive(args);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/upload');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tkn');
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ base64Data: 'QUJD', category: '03_GRN_Evidence', poNumber: 'PO-1', docType: 'GRN_EVIDENCE' });
    expect(r).toMatchObject({ success: true, fileId: SERVER.fileId, fileUrl: SERVER.fileUrl, viewUrl: SERVER.viewUrl, downloadUrl: SERVER.downloadUrl, previewUrl: SERVER.directUrl });
    expect(JSON.stringify(r)).not.toContain('data:');
    expect(JSON.stringify(r)).not.toContain('QUJD');
  });

  it('server error -> throws with the server message (no base64 fallback)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'ไม่มีสิทธิ์ดำเนินการนี้', success: false }), { status: 403 }));
    await expect(uploadFileToDrive(args)).rejects.toThrow(/ไม่มีสิทธิ์/);
  });

  it('ok response without fileId -> throws instead of inventing an id / data URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await expect(uploadFileToDrive(args)).rejects.toThrow();
  });
});
