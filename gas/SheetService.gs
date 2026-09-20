/**
 * @file SheetService.gs
 * @description Concurrency Control, High-Performance CRUD, Header Enforcement, Schema Initializer & Migration Service
 * @version 3.0.0
 */

// =========================================================================
// 1. CONCURRENCY CONTROL & DISTRIBUTED MUTEX LOCKING
// =========================================================================

/**
 * Executes a callback function inside a Google Apps Script ScriptLock mutex.
 * Automatically handles lock acquisition, execution, and guaranteed lock release in `finally`.
 * 
 * @param {Function} callback Function to execute within the critical section
 * @param {number} [timeoutMs=15000] Maximum milliseconds to wait for lock acquisition
 * @param {string} [operationName='Operation'] Descriptive name for log/error context
 * @returns {*} Result of the callback function
 * @throws {Error} If lock acquisition times out or callback throws
 */
function withScriptLock(callback, timeoutMs = 5000, operationName = 'Operation') {
  const lock = LockService.getScriptLock();
  if (lock.hasLock()) {
    return callback();
  }
  let lockAcquired = false;

  try {
    lockAcquired = lock.tryLock(timeoutMs);
    if (!lockAcquired) {
      const errMsg = `LOCK_TIMEOUT: ไม่สามารถทำรายการได้ในขณะนี้เนื่องจากมีผู้ใช้งานอื่นกำลังทำธุรกรรมในส่วน "${operationName}" (รอเกิน ${timeoutMs / 1000} วินาที) กรุณาลองใหม่อีกครั้ง`;
      console.warn(`[LockService] Failed to acquire lock for "${operationName}" after ${timeoutMs}ms.`);
      throw new Error(errMsg);
    }

    console.info(`[LockService] Lock acquired for "${operationName}". Executing critical section...`);
    const result = callback();
    return result;
  } catch (err) {
    console.error(`[LockService] Error during locked operation "${operationName}": ${err.message}`);
    throw err;
  } finally {
    if (lockAcquired) {
      try {
        lock.releaseLock();
        console.info(`[LockService] Lock released for "${operationName}".`);
      } catch (releaseErr) {
        console.warn(`[LockService] Error releasing lock for "${operationName}": ${releaseErr.message}`);
      }
    }
  }
}

/**
 * Executes a callback function inside a DocumentLock mutex (bound to active spreadsheet).
 * 
 * @param {Function} callback Function to execute
 * @param {number} [timeoutMs=10000] Timeout in milliseconds
 * @param {string} [operationName='DocOperation'] Descriptive name
 * @returns {*}
 */
function withDocumentLock(callback, timeoutMs = 10000, operationName = 'DocOperation') {
  const lock = LockService.getDocumentLock();
  if (!lock) {
    return withScriptLock(callback, timeoutMs, operationName);
  }

  let lockAcquired = false;
  try {
    lockAcquired = lock.tryLock(timeoutMs);
    if (!lockAcquired) {
      throw new Error(`DOC_LOCK_TIMEOUT: ระบบกำลังมีผู้ใช้งานอื่นทำรายการ "${operationName}" กรุณาลองใหม่`);
    }
    return callback();
  } finally {
    if (lockAcquired) {
      try { lock.releaseLock(); } catch (e) {}
    }
  }
}

// =========================================================================
// 2. HEADER ENFORCEMENT & DATA SANITIZATION
// =========================================================================

/**
 * Checks if a column name represents an identifier that should be cast to string.
 * @param {string} headerName
 * @returns {boolean}
 */
function isIdentifierColumn(headerName) {
  if (!headerName) return false;
  const lower = String(headerName).trim().toLowerCase();
  if (STRING_IDENTIFIER_FIELDS && STRING_IDENTIFIER_FIELDS[lower]) return true;
  if (lower.endsWith('id') || lower.endsWith('code') || lower.endsWith('no')) return true;
  return false;
}

/**
 * Returns array of header column names from row 1.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {string[]}
 */
function getSheetHeaders(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  const headerValues = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  return headerValues.map(h => String(h).trim()).filter(Boolean);
}

/**
 * Serializes a JavaScript object into a 1D row array matching the given headers.
 * Safely stringifies nested objects and arrays with 50,000 char overflow guard.
 * 
 * @param {Object} record Record object
 * @param {string[]} headers Array of header keys
 * @returns {Array} 1D array of cell values
 */
function serializeRecordToRow(record, headers) {
  const MAX_CELL_LENGTH = 49000; // Google Sheets limit is 50,000 chars per cell

  return headers.map(header => {
    let val = record[header];

    if (val === null || val === undefined) {
      return '';
    }

    if (typeof val === 'boolean') {
      return val;
    }

    if (typeof val === 'number') {
      return val;
    }

    let strVal = '';
    if (typeof val === 'object') {
      try {
        strVal = JSON.stringify(val);
      } catch (e) {
        strVal = String(val);
      }
    } else {
      strVal = String(val);
    }

    // Safety guard against Google Sheets 50,000 characters cell overflow
    if (strVal.length > MAX_CELL_LENGTH) {
      console.warn(`[SheetService] Cell value for header "${header}" exceeds ${MAX_CELL_LENGTH} characters (${strVal.length} chars). Stripping inline Base64 data...`);
      strVal = strVal.replace(/data:(image|application)\/[a-zA-Z0-9.-]+;base64,[A-Za-z0-9+/=]{100,}/g, '');
      
      if (strVal.length > MAX_CELL_LENGTH) {
        console.warn(`[SheetService] Cell value for "${header}" still exceeds limit after regex strip. Truncating to ${MAX_CELL_LENGTH} characters.`);
        strVal = strVal.substring(0, MAX_CELL_LENGTH);
      }
    }

    return strVal;
  });
}

/**
 * Sanitizes PO items before writing to Sheet to avoid exceeding 50,000 chars per cell limit.
 * Strips huge inline base64 image strings while preserving product codes, quantities, and metadata.
 * 
 * @param {Array|string} items
 * @returns {string} JSON string of sanitized items
 */
function sanitizePoItemsForStorage(items) {
  if (!items) return '[]';
  let rawItems = items;
  if (typeof items === 'string') {
    try {
      rawItems = JSON.parse(items);
    } catch (e) {
      return items;
    }
  }

  if (!Array.isArray(rawItems)) return JSON.stringify(rawItems);

  const cleanItems = rawItems.map(it => {
    if (!it || typeof it !== 'object') return it;
    const cleanIt = Object.assign({}, it);

    if (Array.isArray(cleanIt.images)) {
      cleanIt.images = cleanIt.images.map(img => {
        if (img && typeof img === 'object') {
          return {
            name: img.name || 'image',
            size: img.size || 0,
            type: img.type || 'image/jpeg',
            previewUrl: (img.previewUrl && String(img.previewUrl).startsWith('data:')) ? '' : (img.previewUrl || ''),
            url: (img.url && String(img.url).startsWith('data:')) ? '' : (img.url || '')
          };
        }
        return img;
      });
    }

    if (Array.isArray(cleanIt.attachments)) {
      cleanIt.attachments = cleanIt.attachments.map(att => {
        if (att && typeof att === 'object') {
          return {
            name: att.name || 'file',
            size: att.size || 0,
            type: att.type || 'application/octet-stream',
            previewUrl: (att.previewUrl && String(att.previewUrl).startsWith('data:')) ? '' : (att.previewUrl || ''),
            url: (att.url && String(att.url).startsWith('data:')) ? '' : (att.url || '')
          };
        }
        return att;
      });
    }

    return cleanIt;
  });

  return JSON.stringify(cleanItems);
}

/**
 * Formats header row with enterprise styling (dark background, white text, bold, freeze row 1).
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} numColumns
 */
function formatHeaderRow(sheet, numColumns) {
  if (numColumns <= 0) return;
  const headerRange = sheet.getRange(1, 1, 1, numColumns);
  headerRange
    .setBackground(HEADER_STYLE.BACKGROUND_COLOR)
    .setFontColor(HEADER_STYLE.FONT_COLOR)
    .setFontWeight(HEADER_STYLE.FONT_WEIGHT)
    .setFontSize(HEADER_STYLE.FONT_SIZE)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

  sheet.setRowHeight(1, 32);
  sheet.setFrozenRows(1);
}

/**
 * Formats a range of newly appended header cells.
 */
function formatHeaderRange(sheet, row, startCol, numCols) {
  const range = sheet.getRange(row, startCol, 1, numCols);
  range
    .setBackground(HEADER_STYLE.BACKGROUND_COLOR)
    .setFontColor(HEADER_STYLE.FONT_COLOR)
    .setFontWeight(HEADER_STYLE.FONT_WEIGHT)
    .setFontSize(HEADER_STYLE.FONT_SIZE)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
}

var _prItemsSheetEnsured = false;
var _attachmentsSheetEnsured = false;

/**
 * Ensures PRItems sheet tab exists with schema headers and dynamic column sync.
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function ensurePRItemsSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAMES.PR_ITEMS);
  if (_prItemsSheetEnsured && sheet) {
    return sheet;
  }
  const targetHeaders = SCHEMA_DEFINITIONS[SHEET_NAMES.PR_ITEMS];
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.PR_ITEMS);
    sheet.getRange(1, 1, 1, targetHeaders.length).setValues([targetHeaders]);
    formatHeaderRow(sheet, targetHeaders.length);
  } else {
    try {
      const currentHeaders = getSheetHeaders(sheet);
      const missingHeaders = targetHeaders.filter(h => !currentHeaders.includes(h));
      if (missingHeaders.length > 0) {
        const newHeaders = currentHeaders.concat(missingHeaders);
        sheet.getRange(1, 1, 1, newHeaders.length).setValues([newHeaders]);
        formatHeaderRow(sheet, newHeaders.length);
      }
    } catch (e) {
      console.warn('[ensurePRItemsSheet] Header sync warning: ' + e.message);
    }
  }
  _prItemsSheetEnsured = true;
  return sheet;
}

/**
 * Ensures Attachments sheet tab exists with schema headers and dynamic column sync.
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function ensureAttachmentsSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAMES.ATTACHMENTS);
  if (_attachmentsSheetEnsured && sheet) {
    return sheet;
  }
  const targetHeaders = SCHEMA_DEFINITIONS[SHEET_NAMES.ATTACHMENTS];
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.ATTACHMENTS);
    sheet.getRange(1, 1, 1, targetHeaders.length).setValues([targetHeaders]);
    formatHeaderRow(sheet, targetHeaders.length);
  } else {
    try {
      const currentHeaders = getSheetHeaders(sheet);
      const missingHeaders = targetHeaders.filter(h => !currentHeaders.includes(h));
      if (missingHeaders.length > 0) {
        const newHeaders = currentHeaders.concat(missingHeaders);
        sheet.getRange(1, 1, 1, newHeaders.length).setValues([newHeaders]);
        formatHeaderRow(sheet, newHeaders.length);
      }
    } catch (e) {
      console.warn('[ensureAttachmentsSheet] Header sync warning: ' + e.message);
    }
  }
  _attachmentsSheetEnsured = true;
  return sheet;
}

/**
 * Ensures StockLogs sheet contains all required standard header columns.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function ensureStockLogSheetHeaders(sheet) {
  var REQUIRED_HEADERS = [
    'id', 'timestamp', 'date', 'productId', 'productCode', 'name', 'type',
    'documentNo', 'grnNumber', 'poNumber', 'prNo', 'qty', 'unit', 'conversionRate',
    'unitPrice', 'totalPrice', 'unitCost', 'totalCost', 'balanceAfter', 'actorName', 'department', 'locationId', 'notes'
  ];

  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow === 0 || lastCol === 0) {
    sheet.getRange(1, 1, 1, REQUIRED_HEADERS.length).setValues([REQUIRED_HEADERS]);
    formatHeaderRow(sheet, REQUIRED_HEADERS.length);
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
    formatHeaderRange(sheet, 1, startCol, missingHeaders.length);
  }
}

/**
 * Ensures Products sheet contains all required standard header columns,
 * specifically ensuring averageCost and totalValue columns are present.
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 */
function ensureProductSheetHeaders(sheet) {
  var REQUIRED_HEADERS = [
    'id', 'code', 'name', 'category', 'department', 'purchaseUnit', 'stockUnit', 
    'conversionRate', 'price', 'avgCost', 'averageCost', 'stockBalance', 'totalValue', 'reorderPoint', 'leadTimeDays', 
    'locationId', 'locationName', 'status', 'isActive', 'updatedAt'
  ];

  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow === 0 || lastCol === 0) {
    sheet.getRange(1, 1, 1, REQUIRED_HEADERS.length).setValues([REQUIRED_HEADERS]);
    formatHeaderRow(sheet, REQUIRED_HEADERS.length);
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
    formatHeaderRange(sheet, 1, startCol, missingHeaders.length);
  }
}

/**
 * Records an in-app notification event into the Notifications sheet tab.
 * Role & Department based delivery only (no emails).
 * Schema: ['id', 'timestamp', 'title', 'message', 'type', 'targetDepartment', 'targetRole', 'docRef', 'status']
 *
 * @param {Object} params
 * @param {string} params.title Notification headline
 * @param {string} params.message Detailed explanation
 * @param {string} [params.type='INFO'] Notification event type
 * @param {string} [params.targetDept='ALL'] Target Department ('PD', 'QC', 'ALL')
 * @param {string} [params.targetDepartment='ALL'] Alias for targetDept
 * @param {string} [params.targetRole='ALL'] Target Role ('Requester', 'Approver', 'Purchaser', 'ALL')
 * @param {string} [params.docRef=''] Reference document ID (e.g. PR-PD-2026-001, PO-QC-2026-002)
 * @returns {Object|null} Created notification record
 */
function recordNotification(params) {
  if (!params || typeof params !== 'object') return null;
  try {
    var ss = getSpreadsheet();
    var sheetName = SHEET_NAMES.NOTIFICATIONS || 'Notifications';
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    }

    var REQUIRED_HEADERS = [
      'id', 'timestamp', 'title', 'message', 'type', 'targetDepartment', 'targetRole', 'docRef', 'status'
    ];

    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();

    if (lastRow === 0 || lastCol === 0) {
      sheet.getRange(1, 1, 1, REQUIRED_HEADERS.length).setValues([REQUIRED_HEADERS]);
      formatHeaderRow(sheet, REQUIRED_HEADERS.length);
    } else {
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

    var nowIso = new Date().toISOString();
    var notifId = 'NTF-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    var targetDept = params.targetDept || params.targetDepartment || params.department || 'ALL';
    var targetRole = params.targetRole || params.role || 'ALL';
    var docRef = params.docRef || params.refNo || params.poNumber || params.prNumber || params.prNo || params.poNo || '';

    var record = {
      id: notifId,
      timestamp: nowIso,
      title: String(params.title || 'การแจ้งเตือนระบบ'),
      message: String(params.message || ''),
      type: String(params.type || 'INFO'),
      targetDepartment: String(targetDept),
      targetRole: String(targetRole),
      docRef: String(docRef),
      status: 'unread'
    };

    var currentHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function(h) {
      return String(h || '').trim();
    });

    var rowValues = currentHeaders.map(function(header) {
      var val = record[header];
      if (val === undefined) {
        if (header === 'createdAt') val = nowIso;
        if (header === 'isRead') val = false;
        if (header === 'prNumber' && String(docRef).indexOf('PR') !== -1) val = docRef;
        if (header === 'poNumber' && String(docRef).indexOf('PO') !== -1) val = docRef;
      }
      return val !== undefined ? val : '';
    });

    var nextRow = sheet.getLastRow() + 1;
    sheet.getRange(nextRow, 1, 1, rowValues.length).setValues([rowValues]);
    return record;
  } catch (err) {
    console.error('[recordNotification] Error recording notification: ' + err.message);
    return null;
  }
}

// Alias for createNotification
function createNotification(params) {
  return recordNotification(params);
}

// =========================================================================
// 3. BASE CRUD OPERATIONS
// =========================================================================

/**
 * Reads all records from a sheet tab into an array of JavaScript objects.
 * Automatically parses JSON fields, normalizes data types, and strictly casts
 * identifier columns to String.
 * 
 * @param {string} sheetName Name of the sheet tab
 * @returns {Object[]} Array of row objects mapped by header keys
 */
function batchReadRecords(sheetName) {
  const sheet = getSheet(sheetName);
  const dataRange = sheet.getDataRange();
  const values = dataRange.getValues();

  if (!values || values.length <= 1) {
    return []; // Only header or empty
  }

  const headers = values[0].map(h => String(h).trim());
  const records = [];

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const isRowEmpty = row.every(cell => cell === '' || cell === null || cell === undefined);
    if (isRowEmpty) continue;

    const record = {};
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      if (!header) continue;
      
      let val = row[c];
      
      if (isIdentifierColumn(header)) {
        val = (val !== null && val !== undefined) ? String(val).trim() : '';
      } else if (typeof val === 'string' && val.length > 1) {
        const trimmed = val.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || 
            (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
          try {
            val = JSON.parse(trimmed);
          } catch (e) {}
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
 * Alias for batchReadRecords.
 */
function getRowsAsObjects(sheetName) {
  return batchReadRecords(sheetName);
}

/**
 * Writes an array of records to a sheet tab in a single batch operation,
 * completely replacing existing data rows while preserving headers.
 * 
 * @param {string} sheetName Name of the sheet tab
 * @param {Object[]} records Array of objects to write
 * @returns {number} Number of rows written
 */
function batchWriteRecords(sheetName, records = []) {
  const sheet = getSheet(sheetName);
  const headers = getSheetHeaders(sheet);

  if (headers.length === 0) {
    throw new Error(`SCHEMA_ERROR: Sheet "${sheetName}" has no defined header row.`);
  }

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  }

  if (records.length === 0) {
    return 0;
  }

  const rowValues = records.map(record => serializeRecordToRow(record, headers));
  sheet.getRange(2, 1, rowValues.length, headers.length).setValues(rowValues);

  return rowValues.length;
}

/**
 * Appends a single record to the target sheet tab.
 * 
 * @param {string} sheetName Name of the sheet tab
 * @param {Object} record Record object to append
 * @returns {Object} The inserted record
 */
function appendRecord(sheetName, record) {
  const sheet = getSheet(sheetName);
  const headers = getSheetHeaders(sheet);

  if (headers.length === 0) {
    throw new Error(`SCHEMA_ERROR: Sheet "${sheetName}" has no defined header row.`);
  }

  const rowValues = serializeRecordToRow(record, headers);
  const nextRow = sheet.getLastRow() + 1;
  sheet.getRange(nextRow, 1, 1, headers.length).setValues([rowValues]);

  return record;
}

/**
 * Batch appends multiple records to the sheet in a single setValues call.
 * 
 * @param {string} sheetName Name of the sheet tab
 * @param {Object[]} records Array of records to append
 * @returns {number} Number of appended rows
 */
function batchAppendRecords(sheetName, records = []) {
  if (!records || records.length === 0) return 0;

  const sheet = getSheet(sheetName);
  const headers = getSheetHeaders(sheet);
  const rowValues = records.map(rec => serializeRecordToRow(rec, headers));

  const startRow = sheet.getLastRow() + 1;
  sheet.getRange(startRow, 1, rowValues.length, headers.length).setValues(rowValues);

  return rowValues.length;
}

/**
 * Inserts or updates a record by a unique identifier key.
 * 
 * @param {string} sheetName Name of the sheet tab
 * @param {string} idField Column name representing unique key (e.g. 'id', 'poNo')
 * @param {Object} record The record payload
 * @returns {Object} Upserted record with status
 */
function upsertRecordById(sheetName, idField, record) {
  const targetId = record[idField];
  if (!targetId) {
    throw new Error(`VALIDATION_ERROR: Record missing required unique key "${idField}".`);
  }

  const sheet = getSheet(sheetName);
  const headers = getSheetHeaders(sheet);
  const idColIndex = headers.indexOf(idField);

  if (idColIndex === -1) {
    throw new Error(`SCHEMA_ERROR: Header "${idField}" not found in sheet "${sheetName}".`);
  }

  const lastRow = sheet.getLastRow();
  let rowIndexToUpdate = -1;

  if (lastRow > 1) {
    const idValues = sheet.getRange(2, idColIndex + 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < idValues.length; i++) {
      if (String(idValues[i][0]).trim() === String(targetId).trim()) {
        rowIndexToUpdate = i + 2;
        break;
      }
    }
  }

  const rowValues = serializeRecordToRow(record, headers);

  if (rowIndexToUpdate !== -1) {
    sheet.getRange(rowIndexToUpdate, 1, 1, headers.length).setValues([rowValues]);
  } else {
    const nextRow = sheet.getLastRow() + 1;
    sheet.getRange(nextRow, 1, 1, headers.length).setValues([rowValues]);
  }

  return record;
}

/**
 * Deletes a row matching the given unique key.
 * 
 * @param {string} sheetName Name of the sheet tab
 * @param {string} idField Column name representing unique key
 * @param {string|number} idValue Value to match
 * @returns {boolean} True if a row was found and deleted
 */
function deleteRecordById(sheetName, idField, idValue) {
  const sheet = getSheet(sheetName);
  const headers = getSheetHeaders(sheet);
  const idColIndex = headers.indexOf(idField);

  if (idColIndex === -1) {
    throw new Error(`SCHEMA_ERROR: Header "${idField}" not found in sheet "${sheetName}".`);
  }

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow <= 1) return false;

  const allRows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const targetVal = String(idValue).trim();
  const remainingRows = [];
  let found = false;

  for (let i = 0; i < allRows.length; i++) {
    if (!found && String(allRows[i][idColIndex]).trim() === targetVal) {
      found = true;
      continue;
    }
    remainingRows.push(allRows[i]);
  }

  if (found) {
    sheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();
    if (remainingRows.length > 0) {
      sheet.getRange(2, 1, remainingRows.length, lastCol).setValues(remainingRows);
    }
  }

  return found;
}

// =========================================================================
// 4. SEQUENTIAL ID GENERATOR & INITIAL CLIENT HYDRATION
// =========================================================================

/**
 * Thread-safe Sequential ID Generator with LockService mutex.
 * 
 * @param {string} department 'PD' | 'QC' | 'WH' | 'ALL'
 * @param {string} docType 'PO' | 'PR'
 * @returns {string} Generated sequential document number
 */
function generateSequentialDocId(department, docType) {
  const dept = String(department || 'ALL').toUpperCase().trim();
  const type = String(docType || 'PO').toUpperCase().trim();
  const currentYear = new Date().getFullYear();

  return withScriptLock(function() {
    const sheet = getSheet(SHEET_NAMES.PR_COUNTERS);
    const records = batchReadRecords(SHEET_NAMES.PR_COUNTERS);

    let counterRecord = records.find(r => 
      String(r.dept).toUpperCase() === dept && 
      String(r.docType).toUpperCase() === type &&
      Number(r.year || currentYear) === currentYear
    );

    let nextNumber = 1;

    if (counterRecord) {
      nextNumber = Number(counterRecord.lastNumber || 0) + 1;
      counterRecord.lastNumber = nextNumber;
      counterRecord.updatedAt = new Date().toISOString();
      upsertRecordById(SHEET_NAMES.PR_COUNTERS, 'dept', counterRecord);
    } else {
      counterRecord = {
        dept: dept,
        docType: type,
        lastNumber: 1,
        prefix: type,
        year: currentYear,
        updatedAt: new Date().toISOString()
      };
      appendRecord(SHEET_NAMES.PR_COUNTERS, counterRecord);
    }

    const seqStr = String(nextNumber).padStart(3, '0');

    if (type === 'PO') {
      return `PO-${dept}-${currentYear}-${seqStr}`;
    } else if (type === 'PR') {
      return `${dept}${seqStr}/${currentYear}`;
    }

    return `${type}-${dept}-${currentYear}-${seqStr}`;
  }, CONFIG.DEFAULTS.SCRIPT_LOCK_TIMEOUT_MS, `GenerateSequentialId_${type}_${dept}`);
}

/**
 * High-performance batch aggregator for initial client hydration.
 * @returns {Object} Hydrated initial payload
 */
function getInitialPayloadBatch() {
  if (getScriptProperty('ALL_DEPARTMENT_PURGED_V1') !== 'true') {
    try {
      if (typeof purgeAllDepartmentEntity === 'function') {
        purgeAllDepartmentEntity();
      }
    } catch (migErr) {
      console.warn('[SheetService] purgeAllDepartmentEntity note:', migErr.message);
    }
  }

  const products = batchReadRecords(SHEET_NAMES.PRODUCTS);
  const vendors = batchReadRecords(SHEET_NAMES.VENDORS);
  const locations = batchReadRecords(SHEET_NAMES.STORAGE_LOCATIONS);
  const units = batchReadRecords(SHEET_NAMES.USAGE_UNITS);
  const rawDepartments = batchReadRecords(SHEET_NAMES.DEPARTMENTS);
  const users = batchReadRecords(SHEET_NAMES.USERS);
  const prs = batchReadRecords(SHEET_NAMES.PRS);
  const pos = batchReadRecords(SHEET_NAMES.POS);
  const stockLogs = batchReadRecords(SHEET_NAMES.STOCK_LOGS);
  const rawBudgets = batchReadRecords(SHEET_NAMES.BUDGETS);
  const budgetTransactions = batchReadRecords(SHEET_NAMES.BUDGET_TRANSACTIONS);
  const auditLogs = batchReadRecords(SHEET_NAMES.AUDIT_LOGS);
  const notifications = batchReadRecords(SHEET_NAMES.NOTIFICATIONS);
  const signatures = batchReadRecords(SHEET_NAMES.SIGNATURES);

  const departments = rawDepartments.filter(d => {
    const code = String(d.code || '').trim().toUpperCase();
    const id = String(d.id || '').trim().toUpperCase();
    const name = String(d.name || '');
    return code !== 'ALL' && id !== 'DEPT-ALL' && !name.includes('ส่วนกลาง') && !name.includes('ทุกฝ่าย');
  });

  const budgets = {};
  rawBudgets.forEach(r => {
    const dept = String(r.dept || '').trim().toUpperCase();
    if (dept && dept !== 'ALL') {
      budgets[r.dept] = r;
    }
  });

  return {
    products: products,
    vendors: vendors,
    storageLocations: locations,
    usageUnits: units,
    departments: departments,
    users: users,
    prs: prs,
    pos: pos,
    stockLogs: stockLogs,
    budgets: budgets,
    budgetTransactions: budgetTransactions,
    auditLogs: auditLogs,
    notifications: notifications,
    signatures: signatures,
    serverTime: new Date().toISOString()
  };
}

// =========================================================================
// 5. MASTER DATA CRUD & DEPARTMENT-SCOPED DUPLICATE VALIDATION
// =========================================================================

/**
 * Resolves standard sheet tab name from arbitrary collection key.
 * @param {string} collection
 * @returns {string} Standard SHEET_NAMES tab name
 */
function resolveMasterSheetName(collection) {
  const norm = String(collection || '').trim().toLowerCase().replace(/[-_]/g, '');
  if (norm === 'products' || norm === 'product') return SHEET_NAMES.PRODUCTS;
  if (norm === 'vendors' || norm === 'vendor') return SHEET_NAMES.VENDORS;
  if (norm === 'storagelocations' || norm === 'storagelocation' || norm === 'locations' || norm === 'location') return SHEET_NAMES.STORAGE_LOCATIONS;
  if (norm === 'usageunits' || norm === 'usageunit' || norm === 'units' || norm === 'unit') return SHEET_NAMES.USAGE_UNITS;
  if (norm === 'departments' || norm === 'department') return SHEET_NAMES.DEPARTMENTS;
  if (norm === 'users' || norm === 'user') return SHEET_NAMES.USERS;
  throw new Error(`UNKNOWN_COLLECTION: ไม่พบคอลเลกชัน "${collection}"`);
}

/**
 * Universal Master Item Saver with Duplicate Code Validation.
 * Strictly maintains composite key uniqueness (Department + Code) for products/vendors.
 * 
 * @param {string} collection Collection identifier ('Products', 'Vendors', etc.)
 * @param {Object} item Record to save
 * @returns {Object} Saved item or error envelope
 */
function saveMasterItem(collection, item) {
  if (!item || typeof item !== 'object') {
    throw new Error('VALIDATION_ERROR: ข้อมูลที่ส่งมาไม่ถูกต้อง');
  }

  const sheetName = resolveMasterSheetName(collection);
  const now = new Date().toISOString();
  const rawCode = item.code || item.sku || item.vendorCode || '';
  const itemCode = String(rawCode).trim().toUpperCase();

  if (sheetName === SHEET_NAMES.DEPARTMENTS && itemCode === 'ALL') {
    return {
      success: false,
      error: 'ไม่อนุญาตให้ใช้รหัส "ALL" เป็นแผนกจริงในระบบ',
      message: 'ไม่อนุญาตให้ใช้รหัส "ALL" เป็นแผนกจริงในระบบ'
    };
  }

  // 1. Duplicate code validation scoped by department (Composite Key: Department + Code)
  if (itemCode) {
    const existingRecords = batchReadRecords(sheetName);
    const isDuplicate = existingRecords.some(r => {
      const rId = String(r.id || '').trim();
      const rCode = String(r.code || r.sku || r.vendorCode || '').trim().toUpperCase();
      if (item.id && rId === String(item.id).trim()) {
        return false;
      }
      if (rCode !== itemCode) return false;

      if (sheetName === SHEET_NAMES.PRODUCTS) {
        const isSameDept = matchDepartment(r.department || r.category || r.dept, item.department || item.category || item.dept);
        return isSameDept;
      } else if (sheetName === SHEET_NAMES.VENDORS) {
        const rDept = String(r.department || 'ALL').trim().toUpperCase();
        const itemDept = String(item.department || 'ALL').trim().toUpperCase();
        const isSameScope = (rDept === 'ALL' || itemDept === 'ALL' || matchDepartment(rDept, itemDept));
        return isSameScope;
      }

      return true;
    });

    if (isDuplicate) {
      return { 
        success: false, 
        error: 'รหัสนี้มีอยู่ในระบบแล้ว กรุณาใช้รหัสอื่น',
        message: 'รหัสนี้มีอยู่ในระบบแล้ว กรุณาใช้รหัสอื่น'
      };
    }
  }

  // 2. Generate unique ID if new item
  if (!item.id) {
    const suffix = Date.now().toString().slice(-4);
    if (sheetName === SHEET_NAMES.PRODUCTS) {
      const cat = item.category || item.department || 'PD';
      item.id = `PROD-${cat}-${suffix}`;
    } else if (sheetName === SHEET_NAMES.VENDORS) {
      item.id = `VEN-${suffix}`;
    } else if (sheetName === SHEET_NAMES.STORAGE_LOCATIONS) {
      const dept = item.department || 'ALL';
      item.id = `LOC-${dept}-${suffix}`;
    } else if (sheetName === SHEET_NAMES.USAGE_UNITS) {
      const dept = item.department || 'PD';
      item.id = `UNIT-${dept}-${suffix}`;
    } else {
      item.id = `ID-${suffix}`;
    }
    item.createdAt = item.createdAt || now;
  }

  item.updatedAt = now;
  if (item.status === undefined && item.isActive === undefined) {
    item.status = 'ACTIVE';
    item.isActive = true;
  }

  // 3. Upsert record to Google Sheet
  upsertRecordById(sheetName, 'id', item);

  return {
    success: true,
    data: item,
    message: 'บันทึกข้อมูลเรียบร้อยแล้ว'
  };
}

/**
 * Universal Master Item Deletion by ID.
 * 
 * @param {string} collection Collection identifier ('Products', 'Vendors', etc.)
 * @param {string} id Unique identifier to delete
 * @returns {Object} Result object
 */
function deleteMasterItem(collection, id) {
  if (!id) {
    throw new Error('VALIDATION_ERROR: ไม่ได้ระบุ ID สำหรับการลบ');
  }

  const sheetName = resolveMasterSheetName(collection);
  let deleted = deleteRecordById(sheetName, 'id', id);

  if (!deleted && (sheetName === SHEET_NAMES.PRODUCTS || sheetName === SHEET_NAMES.VENDORS)) {
    deleted = deleteRecordById(sheetName, 'code', id);
  }

  return {
    success: true,
    data: { deleted: true, id: id, collection: sheetName },
    message: 'ลบข้อมูลเรียบร้อยแล้ว'
  };
}

// =========================================================================
// 6. SCHEMA DEFINITIONS, SEED DATA & SYSTEM INITIALIZATION / MIGRATION
// =========================================================================

/**
 * Master Schema Definition for All 17 Tabs
 */
const SCHEMA_DEFINITIONS = Object.freeze({
  [SHEET_NAMES.PRODUCTS]: [
    'id', 'code', 'name', 'category', 'department', 'purchaseUnit', 'stockUnit', 
    'conversionRate', 'price', 'avgCost', 'averageCost', 'stockBalance', 'totalValue', 'reorderPoint', 'leadTimeDays', 
    'locationId', 'locationName', 'status', 'isActive', 'updatedAt'
  ],
  [SHEET_NAMES.VENDORS]: [
    'id', 'code', 'name', 'department', 'contactPerson', 'phone', 'email', 
    'taxId', 'address', 'status', 'isActive', 'updatedAt'
  ],
  [SHEET_NAMES.STORAGE_LOCATIONS]: [
    'id', 'name', 'department', 'isActive', 'updatedAt'
  ],
  [SHEET_NAMES.USAGE_UNITS]: [
    'id', 'name', 'department', 'status', 'isActive', 'updatedAt'
  ],
  [SHEET_NAMES.DEPARTMENTS]: [
    'id', 'code', 'name', 'isActive', 'createdAt'
  ],
  [SHEET_NAMES.USERS]: [
    'id', 'employeeId', 'username', 'password', 'email', 'name', 'employeeName', 'displayName', 'position',
    'department', 'primaryDepartment', 'departments', 'allowedDepartments', 
    'roleId', 'canonicalRole', 'level', 'status', 'isActive', 'description', 'signature', 'updatedAt'
  ],
  [SHEET_NAMES.SIGNATURES]: [
    'roleId', 'name', 'signatureUrl', 'updatedAt', 'updatedBy'
  ],
  [SHEET_NAMES.PRS]: [
    'id', 'prNo', 'department', 'requestedBy', 'requesterSignature', 'status', 
    'items', 'subtotal', 'totalAmount', 'createdAt', 'updatedAt', 'reviewedBy', 
    'reviewedAt', 'approvedBy', 'approvedAt', 'poNumber', 'note',
    'budgetPeriod', 'committedAmount', 'actualPaidAmount', 'paymentStatus'
  ],
  [SHEET_NAMES.PR_ITEMS]: [
    'id', 'prId', 'prNo', 'productId', 'productCode', 'name', 
    'purchaseUnit', 'stockUnit', 'conversionRate', 'qty', 'unit', 
    'price', 'totalPrice', 'department', 'notes', 'status', 
    'imageUrl', 'fileId', 'driveUrl', 'images', 'attachments',
    'createdAt', 'updatedAt'
  ],
  [SHEET_NAMES.POS]: [
    'id', 'poNo', 'prId', 'prNo', 'department', 'vendorName', 'vendorId', 
    'purchaseChannel', 'issueDate', 'orderDate', 'status', 'workflowStatus', 
    'items', 'subtotal', 'vat', 'grandTotal', 'isOnline', 'isClosed', 
    'claimStatus', 'ngItems', 'reviewedBy', 'reviewedAt', 'approvedBy', 
    'approvedAt', 'receivedBy', 'receiverName', 'receiverId', 'receivedAt', 
    'receiverRole', 'receiverSignature', 'receivingInfo', 'actualTotalAmount', 
    'savingsAmount', 'settlementStatus', 'settlementNote', 'settlementProofUrl', 
    'settledBy', 'settledAt', 'actualItems', 'activityLog', 
    'createdAt', 'completedAt', 'updatedAt',
    'budgetPeriod', 'committedAmount', 'actualPaidAmount', 'paymentStatus',
    'claimEvidence', 'disputeInfo', 'claimData', 'claimDetails', 'claimReason', 'claimDescription'
  ],
  [SHEET_NAMES.STOCK_LOGS]: [
    'id', 'timestamp', 'date', 'type', 'productId', 'productCode', 'productName', 'name',
    'department', 'location', 'changeQty', 'qty', 'unit', 'conversionRate',
    'unitPrice', 'totalPrice', 'unitCost', 'totalCost', 'balanceAfter', 'balance',
    'issuedTo', 'issueUnit', 'reason', 'notes',
    'documentNo', 'grnNumber', 'poNumber', 'prNo',
    'actorId', 'actorName', 'locationId'
  ],

  [SHEET_NAMES.BUDGET_TRANSACTIONS]: [
    'id', 'date', 'createdAt', 'transactionId', 'period', 'type', 'actionType', 
    'dept', 'amount', 'refundAmount', 'creditAmount', 'docType', 'docNo', 
    'poNumber', 'actorName', 'actorRole', 'note', 'timestamp'
  ],
  [SHEET_NAMES.AUDIT_LOGS]: [
    'id', 'timestamp', 'action', 'module', 'targetRef', 'summary', 
    'actor', 'changes', 'createdAt'
  ],
  [SHEET_NAMES.NOTIFICATIONS]: [
    'id', 'timestamp', 'title', 'message', 'type', 'targetDepartment', 'targetRole', 'docRef', 'status'
  ],
  [SHEET_NAMES.BUDGETS]: [
    'dept', 'monthlyBudget', 'spent', 'pending', 'variance', 'year', 'month', 
    'historicalSpent', 'history', 'refundCredits', 'updatedAt'
  ],
  [SHEET_NAMES.PR_COUNTERS]: [
    'dept', 'docType', 'lastNumber', 'prefix', 'year', 'updatedAt'
  ],
  [SHEET_NAMES.APP_CONFIG]: [
    'key', 'value', 'description', 'updatedAt'
  ],
  [SHEET_NAMES.ATTACHMENTS]: [
    'id', 'fileId', 'fileName', 'mimeType', 'fileSize', 'category', 'poNumber', 
    'docNo', 'docType', 'viewUrl', 'directUrl', 'lh3Url', 'downloadUrl', 'folderPath', 'uploadedBy', 'uploadedAt'
  ]
});

/**
 * Baseline Seed Master Data for Initial System Setup
 */
const SEED_DATA = {
  DEPARTMENTS: [
    { id: 'DEPT-PD', code: 'PD', name: 'ฝ่ายผลิต', isActive: true, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'DEPT-QC', code: 'QC', name: 'ฝ่ายควบคุมคุณภาพ', isActive: true, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'DEPT-WH', code: 'WH', name: 'ฝ่ายคลังสินค้า', isActive: true, createdAt: '2026-01-01T00:00:00.000Z' }
  ],

  STORAGE_LOCATIONS: [
    { id: 'LOC-PD-001', name: 'ชั้นวาง A-01 (สารหล่อลื่น & น้ำมัน)', department: 'PD', isActive: true },
    { id: 'LOC-PD-002', name: 'ชั้นวาง A-02 (อะไหล่เครื่องจักร & สายพาน)', department: 'PD', isActive: true },
    { id: 'LOC-PD-003', name: 'ตู้เก็บอุปกรณ์ความปลอดภัย (PPE)', department: 'PD', isActive: true },
    { id: 'LOC-PD-004', name: 'ห้องแพ็คเกจจิ้ง', department: 'PD', isActive: true },
    { id: 'LOC-QC-001', name: 'ตู้เก็บสารเคมีทดสอบ (Lab 1)', department: 'QC', isActive: true },
    { id: 'LOC-QC-002', name: 'ชั้นวางอาหารเลี้ยงเชื้อ (Media Shelf B)', department: 'QC', isActive: true },
    { id: 'LOC-QC-003', name: 'ตู้เก็บตัวอย่างควบคุม (Retain Sample Room)', department: 'QC', isActive: true },
    { id: 'LOC-QC-004', name: 'ห้องปฏิบัติการกลาง (Central Lab)', department: 'QC', isActive: true }
  ],

  USAGE_UNITS: [
    { id: 'UNIT-PD-001', name: 'ห้อง K1', department: 'PD', status: 'ACTIVE', isActive: true },
    { id: 'UNIT-PD-002', name: 'ห้อง K2', department: 'PD', status: 'ACTIVE', isActive: true },
    { id: 'UNIT-PD-003', name: 'ห้องผลไม้', department: 'PD', status: 'ACTIVE', isActive: true },
    { id: 'UNIT-PD-004', name: 'ห้องสลัด', department: 'PD', status: 'ACTIVE', isActive: true },
    { id: 'UNIT-PD-005', name: 'ห้องล้าง/เตรียมผัก', department: 'PD', status: 'ACTIVE', isActive: true },
    { id: 'UNIT-PD-006', name: 'ห้องเตรียมวัตถุดิบ 1', department: 'PD', status: 'ACTIVE', isActive: true },
    { id: 'UNIT-PD-007', name: 'ห้องพาสเจอร์ไรซ์ (Hot Process)', department: 'PD', status: 'ACTIVE', isActive: true },
    { id: 'UNIT-PD-008', name: 'ห้องบรรจุขวด/แพ็คเกจจิ้ง (Aseptic Filling)', department: 'PD', status: 'ACTIVE', isActive: true },
    { id: 'UNIT-QC-001', name: 'ห้อง Lab 1 (เคมี)', department: 'QC', status: 'ACTIVE', isActive: true },
    { id: 'UNIT-QC-002', name: 'ห้อง Lab 2 (จุลชีววิทยา)', department: 'QC', status: 'ACTIVE', isActive: true }
  ],

  USERS: [
    {
      id: 'USR-0001',
      employeeId: 'EMP-PD-001',
      username: 'siraphat.pd',
      email: '',
      name: 'สิรภัทร แจ่มมิน',
      employeeName: 'สิรภัทร แจ่มมิน',
      displayName: 'สิรภัทร แจ่มมิน',
      position: 'เจ้าหน้าที่ฝ่ายผลิต',
      department: 'PD',
      primaryDepartment: 'PD',
      departments: ['PD'],
      allowedDepartments: ['PD'],
      roleId: 'REQUESTER_PD',
      canonicalRole: 'REQUESTER',
      level: 1,
      status: 'ACTIVE',
      isActive: true,
      description: 'สร้าง/ส่ง PR ฝ่ายผลิต, เบิกจ่ายสินค้า, ตรวจรับของเข้าสต็อก'
    },
    {
      id: 'USR-0002',
      employeeId: 'EMP-QC-001',
      username: 'natthinee.qc',
      email: '',
      name: 'ณัฐธินีย์ สอนครบบุรี',
      employeeName: 'ณัฐธินีย์ สอนครบบุรี',
      displayName: 'ณัฐธินีย์ สอนครบบุรี',
      position: 'เจ้าหน้าที่ฝ่ายควบคุมคุณภาพ (QC)',
      department: 'QC',
      primaryDepartment: 'QC',
      departments: ['QC'],
      allowedDepartments: ['QC'],
      roleId: 'REQUESTER_QC',
      canonicalRole: 'REQUESTER',
      level: 1,
      status: 'ACTIVE',
      isActive: true,
      description: 'สร้าง/ส่ง PR ฝ่าย QC/Lab, เบิกจ่ายสารเคมี, ตรวจรับของ'
    },
    {
      id: 'USR-0003',
      employeeId: 'EMP-MGR-001',
      username: 'kallayani.mgr',
      email: '',
      name: 'กัลยาณี พลไกร',
      employeeName: 'กัลยาณี พลไกร',
      displayName: 'กัลยาณี พลไกร',
      position: 'ผู้ช่วยผู้จัดการฝ่ายผลิต (Asst. Manager)',
      department: 'PD',
      primaryDepartment: 'PD',
      departments: ['PD', 'QC'],
      allowedDepartments: ['PD', 'QC'],
      roleId: 'ASST_MANAGER',
      canonicalRole: 'REVIEWER',
      level: 2,
      status: 'ACTIVE',
      isActive: true,
      description: 'ตรวจทาน PR (Level 1 Reviewer)'
    },
    {
      id: 'USR-0004',
      employeeId: 'EMP-PUR-001',
      username: 'nat.on',
      email: '',
      name: 'คุณนัท จัดซื้อ',
      employeeName: 'คุณนัท จัดซื้อ',
      displayName: 'คุณนัท จัดซื้อ',
      position: 'เจ้าหน้าที่จัดซื้อออนไลน์',
      department: 'PUR',
      primaryDepartment: 'PUR',
      departments: ['PD', 'QC', 'WH', 'PUR', 'ENG'],
      allowedDepartments: ['*'],
      roleId: 'ONLINE_PURCHASER',
      canonicalRole: 'PURCHASER',
      level: 2,
      status: 'ACTIVE',
      isActive: true,
      description: 'จัดการสั่งซื้อออนไลน์ Shopee/Lazada'
    },
    {
      id: 'USR-0005',
      employeeId: 'EMP-MGR-002',
      username: 'prasert.pm',
      email: '',
      name: 'คุณประเสริฐ ยิ่งยง',
      employeeName: 'คุณประเสริฐ ยิ่งยง',
      displayName: 'คุณประเสริฐ ยิ่งยง',
      position: 'ผู้จัดการโรงงาน (Plant Manager)',
      department: 'MGT',
      primaryDepartment: 'MGT',
      departments: ['PD', 'QC', 'WH', 'PUR', 'ENG'],
      allowedDepartments: ['*'],
      roleId: 'PLANT_MANAGER',
      canonicalRole: 'APPROVER',
      level: 3,
      status: 'ACTIVE',
      isActive: true,
      description: 'อนุมัติสั่งซื้อ (Final Approver)'
    },
    {
      id: 'USR-0006',
      employeeId: 'EMP-SYS-999',
      username: 'admin',
      email: '',
      name: 'ผู้ดูแลระบบ',
      employeeName: 'ผู้ดูแลระบบ',
      displayName: 'ผู้ดูแลระบบ',
      position: 'ผู้ดูแลระบบ (Admin)',
      department: 'MGT',
      primaryDepartment: 'MGT',
      departments: ['*'],
      allowedDepartments: ['*'],
      roleId: 'ADMIN',
      canonicalRole: 'ADMIN',
      level: 99,
      status: 'ACTIVE',
      isActive: true,
      description: 'ผู้ดูแลระบบ สิทธิ์สูงสุด'
    }
  ],

  BUDGETS: [
    {
      dept: 'PD',
      monthlyBudget: 1000000,
      spent: 0,
      pending: 0,
      variance: 1000000,
      year: 2026,
      month: 9,
      historicalSpent: { '2026-09': 0 },
      history: { '2026-09': 1000000 },
      refundCredits: { '2026-09': 817 },
      updatedAt: new Date().toISOString()
    },
    {
      dept: 'QC',
      monthlyBudget: 150050,
      spent: 0,
      pending: 0,
      variance: 150000,
      year: 2026,
      month: 9,
      historicalSpent: { '2026-09': 0 },
      history: { '2026-09': 150000 },
      refundCredits: {},
      updatedAt: new Date().toISOString()
    },
    {
      dept: 'WH',
      monthlyBudget: 120000,
      spent: 0,
      pending: 0,
      variance: 120000,
      year: 2026,
      month: 9,
      historicalSpent: { '2026-09': 0 },
      history: { '2026-09': 120000 },
      refundCredits: {},
      updatedAt: new Date().toISOString()
    }
  ],

  PR_COUNTERS: [
    { dept: 'PD', docType: 'PR', lastNumber: 2, prefix: 'PD', year: 2026, updatedAt: new Date().toISOString() },
    { dept: 'PD', docType: 'PO', lastNumber: 2, prefix: 'PO', year: 2026, updatedAt: new Date().toISOString() },
    { dept: 'QC', docType: 'PR', lastNumber: 0, prefix: 'QC', year: 2026, updatedAt: new Date().toISOString() },
    { dept: 'QC', docType: 'PO', lastNumber: 0, prefix: 'PO', year: 2026, updatedAt: new Date().toISOString() }
  ],

  PRODUCTS: [
    // ─── PRODUCTION (PD) ITEMS (10 Items) ───
    {
      id: 'PROD-PD-001',
      code: 'PD-OIL-068',
      name: 'น้ำมันไฮดรอลิกอุตสาหกรรม (Hydraulic Oil ISO VG 68)',
      category: 'PD',
      department: 'PD',
      purchaseUnit: 'ถัง (200L)',
      stockUnit: 'ลิตร',
      conversionRate: 200,
      price: 14500,
      stockBalance: 2400,
      reorderPoint: 1000,
      leadTimeDays: 5,
      locationId: 'LOC-PD-001',
      locationName: 'ชั้นวาง A-01 (สารหล่อลื่น & น้ำมัน)',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'PROD-PD-002',
      code: 'PD-GRS-002',
      name: 'จาระบีทนความร้อนสูงเกรดอาหาร (High-Temp Food Grade Grease NLGI 2)',
      category: 'PD',
      department: 'PD',
      purchaseUnit: 'กล่อง (12 กระป๋อง)',
      stockUnit: 'กระป๋อง',
      conversionRate: 12,
      price: 9600,
      stockBalance: 25,
      reorderPoint: 10,
      leadTimeDays: 3,
      locationId: 'LOC-PD-001',
      locationName: 'ชั้นวาง A-01 (สารหล่อลื่น & น้ำมัน)',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'PROD-PD-003',
      code: 'PD-BLT-380',
      name: 'สายพานลำเลียงทนความร้อน (Timing Belt 380-5M-15)',
      category: 'PD',
      department: 'PD',
      purchaseUnit: 'เส้น',
      stockUnit: 'เส้น',
      conversionRate: 1,
      price: 620,
      stockBalance: 6,
      reorderPoint: 8,
      leadTimeDays: 7,
      locationId: 'LOC-PD-002',
      locationName: 'ชั้นวาง A-02 (อะไหล่เครื่องจักร & สายพาน)',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'PROD-PD-004',
      code: 'PD-GLV-NBR',
      name: 'ถุงมือไนไตรล์ป้องกันสารเคมี (Nitrile Chemical Resistant Gloves Size L)',
      category: 'PD',
      department: 'PD',
      purchaseUnit: 'กล่อง (100 ชิ้น)',
      stockUnit: 'ชิ้น',
      conversionRate: 100,
      price: 320,
      stockBalance: 2000,
      reorderPoint: 750,
      leadTimeDays: 3,
      locationId: 'LOC-PD-003',
      locationName: 'ตู้เก็บอุปกรณ์ความปลอดภัย (PPE)',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'PROD-PD-005',
      code: 'PD-CLN-IND',
      name: 'น้ำยาทำความสะอาดคราบน้ำมันเครื่องจักร (Heavy Duty Degreaser Cleaner)',
      category: 'PD',
      department: 'PD',
      purchaseUnit: 'แกลลอน (20L)',
      stockUnit: 'ลิตร',
      conversionRate: 20,
      price: 1850,
      stockBalance: 360,
      reorderPoint: 120,
      leadTimeDays: 4,
      locationId: 'LOC-PD-001',
      locationName: 'ชั้นวาง A-01 (สารหล่อลื่น & น้ำมัน)',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'PROD-PD-006',
      code: 'PD-FLT-050',
      name: 'ไส้กรองน้ำมันระบบหล่อเย็น (Coolant Cartridge Filter 50 Micron)',
      category: 'PD',
      department: 'PD',
      purchaseUnit: 'กล่อง (10 ชิ้น)',
      stockUnit: 'ชิ้น',
      conversionRate: 10,
      price: 4200,
      stockBalance: 30,
      reorderPoint: 12,
      leadTimeDays: 5,
      locationId: 'LOC-PD-002',
      locationName: 'ชั้นวาง A-02 (อะไหล่เครื่องจักร & สายพาน)',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'PROD-PD-007',
      code: 'PD-STP-015',
      name: 'สายรัดพาเลทพลาสติก PP Band (15mm x 3000m)',
      category: 'PD',
      department: 'PD',
      purchaseUnit: 'ม้วน',
      stockUnit: 'ม้วน',
      conversionRate: 1,
      price: 980,
      stockBalance: 20,
      reorderPoint: 8,
      leadTimeDays: 3,
      locationId: 'LOC-PD-004',
      locationName: 'ห้องแพ็คเกจจิ้ง',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'PROD-PD-008',
      code: 'PD-STF-001',
      name: 'ฟิล์มยืดพันพาเลท (Stretch Film 15 Micron 500mm x 300m)',
      category: 'PD',
      department: 'PD',
      purchaseUnit: 'ลัง (6 ม้วน)',
      stockUnit: 'ม้วน',
      conversionRate: 6,
      price: 1100,
      stockBalance: 60,
      reorderPoint: 25,
      leadTimeDays: 2,
      locationId: 'LOC-PD-004',
      locationName: 'ห้องแพ็คเกจจิ้ง',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'PROD-PD-009',
      code: 'PD-BRG-620',
      name: 'ตลับลูกปืนเม็ดกลมร่องลึก (Deep Groove Ball Bearing 6205-2RS)',
      category: 'PD',
      department: 'PD',
      purchaseUnit: 'ตลับ',
      stockUnit: 'ตลับ',
      conversionRate: 1,
      price: 280,
      stockBalance: 22,
      reorderPoint: 10,
      leadTimeDays: 5,
      locationId: 'LOC-PD-002',
      locationName: 'ชั้นวาง A-02 (อะไหล่เครื่องจักร & สายพาน)',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'PROD-PD-010',
      code: 'PD-MSK-N95',
      name: 'หน้ากากป้องกันฝุ่นละอองและละอองสารเคมี N95',
      category: 'PD',
      department: 'PD',
      purchaseUnit: 'กล่อง (20 ชิ้น)',
      stockUnit: 'ชิ้น',
      conversionRate: 20,
      price: 480,
      stockBalance: 700,
      reorderPoint: 300,
      leadTimeDays: 3,
      locationId: 'LOC-PD-003',
      locationName: 'ตู้เก็บอุปกรณ์ความปลอดภัย (PPE)',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },

    // ─── QUALITY CONTROL (QC) ITEMS (10 Items) ───
    {
      id: 'PROD-QC-001',
      code: 'QC-BUF-PH7',
      name: 'สารละลายบัฟเฟอร์มาตรฐานสอบเทียบ pH 7.00 Buffer Solution (500ml)',
      category: 'QC',
      department: 'QC',
      purchaseUnit: 'ขวด',
      stockUnit: 'ขวด',
      conversionRate: 1,
      price: 750,
      stockBalance: 8,
      reorderPoint: 4,
      leadTimeDays: 5,
      locationId: 'LOC-QC-001',
      locationName: 'ตู้เก็บสารเคมีทดสอบ (Lab 1)',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'PROD-QC-002',
      code: 'QC-BUF-PH4',
      name: 'สารละลายบัฟเฟอร์มาตรฐานสอบเทียบ pH 4.01 Buffer Solution (500ml)',
      category: 'QC',
      department: 'QC',
      purchaseUnit: 'ขวด',
      stockUnit: 'ขวด',
      conversionRate: 1,
      price: 750,
      stockBalance: 6,
      reorderPoint: 3,
      leadTimeDays: 5,
      locationId: 'LOC-QC-001',
      locationName: 'ตู้เก็บสารเคมีทดสอบ (Lab 1)',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'PROD-QC-003',
      code: 'QC-PPT-100',
      name: 'ทิปปิเปตไมโครสีขาว (Micropipette Tips 100-1000 uL, DNase/RNase Free)',
      category: 'QC',
      department: 'QC',
      purchaseUnit: 'กล่อง (1000 ชิ้น)',
      stockUnit: 'ชิ้น',
      conversionRate: 1000,
      price: 1200,
      stockBalance: 15000,
      reorderPoint: 5000,
      leadTimeDays: 4,
      locationId: 'LOC-QC-001',
      locationName: 'ตู้เก็บสารเคมีทดสอบ (Lab 1)',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'PROD-QC-004',
      code: 'QC-FLT-WAT',
      name: 'กระดาษกรองเชิงคุณภาพ Whatman Grade 1 (เส้นผ่านศูนย์กลาง 110mm)',
      category: 'QC',
      department: 'QC',
      purchaseUnit: 'กล่อง (100 แผ่น)',
      stockUnit: 'แผ่น',
      conversionRate: 100,
      price: 950,
      stockBalance: 1200,
      reorderPoint: 400,
      leadTimeDays: 7,
      locationId: 'LOC-QC-002',
      locationName: 'ชั้นวางอาหารเลี้ยงเชื้อ (Media Shelf B)',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'PROD-QC-005',
      code: 'QC-AGR-PCA',
      name: 'อาหารเลี้ยงเชื้อ Plate Count Agar (PCA) สำหรับทดสอบจุลชีววิทยา (500g)',
      category: 'QC',
      department: 'QC',
      purchaseUnit: 'ขวด (500g)',
      stockUnit: 'กรัม',
      conversionRate: 500,
      price: 2850,
      stockBalance: 2500,
      reorderPoint: 1000,
      leadTimeDays: 10,
      locationId: 'LOC-QC-002',
      locationName: 'ชั้นวางอาหารเลี้ยงเชื้อ (Media Shelf B)',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'PROD-QC-006',
      code: 'QC-PDI-STR',
      name: 'แผ่นทดสอบความสะอาดสวอปสำเร็จรูป (Surface Hygiene Swab Test Kits)',
      category: 'QC',
      department: 'QC',
      purchaseUnit: 'กล่อง (50 ชิ้น)',
      stockUnit: 'ชิ้น',
      conversionRate: 50,
      price: 3600,
      stockBalance: 400,
      reorderPoint: 150,
      leadTimeDays: 7,
      locationId: 'LOC-QC-003',
      locationName: 'ตู้ควบคุมอุณหภูมิ 4°C (Cold Storage)',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'PROD-QC-007',
      code: 'QC-THM-CAL',
      name: 'โพรบวัดอุณหภูมิดิจิตอลพร้อมใบรับรองการสอบเทียบ ISO/IEC 17025',
      category: 'QC',
      department: 'QC',
      purchaseUnit: 'ชุด',
      stockUnit: 'ชุด',
      conversionRate: 1,
      price: 4500,
      stockBalance: 4,
      reorderPoint: 2,
      leadTimeDays: 14,
      locationId: 'LOC-QC-001',
      locationName: 'ตู้เก็บสารเคมีทดสอบ (Lab 1)',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'PROD-QC-008',
      code: 'QC-GLV-EXM',
      name: 'ถุงมือตรวจโรคลาเท็กซ์ไม่มีแป้งสำหรับการทดสอบแล็บ (Powder-Free Latex Gloves Size M)',
      category: 'QC',
      department: 'QC',
      purchaseUnit: 'กล่อง (100 ชิ้น)',
      stockUnit: 'ชิ้น',
      conversionRate: 100,
      price: 260,
      stockBalance: 1200,
      reorderPoint: 400,
      leadTimeDays: 3,
      locationId: 'LOC-QC-001',
      locationName: 'ตู้เก็บสารเคมีทดสอบ (Lab 1)',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'PROD-QC-009',
      code: 'QC-ETH-995',
      name: 'เอทานอลบริสุทธิ์เกรดวิเคราะห์ Ethanol Absolute 99.5% AR Grade (4.0L)',
      category: 'QC',
      department: 'QC',
      purchaseUnit: 'ขวด (4.0L)',
      stockUnit: 'ลิตร',
      conversionRate: 4,
      price: 1650,
      stockBalance: 24,
      reorderPoint: 8,
      leadTimeDays: 5,
      locationId: 'LOC-QC-001',
      locationName: 'ตู้เก็บสารเคมีทดสอบ (Lab 1)',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'PROD-QC-010',
      code: 'QC-ALC-PAD',
      name: 'แผ่นแอลกอฮอล์ฆ่าเชื้อสำหรับทำความสะอาดอุปกรณ์วัด (Alcohol Prep Pads)',
      category: 'QC',
      department: 'QC',
      purchaseUnit: 'กล่อง (200 แผ่น)',
      stockUnit: 'แผ่น',
      conversionRate: 200,
      price: 180,
      stockBalance: 2000,
      reorderPoint: 800,
      leadTimeDays: 3,
      locationId: 'LOC-QC-001',
      locationName: 'ตู้เก็บสารเคมีทดสอบ (Lab 1)',
      status: 'ACTIVE',
      isActive: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
  ]
};

/**
 * Seeds products data into Products sheet tab.
 * @returns {number} Number of products inserted
 */
function seedProductsData() {
  console.info('[SheetService] Seeding Products master data (20 items)...');
  return seedSheetIfEmpty(SHEET_NAMES.PRODUCTS, SEED_DATA.PRODUCTS, 'code');
}

/**
 * Seeds base master data into the Google Sheet if sheets are empty.
 * @returns {Object} Seeding execution report
 */
function seedInitialMasterData() {
  console.info('[SheetService] Seeding baseline Master Data...');
  const report = {
    departmentsInserted: 0,
    locationsInserted: 0,
    unitsInserted: 0,
    usersInserted: 0,
    budgetsInserted: 0,
    countersInserted: 0,
    productsInserted: 0
  };

  report.departmentsInserted = seedSheetIfEmpty(SHEET_NAMES.DEPARTMENTS, SEED_DATA.DEPARTMENTS, 'code');
  report.locationsInserted = seedSheetIfEmpty(SHEET_NAMES.STORAGE_LOCATIONS, SEED_DATA.STORAGE_LOCATIONS, 'id');
  report.unitsInserted = seedSheetIfEmpty(SHEET_NAMES.USAGE_UNITS, SEED_DATA.USAGE_UNITS, 'id');

  const currentEmail = getCurrentUserEmail();
  const usersToSeed = SEED_DATA.USERS.map(u => {
    if (u.roleId === 'ADMIN' && currentEmail && !u.email) {
      return Object.assign({}, u, { email: currentEmail });
    }
    return u;
  });
  report.usersInserted = seedSheetIfEmpty(SHEET_NAMES.USERS, usersToSeed, 'username');
  report.budgetsInserted = seedSheetIfEmpty(SHEET_NAMES.BUDGETS, SEED_DATA.BUDGETS, 'dept');
  report.countersInserted = seedSheetIfEmpty(SHEET_NAMES.PR_COUNTERS, SEED_DATA.PR_COUNTERS, 'dept');
  report.productsInserted = seedProductsData();

  console.info('[SheetService] Master Data Seeding completed:', JSON.stringify(report));
  return report;
}

/**
 * Helper to seed records only if target sheet has no data rows.
 */
function seedSheetIfEmpty(sheetName, records, idField) {
  const existing = batchReadRecords(sheetName);
  if (existing.length === 0) {
    batchAppendRecords(sheetName, records);
    return records.length;
  }

  let count = 0;
  records.forEach(rec => {
    const found = existing.some(ex => String(ex[idField]) === String(rec[idField]));
    if (!found) {
      appendRecord(sheetName, rec);
      count++;
    }
  });

  return count;
}

/**
 * Migrates a batch of PO records into the POs sheet.
 * @param {Object[]} poRecords Array of PO records
 * @returns {number} Count of successfully imported POs
 */
function migratePOsBatch(poRecords = []) {
  if (!poRecords || poRecords.length === 0) return 0;

  console.info(`[SheetService] Migrating batch of ${poRecords.length} PO records...`);
  const existingPOs = batchReadRecords(SHEET_NAMES.POS);
  const existingPoNos = new Set(existingPOs.map(p => String(p.poNo || p.id).trim()));
  const recordsToInsert = [];

  poRecords.forEach(po => {
    const key = String(po.poNo || po.id).trim();
    if (!key || existingPoNos.has(key)) {
      return;
    }

    const cleanPo = {
      id: po.id || `PO-${Date.now()}`,
      poNo: po.poNo || po.id,
      prId: po.prId || '',
      prNo: po.prNo || po.prNumber || '',
      department: po.department || 'PD',
      vendorName: po.vendorName || po.vendor || '',
      vendorId: po.vendorId || '',
      purchaseChannel: po.purchaseChannel || (po.isOnline ? 'ONLINE' : 'DIRECT'),
      issueDate: po.issueDate || po.createdAt || '',
      orderDate: po.orderDate || '',
      status: po.status || 'PENDING',
      workflowStatus: po.workflowStatus || po.status || 'PENDING',
      items: sanitizePoItemsForStorage(po.items),
      subtotal: Number(po.subtotal || 0),
      vat: Number(po.vat || 0),
      grandTotal: Number(po.grandTotal || 0),
      isOnline: Boolean(po.isOnline),
      isClosed: Boolean(po.isClosed),
      claimStatus: po.claimStatus || '',
      ngItems: typeof po.ngItems === 'object' ? JSON.stringify(po.ngItems) : (po.ngItems || '[]'),
      reviewedBy: typeof po.reviewedBy === 'object' ? JSON.stringify(po.reviewedBy) : (po.reviewedBy || ''),
      reviewedAt: po.reviewedAt || '',
      approvedBy: typeof po.approvedBy === 'object' ? JSON.stringify(po.approvedBy) : (po.approvedBy || ''),
      approvedAt: po.approvedAt || '',
      activityLog: typeof po.activityLog === 'object' ? JSON.stringify(po.activityLog) : (po.activityLog || '[]'),
      createdAt: po.createdAt || new Date().toISOString(),
      completedAt: po.completedAt || '',
      updatedAt: po.updatedAt || new Date().toISOString()
    };

    recordsToInsert.push(cleanPo);
    existingPoNos.add(key);
  });

  if (recordsToInsert.length > 0) {
    batchAppendRecords(SHEET_NAMES.POS, recordsToInsert);
    console.info(`[SheetService] Successfully inserted ${recordsToInsert.length} POs.`);
  }

  return recordsToInsert.length;
}

/**
 * Generic Batch Importer for Master Data or Transactions.
 */
function migrateGenericRecords(sheetName, records = [], idField = 'id') {
  if (!records || records.length === 0) return 0;
  console.info(`[SheetService] Migrating ${records.length} records into "${sheetName}"...`);

  let count = 0;
  records.forEach(rec => {
    upsertRecordById(sheetName, idField, rec);
    count++;
  });

  return count;
}

/**
 * Enterprise Migration: Purges ALL Department Entity & Refactors Management Scope.
 * @returns {Object} Migration audit report
 */
function purgeAllDepartmentEntity() {
  console.info('[SheetService] Starting purgeAllDepartmentEntity migration...');
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(CONFIG.DEFAULTS.SCRIPT_LOCK_TIMEOUT_MS);
  } catch (e) {
    console.warn('[SheetService] Lock acquisition timeout, proceeding anyway.');
  }

  const report = {
    deptsPurged: 0,
    budgetsPurged: 0,
    usersMigrated: 0,
    timestamp: new Date().toISOString()
  };

  try {
    // 1. Purge 'ALL' from Departments tab
    const depts = batchReadRecords(SHEET_NAMES.DEPARTMENTS);
    const cleanDepts = depts.filter(d => {
      const code = String(d.code || '').trim().toUpperCase();
      const id = String(d.id || '').trim().toUpperCase();
      const name = String(d.name || '');
      const isAll = (code === 'ALL' || id === 'DEPT-ALL' || name.includes('ส่วนกลาง') || name.includes('ทุกฝ่าย'));
      if (isAll) report.deptsPurged++;
      return !isAll;
    });

    if (report.deptsPurged > 0) {
      batchWriteRecords(SHEET_NAMES.DEPARTMENTS, cleanDepts);
      console.info(`[SheetService] Successfully purged ${report.deptsPurged} ALL department records from ${SHEET_NAMES.DEPARTMENTS}.`);
    }

    // 2. Purge 'ALL' from Budgets tab
    const budgets = batchReadRecords(SHEET_NAMES.BUDGETS);
    const cleanBudgets = budgets.filter(b => {
      const dept = String(b.dept || '').trim().toUpperCase();
      const isAll = (dept === 'ALL');
      if (isAll) report.budgetsPurged++;
      return !isAll;
    });

    if (report.budgetsPurged > 0) {
      batchWriteRecords(SHEET_NAMES.BUDGETS, cleanBudgets);
      console.info(`[SheetService] Successfully purged ${report.budgetsPurged} ALL budget records from ${SHEET_NAMES.BUDGETS}.`);
    }

    // 3. Migrate Users with department: 'ALL'
    const users = batchReadRecords(SHEET_NAMES.USERS);
    let usersUpdated = false;
    const migratedUsers = users.map(u => {
      const dept = String(u.department || '').trim().toUpperCase();
      const pDept = String(u.primaryDepartment || '').trim().toUpperCase();
      const roleId = String(u.roleId || '').trim().toUpperCase();
      const uname = String(u.username || '').trim().toLowerCase();

      if (dept === 'ALL' || pDept === 'ALL') {
        report.usersMigrated++;
        usersUpdated = true;
        const targetDept = (roleId === 'ONLINE_PURCHASER' || uname.includes('pur') || uname.includes('nat.on')) ? 'PUR' : 'MGT';

        let allowed = [];
        if (Array.isArray(u.allowedDepartments)) {
          allowed = u.allowedDepartments.filter(d => String(d).toUpperCase() !== 'ALL');
        } else if (typeof u.allowedDepartments === 'string') {
          try {
            allowed = JSON.parse(u.allowedDepartments).filter(d => String(d).toUpperCase() !== 'ALL');
          } catch (e) {
            allowed = u.allowedDepartments.split(',').map(d => d.trim()).filter(d => d && d.toUpperCase() !== 'ALL');
          }
        }
        if (!allowed.includes('*')) {
          allowed.push('*');
        }

        let deptArr = [];
        if (Array.isArray(u.departments)) {
          deptArr = u.departments.filter(d => String(d).toUpperCase() !== 'ALL');
        } else if (typeof u.departments === 'string') {
          try {
            deptArr = JSON.parse(u.departments).filter(d => String(d).toUpperCase() !== 'ALL');
          } catch (e) {
            deptArr = u.departments.split(',').map(d => d.trim()).filter(d => d && d.toUpperCase() !== 'ALL');
          }
        }
        if (!deptArr.includes('*') && deptArr.length === 0) {
          deptArr.push('*');
        }

        return Object.assign({}, u, {
          department: targetDept,
          primaryDepartment: targetDept,
          allowedDepartments: allowed,
          departments: deptArr,
          updatedAt: new Date().toISOString()
        });
      }
      return u;
    });

    if (usersUpdated) {
      batchWriteRecords(SHEET_NAMES.USERS, migratedUsers);
      console.info(`[SheetService] Successfully migrated ${report.usersMigrated} users with ALL department.`);
    }

    setScriptProperty('ALL_DEPARTMENT_PURGED_V1', 'true');
    console.info('[SheetService] purgeAllDepartmentEntity completed successfully:', JSON.stringify(report));
  } catch (err) {
    console.error('[SheetService] purgeAllDepartmentEntity error:', err.message);
    throw err;
  } finally {
    try {
      lock.releaseLock();
    } catch (e) {}
  }

  return report;
}

/**
 * Main Initialization Function.
 * Safely sets up all 17 schema tabs, header columns with enterprise styling,
 * and default configuration without altering existing data.
 * Strictly IDEMPOTENT.
 * 
 * @returns {Object} Audit report of the initialization run
 */
function initializeSystem() {
  console.info('[SheetService] Starting PRPO_PDQC system initialization...');
  const ss = getSpreadsheet();
  const report = {
    timestamp: new Date().toISOString(),
    spreadsheetId: ss.getId(),
    spreadsheetName: ss.getName(),
    sheetsCreated: [],
    sheetsExisted: [],
    headersFormatted: [],
    driveFoldersCreated: [],
    driveFoldersExisted: []
  };

  // 1. Ensure all 17 Sheet Tabs exist with headers
  Object.keys(SCHEMA_DEFINITIONS).forEach(sheetName => {
    const expectedHeaders = SCHEMA_DEFINITIONS[sheetName];
    let sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      if (!Array.isArray(report.sheetsCreated)) report.sheetsCreated = [];
      report.sheetsCreated.push(sheetName);
      console.info(`[SheetService] Created missing sheet: "${sheetName}"`);
    } else {
      if (!Array.isArray(report.sheetsExisted)) report.sheetsExisted = [];
      report.sheetsExisted.push(sheetName);
    }

    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();

    if (lastRow === 0 || lastCol === 0) {
      sheet.getRange(1, 1, 1, expectedHeaders.length).setValues([expectedHeaders]);
      formatHeaderRow(sheet, expectedHeaders.length);
      if (!Array.isArray(report.headersFormatted)) report.headersFormatted = [];
      report.headersFormatted.push(sheetName);
      console.info(`[SheetService] Added and formatted headers for: "${sheetName}"`);
    } else {
      const existingHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
      const missingHeaders = expectedHeaders.filter(h => !existingHeaders.includes(h));

      if (missingHeaders.length > 0) {
        const startCol = lastCol + 1;
        sheet.getRange(1, startCol, 1, missingHeaders.length).setValues([missingHeaders]);
        formatHeaderRange(sheet, 1, startCol, missingHeaders.length);
        console.info(`[SheetService] Appended ${missingHeaders.length} missing columns to "${sheetName}": ${missingHeaders.join(', ')}`);
      }
    }
  });

  // 2. Remove default "Sheet1" if redundant
  try {
    const defaultSheet = ss.getSheetByName('Sheet1') || ss.getSheetByName('แผ่นงาน1');
    if (defaultSheet && ss.getSheets().length > 1 && defaultSheet.getLastRow() <= 1) {
      ss.deleteSheet(defaultSheet);
      console.info('[SheetService] Removed empty default "Sheet1".');
    }
  } catch (e) {}

  // 3. Initialize Drive Folders
  try {
    const root = getRootDriveFolder();
    console.info(`[SheetService] Root Drive folder verified: "${root.getName()}" (${root.getId()})`);

    const standardCategories = [
      DRIVE_CATEGORIES.PR,
      DRIVE_CATEGORIES.PO,
      DRIVE_CATEGORIES.GRN,
      DRIVE_CATEGORIES.CLAIM,
      DRIVE_CATEGORIES.BACKUPS
    ];

    standardCategories.forEach(catName => {
      const existing = root.getFoldersByName(catName);
      if (existing.hasNext()) {
        if (!Array.isArray(report.driveFoldersExisted)) report.driveFoldersExisted = [];
        report.driveFoldersExisted.push(catName);
      } else {
        root.createFolder(catName);
        if (!Array.isArray(report.driveFoldersCreated)) report.driveFoldersCreated = [];
        report.driveFoldersCreated.push(catName);
        console.info(`[SheetService] Created Drive category folder: "${catName}"`);
      }
    });
  } catch (driveErr) {
    console.warn(`[SheetService] Drive setup note: ${driveErr.message}`);
  }

  // 4. Seed baseline Master Data & Products (20 items: 10 PD, 10 QC)
  try {
    report.productsSeeded = seedProductsData();
  } catch (seedErr) {
    console.warn(`[SheetService] Products seed note: ${seedErr.message}`);
  }

  // 5. Purge ALL department entity and migrate user departments
  try {
    report.purgeAllMigration = purgeAllDepartmentEntity();
  } catch (purgeErr) {
    console.warn(`[SheetService] Purge ALL migration note: ${purgeErr.message}`);
  }

  // 6. Mark system initialized in properties
  setScriptProperty(CONFIG.PROPERTY_KEYS.SYSTEM_INITIALIZED, 'true');

  console.info('[SheetService] PRPO_PDQC system initialization completed successfully.');
  return report;
}
