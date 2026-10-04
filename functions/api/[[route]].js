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

  const parseJsonSafe = (str, fallback = []) => {
    if (!str) return fallback;
    if (typeof str !== 'string') return str;
    try { return JSON.parse(str); } catch { return fallback; }
  };

  try {
    // ── 1. Auth Endpoint (/api/auth/login or /api/auth or /api/login) ──
    if (path === '/api/auth/login' || path === '/api/auth' || path === '/api/login') {
      if (method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const cleanUser = String(body.username || '').trim().toLowerCase();
        const cleanPass = String(body.password || '').trim();

        if (!cleanUser) return errorResponse('Username is required', 400);

        if (!db) {
          return errorResponse('D1 Database binding (env.DB) is not available', 500);
        }

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
        db.prepare('SELECT * FROM stock_logs ORDER BY createdAt DESC LIMIT 200').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM budgets').all().catch(() => ({ results: [] }))
      ]);

      const prs = (prsRes.results || []).map(r => ({
        ...r,
        prNo: r.prNumber,
        items: parseJsonSafe(r.itemsJson, []),
        timeline: parseJsonSafe(r.timelineJson, []),
        attachments: parseJsonSafe(r.attachmentsJson, []),
        approvalWorkflow: parseJsonSafe(r.approvalWorkflowJson, {})
      }));

      const pos = (posRes.results || []).map(r => ({
        ...r,
        poNo: r.poNumber,
        items: parseJsonSafe(r.itemsJson, []),
        timeline: parseJsonSafe(r.timelineJson, []),
        evidence: parseJsonSafe(r.evidenceJson, {})
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

    // ── 3. PRs Endpoints (/api/prs or /api/pr) ──
    if (path === '/api/prs' || path === '/api/pr' || path.startsWith('/api/prs/')) {
      if (!db) return jsonResponse([]);
      const subId = path.startsWith('/api/prs/') ? decodeURIComponent(path.replace('/api/prs/', '')) : null;

      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM prs ORDER BY createdAt DESC').all();
        const prs = (res.results || []).map(r => ({
          ...r,
          prNo: r.prNumber,
          items: parseJsonSafe(r.itemsJson, []),
          timeline: parseJsonSafe(r.timelineJson, []),
          attachments: parseJsonSafe(r.attachmentsJson, []),
          approvalWorkflow: parseJsonSafe(r.approvalWorkflowJson, {})
        }));
        return jsonResponse(prs);
      }

      if (method === 'POST') {
        const data = await request.json().catch(() => ({}));
        const prList = Array.isArray(data) ? data : [data];
        for (const p of prList) {
          const prId = p.id || `PR-${Date.now()}`;
          const prNo = p.prNumber || p.prNo || prId;
          const dept = p.department || 'PD';
          const reqId = p.requesterId || '';
          const reqName = p.requesterName || p.requester || '';
          const status = p.status || 'SUBMITTED';
          const total = Number(p.totalAmount || p.total || 0);
          const reason = p.reason || p.purpose || '';
          const itemsJson = JSON.stringify(p.items || []);
          const timelineJson = JSON.stringify(p.timeline || []);
          const attachmentsJson = JSON.stringify(p.attachments || []);
          const approvalWorkflowJson = JSON.stringify(p.approvalWorkflow || {});

          await db.prepare(`
            INSERT INTO prs (id, prNumber, department, requesterId, requesterName, status, totalAmount, reason, itemsJson, timelineJson, attachmentsJson, approvalWorkflowJson, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
              status = excluded.status,
              totalAmount = excluded.totalAmount,
              reason = excluded.reason,
              itemsJson = excluded.itemsJson,
              timelineJson = excluded.timelineJson,
              attachmentsJson = excluded.attachmentsJson,
              approvalWorkflowJson = excluded.approvalWorkflowJson,
              updatedAt = CURRENT_TIMESTAMP
          `).bind(prId, prNo, dept, reqId, reqName, status, total, reason, itemsJson, timelineJson, attachmentsJson, approvalWorkflowJson).run();
        }
        return jsonResponse({ success: true, count: prList.length });
      }

      if (method === 'PUT' && subId) {
        const p = await request.json().catch(() => ({}));
        const status = p.status;
        const itemsJson = p.items ? JSON.stringify(p.items) : null;
        const timelineJson = p.timeline ? JSON.stringify(p.timeline) : null;
        const approvalWorkflowJson = p.approvalWorkflow ? JSON.stringify(p.approvalWorkflow) : null;

        await db.prepare(`
          UPDATE prs SET 
            status = COALESCE(?, status),
            itemsJson = COALESCE(?, itemsJson),
            timelineJson = COALESCE(?, timelineJson),
            approvalWorkflowJson = COALESCE(?, approvalWorkflowJson),
            updatedAt = CURRENT_TIMESTAMP
          WHERE id = ? OR prNumber = ?
        `).bind(status, itemsJson, timelineJson, approvalWorkflowJson, subId, subId).run();

        return jsonResponse({ success: true, id: subId });
      }

      if (method === 'DELETE' && subId) {
        await db.prepare('DELETE FROM prs WHERE id = ? OR prNumber = ?').bind(subId, subId).run();
        return jsonResponse({ success: true, id: subId });
      }
    }

    // ── 4. POs Endpoints (/api/pos or /api/po) ──
    if (path === '/api/pos' || path === '/api/po' || path.startsWith('/api/pos/')) {
      if (!db) return jsonResponse([]);
      const subId = path.startsWith('/api/pos/') ? decodeURIComponent(path.replace('/api/pos/', '')) : null;

      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM pos ORDER BY createdAt DESC').all();
        const pos = (res.results || []).map(r => ({
          ...r,
          poNo: r.poNumber,
          items: parseJsonSafe(r.itemsJson, []),
          timeline: parseJsonSafe(r.timelineJson, []),
          evidence: parseJsonSafe(r.evidenceJson, {})
        }));
        return jsonResponse(pos);
      }

      if (method === 'POST') {
        const data = await request.json().catch(() => ({}));
        const poList = Array.isArray(data) ? data : [data];
        for (const p of poList) {
          const poId = p.id || `PO-${Date.now()}`;
          const poNo = p.poNumber || p.poNo || poId;
          const prId = p.prId || '';
          const prNo = p.prNumber || p.prNo || '';
          const dept = p.department || 'PD';
          const vendorId = p.vendorId || p.supplierId || '';
          const vendorName = p.vendorName || p.supplierName || '';
          const total = Number(p.totalAmount || p.total || 0);
          const vat = Number(p.vatAmount || 0);
          const grand = Number(p.grandTotal || total);
          const status = p.status || 'ORDERED';
          const itemsJson = JSON.stringify(p.items || []);
          const paymentTerms = p.paymentTerms || '';
          const deliveryDate = p.deliveryDate || '';
          const timelineJson = JSON.stringify(p.timeline || []);
          const evidenceJson = JSON.stringify(p.evidence || {});

          await db.prepare(`
            INSERT INTO pos (id, poNumber, prId, prNumber, department, vendorId, vendorName, totalAmount, vatAmount, grandTotal, status, itemsJson, paymentTerms, deliveryDate, timelineJson, evidenceJson, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
              status = excluded.status,
              totalAmount = excluded.totalAmount,
              grandTotal = excluded.grandTotal,
              itemsJson = excluded.itemsJson,
              timelineJson = excluded.timelineJson,
              evidenceJson = excluded.evidenceJson,
              updatedAt = CURRENT_TIMESTAMP
          `).bind(poId, poNo, prId, prNo, dept, vendorId, vendorName, total, vat, grand, status, itemsJson, paymentTerms, deliveryDate, timelineJson, evidenceJson).run();
        }
        return jsonResponse({ success: true, count: poList.length });
      }

      if (method === 'PUT' && subId) {
        const p = await request.json().catch(() => ({}));
        await db.prepare(`
          UPDATE pos SET 
            status = COALESCE(?, status),
            itemsJson = COALESCE(?, itemsJson),
            timelineJson = COALESCE(?, timelineJson),
            evidenceJson = COALESCE(?, evidenceJson),
            updatedAt = CURRENT_TIMESTAMP
          WHERE id = ? OR poNumber = ?
        `).bind(p.status || null, p.items ? JSON.stringify(p.items) : null, p.timeline ? JSON.stringify(p.timeline) : null, p.evidence ? JSON.stringify(p.evidence) : null, subId, subId).run();

        return jsonResponse({ success: true, id: subId });
      }
    }

    // ── 5. Products Catalog Endpoints (/api/products) ──
    if (path === '/api/products' || path === '/api/products/batch' || path.startsWith('/api/products/')) {
      if (!db) return jsonResponse([]);
      const subId = path.startsWith('/api/products/') && path !== '/api/products/batch'
        ? decodeURIComponent(path.replace('/api/products/', ''))
        : null;

      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM products WHERE isDeleted = 0').all();
        return jsonResponse(res.results || []);
      }

      if (method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const prods = Array.isArray(body) ? body : (body.products || [body]);
        for (const p of prods) {
          const id = p.id || `PROD-${Date.now()}`;
          const code = p.code || p.itemCode || id;
          const name = p.name || p.itemName || '';
          const cat = p.category || p.department || 'PD';
          const purchaseUnit = p.purchaseUnit || p.unit || 'ชิ้น';
          const usageUnit = p.usageUnit || p.stockUnit || purchaseUnit;
          const convRate = Number(p.conversionRate || 1);
          const minStock = Number(p.minStock || 0);
          const curStock = Number(p.currentStock ?? p.stockBalance ?? 0);
          const price = Number(p.price ?? p.standardPrice ?? 0);
          const locId = p.locationId || p.defaultLocationId || '';
          const dept = p.department || cat;

          await db.prepare(`
            INSERT INTO products (id, code, name, category, purchaseUnit, usageUnit, conversionRate, minStock, currentStock, standardPrice, defaultLocationId, department, isDeleted, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              currentStock = excluded.currentStock,
              standardPrice = excluded.standardPrice,
              defaultLocationId = excluded.defaultLocationId,
              minStock = excluded.minStock,
              updatedAt = CURRENT_TIMESTAMP
          `).bind(id, code, name, cat, purchaseUnit, usageUnit, convRate, minStock, curStock, price, locId, dept).run();
        }
        return jsonResponse({ success: true, count: prods.length });
      }

      if (method === 'DELETE' && subId) {
        await db.prepare('UPDATE products SET isDeleted = 1, updatedAt = CURRENT_TIMESTAMP WHERE id = ? OR code = ?').bind(subId, subId).run();
        return jsonResponse({ success: true, id: subId });
      }
    }

    // ── 6. Vendors Endpoints (/api/vendors) ──
    if (path === '/api/vendors' || path.startsWith('/api/vendors/')) {
      if (!db) return jsonResponse([]);
      const subId = path.startsWith('/api/vendors/') ? decodeURIComponent(path.replace('/api/vendors/', '')) : null;

      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM vendors WHERE isDeleted = 0').all();
        return jsonResponse(res.results || []);
      }

      if (method === 'POST') {
        const v = await request.json().catch(() => ({}));
        const vList = Array.isArray(v) ? v : [v];
        for (const item of vList) {
          const id = item.id || `VEN-${Date.now()}`;
          const code = item.code || item.vendorCode || id;
          const name = item.name || '';
          const contact = item.contactPerson || '';
          const phone = item.phone || '';
          const email = item.email || '';
          const address = item.address || '';
          const taxId = item.taxId || '';
          const term = item.paymentTerm || '';
          const dept = item.department || 'ALL';

          await db.prepare(`
            INSERT INTO vendors (id, code, name, contactPerson, phone, email, address, taxId, paymentTerm, department, isDeleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              contactPerson = excluded.contactPerson,
              phone = excluded.phone,
              email = excluded.email,
              address = excluded.address,
              paymentTerm = excluded.paymentTerm
          `).bind(id, code, name, contact, phone, email, address, taxId, term, dept).run();
        }
        return jsonResponse({ success: true, count: vList.length });
      }

      if (method === 'DELETE' && subId) {
        await db.prepare('UPDATE vendors SET isDeleted = 1 WHERE id = ? OR code = ?').bind(subId, subId).run();
        return jsonResponse({ success: true, id: subId });
      }
    }

    // ── 7. Storage Locations (/api/storage-locations) ──
    if (path === '/api/storage-locations' || path.startsWith('/api/storage-locations/')) {
      if (!db) return jsonResponse([]);
      const subId = path.startsWith('/api/storage-locations/') ? decodeURIComponent(path.replace('/api/storage-locations/', '')) : null;

      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM storage_locations').all();
        return jsonResponse(res.results || []);
      }

      if (method === 'POST') {
        const loc = await request.json().catch(() => ({}));
        const id = loc.id || `LOC-${Date.now()}`;
        await db.prepare(`
          INSERT INTO storage_locations (id, name, department) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, department = excluded.department
        `).bind(id, loc.name || '', loc.department || 'PD').run();
        return jsonResponse({ success: true, id });
      }

      if (method === 'DELETE' && subId) {
        await db.prepare('DELETE FROM storage_locations WHERE id = ?').bind(subId).run();
        return jsonResponse({ success: true, id: subId });
      }
    }

    // ── 8. Departments (/api/departments) ──
    if (path === '/api/departments' || path.startsWith('/api/departments/')) {
      if (!db) return jsonResponse([]);
      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM departments WHERE isActive = 1').all();
        return jsonResponse(res.results || []);
      }
    }

    // ── 9. Stock Logs (/api/stock-logs) ──
    if (path === '/api/stock-logs') {
      if (!db) return jsonResponse([]);
      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM stock_logs ORDER BY createdAt DESC LIMIT 200').all();
        return jsonResponse(res.results || []);
      }

      if (method === 'POST') {
        const log = await request.json().catch(() => ({}));
        const logList = Array.isArray(log) ? log : [log];
        for (const l of logList) {
          const id = l.id || `LOG-${Date.now()}`;
          const prodId = l.productId || '';
          const prodName = l.productName || l.name || '';
          const type = l.type || 'ADJUST';
          const qty = Number(l.quantity ?? l.qty ?? 0);
          const balance = Number(l.balance ?? l.balanceAfter ?? 0);
          const unit = l.unit || '';
          const refNo = l.referenceNo || l.documentNo || l.docNo || '';
          const dept = l.department || 'PD';
          const notes = l.notes || l.note || '';
          const user = l.performedBy || l.user || 'System';

          await db.prepare(`
            INSERT INTO stock_logs (id, productId, productName, type, quantity, balance, unit, referenceNo, department, notes, performedBy, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `).bind(id, prodId, prodName, type, qty, balance, unit, refNo, dept, notes, user).run();
        }
        return jsonResponse({ success: true, count: logList.length });
      }
    }

    // ── 10. Budgets (/api/budgets) ──
    if (path === '/api/budgets' || path.startsWith('/api/budgets/')) {
      if (!db) return jsonResponse([]);
      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM budgets').all();
        return jsonResponse(res.results || []);
      }
    }

    // ── 11. Health & Status Check (/api/health) ──
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
