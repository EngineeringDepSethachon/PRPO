/**
 * @file Config.gs
 * @description Centralized Configuration, Constants, Properties, Department and Permission Helpers for PRPO_PDQC GAS Backend
 * @version 3.0.0
 */

/**
 * Global Configuration Keys & Defaults
 */
const CONFIG = {
  // Script Property Keys
  PROPERTY_KEYS: {
    SPREADSHEET_ID: 'SPREADSHEET_ID',
    DRIVE_ROOT_FOLDER_ID: 'DRIVE_ROOT_FOLDER_ID',
    ADMIN_EMAILS: 'ADMIN_EMAILS',
    APP_ENV: 'APP_ENV',
    SYSTEM_INITIALIZED: 'SYSTEM_INITIALIZED'
  },

  // Fallback defaults
  DEFAULTS: {
    APP_TITLE: '[ERP] ระบบบริหารจัดซื้อ คลังพัสดุ และงบประมาณ (PRPO_PDQC)',
    DRIVE_ROOT_NAME: '[ERP] PR-PO-Stock-System',
    TIMEZONE: 'Asia/Bangkok',
    MAX_FILE_SIZE_BYTES: 20 * 1024 * 1024, // 20 MB max for base64 uploads
    SCRIPT_LOCK_TIMEOUT_MS: 15000 // 15 seconds lock wait
  }
};

/**
 * Alias for application configuration
 */
const APP_CONFIG = CONFIG;

/**
 * Standard Document Prefixes
 */
const DOC_PREFIXES = Object.freeze({
  PR: 'PR',
  PO: 'PO',
  GRN: 'GRN',
  CLAIM: 'CLM',
  STOCK: 'STK'
});

/**
 * Standard Sheet Tab Names (Single-Spreadsheet Architecture)
 */
const SHEET_NAMES = Object.freeze({
  // Master Data
  PRODUCTS: 'Products',
  VENDORS: 'Vendors',
  STORAGE_LOCATIONS: 'StorageLocations',
  USAGE_UNITS: 'UsageUnits',
  DEPARTMENTS: 'Departments',
  USERS: 'Users',
  SIGNATURES: 'Signatures',

  // Transactions
  PRS: 'PRs',
  PR_ITEMS: 'PRItems',
  POS: 'POs',
  STOCK_LOGS: 'StockLogs',
  BUDGET_TRANSACTIONS: 'BudgetTransactions',
  AUDIT_LOGS: 'AuditLogs',
  NOTIFICATIONS: 'Notifications',

  // System & Financial Configuration
  BUDGETS: 'Budgets',
  PR_COUNTERS: 'PRCounters',
  APP_CONFIG: 'AppConfig',
  ATTACHMENTS: 'Attachments'
});

/**
 * Drive Folder Categories matching driveService.js
 */
const DRIVE_CATEGORIES = Object.freeze({
  ROOT: '[ERP] PR-PO-Stock-System',
  PR: '01_PR_Attachments',
  PO: '02_PO_Documents',
  GRN: '03_GRN_Evidence',
  CLAIM: '04_Claim_Evidence',
  BACKUPS: '_Backups'
});

/**
 * Allowed MIME Types for Document/Evidence Upload
 */
const ALLOWED_MIME_TYPES = Object.freeze([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

/**
 * Standard System Roles
 */
const SYSTEM_ROLES = Object.freeze({
  REQUESTER_PD: 'REQUESTER_PD',
  REQUESTER_QC: 'REQUESTER_QC',
  REQUESTER: 'REQUESTER',
  ASST_MANAGER: 'ASST_MANAGER',
  REVIEWER: 'REVIEWER',
  ONLINE_PURCHASER: 'ONLINE_PURCHASER',
  PURCHASER: 'PURCHASER',
  PLANT_MANAGER: 'PLANT_MANAGER',
  APPROVER: 'APPROVER',
  ADMIN: 'ADMIN'
});

/**
 * Styling constants for enterprise look and feel
 */
const HEADER_STYLE = Object.freeze({
  BACKGROUND_COLOR: '#1e293b', // Slate 800
  FONT_COLOR: '#ffffff',
  FONT_FAMILY: 'Prompt, Segoe UI, sans-serif',
  FONT_SIZE: 10,
  FONT_WEIGHT: 'bold'
});

/**
 * Set of identifier column names that must strictly be returned as String
 * to prevent Google Sheets from sending raw numbers that break frontend operations.
 */
const STRING_IDENTIFIER_FIELDS = Object.freeze({
  'id': true,
  'code': true,
  'employeeid': true,
  'phone': true,
  'telephone': true,
  'mobile': true,
  'username': true,
  'prno': true,
  'pono': true,
  'prnumber': true,
  'ponumber': true,
  'docno': true,
  'documentno': true,
  'grnnumber': true,
  'sku': true,
  'vendorcode': true,
  'itemcode': true,
  'productid': true,
  'productcode': true,
  'vendorid': true,
  'locationid': true,
  'roleid': true,
  'storagelocationid': true,
  'usageunitid': true,
  'dept': true,
  'department': true,
  'primarydepartment': true,
  'category': true,
  'status': true,
  'role': true
});

// =========================================================================
// DEPARTMENT & PERMISSION HELPERS
// =========================================================================

/**
 * Universal Department Matcher for Google Apps Script.
 * Matches department codes, IDs, or names across representations (e.g. 'QC' vs 'DEPT-QC', 'ALL', 'BOTH', '*').
 *
 * @param {string|Object} prodDept - Department code/id/object of the entity
 * @param {string|Object} targetDept - Department code/id/object to compare against
 * @returns {boolean}
 */
function matchDepartment(prodDept, targetDept) {
  if (!prodDept || !targetDept) return false;

  var rawTargetStr = typeof targetDept === 'string' ? targetDept.trim().toUpperCase() : '';
  var rawProductStr = typeof prodDept === 'string' ? prodDept.trim().toUpperCase() : '';
  if (rawTargetStr === 'ALL' || rawTargetStr === '*' || rawTargetStr === 'BOTH') return true;
  if (rawProductStr === 'ALL' || rawProductStr === '*' || rawProductStr === 'BOTH') return true;

  var p = String((prodDept && (prodDept.code || prodDept.id)) || prodDept).trim().toUpperCase();

  if (typeof targetDept === 'string') {
    var t = targetDept.trim().toUpperCase();
    return p === t || 
           p.replace(/^DEPT-/, '') === t.replace(/^DEPT-/, '') ||
           p === t.replace(/^DEPT-/, '') ||
           t === p.replace(/^DEPT-/, '');
  }

  var tId = String(targetDept.id || '').trim().toUpperCase();
  var tCode = String(targetDept.code || '').trim().toUpperCase();
  var tName = String(targetDept.name || '').trim().toUpperCase();

  if (tId === 'ALL' || tCode === 'ALL') return true;

  return p === tCode || 
         p === tId || 
         p.replace(/^DEPT-/, '') === tId.replace(/^DEPT-/, '') ||
         p.replace(/^DEPT-/, '') === tCode.replace(/^DEPT-/, '') ||
         (Boolean(tName) && p === tName);
}

/**
 * Alias for matchDepartment matching frontend convention
 */
var isDepartmentMatch = matchDepartment;

/**
 * Extracts all departments accessible to a user.
 * @param {Object} user
 * @returns {string[]}
 */
function getUserDepartments(user) {
  if (!user) return [];
  var rawDepts = [];

  function collect(val) {
    if (!val) return;
    if (Array.isArray(val)) {
      val.forEach(collect);
    } else if (typeof val === 'string') {
      try {
        var parsed = JSON.parse(val);
        if (Array.isArray(parsed)) {
          parsed.forEach(collect);
          return;
        }
      } catch (e) {}
      val.split(',').forEach(function(d) {
        var trimmed = d.trim().toUpperCase();
        if (trimmed) rawDepts.push(trimmed);
      });
    }
  }

  collect(user.department);
  collect(user.primaryDepartment);
  collect(user.departments);
  collect(user.allowedDepartments);

  if (user.role && typeof user.role === 'object') {
    collect(user.role.departments);
    collect(user.role.assignedDepartments);
    collect(user.role.allowedDepartments);
    collect(user.role.department);
  }

  // Deduplicate
  var uniqueDepts = [];
  rawDepts.forEach(function(d) {
    if (uniqueDepts.indexOf(d) === -1) uniqueDepts.push(d);
  });

  var roleId = String(user.roleId || user.canonicalRole || user.role || '').toUpperCase();
  var isAdmin = user.isAdmin === true || roleId === 'ADMIN' || Number(user.level) >= 99 || user.username === 'admin';
  if (uniqueDepts.length === 0 && isAdmin) {
    return ['ALL'];
  }

  return uniqueDepts;
}

/**
 * Checks if a user has access across multiple departments.
 * Returns true if admin, manager, plant manager, purchaser, or user with >1 depts / 'ALL' / '*'.
 * @param {Object} user
 * @returns {boolean}
 */
function isMultiDeptUser(user) {
  if (!user) return false;
  var userDepts = getUserDepartments(user);
  var roleStr = String(user.role || user.roleId || user.canonicalRole || '').toUpperCase();
  return (
    userDepts.length > 1 ||
    roleStr.indexOf('ADMIN') !== -1 ||
    roleStr.indexOf('ASST_MANAGER') !== -1 ||
    roleStr.indexOf('PLANT_MANAGER') !== -1 ||
    roleStr.indexOf('MANAGER') !== -1 ||
    roleStr.indexOf('PURCHAS') !== -1 ||
    userDepts.indexOf('ALL') !== -1 ||
    userDepts.indexOf('BOTH') !== -1 ||
    userDepts.indexOf('*') !== -1 ||
    Boolean(user.canViewAllDepts) ||
    user.isAdmin === true
  );
}

// =========================================================================
// CONFIGURATION, PROPERTIES & DRIVE HELPERS
// =========================================================================

/**
 * Retrieves the active or configured Spreadsheet ID.
 * @returns {string} Spreadsheet ID
 */
function getSpreadsheetId() {
  const props = PropertiesService.getScriptProperties();
  let ssId = props.getProperty(CONFIG.PROPERTY_KEYS.SPREADSHEET_ID);
  
  if (!ssId) {
    try {
      const activeSs = SpreadsheetApp.getActiveSpreadsheet();
      if (activeSs) {
        ssId = activeSs.getId();
        props.setProperty(CONFIG.PROPERTY_KEYS.SPREADSHEET_ID, ssId);
      }
    } catch (e) {
      // Standalone script fallback
    }
  }

  if (!ssId) {
    throw new Error('CONFIG_ERROR: SPREADSHEET_ID is not configured in Script Properties.');
  }

  return ssId;
}

/**
 * Opens and returns the main Google Spreadsheet instance.
 * @returns {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function getSpreadsheet() {
  const id = getSpreadsheetId();
  try {
    return SpreadsheetApp.openById(id);
  } catch (err) {
    throw new Error(`DATABASE_ERROR: Cannot open Spreadsheet with ID "${id}". Error: ${err.message}`);
  }
}

/**
 * Retrieves a specific sheet tab by name, with helpful error reporting.
 * @param {string} sheetName Name of the sheet tab
 * @param {boolean} [autoCreate=false] Create sheet tab if it doesn't exist
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getSheet(sheetName, autoCreate = false) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  
  if (!sheet && autoCreate) {
    sheet = ss.insertSheet(sheetName);
  } else if (!sheet) {
    throw new Error(`SHEET_NOT_FOUND: Sheet tab "${sheetName}" does not exist in spreadsheet.`);
  }

  return sheet;
}

/**
 * Reads a single Script Property with fallback.
 * @param {string} key Property key
 * @param {string} [defaultValue=''] Fallback value
 * @returns {string}
 */
function getScriptProperty(key, defaultValue = '') {
  const val = PropertiesService.getScriptProperties().getProperty(key);
  return val !== null && val !== undefined ? val : defaultValue;
}

/**
 * Writes a single Script Property.
 * @param {string} key Property key
 * @param {string} value Property value
 */
function setScriptProperty(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}

/**
 * Resolves the currently authenticated user's email address.
 * @returns {string} Clean lowercase email address
 */
function getCurrentUserEmail() {
  let email = '';
  try {
    email = Session.getActiveUser().getEmail();
  } catch (e) {
    console.warn('[Config] Session.getActiveUser().getEmail() threw:', e.message);
  }

  if (!email) {
    try {
      email = Session.getEffectiveUser().getEmail();
    } catch (e) {}
  }

  if (!email) {
    email = getScriptProperty('DEV_OVERRIDE_EMAIL', '');
  }

  return (email || '').trim().toLowerCase();
}

/**
 * Returns list of configured Admin Emails (case-insensitive, trimmed).
 * @returns {string[]}
 */
function getAdminEmails() {
  const raw = getScriptProperty(CONFIG.PROPERTY_KEYS.ADMIN_EMAILS, '');
  if (!raw) return [];
  return raw.split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * In-memory cache variables for Drive Root Folder & Subfolders
 */
var _cachedRootFolder = null;
var _cachedRootFolderId = null;
var _driveFolderCache = {};

/**
 * Retrieves or creates the Root Folder for the ERP system.
 * Looks up by configured ID in Script Properties first, or by standard name.
 * Caches in memory to avoid repeated Drive API round-trips.
 * 
 * @returns {GoogleAppsScript.Drive.Folder}
 */
function getRootDriveFolder() {
  if (_cachedRootFolder) {
    return _cachedRootFolder;
  }
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty(CONFIG.PROPERTY_KEYS.DRIVE_ROOT_FOLDER_ID);

  if (folderId) {
    try {
      _cachedRootFolder = DriveApp.getFolderById(folderId);
      _cachedRootFolderId = folderId;
      return _cachedRootFolder;
    } catch (e) {
      console.warn(`[Config] Configured Root Folder ID "${folderId}" invalid. Resolving by name...`);
    }
  }

  const rootName = CONFIG.DEFAULTS.DRIVE_ROOT_NAME;
  const folders = DriveApp.getFoldersByName(rootName);
  let rootFolder;

  if (folders.hasNext()) {
    rootFolder = folders.next();
  } else {
    rootFolder = DriveApp.createFolder(rootName);
    console.info(`[Config] Created new root folder: "${rootName}" (${rootFolder.getId()})`);
  }

  props.setProperty(CONFIG.PROPERTY_KEYS.DRIVE_ROOT_FOLDER_ID, rootFolder.getId());
  _cachedRootFolder = rootFolder;
  _cachedRootFolderId = rootFolder.getId();
  return rootFolder;
}

/**
 * Finds an existing subfolder by name or creates it if missing.
 * Uses an in-execution cache to avoid repeated Drive API round-trips.
 *
 * @param {GoogleAppsScript.Drive.Folder} parentFolder Parent directory
 * @param {string} subFolderName Name of subfolder
 * @returns {GoogleAppsScript.Drive.Folder}
 */
function getOrCreateSubFolder(parentFolder, subFolderName) {
  var cleanName = String(subFolderName).trim();
  var cacheKey = parentFolder.getId() + '::' + cleanName;
  if (_driveFolderCache[cacheKey]) {
    return _driveFolderCache[cacheKey];
  }
  var children = parentFolder.getFoldersByName(cleanName);
  var folder = children.hasNext() ? children.next() : parentFolder.createFolder(cleanName);
  _driveFolderCache[cacheKey] = folder;
  return folder;
}

/**
 * Normalizes user-supplied category string to canonical folder category name.
 * 
 * @param {string} category 
 * @returns {string} Canonical category folder name
 */
function normalizeDriveCategory(category = '') {
  const cat = String(category).toUpperCase().trim();
  if (cat.startsWith('01') || cat.includes('PR')) return DRIVE_CATEGORIES.PR;
  if (cat.startsWith('02') || cat.includes('PO')) return DRIVE_CATEGORIES.PO;
  if (cat.startsWith('03') || cat.includes('GRN') || cat.includes('RECEIV')) return DRIVE_CATEGORIES.GRN;
  if (cat.startsWith('04') || cat.includes('CLAIM') || cat.includes('DISPUTE')) return DRIVE_CATEGORIES.CLAIM;
  if (cat.includes('BACKUP')) return DRIVE_CATEGORIES.BACKUPS;
  return DRIVE_CATEGORIES.PR;
}

/**
 * Resolves the target Google Drive Folder object based on category, date, and PO number.
 * 
 * @param {string} category 'PR' | 'PO' | 'GRN' | 'CLAIM' | 'BACKUPS'
 * @param {string} [poNumber=''] Optional PO Number
 * @param {Date|string} [date] Optional date
 * @returns {{ folder: GoogleAppsScript.Drive.Folder, pathString: string }}
 */
function resolveTargetDriveFolder(category, poNumber = '', date = new Date()) {
  const root = getRootDriveFolder();
  return {
    folder: root,
    pathString: CONFIG.DEFAULTS.DRIVE_ROOT_NAME || 'PR-PO-Stock-System'
  };
}

/**
 * Standard API Response Envelope Builder
 * @param {*} data Payload
 * @param {string} [message='Success'] Success message
 * @returns {Object}
 */
function apiSuccess(data, message = 'Success') {
  return {
    success: true,
    data: data !== undefined ? data : null,
    error: null,
    message: message
  };
}

/**
 * Standard API Error Response Envelope Builder
 * @param {string} errorCode Machine-readable code
 * @param {string} message Human-readable message
 * @param {*} [data=null] Optional error metadata
 * @returns {Object}
 */
function apiError(errorCode, message, data = null) {
  return {
    success: false,
    data: data,
    error: errorCode,
    message: message || 'An unexpected error occurred.'
  };
}
