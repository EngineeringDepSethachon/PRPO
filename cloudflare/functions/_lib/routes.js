// Route table of functions/api/[[route]].js (T3.2). Not a route (folder starts with "_").
// The handlers stay inline in [[route]].js ; this table is the single readable list of what the API serves, and is used for :
//   - the fallback : unknown path -> 404 JSON, known path with an unsupported method -> 405 JSON (+ Allow header) - never a silent 200
//   - tests/cf_docnum_routes.test.js : every "/api/..." the client (src/) calls must match an entry here (or be listed in NOT_SERVED)
// Authorization is NOT here : see ENDPOINT_RULES in rbac.js (unlisted writes are denied 403 before routing).
// `methods` = what the handler really answers ; OPTIONS (CORS preflight) is answered before routing for every path.

const seg = '[^/]+';

export const API_ROUTES = [
  { id: 'auth', re: /^\/api\/(auth(\/login)?|login)$/, methods: ['POST'] },
  { id: 'bootstrap', re: /^\/api\/bootstrap$/, methods: ['GET'] },
  { id: 'health', re: /^\/api\/health$/, methods: ['GET'] },

  { id: 'prs', re: /^\/api\/(prs|pr)$/, methods: ['GET', 'POST'] },
  { id: 'pr-by-id', re: new RegExp(`^/api/prs/${seg}$`), methods: ['GET', 'PUT', 'DELETE'] }, // GET answers the list (legacy)
  { id: 'pos', re: /^\/api\/(pos|po)$/, methods: ['GET', 'POST'] },
  { id: 'po-by-id', re: new RegExp(`^/api/pos/${seg}$`), methods: ['GET', 'PUT'] },
  { id: 'po-receive', re: new RegExp(`^/api/(pos/${seg}/receive|receive-goods|receive|grn|inventory/receive)$`), methods: ['POST'] },
  { id: 'po-settle', re: new RegExp(`^/api/pos/${seg}/settle$`), methods: ['POST'] },

  { id: 'products', re: /^\/api\/products(\/batch)?$/, methods: ['GET', 'POST', 'PUT'] },
  { id: 'products-mac', re: /^\/api\/products\/recalculate-mac$/, methods: ['POST'] },
  { id: 'product-by-id', re: new RegExp(`^/api/products/${seg}$`), methods: ['GET', 'PUT', 'DELETE'] },
  { id: 'vendors', re: /^\/api\/vendors$/, methods: ['GET', 'POST', 'PUT'] },
  { id: 'vendor-by-id', re: new RegExp(`^/api/vendors/${seg}$`), methods: ['GET', 'PUT', 'DELETE'] },
  { id: 'storage-locations', re: /^\/api\/storage-locations$/, methods: ['GET', 'POST'] },
  { id: 'storage-location-by-id', re: new RegExp(`^/api/storage-locations/${seg}$`), methods: ['GET', 'PUT', 'DELETE'] },
  { id: 'usage-units', re: /^\/api\/usage-units$/, methods: ['GET', 'POST'] },
  { id: 'usage-unit-by-id', re: new RegExp(`^/api/usage-units/${seg}$`), methods: ['PUT', 'DELETE'] },
  { id: 'departments', re: /^\/api\/departments$/, methods: ['GET', 'POST', 'PUT'] },
  { id: 'department-by-id', re: new RegExp(`^/api/departments/${seg}$`), methods: ['GET', 'PUT', 'DELETE'] },
  { id: 'users', re: /^\/api\/(users|user)$/, methods: ['GET', 'POST', 'PUT'] },
  { id: 'user-by-id', re: new RegExp(`^/api/users/${seg}$`), methods: ['GET', 'PUT', 'DELETE'] },

  { id: 'stock-logs', re: /^\/api\/stock-logs$/, methods: ['GET', 'POST'] },
  { id: 'stock-issue', re: /^\/api\/(stock\/issue|inventory\/issue)$/, methods: ['POST'] },

  { id: 'budgets', re: /^\/api\/budgets$/, methods: ['GET', 'POST'] },
  { id: 'budgets-adjust', re: /^\/api\/budgets\/adjust$/, methods: ['POST'] },
  { id: 'budgets-allocate', re: /^\/api\/budgets\/allocate$/, methods: ['POST'] },
  { id: 'budgets-reset', re: /^\/api\/budgets\/reset$/, methods: ['POST'] },
  { id: 'budget-by-dept', re: new RegExp(`^/api/budgets/${seg}$`), methods: ['GET', 'PUT'] },
  { id: 'budget-transactions', re: /^\/api\/budget-transactions(\/.+)?$/, methods: ['GET', 'POST'] },

  { id: 'notifications', re: /^\/api\/notifications$/, methods: ['GET', 'POST'] },
  { id: 'notification-by-id', re: new RegExp(`^/api/notifications/${seg}$`), methods: ['PUT'] },
  { id: 'audit-logs', re: /^\/api\/audit-logs$/, methods: ['GET', 'POST'] },
  { id: 'signatures', re: /^\/api\/signatures$/, methods: ['GET', 'POST'] },
  { id: 'signature-by-role', re: new RegExp(`^/api/signatures/${seg}$`), methods: ['PUT'] },
  { id: 'me', re: /^\/api\/me$/, methods: ['GET'] },
  { id: 'me-password', re: /^\/api\/me\/password$/, methods: ['POST'] },
  { id: 'logout', re: /^\/api\/logout$/, methods: ['POST'] },
  { id: 'upload', re: /^\/api\/upload$/, methods: ['POST'] }, // Google Drive (functions/_lib/upload.js)
  { id: 'files', re: new RegExp(`^/api/files/${seg}$`), methods: ['GET'] }, // authenticated download proxy (functions/_lib/files.js)
  { id: 'admin-cleanup-orphans', re: /^\/api\/admin\/cleanup-orphans$/, methods: ['POST'] }, // admin only, dry run by default (functions/_lib/orphans.js)
  { id: 'admin-restore-orphan', re: /^\/api\/admin\/restore-orphan$/, methods: ['POST'] }, // admin only : undo one cleanup
  { id: 'admin-unshare-public', re: /^\/api\/admin\/unshare-public$/, methods: ['POST'] } // admin only, dry run by default (functions/_lib/unshare.js)
];

// Calls the client makes that the Cloudflare backend deliberately does not serve (yet) : they answer 404 JSON and the client has a fallback.
//  /api/storage : the mock backend's whole-state blob ; in cloudflare mode the app loads through /api/bootstrap, and storageService
//                 ignores a non-ok answer (before T3.2 the old 200 fallback body was cached as if it were the app state)
export const NOT_SERVED = [
  { re: /^\/api\/storage$/, note: 'mock-only state blob' }
];

export function matchRoutes(path) {
  return API_ROUTES.filter((r) => r.re.test(path));
}

// -> { status: 404 | 405, allow?: string[] }
export function classifyUnhandled(method, path) {
  const hits = matchRoutes(path);
  if (hits.length === 0) return { status: 404 };
  const allow = [...new Set(hits.flatMap((r) => r.methods))];
  return allow.includes(String(method).toUpperCase()) ? { status: 404 } : { status: 405, allow };
}
