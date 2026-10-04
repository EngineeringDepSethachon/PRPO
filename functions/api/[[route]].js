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
        budgetsRes,
        txsRes
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
        db.prepare('SELECT * FROM budgets').all().catch(() => ({ results: [] })),
        db.prepare('SELECT * FROM budget_transactions ORDER BY createdAt DESC LIMIT 500').all().catch(() => ({ results: [] }))
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

      const budgets = {};
      if (budgetsRes.results && budgetsRes.results.length > 0) {
        budgetsRes.results.forEach(b => {
          const dept = b.department || b.id;
          budgets[dept] = {
            monthlyBudget: Number(b.monthlyBudget || 0),
            spent: Number(b.totalUsed || 0),
            actualExpense: Number(b.totalUsed || 0),
            pending: 0,
            variance: Number(b.totalRemaining ?? (b.monthlyBudget - (b.totalUsed || 0))),
            remainingBudget: Number(b.totalRemaining ?? (b.monthlyBudget - (b.totalUsed || 0))),
            history: parseJsonSafe(b.monthsJson, { '2026-09': Number(b.monthlyBudget || 0), '2026-10': Number(b.monthlyBudget || 0) }),
            historicalSpent: {}
          };
        });
      }

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
        budgets: Object.keys(budgets).length > 0 ? budgets : undefined,
        budgetTransactions: txsRes.results || []
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
              category = excluded.category,
              purchaseUnit = excluded.purchaseUnit,
              usageUnit = excluded.usageUnit,
              conversionRate = excluded.conversionRate,
              currentStock = excluded.currentStock,
              standardPrice = excluded.standardPrice,
              defaultLocationId = excluded.defaultLocationId,
              department = excluded.department,
              minStock = excluded.minStock,
              isDeleted = 0,
              updatedAt = CURRENT_TIMESTAMP
          `).bind(id, code, name, cat, purchaseUnit, usageUnit, convRate, minStock, curStock, price, locId, dept).run();
        }
        return jsonResponse(Array.isArray(body) || body.products ? { success: true, count: prods.length } : prods[0]);
      }

      if (method === 'PUT') {
        const p = await request.json().catch(() => ({}));
        const id = p.id || subId;
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
          UPDATE products SET
            name = COALESCE(?, name),
            category = COALESCE(?, category),
            purchaseUnit = COALESCE(?, purchaseUnit),
            usageUnit = COALESCE(?, usageUnit),
            conversionRate = COALESCE(?, conversionRate),
            minStock = COALESCE(?, minStock),
            currentStock = COALESCE(?, currentStock),
            standardPrice = COALESCE(?, standardPrice),
            defaultLocationId = COALESCE(?, defaultLocationId),
            department = COALESCE(?, department),
            isDeleted = 0,
            updatedAt = CURRENT_TIMESTAMP
          WHERE id = ? OR code = ?
        `).bind(name, cat, purchaseUnit, usageUnit, convRate, minStock, curStock, price, locId, dept, id, code).run();

        return jsonResponse({ ...p, id, code, name });
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
              taxId = excluded.taxId,
              paymentTerm = excluded.paymentTerm,
              department = excluded.department,
              isDeleted = 0
          `).bind(id, code, name, contact, phone, email, address, taxId, term, dept).run();
        }
        return jsonResponse(Array.isArray(v) ? { success: true, count: vList.length } : vList[0]);
      }

      if (method === 'PUT') {
        const item = await request.json().catch(() => ({}));
        const id = item.id || subId;
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
          UPDATE vendors SET
            name = COALESCE(?, name),
            contactPerson = COALESCE(?, contactPerson),
            phone = COALESCE(?, phone),
            email = COALESCE(?, email),
            address = COALESCE(?, address),
            taxId = COALESCE(?, taxId),
            paymentTerm = COALESCE(?, paymentTerm),
            department = COALESCE(?, department),
            isDeleted = 0
          WHERE id = ? OR code = ?
        `).bind(name, contact, phone, email, address, taxId, term, dept, id, code).run();

        return jsonResponse({ ...item, id, code, name });
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
      const subId = path.startsWith('/api/departments/') ? decodeURIComponent(path.replace('/api/departments/', '')) : null;

      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM departments WHERE isActive = 1').all();
        return jsonResponse(res.results || []);
      }

      if (method === 'POST') {
        const d = await request.json().catch(() => ({}));
        const id = d.id || `DEPT-${d.code || Date.now()}`;
        const code = d.code || id;
        const name = d.name || '';
        const nameEn = d.nameEn || '';
        const prefix = d.prefix || code;
        const desc = d.description || '';
        const budget = Number(d.monthlyBudget || 0);
        const isActive = d.isActive === false || d.isActive === 0 ? 0 : 1;
        const color = d.color || 'blue';
        const mgr = d.managerName || '';

        await db.prepare(`
          INSERT INTO departments (id, code, name, nameEn, prefix, description, monthlyBudget, isActive, color, managerName, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            nameEn = excluded.nameEn,
            prefix = excluded.prefix,
            description = excluded.description,
            monthlyBudget = excluded.monthlyBudget,
            isActive = excluded.isActive,
            color = excluded.color,
            managerName = excluded.managerName,
            updatedAt = CURRENT_TIMESTAMP
        `).bind(id, code, name, nameEn, prefix, desc, budget, isActive, color, mgr).run();

        return jsonResponse({ ...d, id, code, name });
      }

      if (method === 'PUT') {
        const d = await request.json().catch(() => ({}));
        const id = d.id || subId;
        const code = d.code || id;
        const name = d.name || '';
        const nameEn = d.nameEn || '';
        const prefix = d.prefix || code;
        const desc = d.description || '';
        const budget = Number(d.monthlyBudget || 0);
        const isActive = d.isActive === false || d.isActive === 0 ? 0 : 1;
        const color = d.color || 'blue';
        const mgr = d.managerName || '';

        await db.prepare(`
          UPDATE departments SET
            name = COALESCE(?, name),
            nameEn = COALESCE(?, nameEn),
            prefix = COALESCE(?, prefix),
            description = COALESCE(?, description),
            monthlyBudget = COALESCE(?, monthlyBudget),
            isActive = COALESCE(?, isActive),
            color = COALESCE(?, color),
            managerName = COALESCE(?, managerName),
            updatedAt = CURRENT_TIMESTAMP
          WHERE id = ? OR code = ?
        `).bind(name, nameEn, prefix, desc, budget, isActive, color, mgr, id, code).run();

        return jsonResponse({ ...d, id, code, name });
      }

      if (method === 'DELETE' && subId) {
        await db.prepare('UPDATE departments SET isActive = 0, updatedAt = CURRENT_TIMESTAMP WHERE id = ? OR code = ?').bind(subId, subId).run();
        return jsonResponse({ success: true, id: subId });
      }
    }

    // ── 9. Users Management Endpoints (/api/users or /api/user) ──
    if (path === '/api/users' || path === '/api/user' || path.startsWith('/api/users/')) {
      if (!db) return jsonResponse([]);
      const subId = path.startsWith('/api/users/') ? decodeURIComponent(path.replace('/api/users/', '')) : null;

      // Auto ensure signature column in D1 users table
      await db.prepare('ALTER TABLE users ADD COLUMN signature TEXT').run().catch(() => {});

      if (method === 'GET') {
        if (subId) {
          const user = await db.prepare('SELECT * FROM users WHERE id = ? OR username = ? LIMIT 1').bind(subId, subId).first();
          if (!user) return errorResponse('User not found', 404);
          const safeUser = { ...user };
          delete safeUser.password;
          safeUser.allowedDepartments = parseJsonSafe(user.allowedDepartments, [user.department || 'PD']);
          safeUser.assignedDepartments = parseJsonSafe(user.assignedDepartments, safeUser.allowedDepartments);
          safeUser.departments = safeUser.allowedDepartments;
          return jsonResponse(safeUser);
        }

        const res = await db.prepare('SELECT * FROM users ORDER BY name ASC').all();
        const users = (res.results || []).map(u => {
          const safe = { ...u };
          delete safe.password;
          safe.allowedDepartments = parseJsonSafe(u.allowedDepartments, [u.department || 'PD']);
          safe.assignedDepartments = parseJsonSafe(u.assignedDepartments, safe.allowedDepartments);
          safe.departments = safe.allowedDepartments;
          return safe;
        });
        return jsonResponse(users);
      }

      if (method === 'POST' || method === 'PUT') {
        const u = await request.json().catch(() => ({}));
        const id = u.id || subId || `USR-${Date.now()}`;
        const empId = u.employeeId || '';
        const username = (u.username || '').trim();
        const rawPass = (u.password || '').trim();
        const pin = u.pin || rawPass || '';
        const name = (u.name || u.employeeName || '').trim();
        const empName = u.employeeName || name;
        const dispName = u.displayName || name;
        const position = u.position || '';
        const dept = u.department || u.primaryDepartment || 'PD';
        const primaryDept = u.primaryDepartment || dept;
        const allowedDepts = JSON.stringify(Array.isArray(u.allowedDepartments) && u.allowedDepartments.length > 0
          ? u.allowedDepartments
          : (Array.isArray(u.assignedDepartments) ? u.assignedDepartments : [primaryDept]));
        const roleId = u.roleId || 'REQUESTER_PD';
        const canonicalRole = u.canonicalRole || (roleId.includes('ADMIN') ? 'ADMIN' : (roleId.includes('APPROVER') || roleId.includes('MANAGER') ? 'APPROVER' : (roleId.includes('PURCHASER') ? 'PURCHASER' : 'REQUESTER')));
        const posKey = u.positionKey || roleId;
        const title = u.title || position || 'Officer';
        const level = Number(u.level || 1);
        const status = u.status || 'ACTIVE';
        const pic = u.pictureUrl || '';
        const desc = u.description || '';
        const sig = u.signature || null;

        await db.prepare(`
          INSERT INTO users (id, employeeId, username, password, pin, name, employeeName, displayName, position, department, primaryDepartment, allowedDepartments, roleId, canonicalRole, positionKey, title, level, status, pictureUrl, description, signature)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            employeeId = excluded.employeeId,
            username = excluded.username,
            password = CASE WHEN excluded.password != '' THEN excluded.password ELSE users.password END,
            pin = CASE WHEN excluded.pin != '' THEN excluded.pin ELSE users.pin END,
            name = excluded.name,
            employeeName = excluded.employeeName,
            displayName = excluded.displayName,
            position = excluded.position,
            department = excluded.department,
            primaryDepartment = excluded.primaryDepartment,
            allowedDepartments = excluded.allowedDepartments,
            roleId = excluded.roleId,
            canonicalRole = excluded.canonicalRole,
            positionKey = excluded.positionKey,
            title = excluded.title,
            level = excluded.level,
            status = excluded.status,
            pictureUrl = excluded.pictureUrl,
            description = excluded.description,
            signature = COALESCE(excluded.signature, users.signature)
        `).bind(id, empId, username, rawPass, pin, name, empName, dispName, position, dept, primaryDept, allowedDepts, roleId, canonicalRole, posKey, title, level, status, pic, desc, sig).run();

        const savedSafeUser = {
          ...u,
          id,
          employeeId: empId,
          username,
          name,
          employeeName: empName,
          displayName: dispName,
          position,
          department: dept,
          primaryDepartment: primaryDept,
          allowedDepartments: parseJsonSafe(allowedDepts, [primaryDept]),
          assignedDepartments: parseJsonSafe(allowedDepts, [primaryDept]),
          departments: parseJsonSafe(allowedDepts, [primaryDept]),
          roleId,
          canonicalRole,
          positionKey: posKey,
          title,
          level,
          status,
          signature: sig,
          pictureUrl: pic,
          description: desc
        };
        delete savedSafeUser.password;

        return jsonResponse(savedSafeUser);
      }

      if (method === 'DELETE' && subId) {
        await db.prepare('UPDATE users SET status = "INACTIVE" WHERE id = ? OR username = ?').bind(subId, subId).run();
        return jsonResponse({ success: true, id: subId });
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

    // ── 10. Budgets & Ledger (/api/budgets & /api/budget-transactions) ──
    if (path === '/api/budgets/adjust' && method === 'POST') {
      if (!db) return jsonResponse({ success: false });
      const params = await request.json().catch(() => ({}));
      const { dept, action, newAmount, delta, reason, actor, targetMonth } = params;
      const cleanDept = String(dept || 'PD').toUpperCase();
      const numAmount = Number(newAmount ?? delta ?? 0);
      const mKey = targetMonth || '2026-10';

      const existing = await db.prepare('SELECT * FROM budgets WHERE id = ?').bind(cleanDept).first().catch(() => null);
      let history = {};
      if (existing?.monthsJson) {
        history = parseJsonSafe(existing.monthsJson, {});
      }
      history[mKey] = numAmount;

      await db.prepare(`
        INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalAllocated, totalUsed, totalRemaining, monthsJson, updatedAt)
        VALUES (?, ?, 2026, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
          monthlyBudget = excluded.monthlyBudget,
          totalAllocated = excluded.totalAllocated,
          monthsJson = excluded.monthsJson,
          updatedAt = CURRENT_TIMESTAMP
      `).bind(cleanDept, cleanDept, numAmount, numAmount, numAmount, JSON.stringify(history)).run().catch(() => {});

      return jsonResponse({ success: true, budget: { department: cleanDept, monthlyBudget: numAmount, history } });
    }

    if (path === '/api/budgets' || path.startsWith('/api/budgets/')) {
      if (!db) return jsonResponse([]);
      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM budgets').all().catch(() => ({ results: [] }));
        return jsonResponse(res.results || []);
      }
      if (method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const entries = Array.isArray(body)
          ? body.map(b => [b.department || b.dept || b.id, b])
          : Object.entries(body || {});

        for (const [dept, b] of entries) {
          if (!dept || dept === 'ALL') continue;
          const monthly = Number(b.monthlyBudget || b.totalBudget || b.amount || 0);
          const historyJson = JSON.stringify(b.history || {});
          await db.prepare(`
            INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalAllocated, totalUsed, totalRemaining, monthsJson, updatedAt)
            VALUES (?, ?, 2026, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
              monthlyBudget = excluded.monthlyBudget,
              totalAllocated = excluded.totalAllocated,
              monthsJson = excluded.monthsJson,
              updatedAt = CURRENT_TIMESTAMP
          `).bind(dept, dept, monthly, monthly, Number(b.spent || 0), Number(b.variance ?? (monthly - (b.spent || 0))), historyJson).run().catch(() => {});
        }
        return jsonResponse({ success: true });
      }
    }

    if (path === '/api/budget-transactions' || path.startsWith('/api/budget-transactions/')) {
      if (!db) return jsonResponse([]);
      await db.prepare(`
        CREATE TABLE IF NOT EXISTS budget_transactions (
          id TEXT PRIMARY KEY,
          dept TEXT,
          department TEXT,
          type TEXT,
          actionType TEXT,
          typeLabel TEXT,
          amount REAL,
          delta REAL,
          previousAmount REAL,
          newAmount REAL,
          isAllocation INTEGER DEFAULT 0,
          actor TEXT,
          note TEXT,
          targetMonth TEXT,
          period TEXT,
          createdAt TEXT,
          date TEXT
        )
      `).run().catch(() => {});

      if (method === 'GET') {
        const res = await db.prepare('SELECT * FROM budget_transactions ORDER BY createdAt DESC').all().catch(() => ({ results: [] }));
        return jsonResponse(res.results || []);
      }

      if (method === 'POST') {
        const tx = await request.json().catch(() => ({}));
        if (tx && tx.id) {
          await db.prepare(`
            INSERT INTO budget_transactions (id, dept, department, type, actionType, typeLabel, amount, delta, previousAmount, newAmount, isAllocation, actor, note, targetMonth, period, createdAt, date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              amount = excluded.amount,
              newAmount = excluded.newAmount,
              typeLabel = excluded.typeLabel
          `).bind(
            tx.id,
            tx.dept || tx.department || 'PD',
            tx.department || tx.dept || 'PD',
            tx.type || 'MONTHLY_ALLOCATION',
            tx.actionType || tx.type || 'MONTHLY_ALLOCATION',
            tx.typeLabel || 'จัดสรรงบประมาณประจำเดือน',
            Number(tx.amount || 0),
            Number(tx.delta || 0),
            Number(tx.previousAmount || 0),
            Number(tx.newAmount || 0),
            tx.isAllocation ? 1 : 0,
            tx.actor || 'Staff',
            tx.note || tx.remark || '',
            tx.targetMonth || tx.period || '',
            tx.period || tx.targetMonth || '',
            tx.createdAt || new Date().toISOString(),
            tx.date || new Date().toISOString()
          ).run().catch(() => {});
        }
        return jsonResponse({ success: true, transaction: tx });
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
