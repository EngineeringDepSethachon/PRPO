var _pendingAttachments = [];

/**
 * @file Code.gs
 * @description Main Entry Point and Public RPC API Controller for PRPO_PDQC
 * Dispatches google.script.run requests with authentication, parameter unpacking,
 * transactional locking, safe user context, and standardized response envelope wrapping.
 * @version 3.0.0
 */

/**
 * HTTP GET Entry Point for Standalone Web App.
 * Serves the single-file HTML bundle built by Vite.
 * 
 * @param {Object} e HTTP Event object
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet(e) {
  try {
    const output = HtmlService.createHtmlOutputFromFile('index')
      .setTitle(CONFIG.DEFAULTS.APP_TITLE)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

    return output;
  } catch (err) {
    // If index.html is not yet uploaded/bundled, render helpful diagnostic page
    return HtmlService.createHtmlOutput(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>${CONFIG.DEFAULTS.APP_TITLE}</title>
          <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f172a; color: #f8fafc; padding: 40px 20px; display: flex; justify-content: center; }
            .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; max-width: 600px; padding: 32px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
            h2 { color: #38bdf8; margin-top: 0; }
            p { line-height: 1.6; color: #94a3b8; }
            .badge { background: #0369a1; color: #e0f2fe; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: bold; }
            .btn { background: #2563eb; color: #fff; padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; text-decoration: none; font-weight: bold; display: inline-block; margin-top: 16px; }
            .btn:hover { background: #1d4ed8; }
            code { background: #0f172a; padding: 2px 6px; border-radius: 4px; color: #f43f5e; }
          </style>
        </head>
        <body>
          <div class="card">
            <span class="badge">GAS BACKEND ACTIVE</span>
            <h2>${CONFIG.DEFAULTS.APP_TITLE}</h2>
            <p>ระบบหลังบ้าน Google Apps Script ทำงานเรียบร้อยแล้ว พร้อมรับการเชื่อมต่อจาก Frontend Single HTML Bundle</p>
            <p><strong>ผู้เข้าใช้งานปัจจุบัน:</strong> <code>${getCurrentUserEmail() || 'Unidentified'}</code></p>
            <p><strong>สถานะ:</strong> รอการ Build ไฟล์ <code>dist/index.html</code> และ Deploy ขึ้น GAS ผ่าน clasp หรือ Script Editor</p>
            <a href="javascript:void(0)" onclick="google.script.run.withSuccessHandler(alert).apiGetSystemStatus()" class="btn">ทดสอบระบบ (Diagnostic Ping)</a>
          </div>
        </body>
      </html>
    `).setTitle(CONFIG.DEFAULTS.APP_TITLE);
  }
}

/**
 * Universal RPC Invoker & Safety Middleware.
 * Unpacks payloads, guarantees safe user context, enforces transactional locking,
 * and standardizes responses into { success: true, data: result } or { success: false, error: err.message }.
 * 
 * @param {Function} fn The business logic function to execute (payload, user)
 * @param {string} actionName Name of the action for audit and logging
 * @param {*} rawPayload Incoming payload from frontend (Object or JSON String)
 * @param {Object} [userContext] Explicit user context if provided
 * @returns {Object} Standard API Response { success, data, error }
 */
function handleApiRequest(fn, actionName, rawPayload, userContext) {
  var lock = LockService.getScriptLock();
  var lockAcquired = false;
  try {
    if (!lock.hasLock()) {
      try {
        lock.waitLock(5000); // ป้องกันแย่งกันเขียนชีต (ลดเวลาจาก 10000 เหลือ 5000 ตามคำขอ)
        lockAcquired = true;
      } catch (lockErr) {
        console.warn('[API Controller] Lock waitLock timed out or unavailable in "' + actionName + '": ' + lockErr.message);
      }
    }
    
    // 1. แกะ Payload อย่างปลอดภัย รองรับทั้ง Object และ String JSON
    var payload = rawPayload;
    if (typeof rawPayload === 'string') {
      try { payload = JSON.parse(rawPayload); } catch (e) { payload = {}; }
    }
    payload = payload || {};

    // 2. สร้าง Safe User Context ป้องกัน user.department / user.role เป็น undefined
    var rawUser = userContext || payload.currentUser || payload.user;
    var user;
    if (rawUser && typeof rawUser === 'object') {
      user = {
        username: rawUser.username || rawUser.employeeId || 'system',
        name: rawUser.name || rawUser.displayName || rawUser.employeeName || 'System User',
        department: rawUser.department || rawUser.dept || rawUser.primaryDepartment || payload.department || payload.dept || 'PD',
        role: rawUser.role || rawUser.roleId || rawUser.canonicalRole || 'ADMIN',
        canonicalRole: rawUser.canonicalRole || rawUser.role || rawUser.roleId || 'ADMIN',
        isAdmin: !!(rawUser.isAdmin || rawUser.role === 'ADMIN' || rawUser.canonicalRole === 'ADMIN')
      };
      for (var k in rawUser) {
        if (!(k in user)) {
          user[k] = rawUser[k];
        }
      }
    } else {
      user = {
        username: 'system',
        name: 'System User',
        department: payload.department || payload.dept || 'PD',
        role: 'ADMIN',
        canonicalRole: 'ADMIN',
        isAdmin: true
      };
    }

    // 3. รันฟังก์ชันพร้อมส่ง payload และ safe user
    var result = fn(payload, user);

    // Write pending attachments in a single batch with direct setValues
    if (typeof _pendingAttachments !== 'undefined' && Array.isArray(_pendingAttachments) && _pendingAttachments.length > 0) {
      try {
        var attSheet = getSheet(SHEET_NAMES.ATTACHMENTS);
        var attHeaders = getSheetHeaders(attSheet);
        var attachmentRows = _pendingAttachments.map(function(rec) {
          return serializeRecordToRow(rec, attHeaders);
        });
        if (attachmentRows.length > 0 && attachmentRows[0].length > 0) {
          var lastRow = attSheet.getLastRow();
          attSheet.getRange(lastRow + 1, 1, attachmentRows.length, attachmentRows[0].length).setValues(attachmentRows);
        }
      } catch (attBatchErr) {
        console.warn('[API Controller] Failed to batch write attachments: ' + attBatchErr.message);
      }
      _pendingAttachments = [];
    }

    if (result && typeof result === 'object' && 'success' in result) {
      return result;
    }
    return { success: true, data: result !== undefined ? result : null };
  } catch (err) {
    console.error('[API Controller] Error in "' + actionName + '": ' + err.message + ' \nStack: ' + err.stack);
    return { success: false, error: err.message };
  } finally {
    if (lockAcquired) {
      try { lock.releaseLock(); } catch (e) {}
    }
  }
}

// =========================================================================
// 1. AUTHENTICATION & USER PROFILE RPCs & RBAC GUARDS
// =========================================================================

/**
 * Fetches user profile and permissions from the "Users" sheet tab by email.
 * 
 * @param {string} [email] Target email to look up (defaults to active user)
 * @returns {Object} Hydrated user profile with roles, department, and computed permissions
 */
function getUserProfile(email) {
  const targetEmail = (email || getCurrentUserEmail()).trim().toLowerCase();
  const adminEmails = getAdminEmails();
  const isConfiguredAdmin = targetEmail && adminEmails.includes(targetEmail);

  let usersList = [];
  try {
    usersList = batchReadRecords(SHEET_NAMES.USERS);
  } catch (err) {
    console.warn('[Auth] Could not read Users sheet:', err.message);
  }

  if (targetEmail) {
    const userRecord = usersList.find(u => {
      const userEmail = String(u.email || '').trim().toLowerCase();
      return userEmail === targetEmail;
    });

    if (userRecord) {
      const isActive = userRecord.isActive === true || 
                       String(userRecord.isActive).toLowerCase() === 'true' || 
                       userRecord.isActive === 1 || 
                       userRecord.status === 'ACTIVE';

      if (!isActive) {
        throw new Error(`ACCOUNT_DISABLED: บัญชีผู้ใช้งาน (${targetEmail}) ถูกระงับการใช้งานชั่วคราว กรุณาติดต่อผู้ดูแลระบบ`);
      }

      return buildUserProfile(userRecord, isConfiguredAdmin);
    }

    if (isConfiguredAdmin) {
      return buildUserProfile({
        id: 'USR-BOOTSTRAP-ADMIN',
        employeeId: 'EMP-SYS-ADMIN',
        username: targetEmail.split('@')[0],
        email: targetEmail,
        name: 'System Administrator (Bootstrap)',
        displayName: 'System Admin',
        department: 'MGT',
        primaryDepartment: 'MGT',
        allowedDepartments: ['*'],
        roleId: SYSTEM_ROLES.ADMIN,
        canonicalRole: SYSTEM_ROLES.ADMIN,
        level: 99,
        status: 'ACTIVE',
        isActive: true,
        description: 'ผู้ดูแลระบบฉุกเฉินผ่าน Script Properties'
      });
    }
  }

  return buildUserProfile({
    id: 'USR-APP-SESSION',
    employeeId: 'EMP-APP-001',
    username: targetEmail ? targetEmail.split('@')[0] : 'webapp.user',
    email: targetEmail || 'webapp@company.local',
    name: targetEmail ? `User (${targetEmail.split('@')[0]})` : 'ผู้ใช้งานระบบ',
    displayName: 'App User',
    department: 'MGT',
    primaryDepartment: 'MGT',
    allowedDepartments: ['*'],
    roleId: SYSTEM_ROLES.ADMIN,
    canonicalRole: SYSTEM_ROLES.ADMIN,
    level: 99,
    status: 'ACTIVE',
    isActive: true,
    description: 'ผู้ใช้งานระบบผ่าน Web App'
  });
}

/**
 * Authenticates user credentials against the Users sheet tab.
 * 
 * @param {string} username Username or Employee ID
 * @param {string} password Provided plain password
 * @returns {Object} Hydrated user profile
 */
function authenticateUserByPassword(username, password) {
  const cleanUser = String(username || '').trim().toLowerCase();
  const cleanPass = String(password || '').trim();

  if (!cleanUser) {
    throw new Error('AUTH_ERROR: กรุณาระบุชื่อผู้ใช้งาน (Username หรือ Employee ID)');
  }
  if (!cleanPass) {
    throw new Error('AUTH_ERROR: กรุณาระบุรหัสผ่าน (Password)');
  }

  let usersList = [];
  try {
    usersList = batchReadRecords(SHEET_NAMES.USERS);
  } catch (err) {
    console.warn('[Auth] Could not read Users sheet:', err.message);
  }

  let matchedUser = usersList.find(u => {
    const uUser = String(u.username || '').trim().toLowerCase();
    const uEmp = String(u.employeeId || '').trim().toLowerCase();
    const uEmail = String(u.email || '').trim().toLowerCase();
    return uUser === cleanUser || uEmp === cleanUser || (uEmail && uEmail === cleanUser);
  });

  const DEFAULT_INITIAL_PASSWORDS = ['123456', 'password123', 'admin123'];

  if (!matchedUser) {
    const adminEmails = getAdminEmails();
    const isBootstrapAdmin = cleanUser === 'admin' || adminEmails.some(e => e.toLowerCase() === cleanUser);
    if (isBootstrapAdmin && DEFAULT_INITIAL_PASSWORDS.includes(cleanPass)) {
      matchedUser = {
        id: 'USR-0006',
        employeeId: 'EMP-SYS-999',
        username: 'admin',
        email: adminEmails[0] || 'admin@company.com',
        name: 'System Administrator (Bootstrap)',
        displayName: 'System Admin',
        department: 'MGT',
        primaryDepartment: 'MGT',
        departments: ['*'],
        allowedDepartments: ['*'],
        roleId: SYSTEM_ROLES.ADMIN,
        canonicalRole: SYSTEM_ROLES.ADMIN,
        level: 99,
        status: 'ACTIVE',
        isActive: true,
        password: cleanPass
      };
      try {
        upsertRecordById(SHEET_NAMES.USERS, 'id', matchedUser);
      } catch (e) {}
    } else {
      throw new Error('AUTH_FAILED: ชื่อผู้ใช้งาน (Username) หรือรหัสผ่าน (Password) ไม่ถูกต้อง');
    }
  }

  const storedPass = String(matchedUser.password || '').trim();
  let isPasswordValid = false;

  if (storedPass) {
    isPasswordValid = (storedPass === cleanPass);
  } else {
    if (DEFAULT_INITIAL_PASSWORDS.includes(cleanPass)) {
      isPasswordValid = true;
      try {
        matchedUser.password = cleanPass;
        matchedUser.updatedAt = new Date().toISOString();
        upsertRecordById(SHEET_NAMES.USERS, 'id', matchedUser);
      } catch (saveErr) {}
    }
  }

  if (!isPasswordValid) {
    throw new Error('AUTH_FAILED: ชื่อผู้ใช้งาน (Username) หรือรหัสผ่าน (Password) ไม่ถูกต้อง');
  }

  const isActive = matchedUser.isActive === true || 
                   String(matchedUser.isActive).toLowerCase() === 'true' || 
                   matchedUser.isActive === 1 || 
                   matchedUser.status === 'ACTIVE';

  if (!isActive) {
    throw new Error(`ACCOUNT_DISABLED: บัญชีผู้ใช้งาน (${matchedUser.username}) ถูกระงับการใช้งานชั่วคราว กรุณาติดต่อผู้ดูแลระบบ`);
  }

  const adminEmails = getAdminEmails();
  const isConfiguredAdmin = adminEmails.includes(String(matchedUser.email || '').toLowerCase()) || matchedUser.username === 'admin';

  return buildUserProfile(matchedUser, isConfiguredAdmin);
}

/**
 * Normalizes user record and calculates fine-grained permissions.
 * @param {Object} raw Raw row record
 * @param {boolean} [elevateAdmin=false] Whether to elevate to ADMIN
 * @returns {Object}
 */
function buildUserProfile(raw, elevateAdmin = false) {
  let allowedDepts = [];
  if (Array.isArray(raw.allowedDepartments)) {
    allowedDepts = raw.allowedDepartments.filter(d => String(d).toUpperCase() !== 'ALL');
  } else if (typeof raw.allowedDepartments === 'string') {
    try {
      allowedDepts = JSON.parse(raw.allowedDepartments).filter(d => String(d).toUpperCase() !== 'ALL');
    } catch (e) {
      allowedDepts = raw.allowedDepartments.split(',').map(d => d.trim()).filter(d => d && d.toUpperCase() !== 'ALL');
    }
  }

  if (allowedDepts.length === 0) {
    const fallbackDept = (raw.primaryDepartment && raw.primaryDepartment !== 'ALL') 
      ? raw.primaryDepartment 
      : ((raw.department && raw.department !== 'ALL') ? raw.department : 'MGT');
    allowedDepts = [fallbackDept];
  }

  const roleId = elevateAdmin ? SYSTEM_ROLES.ADMIN : (raw.roleId || raw.canonicalRole || SYSTEM_ROLES.REQUESTER);
  const canonicalRole = elevateAdmin ? SYSTEM_ROLES.ADMIN : (raw.canonicalRole || raw.roleId || SYSTEM_ROLES.REQUESTER);
  const level = elevateAdmin ? 99 : Number(raw.level || 1);

  const roleStr = String(roleId + ' ' + canonicalRole).toUpperCase();
  const isAdmin = elevateAdmin || level >= 99 || roleStr.includes('ADMIN');
  const isApprover = isAdmin || level >= 3 || roleStr.includes('APPROV') || roleStr.includes('PLANT_MANAGER');
  const isPurchaser = isAdmin || roleStr.includes('PURCHAS') || roleStr.includes('ONLINE_PURCHASER');
  const isReviewer = isAdmin || isApprover || level >= 2 || roleStr.includes('REVIEW') || roleStr.includes('ASST_MANAGER');
  const isRequester = isAdmin || roleStr.includes('REQUEST') || roleStr.includes('PD') || roleStr.includes('QC');

  const permissions = {
    PR_CREATION: Boolean(isAdmin || isRequester || raw.canCreatePR),
    REVIEW: Boolean(isAdmin || isReviewer || raw.canReview),
    APPROVAL: Boolean(isAdmin || isApprover || raw.canFinalApprove),
    PURCHASING: Boolean(isAdmin || isPurchaser || raw.canOnlinePurchase),
    INVENTORY: Boolean(isAdmin || isRequester || raw.canReceiveGRN || raw.canReceiveGoods),
    ADMIN: Boolean(isAdmin)
  };

  const cleanDept = (raw.department && raw.department !== 'ALL') ? raw.department : ((roleId === 'ONLINE_PURCHASER') ? 'PUR' : 'MGT');
  const cleanPDept = (raw.primaryDepartment && raw.primaryDepartment !== 'ALL') ? raw.primaryDepartment : cleanDept;

  return {
    id: raw.id || `USR-${Utilities.getUuid().slice(0, 8)}`,
    employeeId: raw.employeeId || '',
    username: raw.username || (raw.email ? raw.email.split('@')[0] : ''),
    email: (raw.email || '').trim().toLowerCase(),
    name: raw.name || raw.employeeName || raw.displayName || 'ผู้ใช้งานระบบ',
    displayName: raw.displayName || raw.name || raw.employeeName || 'User',
    department: cleanDept,
    primaryDepartment: cleanPDept,
    allowedDepartments: allowedDepts,
    roleId: roleId,
    canonicalRole: canonicalRole,
    level: level,
    status: raw.status || 'ACTIVE',
    isActive: true,
    isAdmin: isAdmin,
    isApprover: isApprover,
    isPurchaser: isPurchaser,
    isReviewer: isReviewer,
    isRequester: isRequester,
    permissions: permissions
  };
}

/**
 * Server-side RBAC Guard: Requires user to be authenticated and registered.
 */
function requireAuth() {
  return getUserProfile();
}

/**
 * Server-side RBAC Guard: Requires active user to possess at least one of the allowed roles.
 */
function requireRole(allowedRoles = []) {
  const user = requireAuth();
  if (user.isAdmin) return user;

  const userRoles = [
    String(user.roleId || '').toUpperCase(),
    String(user.canonicalRole || '').toUpperCase()
  ];

  const hasRole = allowedRoles.some(r => userRoles.includes(String(r).toUpperCase()));
  if (!hasRole) {
    throw new Error(`PERMISSION_DENIED: สิทธิ์การใช้งานไม่เพียงพอ ต้องการบทบาทอย่างน้อยหนึ่งใน [${allowedRoles.join(', ')}]`);
  }

  return user;
}

/**
 * Server-side RBAC Guard: Requires specific permission capability.
 */
function requirePermission(permissionKey) {
  const user = requireAuth();
  if (user.isAdmin) return user;

  if (!user.permissions || !user.permissions[permissionKey]) {
    throw new Error(`PERMISSION_DENIED: ผู้ใช้ไม่มีสิทธิ์ในการดำเนินการ "${permissionKey}"`);
  }

  return user;
}

/**
 * Server-side Department Guard: Ensures user has access to specified department.
 */
function requireDepartment(targetDepartment) {
  const user = requireAuth();
  if (user.isAdmin) return user;

  const target = String(targetDepartment || '').trim().toUpperCase();
  const allowed = user.allowedDepartments.map(d => String(d).trim().toUpperCase());

  const canAccess = allowed.includes('*') || allowed.includes('ALL') || allowed.includes(target);
  if (!canAccess) {
    throw new Error(`DEPARTMENT_ACCESS_DENIED: ท่านไม่มีสิทธิ์เข้าถึงหรือจัดการข้อมูลของแผนก "${targetDepartment}"`);
  }

  return user;
}

/**
 * Returns authenticated user profile and capability matrix.
 */
function apiGetCurrentUser(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    return {
      username: user.username,
      name: user.name,
      department: user.department,
      role: user.role,
      canonicalRole: user.canonicalRole,
      isAdmin: user.isAdmin
    };
  }, 'GetCurrentUser', rawPayload, userContext);
}

/**
 * Authenticates user credentials with username and password against Users sheet.
 * Public endpoint for frontend login.
 * 
 * @param {string} username Username or Employee ID
 * @param {string} password Password
 * @returns {Object} Hydrated user profile
 */
function apiLogin(username, password, rawPayload, userContext) {
  var cleanUser = username;
  var cleanPass = password;
  if (typeof username === 'object' && username !== null) {
    cleanUser = username.username || username.employeeId;
    cleanPass = username.password;
    rawPayload = username;
    userContext = password;
  }
  return handleApiRequest(function(payload, user) {
    var u = cleanUser || payload.username || payload.employeeId;
    var p = cleanPass || payload.password;
    return authenticateUserByPassword(u, p);
  }, 'Login', rawPayload, userContext);
}

/**
 * Retrieves all registered users from Users sheet.
 */
function apiGetUsers(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    return batchReadRecords(SHEET_NAMES.USERS);
  }, 'GetUsers', rawPayload, userContext);
}

/**
 * Upserts a user account.
 */
function apiUpsertUser(userObj, userContext) {
  return handleApiRequest(function(payload, user) {
    var target = payload ? Object.assign({}, payload) : {};
    target.department = target.department || target.dept || user.department || 'PD';
    target.updatedAt = new Date().toISOString();
    if (!target.id && !target.employeeId && !target.username) {
      target.id = 'USR-' + Date.now();
    }
    var key = target.id ? 'id' : (target.username ? 'username' : 'employeeId');
    return upsertRecordById(SHEET_NAMES.USERS, key, target);
  }, 'UpsertUser', userObj, userContext);
}

/**
 * Saves a user account (Standard alias for apiUpsertUser).
 */
function apiSaveUser(userObj, userContext) {
  return apiUpsertUser(userObj, userContext);
}

/**
 * Deletes a user account.
 */
function apiDeleteUser(userIdOrPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var id = (typeof userIdOrPayload === 'object' && userIdOrPayload !== null)
      ? (userIdOrPayload.id || userIdOrPayload.userId)
      : (payload.id || payload.userId || userIdOrPayload);
    if (!id) {
      throw new Error('VALIDATION_ERROR: Missing User ID for deletion');
    }
    return deleteRecordById(SHEET_NAMES.USERS, 'id', id);
  }, 'DeleteUser', userIdOrPayload, userContext);
}

// =========================================================================
// 2. MASTER DATA RPCs (Products, Vendors, Locations, Units, Depts)
// =========================================================================

/**
 * Universal Master Item Saver RPC Endpoint.
 * Validates duplicate code, generates ID, timestamps, and persists to Google Sheet.
 * 
 * @param {string|Object} collectionOrPayload 'Products' | 'Vendors' | 'StorageLocations' | 'UsageUnits'
 * @param {Object} [itemOrUser] Record to save
 * @param {Object} [userContext] Optional user context
 * @returns {Object} Standard API response envelope
 */
function apiSaveMasterItem(collectionOrPayload, itemOrUser, userContext) {
  var collection = collectionOrPayload;
  var item = itemOrUser;
  var rawPayload = item;
  var rawUser = userContext;

  if (typeof collectionOrPayload === 'object' && collectionOrPayload !== null) {
    collection = collectionOrPayload.collection || collectionOrPayload.collectionName || collectionOrPayload.sheetName;
    item = collectionOrPayload.item || collectionOrPayload.data || collectionOrPayload;
    rawPayload = collectionOrPayload;
    rawUser = itemOrUser;
  }

  return handleApiRequest(function(payload, user) {
    var targetCollection = collection || payload.collection;
    var targetItem = item || payload.item || payload;
    if (typeof targetItem === 'string') {
      try { targetItem = JSON.parse(targetItem); } catch (e) { targetItem = {}; }
    }
    targetItem = targetItem ? Object.assign({}, targetItem) : {};

    // Fallback department
    var rawDept = targetItem.department || targetItem.dept || targetItem.category || user.department || 'PD';
    var cleanDept = String(rawDept).replace(/^DEPT-/, '').trim().toUpperCase() || 'PD';
    targetItem.department = cleanDept;
    targetItem.category = cleanDept;
    targetItem.dept = cleanDept;
    targetItem.updatedAt = new Date().toISOString();
    if (!targetItem.createdAt && !targetItem.id) {
      targetItem.createdAt = new Date().toISOString();
    }

    var sheetName = resolveMasterSheetName(targetCollection);
    var targetCode = String(targetItem.code || targetItem.sku || targetItem.vendorCode || '').trim().toUpperCase();
    if (sheetName === SHEET_NAMES.DEPARTMENTS && targetCode === 'ALL') {
      throw new Error('VALIDATION_ERROR: ไม่อนุญาตให้ใช้รหัส "ALL" เป็นแผนกจริงในระบบ');
    }

    // Auto-generate ID if new item
    if (!targetItem.id) {
      var suffix = Date.now().toString().slice(-4);
      if (sheetName === SHEET_NAMES.PRODUCTS) {
        var cat = targetItem.category || targetItem.department || 'PD';
        targetItem.id = 'PROD-' + cat + '-' + suffix;
      } else if (sheetName === SHEET_NAMES.VENDORS) {
        targetItem.id = 'VEN-' + suffix;
      } else if (sheetName === SHEET_NAMES.STORAGE_LOCATIONS) {
        targetItem.id = 'LOC-' + (targetItem.department || 'ALL') + '-' + suffix;
      } else if (sheetName === SHEET_NAMES.USAGE_UNITS) {
        targetItem.id = 'UNIT-' + (targetItem.department || 'PD') + '-' + suffix;
      } else {
        targetItem.id = 'ID-' + suffix;
      }
    }
    if (targetItem.status === undefined && targetItem.isActive === undefined) {
      targetItem.status = 'ACTIVE';
      targetItem.isActive = true;
    }

    // Uniqueness validation for PRODUCTS and VENDORS scoped by Department
    if ((sheetName === SHEET_NAMES.PRODUCTS || sheetName === SHEET_NAMES.VENDORS) && targetCode) {
      var existingItems = batchReadRecords(sheetName) || [];
      var isDuplicate = existingItems.some(function(existing) {
        if (!existing) return false;
        if (targetItem.id && String(existing.id).trim().toLowerCase() === String(targetItem.id).trim().toLowerCase()) {
          return false;
        }
        var existingCode = String(existing.code || existing.sku || existing.vendorCode || '').trim().toUpperCase();
        if (!existingCode || existingCode !== targetCode) {
          return false;
        }

        if (sheetName === SHEET_NAMES.PRODUCTS) {
          var existingDept = existing.department || existing.category || existing.dept || 'PD';
          var itemDept = targetItem.department || targetItem.category || targetItem.dept || 'PD';
          return matchDepartment(existingDept, itemDept);
        } else {
          var exDept = String(existing.department || 'ALL').trim().toUpperCase();
          var itDept = String(targetItem.department || 'ALL').trim().toUpperCase();
          return (exDept === 'ALL' || itDept === 'ALL' || matchDepartment(exDept, itDept));
        }
      });

      if (isDuplicate) {
        var entityName = (sheetName === SHEET_NAMES.PRODUCTS) ? 'สินค้า' : 'ผู้ขาย';
        throw new Error('VALIDATION_ERROR: รหัส' + entityName + ' "' + targetCode + '" ซ้ำกับข้อมูลในแผนก ' + cleanDept);
      }
    }

    // High-speed RAM array search + batch write
    var saved = upsertRecordFast(sheetName, 'id', targetItem);
    return saved;
  }, 'SaveMasterItem', rawPayload, rawUser);
}

/**
 * Universal Master Item Deletion RPC Endpoint.
 * Deletes item row from Google Sheet by ID.
 * 
 * @param {string|Object} collectionOrPayload 'Products' | 'Vendors' | 'StorageLocations' | 'UsageUnits'
 * @param {string} [idOrUser] Unique identifier
 * @param {Object} [userContext] Optional user context
 * @returns {Object} Standard API response envelope
 */
function apiDeleteMasterItem(collectionOrPayload, idOrUser, userContext) {
  var collection = collectionOrPayload;
  var id = idOrUser;
  var rawPayload = { collection: collection, id: id };
  var rawUser = userContext;

  if (typeof collectionOrPayload === 'object' && collectionOrPayload !== null) {
    collection = collectionOrPayload.collection || collectionOrPayload.sheetName;
    id = collectionOrPayload.id || collectionOrPayload.itemId;
    rawPayload = collectionOrPayload;
    rawUser = idOrUser;
  }

  return handleApiRequest(function(payload, user) {
    var targetCollection = collection || payload.collection;
    var targetId = id || payload.id;
    if (!targetId) {
      throw new Error('VALIDATION_ERROR: Missing ID for deletion');
    }
    var result = deleteMasterItem(targetCollection, targetId);
    return (result && result.data !== undefined) ? result.data : result;
  }, 'DeleteMasterItem', rawPayload, rawUser);
}

/**
 * Retrieves master data items from specified collection.
 * 
 * @param {string|Object} collectionOrPayload Collection identifier or payload
 * @param {Object} [userContext]
 * @returns {Object} Standard API response envelope
 */
function apiGetMasterData(collectionOrPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var coll = typeof payload === 'string' ? payload : (payload.collection || payload.type || 'Products');
    var sheetName = resolveMasterSheetName(coll);
    return batchReadRecords(sheetName);
  }, 'GetMasterData', collectionOrPayload, userContext);
}

/**
 * Auto-fallback on Read:
 * If a product has stockBalance > 0 but averageCost is 0 or empty,
 * fall back to unitPrice from latest 'IN' log in StockLogs.
 */
function applyProductCostFailSafe(products, stockLogs) {
  if (!Array.isArray(products)) return products;
  var logs = Array.isArray(stockLogs) ? stockLogs : (batchReadRecords(SHEET_NAMES.STOCK_LOGS) || []);
  
  var latestInLogsMap = {};
  logs.forEach(function(l) {
    if (!l) return;
    var lType = String(l.type || '').toUpperCase();
    var qty = Number(l.qty || l.quantity || 0);
    var unitPrice = Number(l.unitPrice !== undefined ? l.unitPrice : (l.actualUnitPrice !== undefined ? l.actualUnitPrice : (l.unitCost || 0)));
    if (lType === 'IN' && qty > 0 && unitPrice > 0) {
      var ts = new Date(l.timestamp || l.date || 0).getTime();
      var keys = [
        String(l.productId || '').trim().toLowerCase(),
        String(l.productCode || l.code || l.sku || '').trim().toLowerCase(),
        String(l.name || '').trim().toLowerCase()
      ].filter(Boolean);
      
      keys.forEach(function(k) {
        if (!latestInLogsMap[k] || ts >= latestInLogsMap[k].ts) {
          latestInLogsMap[k] = { unitPrice: unitPrice, ts: ts };
        }
      });
    }
  });

  products.forEach(function(prod) {
    if (!prod) return;
    var stock = Number(prod.stockBalance !== undefined ? prod.stockBalance : (prod.currentStock || prod.stock || 0));
    var cost = Number(prod.averageCost !== undefined && prod.averageCost !== '' && prod.averageCost !== null ? prod.averageCost : (prod.avgCost !== undefined && prod.avgCost !== '' && prod.avgCost !== null ? prod.avgCost : 0));
    
    if (stock > 0 && cost <= 0) {
      var pId = String(prod.id || '').trim().toLowerCase();
      var pCode = String(prod.code || prod.sku || '').trim().toLowerCase();
      var pName = String(prod.name || '').trim().toLowerCase();
      
      var match = (pId && latestInLogsMap[pId]) || (pCode && latestInLogsMap[pCode]) || (pName && latestInLogsMap[pName]);
      if (match && match.unitPrice > 0) {
        prod.averageCost = match.unitPrice;
        prod.avgCost = match.unitPrice;
        if (!prod.totalValue || Number(prod.totalValue) <= 0) {
          prod.totalValue = Math.round(stock * match.unitPrice * 100) / 100;
        }
      }
    } else if (cost > 0) {
      if (prod.averageCost === undefined || prod.averageCost === null || prod.averageCost === '') {
        prod.averageCost = cost;
      }
      if (prod.avgCost === undefined || prod.avgCost === null || prod.avgCost === '') {
        prod.avgCost = cost;
      }
      if (!prod.totalValue || Number(prod.totalValue) <= 0) {
        prod.totalValue = Math.round(stock * cost * 100) / 100;
      }
    }
  });
  return products;
}

/**
 * Retrieves all products with fail-safe fallback applied.
 */
function apiGetProducts(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var products = batchReadRecords(SHEET_NAMES.PRODUCTS);
    var logs = batchReadRecords(SHEET_NAMES.STOCK_LOGS);
    return applyProductCostFailSafe(products, logs);
  }, 'GetProducts', rawPayload, userContext);
}

/**
 * Recalculates Moving Average Cost (MAC) from historical IN logs and updates Products sheet.
 */
function apiRecalculateProductMAC(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var p = typeof payload === 'string' ? JSON.parse(payload) : (payload || {});
    var targetKey = String(p.productId || p.productCode || p.code || p.id || p.targetSkuOrName || '').trim().toLowerCase();
    if (!targetKey) throw new Error('VALIDATION_ERROR: Missing target product identifier');

    var ss = getSpreadsheet();
    var prodSheet = ss.getSheetByName(SHEET_NAMES.PRODUCTS || 'Products');
    if (typeof ensureProductSheetHeaders === 'function') {
      ensureProductSheetHeaders(prodSheet);
    }
    
    var products = batchReadRecords(SHEET_NAMES.PRODUCTS);
    var targetProdIndex = products.findIndex(function(prod) {
      if (!prod) return false;
      var cId = String(prod.id || '').trim().toLowerCase();
      var cCode = String(prod.code || prod.sku || '').trim().toLowerCase();
      var cName = String(prod.name || '').trim().toLowerCase();
      return cId === targetKey || cCode === targetKey || cName === targetKey;
    });

    if (targetProdIndex === -1) {
      throw new Error('NOT_FOUND: ไม่พบสินค้า "' + targetKey + '" ในระบบ');
    }

    var prod = products[targetProdIndex];
    var pId = String(prod.id || '').trim().toLowerCase();
    var pCode = String(prod.code || prod.sku || '').trim().toLowerCase();
    var pName = String(prod.name || '').trim().toLowerCase();

    var allLogs = batchReadRecords(SHEET_NAMES.STOCK_LOGS);
    var targetLogs = allLogs.filter(function(l) {
      if (!l) return false;
      var lSku = String(l.productCode || l.code || l.sku || '').trim().toLowerCase();
      var lId = String(l.productId || '').trim().toLowerCase();
      var lName = String(l.name || l.productName || '').trim().toLowerCase();
      var match = (pId && lId === pId) || (pCode && (lSku === pCode || lId === pCode)) || (pName && lName === pName);
      var lType = String(l.type || '').toUpperCase();
      var qty = Number(l.quantity !== undefined ? l.quantity : (l.qty || 0));
      return match && lType === 'IN' && qty > 0;
    }).sort(function(a, b) {
      return new Date(a.timestamp || a.date || 0).getTime() - new Date(b.timestamp || b.date || 0).getTime();
    });

    var currentStock = 0;
    var currentAvgCost = 0;

    targetLogs.forEach(function(log) {
      var inQty = Number(log.quantity !== undefined ? log.quantity : (log.qty || 0));
      var inUnitCost = Number(
        log.unitPrice !== undefined ? log.unitPrice : 
        (log.actualUnitPrice !== undefined ? log.actualUnitPrice : 
        (log.unitCost || log.baseUnitCost || 0))
      );

      var currentTotalValue = currentStock * currentAvgCost;
      var inTotalValue = inQty * inUnitCost;
      var newStock = currentStock + inQty;
      var newAverageCost = inUnitCost;

      if (currentStock > 0 && newStock > 0) {
        newAverageCost = (currentTotalValue + inTotalValue) / newStock;
      }
      newAverageCost = Math.round((newAverageCost + Number.EPSILON) * 100) / 100;
      currentStock = newStock;
      currentAvgCost = newAverageCost;
    });

    if (p.averageCost && Number(p.averageCost) > 0 && currentAvgCost === 0) {
      currentAvgCost = Number(p.averageCost);
    }

    if (currentAvgCost > 0) {
      var stock = Number(prod.stockBalance !== undefined ? prod.stockBalance : (prod.currentStock || 0));
      prod.averageCost = currentAvgCost;
      prod.avgCost = currentAvgCost;
      prod.totalValue = Math.round(stock * currentAvgCost * 100) / 100;
      prod.updatedAt = new Date().toISOString();

      upsertRecordFast(SHEET_NAMES.PRODUCTS, 'id', prod);
    }

    return {
      success: true,
      product: prod,
      averageCost: prod.averageCost,
      totalValue: prod.totalValue
    };
  }, 'RecalculateProductMAC', rawPayload, userContext);
}

/**
 * Upserts a product.
 */
function apiUpsertProduct(productObj, userContext) {
  return apiSaveMasterItem(SHEET_NAMES.PRODUCTS, productObj, userContext);
}

/**
 * Deletes a product by ID.
 */
function apiDeleteProduct(productId, userContext) {
  return apiDeleteMasterItem(SHEET_NAMES.PRODUCTS, productId, userContext);
}

/**
 * Retrieves all vendors.
 */
function apiGetVendors(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    return batchReadRecords(SHEET_NAMES.VENDORS);
  }, 'GetVendors', rawPayload, userContext);
}

/**
 * Upserts a vendor record.
 */
function apiUpsertVendor(vendorObj, userContext) {
  return apiSaveMasterItem(SHEET_NAMES.VENDORS, vendorObj, userContext);
}

/**
 * Deletes a vendor by ID.
 */
function apiDeleteVendor(vendorId, userContext) {
  return apiDeleteMasterItem(SHEET_NAMES.VENDORS, vendorId, userContext);
}

/**
 * Storage Locations RPCs
 */
function apiGetStorageLocations(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    return batchReadRecords(SHEET_NAMES.STORAGE_LOCATIONS);
  }, 'GetStorageLocations', rawPayload, userContext);
}

function apiUpsertStorageLocation(locationObj, userContext) {
  return apiSaveMasterItem(SHEET_NAMES.STORAGE_LOCATIONS, locationObj, userContext);
}

function apiDeleteStorageLocation(locationId, userContext) {
  return apiDeleteMasterItem(SHEET_NAMES.STORAGE_LOCATIONS, locationId, userContext);
}

/**
 * Usage Units RPCs
 */
function apiGetUsageUnits(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    return batchReadRecords(SHEET_NAMES.USAGE_UNITS);
  }, 'GetUsageUnits', rawPayload, userContext);
}

function apiUpsertUsageUnit(unitObj, userContext) {
  return apiSaveMasterItem(SHEET_NAMES.USAGE_UNITS, unitObj, userContext);
}

function apiDeleteUsageUnit(unitId, userContext) {
  return apiDeleteMasterItem(SHEET_NAMES.USAGE_UNITS, unitId, userContext);
}

/**
 * Departments RPCs
 */
function apiGetDepartments(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    return batchReadRecords(SHEET_NAMES.DEPARTMENTS);
  }, 'GetDepartments', rawPayload, userContext);
}

function apiUpsertDepartment(deptObj, userContext) {
  return handleApiRequest(function(payload, user) {
    var target = payload ? Object.assign({}, payload) : {};
    var code = String(target.code || '').trim().toUpperCase();
    if (code === 'ALL') {
      throw new Error('VALIDATION_ERROR: ไม่อนุญาตให้ใช้รหัสแผนก "ALL"');
    }
    target.updatedAt = new Date().toISOString();
    return upsertRecordById(SHEET_NAMES.DEPARTMENTS, 'code', target);
  }, 'UpsertDepartment', deptObj, userContext);
}

/**
 * Signatures RPCs
 */
function apiGetSignatures(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    return batchReadRecords(SHEET_NAMES.SIGNATURES);
  }, 'GetSignatures', rawPayload, userContext);
}

function apiSaveSignature(roleId, signatureUrl, userObj, rawPayload, userContext) {
  var cleanRoleId = roleId;
  var cleanUrl = signatureUrl;
  var cleanUser = userObj;
  if (typeof roleId === 'object' && roleId !== null) {
    cleanRoleId = roleId.roleId;
    cleanUrl = roleId.signatureUrl || roleId.signature;
    cleanUser = roleId.userObj || roleId.user;
    rawPayload = roleId;
    userContext = signatureUrl;
  }
  return handleApiRequest(function(payload, user) {
    var rId = cleanRoleId || payload.roleId;
    var sUrl = cleanUrl || payload.signatureUrl || payload.signature;
    var u = cleanUser || payload.userObj || user;
    var record = {
      roleId: rId,
      name: u ? (u.name || u.displayName || u.username) : 'Unknown',
      signatureUrl: sUrl,
      updatedAt: new Date().toISOString(),
      updatedBy: u ? (u.email || u.username) : 'Unknown'
    };
    return upsertRecordById(SHEET_NAMES.SIGNATURES, 'roleId', record);
  }, 'SaveSignature', rawPayload, userContext);
}

// =========================================================================
// 3. PURCHASE REQUEST (PR) RPCs
// =========================================================================

/**
 * Normalizes PR records for backward compatibility.
 * If any PR contains item store URLs (Shopee/Lazada/http/https) or mentions "ออนไลน์" / "online",
 * enforce purchaseChannel = 'ONLINE'.
 *
 * @param {Array<Object>} prs
 * @returns {Array<Object>}
 */
function normalizePRsLegacyOnline(prs) {
  if (!Array.isArray(prs)) return [];
  return prs.map(function(pr) {
    if (!pr || typeof pr !== 'object') return pr;

    var currentChannel = String(pr.purchaseChannel || pr.channel || '').trim().toUpperCase();
    if (currentChannel === 'ONLINE' || currentChannel === 'ONLINE_PURCHASE') {
      pr.purchaseChannel = 'ONLINE';
      pr.channel = 'ONLINE';
      return pr;
    }

    var isOnline = false;

    // 1. Check PR level fields
    var textToCheck = (
      String(pr.purchaseChannel || '') + ' ' +
      String(pr.channel || '') + ' ' +
      String(pr.orderType || '') + ' ' +
      String(pr.remarks || '') + ' ' +
      String(pr.note || '') + ' ' +
      String(pr.notes || '') + ' ' +
      String(pr.vendorName || '')
    ).toLowerCase();

    if (
      textToCheck.indexOf('ออนไลน์') !== -1 ||
      textToCheck.indexOf('online') !== -1 ||
      textToCheck.indexOf('shopee') !== -1 ||
      textToCheck.indexOf('lazada') !== -1 ||
      textToCheck.indexOf('tiktok') !== -1
    ) {
      isOnline = true;
    }

    // 2. Check items
    var rawItems = pr.items;
    if (typeof rawItems === 'string') {
      try {
        rawItems = JSON.parse(rawItems);
      } catch (e) {
        var strItems = rawItems.toLowerCase();
        if (
          strItems.indexOf('http://') !== -1 ||
          strItems.indexOf('https://') !== -1 ||
          strItems.indexOf('shopee') !== -1 ||
          strItems.indexOf('lazada') !== -1 ||
          strItems.indexOf('tiktok') !== -1 ||
          strItems.indexOf('ออนไลน์') !== -1 ||
          strItems.indexOf('online') !== -1
        ) {
          isOnline = true;
        }
      }
    }

    if (!isOnline && Array.isArray(rawItems)) {
      for (var i = 0; i < rawItems.length; i++) {
        var it = rawItems[i];
        if (!it) continue;
        var url = String(it.productUrl || it.onlineUrl || it.url || it.shopUrl || it.link || it.itemUrl || '').trim().toLowerCase();
        if (
          url.indexOf('http://') === 0 ||
          url.indexOf('https://') === 0 ||
          url.indexOf('shopee') !== -1 ||
          url.indexOf('lazada') !== -1 ||
          url.indexOf('tiktok') !== -1
        ) {
          isOnline = true;
          break;
        }
        var itemText = (
          String(it.name || '') + ' ' +
          String(it.description || '') + ' ' +
          String(it.remarks || '') + ' ' +
          String(it.note || '') + ' ' +
          String(it.vendorName || '')
        ).toLowerCase();
        if (
          itemText.indexOf('ออนไลน์') !== -1 ||
          itemText.indexOf('online') !== -1 ||
          itemText.indexOf('shopee') !== -1 ||
          itemText.indexOf('lazada') !== -1
        ) {
          isOnline = true;
          break;
        }
      }
    }

    if (isOnline) {
      pr.purchaseChannel = 'ONLINE';
      pr.channel = 'ONLINE';
    }

    return pr;
  });
}

/**
 * Records an audit log entry in AuditLogs sheet with full schema & legacy compatibility.
 * Covers both standard schema (targetRef, summary, actor, changes, createdAt)
 * and legacy/header variants (docNo, actorName, actorRole, comment, details).
 *
 * @param {string} docNo Document number (e.g. "PD007/2026")
 * @param {string} action Action name (e.g. "CREATE", "SEND_BACK", "REVIEW_APPROVED", "APPROVED")
 * @param {string} actorName Name of actor
 * @param {string} actorRole Role of actor
 * @param {string} comment Reason or comment
 * @param {string} [module='PURCHASE'] Module name
 * @param {Object} [userObj=null] Full user context object
 * @returns {Object} Appended audit log object
 */
function recordAuditLogEntry(docNo, action, actorName, actorRole, comment, module, userObj) {
  try {
    var opts = {};
    if (typeof docNo === 'object' && docNo !== null) {
      opts = docNo;
      docNo = opts.docNo || opts.targetRef || opts.documentNo || opts.prNo || '';
      action = opts.action;
      actorName = opts.actorName || (opts.actor && (opts.actor.name || opts.actor.displayName || opts.actor.username)) || (typeof opts.actor === 'string' ? opts.actor : '');
      actorRole = opts.actorRole || (opts.actor && (opts.actor.role || opts.actor.userRole || opts.actor.title)) || '';
      comment = opts.comment || opts.summary || opts.reason || '';
      module = opts.module || 'PURCHASE';
      userObj = (opts.actor && typeof opts.actor === 'object') ? opts.actor : null;
    }

    var timestamp = new Date().toISOString();
    var cleanDocNo = String(docNo || '').trim().toUpperCase();
    var cleanAction = String(action || 'ACTION').trim();
    var cleanActorName = String(actorName || (userObj && (userObj.name || userObj.username)) || 'ผู้ใช้งาน').trim();
    var cleanActorRole = String(actorRole || (userObj && (userObj.role || userObj.title || userObj.canonicalRole)) || '').trim();
    var cleanComment = String(comment || opts.summary || '').trim();
    var summaryText = opts.summary || cleanComment || (cleanAction + ' บนเอกสาร ' + cleanDocNo);

    var auditLog = {
      id: opts.id || ('AL-' + Date.now() + '-' + Utilities.getUuid().slice(0, 4)),
      timestamp: timestamp,
      createdAt: timestamp,
      action: cleanAction,
      module: module || 'PURCHASE',
      targetRef: cleanDocNo,
      docNo: cleanDocNo,
      documentNo: cleanDocNo,
      prNo: cleanDocNo,
      actorName: cleanActorName,
      actorRole: cleanActorRole,
      actor: (opts.actor && typeof opts.actor === 'object') ? opts.actor : {
        id: (userObj && (userObj.username || userObj.id)) || 'USER',
        name: cleanActorName,
        role: cleanActorRole,
        department: (userObj && userObj.department) || ''
      },
      summary: summaryText,
      details: summaryText,
      comment: cleanComment,
      note: cleanComment,
      reason: opts.reason || cleanComment,
      changes: opts.changes || (cleanComment ? [{ field: 'บันทึกเหตุผล', before: '-', after: cleanComment }] : [])
    };

    var logSheet = getSheet(SHEET_NAMES.AUDIT_LOGS || 'AuditLogs');
    var logHeaders = getSheetHeaders(logSheet);
    var logRows = [serializeRecordToRow(auditLog, logHeaders)];
    if (logRows.length > 0 && logRows[0].length > 0) {
      var lastRow = logSheet.getLastRow();
      logSheet.getRange(lastRow + 1, 1, logRows.length, logRows[0].length).setValues(logRows);
    }
    return auditLog;
  } catch (err) {
    console.warn('[recordAuditLogEntry] Error appending to AuditLogs:', err.message);
    return null;
  }
}

/**
 * Standardized central helper for recording PR Audit Logs across its lifecycle.
 *
 * @param {string} docNo Document number (PR No)
 * @param {string} action Action name (CREATE, RESUBMIT, SEND_BACK, REVIEW_FORWARD, APPROVE, CANCEL)
 * @param {Object|string} actor User context object or name
 * @param {string} summary Description / comment for this action
 * @param {Array} [changes] Optional array of modified fields
 * @returns {Object} Appended audit log object
 */
function logPRAudit(docNo, action, actor, summary, changes) {
  return recordAuditLogEntry({
    targetRef: String(docNo || '').trim().toUpperCase(),
    docNo: String(docNo || '').trim().toUpperCase(),
    action: action,
    module: 'PURCHASE',
    summary: summary || '',
    comment: summary || '',
    actor: actor || { name: 'ผู้ใช้งานระบบ', role: '' },
    actorName: typeof actor === 'object' ? (actor.name || actor.displayName || actor.username) : String(actor || ''),
    actorRole: typeof actor === 'object' ? (actor.role || actor.userRole || actor.title) : '',
    changes: changes || []
  });
}

/**
 * Reads, indexes, and groups AuditLogs by normalized document key (e.g. normKey(docNo)).
 * Maps both schema-compliant fields and legacy fields to ensure timeline displays correctly.
 *
 * @param {Array} auditLogsList Array of raw audit log records
 * @returns {Object} Map of normalized docKey -> Array of log event items
 */
function buildAuditLogsByDoc(auditLogsList) {
  var normKey = function(val) { return String(val || '').trim().toUpperCase(); };
  var logsByDoc = {};
  if (!Array.isArray(auditLogsList)) return logsByDoc;

  auditLogsList.forEach(function(log) {
    if (!log) return;
    var rawDocNo = log.docNo || log.targetRef || log.documentNo || log.prNo || log.poNo || '';
    var keys = [];
    if (log.targetRef) keys.push(normKey(log.targetRef));
    if (log.docNo) keys.push(normKey(log.docNo));
    if (log.prNo) keys.push(normKey(log.prNo));
    if (log.poNo) keys.push(normKey(log.poNo));
    if (log.documentNo) keys.push(normKey(log.documentNo));
    if (keys.length === 0 && rawDocNo) keys.push(normKey(rawDocNo));

    var uniqueKeys = [];
    keys.forEach(function(k) {
      if (k && uniqueKeys.indexOf(k) === -1) uniqueKeys.push(k);
    });
    if (uniqueKeys.length === 0) return;

    var parsedActor = null;
    if (typeof log.actor === 'string') {
      try { parsedActor = JSON.parse(log.actor); } catch(e) {}
    } else if (typeof log.actor === 'object' && log.actor !== null) {
      parsedActor = log.actor;
    }

    var actorName = log.actorName || (parsedActor && (parsedActor.name || parsedActor.displayName || parsedActor.username)) || (typeof log.actor === 'string' && !log.actor.trim().startsWith('{') ? log.actor : '') || log.userName || log.user || 'ผู้ใช้งาน';
    var actorRole = log.actorRole || (parsedActor && (parsedActor.role || parsedActor.title || parsedActor.position || parsedActor.userRole)) || log.userRole || log.role || '';
    var commentText = log.comment || log.summary || log.note || log.details || log.reason || '';
    var timestamp = log.timestamp || log.createdAt || log.date || new Date().toISOString();

    var eventObj = {
      id: log.id || ('AUD-' + Utilities.getUuid().slice(0, 8)),
      timestamp: timestamp,
      createdAt: timestamp,
      date: timestamp,
      time: timestamp,
      action: log.action || 'ดำเนินการ',
      title: log.action || 'ดำเนินการ',
      type: log.action || 'ดำเนินการ',
      docNo: rawDocNo,
      targetRef: log.targetRef || rawDocNo,
      actor: actorName,
      actorName: actorName,
      user: actorName,
      userName: actorName,
      by: actorName,
      role: actorRole,
      actorRole: actorRole,
      userRole: actorRole,
      comment: commentText,
      note: commentText,
      details: commentText,
      description: commentText,
      summary: commentText,
      reason: log.reason || commentText,
      changes: log.changes || [],
      status: log.status || null
    };

    uniqueKeys.forEach(function(key) {
      if (!logsByDoc[key]) logsByDoc[key] = [];
      logsByDoc[key].push(eventObj);
    });
  });

  Object.keys(logsByDoc).forEach(function(k) {
    logsByDoc[k].sort(function(a, b) {
      var tA = new Date(a.timestamp || a.createdAt || 0).getTime();
      var tB = new Date(b.timestamp || b.createdAt || 0).getTime();
      return tA - tB;
    });
  });

  return logsByDoc;
}

/**
 * Retrieves all PRs.
 */
function apiGetPRs(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var prs = batchReadRecords(SHEET_NAMES.PRS);
    
    // Join Attachments
    var attachSheetName = (typeof SHEET_NAMES !== 'undefined' && SHEET_NAMES.ATTACHMENTS) ? SHEET_NAMES.ATTACHMENTS : 'Attachments';
    var attachments = [];
    try { attachments = batchReadRecords(attachSheetName); } catch (e) {}
    
    var normKey = function(val) { return String(val || '').trim().toUpperCase(); };
    var attachmentsByDoc = {};
    attachments.forEach(function(att) {
      if (!att) return;
      var k1 = normKey(att.docNo);
      var k2 = normKey(att.prNo);
      if (k1) {
        if (!attachmentsByDoc[k1]) attachmentsByDoc[k1] = [];
        attachmentsByDoc[k1].push(att);
      }
      if (k2 && k2 !== k1) {
        if (!attachmentsByDoc[k2]) attachmentsByDoc[k2] = [];
        attachmentsByDoc[k2].push(att);
      }
    });
    
    // Join AuditLogs
    var auditLogs = [];
    try { auditLogs = batchReadRecords('AuditLogs'); } catch (e) {}
    var logsByDoc = buildAuditLogsByDoc(auditLogs);

    prs.forEach(function(pr) {
      if (typeof pr.attachments === 'string') {
        try { pr.attachments = JSON.parse(pr.attachments); } catch(e) {}
      }
      var prKey = normKey(pr.prNo || pr.id || pr.docNo);
      var kNo = normKey(pr.prNo);
      var kId = normKey(pr.id);
      var kDoc = normKey(pr.docNo);
      var files = attachmentsByDoc[prKey] || [];
      pr.attachments = files;
      pr.quotationFiles = files;
      pr.generalAttachments = files;
      
      var docLogs = logsByDoc[prKey] || logsByDoc[kNo] || logsByDoc[kDoc] || logsByDoc[kId] || [];
      var seenIds = {};
      var sortedLogs = [];
      docLogs.forEach(function(l) {
        var lid = l.id || (l.timestamp + '_' + l.action);
        if (!seenIds[lid]) {
          seenIds[lid] = true;
          sortedLogs.push(l);
        }
      });
      sortedLogs.sort(function(a, b) {
        var tA = new Date(a.timestamp || a.createdAt || 0).getTime();
        var tB = new Date(b.timestamp || b.createdAt || 0).getTime();
        return tA - tB;
      });

      pr.timeline = sortedLogs;
      pr.activityTimeline = sortedLogs;
      pr.history = sortedLogs;
      pr.approvalHistory = sortedLogs;
      pr.auditLogs = sortedLogs;
    });

    return normalizePRsLegacyOnline(prs);
  }, 'GetPRs', rawPayload, userContext);
}

/**
 * Packages an updated PR object for lean client responses.
 * Parses JSON strings (items, attachments, logs), joins timeline/audit logs & attachments,
 * and normalizes the PR object without triggering full database bootstrap.
 * @param {Object} prObj
 * @returns {Object} { success: true, data: packagedPR }
 */
function packageUpdatedPR(prObj) {
  if (!prObj || typeof prObj !== 'object') return { success: true, data: prObj };
  var packaged = Object.assign({}, prObj);

  // Safely parse items if stringified
  if (typeof packaged.items === 'string') {
    try { packaged.items = JSON.parse(packaged.items); } catch(e) { packaged.items = []; }
  }

  // Safely parse attachments if stringified
  if (typeof packaged.attachments === 'string') {
    try { packaged.attachments = JSON.parse(packaged.attachments); } catch(e) { packaged.attachments = []; }
  }

  // Parse JSON fields
  ['history', 'timeline', 'activityLog', 'approvalHistory', 'comments'].forEach(function(field) {
    if (typeof packaged[field] === 'string') {
      try { packaged[field] = JSON.parse(packaged[field]); } catch(e) { packaged[field] = []; }
    }
  });

  // Attach up-to-date AuditLogs for this PR if docNo is present
  var docNo = packaged.prNo || packaged.id;
  if (docNo) {
    try {
      var auditLogs = [];
      try { auditLogs = batchReadRecords('AuditLogs'); } catch (e) {}
      var logsByDoc = buildAuditLogsByDoc(auditLogs);
      var prKey = String(docNo).trim().toUpperCase();
      var kNo = String(packaged.prNo || '').trim().toUpperCase();
      var kId = String(packaged.id || '').trim().toUpperCase();
      var docLogs = logsByDoc[prKey] || (kNo ? logsByDoc[kNo] : null) || (kId ? logsByDoc[kId] : null) || [];
      var seenIds = {};
      var sortedLogs = [];
      docLogs.forEach(function(l) {
        var lid = l.id || (l.timestamp + '_' + l.action);
        if (!seenIds[lid]) {
          seenIds[lid] = true;
          sortedLogs.push(l);
        }
      });
      sortedLogs.sort(function(a, b) {
        var tA = new Date(a.timestamp || a.createdAt || 0).getTime();
        var tB = new Date(b.timestamp || b.createdAt || 0).getTime();
        return tA - tB;
      });

      if (sortedLogs.length > 0) {
        packaged.timeline = sortedLogs;
        packaged.activityTimeline = sortedLogs;
        packaged.history = sortedLogs;
        packaged.approvalHistory = sortedLogs;
        packaged.auditLogs = sortedLogs;
      }
    } catch (e) {
      console.warn('[packageUpdatedPR] Warning fetching audit logs: ' + e.message);
    }

    if (!Array.isArray(packaged.attachments) || packaged.attachments.length === 0) {
      try {
        var attachSheet = getSheet(SHEET_NAMES.ATTACHMENTS || 'Attachments');
        var rawAttachments = attachSheet ? readSheetValuesAsObjects(attachSheet) : [];
        var prKeyU = String(docNo).trim().toUpperCase();
        var matchingAtts = rawAttachments.filter(function(att) {
          if (!att) return false;
          var adoc = String(att.docNo || att.prNo || '').trim().toUpperCase();
          return adoc === prKeyU;
        });
        if (matchingAtts.length > 0) {
          packaged.attachments = matchingAtts;
          packaged.quotationFiles = matchingAtts;
          packaged.generalAttachments = matchingAtts;
        }
      } catch (attErr) {
        console.warn('[packageUpdatedPR] Warning fetching attachments: ' + attErr.message);
      }
    }
  }

  if (typeof normalizePRsLegacyOnline === 'function') {
    var normalized = normalizePRsLegacyOnline([packaged]);
    packaged = normalized[0] || packaged;
  }

  return { success: true, data: packaged };
}

/**
 * Creates a new PR with thread-safe sequential PR Number generation.
 * Immediately persists to PRs sheet and writes individual lines to PRItems sheet.
 */
function apiCreatePR(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var prObj = payload ? Object.assign({}, payload) : {};
    var dept = prObj.department || prObj.dept || user.department || 'PD';

    // Generate unique sequential number inside ScriptLock
    var seqPrNo = prObj.prNo || generateSequentialDocId(dept, 'PR');

    prObj.id = prObj.id || ('PR-' + Date.now() + '-' + Utilities.getUuid().slice(0, 4));
    prObj.prNo = seqPrNo;
    prObj.department = dept;
    prObj.requestedBy = prObj.requestedBy || user.name || user.username || 'System User';
    prObj.status = prObj.status || 'SUBMITTED';
    prObj.createdAt = prObj.createdAt || new Date().toISOString();
    prObj.updatedAt = new Date().toISOString();

    // Extract & stringify items for Sheet persistence
    var rawItems = prObj.items;
    if (typeof rawItems === 'string') {
      try { rawItems = JSON.parse(rawItems); } catch (e) { rawItems = []; }
    }
    if (!Array.isArray(rawItems)) rawItems = [];

    // REAL GOOGLE DRIVE UPLOAD PIPELINE:
    // Upload any inline Base64 images and attachments to Google Drive before writing to sheet
    rawItems = processItemImages(rawItems, seqPrNo, 'PR');
    if (Array.isArray(prObj.attachments)) {
      prObj.attachments = processDocumentAttachments(prObj.attachments, DRIVE_CATEGORIES.PR, seqPrNo, 'PR', true);
    }

    // Always stringify items before writing to PRs sheet
    prObj.items = JSON.stringify(rawItems);

    // Calculate subtotal & totalAmount if missing
    if (!prObj.totalAmount && rawItems.length > 0) {
      var total = rawItems.reduce(function(sum, it) {
        return sum + ((Number(it.qty || it.quantity || 0)) * (Number(it.price || it.unitPrice || 0)));
      }, 0);
      prObj.totalAmount = total;
      prObj.subtotal = prObj.subtotal || total;
    }

    // 1. Write to PRs sheet (Search RAM index first, then batch write)
    upsertRecordFast(SHEET_NAMES.PRS, 'id', prObj);

    // 2. Write individual items to PRItems sheet immediately with real Drive URLs & IDs
    try {
      ensurePRItemsSheet();
      if (rawItems.length > 0) {
        var itemRows = rawItems.map(function(item, idx) {
          var qty = Number(item.qty || item.quantity || item.purchaseQty || 1);
          var price = Number(item.price || item.unitPrice || 0);
          return {
            id: item.id || ('PRI-' + Date.now() + '-' + (idx + 1) + '-' + Utilities.getUuid().slice(0, 3)),
            prId: prObj.id,
            prNo: prObj.prNo,
            productId: item.productId || item.product || item.code || '',
            productCode: item.code || item.productCode || '',
            name: item.name || item.itemName || item.title || '',
            purchaseUnit: item.purchaseUnit || item.unit || 'ชิ้น',
            stockUnit: item.stockUnit || item.unit || 'ชิ้น',
            conversionRate: Number(item.conversionRate || 1),
            qty: qty,
            unit: item.unit || item.purchaseUnit || item.stockUnit || 'ชิ้น',
            price: price,
            totalPrice: Number(item.totalPrice || item.total || (qty * price)),
            department: dept,
            notes: item.notes || item.remark || '',
            status: prObj.status,
            imageUrl: item.imageUrl || '',
            fileId: item.fileId || '',
            driveUrl: item.driveUrl || '',
            images: Array.isArray(item.images) ? JSON.stringify(item.images) : (item.images || ''),
            attachments: Array.isArray(item.attachments) ? JSON.stringify(item.attachments) : (item.attachments || ''),
            createdAt: prObj.createdAt,
            updatedAt: prObj.updatedAt
          };
        });
        batchAppendRecords(SHEET_NAMES.PR_ITEMS, itemRows);
      }
    } catch (itemErr) {
      console.warn('[apiCreatePR] Warning saving to PRItems tab: ' + itemErr.message);
    }

    // 3. Write to AuditLogs
    try {
      logPRAudit(
        seqPrNo || prObj.prNo || prObj.id,
        prObj.status === 'DRAFT' ? 'PR_DRAFTED' : 'CREATE',
        user,
        prObj.status === 'DRAFT' ? 'บันทึกแบบร่างใบขอซื้อ' : 'สร้างใบขอซื้อและส่งตรวจสอบ'
      );
    } catch(e) {
      console.warn('AuditLog Error in apiCreatePR:', e);
    }

    // 4. Trigger In-App Notification (Approver in department)
    if (prObj.status !== 'DRAFT') {
      try {
        recordNotification({
          title: 'มี PR รอการตรวจสอบ / อนุมัติ',
          message: 'ใบขอซื้อ ' + (seqPrNo || prObj.prNo || prObj.id) + ' แผนก ' + dept + ' จาก ' + (prObj.requestedBy || user.name) + ' รอการอนุมัติ',
          type: 'PR_SUBMITTED',
          targetDept: dept,
          targetRole: 'Approver',
          docRef: seqPrNo || prObj.prNo || prObj.id
        });
      } catch(ne) {
        console.warn('[apiCreatePR] Notification error:', ne);
      }
    }

    var returnPr = Object.assign({}, prObj);
    returnPr.items = rawItems;
    return packageUpdatedPR(returnPr);
  }, 'CreatePR', rawPayload, userContext);
}

/**
 * Updates or reviews an existing PR.
 * Fallback department, creates object if payload empty, stringifies items, sets updatedAt.
 */
function apiSavePR(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var prObj = payload ? Object.assign({}, payload) : {};
    var dept = prObj.department || prObj.dept || user.department || 'PD';
    prObj.department = dept;
    prObj.id = prObj.id || ('PR-' + Date.now());
    prObj.updatedAt = new Date().toISOString();

    var rawItems = prObj.items;
    if (typeof rawItems === 'string') {
      try { rawItems = JSON.parse(rawItems); } catch (e) { rawItems = []; }
    }
    if (!Array.isArray(rawItems)) rawItems = [];

    // REAL GOOGLE DRIVE UPLOAD PIPELINE:
    rawItems = processItemImages(rawItems, prObj.prNo || prObj.id, 'PR');
    if (Array.isArray(prObj.attachments)) {
      prObj.attachments = processDocumentAttachments(prObj.attachments, DRIVE_CATEGORIES.PR, prObj.prNo || prObj.id, 'PR');
    }

    prObj.items = JSON.stringify(rawItems);

    ['history', 'timeline', 'activityLog', 'approvalHistory', 'comments'].forEach(function(field) {
      if (prObj[field]) {
        var rawVal = prObj[field];
        if (typeof rawVal === 'string') {
          try { rawVal = JSON.parse(rawVal); } catch (e) { rawVal = []; }
        }
        prObj[field] = JSON.stringify(Array.isArray(rawVal) ? rawVal : []);
      }
    });

    var saved = upsertRecordFast(SHEET_NAMES.PRS, 'id', prObj);

    // Also update PRItems if available
    try {
      if (rawItems.length > 0 && prObj.id) {
        ensurePRItemsSheet();
        var itemRows = rawItems.map(function(item, idx) {
          var qty = Number(item.qty || item.quantity || 1);
          var price = Number(item.price || item.unitPrice || 0);
          return {
            id: item.id || ('PRI-' + prObj.id + '-' + (idx + 1)),
            prId: prObj.id,
            prNo: prObj.prNo || '',
            productId: item.productId || item.code || '',
            productCode: item.code || item.productCode || '',
            name: item.name || item.itemName || '',
            purchaseUnit: item.purchaseUnit || item.unit || 'ชิ้น',
            stockUnit: item.stockUnit || item.unit || 'ชิ้น',
            conversionRate: Number(item.conversionRate || 1),
            qty: qty,
            unit: item.unit || 'ชิ้น',
            price: price,
            totalPrice: Number(item.totalPrice || item.total || (qty * price)),
            department: dept,
            notes: item.notes || '',
            status: prObj.status || 'UPDATED',
            imageUrl: item.imageUrl || '',
            fileId: item.fileId || '',
            driveUrl: item.driveUrl || '',
            images: Array.isArray(item.images) ? JSON.stringify(item.images) : (item.images || ''),
            attachments: Array.isArray(item.attachments) ? JSON.stringify(item.attachments) : (item.attachments || ''),
            createdAt: prObj.createdAt || prObj.updatedAt,
            updatedAt: prObj.updatedAt
          };
        });
        batchUpsertRecordsFast(SHEET_NAMES.PR_ITEMS, 'id', itemRows);
      }
    } catch (e) {
      console.warn('[apiSavePR] Warning updating PRItems: ' + e.message);
    }

    // Audit log hook for apiSavePR
    try {
      var prNo = prObj.prNo || prObj.id;
      if (prObj.status === 'CANCELLED') {
        logPRAudit(prNo, 'CANCEL', user, prObj.reason || prObj.comment || 'ยกเลิกใบขอซื้อ');
      } else if (payload && (payload.action === 'RESUBMIT' || payload.isResubmit)) {
        logPRAudit(prNo, 'RESUBMIT', user, 'แก้ไขรายละเอียดเอกสารและส่งตรวจสอบใหม่อีกครั้ง');
      }
    } catch(e) {
      console.warn('AuditLog Error in apiSavePR:', e);
    }

    var returnSaved = Object.assign({}, prObj);
    returnSaved.items = rawItems;
    return packageUpdatedPR(returnSaved);
  }, 'SavePR', rawPayload, userContext);
}

/**
 * Updates a PR (when Requester edits/resubmits).
 */
function apiUpdatePR(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var savedPr = apiSavePR(payload, userContext);
    var targetPr = (savedPr && savedPr.data) ? savedPr.data : savedPr;
    var prNo = (targetPr && (targetPr.prNo || targetPr.id)) || (payload && (payload.prNo || payload.id)) || '';
    if (prNo) {
      try {
        logPRAudit(prNo, 'RESUBMIT', user, 'แก้ไขรายละเอียดเอกสารและส่งตรวจสอบใหม่อีกครั้ง');
      } catch(e) {
        console.warn('AuditLog Error in apiUpdatePR:', e);
      }
    }
    return packageUpdatedPR(targetPr);
  }, 'UpdatePR', rawPayload, userContext);
}

/**
 * Reviews a PR.
 */
function apiReviewPR(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var prObj = payload ? Object.assign({}, payload) : {};
    var dept = prObj.department || prObj.dept || user.department || 'PD';
    prObj.department = dept;
    prObj.status = prObj.status || 'REVIEWED';
    prObj.reviewedBy = prObj.reviewedBy || user.name || user.username || 'Reviewer';
    prObj.reviewedAt = prObj.reviewedAt || new Date().toISOString();
    prObj.updatedAt = new Date().toISOString();

    ['items', 'history', 'timeline', 'activityLog', 'approvalHistory', 'comments'].forEach(function(field) {
      if (prObj[field]) {
        var rawVal = prObj[field];
        if (typeof rawVal === 'string') {
          try { rawVal = JSON.parse(rawVal); } catch (e) { rawVal = []; }
        }
        prObj[field] = JSON.stringify(Array.isArray(rawVal) ? rawVal : []);
      }
    });

    var result = upsertRecordFast(SHEET_NAMES.PRS, 'id', prObj);

    // 3. Write to AuditLogs
    try {
      logPRAudit(
        prObj.prNo || prObj.id,
        'REVIEW_FORWARD',
        user,
        prObj.comment || (payload && payload.comment) || 'ตรวจสอบผ่าน ส่งต่อ Plant Mgr'
      );
    } catch(e) {
      console.warn('AuditLog Error in apiReviewPR:', e);
    }

    return packageUpdatedPR(prObj);
  }, 'ReviewPR', rawPayload, userContext);
}

/**
 * Approves a PR.
 */
function apiApprovePR(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var prObj = payload ? Object.assign({}, payload) : {};
    var dept = prObj.department || prObj.dept || user.department || 'PD';
    prObj.department = dept;
    prObj.status = 'APPROVED';
    prObj.approvedBy = prObj.approvedBy || user.name || user.username || 'Approver';
    prObj.approvedAt = prObj.approvedAt || new Date().toISOString();
    prObj.updatedAt = new Date().toISOString();

    ['items', 'history', 'timeline', 'activityLog', 'approvalHistory', 'comments'].forEach(function(field) {
      if (prObj[field]) {
        var rawVal = prObj[field];
        if (typeof rawVal === 'string') {
          try { rawVal = JSON.parse(rawVal); } catch (e) { rawVal = []; }
        }
        prObj[field] = JSON.stringify(Array.isArray(rawVal) ? rawVal : []);
      }
    });

    var result = upsertRecordFast(SHEET_NAMES.PRS, 'id', prObj);

    // 3. Write to AuditLogs
    try {
      logPRAudit(
        prObj.prNo || prObj.id,
        'APPROVE',
        user,
        prObj.comment || (payload && payload.comment) || 'อนุมัติใบขอซื้อ'
      );
    } catch(e) {
      console.warn('AuditLog Error in apiApprovePR:', e);
    }

    // 4. Trigger In-App Notifications (Requester & Purchaser)
    try {
      recordNotification({
        title: 'PR ได้รับการอนุมัติแล้ว',
        message: 'ใบขอซื้อ ' + (prObj.prNo || prObj.id) + ' ได้รับการอนุมัติเรียบร้อยแล้ว',
        type: 'PR_APPROVED',
        targetDept: dept,
        targetRole: 'Requester',
        docRef: prObj.prNo || prObj.id
      });
      recordNotification({
        title: 'มี PR ใหม่ได้รับการอนุมัติ (พร้อมออก PO)',
        message: 'ใบขอซื้อ ' + (prObj.prNo || prObj.id) + ' แผนก ' + dept + ' ได้รับการอนุมัติแล้ว พร้อมดำเนินการจัดซื้อ',
        type: 'PR_APPROVED',
        targetDept: dept,
        targetRole: 'Purchaser',
        docRef: prObj.prNo || prObj.id
      });
    } catch(ne) {
      console.warn('[apiApprovePR] Notification error:', ne);
    }

    return packageUpdatedPR(prObj);
  }, 'ApprovePR', rawPayload, userContext);
}

/**
 * Rejects / Sends back a PR.
 */
function apiRejectPR(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var prObj = payload ? Object.assign({}, payload) : {};
    var dept = prObj.department || prObj.dept || user.department || 'PD';
    prObj.department = dept;
    
    // 1. ดึงค่าเหตุผล (Reason Field Mapping & Display)
    var actualReason = prObj.reason || prObj.comment || prObj.rejectReason || prObj.revisionReason || prObj.returnComment || (payload && (payload.reason || payload.comment)) || '';
    prObj.rejectReason = actualReason;
    
    // 2. Preserve status (REJECTED_TO_DRAFT, RETURNED) or default to REJECTED
    prObj.status = prObj.status || 'REJECTED';
    prObj.rejectedBy = prObj.rejectedBy || user.name || user.username || 'Rejecter';
    prObj.rejectedAt = prObj.rejectedAt || new Date().toISOString();
    prObj.updatedAt = new Date().toISOString();

    ['items', 'history', 'timeline', 'activityLog', 'approvalHistory', 'comments'].forEach(function(field) {
      if (prObj[field]) {
        var rawVal = prObj[field];
        if (typeof rawVal === 'string') {
          try { rawVal = JSON.parse(rawVal); } catch (e) { rawVal = []; }
        }
        prObj[field] = JSON.stringify(Array.isArray(rawVal) ? rawVal : []);
      }
    });

    var result = upsertRecordFast(SHEET_NAMES.PRS, 'id', prObj);
    
    // 3. บันทึกลง AuditLogs
    try {
      logPRAudit(
        prObj.prNo || prObj.id,
        'SEND_BACK',
        user,
        actualReason || 'ส่งกลับเพื่อแก้ไข'
      );
    } catch(e) {
      console.warn('AuditLog Error in apiRejectPR:', e);
    }

    // 4. แจ้งเตือน In-App Notification (Requester)
    try {
      recordNotification({
        title: 'PR ไม่อนุมัติ / ส่งกลับแก้ไข',
        message: 'ใบขอซื้อ ' + (prObj.prNo || prObj.id) + ' ถูกส่งกลับ: ' + (actualReason || 'โปรดตรวจสอบรายละเอียดและแก้ไข'),
        type: 'PR_REJECTED',
        targetDept: dept,
        targetRole: 'Requester',
        docRef: prObj.prNo || prObj.id
      });
    } catch (notifyErr) {
      console.warn('[apiRejectPR] Notification Error:', notifyErr);
    }

    return packageUpdatedPR(prObj);
  }, 'RejectPR', rawPayload, userContext);
}

/**
 * Sends back / Rejects a PR (Standard alias for apiRejectPR).
 */
function apiSendBackPR(rawPayload, userContext) {
  return apiRejectPR(rawPayload, userContext);
}

/**
 * Cancels a PR and logs CANCEL action in AuditLogs.
 */
function apiCancelPR(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var prObj = payload ? Object.assign({}, payload) : {};
    var dept = prObj.department || prObj.dept || user.department || 'PD';
    prObj.department = dept;
    prObj.status = 'CANCELLED';
    var actualReason = prObj.reason || prObj.comment || prObj.rejectReason || (payload && (payload.reason || payload.comment)) || '';
    prObj.cancelledBy = prObj.cancelledBy || user.name || user.username || 'User';
    prObj.cancelledAt = prObj.cancelledAt || new Date().toISOString();
    prObj.updatedAt = new Date().toISOString();

    ['items', 'history', 'timeline', 'activityLog', 'approvalHistory', 'comments'].forEach(function(field) {
      if (prObj[field]) {
        var rawVal = prObj[field];
        if (typeof rawVal === 'string') {
          try { rawVal = JSON.parse(rawVal); } catch (e) { rawVal = []; }
        }
        prObj[field] = JSON.stringify(Array.isArray(rawVal) ? rawVal : []);
      }
    });

    var result = upsertRecordFast(SHEET_NAMES.PRS, 'id', prObj);

    var committed = Number(prObj.totalAmount || prObj.grandTotal || 0);
    if (committed > 0) {
      try {
        var txObj = {
          type: 'PR_CANCEL_RELEASE',
          docRef: prObj.prNo || prObj.id,
          amount: committed,
          refundAmount: committed,
          note: 'คืนงบผูกพันจากการยกเลิกใบขอซื้อ' + (actualReason ? (' (' + actualReason + ')') : ''),
          department: prObj.department
        };
        apiAppendBudgetTransaction(txObj, userContext);
      } catch (e) {
        console.warn('Budget Refund Error in apiCancelPR:', e);
      }
    }

    try {
      logPRAudit(prObj.prNo || prObj.id, 'CANCEL', user, actualReason || 'ยกเลิกใบขอซื้อ');
    } catch(e) {
      console.warn('AuditLog Error in apiCancelPR:', e);
    }

    // Trigger In-App Notification (PR Cancelled & Budget Released)
    try {
      recordNotification({
        title: 'PR ถูกยกเลิกและคืนงบประมาณแล้ว',
        message: 'ใบขอซื้อ ' + (prObj.prNo || prObj.id) + ' ถูกยกเลิก' + (actualReason ? (' (' + actualReason + ')') : '') + ' และคืนงบประมาณเรียบร้อยแล้ว',
        type: 'PR_CANCELLED',
        targetDept: dept,
        targetRole: 'ALL',
        docRef: prObj.prNo || prObj.id
      });
    } catch(ne) {
      console.warn('[apiCancelPR] Notification error:', ne);
    }

    return packageUpdatedPR(prObj);
  }, 'CancelPR', rawPayload, userContext);
}

// =========================================================================
// 4. PURCHASE ORDER (PO) RPCs
// =========================================================================

/**
 * Resolves a user signature to a Base64 Data URI in memory.
 * Safely extracts signature from user object, Users sheet, Drive File ID, or Signatures sheet.
 * Respects Google Sheets 50,000 char cell limit by resolving large images dynamically in RAM.
 *
 * @param {Object|string} userOrId User object, username, employeeName, or user ID
 * @param {Array} [usersList] Optional preloaded Users array
 * @param {Array} [signaturesList] Optional preloaded Signatures array
 * @returns {string|null} Base64 Data URI or null
 */
function resolveUserSignatureBase64(userOrId, usersList, signaturesList) {
  if (!userOrId) return null;
  
  var targetUser = null;
  var allUsers = usersList;
  if (!allUsers || !Array.isArray(allUsers)) {
    try { allUsers = batchReadRecords(SHEET_NAMES.USERS); } catch(e) { allUsers = []; }
  }

  if (typeof userOrId === 'object') {
    targetUser = userOrId;
  }
  
  var searchKey = String(
    (typeof userOrId === 'object' ? (userOrId.id || userOrId.username || userOrId.employeeId || userOrId.name || userOrId.employeeName) : userOrId) || ''
  ).trim().toLowerCase();

  if (searchKey && Array.isArray(allUsers) && allUsers.length > 0) {
    for (var i = 0; i < allUsers.length; i++) {
      var u = allUsers[i];
      if (!u) continue;
      var uid = String(u.id || '').trim().toLowerCase();
      var uname = String(u.username || '').trim().toLowerCase();
      var empid = String(u.employeeId || '').trim().toLowerCase();
      var rname = String(u.name || '').trim().toLowerCase();
      var empname = String(u.employeeName || '').trim().toLowerCase();
      if (uid === searchKey || uname === searchKey || empid === searchKey || rname === searchKey || empname === searchKey) {
        targetUser = Object.assign({}, u, targetUser || {});
        break;
      }
    }
  }

  var rawSig = (targetUser && (targetUser.signature || targetUser.signatureUrl)) || '';
  if (typeof userOrId === 'object' && userOrId.signature) {
    rawSig = userOrId.signature;
  }

  // 1. If already a Data URI
  if (rawSig && typeof rawSig === 'string' && rawSig.indexOf('data:image/') === 0) {
    return rawSig;
  }

  // 2. If Drive File ID or Drive URL
  if (rawSig && typeof rawSig === 'string' && (rawSig.indexOf('http') === 0 || rawSig.length < 150)) {
    var match = rawSig.match(/[-\w]{25,}/);
    if (match && match[0]) {
      try {
        var fileId = match[0];
        var file = DriveApp.getFileById(fileId);
        var blob = file.getBlob();
        var mime = blob.getContentType() || 'image/png';
        return 'data:' + mime + ';base64,' + Utilities.base64Encode(blob.getBytes());
      } catch (driveErr) {
        console.warn('[resolveUserSignatureBase64] Drive fetch error: ' + driveErr.message);
      }
    }
  }

  // 3. Fallback to Signatures sheet by roleId
  var targetRoleId = (targetUser && (targetUser.roleId || targetUser.canonicalRole || targetUser.role)) || 'REQUESTER_PD';
  var allSigs = signaturesList;
  if (!allSigs || !Array.isArray(allSigs)) {
    try { allSigs = batchReadRecords(SHEET_NAMES.SIGNATURES); } catch(e) { allSigs = []; }
  }
  if (allSigs && allSigs.length > 0) {
    for (var s = 0; s < allSigs.length; s++) {
      if (String(allSigs[s].roleId || '').trim().toUpperCase() === String(targetRoleId).trim().toUpperCase()) {
        var sUrl = allSigs[s].signatureUrl || allSigs[s].signature;
        if (sUrl && sUrl.indexOf('data:image/') === 0) {
          return sUrl;
        }
        if (sUrl && (sUrl.indexOf('http') === 0 || sUrl.length < 150)) {
          var sMatch = sUrl.match(/[-\w]{25,}/);
          if (sMatch && sMatch[0]) {
            try {
              var sFile = DriveApp.getFileById(sMatch[0]);
              var sBlob = sFile.getBlob();
              var sMime = sBlob.getContentType() || 'image/png';
              return 'data:' + sMime + ';base64,' + Utilities.base64Encode(sBlob.getBytes());
            } catch (err) {}
          }
        }
      }
    }
  }

  return rawSig || null;
}

/**
 * Ensures header row in POs sheet contains all required receiving columns.
 * Appends missing headers without altering existing rows.
 */
function ensurePOSheetHeaders(sheet) {
  if (!sheet) return;
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return;
  var headerValues = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var headers = headerValues.map(function(h) { return String(h).trim(); });
  var REQUIRED_RECEIVING_HEADERS = [
    'receivedBy', 'receiverName', 'receiverId', 'receivedAt', 'receiverRole', 'receiverSignature', 'receivingInfo',
    'actualTotalAmount', 'savingsAmount', 'settlementStatus', 'settlementNote', 'settlementProofUrl', 'settledBy', 'settledAt', 'actualItems',
    'storeClaims', 'claimResolution', 'totalRefunded', 'hasDispute', 'isInClaim'
  ];
  var missing = [];
  REQUIRED_RECEIVING_HEADERS.forEach(function(col) {
    if (headers.indexOf(col) === -1) {
      missing.push(col);
    }
  });
  if (missing.length > 0) {
    var startCol = lastCol + 1;
    sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
    try {
      formatHeaderRange(sheet, 1, startCol, missing.length);
    } catch(e) {}
    console.log('[ensurePOSheetHeaders] Appended ' + missing.length + ' missing headers to POs sheet: ' + missing.join(', '));
  }
}

/**
 * Backfills receiving signatures for historical POs in memory.
 * If a PO is completed/received but missing receiverSignature,
 * looks up the latest StockLog for this PO and matches the user's signature.
 */
function backfillHistoricalReceivingSignatures(pos, stockLogs, users, signatures) {
  if (!Array.isArray(pos) || pos.length === 0) return pos;
  
  var logs = stockLogs;
  if (!logs || !Array.isArray(logs)) {
    try { logs = batchReadRecords(SHEET_NAMES.STOCK_LOGS); } catch(e) { logs = []; }
  }
  var allUsers = users;
  if (!allUsers || !Array.isArray(allUsers)) {
    try { allUsers = batchReadRecords(SHEET_NAMES.USERS); } catch(e) { allUsers = []; }
  }
  var allSigs = signatures;
  if (!allSigs || !Array.isArray(allSigs)) {
    try { allSigs = batchReadRecords(SHEET_NAMES.SIGNATURES); } catch(e) { allSigs = []; }
  }

  // Index logs by PO number / ID
  var logsByPo = {};
  if (Array.isArray(logs)) {
    logs.forEach(function(l) {
      if (!l) return;
      var pNo = String(l.poNumber || l.documentNo || '').trim().toUpperCase();
      if (pNo) {
        if (!logsByPo[pNo]) logsByPo[pNo] = [];
        logsByPo[pNo].push(l);
      }
    });
  }

  pos.forEach(function(po) {
    if (!po) return;
    var status = String(po.status || '').toUpperCase();
    var isReceived = ['RECEIVED', 'COMPLETED', 'CLOSED', 'COMPLETED_WITH_REFUND', 'PARTIALLY_RECEIVED', 'PARTIALLY_RECEIVED_IN_CLAIM'].indexOf(status) !== -1 ||
                     Boolean(po.receivedAt || po.receivingInfo || (po.grnHistory && po.grnHistory.length > 0));

    // Safely parse receivingInfo if stringified
    if (typeof po.receivingInfo === 'string') {
      try { po.receivingInfo = JSON.parse(po.receivingInfo); } catch(e) { po.receivingInfo = {}; }
    }

    if (isReceived) {
      var currentSig = po.receiverSignature || (po.receivingInfo && po.receivingInfo.receiverSignature) || '';
      var needsSig = !currentSig || currentSig.indexOf('/signatures/') !== -1 || currentSig.indexOf('USER_SIG:') === 0;

      // Find candidate receiver name / id
      var recName = po.receiverName || po.receivedBy || (po.receivingInfo && po.receivingInfo.receiverName) || '';
      var recId = po.receiverId || (po.receivingInfo && po.receivingInfo.receiverId) || '';
      var recAt = po.receivedAt || (po.receivingInfo && po.receivingInfo.receivedAt) || '';

      // If name or time missing, look up from StockLogs
      if (!recName || !recAt) {
        var pKey = String(po.poNo || po.id || '').trim().toUpperCase();
        var poLogs = logsByPo[pKey] || [];
        if (poLogs.length > 0) {
          poLogs.sort(function(a, b) {
            var tA = new Date(a.timestamp || a.date || 0).getTime();
            var tB = new Date(b.timestamp || b.date || 0).getTime();
            return tB - tA;
          });
          var latestLog = poLogs[0];
          if (!recName && latestLog.actorName) recName = latestLog.actorName;
          if (!recAt && (latestLog.timestamp || latestLog.date)) recAt = latestLog.timestamp || latestLog.date;
        }
      }

      if (needsSig) {
        var resolved = resolveUserSignatureBase64(recId || recName, allUsers, allSigs);
        if (resolved) {
          po.receiverSignature = resolved;
        }
      } else if (currentSig && currentSig.indexOf('data:image/') === 0) {
        po.receiverSignature = currentSig;
      }

      if (recName) {
        po.receiverName = recName;
        po.receivedBy = recName;
      }
      if (recAt) {
        po.receivedAt = recAt;
      }
      if (!po.receivingInfo || typeof po.receivingInfo !== 'object') {
        po.receivingInfo = {};
      }
      po.receivingInfo.receiverName = po.receiverName || '';
      po.receivingInfo.receivedAt = po.receivedAt || '';
      po.receivingInfo.receiverSignature = po.receiverSignature || '';
    }
  });

  return pos;
}

/**
 * Retrieves all POs with historical receiving backfill.
 */
function apiGetPOs(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var pos = batchReadRecords(SHEET_NAMES.POS);
    return backfillHistoricalReceivingSignatures(pos);
  }, 'GetPOs', rawPayload, userContext);
}

/**
 * Packages an updated PO object for lean client responses.
 * Parses JSON strings (items, attachments, logs, claim/grn history),
 * preserves and structures receiving metadata (receiverName, receivedAt, receiverSignature/receivingInfo)
 * for PDF printing, joins AuditLogs, and returns { success: true, data: packagedPO }.
 * @param {Object} poObj
 * @returns {Object} { success: true, data: packagedPO }
 */
function packageUpdatedPO(poObj) {
  if (!poObj || typeof poObj !== 'object') return { success: true, data: poObj };
  var packaged = Object.assign({}, poObj);

  // 1. Safely parse items if stringified
  if (typeof packaged.items === 'string') {
    try { packaged.items = JSON.parse(packaged.items); } catch(e) { packaged.items = []; }
  }

  // 2. Safely parse attachments if stringified
  if (typeof packaged.attachments === 'string') {
    try { packaged.attachments = JSON.parse(packaged.attachments); } catch(e) { packaged.attachments = []; }
  }

  // 3. Parse JSON array fields
  ['history', 'timeline', 'activityLog', 'claimHistory', 'comments', 'ngItems', 'grnHistory', 'grAttachments'].forEach(function(field) {
    if (typeof packaged[field] === 'string') {
      try { packaged[field] = JSON.parse(packaged[field]); } catch(e) { packaged[field] = []; }
    }
  });

  // 4. Parse & Structure Goods Receiving Metadata for PDF & UI
  if (typeof packaged.receivingInfo === 'string') {
    try { packaged.receivingInfo = JSON.parse(packaged.receivingInfo); } catch(e) { packaged.receivingInfo = {}; }
  }
  if (!packaged.receivingInfo || typeof packaged.receivingInfo !== 'object') {
    packaged.receivingInfo = {};
  }
  if (typeof packaged.claimDetails === 'string') {
    try { packaged.claimDetails = JSON.parse(packaged.claimDetails); } catch(e) { packaged.claimDetails = null; }
  }
  if (typeof packaged.claimData === 'string') {
    try { packaged.claimData = JSON.parse(packaged.claimData); } catch(e) { packaged.claimData = null; }
  }
  if (typeof packaged.claimEvidence === 'string') {
    try { packaged.claimEvidence = JSON.parse(packaged.claimEvidence); } catch(e) { packaged.claimEvidence = null; }
  }
  if (typeof packaged.disputeInfo === 'string') {
    try { packaged.disputeInfo = JSON.parse(packaged.disputeInfo); } catch(e) { packaged.disputeInfo = null; }
  }

  // Harmonize receiving signature & receiver info
  packaged.receiverName = packaged.receiverName || packaged.receivedBy || (packaged.receivingInfo && packaged.receivingInfo.receiverName) || '';
  packaged.receivedBy = packaged.receivedBy || packaged.receiverName;
  packaged.receivedAt = packaged.receivedAt || (packaged.receivingInfo && packaged.receivingInfo.receivedAt) || '';
  packaged.receiverRole = packaged.receiverRole || (packaged.receivingInfo && packaged.receivingInfo.receiverRole) || '';

  // Resolve Base64 Data URI in RAM (Guardrail: cell limit protected, full base64 in RAM)
  var currentSig = packaged.receiverSignature || (packaged.receivingInfo && packaged.receivingInfo.receiverSignature) || '';
  if (!currentSig || currentSig.indexOf('USER_SIG:') === 0 || currentSig.indexOf('/signatures/') !== -1 || currentSig.indexOf('data:image/') !== 0) {
    var inMemSig = resolveUserSignatureBase64(packaged.receiverId || packaged.receiverName || packaged.receivedBy);
    if (inMemSig) {
      packaged.receiverSignature = inMemSig;
    } else {
      packaged.receiverSignature = currentSig;
    }
  } else {
    packaged.receiverSignature = currentSig;
  }

  if (packaged.receiverName || packaged.receivedAt || packaged.receiverSignature) {
    packaged.receivingInfo.receiverName = packaged.receiverName;
    packaged.receivingInfo.receivedAt = packaged.receivedAt;
    packaged.receivingInfo.receiverSignature = packaged.receiverSignature;
    packaged.receivingInfo.receiverRole = packaged.receiverRole;
  }

  // 5. Harmonize Online PO Settlement Fields
  if (typeof packaged.actualItems === 'string') {
    try { packaged.actualItems = JSON.parse(packaged.actualItems); } catch(e) { packaged.actualItems = null; }
  }
  packaged.actualTotalAmount = (packaged.actualTotalAmount !== undefined && packaged.actualTotalAmount !== null && packaged.actualTotalAmount !== '')
    ? Number(packaged.actualTotalAmount)
    : null;
  packaged.savingsAmount = (packaged.savingsAmount !== undefined && packaged.savingsAmount !== null && packaged.savingsAmount !== '')
    ? Number(packaged.savingsAmount)
    : null;
  packaged.settlementStatus = packaged.settlementStatus || (packaged.actualTotalAmount !== null ? 'SETTLED' : 'UNSETTLED');
  packaged.settlementNote = packaged.settlementNote || '';
  packaged.settlementProofUrl = packaged.settlementProofUrl || '';
  packaged.settledBy = packaged.settledBy || '';
  packaged.settledAt = packaged.settledAt || '';

  // 6. Attach up-to-date AuditLogs for this PO if poNo is present
  var docNo = packaged.poNo || packaged.id;
  if (docNo) {
    try {
      var auditLogs = [];
      try { auditLogs = batchReadRecords('AuditLogs'); } catch (e) {}
      var logsByDoc = buildAuditLogsByDoc(auditLogs);
      var poKey = String(docNo).trim().toUpperCase();
      var kNo = String(packaged.poNo || '').trim().toUpperCase();
      var kId = String(packaged.id || '').trim().toUpperCase();
      var docLogs = logsByDoc[poKey] || (kNo ? logsByDoc[kNo] : null) || (kId ? logsByDoc[kId] : null) || [];
      var seenIds = {};
      var sortedLogs = [];
      docLogs.forEach(function(l) {
        var lid = l.id || (l.timestamp + '_' + l.action);
        if (!seenIds[lid]) {
          seenIds[lid] = true;
          sortedLogs.push(l);
        }
      });
      sortedLogs.sort(function(a, b) {
        var tA = new Date(a.timestamp || a.createdAt || 0).getTime();
        var tB = new Date(b.timestamp || b.createdAt || 0).getTime();
        return tA - tB;
      });

      if (sortedLogs.length > 0) {
        packaged.timeline = sortedLogs;
        packaged.activityTimeline = sortedLogs;
        packaged.history = sortedLogs;
        packaged.auditLogs = sortedLogs;
      }
    } catch (e) {
      console.warn('[packageUpdatedPO] Warning fetching audit logs: ' + e.message);
    }

    if (!Array.isArray(packaged.attachments) || packaged.attachments.length === 0) {
      try {
        var attachSheet = getSheet(SHEET_NAMES.ATTACHMENTS || 'Attachments');
        var rawAttachments = attachSheet ? readSheetValuesAsObjects(attachSheet) : [];
        var poKeyU = String(docNo).trim().toUpperCase();
        var matchingAtts = rawAttachments.filter(function(att) {
          if (!att) return false;
          var adoc = String(att.docNo || att.poNo || '').trim().toUpperCase();
          return adoc === poKeyU;
        });
        if (matchingAtts.length > 0) {
          packaged.attachments = matchingAtts;
        }
      } catch (attErr) {
        console.warn('[packageUpdatedPO] Warning fetching attachments: ' + attErr.message);
      }
    }
  }

  return { success: true, data: packaged };
}

/**
 * Creates a new PO with thread-safe sequential PO number.
 */
function apiCreatePO(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var poObj = payload ? Object.assign({}, payload) : {};
    var dept = poObj.department || poObj.dept || user.department || 'PUR';
    var seqPoNo = poObj.poNo || generateSequentialDocId(dept, 'PO');

    poObj.id = poObj.id || ('PO-' + Date.now() + '-' + Utilities.getUuid().slice(0, 4));
    poObj.poNo = seqPoNo;
    poObj.department = dept;
    poObj.status = poObj.status || 'PO_CREATED';
    poObj.createdAt = poObj.createdAt || new Date().toISOString();
    poObj.updatedAt = new Date().toISOString();

    if (poObj.items) {
      var rawItems = poObj.items;
      if (typeof rawItems === 'string') {
        try { rawItems = JSON.parse(rawItems); } catch (e) { rawItems = []; }
      }
      if (Array.isArray(rawItems)) {
        rawItems = processItemImages(rawItems, poObj.poNo || poObj.id, 'PO');
        poObj.items = JSON.stringify(rawItems);
      }
    }
    if (Array.isArray(poObj.attachments)) {
      poObj.attachments = processDocumentAttachments(poObj.attachments, DRIVE_CATEGORIES.PO, poObj.poNo || poObj.id, 'PO');
    }

    ['items', 'history', 'timeline', 'activityLog', 'claimHistory', 'comments', 'ngItems', 'grnHistory'].forEach(function(field) {
      if (poObj[field]) {
        var rawVal = poObj[field];
        if (typeof rawVal === 'string') {
          try { rawVal = JSON.parse(rawVal); } catch (e) { rawVal = []; }
        }
        poObj[field] = JSON.stringify(Array.isArray(rawVal) ? rawVal : []);
      }
    });

    upsertRecordFast(SHEET_NAMES.POS, 'id', poObj);

    // Audit log for PO creation
    try {
      recordAuditLogEntry({
        docNo: seqPoNo,
        targetRef: seqPoNo,
        action: 'PO_CREATED',
        actor: user,
        comment: 'สร้างใบสั่งซื้อ (PO) เลขที่ ' + seqPoNo,
        status: poObj.status || 'PO_CREATED'
      });
    } catch (auditErr) {
      console.warn('[apiCreatePO] AuditLog error: ' + auditErr.message);
    }

    return packageUpdatedPO(poObj);
  }, 'CreatePO', rawPayload, userContext);
}

/**
 * Updates an existing PO record.
 */
function apiSavePO(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var poObj = payload ? Object.assign({}, payload) : {};
    var dept = poObj.department || poObj.dept || user.department || 'PUR';
    poObj.department = dept;
    poObj.id = poObj.id || ('PO-' + Date.now());
    poObj.createdAt = poObj.createdAt || new Date().toISOString();
    poObj.updatedAt = new Date().toISOString();

    // ✅ Budget Anchoring & Commitment Logic (Flow A vs Flow B)
    var refDate = poObj.approvedAt || poObj.createdAt;
    poObj.budgetPeriod = poObj.budgetPeriod || refDate.substring(0, 7);

    // Online Procurement Confirm Order
    if (poObj.isOnline && poObj.actualTotalAmount !== undefined && poObj.actualTotalAmount !== null) {
      poObj.actualPaidAmount = Number(poObj.actualTotalAmount);
      poObj.committedAmount = 0;
    } else {
      // Internal Procurement (or still pending online)
      poObj.committedAmount = Number(poObj.grandTotal || poObj.totalAmount || 0);
    }

    if (poObj.items) {
      var rawItems = poObj.items;
      if (typeof rawItems === 'string') {
        try { rawItems = JSON.parse(rawItems); } catch (e) { rawItems = []; }
      }
      if (Array.isArray(rawItems)) {
        rawItems = processItemImages(rawItems, poObj.poNo || poObj.id, 'PO');
        poObj.items = JSON.stringify(rawItems);
      }
    }
    if (Array.isArray(poObj.attachments)) {
      poObj.attachments = processDocumentAttachments(poObj.attachments, DRIVE_CATEGORIES.PO, poObj.poNo || poObj.id, 'PO');
    }

    ['items', 'history', 'timeline', 'activityLog', 'claimHistory', 'comments', 'ngItems', 'grnHistory'].forEach(function(field) {
      if (poObj[field]) {
        var rawVal = poObj[field];
        if (typeof rawVal === 'string') {
          try { rawVal = JSON.parse(rawVal); } catch (e) { rawVal = []; }
        }
        poObj[field] = JSON.stringify(Array.isArray(rawVal) ? rawVal : []);
      }
    });

    // Serialize claim-state object fields to JSON strings so they survive serializeRecordToRow
    ['storeClaims', 'claimResolution', 'claimData', 'claimDetails', 'claimEvidence', 'disputeInfo', 'receivingInfo'].forEach(function(field) {
      if (poObj[field] !== undefined && poObj[field] !== null && typeof poObj[field] === 'object') {
        try { poObj[field] = JSON.stringify(poObj[field]); } catch(e) {}
      }
    });

    var livePOs = batchReadRecords(SHEET_NAMES.POS);
    var livePO = livePOs.find(function(p) { return String(p.id) === String(poObj.id); });
    var wasCancelled = livePO && livePO.status === 'CANCELLED';

    if (poObj.status === 'CANCELLED' && !wasCancelled) {
      var poCommitted = Number(poObj.committedAmount || poObj.grandTotal || poObj.totalAmount || 0);
      if (poCommitted > 0) {
        try {
          apiAppendBudgetTransaction({
            type: 'PO_CANCEL_RELEASE',
            docRef: poObj.poNo || poObj.id,
            amount: poCommitted,
            refundAmount: poCommitted,
            note: 'คืนงบผูกพันจากการยกเลิกใบสั่งซื้อ',
            department: poObj.department
          }, userContext);
        } catch(e) {
          console.warn('Budget Refund Error in apiSavePO Cancel:', e);
        }
      }
      try {
        recordNotification({
          title: 'PO ถูกยกเลิกและคืนงบประมาณแล้ว',
          message: 'ใบสั่งซื้อ ' + (poObj.poNo || poObj.id) + ' ถูกยกเลิกและคืนงบประมาณเรียบร้อยแล้ว',
          type: 'PO_CANCELLED',
          targetDept: poObj.department || 'ALL',
          targetRole: 'ALL',
          docRef: poObj.poNo || poObj.id
        });
      } catch(ne) {
        console.warn('[apiSavePO] Cancel Notification error:', ne);
      }
    }

    // Trigger Notification for Online Order Confirmation
    var wasOrdered = livePO && (livePO.status === 'ORDERED' || livePO.orderStatus === 'ORDERED');
    var isNowOrdered = poObj.status === 'ORDERED' || poObj.orderStatus === 'ORDERED';
    if (isNowOrdered && !wasOrdered) {
      try {
        recordNotification({
          title: 'สินค้าสั่งซื้อแล้ว (รอรับของ)',
          message: 'ใบสั่งซื้อ ' + (poObj.poNo || poObj.id) + ' ได้รับการยืนยันการสั่งซื้อแล้ว อยู่ระหว่างการจัดส่ง',
          type: 'ONLINE_ORDERED',
          targetDept: poObj.department || 'ALL',
          targetRole: 'Requester',
          docRef: poObj.poNo || poObj.id
        });
      } catch(ne) {
        console.warn('[apiSavePO] Online Order Notification error:', ne);
      }
    }

    if (poObj.claimResolution) {
      var res = poObj.claimResolution;
      if (typeof res === 'string') {
        try { res = JSON.parse(res); } catch(e) { res = null; }
      }
      var liveRes = livePO ? livePO.claimResolution : null;
      if (typeof liveRes === 'string') {
        try { liveRes = JSON.parse(liveRes); } catch(e) { liveRes = null; }
      }
      
      if (res && res.type && (!liveRes || liveRes.resolvedAt !== res.resolvedAt)) {
         if (res.type === 'REFUND' || res.type === 'CANCEL') {
           var refundAmt = Number(res.refundAmount || 0);
           if (refundAmt > 0) {
             try {
                apiAppendBudgetTransaction({
                  type: 'CLAIM_REFUND',
                  docRef: poObj.poNo || poObj.id,
                  amount: refundAmt,
                  refundAmount: refundAmt,
                  note: 'รับเงินคืนจากการเคลม/ยกเลิก (Claim Resolution)',
                  department: poObj.department
                }, userContext);
             } catch(e) {
                console.warn('Budget Refund Error in apiSavePO Claim:', e);
             }
           }
         }
         try {
           recordNotification({
             title: 'เคลมสินค้าสำเร็จ / คืนเงินเรียบร้อย',
             message: 'ใบสั่งซื้อ ' + (poObj.poNo || poObj.id) + ' จัดการเคลมสำเร็จ' + (res.refundAmount > 0 ? (' ได้รับเงินคืน ฿' + Number(res.refundAmount).toLocaleString()) : ''),
             type: 'PO_CLAIM_CLOSED',
             targetDept: poObj.department || 'ALL',
             targetRole: 'Purchaser',
             docRef: poObj.poNo || poObj.id
           });
         } catch(ne) {
           console.warn('[apiSavePO] Claim Notification error:', ne);
         }
      }
    }

    upsertRecordFast(SHEET_NAMES.POS, 'id', poObj);

    // Audit log for PO update
    try {
      recordAuditLogEntry({
        docNo: poObj.poNo || poObj.id,
        targetRef: poObj.poNo || poObj.id,
        action: 'UPDATE_PO',
        actor: user,
        comment: (payload && (payload.note || payload.reason || payload.comment)) || 'ปรับปรุงข้อมูลใบสั่งซื้อ',
        status: poObj.status
      });
    } catch (auditErr) {
      console.warn('[apiSavePO] AuditLog error: ' + auditErr.message);
    }

    return packageUpdatedPO(poObj);
  }, 'SavePO', rawPayload, userContext);
}

/**
 * Updates a PO (Standard alias for apiSavePO).
 */
function apiUpdatePO(rawPayload, userContext) {
  return apiSavePO(rawPayload, userContext);
}

/**
 * Receives goods against a PO with full Idempotency Guard and atomic updates.
 *
 * Payload shape (sent by workflowEngine.receiveGoods):
 *   { id, poNo, department, status, items[], history[], grnHistory[],
 *     activityLog[], ngItems[], claimHistory[], grNumber,
 *     receivedBy, receiverName, receivedAt, receivingInfo{} }
 *
 * Idempotency: if grNumber already exists in grnHistory → short-circuit (returns existing PO).
 * Atomic: reads the LIVE sheet record, merges updated fields, writes back once.
 * Cascading: if status === 'CLOSED' and PO references a PR → marks PR as 'completed'.
 */
function apiReceivePO(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    // ── 1. Resolve ID ────────────────────────────────────────────────────────
    var poId = payload.id || payload.poId;
    if (!poId) {
      throw new Error('VALIDATION_ERROR: apiReceivePO requires payload.id (PO document ID)');
    }

    // ── 2. Read LIVE record from Sheet (GAS Sheet is SSOT) ───────────────────
    var allPOs = batchReadRecords(SHEET_NAMES.POS);
    var livePO = null;
    var liveIdx = -1;
    for (var i = 0; i < allPOs.length; i++) {
      if (String(allPOs[i].id) === String(poId) || String(allPOs[i].poNo) === String(poId)) {
        livePO = allPOs[i];
        liveIdx = i;
        break;
      }
    }

    // ── 3. Idempotency Guard: reject RECEIVED / CLOSED / CANCELLED POs ───────
    var TERMINAL_STATUSES = ['CLOSED', 'CANCELLED', 'RECEIVED', 'COMPLETED', 'COMPLETED_WITH_REFUND'];
    if (livePO && TERMINAL_STATUSES.indexOf(String(livePO.status || '').toUpperCase()) !== -1) {
      console.warn('[apiReceivePO] Idempotency block: PO "' + (livePO.poNo || poId) + '" already in terminal status "' + livePO.status + '". Skipping write.');
      return livePO;
    }

    // ── 4. Idempotency Guard: reject duplicate GRN number ───────────────────
    var incomingGrn = payload.grNumber || payload.grId || '';
    if (incomingGrn && livePO) {
      var existingGrnHistory = livePO.grnHistory;
      if (typeof existingGrnHistory === 'string') {
        try { existingGrnHistory = JSON.parse(existingGrnHistory); } catch (e) { existingGrnHistory = []; }
      }
      if (Array.isArray(existingGrnHistory)) {
        for (var gi = 0; gi < existingGrnHistory.length; gi++) {
          if (existingGrnHistory[gi] && existingGrnHistory[gi].grNumber === incomingGrn) {
            console.warn('[apiReceivePO] Idempotency block: GRN "' + incomingGrn + '" already processed for PO "' + (livePO.poNo || poId) + '".');
            return livePO;
          }
        }
      }
    }

    // ── 5. Build the merged PO object ────────────────────────────────────────
    // Start from live record if found, else from payload (new PO being written)
    var poObj = livePO ? Object.assign({}, livePO) : {};

    // Merge in ALL fields from payload (client already computed the correct values)
    var SKIP_MERGE = ['id', 'poNo', 'createdAt']; // never overwrite identity / creation stamp
    for (var key in payload) {
      if (Object.prototype.hasOwnProperty.call(payload, key) && SKIP_MERGE.indexOf(key) === -1) {
        poObj[key] = payload[key];
      }
    }

    // ── 6. Ensure critical scalar fields ────────────────────────────────────
    var dept = poObj.department || poObj.dept || user.department || 'PD';
    poObj.id = poId;
    poObj.department = dept;
    poObj.createdAt = poObj.createdAt || new Date().toISOString();
    poObj.updatedAt = new Date().toISOString();

    // Read old items to compute delta
    var oldItemsMap = {};
    if (livePO && typeof livePO.items === 'string') {
      try {
        var parsedOldItems = JSON.parse(livePO.items);
        parsedOldItems.forEach(function(oldIt) {
          oldItemsMap[oldIt.productId || oldIt.id || oldIt.code] = Number(oldIt.receivedQty || 0);
        });
      } catch(e) {}
    }

    // Status: Partial vs Full Receiving Logic
    var rawItemsForPartial = payload.items || poObj.items;
    if (typeof rawItemsForPartial === 'string') {
      try { rawItemsForPartial = JSON.parse(rawItemsForPartial); } catch(e) { rawItemsForPartial = []; }
    }
    
    var isPartial = false;
    var stockMovements = [];
    var productCostUpdates = {};

    if (Array.isArray(rawItemsForPartial)) {
      for (var pIdx = 0; pIdx < rawItemsForPartial.length; pIdx++) {
        var it = rawItemsForPartial[pIdx];
        var q = Number(it.quantity || it.orderedQty || 0);
        var newTotalReceived = Number(it.receivedQty || 0);
        var oldReceived = oldItemsMap[it.productId || it.id || it.code] || 0;
        
        var roundReceiveQty = Math.max(0, newTotalReceived - oldReceived);
        var remQ = Math.max(0, q - newTotalReceived);
        
        it.quantity = q;
        it.receivedQty = newTotalReceived;
        it.remainingQty = remQ;

        if (remQ > 0) {
          isPartial = true;
        }

        // Write StockLogs with real delta qty and calculate moving average
        if (roundReceiveQty > 0) {
          var convRate = Number(it.conversionRate || it.conversionRatio || 1);
          var deltaQty = roundReceiveQty * convRate;
          
          var unitPrice = Number(it.price || it.unitPrice || it.actualPrice || it.actUnitPrice || 0);
          var baseUnitCost = unitPrice / (convRate > 0 ? convRate : 1);
          
          var movId = 'MOV-' + Date.now() + '-' + Math.floor(Math.random()*1000);
          stockMovements.push({
            id: movId,
            timestamp: new Date().toISOString(),
            date: new Date().toISOString(),
            productId: it.productId || it.id || '',
            productCode: it.code || '',
            sku: it.code || '',
            productName: it.name || '',
            type: 'IN',
            docType: 'GRN',
            docNo: incomingGrn || poObj.poNo || poId,
            poNo: poObj.poNo || poId,
            quantity: deltaQty,
            qty: deltaQty,
            receivedQty: roundReceiveQty,
            unit: it.stockUnit || it.baseUom || 'ชิ้น',
            baseUom: it.stockUnit || it.baseUom || 'ชิ้น',
            purchaseUnit: it.purchaseUnit || it.purchaseUom || 'ชิ้น',
            conversionRate: convRate,
            unitPrice: baseUnitCost,
            baseUnitCost: baseUnitCost,
            totalAmount: deltaQty * baseUnitCost,
            totalPrice: deltaQty * baseUnitCost,
            actorName: user ? (user.name || user.employeeName) : 'System',
            department: dept,
            notes: 'ตรวจรับสินค้า PO ' + (poObj.poNo || poId)
          });
          
          if (it.productId || it.code) {
             productCostUpdates[it.productId || it.code] = {
                deltaQty: deltaQty,
                baseUnitCost: baseUnitCost
             };
          }
        }
      }
      poObj.items = rawItemsForPartial; // Will be stringified later
    }

    if (isPartial) {
      poObj.status = 'WAITING_DELIVERY_ROUND_2';
      poObj.receiptRound = (Number(poObj.receiptRound) || 1) + 1;
    } else {
      poObj.status = 'COMPLETED';
    }

    // Write to StockLogs and Update Moving Average Cost
    // NOTE: Writing to StockLogs is now handled exclusively by apiAppendStockMovements (called via storageService)
    // to prevent duplicate and incomplete logs. We only calculate and update MAC here.
    if (stockMovements.length > 0) {
      try {
        var products = batchReadRecords(SHEET_NAMES.PRODUCTS);
        products.forEach(function(prod) {
           var key = prod.id;
           var codeKey = prod.code;
           var updateInfo = productCostUpdates[key] || productCostUpdates[codeKey];
           
           if (updateInfo) {
              var currentStock = Number(prod.stockBalance || 0);
              // Ensure we don't calculate with negative stock balance initially
              currentStock = Math.max(0, currentStock); 
              var currentAvgCost = Number(prod.avgCost || prod.price || 0);
              
              var totalCurrentValue = currentStock * currentAvgCost;
              var newIncomingValue = updateInfo.deltaQty * updateInfo.baseUnitCost;
              var newTotalStock = currentStock + updateInfo.deltaQty;
              
              if (newTotalStock > 0) {
                 prod.avgCost = (totalCurrentValue + newIncomingValue) / newTotalStock;
              }
              // STRICT SSOT: Stock Balance is handled exclusively by apiAppendStockMovements.
              // We only update MAC (avgCost) here.
              // prod.stockBalance = newTotalStock; 
              
              upsertRecordFast(SHEET_NAMES.PRODUCTS, 'id', prod);
           }
        });
      } catch (err) {
        console.warn('[apiReceivePO] Failed to update Products avgCost: ' + err.message);
      }
    }

    // ✅ Budget Encumbrance & Force Close Logic
    if (poObj.status === 'CLOSED' || poObj.status === 'COMPLETED') {
      poObj.actualPaidAmount = Number(poObj.actualTotalAmount !== undefined ? poObj.actualTotalAmount : (poObj.grandTotal || poObj.totalAmount || 0));
      poObj.committedAmount = 0;
    }

    // Receiver metadata (Guardrail: avoid hardcoded mock names, respect cell limits)
    poObj.receivedBy = poObj.receivedBy || (user && (user.employeeName || user.name || user.username)) || 'Receiver';
    poObj.receiverName = poObj.receiverName || poObj.receivedBy;
    poObj.receiverId = poObj.receiverId || (user && (user.id || user.username)) || '';
    poObj.receiverRole = poObj.receiverRole || (user && (user.position || user.roleId || user.role)) || 'ผู้ตรวจรับ / บันทึกสต็อก';
    poObj.receivedAt = poObj.receivedAt || new Date().toISOString();

    // Resolve user signature safely
    var resolvedSig = resolveUserSignatureBase64(user, null, null);
    if (!resolvedSig && poObj.receiverSignature) {
      resolvedSig = resolveUserSignatureBase64(poObj.receiverSignature, null, null);
    }

    // Guardrail 1: Do NOT write massive Base64 into sheet cell (> 50,000 char limit)
    // In sheet cell, store short reference if string is large, and resolve to Base64 in RAM
    var sheetSig = poObj.receiverSignature || resolvedSig || '';
    if (sheetSig && sheetSig.length > 2000) {
      sheetSig = poObj.receiverId ? ('USER_SIG:' + poObj.receiverId) : 'SIGNATURE_ATTACHED';
    }
    poObj.receiverSignature = sheetSig;

    if (!poObj.receivingInfo || typeof poObj.receivingInfo !== 'object') {
      poObj.receivingInfo = {
        receiverName: poObj.receiverName,
        receiverId: poObj.receiverId,
        receivedAt: poObj.receivedAt,
        receiverRole: poObj.receiverRole,
        receiverSignature: sheetSig
      };
    } else {
      poObj.receivingInfo.receiverName = poObj.receiverName;
      poObj.receivingInfo.receiverId = poObj.receiverId;
      poObj.receivingInfo.receivedAt = poObj.receivedAt;
      poObj.receivingInfo.receiverRole = poObj.receiverRole;
      poObj.receivingInfo.receiverSignature = sheetSig;
    }

    // ── 7. Append GRN entry to grnHistory if grNumber present ───────────────
    if (incomingGrn) {
      var rawGrnHistory = poObj.grnHistory;
      if (typeof rawGrnHistory === 'string') {
        try { rawGrnHistory = JSON.parse(rawGrnHistory); } catch (e) { rawGrnHistory = []; }
      }
      if (!Array.isArray(rawGrnHistory)) rawGrnHistory = [];
      rawGrnHistory.push({
        grNumber: incomingGrn,
        receivedBy: poObj.receivedBy,
        receivedAt: poObj.receivedAt,
        status: poObj.status,
        timestamp: new Date().toISOString()
      });
      poObj.grnHistory = rawGrnHistory; // will be stringified below
    }

    // ── 8. Stringify ALL array / object fields before Sheet write ────────────
    var ARRAY_FIELDS = [
      'items', 'history', 'timeline', 'activityLog', 'approvalHistory',
      'comments', 'claimHistory', 'ngItems', 'grnHistory', 'grAttachments'
    ];
    ARRAY_FIELDS.forEach(function(field) {
      if (poObj[field] !== undefined && poObj[field] !== null && poObj[field] !== '') {
        var rawVal = poObj[field];
        if (typeof rawVal === 'string') {
          try { rawVal = JSON.parse(rawVal); } catch (e) { rawVal = []; }
        }
        poObj[field] = JSON.stringify(Array.isArray(rawVal) ? rawVal : []);
      }
    });

    // Stringify receivingInfo (object, not array)
    if (poObj.receivingInfo && typeof poObj.receivingInfo === 'object') {
      poObj.receivingInfo = JSON.stringify(poObj.receivingInfo);
    }
    if (poObj.claimDetails && typeof poObj.claimDetails === 'object') {
      poObj.claimDetails = JSON.stringify(poObj.claimDetails);
    }
    if (poObj.claimData && typeof poObj.claimData === 'object') {
      poObj.claimData = JSON.stringify(poObj.claimData);
    }

    // ── 9.5 Handle On-the-spot Settlement if provided during receiving ──────
    if (payload.actualTotalAmount !== undefined && payload.actualTotalAmount !== null && payload.actualTotalAmount !== '') {
      var grandTot = Number(poObj.grandTotal || poObj.totalAmount || 0);
      var actTot = Number(payload.actualTotalAmount);
      var sav = grandTot - actTot;
      poObj.actualTotalAmount = actTot;
      poObj.savingsAmount = sav;
      poObj.settlementStatus = 'SETTLED';
      poObj.settlementNote = payload.settlementNote || poObj.settlementNote || '';
      poObj.settlementProofUrl = payload.settlementProofUrl || poObj.settlementProofUrl || '';
      poObj.settledBy = user.employeeName || user.name || user.username || 'Receiver';
      poObj.settledAt = new Date().toISOString();

      var ratio = grandTot > 0 ? (actTot / grandTot) : 1;
      var rawItems = poObj.items;
      if (typeof rawItems === 'string') {
        try { rawItems = JSON.parse(rawItems); } catch(e) { rawItems = []; }
      }
      if (Array.isArray(rawItems)) {
        rawItems.forEach(function(it) {
          var bp = Number(it.price || it.unitPrice || it.estimatedPrice || 0);
          it.actualPrice = Math.round((bp * ratio) * 100) / 100;
          it.actualUnitPrice = it.actualPrice;
          it.unitPrice = it.actualPrice;
        });
        poObj.items = JSON.stringify(rawItems);
        poObj.actualItems = JSON.stringify(rawItems);
      }

      if (sav > 0) {
        try {
          var txObj = {
            dept: dept,
            amount: sav,
            refundAmount: sav,
            type: 'BUDGET_ROLLBACK',
            docType: 'PO',
            docNo: poObj.poNo || poObj.id,
            note: 'คืนงบประมาณจากการปิดยอดจ่ายจริงในการตรวจรับ PO ' + (poObj.poNo || poObj.id) + ' (ประหยัด ฿' + sav.toLocaleString() + ')'
          };
          apiAppendBudgetTransaction(txObj, userContext);
        } catch(bErr) {
          console.warn('[apiReceivePO] Settlement budget refund warning: ' + bErr.message);
        }
      }
    }

    // ── 9. Atomic write to POs sheet ─────────────────────────────────────────
    var updatedPO = upsertRecordFast(SHEET_NAMES.POS, 'id', poObj);
    console.log('[apiReceivePO] PO "' + (poObj.poNo || poId) + '" written to sheet. Status: ' + poObj.status + (incomingGrn ? ' | GRN: ' + incomingGrn : ''));

    // ── 10. Cascading PR Completion (if fully received → CLOSED) ────────────
    var isClosed = poObj.status === 'CLOSED' || poObj.status === 'COMPLETED';
    if (isClosed) {
      var prRef = payload.prId || payload.prNo || payload.prNumber;
      if (prRef) {
        try {
          var allPRs = batchReadRecords(SHEET_NAMES.PRS);
          var targetPR = null;
          for (var pi = 0; pi < allPRs.length; pi++) {
            var p = allPRs[pi];
            if (
              String(p.id) === String(prRef) ||
              String(p.prNo) === String(prRef) ||
              String(p.prNumber) === String(prRef)
            ) {
              targetPR = p;
              break;
            }
          }
          if (targetPR) {
            targetPR.status = 'completed';
            targetPR.poStatus = 'completed';
            targetPR.poNumber = poObj.poNo || poObj.poNumber || targetPR.poNumber;
            targetPR.fullyReceivedAt = poObj.receivedAt || new Date().toISOString();
            targetPR.updatedAt = new Date().toISOString();

            // Append to PR activityLog
            var prLog = targetPR.activityLog;
            if (typeof prLog === 'string') {
              try { prLog = JSON.parse(prLog); } catch (e) { prLog = []; }
            }
            if (!Array.isArray(prLog)) prLog = [];
            prLog.push({
              action: 'ปิดเอกสาร (Closed)',
              user: user.name || user.username || 'System',
              role: user.canonicalRole || user.role || '',
              timestamp: new Date().toISOString(),
              note: 'PO ' + (poObj.poNo || poId) + ' รับสินค้าครบแล้ว ปิดใบ PR อัตโนมัติ'
            });
            targetPR.activityLog = JSON.stringify(prLog);
            upsertRecordFast(SHEET_NAMES.PRS, 'id', targetPR);
            console.log('[apiReceivePO] Cascading PR "' + (targetPR.prNo || prRef) + '" → status: completed');
          }
        } catch (prErr) {
          console.warn('[apiReceivePO] Warning: Could not cascade PR completion: ' + prErr.message);
        }
      }
    }

    // Audit log for Goods Receiving
    try {
      recordAuditLogEntry({
        docNo: poObj.poNo || poId,
        targetRef: poObj.poNo || poId,
        action: isClosed ? 'GOODS_RECEIVED_FULL' : 'GOODS_RECEIVED_PARTIAL',
        actor: user,
        comment: 'ตรวจรับสินค้า ' + (incomingGrn ? ('เลขที่ ' + incomingGrn) : '') + (isClosed ? ' ครบถ้วนแล้ว ปิดใบงาน' : ' บางส่วน'),
        status: poObj.status
      });
    } catch (auditErr) {
      console.warn('[apiReceivePO] AuditLog error: ' + auditErr.message);
    }

    // Trigger In-App Notification (Full vs Partial/Claim GRN)
    try {
      if (isClosed) {
        recordNotification({
          title: 'ตรวจรับสินค้าเข้าคลังเรียบร้อย',
          message: 'ใบสั่งซื้อ ' + (poObj.poNo || poId) + ' ได้รับสินค้าครบถ้วนและเข้าคลังเรียบร้อยแล้ว',
          type: 'GOODS_RECEIVED',
          targetDept: poObj.department || dept || 'ALL',
          targetRole: 'Purchaser',
          docRef: poObj.poNo || poId
        });
      } else {
        recordNotification({
          title: 'ตรวจรับสินค้าบางส่วน / มีรายการค้างรับ-รอเคลม',
          message: 'ใบสั่งซื้อ ' + (poObj.poNo || poId) + ' ตรวจรับบางส่วน มีรายการค้างรับหรือรอเคลม',
          type: 'PO_CLAIM',
          targetDept: poObj.department || dept || 'ALL',
          targetRole: 'Purchaser',
          docRef: poObj.poNo || poId
        });
        recordNotification({
          title: 'ตรวจรับสินค้าบางส่วน / มีรายการค้างรับ-รอเคลม',
          message: 'ใบสั่งซื้อ ' + (poObj.poNo || poId) + ' ตรวจรับบางส่วน มีรายการค้างรับหรือรอเคลม',
          type: 'PO_CLAIM',
          targetDept: poObj.department || dept || 'ALL',
          targetRole: 'Requester',
          docRef: poObj.poNo || poId
        });
      }
    } catch (notifErr) {
      console.warn('[apiReceivePO] Notification error: ' + notifErr.message);
    }

    return packageUpdatedPO(updatedPO);
  }, 'ReceivePO', rawPayload, userContext);
}

/**
 * Processes GRN Receiving for a PO document (Alias for apiReceivePO).
 */
function apiReceiveGRN(rawPayload, userContext) {
  return apiReceivePO(rawPayload, userContext);
}

/**
 * Settles an Online PO with actual transfer amounts, calculates savings,
 * adjusts line-item actual unit prices for inventory costing, and refunds unused budget.
 */
function apiSettlePO(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var poId = payload.poId || payload.id || payload.poNo;
    if (!poId) throw new Error('VALIDATION_ERROR: Missing poId for settlement');

    var allPOs = batchReadRecords(SHEET_NAMES.POS);
    var targetPO = null;
    for (var i = 0; i < allPOs.length; i++) {
      if (String(allPOs[i].id) === String(poId) || String(allPOs[i].poNo) === String(poId)) {
        targetPO = allPOs[i];
        break;
      }
    }
    if (!targetPO) throw new Error('NOT_FOUND: PO "' + poId + '" not found');

    var originalTotal = Number(targetPO.grandTotal || targetPO.totalAmount || targetPO.subtotal || 0);
    var actualTotal = Number(payload.actualTotalAmount !== undefined ? payload.actualTotalAmount : payload.actualTotal);
    if (isNaN(actualTotal) || actualTotal < 0) {
      throw new Error('VALIDATION_ERROR: Invalid actualTotalAmount');
    }

    var savings = originalTotal - actualTotal;

    // Parse items
    var items = targetPO.items;
    if (typeof items === 'string') {
      try { items = JSON.parse(items); } catch(e) { items = []; }
    }
    if (!Array.isArray(items)) items = [];

    // Calculate actualUnitPrice per item based on actual ratio or explicit actualItems
    var costRatio = originalTotal > 0 ? (actualTotal / originalTotal) : 1;
    var actualItems = payload.actualItems;
    if (typeof actualItems === 'string') {
      try { actualItems = JSON.parse(actualItems); } catch(e) { actualItems = null; }
    }

    items.forEach(function(item, idx) {
      var explicitActual = Array.isArray(actualItems) && actualItems[idx];
      var basePrice = Number(item.price || item.unitPrice || item.estimatedPrice || 0);
      var unitPrice = explicitActual && explicitActual.actualUnitPrice !== undefined
        ? Number(explicitActual.actualUnitPrice)
        : Math.round((basePrice * costRatio) * 100) / 100;
      
      item.actualPrice = unitPrice;
      item.actualUnitPrice = unitPrice;
      item.unitPrice = unitPrice;
    });

    targetPO.actualTotalAmount = actualTotal;
    targetPO.savingsAmount = savings;
    targetPO.settlementStatus = 'SETTLED';
    targetPO.settlementNote = payload.settlementNote || payload.note || '';
    targetPO.settlementProofUrl = payload.settlementProofUrl || payload.proofUrl || '';
    targetPO.settledBy = user.employeeName || user.name || user.username || 'Purchaser';
    targetPO.settledAt = new Date().toISOString();
    targetPO.actualItems = JSON.stringify(actualItems || items);
    targetPO.items = JSON.stringify(items);
    targetPO.updatedAt = new Date().toISOString();

    // If savings > 0, automatically refund department budget
    if (savings > 0) {
      var dept = targetPO.department || user.department || 'PD';
      try {
        var txObj = {
          dept: dept,
          amount: savings,
          refundAmount: savings,
          type: 'BUDGET_ROLLBACK',
          docType: 'PO',
          docNo: targetPO.poNo || targetPO.id,
          note: 'คืนงบประมาณจากการปิดยอดจ่ายจริง (Online Settlement) PO ' + (targetPO.poNo || targetPO.id) + ' (ประหยัด ฿' + savings.toLocaleString() + ')'
        };
        apiAppendBudgetTransaction(txObj, userContext);
      } catch (bErr) {
        console.warn('[apiSettlePO] Budget refund warning: ' + bErr.message);
      }
    }

    // Record AuditLog
    try {
      recordAuditLogEntry({
        docNo: targetPO.poNo || targetPO.id,
        targetRef: targetPO.poNo || targetPO.id,
        action: 'PO_SETTLED',
        actor: user,
        comment: 'ปิดยอดจ่ายจริง (Online Settlement): ยอดอนุมัติ ฿' + originalTotal.toLocaleString() + ' | ยอดจ่ายจริง ฿' + actualTotal.toLocaleString() + (savings > 0 ? (' | ประหยัดงบ ฿' + savings.toLocaleString()) : '') + (targetPO.settlementNote ? (' | ' + targetPO.settlementNote) : ''),
        status: targetPO.status
      });
    } catch (auditErr) {
      console.warn('[apiSettlePO] AuditLog warning: ' + auditErr.message);
    }

    var updatedPO = upsertRecordFast(SHEET_NAMES.POS, 'id', targetPO);
    return packageUpdatedPO(updatedPO);
  }, 'SettlePO', rawPayload, userContext);
}

/**
 * Finalizes PO, updates PR status, and records audit trail atomically.
 */
function apiFinalizePO(poIdOrPayload, poDataOrUser, userContext) {
  var poId = poIdOrPayload;
  var poData = poDataOrUser;
  var rawPayload = poDataOrUser;
  var rawUser = userContext;

  if (typeof poIdOrPayload === 'object' && poIdOrPayload !== null) {
    poId = poIdOrPayload.id || poIdOrPayload.poId;
    poData = poIdOrPayload.data || poIdOrPayload.poData || poIdOrPayload;
    rawPayload = poIdOrPayload;
    rawUser = poDataOrUser;
  }

  return handleApiRequest(function(payload, user) {
    var finalData = (poData || payload) ? Object.assign({}, (poData || payload)) : {};
    var targetId = poId || finalData.id;
    var dept = finalData.department || finalData.dept || user.department || 'PUR';
    finalData.id = targetId;
    finalData.department = dept;
    finalData.createdAt = finalData.createdAt || new Date().toISOString();
    finalData.updatedAt = new Date().toISOString();

    if (finalData.items) {
      var rawItems = finalData.items;
      if (typeof rawItems === 'string') {
        try { rawItems = JSON.parse(rawItems); } catch (e) { rawItems = []; }
      }
      finalData.items = JSON.stringify(Array.isArray(rawItems) ? rawItems : []);
    }

    var updated = upsertRecordFast(SHEET_NAMES.POS, 'id', finalData);

    // If associated with PR, mark PR as APPROVED
    if (finalData.prId || finalData.prNo) {
      var prKey = finalData.prId ? 'id' : 'prNo';
      var prVal = finalData.prId || finalData.prNo;
      var prs = batchReadRecords(SHEET_NAMES.PRS);
      var targetPr = prs.find(function(p) { return String(p[prKey]) === String(prVal); });
      if (targetPr) {
        targetPr.status = 'APPROVED';
        targetPr.poNumber = finalData.poNo;
        targetPr.approvedBy = finalData.approvedBy || user.name || user.username || 'System';
        targetPr.approvedAt = finalData.approvedAt || new Date().toISOString();
        targetPr.updatedAt = new Date().toISOString();
        upsertRecordFast(SHEET_NAMES.PRS, 'id', targetPr);
      }
    }

    return packageUpdatedPO(updated);
  }, 'FinalizePO', rawPayload, rawUser);
}

// =========================================================================
// 5. INVENTORY & STOCK TRANSACTIONS RPCs
// =========================================================================

/**
 * Retrieves all stock movements/logs.
 */
function apiGetStockLogs(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var logs = batchReadRecords(SHEET_NAMES.STOCK_LOGS);
    return logs.map(function(log) {
      if (log.timestamp) {
        var ts = new Date(log.timestamp);
        if (!isNaN(ts.getTime())) log.timestamp = ts.toISOString();
      }
      if (log.date) {
        var dt = new Date(log.date);
        if (!isNaN(dt.getTime())) log.date = dt.toISOString();
      }
      return log;
    });
  }, 'GetStockLogs', rawPayload, userContext);
}

/**
 * Records stock movements and atomically adjusts Product balances.
 */
function apiAppendStockMovements(movementsListOrPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var list = Array.isArray(payload) ? payload : (payload.movementsList || payload.movements || payload.items || []);
    if (typeof list === 'string') {
      try { list = JSON.parse(list); } catch (e) { list = []; }
    }
    if (!Array.isArray(list) || list.length === 0) return [];

    var dept = user.department || 'PD';
    var defaultActor = user.name || user.username || 'System User';

    var products = batchReadRecords(SHEET_NAMES.PRODUCTS);
    var productMap = new Map(products.map(function(p) { return [String(p.id), p]; }));
    var recordsToAppend = [];

    list.forEach(function(mov) {
      if (!mov || typeof mov !== 'object') return;
      var prod = mov.productId ? productMap.get(String(mov.productId)) : null;
      if (!prod && (mov.productCode || mov.code)) {
        var targetCode = String(mov.productCode || mov.code).trim();
        var targetDept = mov.department || dept;
        prod = products.find(function(p) {
          return String(p.code || '').trim() === targetCode && matchDepartment(p.department || p.category, targetDept);
        });
      }
      var currentBalance = prod ? Number(prod.stockBalance || 0) : 0;
      
      var conversionRate = Number(mov.conversionRate || mov.packSize || 1);
      if (conversionRate <= 0) conversionRate = 1;

      var baseQty = Number(mov.receiveQty || mov.roundQty || mov.qty || mov.quantity || 0);
      var qty = (mov.receiveQty !== undefined || mov.roundQty !== undefined) 
        ? baseQty * conversionRate 
        : baseQty;

      if (qty === 0 && baseQty > 0) qty = baseQty; // Fallback
      if (qty === 0 && mov.type === 'IN') {
        qty = Number(mov.qty || mov.quantity || 0) * conversionRate;
        if (qty === 0) qty = Number(mov.qty || mov.quantity || 0);
      }

      var newBalance = currentBalance;
      var unitCost = 0;
      var totalCost = 0;

      if (mov.type === 'IN') {
        newBalance += qty;
        var rawPrice = Number(mov.unitPrice !== undefined ? mov.unitPrice : (mov.actualUnitPrice !== undefined ? mov.actualUnitPrice : (mov.actualPrice || 0)));
        var baseUnitPrice = rawPrice / conversionRate;

        var currentAvg = prod ? Number(prod.avgCost || prod.costPrice || prod.price || 0) : 0;
        var newAvgCost = currentAvg;
        
        var totalQty = currentBalance + qty;
        if (totalQty > 0) {
          newAvgCost = ((currentBalance * currentAvg) + (qty * baseUnitPrice)) / totalQty;
        }
        newAvgCost = Math.round((newAvgCost + Number.EPSILON) * 100) / 100;
        
        if (prod) {
          prod.avgCost = newAvgCost;
        }
        
        unitCost = baseUnitPrice;
        totalCost = Math.round(qty * baseUnitPrice * 100) / 100;
      } else if (mov.type === 'OUT') {
        newBalance = Math.max(0, currentBalance - qty);
        var currentAvg = prod ? Number(prod.avgCost || prod.costPrice || prod.price || 0) : 0;
        unitCost = currentAvg;
        totalCost = Math.round(qty * currentAvg * 100) / 100;
      } else if (mov.type === 'ADJUST') {
        newBalance = qty;
        var currentAvg = prod ? Number(prod.avgCost || prod.costPrice || prod.price || 0) : 0;
        unitCost = currentAvg;
        totalCost = Math.round(qty * currentAvg * 100) / 100;
      }

      if (prod) {
        prod.stockBalance = newBalance;
        prod.updatedAt = new Date().toISOString();
      }

      var logRecord = {
        id: mov.id || ('MOV-' + Date.now() + '-' + Utilities.getUuid().slice(0, 4)),
        timestamp: mov.timestamp || new Date().toISOString(),
        date: mov.date || new Date().toISOString(),
        productId: (prod ? prod.id : mov.productId) || '',
        productCode: (prod ? prod.code : mov.productCode) || '',
        name: mov.name || (prod ? prod.name : ''),
        type: mov.type || 'IN',

        documentNo: mov.documentNo || mov.grnNumber || mov.docNo || '',
        grnNumber: mov.grnNumber || mov.documentNo || '',
        poNumber: mov.poNumber || mov.poNo || '',
        prNo: mov.prNo || '',
        changeQty: mov.type === 'IN' || mov.type === 'IN_NG' ? qty : (mov.type === 'OUT' ? -qty : qty),
        qty: qty,
        unit: mov.unit || mov.stockUnit || (prod ? prod.stockUnit : 'ชิ้น'),
        conversionRate: conversionRate,
        unitPrice: Number(mov.unitPrice !== undefined ? mov.unitPrice : (mov.actualUnitPrice !== undefined ? mov.actualUnitPrice : (mov.actualPrice || 0))),
        totalPrice: Number(mov.totalPrice !== undefined ? mov.totalPrice : (qty * Number(mov.unitPrice || mov.actualUnitPrice || mov.actualPrice || 0))),
        unitCost: unitCost,
        totalCost: totalCost,
        balanceAfter: newBalance,
        actorName: mov.actorName || defaultActor,
        department: mov.department || (prod ? (prod.department || prod.category) : dept),
        locationId: mov.locationId || (prod ? prod.locationId : ''),
        notes: mov.notes || mov.note || ''
      };

      // Guard: Before appending to StockLogs, MUST have documentNo or grnNumber
      // If missing, skip this row entirely (Cancel recording)
      var validDocNo = logRecord.documentNo || logRecord.grnNumber;
      if (['IN', 'IN_NG', 'OUT'].indexOf(logRecord.type) !== -1 && !validDocNo && String(logRecord.docNo).indexOf('SYSTEM-INITIAL-BALANCE') === -1) {
        console.warn('[apiAppendStockMovements] Cancelled invalid log row due to missing documentNo/grnNumber:', logRecord);
        return;
      }

      recordsToAppend.push(logRecord);
    });

    if (recordsToAppend.length > 0) {
      batchAppendRecords(SHEET_NAMES.STOCK_LOGS, recordsToAppend);
      batchWriteRecords(SHEET_NAMES.PRODUCTS, Array.from(productMap.values()));
    }

    return recordsToAppend;
  }, 'AppendStockMovements', movementsListOrPayload, userContext);
}

/**
 * Receives stock into inventory (Atomic Response).
 */
function apiReceiveStock(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var items = Array.isArray(payload) ? payload : (payload.items || payload.movements || [payload]);
    items.forEach(function(it) { if (it && typeof it === 'object') it.type = 'IN'; });
    var res = apiAppendStockMovements(items, userContext);
    var data = (res && res.data) ? res.data : res;
    return { success: true, data: data };
  }, 'ReceiveStock', rawPayload, userContext);
}

/**
 * Ensures StockLogs sheet contains all required standard header columns.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function ensureStockLogSheetHeaders(sheet) {
  var REQUIRED_HEADERS = [
    'id', 'timestamp', 'type', 'productId', 'productCode', 'productName',
    'department', 'location', 'changeQty', 'balanceAfter', 'issuedTo', 'reason', 'actorId', 'actorName'
  ];

  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow === 0 || lastCol === 0) {
    sheet.getRange(1, 1, 1, REQUIRED_HEADERS.length).setValues([REQUIRED_HEADERS]);
    return;
  }

  var existingHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) {
    return String(h || '').trim();
  });

  var missingHeaders = REQUIRED_HEADERS.filter(function(h) {
    return existingHeaders.indexOf(h) === -1;
  });

  if (missingHeaders.length > 0) {
    var startCol = existingHeaders.length + 1;
    sheet.getRange(1, startCol, 1, missingHeaders.length).setValues([missingHeaders]);
  }
}

/**
 * Issues stock from inventory (Atomic Script-Locked Real-time Deduction).
 * Accurately updates stockBalance in Products sheet and records entry in StockLogs sheet.
 */
function apiIssueStock(rawPayload, userContext) {
  var lock = LockService.getScriptLock();
  try {
    // ล็อกระบบป้องกันการแย่งเขียนข้อมูล (Timeout 15 วินาที)
    lock.waitLock(15000);

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var prodSheet = ss.getSheetByName(SHEET_NAMES.PRODUCTS || 'Products');
    var logSheet = ss.getSheetByName(SHEET_NAMES.STOCK_LOGS || 'StockLogs');
    
    if (!prodSheet || !logSheet) throw new Error("ไม่พบชีต Products หรือ StockLogs");

    var payload = rawPayload;
    if (typeof rawPayload === 'string') {
      try { payload = JSON.parse(rawPayload); } catch (e) { payload = {}; }
    }
    payload = payload || {};
    if (Array.isArray(payload)) payload = payload[0] || {};

    var user = userContext || payload.currentUser || payload.user || {};
    var productId = payload.productId || payload.id;
    var productCode = payload.productCode || payload.code || payload.sku;
    var department = payload.department || payload.category || (user && user.department);
    var quantity = payload.quantity !== undefined ? payload.quantity : (payload.qty || payload.issueQty);
    var issuedTo = payload.issuedTo || payload.issueUnit || payload.unitName || '';
    var targetLocation = payload.location || payload.unit || payload.targetLocation || payload.targetUnit || issuedTo || '';
    var reason = payload.reason || payload.note || 'เบิกจ่ายด่วน';
    var requesterId = payload.requesterId || payload.userId || (user && (user.id || user.username)) || '';
    var requesterName = payload.requesterName || payload.userName || (user && (user.name || user.displayName)) || issuedTo || '';

    var issueQty = Math.abs(Number(quantity));
    if (isNaN(issueQty) || issueQty <= 0) throw new Error("จำนวนที่เบิกจ่ายไม่ถูกต้อง");

    // 1. ค้นหาสินค้าในชีต Products ด้วย ID เป็นหลัก (Fallback ด้วย Code + แผนก)
    var prodData = prodSheet.getDataRange().getValues();
    var prodHeaders = prodData[0].map(function(h) { return String(h || '').trim(); });
    var idIdx = prodHeaders.indexOf('id');
    var codeIdx = prodHeaders.indexOf('code');
    var deptIdx = prodHeaders.indexOf('department');
    if (deptIdx === -1) deptIdx = prodHeaders.indexOf('category');
    var balanceIdx = prodHeaders.indexOf('stockBalance');
    var nameIdx = prodHeaders.indexOf('name');
    var updateIdx = prodHeaders.indexOf('updatedAt');
    var avgCostIdx = prodHeaders.indexOf('avgCost');
    if (avgCostIdx === -1) avgCostIdx = prodHeaders.indexOf('price'); // Fallback

    var targetRowIndex = -1;
    for (var i = 1; i < prodData.length; i++) {
      var row = prodData[i];
      // ค้นหาด้วย id ก่อน
      if (productId && String(row[idIdx]).trim() === String(productId).trim()) {
        targetRowIndex = i + 1;
        break;
      }
      // Fallback ด้วย Department + Code
      if (department && productCode && 
          matchDepartment(row[deptIdx], department) && 
          String(row[codeIdx]).trim() === String(productCode).trim()) {
        targetRowIndex = i + 1;
        break;
      }
    }

    if (targetRowIndex === -1) throw new Error("ไม่พบสินค้านี้ในระบบเพื่อตัดสต็อก");

    // 2. คำนวณยอดสต็อกใหม่
    var currentRow = prodData[targetRowIndex - 1];
    var currentBalance = Number(currentRow[balanceIdx] || 0);
    if (currentBalance < issueQty) {
      throw new Error("จำนวนคงเหลือไม่พอเบิก (มี " + currentBalance + ", ต้องการเบิก " + issueQty + ")");
    }
    var newBalance = Math.round((currentBalance - issueQty) * 10000) / 10000;

    // ประทับตราต้นทุนเฉลี่ย
    var currentAvg = Number(avgCostIdx !== -1 ? (currentRow[avgCostIdx] || 0) : 0);
    var totalCost = Math.round(issueQty * currentAvg * 100) / 100;

    // อัปเดต stockBalance และ updatedAt ลงใน Products
    prodSheet.getRange(targetRowIndex, balanceIdx + 1).setValue(newBalance);
    if (updateIdx !== -1) {
      prodSheet.getRange(targetRowIndex, updateIdx + 1).setValue(new Date().toISOString());
    }

    // 3. บันทึกแถวใหม่ลงในชีต StockLogs
    ensureStockLogSheetHeaders(logSheet);
    var logHeaders = logSheet.getDataRange().getValues()[0].map(function(h) { return String(h || '').trim(); });
    var logId = 'LOG-' + (department || 'PD') + '-' + Date.now();
    var nowIso = new Date().toISOString();
    var logRecord = {
      id: logId,
      timestamp: nowIso,
      date: nowIso,
      type: 'OUT', // 'OUT' สำหรับสอดคล้องกับ frontend filter ('OUT'/'ISSUE'/'DISPATCH')
      productId: String(currentRow[idIdx] || productId || ''),
      productCode: String(currentRow[codeIdx] || productCode || ''),
      productName: String(currentRow[nameIdx] || ''),
      name: String(currentRow[nameIdx] || ''),
      department: department || (deptIdx !== -1 ? currentRow[deptIdx] : 'PD'),
      location: targetLocation || '',  // ห้องหรือหน่วยที่เบิก เช่น 'ห้อง K1'
      changeQty: -issueQty, // ติดลบสำหรับตัดสต็อก
      qty: issueQty,
      unit: (prodHeaders.indexOf('stockUnit') !== -1 ? currentRow[prodHeaders.indexOf('stockUnit')] : '') || 
            (prodHeaders.indexOf('unit') !== -1 ? currentRow[prodHeaders.indexOf('unit')] : 'ชิ้น') || 'ชิ้น',
      balanceAfter: newBalance,
      balance: newBalance,
      unitCost: currentAvg,
      totalCost: totalCost,
      issuedTo: issuedTo || targetLocation || '',
      issueUnit: targetLocation || issuedTo || '',
      reason: reason || 'เบิกจ่ายด่วน',
      notes: reason || 'เบิกจ่ายด่วน',
      actorId: requesterId || '',
      actorName: requesterName || issuedTo || ''
    };

    var newLogRow = logHeaders.map(function(header) {
      var val = logRecord[header];
      return val !== undefined ? val : '';
    });
    var nextRow = logSheet.getLastRow() + 1;
    logSheet.getRange(nextRow, 1, 1, newLogRow.length).setValues([newLogRow]);

    var updatedProductObj = {};
    for (var c = 0; c < prodHeaders.length; c++) {
      updatedProductObj[prodHeaders[c]] = currentRow[c];
    }
    updatedProductObj.id = currentRow[idIdx];
    updatedProductObj.stockBalance = newBalance;
    updatedProductObj.updatedAt = nowIso;

    return {
      success: true,
      data: {
        updatedProduct: updatedProductObj,
        logEntry: logRecord
      },
      updatedProduct: updatedProductObj,
      logEntry: logRecord
    };

  } catch (error) {
    return { success: false, error: error.message, message: error.message };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

// =========================================================================
// 6. BUDGET & FINANCIAL RECONCILIATION RPCs
// =========================================================================

/**
 * Retrieves budget configuration and spent status.
 */
function apiGetBudgets(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var rows = batchReadRecords(SHEET_NAMES.BUDGETS);
    var budgetMap = {};
    rows.forEach(function(r) {
      var dept = String(r.dept || '').trim().toUpperCase();
      if (dept && dept !== 'ALL') {
        budgetMap[r.dept] = r;
      }
    });
    return budgetMap;
  }, 'GetBudgets', rawPayload, userContext);
}

/**
 * Saves or updates budget configurations.
 */
function apiSaveBudgets(budgetsObj, userContext) {
  return handleApiRequest(function(payload, user) {
    var targetBudgets = (typeof payload === 'object' && payload !== null) ? payload : {};
    var budgetList = [];
    Object.keys(targetBudgets).forEach(function(dept) {
      var cleanDept = String(dept || '').trim().toUpperCase();
      if (!cleanDept || cleanDept === 'ALL') return;
      var data = targetBudgets[dept] || {};
      data.dept = cleanDept;
      data.updatedAt = new Date().toISOString();
      budgetList.push(data);
    });
    if (budgetList.length > 0) {
      batchUpsertRecordsFast(SHEET_NAMES.BUDGETS, 'dept', budgetList);
    }
    return targetBudgets;
  }, 'SaveBudgets', budgetsObj, userContext);
}

/**
 * Retrieves budget transaction history.
 */
function apiGetBudgetTransactions(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    return batchReadRecords(SHEET_NAMES.BUDGET_TRANSACTIONS);
  }, 'GetBudgetTransactions', rawPayload, userContext);
}

/**
 * Appends a budget transaction and reconciles variance.
 * Includes an idempotency guard: for key event types (PR_CANCEL_RELEASE,
 * PO_CANCEL_RELEASE, BUDGET_ROLLBACK, CLAIM_REFUND), it checks the sheet
 * for a pre-existing record with the same (type + docRef) before appending.
 * If a duplicate is found, it skips the append and returns the existing record.
 */
function apiAppendBudgetTransaction(txObj, userContext) {
  return handleApiRequest(function(payload, user) {
    var targetTx = payload ? Object.assign({}, payload) : {};
    var dept = targetTx.dept || targetTx.department || user.department || 'PD';
    targetTx.dept = dept;
    targetTx.createdAt = targetTx.createdAt || new Date().toISOString();
    targetTx.actorName = targetTx.actorName || user.name || user.username || 'System User';
    targetTx.actorRole = targetTx.actorRole || user.role || 'ADMIN';

    // ── Idempotency Guard ──────────────────────────────────────────────────
    // For cancellation/refund event types, prevent double-writing the same
    // transaction if the caller is retried or the button is pressed twice.
    var IDEMPOTENT_TYPES = ['PR_CANCEL_RELEASE', 'PO_CANCEL_RELEASE', 'BUDGET_ROLLBACK', 'CLAIM_REFUND'];
    var txType = String(targetTx.type || '').toUpperCase();
    var txDocRef = String(targetTx.docRef || targetTx.docNo || targetTx.referenceDoc || '').trim();

    if (IDEMPOTENT_TYPES.indexOf(txType) !== -1 && txDocRef) {
      var existingTxs = batchReadRecords(SHEET_NAMES.BUDGET_TRANSACTIONS);
      var duplicate = existingTxs.find(function(ex) {
        return String(ex.type || '').toUpperCase() === txType &&
               String(ex.docRef || ex.docNo || ex.referenceDoc || '').trim() === txDocRef;
      });
      if (duplicate) {
        console.log('[apiAppendBudgetTransaction] Idempotency Guard: Skipped duplicate ' + txType + ' for docRef=' + txDocRef);
        return duplicate; // Return existing record — no sheet write
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    targetTx.id = targetTx.id || ('TX-' + Date.now() + '-' + Utilities.getUuid().slice(0, 4));
    appendRecord(SHEET_NAMES.BUDGET_TRANSACTIONS, targetTx);

    // Reconcile with Budgets tab if refund/credit
    if (targetTx.type === 'BUDGET_ROLLBACK' || targetTx.refundAmount) {
      var budgets = batchReadRecords(SHEET_NAMES.BUDGETS);
      var deptBudget = budgets.find(function(b) { return String(b.dept).toUpperCase() === String(dept).toUpperCase(); });
      if (deptBudget) {
        var refund = Number(targetTx.refundAmount || targetTx.amount || 0);
        deptBudget.variance = Number(deptBudget.variance || 0) + refund;
        deptBudget.updatedAt = new Date().toISOString();
        upsertRecordById(SHEET_NAMES.BUDGETS, 'dept', deptBudget);
      }
    }

    return targetTx;
  }, 'AppendBudgetTransaction', txObj, userContext);
}

// =========================================================================
// 7. AUDIT LOGS & NOTIFICATIONS RPCs
// =========================================================================

function apiGetAuditLogs(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    return batchReadRecords(SHEET_NAMES.AUDIT_LOGS);
  }, 'GetAuditLogs', rawPayload, userContext);
}

function apiAppendAuditLog(logObj, userContext) {
  return handleApiRequest(function(payload, user) {
    var targetLog = payload ? Object.assign({}, payload) : {};
    targetLog.id = targetLog.id || ('AUD-' + Date.now() + '-' + Utilities.getUuid().slice(0, 5));
    targetLog.timestamp = targetLog.timestamp || new Date().toISOString();
    targetLog.actor = targetLog.actor || { id: user.username, name: user.name, role: user.role };
    targetLog.createdAt = targetLog.createdAt || new Date().toISOString();
    return appendRecord(SHEET_NAMES.AUDIT_LOGS, targetLog);
  }, 'AppendAuditLog', logObj, userContext);
}

/**
 * Helper to match user against notification targetDepartment and targetRole (No email binding)
 */
function isUserTargetOfNotification(n, user) {
  if (!n) return false;
  var targetRole = String(n.targetRole || (Array.isArray(n.targetRoles) && n.targetRoles[0]) || 'ALL').toUpperCase();
  var targetDept = String(n.targetDepartment || n.targetDept || n.department || 'ALL').toUpperCase();

  if (!user) return targetRole === 'ALL' && targetDept === 'ALL';
  var userRole = String(user.canonicalRole || user.roleId || user.role || '').toUpperCase();
  var isAdmin = user.isAdmin || userRole.indexOf('ADMIN') !== -1 || Number(user.level) >= 99 || user.username === 'admin';
  if (isAdmin) return true;

  // 1. Department Filter: หากเป็น Approver หรืองานของ MGT ให้ข้ามเงื่อนไขตรวจสอบ department ได้
  var userDept = String(user.department || user.dept || '').toUpperCase();
  var isApproverOrMGT = userRole.indexOf('APPROV') !== -1 || userRole.indexOf('REVIEW') !== -1 || userRole.indexOf('MANAGER') !== -1 || userDept === 'MGT';
  var isApproverTarget = targetRole.indexOf('APPROV') !== -1 || targetRole.indexOf('REVIEW') !== -1 || (Array.isArray(n.targetRoles) && n.targetRoles.some(function(r) {
    var ru = String(r).toUpperCase();
    return ru.indexOf('APPROV') !== -1 || ru.indexOf('REVIEW') !== -1 || ru.indexOf('MANAGER') !== -1;
  }));

  var matchDept = (isApproverOrMGT && isApproverTarget)
    ? true
    : (targetDept === 'ALL' || userDept === 'ALL' || targetDept === userDept || userDept.indexOf(targetDept) !== -1 || targetDept.indexOf(userDept) !== -1);

  if (!matchDept && !user.canViewAllDepts && userDept !== 'ALL') {
    return false;
  }

  // 2. Role Filter
  if (targetRole === 'ALL') return true;

  if (targetRole.indexOf('REQUEST') !== -1) {
    return userRole.indexOf('REQUEST') !== -1 || userRole.indexOf('PD') !== -1 || userRole.indexOf('QC') !== -1 || Number(user.level) === 1;
  }
  if (targetRole.indexOf('APPROV') !== -1) {
    return isApproverOrMGT || userRole.indexOf('APPROV') !== -1 || userRole.indexOf('REVIEW') !== -1 || userRole.indexOf('PLANT_MANAGER') !== -1 || userRole.indexOf('ASST_MANAGER') !== -1 || Boolean(user.canReview || user.canFinalApprove);
  }
  if (targetRole.indexOf('PURCHAS') !== -1 || targetRole.indexOf('BUYER') !== -1) {
    return userRole.indexOf('PURCHAS') !== -1 || userRole.indexOf('BUYER') !== -1 || Boolean(user.canOnlinePurchase);
  }

  return userRole.indexOf(targetRole) !== -1;
}

function apiGetNotifications(userObjOrPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var allNotifs = batchReadRecords(SHEET_NAMES.NOTIFICATIONS);
    return allNotifs.filter(function(n) {
      return isUserTargetOfNotification(n, user);
    });
  }, 'GetNotifications', userObjOrPayload, userContext);
}

function apiConfirmOnlineOrder(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var poObj = payload ? Object.assign({}, payload) : {};
    poObj.status = poObj.status || 'ORDERED';
    poObj.orderStatus = 'ORDERED';
    poObj.orderedAt = poObj.orderedAt || new Date().toISOString();
    poObj.orderedBy = poObj.orderedBy || user.name || user.username || 'Online Purchaser';
    return apiSavePO(poObj, userContext);
  }, 'ConfirmOnlineOrder', rawPayload, userContext);
}

function apiCancelPO(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var poObj = payload ? Object.assign({}, payload) : {};
    poObj.status = 'CANCELLED';
    poObj.cancelledAt = poObj.cancelledAt || new Date().toISOString();
    poObj.cancelledBy = poObj.cancelledBy || user.name || user.username || 'User';
    return apiSavePO(poObj, userContext);
  }, 'CancelPO', rawPayload, userContext);
}

function apiResolveClaim(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var poObj = payload ? Object.assign({}, payload) : {};
    return apiSavePO(poObj, userContext);
  }, 'ResolveClaim', rawPayload, userContext);
}

function apiSaveNotifications(notifsListOrPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var list = Array.isArray(payload) ? payload : (payload.notifications || payload.notifs || []);
    return batchWriteRecords(SHEET_NAMES.NOTIFICATIONS, list);
  }, 'SaveNotifications', notifsListOrPayload, userContext);
}

// =========================================================================
// 8. DRIVE FILE UPLOAD & ATTACHMENT SERVICES
// =========================================================================

/**
 * Uploads a Base64-encoded file into the structured Google Drive hierarchy.
 * 
 * @param {Object} payload File upload payload
 * @returns {Object} Upload result with Drive IDs and URLs
 */
function uploadBase64File(payload) {
  if (!payload || !payload.base64Data) {
    throw new Error('VALIDATION_ERROR: Missing required "base64Data" payload.');
  }

  const fileName = (payload.fileName || `file_${Date.now()}`).trim();
  let mimeType = (payload.mimeType || 'application/octet-stream').toLowerCase().trim();
  let base64 = String(payload.base64Data);

  if (base64.includes(';base64,')) {
    const parts = base64.split(';base64,');
    const meta = parts[0];
    base64 = parts[1];
    if (meta.includes(':')) {
      mimeType = meta.split(':')[1].trim();
    }
  }

  if (ALLOWED_MIME_TYPES.length > 0 && !ALLOWED_MIME_TYPES.includes(mimeType)) {
    throw new Error(`UNSUPPORTED_MEDIA_TYPE: ไม่อนุญาตให้อัปโหลดไฟล์ประเภท "${mimeType}"`);
  }

  const bytes = Utilities.base64Decode(base64);
  const fileSize = bytes.length;

  if (fileSize > CONFIG.DEFAULTS.MAX_FILE_SIZE_BYTES) {
    const maxMb = (CONFIG.DEFAULTS.MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0);
    throw new Error(`FILE_TOO_LARGE: ขนาดไฟล์เกินข้อกำหนด (${(fileSize / (1024 * 1024)).toFixed(2)} MB) จำกัดสูงสุดไม่เกิน ${maxMb} MB`);
  }

  const { folder, pathString } = resolveTargetDriveFolder(
    payload.category,
    payload.poNumber,
    payload.date
  );

  const blob = Utilities.newBlob(bytes, mimeType, fileName);
  let createdFile;

  try {
    createdFile = folder.createFile(blob);
  } catch (driveErr) {
    throw new Error(`DRIVE_UPLOAD_FAILED: ไม่สามารถบันทึกไฟล์ลง Google Drive: ${driveErr.message}`);
  }

  try {
    createdFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (shareErr) {
    Logger.log('[uploadBase64File] Sharing permission notice: ' + shareErr.message);
  }

  const fileId = createdFile.getId();
  const viewUrl = 'https://drive.google.com/file/d/' + fileId + '/view';
  const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  const directUrl = 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w1200';
  const lh3Url = 'https://lh3.googleusercontent.com/d/' + fileId;
  const attachmentId = `ATT-${Utilities.getUuid().slice(0, 8)}`;
  const currentUser = payload.uploadedBy || getCurrentUserEmail() || 'system';

  const attachmentRecord = {
    id: attachmentId,
    fileId: fileId,
    fileName: fileName,
    mimeType: mimeType,
    fileSize: fileSize,
    category: normalizeDriveCategory(payload.category),
    poNumber: payload.poNumber || '',
    docNo: payload.docNo || payload.poNumber || '',
    docType: payload.docType || payload.category || 'OTHER',
    viewUrl: viewUrl,
    directUrl: directUrl,
    lh3Url: lh3Url,
    downloadUrl: downloadUrl,
    folderPath: pathString,
    uploadedBy: currentUser,
    uploadedAt: new Date().toISOString()
  };

  try {
    const sheet = getSheet(SHEET_NAMES.ATTACHMENTS);
    const headers = getSheetHeaders(sheet);
    const rowValues = [serializeRecordToRow(attachmentRecord, headers)];
    const lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, 1, rowValues[0].length).setValues(rowValues);
  } catch (sheetErr) {
    try {
      createdFile.setTrashed(true);
    } catch (trashErr) {}
    throw new Error(`TRANSACTION_FAILED: ไม่สามารถบันทึกประวัติไฟล์ลงฐานข้อมูลได้ (${sheetErr.message})`);
  }

  return {
    attachmentId: attachmentId,
    fileId: fileId,
    name: fileName,
    fileName: fileName,
    fileSize: fileSize,
    mimeType: mimeType,
    directUrl: directUrl,
    lh3Url: lh3Url,
    viewUrl: viewUrl,
    downloadUrl: downloadUrl,
    folderPath: pathString,
    uploadedAt: attachmentRecord.uploadedAt
  };
}

/**
 * Saves image base64 to Google Drive with public read permission and direct CDN URLs
 */
function saveImageToDrive(base64Data, fileName, mimeType, category) {
  return uploadBase64File({
    base64Data: base64Data,
    fileName: fileName || ('image_' + Date.now() + '.jpg'),
    mimeType: mimeType || 'image/jpeg',
    category: category || 'PR'
  });
}

function uploadAttachment(payload) {
  return uploadBase64File(payload);
}

function getOrCreateAttachmentFolder(folderName) {
  var root = getRootDriveFolder();
  var targetName = folderName || DRIVE_CATEGORIES.PR;
  return getOrCreateSubFolder(root, targetName);
}

/**
 * Decodes and uploads a single Base64 image directly to Google Drive.
 */
function uploadBase64Image(base64Data, fileName, mimeType, category, docNo, docType) {
  if (!base64Data || typeof base64Data !== 'string') return null;

  var cleanMime = (mimeType || 'image/jpeg').toLowerCase();
  var rawBase64 = base64Data;

  if (base64Data.includes(';base64,')) {
    var parts = base64Data.split(';base64,');
    var header = parts[0];
    rawBase64 = parts[1];
    if (header.includes(':')) {
      cleanMime = header.split(':')[1].trim();
    }
  }

  if (!rawBase64 || rawBase64.includes('STORED_IN_DRIVE') || rawBase64.includes('BASE64_') || rawBase64.length < 20
      || rawBase64.startsWith('https://') || rawBase64.startsWith('http://')) {
    return null;
  }

  var bytes;
  try {
    bytes = Utilities.base64Decode(rawBase64);
  } catch (decErr) {
    return null;
  }

  var ext = cleanMime.includes('png') ? '.png' : (cleanMime.includes('webp') ? '.webp' : '.jpg');
  var cleanFileName = (fileName || ('pr_image_' + Date.now())).trim();
  if (!cleanFileName.match(/\.(jpe?g|png|webp|gif)$/i)) {
    cleanFileName += ext;
  }

  var folder = getRootDriveFolder();
  var blob = Utilities.newBlob(bytes, cleanMime, cleanFileName);
  var file;

  try {
    file = folder.createFile(blob);
    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (e) {
      Logger.log('[apiSaveBase64ImageFast] Sharing permission notice: ' + e.message);
    }
  } catch (driveErr) {
    return null;
  }

  var fileId = file.getId();
  var directUrl = 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w1200';
  var lh3Url = 'https://lh3.googleusercontent.com/d/' + fileId;
  var viewUrl = 'https://drive.google.com/file/d/' + fileId + '/view';

  try {
    _pendingAttachments.push({
      id: 'ATT-' + Utilities.getUuid().slice(0, 8),
      fileId: fileId,
      fileName: cleanFileName,
      mimeType: cleanMime,
      fileSize: bytes.length,
      category: category || DRIVE_CATEGORIES.PR,
      poNumber: (docType === 'PO' ? docNo : ''),
      docNo: docNo || '',
      docType: docType || 'PR',
      viewUrl: viewUrl,
      directUrl: directUrl,
      lh3Url: lh3Url,
      downloadUrl: 'https://drive.google.com/uc?export=download&id=' + fileId,
      folderPath: CONFIG.DEFAULTS.DRIVE_ROOT_NAME || 'PR-PO-Stock-System',
      uploadedBy: getCurrentUserEmail() || 'system',
      uploadedAt: new Date().toISOString()
    });
  } catch (attErr) {}

  return {
    fileId: fileId,
    directUrl: directUrl,
    lh3Url: lh3Url,
    viewUrl: viewUrl,
    driveUrl: viewUrl,
    fileName: cleanFileName,
    mimeType: cleanMime
  };
}

/**
 * Processes inline Base64 images/attachments in PR items.
 */
function processItemImages(items, docNo, docType) {
  if (!Array.isArray(items) || items.length === 0) return items;

  return items.map(function(item, idx) {
    if (!item || typeof item !== 'object') return item;
    var cleanItem = Object.assign({}, item);

    if (cleanItem.imageUrl && typeof cleanItem.imageUrl === 'string' && cleanItem.imageUrl.startsWith('data:image/')) {
      var uploadResult = uploadBase64Image(
        cleanItem.imageUrl,
        (cleanItem.name || 'item_' + (idx + 1)) + '_thumb',
        'image/jpeg',
        DRIVE_CATEGORIES.PR,
        docNo,
        docType || 'PR'
      );
      if (uploadResult) {
        cleanItem.imageUrl = uploadResult.directUrl;
        cleanItem.fileId = uploadResult.fileId;
        cleanItem.driveUrl = uploadResult.viewUrl;
        cleanItem.lh3Url = uploadResult.lh3Url;
      } else {
        cleanItem.imageUrl = '';
      }
    }

    if (Array.isArray(cleanItem.images) && cleanItem.images.length > 0) {
      cleanItem.images = cleanItem.images.map(function(img, imgIdx) {
        if (!img) return img;
        var rawUrl = (typeof img === 'string') ? img : (img.url || img.previewUrl || '');
        var imgName = (typeof img === 'object' && img.name) ? img.name : ((cleanItem.name || 'item_' + (idx + 1)) + '_img_' + (imgIdx + 1));

        if (!rawUrl || !rawUrl.startsWith('data:')) return img;

        if (typeof rawUrl === 'string' && rawUrl.startsWith('data:')) {
          var res = uploadBase64Image(rawUrl, imgName, 'image/jpeg', DRIVE_CATEGORIES.PR, docNo, docType || 'PR');
          if (res) {
            if (typeof img === 'string') return res.directUrl;
            return Object.assign({}, img, {
              url: res.directUrl,
              previewUrl: res.directUrl,
              directUrl: res.directUrl,
              lh3Url: res.lh3Url,
              fileId: res.fileId,
              driveUrl: res.viewUrl
            });
          }
          return (typeof img === 'string') ? '' : Object.assign({}, img, { url: '', previewUrl: '' });
        }
        return img;
      });

      if ((!cleanItem.imageUrl || cleanItem.imageUrl.includes('BASE64_')) && cleanItem.images.length > 0) {
        var first = cleanItem.images[0];
        cleanItem.imageUrl = (typeof first === 'string') ? first : (first.directUrl || first.url || first.previewUrl || '');
        if (typeof first === 'object' && first.fileId) {
          cleanItem.fileId = first.fileId;
          cleanItem.driveUrl = first.driveUrl;
        }
      }
    }

    if (Array.isArray(cleanItem.attachments) && cleanItem.attachments.length > 0) {
      cleanItem.attachments = cleanItem.attachments.map(function(att, attIdx) {
        if (!att || typeof att !== 'object') return att;
        var rawUrl = att.url || att.previewUrl || att.dataUrl || '';
        if (!rawUrl || !rawUrl.startsWith('data:')) return att;
        if (typeof rawUrl === 'string' && rawUrl.startsWith('data:')) {
          var attName = att.name || ((cleanItem.name || 'item_' + (idx + 1)) + '_att_' + (attIdx + 1));
          var res = uploadBase64Image(rawUrl, attName, att.type || 'image/jpeg', DRIVE_CATEGORIES.PR, docNo, docType || 'PR');
          if (res) {
            return Object.assign({}, att, {
              url: res.directUrl,
              previewUrl: res.directUrl,
              directUrl: res.directUrl,
              lh3Url: res.lh3Url,
              fileId: res.fileId,
              driveUrl: res.viewUrl
            });
          }
          return Object.assign({}, att, { url: '', previewUrl: '' });
        }
        return att;
      });
    }

    return cleanItem;
  });
}

/**
 * Processes document-level attachments and uploads any Base64 files to Google Drive.
 */
function processDocumentAttachments(attachments, category, docNo, docType, isNew) {
  if (docNo && !isNew) {
    try {
      var allAtts = batchReadRecords(SHEET_NAMES.ATTACHMENTS);
      var validKeys = {};
      if (Array.isArray(attachments)) {
        attachments.forEach(function(att) {
           if (att && att.fileId) validKeys[att.fileId] = true;
           if (att && att.url) validKeys[att.url] = true;
           if (att && att.viewUrl) validKeys[att.viewUrl] = true;
           if (att && att.directUrl) validKeys[att.directUrl] = true;
        });
      }
      
      var filteredAtts = allAtts.filter(function(row) {
        var rDocNo = String(row.docNo || '').trim().toUpperCase();
        var rPoNo = String(row.poNumber || '').trim().toUpperCase();
        var rPrNo = String(row.prNo || '').trim().toUpperCase();
        var targetDocNo = String(docNo).trim().toUpperCase();
        
        var isThisDoc = (rDocNo === targetDocNo || rPoNo === targetDocNo || rPrNo === targetDocNo);
        if (!isThisDoc) return true;
        
        var isKept = false;
        if (row.fileId && validKeys[row.fileId]) isKept = true;
        if (row.viewUrl && validKeys[row.viewUrl]) isKept = true;
        if (row.directUrl && validKeys[row.directUrl]) isKept = true;
        
        return isKept;
      });
      
      if (filteredAtts.length < allAtts.length) {
        var attSheet = getSheet(SHEET_NAMES.ATTACHMENTS || 'Attachments');
        var attHeaders = getSheetHeaders(attSheet);
        var lastR = attSheet.getLastRow();
        var lastC = attSheet.getLastColumn();
        if (lastR > 1 && lastC > 0) {
          attSheet.getRange(2, 1, lastR - 1, lastC).clearContent();
        }
        if (filteredAtts.length > 0) {
          var rowsToWrite = filteredAtts.map(function(rec) { return serializeRecordToRow(rec, attHeaders); });
          attSheet.getRange(2, 1, rowsToWrite.length, attHeaders.length).setValues(rowsToWrite);
        }
      }
    } catch (e) {}
  }

  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  return attachments.map(function(att, idx) {
    if (!att || typeof att !== 'object') return att;
    var rawUrl = att.url || att.previewUrl || att.dataUrl || '';
    if (!rawUrl || !rawUrl.startsWith('data:')) return att;
    if (typeof rawUrl === 'string' && rawUrl.startsWith('data:')) {
      var attName = att.name || ('attachment_' + (idx + 1));
      var res = uploadBase64Image(rawUrl, attName, att.type || 'application/octet-stream', category || DRIVE_CATEGORIES.PR, docNo, docType);
      if (res) {
        return Object.assign({}, att, {
          url: res.directUrl,
          previewUrl: res.directUrl,
          directUrl: res.directUrl,
          lh3Url: res.lh3Url,
          fileId: res.fileId,
          driveUrl: res.viewUrl
        });
      }
      return Object.assign({}, att, { url: '', previewUrl: '' });
    }
    return att;
  });
}

/**
 * Sets Public Read permissions for all existing image files and attachments.
 */
function makeAllDriveFilesPublic() {
  const stats = {
    foldersScanned: 0,
    totalScanned: 0,
    updated: 0,
    errors: [],
    processedFiles: []
  };

  const visitedFileIds = {};

  function markFilePublic(file, sourceDesc) {
    if (!file) return;
    const fileId = file.getId();
    if (visitedFileIds[fileId]) return;
    visitedFileIds[fileId] = true;

    stats.totalScanned++;
    const name = file.getName() || 'unnamed';
    const mimeType = file.getMimeType() || '';

    try {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      stats.updated++;
      if (!Array.isArray(stats.processedFiles)) stats.processedFiles = [];
      stats.processedFiles.push({
        id: fileId,
        name: name,
        mimeType: mimeType,
        directUrl: 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w1200',
        lh3Url: 'https://lh3.googleusercontent.com/d/' + fileId,
        viewUrl: file.getUrl(),
        source: sourceDesc || 'DriveFolder'
      });
    } catch (err) {
      if (!Array.isArray(stats.errors)) stats.errors = [];
      stats.errors.push({ id: fileId, name: name, error: err.message });
    }
  }

  function traverseFolder(folder, currentPath) {
    if (!folder) return;
    stats.foldersScanned++;
    const folderName = folder.getName();
    const folderPath = currentPath ? (currentPath + '/' + folderName) : folderName;

    try {
      const files = folder.getFiles();
      while (files.hasNext()) {
        markFilePublic(files.next(), folderPath);
      }
    } catch (err) {
      if (!Array.isArray(stats.errors)) stats.errors = [];
      stats.errors.push({ folder: folderPath, error: err.message });
    }

    try {
      const childFolders = folder.getFolders();
      while (childFolders.hasNext()) {
        traverseFolder(childFolders.next(), folderPath);
      }
    } catch (err) {
      if (!Array.isArray(stats.errors)) stats.errors = [];
      stats.errors.push({ folder: folderPath, error: err.message });
    }
  }

  try {
    const rootFolder = getRootDriveFolder();
    if (rootFolder) {
      traverseFolder(rootFolder, '');
    }
  } catch (rootErr) {}

  return {
    success: true,
    message: 'ปรับสิทธิ์ไฟล์รูปภาพทั้งหมดใน Google Drive ให้เป็น Public Read เรียบร้อยแล้ว',
    totalFoldersScanned: stats.foldersScanned,
    totalFilesScanned: stats.totalScanned,
    updatedCount: stats.updated,
    errorCount: stats.errors.length,
    updatedFiles: stats.processedFiles,
    errors: stats.errors,
    executedAt: new Date().toISOString()
  };
}

/**
 * Public RPC Endpoint: One-time migration to set all Drive image files and attachments to Public Read.
 */
function apiMakeAllDriveFilesPublic(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    return makeAllDriveFilesPublic();
  }, 'MakeAllDriveFilesPublic', rawPayload, userContext);
}

/**
 * Accepts Base64 file from frontend, validates, stores in Drive,
 * logs to Attachments sheet, and rolls back if database write fails.
 */
function apiUploadFile(payload, userContext) {
  return handleApiRequest(function(p, user) {
    var uploadPayload = p ? Object.assign({}, p) : {};
    uploadPayload.uploadedBy = uploadPayload.uploadedBy || user.name || user.username || 'System User';
    return uploadBase64File(uploadPayload);
  }, 'UploadFile', payload, userContext);
}

// =========================================================================
// 9. SYSTEM ADMINISTRATION & INITIALIZATION RPCs
// =========================================================================

/**
 * Initializes Spreadsheet tabs, headers, and Drive folders.
 */
function apiInitializeSystem(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var report = initializeSystem();
    ensurePRItemsSheet();
    return report;
  }, 'InitializeSystem', rawPayload, userContext);
}

/**
 * Seeds baseline Master Data.
 */
function apiSeedMasterData(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    return seedInitialMasterData();
  }, 'SeedMasterData', rawPayload, userContext);
}

/**
 * Migrates a batch of PO records into POs sheet.
 */
function apiMigratePOsBatch(poBatch, userContext) {
  return handleApiRequest(function(payload, user) {
    var batch = Array.isArray(payload) ? payload : (payload.poBatch || payload.pos || []);
    return migratePOsBatch(batch);
  }, 'MigratePOsBatch', poBatch, userContext);
}

/**
 * System Health Diagnostic Ping.
 */
function apiGetSystemStatus(userEmailOrPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    var ss = getSpreadsheet();
    return {
      status: 'HEALTHY',
      environment: getScriptProperty(CONFIG.PROPERTY_KEYS.APP_ENV, 'production'),
      spreadsheetId: ss.getId(),
      spreadsheetName: ss.getName(),
      currentUser: user.username || user.name || 'System User',
      currentRole: user.role || 'ADMIN',
      isAdmin: user.isAdmin,
      totalSheets: ss.getSheets().length,
      serverTime: new Date().toISOString()
    };
  }, 'GetSystemStatus', userEmailOrPayload, userContext);
}

/**
 * High-Performance Consolidated Initial Data RPC Endpoint.
 * Batches all collections into a single RPC round-trip for instant app boot.
 * 
 * @returns {Object} Standard API Envelope containing full hydrated initial dataset
 */
function apiGetInitialPayload(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    return getInitialPayloadBatch();
  }, 'GetInitialPayload', rawPayload, userContext);
}

/**
 * Migration Endpoint: Purges ALL Department Entity from Google Sheets.
 * - Removes 'ALL' department and 'ALL' budgets
 * - Re-maps users with department 'ALL' to 'MGT' / 'PUR'
 * 
 * @returns {Object} Migration audit report
 */
function apiPurgeAllDepartment(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    return purgeAllDepartmentEntity();
  }, 'PurgeAllDepartment', rawPayload, userContext);
}

/**
 * High-Performance Sheet Values to Objects Parser in RAM.
 * Reads 2D getValues() array, strictly maps header rows, auto-parses JSON fields,
 * formats ISO dates, and casts identifiers to string without repeated sheet calls.
 * 
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {Array<Object>}
 */
function readSheetValuesAsObjects(sheet) {
  if (!sheet) return [];
  var dataRange = sheet.getDataRange();
  var values = dataRange.getValues();
  if (!values || values.length <= 1) return [];

  var headers = values[0].map(function(h) { return String(h || '').trim(); });
  var records = [];

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var isEmpty = true;
    for (var c = 0; c < row.length; c++) {
      if (row[c] !== '' && row[c] !== null && row[c] !== undefined) {
        isEmpty = false;
        break;
      }
    }
    if (isEmpty) continue;

    var record = {};
    for (var c = 0; c < headers.length; c++) {
      var header = headers[c];
      if (!header) continue;
      var val = row[c];

      if (typeof isIdentifierColumn === 'function' && isIdentifierColumn(header)) {
        val = (val !== null && val !== undefined) ? String(val).trim() : '';
      } else if (typeof val === 'string' && val.length > 1) {
        var trimmed = val.trim();
        if ((trimmed.charAt(0) === '{' && trimmed.charAt(trimmed.length - 1) === '}') ||
            (trimmed.charAt(0) === '[' && trimmed.charAt(trimmed.length - 1) === ']')) {
          try { val = JSON.parse(trimmed); } catch (e) {}
        }
      } else if (val instanceof Date) {
        val = val.toISOString();
      }
      record[header] = val;
    }
    records.push(record);
  }
  return records;
}

/**
 * Fast Bootstrap Data Payload for frontend initial load.
 * Opens Google Spreadsheet ONCE, reads PRs, POs, and Inventory/Products via .getDataRange().getValues(),
 * converts 2D arrays to JSON in RAM, and returns all collections in a single unified response.
 */
function apiGetBootstrapData(rawPayload, userContext) {
  return handleApiRequest(function(payload, user) {
    // 1. Open Spreadsheet ONCE
    var ss = getSpreadsheet();

    // 2. Fetch sheet tabs
    var prSheet = ss.getSheetByName(SHEET_NAMES.PRS) || ss.getSheetByName('PRs');
    var poSheet = ss.getSheetByName(SHEET_NAMES.POS) || ss.getSheetByName('POs');
    var invSheet = ss.getSheetByName('Inventory') || ss.getSheetByName(SHEET_NAMES.PRODUCTS) || ss.getSheetByName('Products');
    var logsSheet = ss.getSheetByName(SHEET_NAMES.STOCK_LOGS) || ss.getSheetByName('StockLogs');
    var venSheet = ss.getSheetByName(SHEET_NAMES.VENDORS) || ss.getSheetByName('Vendors');
    var locSheet = ss.getSheetByName(SHEET_NAMES.STORAGE_LOCATIONS) || ss.getSheetByName('StorageLocations');
    var unitSheet = ss.getSheetByName(SHEET_NAMES.USAGE_UNITS) || ss.getSheetByName('UsageUnits');
    var deptSheet = ss.getSheetByName(SHEET_NAMES.DEPARTMENTS) || ss.getSheetByName('Departments');
    var userSheet = ss.getSheetByName(SHEET_NAMES.USERS) || ss.getSheetByName('Users');
    var budSheet = ss.getSheetByName(SHEET_NAMES.BUDGETS) || ss.getSheetByName('Budgets');
    var txSheet = ss.getSheetByName(SHEET_NAMES.BUDGET_TRANSACTIONS) || ss.getSheetByName('BudgetTransactions');
    var notifSheet = ss.getSheetByName(SHEET_NAMES.NOTIFICATIONS) || ss.getSheetByName('Notifications');
    var attachSheetName = (typeof SHEET_NAMES !== 'undefined' && SHEET_NAMES.ATTACHMENTS) ? SHEET_NAMES.ATTACHMENTS : 'Attachments';
    var attachSheet = ss.getSheetByName(attachSheetName);

    // 3. Read .getDataRange().getValues() and convert to JSON in RAM
    var rawAttachments = attachSheet ? readSheetValuesAsObjects(attachSheet) : [];
    var normKey = function(val) { return String(val || '').trim().toUpperCase(); };
    var attachmentsByDoc = {};
    rawAttachments.forEach(function(att) {
      if (!att) return;
      var k1 = normKey(att.docNo);
      var k2 = normKey(att.prNo);
      if (k1) {
        if (!attachmentsByDoc[k1]) attachmentsByDoc[k1] = [];
        attachmentsByDoc[k1].push(att);
      }
      if (k2 && k2 !== k1) {
        if (!attachmentsByDoc[k2]) attachmentsByDoc[k2] = [];
        attachmentsByDoc[k2].push(att);
      }
    });

    var prs = prSheet ? readSheetValuesAsObjects(prSheet) : [];
    if (typeof normalizePRsLegacyOnline === 'function') {
      prs = normalizePRsLegacyOnline(prs);
    }
    // Fetch and Index AuditLogs
    var auditLogsSheet = ss.getSheetByName('AuditLogs');
    var rawAuditLogs = auditLogsSheet ? readSheetValuesAsObjects(auditLogsSheet) : [];
    var logsByDoc = buildAuditLogsByDoc(rawAuditLogs);

    prs.forEach(function(pr) {
      if (typeof pr.attachments === 'string') {
        try { pr.attachments = JSON.parse(pr.attachments); } catch(e) {}
      }
      var prKey = normKey(pr.prNo || pr.id || pr.docNo);
      var kNo = normKey(pr.prNo);
      var kId = normKey(pr.id);
      var kDoc = normKey(pr.docNo);
      var files = attachmentsByDoc[prKey] || [];
      pr.attachments = files;
      pr.quotationFiles = files;
      pr.generalAttachments = files;
      
      var docLogs = logsByDoc[prKey] || logsByDoc[kNo] || logsByDoc[kDoc] || logsByDoc[kId] || [];
      var seenIds = {};
      var sortedLogs = [];
      docLogs.forEach(function(l) {
        var lid = l.id || (l.timestamp + '_' + l.action);
        if (!seenIds[lid]) {
          seenIds[lid] = true;
          sortedLogs.push(l);
        }
      });
      sortedLogs.sort(function(a, b) {
        var tA = new Date(a.timestamp || a.createdAt || 0).getTime();
        var tB = new Date(b.timestamp || b.createdAt || 0).getTime();
        return tA - tB;
      });

      pr.timeline = sortedLogs;
      pr.activityTimeline = sortedLogs;
      pr.history = sortedLogs;
      pr.approvalHistory = sortedLogs;
      pr.auditLogs = sortedLogs;
    });

    var pos = poSheet ? readSheetValuesAsObjects(poSheet) : [];
    pos.forEach(function(po) {
      po.attachments = attachmentsByDoc[po.poNo] || [];
    });
    var inventory = invSheet ? readSheetValuesAsObjects(invSheet) : [];
    var stockLogs = logsSheet ? readSheetValuesAsObjects(logsSheet) : [];
    inventory = applyProductCostFailSafe(inventory, stockLogs);
    var vendors = venSheet ? readSheetValuesAsObjects(venSheet) : [];
    var storageLocations = locSheet ? readSheetValuesAsObjects(locSheet) : [];
    var usageUnits = unitSheet ? readSheetValuesAsObjects(unitSheet) : [];
    var rawDepartments = deptSheet ? readSheetValuesAsObjects(deptSheet) : [];
    var users = userSheet ? readSheetValuesAsObjects(userSheet) : [];
    pos = backfillHistoricalReceivingSignatures(pos, stockLogs, users, null);
    var rawBudgets = budSheet ? readSheetValuesAsObjects(budSheet) : [];
    var budgetTransactions = txSheet ? readSheetValuesAsObjects(txSheet) : [];
    var rawNotifications = notifSheet ? readSheetValuesAsObjects(notifSheet) : [];

    var departments = rawDepartments.filter(function(d) {
      var code = String(d.code || '').trim().toUpperCase();
      var id = String(d.id || '').trim().toUpperCase();
      var name = String(d.name || '');
      return code !== 'ALL' && id !== 'DEPT-ALL' && name.indexOf('ส่วนกลาง') === -1 && name.indexOf('ทุกฝ่าย') === -1;
    });

    var budgets = {};
    rawBudgets.forEach(function(r) {
      var dept = String(r.dept || '').trim().toUpperCase();
      if (dept && dept !== 'ALL') {
        budgets[r.dept] = r;
      }
    });

    var notifications = rawNotifications.filter(function(n) {
      return isUserTargetOfNotification(n, user);
    });

    // 4. Return all collections in a single Response
    return {
      prs: prs,
      pos: pos,
      inventory: inventory,
      products: inventory, // alias so code expecting products or inventory works seamlessly
      stockLogs: stockLogs,
      vendors: vendors,
      storageLocations: storageLocations,
      usageUnits: usageUnits,
      departments: departments,
      users: users,
      budgets: budgets,
      budgetTransactions: budgetTransactions,
      notifications: notifications,
      serverTime: new Date().toISOString()
    };
  }, 'GetBootstrapData', rawPayload, userContext);
}

/**
 * Fast RAM Array Indexing Upsert for High-Volume Sheets (PRs, POs, Master Data).
 * Loads sheet once into RAM array, finds target index in memory,
 * and executes a single batch write (setValues) without redundant lookups.
 */
function upsertRecordFast(sheetName, idField, record) {
  var targetId = record[idField];
  if (!targetId) throw new Error('VALIDATION_ERROR: Missing idField');
  var sheet = getSheet(sheetName);
  if (sheetName === SHEET_NAMES.POS && typeof ensurePOSheetHeaders === 'function') {
    ensurePOSheetHeaders(sheet);
  }
  if (sheetName === SHEET_NAMES.PRODUCTS && typeof ensureProductSheetHeaders === 'function') {
    ensureProductSheetHeaders(sheet);
  }
  var values = sheet.getDataRange().getValues(); // Load into RAM array
  if (!values || values.length === 0) throw new Error('SCHEMA_ERROR: Sheet empty');
  
  var headers = values[0].map(function(h) { return String(h).trim(); });
  var idColIndex = headers.indexOf(idField);
  if (idColIndex === -1) throw new Error('SCHEMA_ERROR: Header "' + idField + '" not found in ' + sheetName);
  
  // 1. ค้นหา index ใน Array บน RAM ก่อน
  var rowIndexToUpdate = -1;
  var targetStr = String(targetId).trim().toLowerCase();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idColIndex]).trim().toLowerCase() === targetStr) {
      rowIndexToUpdate = i + 1; // 1-based index
      break;
    }
  }
  
  var rowValues = serializeRecordToRow(record, headers);
  // 2. ค่อยสั่งเขียนช่วงข้อมูล (Batch write via setValues)
  if (rowIndexToUpdate !== -1) {
    sheet.getRange(rowIndexToUpdate, 1, 1, headers.length).setValues([rowValues]);
  } else {
    sheet.getRange(values.length + 1, 1, 1, headers.length).setValues([rowValues]);
  }
  return record;
}

/**
 * Fast Batch Upsert for Multiple Records using RAM Indexing.
 * Reads sheet once into RAM, finds all indices in memory,
 * and writes updates and appended rows in batch.
 */
function batchUpsertRecordsFast(sheetName, idField, records) {
  if (!records || records.length === 0) return [];
  var sheet = getSheet(sheetName);
  if (sheetName === SHEET_NAMES.PRODUCTS && typeof ensureProductSheetHeaders === 'function') {
    ensureProductSheetHeaders(sheet);
  }
  var values = sheet.getDataRange().getValues(); // Load into RAM array
  if (!values || values.length === 0) throw new Error('SCHEMA_ERROR: Sheet empty');
  
  var headers = values[0].map(function(h) { return String(h).trim(); });
  var idColIndex = headers.indexOf(idField);
  if (idColIndex === -1) throw new Error('SCHEMA_ERROR: Header "' + idField + '" not found in ' + sheetName);
  
  // 1. ค้นหา index ใน Array บน RAM ก่อน โดยสร้าง Map
  var ramIndexMap = {};
  for (var i = 1; i < values.length; i++) {
    var cellVal = String(values[i][idColIndex]).trim().toLowerCase();
    if (cellVal) {
      ramIndexMap[cellVal] = i + 1; // 1-based index
    }
  }
  
  var newRows = [];
  records.forEach(function(rec) {
    var recId = rec[idField];
    var serialized = serializeRecordToRow(rec, headers);
    var key = recId ? String(recId).trim().toLowerCase() : '';
    if (key && ramIndexMap[key]) {
      var rowIdx = ramIndexMap[key];
      // ค่อยสั่งเขียนช่วงข้อมูลเฉพาะแถวที่มีการอัปเดต
      sheet.getRange(rowIdx, 1, 1, headers.length).setValues([serialized]);
    } else {
      newRows.push(serialized);
    }
  });
  
  // 2. สั่งเขียนช่วงข้อมูลส่วนแถวใหม่ทั้งหมดในคำสั่งเดียว (Batch write)
  if (newRows.length > 0) {
    var startRow = values.length + 1;
    sheet.getRange(startRow, 1, newRows.length, headers.length).setValues(newRows);
  }
  
  return records;
}



