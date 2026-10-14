// CSV cell helper : always quoted, " doubled, and a cell starting with = + - @ TAB CR is prefixed with ' (spreadsheet formula injection hardening,
// same rule as exportAuditLogsToCSV).
export function csvCell(value) {
  if (value === null || value === undefined) return '""';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
