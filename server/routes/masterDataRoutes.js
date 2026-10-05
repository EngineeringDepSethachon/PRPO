import { Router } from 'express';
import { 
  readFile, 
  writeFile, 
  isBlacklistedProduct, 
  initialStorageLocations, 
  initialUsageUnits, 
  initialDepartments, 
  initialUsers 
} from '../storage.js';

const router = Router();

/**
 * Master Data Subsystem
 * Covers Products, Vendors, Storage Locations, Usage Units, Departments, Users
 * Mounted at /api/master-data/* and /api/*
 */

// ── 1. Products ──
router.get('/products', async (req, res) => {
  try {
    const rawProducts = await readFile('products.json', []);
    const sanitized = (Array.isArray(rawProducts) ? rawProducts : [])
      .flatMap(p => Array.isArray(p) ? p : [p])
      .filter(p => p && typeof p === 'object' && (p.name || p.itemName || p.title) && !isBlacklistedProduct(p));
    const map = new Map();
    sanitized.forEach(item => {
      const key = String(item.code || item.id || '').trim().toUpperCase();
      if (key && !map.has(key)) {
        map.set(key, item);
      }
    });
    res.json(Array.from(map.values()));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/products', async (req, res) => {
  try {
    const data = req.body;
    if (Array.isArray(data)) {
      const sanitized = data
        .flatMap(p => Array.isArray(p) ? p : [p])
        .filter(p => p && typeof p === 'object' && (p.name || p.itemName || p.title) && !isBlacklistedProduct(p));
      const map = new Map();
      sanitized.forEach(item => {
        const key = String(item.code || item.id || '').trim().toUpperCase();
        if (key && !map.has(key)) {
          map.set(key, item);
        }
      });
      const deduped = Array.from(map.values());
      await writeFile('products.json', deduped);
      return res.json(deduped);
    }
    if (isBlacklistedProduct(data)) {
      return res.json(data);
    }
    const products = (await readFile('products.json', []))
      .flatMap(p => Array.isArray(p) ? p : [p])
      .filter(p => p && typeof p === 'object' && (p.name || p.itemName || p.title) && !isBlacklistedProduct(p));
    products.unshift(data);
    const map = new Map();
    products.forEach(item => {
      const key = String(item.code || item.id || '').trim().toUpperCase();
      if (key && !map.has(key)) {
        map.set(key, item);
      }
    });
    const deduped = Array.from(map.values());
    await writeFile('products.json', deduped);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/products/batch', async (req, res) => {
  try {
    const data = req.body;
    if (Array.isArray(data)) {
      const sanitized = data
        .flatMap(p => Array.isArray(p) ? p : [p])
        .filter(p => p && typeof p === 'object' && (p.name || p.itemName || p.title) && !isBlacklistedProduct(p));
      const map = new Map();
      sanitized.forEach(item => {
        const key = String(item.code || item.id || '').trim().toUpperCase();
        if (key && !map.has(key)) {
          map.set(key, item);
        }
      });
      const deduped = Array.from(map.values());
      await writeFile('products.json', deduped);
      return res.json(deduped);
    }
    res.status(400).json({ error: 'Expected array body for batch update' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const targetId = decodeURIComponent(String(id || '')).trim().toLowerCase();
    const updated = req.body;
    const targetCode = String(updated.code || updated.sku || targetId).trim().toLowerCase();
    const rawProducts = await readFile('products.json', []);
    const products = (Array.isArray(rawProducts) ? rawProducts : [])
      .flatMap(p => Array.isArray(p) ? p : [p])
      .filter(p => p && typeof p === 'object' && (p.name || p.itemName || p.title) && !isBlacklistedProduct(p));
    const idx = products.findIndex(p => {
      const pId = String(p.id || '').trim().toLowerCase();
      const pCode = String(p.code || p.sku || '').trim().toLowerCase();
      return (targetId && pId === targetId) || (targetCode && pCode === targetCode);
    });
    if (idx !== -1) {
      products[idx] = { ...products[idx], ...updated };
    } else if (!isBlacklistedProduct(updated)) {
      products.unshift(updated);
    }
    await writeFile('products.json', products);
    res.json(products[idx !== -1 ? idx : 0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const targetId = decodeURIComponent(String(id || '')).trim().toLowerCase();
    const rawProducts = await readFile('products.json', []);
    const products = (Array.isArray(rawProducts) ? rawProducts : [])
      .flatMap(p => Array.isArray(p) ? p : [p])
      .filter(p => p && typeof p === 'object' && (p.name || p.itemName || p.title) && !isBlacklistedProduct(p));
    const filtered = products.filter(p => {
      const pId = String(p.id || '').trim().toLowerCase();
      const pCode = String(p.code || '').trim().toLowerCase();
      return pId !== targetId && pCode !== targetId;
    });
    await writeFile('products.json', filtered);
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 2. Storage Locations ──
router.get('/storage-locations', async (req, res) => {
  try {
    const locs = await readFile('storageLocations.json', initialStorageLocations);
    res.json(locs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/storage-locations', async (req, res) => {
  try {
    const data = req.body;
    if (Array.isArray(data)) {
      await writeFile('storageLocations.json', data);
      return res.json(data);
    }
    const locs = await readFile('storageLocations.json', initialStorageLocations);
    locs.unshift(data);
    await writeFile('storageLocations.json', locs);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/storage-locations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updated = req.body;
    const locs = await readFile('storageLocations.json', initialStorageLocations);
    const idx = locs.findIndex(l => l.id === id);
    if (idx !== -1) {
      locs[idx] = { ...locs[idx], ...updated };
    } else {
      locs.push(updated);
    }
    await writeFile('storageLocations.json', locs);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/storage-locations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const locs = await readFile('storageLocations.json', initialStorageLocations);
    const filtered = locs.filter(l => l.id !== id);
    await writeFile('storageLocations.json', filtered);
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 3. Usage Units (Department-Scoped) ──
router.get('/usage-units', async (req, res) => {
  try {
    const { department } = req.query;
    const units = await readFile('usageUnits.json', initialUsageUnits);
    if (department && department !== 'ALL') {
      return res.json(units.filter(u => u.department === department));
    }
    res.json(units);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/usage-units', async (req, res) => {
  try {
    const data = req.body;
    if (Array.isArray(data)) {
      await writeFile('usageUnits.json', data);
      return res.json(data);
    }
    const units = await readFile('usageUnits.json', initialUsageUnits);
    const newUnit = {
      id: data.id || `UNIT-${data.department || 'GEN'}-${Date.now().toString().slice(-6)}`,
      status: data.status || 'ACTIVE',
      ...data
    };
    units.push(newUnit);
    await writeFile('usageUnits.json', units);
    res.json(newUnit);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/usage-units/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updated = req.body;
    const units = await readFile('usageUnits.json', initialUsageUnits);
    const idx = units.findIndex(u => u.id === id);
    if (idx !== -1) {
      units[idx] = { ...units[idx], ...updated };
      await writeFile('usageUnits.json', units);
      res.json(units[idx]);
    } else {
      units.push(updated);
      await writeFile('usageUnits.json', units);
      res.json(updated);
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/usage-units/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const units = await readFile('usageUnits.json', initialUsageUnits);
    const filtered = units.filter(u => u.id !== id);
    await writeFile('usageUnits.json', filtered);
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 4. Users & Access Management ──
router.get('/users', async (req, res) => {
  try {
    const users = await readFile('users.json', initialUsers);
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/users', async (req, res) => {
  try {
    const data = req.body;
    if (Array.isArray(data)) {
      await writeFile('users.json', data);
      return res.json(data);
    }
    const users = await readFile('users.json', initialUsers);
    const targetId = String(data.id || '').trim().toLowerCase();
    const targetUname = String(data.username || '').trim().toLowerCase();
    const targetEmpId = String(data.employeeId || '').trim().toLowerCase();

    const existingIdx = users.findIndex(u => {
      const uId = String(u.id || '').trim().toLowerCase();
      const uName = String(u.username || '').trim().toLowerCase();
      const uEmp = String(u.employeeId || '').trim().toLowerCase();
      return (targetId && uId === targetId) || (targetUname && uName === targetUname) || (targetEmpId && uEmp === targetEmpId);
    });

    const primaryDept = data.primaryDepartment || data.department || 'PD';
    const allowedDepts = Array.isArray(data.allowedDepartments) && data.allowedDepartments.length > 0 
      ? data.allowedDepartments 
      : (primaryDept === 'ALL' ? ['*'] : [primaryDept]);

    if (existingIdx !== -1) {
      const merged = {
        ...users[existingIdx],
        ...data,
        primaryDepartment: primaryDept,
        department: primaryDept,
        allowedDepartments: allowedDepts
      };
      users[existingIdx] = merged;
      await writeFile('users.json', users);
      return res.json(merged);
    }

    const newId = data.id || `USR-${Date.now().toString().slice(-4)}`;
    const newUser = {
      ...data,
      id: newId,
      primaryDepartment: primaryDept,
      department: primaryDept,
      allowedDepartments: allowedDepts,
      status: data.status || 'ACTIVE'
    };
    users.push(newUser);
    await writeFile('users.json', users);
    res.json(newUser);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const targetId = decodeURIComponent(String(id || '')).trim().toLowerCase();
    const updated = req.body;
    const targetUname = String(updated.username || '').trim().toLowerCase();
    const targetEmpId = String(updated.employeeId || '').trim().toLowerCase();

    const users = await readFile('users.json', initialUsers);
    const idx = users.findIndex(u => {
      const uId = String(u.id || '').trim().toLowerCase();
      const uName = String(u.username || '').trim().toLowerCase();
      const uEmp = String(u.employeeId || '').trim().toLowerCase();
      return (targetId && uId === targetId) || (targetUname && uName === targetUname) || (targetEmpId && uEmp === targetEmpId);
    });
    
    const primaryDept = updated.primaryDepartment || updated.department || (idx !== -1 ? users[idx].primaryDepartment : 'PD');
    const allowedDepts = Array.isArray(updated.allowedDepartments) 
      ? updated.allowedDepartments 
      : (idx !== -1 ? users[idx].allowedDepartments : [primaryDept]);

    const merged = {
      ...(idx !== -1 ? users[idx] : {}),
      ...updated,
      id: (idx !== -1 && users[idx].id) ? users[idx].id : id,
      primaryDepartment: primaryDept,
      department: primaryDept,
      allowedDepartments: allowedDepts
    };

    if (idx !== -1) {
      users[idx] = merged;
    } else {
      users.push(merged);
    }
    await writeFile('users.json', users);
    res.json(merged);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const users = await readFile('users.json', initialUsers);
    const filtered = users.filter(u => u.id !== id);
    await writeFile('users.json', filtered);
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 5. Departments Master Data ──
router.get('/departments', async (req, res) => {
  try {
    const depts = await readFile('departments.json', initialDepartments);
    res.json(depts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/departments', async (req, res) => {
  try {
    const data = req.body;
    if (Array.isArray(data)) {
      await writeFile('departments.json', data);
      return res.json(data);
    }
    const depts = await readFile('departments.json', initialDepartments);
    const code = (data.code || '').toUpperCase().trim();
    const newId = data.id || `DEPT-${code || Date.now().toString().slice(-4)}`;
    const newDept = {
      ...data,
      id: newId,
      code,
      name: data.name || '',
      nameEn: data.nameEn || '',
      prefix: data.prefix || code,
      description: data.description || '',
      monthlyBudget: Number(data.monthlyBudget) || 0,
      isActive: data.isActive !== undefined ? data.isActive : true,
      color: data.color || 'blue',
      managerName: data.managerName || '',
      createdAt: data.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    depts.push(newDept);
    await writeFile('departments.json', depts);
    res.json(newDept);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/departments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updated = req.body;
    const depts = await readFile('departments.json', initialDepartments);
    const idx = depts.findIndex(d => d.id === id || d.code === id);
    const existing = idx !== -1 ? depts[idx] : {};
    const code = (updated.code || existing.code || id).toUpperCase().trim();
    const merged = {
      ...existing,
      ...updated,
      id: existing.id || id,
      code,
      name: updated.name !== undefined ? updated.name : existing.name,
      isActive: updated.isActive !== undefined ? updated.isActive : (existing.isActive !== undefined ? existing.isActive : true),
      monthlyBudget: updated.monthlyBudget !== undefined ? Number(updated.monthlyBudget) : (existing.monthlyBudget || 0),
      updatedAt: new Date().toISOString()
    };
    if (idx !== -1) {
      depts[idx] = merged;
    } else {
      depts.push(merged);
    }
    await writeFile('departments.json', depts);
    res.json(merged);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/departments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const depts = await readFile('departments.json', initialDepartments);
    const filtered = depts.filter(d => d.id !== id && d.code !== id);
    await writeFile('departments.json', filtered);
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 6. Vendors ──
router.get('/vendors', async (req, res) => {
  try {
    const vendors = await readFile('vendors.json', []);
    res.json(vendors);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/vendors', async (req, res) => {
  try {
    const data = req.body;
    if (Array.isArray(data)) {
      await writeFile('vendors.json', data);
      return res.json(data);
    }
    const vendors = await readFile('vendors.json', []);
    vendors.unshift(data);
    await writeFile('vendors.json', vendors);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/vendors/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const targetId = decodeURIComponent(String(id || '')).trim().toLowerCase();
    const updated = req.body;
    const vendors = await readFile('vendors.json', []);
    const idx = vendors.findIndex(v => {
      const vId = String(v.id || '').trim().toLowerCase();
      const vCode = String(v.code || '').trim().toLowerCase();
      return vId === targetId || vCode === targetId;
    });
    if (idx !== -1) {
      vendors[idx] = { ...vendors[idx], ...updated };
    } else {
      vendors.unshift(updated);
    }
    await writeFile('vendors.json', vendors);
    res.json(vendors[idx !== -1 ? idx : 0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/vendors/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const targetId = decodeURIComponent(String(id || '')).trim().toLowerCase();
    const vendors = await readFile('vendors.json', []);
    const filtered = vendors.filter(v => {
      const vId = String(v.id || '').trim().toLowerCase();
      const vCode = String(v.code || '').trim().toLowerCase();
      return vId !== targetId && vCode !== targetId;
    });
    await writeFile('vendors.json', filtered);
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
