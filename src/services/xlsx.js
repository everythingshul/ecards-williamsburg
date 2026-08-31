import xlsx from 'xlsx';

const SQLITE_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// Every timestamp in this app is written via SQLite's datetime('now'), which
// is always UTC. The admin UI already converts that to the browser's local
// time for display (see app.js's fmtDateTime, which appends 'Z' before
// formatting) — but xlsx cells go straight from the DB with no such
// client-side step, so raw UTC strings read hours ahead of the org's actual
// (Eastern) time. Convert any recognizable SQLite datetime string to Eastern
// before it's written to a cell.
function toEastern(value) {
  if (typeof value !== 'string' || !SQLITE_DATETIME_RE.test(value)) return value;
  const utc = new Date(value.replace(' ', 'T') + 'Z');
  return utc.toLocaleString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
}

// rows: array of plain objects. columns: optional ordered [key, ...] — if
// omitted, uses the union of keys across all rows (first-seen order). Same
// column-ordering contract as the old CSV writer this replaces — CSV was
// dropped because it doesn't reliably round-trip Hebrew text; Excel does.
export function sendXlsx(res, filename, rows, columns) {
  if (!columns) {
    const seen = new Set();
    columns = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); columns.push(k); }
  }
  const converted = rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toEastern(v)])));
  const wb = xlsx.utils.book_new();
  const sheet = xlsx.utils.json_to_sheet(converted.length ? converted : [{}], { header: columns });
  xlsx.utils.book_append_sheet(wb, sheet, 'Sheet1');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
}
