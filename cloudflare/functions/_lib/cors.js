// CORS policy (T1.8). Not a route (folder starts with "_").
//  - env.ALLOWED_ORIGINS = comma separated list of exact origins ("https://app.example.com,https://admin.example.com").
//    The request Origin must match one of them exactly -> it is echoed back (Access-Control-Allow-Origin) ; otherwise no ACAO header.
//  - ALLOWED_ORIGINS not set -> same-origin only (no ACAO header at all) ... except in dev (env.ALLOW_DEV_SEED === 'true' or
//    env.ENVIRONMENT === 'dev'), where the local dev servers http://localhost:5173 (vite) and http://localhost:8788 (wrangler pages dev)
//    are allowed.
//  - "*" is never honoured (the API uses the Authorization header).
export const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:8788'];

// entries are compared lower-case (scheme and host are case-insensitive) ; "*" and "null" (opaque origins: sandboxed iframes, file://) are never allowed
export function parseAllowedOrigins(env) {
  const raw = env && typeof env.ALLOWED_ORIGINS === 'string' ? env.ALLOWED_ORIGINS : '';
  return raw.split(',').map((s) => s.trim().replace(/\/+$/, '').toLowerCase()).filter((s) => s && s !== '*' && s !== 'null');
}

export function isDevEnv(env) {
  return Boolean(env) && (env.ALLOW_DEV_SEED === 'true' || String(env.ENVIRONMENT || '').toLowerCase() === 'dev');
}

// -> the origin to echo, or null (no ACAO header)
export function pickAllowedOrigin(env, request) {
  const origin = request && request.headers ? request.headers.get('Origin') : null;
  if (!origin) return null;
  const lower = origin.trim().toLowerCase();
  if (lower === 'null' || lower === '*') return null;
  let allowed = parseAllowedOrigins(env);
  if (allowed.length === 0 && isDevEnv(env)) allowed = DEV_ORIGINS;
  return allowed.includes(lower) ? origin : null;
}

export function buildCorsHeaders(env, request) {
  const headers = { 'Content-Type': 'application/json;charset=utf-8', Vary: 'Origin' };
  const origin = pickAllowedOrigin(env, request);
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}
