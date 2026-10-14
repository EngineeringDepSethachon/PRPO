// @vitest-environment node
// T1.8: CORS allow-list from env.ALLOWED_ORIGINS (exact match, echo + Vary), same-origin default, dev shortcut, preflight = same rule.
import { describe, it, expect } from 'vitest';
import { onRequest } from '../functions/api/[[route]].js';
import { parseAllowedOrigins, pickAllowedOrigin, buildCorsHeaders, DEV_ORIGINS } from '../functions/_lib/cors.js';

const SECRET = 'unit-test-secret-0123456789abcdef';
const req = (method, origin, p = '/api/health') => new Request(`https://prpo.pages.dev${p}`, { method, headers: origin ? { Origin: origin } : {} });
const call = (method, origin, env, p) => onRequest({ request: req(method, origin, p), env: { AUTH_TOKEN_SECRET: SECRET, ...env } });
const acao = (res) => res.headers.get('Access-Control-Allow-Origin');

describe('T1.8 CORS', () => {
  it('parse: trims, drops empties, ignores "*", strips trailing slash', () => {
    expect(parseAllowedOrigins({ ALLOWED_ORIGINS: ' https://a.com/ , ,*,https://b.com' })).toEqual(['https://a.com', 'https://b.com']);
    expect(parseAllowedOrigins({})).toEqual([]);
  });

  it('matching origin is echoed with Vary: Origin ; non-matching gets no ACAO ; "*" never honoured', async () => {
    const env = { ALLOWED_ORIGINS: 'https://app.example.com,https://admin.example.com' };
    const ok = await call('GET', 'https://admin.example.com', env);
    expect(acao(ok)).toBe('https://admin.example.com');
    expect(ok.headers.get('Vary')).toBe('Origin');
    expect(ok.status).toBe(401); // error responses carry the same CORS headers
    expect(acao(await call('GET', 'https://evil.example.com', env))).toBeNull();
    expect(acao(await call('GET', 'https://app.example.com.evil.com', env))).toBeNull(); // exact match, not prefix
    expect(acao(await call('GET', 'http://app.example.com', env))).toBeNull(); // scheme matters
    expect(acao(await call('GET', 'https://anything.com', { ALLOWED_ORIGINS: '*' }))).toBeNull();
    expect(acao(await call('GET', null, env))).toBeNull(); // same-origin / non-browser: no Origin header
  });

  it('not configured => same-origin only (no ACAO) ; dev shortcut only for ALLOW_DEV_SEED=true or ENVIRONMENT=dev', async () => {
    for (const o of ['https://app.example.com', DEV_ORIGINS[0]]) expect(acao(await call('GET', o, {}))).toBeNull();
    for (const env of [{ ALLOW_DEV_SEED: 'true' }, { ENVIRONMENT: 'dev' }, { ENVIRONMENT: 'DEV' }]) {
      for (const o of DEV_ORIGINS) expect(acao(await call('GET', o, env))).toBe(o);
      expect(acao(await call('GET', 'http://localhost:3000', env))).toBeNull();
      expect(acao(await call('GET', 'https://app.example.com', env))).toBeNull();
    }
    expect(acao(await call('GET', DEV_ORIGINS[0], { ENVIRONMENT: 'production' }))).toBeNull();
    // an explicit list wins over the dev shortcut
    expect(acao(await call('GET', DEV_ORIGINS[0], { ALLOW_DEV_SEED: 'true', ALLOWED_ORIGINS: 'https://app.example.com' }))).toBeNull();
  });

  it('preflight (OPTIONS) follows the same rule', async () => {
    const env = { ALLOWED_ORIGINS: 'https://app.example.com' };
    const ok = await call('OPTIONS', 'https://app.example.com', env, '/api/prs');
    expect(ok.status).toBe(200);
    expect(acao(ok)).toBe('https://app.example.com');
    expect(ok.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
    expect(ok.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    expect(ok.headers.get('Vary')).toBe('Origin');
    const bad = await call('OPTIONS', 'https://evil.example.com', env, '/api/prs');
    expect(bad.status).toBe(200);
    expect(acao(bad)).toBeNull();
    expect(bad.headers.get('Access-Control-Allow-Methods')).toBeNull();
    expect(acao(await call('OPTIONS', 'https://app.example.com', {}, '/api/prs'))).toBeNull();
  });

  it('allow-list is case-insensitive ; the opaque origin "null" is never allowed (even if listed)', async () => {
    const env = { ALLOWED_ORIGINS: 'HTTPS://App.Example.com, null' };
    expect(parseAllowedOrigins(env)).toEqual(['https://app.example.com']);
    expect(acao(await call('GET', 'https://app.example.com', env))).toBe('https://app.example.com');
    expect(acao(await call('GET', 'HTTPS://APP.EXAMPLE.COM', env))).toBe('HTTPS://APP.EXAMPLE.COM'); // echoes what the browser sent
    expect(acao(await call('GET', 'null', env))).toBeNull();
    expect(acao(await call('GET', 'null', { ALLOWED_ORIGINS: 'null' }))).toBeNull();
    expect(acao(await call('GET', 'NULL', { ENVIRONMENT: 'dev' }))).toBeNull();
    expect(acao(await call('GET', 'HTTP://LOCALHOST:5173', { ENVIRONMENT: 'dev' }))).toBe('HTTP://LOCALHOST:5173');
  });

  it('the signing secret needs >= 32 chars', async () => {
    const { hasSecret } = await import('../functions/_lib/auth.js');
    const good = 'k7Qz'.repeat(8); // 32 random-looking chars (a run of x's would be rejected as a placeholder)
    expect(hasSecret({ AUTH_TOKEN_SECRET: good.slice(0, 31) })).toBe(false);
    expect(hasSecret({ AUTH_TOKEN_SECRET: good })).toBe(true);
    expect(hasSecret({ AUTH_TOKEN_SECRET: 'REPLACE_ME' })).toBe(false);
    expect(hasSecret({})).toBe(false);
  });

  it('buildCorsHeaders keeps the JSON content type', () => {
    expect(buildCorsHeaders({}, req('GET', null))['Content-Type']).toContain('application/json');
    expect(pickAllowedOrigin({ ALLOWED_ORIGINS: 'https://a.com' }, req('GET', 'https://a.com'))).toBe('https://a.com');
  });
});
