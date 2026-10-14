// @vitest-environment jsdom
// P5 phase 2 client : files are read through GET /api/files/:id with the Bearer header (blob: URL), cloudflare mode only
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

vi.mock('../src/services/modalService', () => ({ modalService: { alert: vi.fn(), error: vi.fn(), confirm: vi.fn() } }));

import { registerBlobUrl } from '../src/utils/attachmentUrls.js';
import { driveFileIdOf, getProxiedFileUrl, clearProxiedFileCache, useProxiedFileUrl, openProxiedFile } from '../src/utils/cfAttachments.js';

const FID = 'FILEID1234567890abcd';
const att = { fileId: FID, name: 'a.png', mimeType: 'image/png', url: `https://drive.google.com/thumbnail?id=${FID}&sz=w1200` };

describe('driveFileIdOf', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it('cloudflare mode : Drive id from fileId or from a Drive / lh3 URL ; local previews, placeholders and foreign URLs -> null', () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    expect(driveFileIdOf(att)).toBe(FID);
    expect(driveFileIdOf({ url: `https://drive.google.com/file/d/${FID}/view` })).toBe(FID);
    expect(driveFileIdOf({ lh3Url: `https://lh3.googleusercontent.com/d/${FID}` })).toBe(FID);
    expect(driveFileIdOf(`https://drive.google.com/uc?export=download&id=${FID}`)).toBe(FID);
    expect(driveFileIdOf({ ...att, previewUrl: registerBlobUrl('blob:http://localhost/x') })).toBeNull();
    expect(driveFileIdOf({ fileId: 'BASE64_ATTACHMENT_STORED_IN_DRIVE' })).toBeNull();
    expect(driveFileIdOf({ url: `https://evil.example/file/d/${FID}/view` })).toBeNull();
    expect(driveFileIdOf({ url: 'data:image/png;base64,AAAA' })).toBeNull();
    expect(driveFileIdOf(null)).toBeNull();
  });
  it('GAS and mock mode : never (unchanged behaviour)', () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'gas');
    expect(driveFileIdOf(att)).toBeNull();
    vi.stubEnv('VITE_BACKEND_MODE', 'mock');
    expect(driveFileIdOf(att)).toBeNull();
  });
});

describe('proxy fetch (cloudflare mode)', () => {
  let fetchMock;
  beforeEach(() => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    localStorage.setItem('prpo_auth_session', JSON.stringify({ token: 'tkn-1' }));
    clearProxiedFileCache();
    URL.createObjectURL = vi.fn(() => 'blob:http://localhost/file-1');
    URL.revokeObjectURL = vi.fn();
    fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); localStorage.clear(); clearProxiedFileCache(); });

  it('sends the Bearer header (token never in the URL) and caches per session', async () => {
    const a = await getProxiedFileUrl(FID);
    const b = await getProxiedFileUrl(FID);
    expect(a).toBe('blob:http://localhost/file-1');
    expect(b).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/files/${FID}`);
    expect(url).not.toContain('tkn-1');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tkn-1');
  });

  it('a different login does not reuse the cached file ; clearing revokes the blob URLs', async () => {
    await getProxiedFileUrl(FID);
    localStorage.setItem('prpo_auth_session', JSON.stringify({ token: 'tkn-2' }));
    await getProxiedFileUrl(FID);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    clearProxiedFileCache();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('session gone / session invalid events and a rotated token revoke the cached blob: URLs', async () => {
    await getProxiedFileUrl(FID);
    window.dispatchEvent(new CustomEvent('prpo_session_gone'));
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    await getProxiedFileUrl(FID);
    window.dispatchEvent(new CustomEvent('prpo_session_invalid', { detail: {} }));
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    await getProxiedFileUrl(FID);
    localStorage.setItem('prpo_auth_session', JSON.stringify({ token: 'tkn-rotated' })); // password change : new token
    await getProxiedFileUrl(FID);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3); // the blob fetched under the old token is gone
  });

  it('a download that finishes after the cache was cleared is not kept (no blob URL is even created)', async () => {
    let release;
    fetchMock.mockImplementation(() => new Promise((resolve) => { release = () => resolve(new Response(new Uint8Array([1]), { status: 200 })); }));
    const p = getProxiedFileUrl(FID);
    p.catch(() => {});
    await Promise.resolve();
    clearProxiedFileCache(); // sign-out while the file is still downloading
    release();
    await expect(p).rejects.toMatchObject({ status: 0 });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    fetchMock.mockImplementation(async () => new Response(new Uint8Array([1]), { status: 200 }));
    expect(await getProxiedFileUrl(FID)).toBe('blob:http://localhost/file-1'); // and the next request starts clean
  });

  it('logout clears the cache (AuthContext.logout calls clearProxiedFileCache)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/context/AuthContext.jsx', 'utf8');
    const logout = src.slice(src.indexOf('const logout = useCallback'), src.indexOf('}, [currentUser]);', src.indexOf('const logout = useCallback')));
    expect(logout).toContain('clearProxiedFileCache()');
  });

  it('404 is remembered for the session (old Drive links), 5xx / 429 can be retried', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 404 }));
    await expect(getProxiedFileUrl(FID)).rejects.toMatchObject({ status: 404 });
    await expect(getProxiedFileUrl(FID)).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clearProxiedFileCache();
    fetchMock.mockImplementation(async () => new Response('{}', { status: 503 }));
    await expect(getProxiedFileUrl(FID)).rejects.toMatchObject({ status: 503 });
    await expect(getProxiedFileUrl(FID)).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('hook : loading -> ready ; imagesOnly skips a PDF ; falls to error on 404', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const seen = [];
    function Probe({ a, opts }) { const r = useProxiedFileUrl(a, opts); seen.push(r.state + ':' + r.url); return null; }
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => { root.render(React.createElement(Probe, { a: att, opts: { imagesOnly: true } })); });
    expect(seen[0]).toBe('loading:');
    expect(seen[seen.length - 1]).toBe('ready:blob:http://localhost/file-1');
    seen.length = 0;
    fetchMock.mockClear();
    await act(async () => { root.render(React.createElement(Probe, { a: { ...att, fileId: 'PDFFILE1234567890abcd', mimeType: 'application/pdf', url: '' }, opts: { imagesOnly: true } })); });
    expect(seen[seen.length - 1]).toBe('off:');
    expect(fetchMock).not.toHaveBeenCalled();
    seen.length = 0;
    fetchMock.mockImplementation(async () => new Response('{}', { status: 404 }));
    await act(async () => { root.render(React.createElement(Probe, { a: { ...att, fileId: 'LEGACYFILE1234567890a' }, opts: {} })); });
    expect(seen[seen.length - 1]).toBe('error:');
    await act(async () => { root.unmount(); });
  });

  it('hook : after the token rotated the revoked blob URL is not handed out, the file is fetched again', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:http://localhost/file-${++n}`);
    const seen = [];
    function Probe() { const r = useProxiedFileUrl(att); seen.push(r.state + ':' + r.url); return null; }
    const root = createRoot(document.createElement('div'));
    await act(async () => { root.render(React.createElement(Probe)); });
    expect(seen[seen.length - 1]).toBe('ready:blob:http://localhost/file-1');
    localStorage.setItem('prpo_auth_session', JSON.stringify({ token: 'tkn-rotated' }));
    seen.length = 0;
    await act(async () => { root.render(React.createElement(Probe, { k: 2 })); });
    expect(seen).not.toContain('ready:blob:http://localhost/file-1'); // never the revoked one
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/file-1');
    expect(seen[seen.length - 1]).toBe('ready:blob:http://localhost/file-2');
    await act(async () => { root.unmount(); });
  });

  it('openProxiedFile : opens the tab inside the click, then points it at the blob URL ; false when the proxy refuses', async () => {
    const win = { location: { href: '' }, close: vi.fn(), opener: {} };
    window.open = vi.fn(() => win);
    expect(await openProxiedFile(att)).toBe(true);
    expect(window.open).toHaveBeenCalledWith('', '_blank');
    expect(win.location.href).toBe('blob:http://localhost/file-1');
    clearProxiedFileCache();
    fetchMock.mockImplementation(async () => new Response('{}', { status: 404 }));
    expect(await openProxiedFile(att)).toBe(false);
    expect(win.close).toHaveBeenCalled();
    vi.stubEnv('VITE_BACKEND_MODE', 'gas');
    window.open.mockClear();
    expect(await openProxiedFile(att)).toBe(false);
    expect(window.open).not.toHaveBeenCalled();
  });
});
