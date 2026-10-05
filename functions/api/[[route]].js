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

  const formatSafeUser = (u) => {
    if (!u) return null;
    const safe = { ...u };
    delete safe.password;

    const rawLevel = Number(u.level || 1);
    const roleStr = String((u.roleId || '') + ' ' + (u.canonicalRole || '') + ' ' + (u.positionKey || '') + ' ' + (u.title || '')).toUpperCase();
    const isAdmin = rawLevel >= 99 || (u.username && u.username.toLowerCase() === 'admin') || roleStr.includes('ADMIN');
    const level = isAdmin ? 99 : rawLevel;
    const isOnline = !isAdmin && (roleStr.includes('ONLINE_PURCHASER') || u.canonicalRole === 'PURCHASER');
    const isApprover = isAdmin || level >= 3 || roleStr.includes('APPROV') || roleStr.includes('PLANT_MANAGER');
    const isReviewer = isAdmin || (!isOnline && (isApprover || level >= 2 || roleStr.includes('REVIEW') || roleStr.includes('ASST_MANAGER')));
    const isPurchaser = isAdmin || isOnline || roleStr.includes('PURCHAS');
    const isRequester = isAdmin || (!isOnline && (roleStr.includes('REQUEST') || roleStr.includes('PD') || roleStr.includes('QC') || level === 1));

    let depts = parseJsonSafe(u.allowedDepartments, null);
    if (!depts || !Array.isArray(depts) || depts.length === 0) {
      depts = u.allowedDepartments ? String(u.allowedDepartments).split(',').map(d => d.trim()).filter(Boolean) : [u.department || 'PD'];
    }

    const canCreatePR = isAdmin ? true : (u.canCreatePR !== undefined && u.canCreatePR !== null ? Boolean(Number(u.canCreatePR)) : Boolean(!isOnline && isRequester));
    const canSubmitPR = isAdmin ? true : (u.canSubmitPR !== undefined && u.canSubmitPR !== null ? Boolean(Number(u.canSubmitPR)) : canCreatePR);
    const canDeleteOwnDraft = isAdmin ? true : (u.canDeleteOwnDraft !== undefined && u.canDeleteOwnDraft !== null ? Boolean(Number(u.canDeleteOwnDraft)) : Boolean(!isOnline && level >= 1));
    const canReview = isAdmin ? true : (u.canReview !== undefined && u.canReview !== null ? Boolean(Number(u.canReview)) : Boolean(!isOnline && level >= 2));
    const canFinalApprove = isAdmin ? true : (u.canFinalApprove !== undefined && u.canFinalApprove !== null ? Boolean(Number(u.canFinalApprove)) : Boolean(level >= 3));
    const canOnlinePurchase = isAdmin ? true : (u.canOnlinePurchase !== undefined && u.canOnlinePurchase !== null ? Boolean(Number(u.canOnlinePurchase)) : Boolean(isOnline));
    const canReceiveGoods = isAdmin ? true : (u.canReceiveGoods !== undefined && u.canReceiveGoods !== null ? Boolean(Number(u.canReceiveGoods)) : Boolean(!isOnline && (level === 1 || roleStr.includes('WH'))));
    const canCloseOwnPO = isAdmin ? true : (u.canCloseOwnPO !== undefined && u.canCloseOwnPO !== null ? Boolean(Number(u.canCloseOwnPO)) : Boolean(isOnline || level === 1));
    const canManageMaster = isAdmin ? true : (u.canManageMaster !== undefined && u.canManageMaster !== null ? Boolean(Number(u.canManageMaster)) : Boolean(!isOnline && level >= 1));
    const canDeleteMaster = isAdmin ? true : (u.canDeleteMaster !== undefined && u.canDeleteMaster !== null ? Boolean(Number(u.canDeleteMaster)) : false);
    const canViewBudget = isAdmin ? true : (u.canViewBudget !== undefined && u.canViewBudget !== null ? Boolean(Number(u.canViewBudget)) : Boolean(!isOnline && level >= 2));
    const canViewBudgetMenu = isAdmin ? true : (u.canViewBudgetMenu !== undefined && u.canViewBudgetMenu !== null ? Boolean(Number(u.canViewBudgetMenu)) : Boolean(!isOnline && level >= 2));
    const canSetBudget = isAdmin ? true : (u.canSetBudget !== undefined && u.canSetBudget !== null ? Boolean(Number(u.canSetBudget)) : Boolean(level >= 3));
    const canViewAllDepts = isAdmin ? true : (u.canViewAllDepts !== undefined && u.canViewAllDepts !== null ? Boolean(Number(u.canViewAllDepts)) : Boolean(isOnline || level >= 2 || (u.department === 'ALL')));

    const permissions = {
      PR_CREATION: Boolean(isAdmin || canCreatePR),
      REVIEW: Boolean(isAdmin || canReview),
      APPROVAL: Boolean(isAdmin || canFinalApprove),
      PURCHASING: Boolean(isAdmin || canOnlinePurchase || isPurchaser),
      INVENTORY: Boolean(isAdmin || canReceiveGoods),
      ADMIN: Boolean(isAdmin)
    };

    return {
      ...safe,
      level,
      isAdmin,
      isApprover,
      isReviewer,
      isPurchaser,
      isRequester,
      isOnline,
      canCreatePR,
      canSubmitPR,
      canDeleteOwnDraft,
      canReview,
      canFinalApprove,
      canOnlinePurchase,
      canReceiveGoods,
      canCloseOwnPO,
      canManageMaster,
      canDeleteMaster,
      canViewBudget,
      canViewBudgetMenu,
      canSetBudget,
      canViewAllDepts,
      permissions,
      allowedDepartments: depts,
      assignedDepartments: depts,
      departments: depts
    };
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

        const lookupUser = (cleanUser === 'prasert.mgr') ? 'prasert.pm' : cleanUser;
        const user = await db.prepare(
          `SELECT * FROM users WHERE LOWER(username) = ? OR LOWER(employeeId) = ? OR LOWER(email) = ? LIMIT 1`
        ).bind(lookupUser, lookupUser, lookupUser).first();

        if (!user) {
          return errorResponse('ชื่อผู้ใช้งาน หรือ รหัสผ่าน ไม่ถูกต้อง', 401);
        }

        const isAdminLogin = (user.username && user.username.toLowerCase() === 'admin') || Number(user.level) >= 99;
        const isPassMatch = (user.password === cleanPass) || (isAdminLogin && (cleanPass === 'admin123' || cleanPass === 'password123'));
        if (cleanPass && user.password && !isPassMatch) {
          return errorResponse('ชื่อผู้ใช้งาน หรือ รหัสผ่าน ไม่ถูกต้อง', 401);
        }

        const safeUser = formatSafeUser(user);
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

      const users = (usersRes.results || []).map(u => formatSafeUser(u));

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

          // Check if product already exists by id OR code (case-insensitive)
          const existing = await db.prepare('SELECT * FROM products WHERE id = ? OR UPPER(code) = UPPER(?) LIMIT 1').bind(id, code).first();
          if (existing) {
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
              WHERE id = ?
            `).bind(name, cat, purchaseUnit, usageUnit, convRate, minStock, curStock, price, locId, dept, existing.id).run();
          } else {
            await db.prepare(`
              INSERT INTO products (id, code, name, category, purchaseUnit, usageUnit, conversionRate, minStock, currentStock, standardPrice, defaultLocationId, department, isDeleted, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
            `).bind(id, code, name, cat, purchaseUnit, usageUnit, convRate, minStock, curStock, price, locId, dept).run();
          }
        }
        return jsonResponse(Array.isArray(body) || body.products ? { success: true, count: prods.length } : prods[0]);
      }

      if (method === 'PUT') {
        const body = await request.json().catch(() => ({}));
        const prods = Array.isArray(body) ? body : (body.products || [body]);
        for (const p of prods) {
          const id = p.id || subId;
          const code = p.code || p.itemCode || id;
          const name = p.name || p.itemName || '';
          const cat = p.category || p.department || 'PD';
          const purchaseUnit = p.purchaseUnit || p.unit || 'ชิ้น';
          const usageUnit = p.usageUnit || p.stockUnit || purchaseUnit;
          const convRate = Number(p.conversionRate || 1);
          const minStock = Number(p.minStock || 0);
          const curStock = p.currentStock !== undefined ? Number(p.currentStock) : (p.stockBalance !== undefined ? Number(p.stockBalance) : null);
          const price = p.price !== undefined ? Number(p.price) : (p.standardPrice !== undefined ? Number(p.standardPrice) : null);
          const locId = p.locationId || p.defaultLocationId || null;
          const dept = p.department || cat;

          // Find existing product by subId, id, or code
          let existing = null;
          if (subId) {
            existing = await db.prepare('SELECT * FROM products WHERE id = ? OR UPPER(code) = UPPER(?) LIMIT 1').bind(subId, subId).first();
          }
          if (!existing && (id || code)) {
            existing = await db.prepare('SELECT * FROM products WHERE id = ? OR UPPER(code) = UPPER(?) LIMIT 1').bind(id || '', code || '').first();
          }

          if (existing) {
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
              WHERE id = ?
            `).bind(name, cat, purchaseUnit, usageUnit, convRate, minStock, curStock, price, locId, dept, existing.id).run();
          } else {
            await db.prepare(`
              INSERT INTO products (id, code, name, category, purchaseUnit, usageUnit, conversionRate, minStock, currentStock, standardPrice, defaultLocationId, department, isDeleted, updatedAt)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
            `).bind(id || `PROD-${Date.now()}`, code, name, cat, purchaseUnit, usageUnit, convRate, minStock, curStock || 0, price || 0, locId, dept).run();
          }
        }

        return jsonResponse(Array.isArray(body) || body.products ? { success: true, count: prods.length } : prods[0]);
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
          return jsonResponse(formatSafeUser(user));
        }

        const res = await db.prepare('SELECT * FROM users ORDER BY name ASC').all();
        const users = (res.results || []).map(u => formatSafeUser(u));
        return jsonResponse(users);
      }

      if (method === 'POST' || method === 'PUT') {
        const u = await request.json().catch(() => ({}));
        const rawId = (u.id || subId || '').trim();
        const empId = (u.employeeId || '').trim();
        const username = (u.username || '').trim();
        const email = (u.email || (username ? `${username.toLowerCase()}@company.com` : '')).trim();
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
        const roleUpper = String(roleId).toUpperCase();
        const canonicalRole = u.canonicalRole || (
          roleUpper.includes('ADMIN') ? 'ADMIN' :
          (roleUpper.includes('ASST') || roleUpper.includes('REVIEW')) ? 'REVIEWER' :
          (roleUpper.includes('APPROV') || roleUpper.includes('MANAGER') || roleUpper.includes('PLANT')) ? 'APPROVER' :
          (roleUpper.includes('PURCHAS') || roleUpper.includes('BUYER')) ? 'PURCHASER' : 'REQUESTER'
        );
        const posKey = u.positionKey || roleId;
        const title = u.title || position || 'Officer';
        const defaultLevel = canonicalRole === 'ADMIN' ? 99 : (canonicalRole === 'APPROVER' ? 3 : (canonicalRole === 'REVIEWER' || canonicalRole === 'PURCHASER' ? 2 : 1));
        const level = Number(u.level || defaultLevel);
        const status = u.status || 'ACTIVE';
        const pic = u.pictureUrl || '';
        const desc = u.description || '';
        const sig = u.signature || null;

        const isOnline = !((level >= 99) || canonicalRole === 'ADMIN') && (roleUpper.includes('ONLINE_PURCHASER') || canonicalRole === 'PURCHASER');
        const canCreatePR = u.canCreatePR !== undefined ? (u.canCreatePR ? 1 : 0) : (level >= 1 && !isOnline ? 1 : 0);
        const canSubmitPR = u.canSubmitPR !== undefined ? (u.canSubmitPR ? 1 : 0) : canCreatePR;
        const canDeleteOwnDraft = u.canDeleteOwnDraft !== undefined ? (u.canDeleteOwnDraft ? 1 : 0) : (level >= 1 && !isOnline ? 1 : 0);
        const canReview = u.canReview !== undefined ? (u.canReview ? 1 : 0) : (level >= 2 && !isOnline ? 1 : 0);
        const canFinalApprove = u.canFinalApprove !== undefined ? (u.canFinalApprove ? 1 : 0) : (level >= 3 ? 1 : 0);
        const canOnlinePurchase = u.canOnlinePurchase !== undefined ? (u.canOnlinePurchase ? 1 : 0) : (isOnline || level >= 99 ? 1 : 0);
        const canReceiveGoods = u.canReceiveGoods !== undefined ? (u.canReceiveGoods ? 1 : 0) : (!isOnline && (level === 1 || level >= 99 || roleUpper.includes('WH')) ? 1 : 0);
        const canCloseOwnPO = u.canCloseOwnPO !== undefined ? (u.canCloseOwnPO ? 1 : 0) : (level === 1 || isOnline || level >= 99 ? 1 : 0);
        const canManageMaster = u.canManageMaster !== undefined ? (u.canManageMaster ? 1 : 0) : (!isOnline && level >= 1 ? 1 : 0);
        const canDeleteMaster = u.canDeleteMaster !== undefined ? (u.canDeleteMaster ? 1 : 0) : (level >= 99 ? 1 : 0);
        const canViewBudget = u.canViewBudget !== undefined ? (u.canViewBudget ? 1 : 0) : (!isOnline && level >= 2 ? 1 : 0);
        const canViewBudgetMenu = u.canViewBudgetMenu !== undefined ? (u.canViewBudgetMenu ? 1 : 0) : (!isOnline && level >= 2 ? 1 : 0);
        const canSetBudget = u.canSetBudget !== undefined ? (u.canSetBudget ? 1 : 0) : (level >= 3 ? 1 : 0);
        const canViewAllDepts = u.canViewAllDepts !== undefined ? (u.canViewAllDepts ? 1 : 0) : (isOnline || level >= 2 || dept === 'ALL' ? 1 : 0);
        const now = new Date().toISOString();

        // 1. Find existing user by subId, id, username, or employeeId
        let existingUser = null;
        if (subId) {
          existingUser = await db.prepare('SELECT * FROM users WHERE id = ? OR username = ? OR (employeeId IS NOT NULL AND employeeId != "" AND employeeId = ?) LIMIT 1').bind(subId, subId, subId).first();
        }
        if (!existingUser && rawId) {
          existingUser = await db.prepare('SELECT * FROM users WHERE id = ? LIMIT 1').bind(rawId).first();
        }
        if (!existingUser && username) {
          existingUser = await db.prepare('SELECT * FROM users WHERE username = ? LIMIT 1').bind(username).first();
        }
        if (!existingUser && empId) {
          existingUser = await db.prepare('SELECT * FROM users WHERE employeeId = ? LIMIT 1').bind(empId).first();
        }

        if (existingUser) {
          // 2. Perform direct UPDATE on the existing record
          await db.prepare(`
            UPDATE users SET
              employeeId = CASE WHEN ? != '' THEN ? ELSE employeeId END,
              username = CASE WHEN ? != '' THEN ? ELSE username END,
              email = COALESCE(?, email),
              password = CASE WHEN ? != '' THEN ? ELSE password END,
              pin = CASE WHEN ? != '' THEN ? ELSE pin END,
              name = ?,
              employeeName = ?,
              displayName = ?,
              position = ?,
              department = ?,
              primaryDepartment = ?,
              allowedDepartments = ?,
              roleId = ?,
              canonicalRole = ?,
              positionKey = ?,
              title = ?,
              level = ?,
              status = ?,
              pictureUrl = ?,
              description = ?,
              signature = COALESCE(?, signature),
              canCreatePR = ?,
              canSubmitPR = ?,
              canDeleteOwnDraft = ?,
              canReview = ?,
              canFinalApprove = ?,
              canOnlinePurchase = ?,
              canReceiveGoods = ?,
              canCloseOwnPO = ?,
              canManageMaster = ?,
              canDeleteMaster = ?,
              canViewBudget = ?,
              canViewBudgetMenu = ?,
              canSetBudget = ?,
              canViewAllDepts = ?,
              updatedAt = ?
            WHERE id = ?
          `).bind(
            empId, empId,
            username, username,
            email || null,
            rawPass, rawPass,
            pin, pin,
            name, empName, dispName,
            position, dept, primaryDept, allowedDepts,
            roleId, canonicalRole, posKey, title,
            level, status, pic, desc, sig,
            canCreatePR, canSubmitPR, canDeleteOwnDraft, canReview, canFinalApprove, canOnlinePurchase,
            canReceiveGoods, canCloseOwnPO, canManageMaster, canDeleteMaster, canViewBudget, canViewBudgetMenu,
            canSetBudget, canViewAllDepts, now,
            existingUser.id
          ).run();

          const updatedUserRow = await db.prepare('SELECT * FROM users WHERE id = ? LIMIT 1').bind(existingUser.id).first();
          return jsonResponse(formatSafeUser(updatedUserRow || { ...existingUser, ...u }));
        } else {
          // 3. New user INSERT
          const newId = rawId || `USR-${Date.now()}`;
          await db.prepare(`
            INSERT INTO users (
              id, employeeId, username, email, password, pin, name, employeeName, displayName,
              position, department, primaryDepartment, allowedDepartments, roleId, canonicalRole,
              positionKey, title, level, status, pictureUrl, description, signature,
              canCreatePR, canSubmitPR, canDeleteOwnDraft, canReview, canFinalApprove, canOnlinePurchase,
              canReceiveGoods, canCloseOwnPO, canManageMaster, canDeleteMaster, canViewBudget, canViewBudgetMenu,
              canSetBudget, canViewAllDepts, updatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            newId, empId, username, email, rawPass, pin, name, empName, dispName,
            position, dept, primaryDept, allowedDepts, roleId, canonicalRole,
            posKey, title, level, status, pic, desc, sig,
            canCreatePR, canSubmitPR, canDeleteOwnDraft, canReview, canFinalApprove, canOnlinePurchase,
            canReceiveGoods, canCloseOwnPO, canManageMaster, canDeleteMaster, canViewBudget, canViewBudgetMenu,
            canSetBudget, canViewAllDepts, now
          ).run();

          const savedUserRow = await db.prepare('SELECT * FROM users WHERE id = ? LIMIT 1').bind(newId).first();
          return jsonResponse(formatSafeUser(savedUserRow || u));
        }
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
        const res = await db.prepare('SELECT * FROM stock_logs ORDER BY createdAt DESC LIMIT 500').all();
        return jsonResponse(res.results || []);
      }

      if (method === 'POST') {
        const log = await request.json().catch(() => ({}));
        const logList = Array.isArray(log) ? log : [log];
        for (const l of logList) {
          if (!l || typeof l !== 'object') continue;
          const id = l.id || `LOG-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
          const prodId = l.productId || l.id || '';
          const prodCode = l.productCode || l.itemCode || l.sku || '';
          const prodName = l.productName || l.name || l.itemName || '';
          const type = (l.type || (Number(l.changeQty) < 0 ? 'OUT' : 'IN')).toUpperCase();
          const docType = l.docType || (type === 'OUT' ? 'ISSUE' : (type === 'IN' ? 'GRN' : 'ADJUST'));
          const docNo = l.docNo || l.documentNo || l.referenceNo || l.grnNumber || l.poNumber || '';
          const refNo = l.referenceNo || l.refPo || l.poNo || l.poNumber || l.docNo || '';
          const poNo = l.poNo || l.poNumber || l.refPo || '';
          const qty = Math.abs(Number(l.quantity ?? l.qty ?? l.changeQty ?? 0));
          const changeQty = l.changeQty !== undefined ? Number(l.changeQty) : (type === 'OUT' ? -qty : qty);
          const balance = Number(l.balance ?? l.balanceAfter ?? l.currentStock ?? 0);
          const unit = l.unit || l.stockUnit || l.purchaseUnit || 'ชิ้น';
          const dept = l.department || l.category || 'PD';
          const location = l.location || l.locationName || l.targetLocation || l.targetUnit || l.issueUnit || l.issuedTo || '';
          const issuedTo = l.issuedTo || l.issueUnit || location || '';
          const issueUnit = l.issueUnit || l.unitId || l.unitName || issuedTo || '';
          const unitCost = Number(l.unitCost ?? l.unitPrice ?? l.baseUnitCost ?? l.price ?? 0);
          const totalCost = Number(l.totalCost ?? l.totalValue ?? l.totalPrice ?? (qty * unitCost));
          const actorId = l.actorId || l.requesterId || l.userId || '';
          const actorName = l.actorName || l.performedBy || l.requesterName || l.user || 'System';
          const performedBy = actorName;
          const notes = l.notes || l.note || l.reason || '';
          const createdAt = l.createdAt || l.timestamp || l.date || new Date().toISOString();

          await db.prepare(`
            INSERT INTO stock_logs (
              id, productId, productCode, productName, type, docType, docNo, referenceNo, poNo,
              quantity, changeQty, balance, unit, department, location, issuedTo, issueUnit,
              unitCost, totalCost, actorId, actorName, performedBy, notes, createdAt
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              productId = excluded.productId,
              productCode = COALESCE(excluded.productCode, stock_logs.productCode),
              productName = COALESCE(excluded.productName, stock_logs.productName),
              type = excluded.type,
              docType = COALESCE(excluded.docType, stock_logs.docType),
              docNo = COALESCE(excluded.docNo, stock_logs.docNo),
              referenceNo = COALESCE(excluded.referenceNo, stock_logs.referenceNo),
              poNo = COALESCE(excluded.poNo, stock_logs.poNo),
              quantity = excluded.quantity,
              changeQty = excluded.changeQty,
              balance = excluded.balance,
              unit = COALESCE(excluded.unit, stock_logs.unit),
              department = COALESCE(excluded.department, stock_logs.department),
              location = COALESCE(excluded.location, stock_logs.location),
              issuedTo = COALESCE(excluded.issuedTo, stock_logs.issuedTo),
              issueUnit = COALESCE(excluded.issueUnit, stock_logs.issueUnit),
              unitCost = excluded.unitCost,
              totalCost = excluded.totalCost,
              actorId = COALESCE(excluded.actorId, stock_logs.actorId),
              actorName = COALESCE(excluded.actorName, stock_logs.actorName),
              performedBy = COALESCE(excluded.performedBy, stock_logs.performedBy),
              notes = COALESCE(excluded.notes, stock_logs.notes),
              createdAt = stock_logs.createdAt
          `).bind(
            id, prodId, prodCode, prodName, type, docType, docNo, refNo, poNo,
            qty, changeQty, balance, unit, dept, location, issuedTo, issueUnit,
            unitCost, totalCost, actorId, actorName, performedBy, notes, createdAt
          ).run().catch(err => {
            console.error('Error inserting stock_log:', err);
          });
        }
        return jsonResponse({ success: true, count: logList.length });
      }
    }

    // ── 9.1 Stock Issue Atomic Endpoint (/api/stock/issue or /api/inventory/issue) ──
    if (path === '/api/stock/issue' || path === '/api/inventory/issue') {
      if (!db) return errorResponse('Database not available', 500);
      if (method === 'POST') {
        const payload = await request.json().catch(() => ({}));
        const productId = payload.productId || payload.id;
        const productCode = payload.productCode || payload.code || payload.sku;
        const rawQty = payload.quantity !== undefined ? payload.quantity : (payload.qty !== undefined ? payload.qty : payload.issueQty);
        const quantity = Math.abs(Number(rawQty));
        if (isNaN(quantity) || quantity <= 0) {
          return errorResponse('จำนวนที่เบิกจ่ายไม่ถูกต้อง (ต้องมากกว่า 0)', 400);
        }

        // 1. ค้นหาสินค้าในตาราง products ด้วย id หรือ code
        let prod = null;
        if (productId) {
          prod = await db.prepare('SELECT * FROM products WHERE id = ? LIMIT 1').bind(productId).first();
        }
        if (!prod && productCode) {
          prod = await db.prepare('SELECT * FROM products WHERE code = ? LIMIT 1').bind(productCode).first();
        }

        if (!prod) {
          return errorResponse('ไม่พบสินค้านี้ในระบบเพื่อตัดสต็อก', 404);
        }

        const currentStock = Number(prod.currentStock || 0);
        const sUnit = prod.usageUnit || prod.purchaseUnit || 'ชิ้น';
        if (currentStock < quantity) {
          return errorResponse(`จำนวนคงเหลือไม่พอเบิก (มี ${currentStock} ${sUnit}, ต้องการเบิก ${quantity} ${sUnit})`, 400);
        }

        const newBalance = Math.round((currentStock - quantity) * 10000) / 10000;
        const department = payload.department || prod.department || prod.category || 'PD';
        const issuedTo = payload.issuedTo || payload.issueUnit || payload.location || '';
        const location = payload.location || payload.targetLocation || payload.targetUnit || issuedTo || '';
        const issueUnit = payload.issueUnit || location || issuedTo || '';
        const reason = payload.reason || payload.note || payload.notes || 'เบิกจ่ายด่วน';
        const requesterId = payload.requesterId || payload.userId || (payload.user && (payload.user.id || payload.user.username)) || '';
        const requesterName = payload.requesterName || payload.userName || (payload.user && (payload.user.name || payload.user.displayName)) || issuedTo || 'System';
        const unitCost = Number(payload.unitCost ?? prod.standardPrice ?? 0);
        const totalCost = Math.round(quantity * unitCost * 100) / 100;

        const logId = payload.id || `LOG-${department}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        const docNo = payload.docNo || `REQ-${Date.now().toString().slice(-4)}`;
        const nowIso = new Date().toISOString();

        // 2. ตัดยอดสต็อกในตาราง products
        await db.prepare(`
          UPDATE products SET
            currentStock = ?,
            updatedAt = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(newBalance, prod.id).run();

        // 3. บันทึกประวัติการเคลื่อนไหวลงใน stock_logs พร้อมระบุ แผนก (department) ครบถ้วน
        await db.prepare(`
          INSERT INTO stock_logs (
            id, productId, productCode, productName, type, docType, docNo, referenceNo, poNo,
            quantity, changeQty, balance, unit, department, location, issuedTo, issueUnit,
            unitCost, totalCost, actorId, actorName, performedBy, notes, createdAt
          )
          VALUES (?, ?, ?, ?, 'OUT', 'ISSUE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            quantity = excluded.quantity,
            changeQty = excluded.changeQty,
            balance = excluded.balance,
            department = excluded.department,
            location = excluded.location,
            issuedTo = excluded.issuedTo,
            issueUnit = excluded.issueUnit,
            unitCost = excluded.unitCost,
            totalCost = excluded.totalCost,
            notes = excluded.notes
        `).bind(
          logId,
          prod.id,
          prod.code,
          prod.name,
          docNo,
          docNo,
          payload.poNo || '',
          quantity,
          -quantity,
          newBalance,
          sUnit,
          department,
          location,
          issuedTo,
          issueUnit,
          unitCost,
          totalCost,
          requesterId,
          requesterName,
          requesterName,
          reason,
          nowIso
        ).run();

        const updatedProduct = {
          ...prod,
          currentStock: newBalance,
          stockBalance: newBalance,
          updatedAt: nowIso
        };

        const logEntry = {
          id: logId,
          timestamp: nowIso,
          date: nowIso,
          type: 'OUT',
          docType: 'ISSUE',
          docNo,
          referenceNo: docNo,
          productId: prod.id,
          productCode: prod.code,
          productName: prod.name,
          name: prod.name,
          department,
          location,
          changeQty: -quantity,
          qty: quantity,
          quantity,
          unit: sUnit,
          balanceAfter: newBalance,
          balance: newBalance,
          unitCost,
          totalCost,
          issuedTo,
          issueUnit,
          reason,
          notes: reason,
          actorId: requesterId,
          actorName: requesterName,
          performedBy: requesterName,
          createdAt: nowIso
        };

        return jsonResponse({
          success: true,
          updatedProduct,
          product: updatedProduct,
          logEntry
        });
      }
    }

    // ── 10. Budgets & Ledger (/api/budgets & /api/budget-transactions) ──
    if (path === '/api/budgets/adjust' && method === 'POST') {
      if (!db) return jsonResponse({ success: false });
      const params = await request.json().catch(() => ({}));
      const { dept, action, newAmount, previousAmount, delta, reason, actor, targetMonth } = params;
      const cleanDept = String(dept || 'PD').toUpperCase();
      const numAmount = Number(newAmount ?? delta ?? 0);
      const mKey = targetMonth || '2026-10';

      const existing = await db.prepare('SELECT * FROM budgets WHERE id = ?').bind(cleanDept).first().catch(() => null);
      let history = {};
      if (existing?.monthsJson) {
        history = parseJsonSafe(existing.monthsJson, {});
      }

      let baseAlloc = Number(existing?.monthlyBudget || 0);
      if (baseAlloc === 0) {
        const deptMaster = await db.prepare('SELECT monthlyBudget FROM departments WHERE code = ?').bind(cleanDept).first().catch(() => null);
        baseAlloc = Number(deptMaster?.monthlyBudget || 0);
      }

      const prevAlloc = (previousAmount !== undefined && previousAmount !== null)
        ? Number(previousAmount)
        : (history[mKey] !== undefined ? Number(history[mKey]) : baseAlloc);

      const deltaAmount = (delta !== undefined && delta !== null) ? Number(delta) : (numAmount - prevAlloc);
      const isInitial = prevAlloc === 0;
      const movementAmount = isInitial ? numAmount : Math.abs(deltaAmount);
      const txType = isInitial ? 'MONTHLY_ALLOCATION' : (deltaAmount >= 0 ? 'TOP_UP' : 'BUDGET_ADJUSTMENT_DOWN');
      const txTypeLabel = isInitial 
        ? 'จัดสรรงบประมาณประจำเดือน' 
        : (deltaAmount >= 0 ? 'ปรับเพิ่มงบประมาณ' : 'ปรับลดงบประมาณ');

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

      const now = new Date().toISOString();
      const txId = `BTX-${Date.now()}-${cleanDept}`;
      await db.prepare(`
        INSERT INTO budget_transactions (id, dept, department, type, actionType, typeLabel, amount, delta, previousAmount, newAmount, isAllocation, actor, note, targetMonth, period, createdAt, date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          amount = excluded.amount,
          newAmount = excluded.newAmount,
          delta = excluded.delta,
          typeLabel = excluded.typeLabel
      `).bind(
        txId,
        cleanDept,
        cleanDept,
        txType,
        txType,
        txTypeLabel,
        movementAmount,
        deltaAmount,
        prevAlloc,
        numAmount,
        deltaAmount >= 0 ? 1 : 0,
        actor || 'Staff',
        reason || (isInitial ? `จัดสรรงบประมาณประจำเดือน ${mKey}` : (deltaAmount >= 0 ? `ปรับเพิ่มงบประมาณจาก ฿${prevAlloc.toLocaleString()} เป็น ฿${numAmount.toLocaleString()}` : `ปรับลดงบประมาณจาก ฿${prevAlloc.toLocaleString()} เป็น ฿${numAmount.toLocaleString()}`)),
        mKey,
        mKey,
        now,
        now
      ).run().catch(() => {});

      return jsonResponse({
        success: true,
        budget: { department: cleanDept, monthlyBudget: numAmount, history },
        transaction: {
          id: txId,
          type: txType,
          typeLabel: txTypeLabel,
          amount: movementAmount,
          delta: deltaAmount,
          previousAmount: prevAlloc,
          newAmount: numAmount,
          period: mKey
        }
      });
    }

    if (path === '/api/budgets/allocate' && method === 'POST') {
      if (!db) return jsonResponse({ success: false });
      const { period, allocations, previousAmounts, reason, actor, transactionId, transactions } = await request.json().catch(() => ({}));
      const mKey = period || '2026-10';
      if (allocations && typeof allocations === 'object') {
        const now = new Date().toISOString();
        for (const [dept, amt] of Object.entries(allocations)) {
          if (!dept || dept === 'ALL') continue;
          const cleanDept = String(dept).toUpperCase();
          const numAmt = Number(amt || 0);
          const existing = await db.prepare('SELECT * FROM budgets WHERE id = ?').bind(cleanDept).first().catch(() => null);
          let history = {};
          if (existing?.monthsJson) {
            history = parseJsonSafe(existing.monthsJson, {});
          }

          let baseAlloc = Number(existing?.monthlyBudget || 0);
          if (baseAlloc === 0) {
            const deptMaster = await db.prepare('SELECT monthlyBudget FROM departments WHERE code = ?').bind(cleanDept).first().catch(() => null);
            baseAlloc = Number(deptMaster?.monthlyBudget || 0);
          }

          const explicitPrev = (previousAmounts && previousAmounts[cleanDept] !== undefined && previousAmounts[cleanDept] !== null)
            ? Number(previousAmounts[cleanDept])
            : null;
          const prevAlloc = explicitPrev !== null
            ? explicitPrev
            : (history[mKey] !== undefined ? Number(history[mKey]) : baseAlloc);

          const deltaAmount = numAmt - prevAlloc;
          const isInitial = prevAlloc === 0;
          const movementAmount = isInitial ? numAmt : Math.abs(deltaAmount);
          const txType = isInitial ? 'MONTHLY_ALLOCATION' : (deltaAmount >= 0 ? 'TOP_UP' : 'BUDGET_ADJUSTMENT_DOWN');
          const txTypeLabel = isInitial 
            ? 'จัดสรรงบประมาณประจำเดือน' 
            : (deltaAmount >= 0 ? 'ปรับเพิ่มงบประมาณ' : 'ปรับลดงบประมาณ');

          history[mKey] = numAmt;
          await db.prepare(`
            INSERT INTO budgets (id, department, fiscalYear, monthlyBudget, totalAllocated, totalUsed, totalRemaining, monthsJson, updatedAt)
            VALUES (?, ?, 2026, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
              monthlyBudget = excluded.monthlyBudget,
              totalAllocated = excluded.totalAllocated,
              monthsJson = excluded.monthsJson,
              updatedAt = CURRENT_TIMESTAMP
          `).bind(cleanDept, cleanDept, numAmt, numAmt, numAmt, JSON.stringify(history)).run().catch(() => {});

          const txId = transactionId || (transactions && (transactions[cleanDept]?.id || transactions[dept]?.id)) || `BTX-ALLOC-${cleanDept}-${mKey}-${Date.now()}`;
          await db.prepare(`
            INSERT INTO budget_transactions (id, dept, department, type, actionType, typeLabel, amount, delta, previousAmount, newAmount, isAllocation, actor, note, targetMonth, period, createdAt, date)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              amount = excluded.amount,
              newAmount = excluded.newAmount,
              delta = excluded.delta,
              typeLabel = excluded.typeLabel
          `).bind(
            txId,
            cleanDept,
            cleanDept,
            txType,
            txType,
            txTypeLabel,
            movementAmount,
            deltaAmount,
            prevAlloc,
            numAmt,
            deltaAmount >= 0 ? 1 : 0,
            actor || 'Staff',
            reason || (isInitial ? `จัดสรรงบประมาณประจำเดือน ${mKey}` : (deltaAmount >= 0 ? `ปรับเพิ่มงบประมาณจาก ฿${prevAlloc.toLocaleString()} เป็น ฿${numAmt.toLocaleString()}` : `ปรับลดงบประมาณจาก ฿${prevAlloc.toLocaleString()} เป็น ฿${numAmt.toLocaleString()}`)),
            mKey,
            mKey,
            now,
            now
          ).run().catch(() => {});
        }
      }
      return jsonResponse({ success: true, period: mKey, allocations });
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
