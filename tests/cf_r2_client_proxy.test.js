// R2 attachments (url = /api/files/<uuid>, uuid fileId) are shown through the proxy by the client helpers (ProxiedImg / PODetailsModal / viewer)
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../src/services/modalService', () => ({ modalService: { alert: vi.fn(), error: vi.fn(), confirm: vi.fn(), warning: vi.fn() } }));

import { driveFileIdOf } from '../src/utils/cfAttachments.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('driveFileIdOf with R2 attachments', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('takes the uuid fileId, or the id inside the /api/files path when there is no fileId', () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    expect(driveFileIdOf({ fileId: ID, url: '' })).toBe(ID);
    expect(driveFileIdOf({ url: `/api/files/${ID}` })).toBe(ID);
    expect(driveFileIdOf({ previewUrl: `/api/files/${ID}?download=1` })).toBe(ID);
    expect(driveFileIdOf(`/api/files/${ID}`)).toBe(ID);
  });
  it('rejects look-alikes (other host, other path, bad id) and other modes', () => {
    vi.stubEnv('VITE_BACKEND_MODE', 'cloudflare');
    expect(driveFileIdOf({ url: `https://evil.example/api/files/${ID}` })).toBeNull();
    expect(driveFileIdOf({ url: `/api/files/${ID}/../x` })).toBeNull();
    expect(driveFileIdOf({ url: '/api/files/short' })).toBeNull();
    vi.stubEnv('VITE_BACKEND_MODE', 'gas');
    expect(driveFileIdOf({ fileId: ID, url: `/api/files/${ID}` })).toBeNull();
  });
});
