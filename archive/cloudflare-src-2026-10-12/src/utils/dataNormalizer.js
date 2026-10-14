/**
 * Safely parse JSON string with a fallback.
 */
export function safeJsonParse(str, fallback = []) {
  if (typeof str !== 'string') return fallback;
  try {
    return JSON.parse(str);
  } catch (e) {
    return fallback;
  }
}

export function safeJsonParseObj(str, fallback = {}) {
  if (typeof str !== 'string') return fallback;
  try {
    const parsed = JSON.parse(str);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch (e) {
    return fallback;
  }
}

/**
 * Centralized normalizer for Purchase Requests (PR).
 * Ensures all array fields are valid arrays and not undefined/strings to prevent array mutation runtime errors.
 */
export function normalizePR(pr) {
  if (!pr || typeof pr !== 'object') return {};
  return {
    ...pr,
    items: Array.isArray(pr.items) ? pr.items : (typeof pr.items === 'string' ? safeJsonParse(pr.items, []) : []),
    timeline: Array.isArray(pr.timeline) ? pr.timeline : (typeof pr.timeline === 'string' ? safeJsonParse(pr.timeline, []) : []),
    history: Array.isArray(pr.history) ? pr.history : (typeof pr.history === 'string' ? safeJsonParse(pr.history, []) : []),
    activityLog: Array.isArray(pr.activityLog) ? pr.activityLog : (typeof pr.activityLog === 'string' ? safeJsonParse(pr.activityLog, []) : []),
    approvalHistory: Array.isArray(pr.approvalHistory) ? pr.approvalHistory : (typeof pr.approvalHistory === 'string' ? safeJsonParse(pr.approvalHistory, []) : []),
    attachments: Array.isArray(pr.attachments) ? pr.attachments : (typeof pr.attachments === 'string' ? safeJsonParse(pr.attachments, []) : []),
    comments: Array.isArray(pr.comments) ? pr.comments : (typeof pr.comments === 'string' ? safeJsonParse(pr.comments, []) : []),
    status: pr.status || 'PENDING_REVIEW'
  };
}

/**
 * Centralized normalizer for Purchase Orders (PO).
 */
export function normalizePO(po) {
  if (!po || typeof po !== 'object') return {};
  return {
    ...po,
    items: Array.isArray(po.items) ? po.items : (typeof po.items === 'string' ? safeJsonParse(po.items, []) : []),
    history: Array.isArray(po.history) ? po.history : (typeof po.history === 'string' ? safeJsonParse(po.history, []) : []),
    timeline: Array.isArray(po.timeline) ? po.timeline : (typeof po.timeline === 'string' ? safeJsonParse(po.timeline, []) : []),
    activityLog: Array.isArray(po.activityLog) ? po.activityLog : (typeof po.activityLog === 'string' ? safeJsonParse(po.activityLog, []) : []),
    claimHistory: Array.isArray(po.claimHistory) ? po.claimHistory : (typeof po.claimHistory === 'string' ? safeJsonParse(po.claimHistory, []) : []),
    storeClaims: (po.storeClaims && typeof po.storeClaims === 'object' && !Array.isArray(po.storeClaims)) ? po.storeClaims : (typeof po.storeClaims === 'string' ? safeJsonParseObj(po.storeClaims, {}) : {}),
    ngItems: Array.isArray(po.ngItems) ? po.ngItems : (typeof po.ngItems === 'string' ? safeJsonParse(po.ngItems, []) : []),
    attachments: Array.isArray(po.attachments) ? po.attachments : (typeof po.attachments === 'string' ? safeJsonParse(po.attachments, []) : []),
    comments: Array.isArray(po.comments) ? po.comments : (typeof po.comments === 'string' ? safeJsonParse(po.comments, []) : []),
    status: po.status || 'DRAFT'
  };
}
