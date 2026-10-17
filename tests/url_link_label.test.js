// getLinkLabel: label และ host สำหรับลิงก์สินค้า (pure function, ไม่มี side effect)
import { describe, it, expect } from 'vitest';
import { getLinkLabel } from '../src/utils/urlHelper.js';

const EMPTY = { label: '', host: '' };

describe('getLinkLabel protocol / www / host', () => {
  it('parses url with https protocol', () => {
    expect(getLinkLabel('https://shopee.co.th/product/1')).toEqual({ label: 'Shopee', host: 'shopee.co.th' });
  });

  it('parses url with http protocol', () => {
    expect(getLinkLabel('http://shopee.co.th/product/1')).toEqual({ label: 'Shopee', host: 'shopee.co.th' });
  });

  it('adds https when protocol is missing', () => {
    expect(getLinkLabel('shopee.co.th/product/1')).toEqual({ label: 'Shopee', host: 'shopee.co.th' });
    expect(getLinkLabel('  www.lazada.co.th/x  ')).toEqual({ label: 'Lazada', host: 'lazada.co.th' });
  });

  it('strips leading www.', () => {
    expect(getLinkLabel('https://www.example.com/a')).toEqual({ label: 'example.com', host: 'example.com' });
    expect(getLinkLabel('www.example.com')).toEqual({ label: 'example.com', host: 'example.com' });
  });

  it('keeps subdomains other than www', () => {
    expect(getLinkLabel('https://m.facebook.com/x')).toEqual({ label: 'Facebook', host: 'm.facebook.com' });
  });

  it('lowercases host', () => {
    expect(getLinkLabel('https://WWW.Example.COM/a')).toEqual({ label: 'example.com', host: 'example.com' });
  });

  it('handles protocol-less host with port', () => {
    expect(getLinkLabel('localhost:5173/x')).toEqual({ label: 'localhost', host: 'localhost' });
  });

  it('returns host as label for generic host', () => {
    expect(getLinkLabel('https://www.somestore.co.th/p/123')).toEqual({ label: 'somestore.co.th', host: 'somestore.co.th' });
  });
});

describe('getLinkLabel platform detected from host', () => {
  it.each([
    ['https://shopee.co.th/product/1', 'Shopee', 'shopee.co.th'],
    ['https://www.lazada.co.th/products/x', 'Lazada', 'lazada.co.th'],
    ['https://www.nocnoc.com/product/x', 'NocNoc', 'nocnoc.com'],
    ['https://www.jd.com/item/1.html', 'JD Central', 'jd.com'],
    ['https://www.jd.co.th/item/1', 'JD Central', 'jd.co.th'],
    ['https://www.amazon.co.jp/dp/B000', 'Amazon', 'amazon.co.jp'],
    ['https://www.aliexpress.com/item/1.html', 'AliExpress', 'aliexpress.com'],
    ['https://shop.line.me/@abc/product/1', 'LINE Shopping', 'shop.line.me'],
    ['https://www.facebook.com/marketplace/item/1', 'Facebook', 'facebook.com'],
    ['https://www.tiktok.com/view/product/1', 'TikTok Shop', 'tiktok.com'],
  ])('%s -> %s', (url, label, host) => {
    expect(getLinkLabel(url)).toEqual({ label, host });
  });

  it('jdcentral.co.th / shopee.com.my ไม่อยู่ใน allowlist -> label = host', () => {
    expect(getLinkLabel('https://www.jdcentral.co.th/p/1')).toEqual({ label: 'jdcentral.co.th', host: 'jdcentral.co.th' });
    expect(getLinkLabel('https://shopee.com.my/x')).toEqual({ label: 'shopee.com.my', host: 'shopee.com.my' });
  });

  it('does not treat line.me outside shop.line.me as LINE Shopping', () => {
    expect(getLinkLabel('https://line.me/R/ti/p/@x')).toEqual({ label: 'line.me', host: 'line.me' });
  });

  it('matches whole domain labels, not substrings', () => {
    expect(getLinkLabel('https://notshopee.com/x')).toEqual({ label: 'notshopee.com', host: 'notshopee.com' });
    expect(getLinkLabel('https://myjd.example.com/x')).toEqual({ label: 'myjd.example.com', host: 'myjd.example.com' });
  });
});

describe('getLinkLabel registrable domain (ห้ามโดเมนปลอมได้ป้ายแพลตฟอร์ม)', () => {
  it.each([
    'https://shopee.evil.com/x',
    'https://lazada.co.th.evil.com/x',
    'https://www.shopee.attacker.co.th/x',
    'https://facebook.com.evil.net/x',
    'https://amazon.evil.org/x',
    'https://tiktok.example.co.uk/x',
  ])('%s ไม่ใช่แพลตฟอร์มที่รู้จัก -> label = host', (url) => {
    const { label, host } = getLinkLabel(url);
    expect(label).toBe(host);
  });

  it.each([
    ['https://shopee.co.th/x', 'Shopee'],
    ['https://m.shopee.co.th/x', 'Shopee'],
    ['https://shopee.sg/x', 'Shopee'],
    ['https://shopee.com/x', 'Shopee'],
    ['https://th.lazada.co.th/x', 'Lazada'],
    ['https://www.nocnoc.com/x', 'NocNoc'],
    ['https://www.jd.co.th/x', 'JD Central'],
    ['https://shop.line.me/x', 'LINE Shopping'],
    ['https://store.shop.line.me/x', 'LINE Shopping'],
    ['https://m.facebook.com/x', 'Facebook'],
    ['https://vt.tiktok.com/x', 'TikTok Shop'],
    ['https://www.amazon.co.jp/x', 'Amazon'],
    ['https://www.amazon.com/x', 'Amazon'],
    ['https://www.aliexpress.com/x', 'AliExpress'],
  ])('%s -> %s', (url, label) => {
    expect(getLinkLabel(url).label).toBe(label);
  });

  it('shop.line.me ปลอมใต้โดเมนอื่นไม่ได้ป้าย LINE Shopping', () => {
    expect(getLinkLabel('https://shop.line.me.evil.com/x').label).toBe('shop.line.me.evil.com');
  });
});

describe('getLinkLabel allowlist (โดเมนตรงตัวเท่านั้น)', () => {
  it.each([
    ['https://shopee.xyz/x', 'shopee.xyz'],
    ['https://shopee.com.zz/x', 'shopee.com.zz'],
    ['https://shopee.co.th.zz/x', 'shopee.co.th.zz'],
    ['https://lazada.com.evil.net/x', 'lazada.com.evil.net'],
    ['https://xn--shopee-7ya.co.th/x', 'xn--shopee-7ya.co.th'],
    ['https://shopee.xn--p1ai/x', 'shopee.xn--p1ai'],
  ])('%s -> ไม่ใช่แบรนด์ label = host (%s)', (url, host) => {
    expect(getLinkLabel(url)).toEqual({ label: host, host });
  });

  it('userinfo ที่ทำเป็น shopee.co.th ไม่ทำให้ได้ป้าย Shopee (host จริงคือ evil.com)', () => {
    const r = getLinkLabel('https://shopee.co.th@evil.com/x');
    expect(r).toEqual({ label: 'evil.com', host: 'evil.com' });
    expect(r.label).not.toBe('Shopee');
  });

  it('java\\tscript: ไม่ได้ป้ายแบรนด์และไม่มี host', () => {
    const r = getLinkLabel('java\tscript:alert(1)');
    expect(r.label).toBe(r.host);
    expect(r.host).toBe('');
    expect(r.label).toBe('');
  });

  it('ไม่มีการคืน prototype key เป็นป้าย', () => {
    expect(getLinkLabel('https://constructor/x').label).toBe('constructor');
  });
});

describe('getLinkLabel ignores platform param when host is not a known platform', () => {
  it.each(['Shopee', 'Lazada', 'foo', '', null, undefined, 42, 'constructor'])('platform %j on generic host -> label = host', (platform) => {
    expect(getLinkLabel('https://www.homepro.co.th/p', platform)).toEqual({ label: 'homepro.co.th', host: 'homepro.co.th' });
  });

  it('platform ที่ขัดกับ host ที่รู้จัก -> ใช้ host', () => {
    expect(getLinkLabel('https://shopee.co.th/x', 'Lazada')).toEqual({ label: 'Shopee', host: 'shopee.co.th' });
  });
});
describe('getLinkLabel invalid input', () => {
  it.each([
    'http://',
    'https://',
    'not a url at all',
    'https://exa mple.com',
    '   ',
  ])('returns empty for broken url %j', (url) => {
    expect(getLinkLabel(url)).toEqual(EMPTY);
    expect(getLinkLabel(url, 'Shopee')).toEqual(EMPTY);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'javascript:1',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'mailto:someone@example.com',
    'ftp://shopee.co.th/file',
    'file:///C:/secret.txt',
  ])('returns empty for non-http(s) url %s', (url) => {
    expect(getLinkLabel(url)).toEqual(EMPTY);
    expect(getLinkLabel(url, 'Shopee')).toEqual(EMPTY);
  });

  it.each([
    ['', undefined],
    [undefined, undefined],
    [null, undefined],
    [123, 'Shopee'],
    [{}, 'Shopee'],
  ])('returns empty for empty/non-string url %j', (url, platform) => {
    expect(getLinkLabel(url, platform)).toEqual(EMPTY);
  });

  it('returns empty when url is empty even if platform is given', () => {
    expect(getLinkLabel('', 'Shopee')).toEqual(EMPTY);
    expect(getLinkLabel(undefined, 'Shopee')).toEqual(EMPTY);
  });

  it('handles missing platform argument', () => {
    expect(getLinkLabel('https://example.com/p')).toEqual({ label: 'example.com', host: 'example.com' });
    expect(getLinkLabel('https://shopee.co.th/p')).toEqual({ label: 'Shopee', host: 'shopee.co.th' });
  });

  it('handles null / undefined / number platform without throwing', () => {
    expect(getLinkLabel('https://example.com/p', null).label).toBe('example.com');
    expect(getLinkLabel('https://example.com/p', undefined).label).toBe('example.com');
    expect(getLinkLabel('https://example.com/p', 42).label).toBe('example.com');
  });
});
