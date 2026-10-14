// @vitest-environment jsdom
// T2.1c QA fixes : PR attachments (PDF 1MB) in cloudflare mode go to Drive ; no blob:/full-file data URL in the payload ; URL picking
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/services/modalService', () => ({ modalService: { alert: vi.fn(), error: vi.fn(), confirm: vi.fn() } }));

import { uploadAttachmentsForCloudflare, uploadItemImagesForCloudflare } from '../src/utils/cfAttachments.js';
import { attachmentsForServer, pickAttachmentUrl, registerBlobUrl, isUsableUrl } from '../src/utils/attachmentUrls.js';
import { hasOversizedDataUrl } from '../functions/_lib/upload.js';

const SERVER = {
  success: true, attachmentId: 'ATT-9', fileId: 'FILEID1234567890abcd',
  fileUrl: 'https://drive.google.com/file/d/FILEID1234567890abcd/view',
  directUrl: 'https://drive.google.com/thumbnail?id=FILEID1234567890abcd&sz=w1200',
  viewUrl: 'https://drive.google.com/file/d/FILEID1234567890abcd/view',
  downloadUrl: 'https://drive.google.com/uc?export=download&id=FILEID1234567890abcd',
  lh3Url: 'https://lh3.googleusercontent.com/d/FILEID1234567890abcd',
  fileName: 'quote.pdf', mimeType: 'application/pdf', fileSize: 1048576, folderPath: '01_PR_Attachments/2026-10', uploadedAt: '2026-10-12T00:00:00.000Z'
};

describe('cloudflare mode : PR attachments', () => {
  let fetchMock;
  beforeEach(() => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    localStorage.setItem('prpo_auth_session', JSON.stringify({ token: 'tkn' }));
    fetchMock = vi.fn(async () => new Response(JSON.stringify(SERVER), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); localStorage.clear(); });

  const pdf = () => new File([new Uint8Array(1024 * 1024).fill(37)], 'quote.pdf', { type: 'application/pdf' });
  // what FileUploader builds for a PDF : full data URL + blob preview
  const uploaderItem = (file) => ({
    file, id: 'x1', name: file.name, size: file.size, type: file.type, isImage: false,
    previewUrl: registerBlobUrl('blob:http://localhost/abc'), url: 'data:application/pdf;base64,AAAA', dataUrl: 'data:application/pdf;base64,AAAA'
  });

  it('1MB PDF is uploaded (category PR, own department) and only the Drive reference is kept', async () => {
    const item = uploaderItem(pdf());
    const [out] = await uploadAttachmentsForCloudflare([item], { category: 'PR', department: 'PD', docType: 'QUOTATION' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/upload');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tkn');
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ category: '01_PR_Attachments', department: 'PD', docType: 'QUOTATION', mimeType: 'application/pdf', poNumber: '' });
    expect(sent.base64Data.length).toBeGreaterThan(1000000);

    expect(out).toMatchObject({ fileId: SERVER.fileId, url: SERVER.fileUrl, mimeType: 'application/pdf', name: 'quote.pdf', size: SERVER.fileSize });
    expect(out.file).toBeUndefined();
    expect(out.dataUrl).toBeUndefined();
    const json = JSON.stringify(out);
    expect(json).not.toContain('blob:');
    expect(json).not.toContain('data:');
    expect(hasOversizedDataUrl(out)).toBe(false);
  });

  it('S6 : a small compressed image is uploaded too (from its compressed data URL) and no data:image stays in the saved reference', async () => {
    const img = new File([new Uint8Array(10)], 'p.jpg', { type: 'image/jpeg' });
    const data = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
    const item = { file: img, id: 'i1', name: 'p.jpg', type: 'image/jpeg', isImage: true, previewUrl: 'blob:http://localhost/old', url: data, dataUrl: data };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...SERVER, fileName: 'p.jpg', mimeType: 'image/jpeg', fileSize: 750 }), { status: 200 }));
    const [out] = await uploadAttachmentsForCloudflare([item], { category: 'PR', department: 'PD', docType: 'PR_ATTACHMENT' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent).toMatchObject({ mimeType: 'image/jpeg', fileName: 'p.jpg', department: 'PD', docType: 'PR_ATTACHMENT' });
    expect(sent.base64Data).toBe('A'.repeat(1000));
    expect(out.fileId).toBe(SERVER.fileId);
    expect(JSON.stringify(out)).not.toMatch(/data:|blob:/);
  });

  it('S6 : per-line product images (data URL, no File) are uploaded once per picture ; old fileId / non-image data untouched', async () => {
    const d1 = 'data:image/png;base64,' + 'B'.repeat(400);
    const d2 = 'data:image/jpeg;base64,' + 'C'.repeat(400);
    const svg = 'data:image/svg+xml;base64,PHN2Zy8+';
    const old = { name: 'old.jpg', fileId: 'OLDFILEID12345678', url: '/api/files/OLDFILEID12345678' };
    const a = { name: 'a.png', url: d1, previewUrl: d1, size: 300 };
    const b = { name: 'b.jpg', url: d2, previewUrl: d2 };
    const items = [{ id: 'l1', name: 'x', images: [a, b, old], attachments: [a, b, old] }, { id: 'l2', images: [{ url: svg, previewUrl: svg }] }, { id: 'l3' }];
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ...SERVER, fileId: 'NEWFILEID' + fetchMock.mock.calls.length + 'zzzzzzzz', fileUrl: '/api/files/x', directUrl: '/api/files/x', fileName: 'img.jpg', mimeType: 'image/jpeg', fileSize: 300 }), { status: 200 }));
    const out = await uploadItemImagesForCloudflare(items, { category: 'PR', department: 'PD' });
    expect(fetchMock).toHaveBeenCalledTimes(2); // a and b once each, although they sit in images AND attachments
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies[0]).toMatchObject({ mimeType: 'image/png', docType: 'PR_ITEM_IMAGE', category: '01_PR_Attachments', department: 'PD' });
    expect(bodies[1].mimeType).toBe('image/jpeg');
    expect(out[0].images[0].fileId).toMatch(/^NEWFILEID/);
    expect(out[0].images[0]).toEqual(out[0].attachments[0]);
    expect(out[0].images[2]).toBe(old);
    expect(out[1].images[0].url).toBe(svg); // unsupported type : left as before
    expect(out[2]).toEqual({ id: 'l3' });
    expect(JSON.stringify(out[0])).not.toMatch(/data:image/);
    expect(items[0].images[0].url).toBe(d1); // input not mutated
  });

  it('S6 : two different pictures that only have dataUrl are uploaded as 2 files (no wrong dedupe)', async () => {
    const d1 = 'data:image/png;base64,' + 'B'.repeat(400);
    const d2 = 'data:image/png;base64,' + 'C'.repeat(400);
    let n = 0;
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ...SERVER, fileId: 'FILEID_' + (++n) + '_zzzzzzzzzz', fileUrl: '/api/files/x' }), { status: 200 }));
    const out = await uploadItemImagesForCloudflare([{ images: [{ dataUrl: d1 }, { dataUrl: d2 }] }], {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out[0].images[0].fileId).not.toBe(out[0].images[1].fileId);
  });

  it('S6 : upload failure of an item image propagates (nothing is silently saved as base64) ; other modes untouched', async () => {
    const d = 'data:image/png;base64,' + 'B'.repeat(400);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'ระบบจัดเก็บไฟล์ยังไม่พร้อมใช้งาน' }), { status: 503 }));
    await expect(uploadItemImagesForCloudflare([{ images: [{ url: d }] }], {})).rejects.toThrow();
    vi.stubEnv('VITE_BACKEND_MODE', 'mock');
    const items = [{ images: [{ url: d }] }];
    expect(await uploadItemImagesForCloudflare(items, {})).toBe(items);
  });

  it('already uploaded items (fileId, no File) are untouched ; upload failure propagates', async () => {
    const done = { id: 'd', fileId: 'F1', url: 'https://drive.google.com/x', name: 'a.pdf' };
    expect(await uploadAttachmentsForCloudflare([done], { category: 'PR' })).toEqual([done]);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'ขนาดไฟล์เกินกำหนด' }), { status: 413 }));
    await expect(uploadAttachmentsForCloudflare([uploaderItem(pdf())], { category: 'PR' })).rejects.toThrow(/ขนาด/);
  });

  it('other modes : untouched (same array)', async () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'mock');
    const list = [uploaderItem(pdf())];
    expect(await uploadAttachmentsForCloudflare(list, { category: 'PR' })).toBe(list);
    expect(attachmentsForServer(list)).toBe(list);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('attachment URL helpers', () => {
  beforeEach(() => { vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('attachmentsForServer removes blob: values and keeps the server fileUrl', () => {
    const att = {
      name: 'g.jpg', fileId: 'F', fileUrl: 'https://drive.google.com/thumbnail?id=F&sz=w1200',
      previewUrl: 'blob:http://localhost/a', dataUrl: 'blob:http://localhost/a', localUrl: 'blob:http://localhost/a'
    };
    const [out] = attachmentsForServer([att, '', 'blob:http://localhost/z']);
    expect(JSON.stringify(out)).not.toContain('blob:');
    expect(out.previewUrl).toBe(att.fileUrl);
    expect(out.dataUrl).toBe(att.fileUrl);
    expect(out.localUrl).toBeUndefined();
    expect(attachmentsForServer([att, 'blob:http://localhost/z', 'https://x/y'])).toHaveLength(2);
    expect(att.previewUrl).toBe('blob:http://localhost/a'); // input not mutated (the modal keeps the live preview)
  });

  it('pickAttachmentUrl : a blob: from this session wins, a dead one falls through to fileUrl', () => {
    const live = registerBlobUrl('blob:http://localhost/live');
    const att = { localUrl: live, fileUrl: 'https://drive/x' };
    expect(pickAttachmentUrl(att, ['localUrl', 'fileUrl'])).toBe(live);
    const old = { localUrl: 'blob:http://localhost/dead', previewUrl: 'blob:http://localhost/dead', fileUrl: 'https://drive/x' };
    expect(pickAttachmentUrl(old, ['localUrl', 'previewUrl', 'fileUrl'])).toBe('https://drive/x');
    expect(pickAttachmentUrl('blob:http://localhost/dead', [])).toBe('');
    expect(pickAttachmentUrl('https://a/b', [])).toBe('https://a/b');
    expect(isUsableUrl('data:image/png;base64,AA')).toBe(true);
  });
});
