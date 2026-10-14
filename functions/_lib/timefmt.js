// D1 CURRENT_TIMESTAMP / datetime('now') = 'YYYY-MM-DD HH:MM:SS' in UTC with no zone marker. A browser reads that as LOCAL time, so
// the clock shows the UTC hour and a PR made 00:00-06:59 (Bangkok) on the 1st lands in the previous month. Output side only : the stored
// value is never touched. Only that exact SQLite shape is converted ; ISO values (already 'T...Z') and date-only values ('YYYY-MM-DD',
// e.g. a document date the client sent) are returned as they are.
const SQLITE_UTC = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/;

export function sqliteUtcToIso(v) {
  if (typeof v !== 'string') return v;
  const m = SQLITE_UTC.exec(v.trim());
  if (!m) return v;
  const ms = Date.parse(`${m[1]}T${m[2]}${m[3] || ''}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : v;
}

// the columns D1 fills by default with CURRENT_TIMESTAMP (see migrations/*.sql)
const TIME_COLS = ['createdAt', 'updatedAt', 'date', 'timestamp', 'uploadedAt'];

// copy of the row with those columns in ISO-Z (same object back when nothing needs converting)
export function utcIsoRow(row) {
  if (!row || typeof row !== 'object') return row;
  let out = row;
  for (const k of TIME_COLS) {
    const v = row[k];
    if (typeof v === 'string') {
      const iso = sqliteUtcToIso(v);
      if (iso !== v) { if (out === row) out = { ...row }; out[k] = iso; }
    }
  }
  return out;
}

export const utcIsoRows = (rows) => (Array.isArray(rows) ? rows.map(utcIsoRow) : rows);
