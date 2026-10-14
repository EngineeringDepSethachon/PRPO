// isDriveUrl must match on the URL hostname, not on a substring of the whole string
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/services/modalService', () => ({ modalService: { alert: vi.fn(), error: vi.fn(), confirm: vi.fn() } }));

import { isDriveUrl } from '../src/services/driveService.js';

const ID = 'FILEID1234567890abcd';

describe('isDriveUrl hostname check', () => {
  it.each([
    `https://drive.google.com/file/d/${ID}/view`,
    `https://drive.google.com/open?id=${ID}`,
    `https://drive.google.com/thumbnail?id=${ID}&sz=w1600`,
    `https://docs.google.com/document/d/${ID}/edit`,
    `https://lh3.googleusercontent.com/d/${ID}`,
    `https://drive.usercontent.google.com/download?id=${ID}`,
    `drive.google.com/file/d/${ID}/view`,
    '1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
  ])('accepts real Drive URL/ID %s', (url) => {
    expect(isDriveUrl(url)).toBe(true);
  });

  it.each([
    'https://evil.example/a.pdf?x=drive.google.com',
    'https://evil.example/a.pdf?x=googleusercontent.com',
    'https://evil-drive.google.com.evil.com/a.pdf',
    'https://drive.google.com.evil.com/a.pdf',
    'https://evil.example/file/d/FILEID1234567890abcd/view',
    'https://evil.example/a.pdf?id=FILEID1234567890abcd',
    'https://notgoogleusercontent.com/d/FILEID1234567890abcd',
    'javascript:alert(1)',
    'not a url at all',
  ])('rejects spoofed or non-Drive URL %s', (url) => {
    expect(isDriveUrl(url)).toBe(false);
  });

  it('returns false for empty / non-string input', () => {
    expect(isDriveUrl('')).toBe(false);
    expect(isDriveUrl(null)).toBe(false);
    expect(isDriveUrl(undefined)).toBe(false);
  });
});
