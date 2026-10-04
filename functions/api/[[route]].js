// Cloudflare Pages Functions - Native D1 REST API for PRPO
// Mounted automatically at /api/* by Cloudflare Pages

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json;charset=utf-8'
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const jsonResponse = (data, status = 200) => {
    return new Response(JSON.stringify(data), {
      status,
      headers: corsHeaders
    });
  };

  const errorResponse = (msg, status = 500) => {
    return new Response(JSON.stringify({ error: msg, success: false }), {
      status,
      headers: corsHeaders
    });
  };

  const db = env.DB;

  try {
    // ── 1. Auth Endpoint (/api/auth/login or /api/auth) ──
    if (path === '/api/auth/login' || path === '/api/auth' || path === '/api/login') {
      if (method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const cleanUser = String(body.username || '').trim().toLowerCase();
        const cleanPass = String(body.password || '').trim();

        if (!cleanUser) return errorResponse('Username is required', 400);

        if (db) {
          const user = await db.prepare(
            `SELECT * FROM users WHERE LOWER(username) = ? OR LOWER(employeeId) = ? LIMIT 1`
          ).bind(cleanUser, cleanUser).first();

          if (!user) {
            return errorResponse('ชื่อผู้ใช้งาน หรือ รหัสผ่าน ไม่ถูกต้อง', 401);
          }

          if (cleanPass && user.password && user.password !== cleanPass) {
            return errorResponse('ชื่อผู้ใช้งาน หรือ รหัสผ่าน ไม่ถูกต้อง', 401);
          }

          let depts = [user.department || 'PD'];
          if (user.allowedDepartments) {
            try {
              depts = JSON.parse(user.allowedDepartments);
            } catch {
              depts = user.allowedDepartments.split(',').map(d => d.trim()).filter(Boolean);
            }
          }

          const safeUser = { ...user, allowedDepartments: depts, departments: depts };
          delete safeUser.password;

          const token = `token_${user.id}_${Date.now()}`;
          return jsonResponse({
            success: true,
            token,
            user: safeUser
          });
        }
      }
    }

    // ── 2. Bootstrap Endpoint (/api/bootstrap) ──
    if (path === '/api/bootstrap') {
      if (!db) {
        return jsonResponse({ success: true, localMode: true });
      }

      const [
        productsRes,
        vendorsRes,
        locationsRes,
        unitsRes,
        deptsRes,
        usersRes,
        prsRes,
        posRes,
        logsRes,
        budgetsRes
      ] = await Promise.all([
        db.prepare('SELECT * FROM products WHERE isDeleted = 0').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM vendors WHERE isDeleted = 0').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM storage_locations').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM usage_units').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM departments WHERE isActive = 1').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM users WHERE status = "ACTIVE"').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM prs ORDER BY createdAt DESC').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM pos ORDER BY createdAt DESC').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM stock_logs ORDER BY createdAt DESC LIMIT 100').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM budgets').all().catch(() => ({ results: [] }))
      ]);

      const parseJsonSafe = (str, fallback = []) => {
        if (!str) return fallback;
        if (typeof str !== 'string') return str;
        try { return JSON.parse(str); } catch { return fallback; }
      };

      const prs = (prsRes.results || []).map(r => ({
        ...r,
        items: parseJsonSafe(r.itemsJson, []),
        timeline: parseJsonSafe(r.timelineJson, []),
        attachments: parseJsonSafe(r.attachmentsJson, [])
      }));

      const pos = (posRes.results || []).map(r => ({
        ...r,
        items: parseJsonSafe(r.itemsJson, []),
        timeline: parseJsonSafe(r.timelineJson, [])
      }));

      const users = (usersRes.results || []).map(u => {
        const safe = { ...u };
        delete safe.password;
        safe.allowedDepartments = parseJsonSafe(u.allowedDepartments, [u.department]);
        safe.departments = safe.allowedDepartments;
        return safe;
      });

      return jsonResponse({
        success: true,
        prs,
        pos,
        products: productsRes.results || [],
        inventory: productsRes.results || [],
        vendors: vendorsRes.results || [],
        storageLocations: locationsRes.results || [],
        usageUnits: unitsRes.results || [],
        departments: deptsRes.results || [],
        users,
        stockLogs: logsRes.results || [],
        budgets: budgetsRes.results || []
      });
    }

    // ── 3. Health & Status Check (/api/health) ──
    if (path === '/api/health') {
      return jsonResponse({
        status: 'UP',
        platform: 'Cloudflare Pages Functions + D1',
        d1Connected: Boolean(db),
        time: new Date().toISOString()
      });
    }

    // Default API Fallback
    return jsonResponse({
      message: 'Cloudflare D1 Pages API Gateway',
      path,
      method,
      d1Connected: Boolean(db)
    });

  } catch (err) {
    return errorResponse(err.message, 500);
  }
}
