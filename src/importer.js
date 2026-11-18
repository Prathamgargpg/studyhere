const Papa = require('papaparse');
const ExcelJS = require('exceljs');
const { query } = require('./db');

const MAX_ROWS = 50000;

// ---------- File parsing ----------

function cellToString(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if (v.text !== undefined) return cellToString(v.text);
    if (v.result !== undefined) return cellToString(v.result);
    if (v.hyperlink) return String(v.hyperlink);
    return '';
  }
  if (typeof v === 'number') {
    // Avoid 9.87654321E9 style output for phone numbers
    return Number.isInteger(v) ? v.toFixed(0) : String(v);
  }
  return String(v);
}

async function parseFile(buffer, filename) {
  const lower = (filename || '').toLowerCase();
  let table = [];

  if (lower.endsWith('.xlsx')) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets.find((s) => s.actualRowCount > 0) || wb.worksheets[0];
    if (!ws) throw new Error('The Excel file has no sheets.');
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      for (let i = 1; i <= row.cellCount; i++) vals.push(cellToString(row.getCell(i).value).trim());
      table.push(vals);
    });
  } else if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    let text = buffer.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const res = Papa.parse(text, { skipEmptyLines: 'greedy' });
    table = res.data.map((r) => r.map((c) => String(c ?? '').trim()));
  } else if (lower.endsWith('.xls')) {
    throw new Error('Old .xls files are not supported. In Excel, use File > Save As > .xlsx or .csv and upload again.');
  } else {
    throw new Error('Please upload a .csv or .xlsx file.');
  }

  // Skip leading blank rows; first non-empty row is the header
  while (table.length && table[0].every((c) => !c)) table.shift();
  if (table.length < 2) throw new Error('The file needs a header row and at least one contact row.');

  const width = Math.max(...table.slice(0, 200).map((r) => r.length));
  const headers = [];
  for (let i = 0; i < width; i++) {
    const h = (table[0][i] || '').trim();
    headers.push(h || `Column ${i + 1}`);
  }
  const rows = table.slice(1, MAX_ROWS + 1).map((r) => headers.map((_, i) => r[i] || ''))
    .filter((r) => r.some((c) => c));
  return { headers, rows, truncated: table.length - 1 > MAX_ROWS };
}

// ---------- Normalisation ----------

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;

function normalizeEmail(raw) {
  if (!raw) return null;
  let e = String(raw).trim().replace(/^mailto:/i, '').toLowerCase();
  // Some sheets have "Name <email@x.com>"
  const m = e.match(/<([^>]+)>/);
  if (m) e = m[1].trim();
  return EMAIL_RE.test(e) ? e : null;
}

function normalizePhone(raw, defaultCountry = '91') {
  if (!raw) return null;
  let s = String(raw).trim();
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(s)) s = Number(s).toFixed(0);
  // Take first number if a cell holds several ("98xxx / 97xxx")
  s = s.split(/[\/,;|]/)[0];
  const hadPlus = s.trim().startsWith('+');
  let d = s.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (!d) return null;

  if (defaultCountry === '91') {
    if (d.length === 10 && /^[6-9]/.test(d)) return '+91' + d;
    if (d.length === 11 && d.startsWith('0') && /^[6-9]/.test(d[1])) return '+91' + d.slice(1);
    if (d.length === 12 && d.startsWith('91') && /^[6-9]/.test(d[2])) return '+' + d;
  }
  if ((hadPlus || d.length > 10) && d.length >= 8 && d.length <= 15) return '+' + d;
  return null;
}

function normalizeTags(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,;|]/)
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, ''))
    .filter(Boolean)
    .slice(0, 20);
}

function parseConsent(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const v = String(raw).trim().toLowerCase();
  if (['no', 'n', 'false', '0', 'unsubscribed', 'not_subscribed', 'opted out', 'optout'].includes(v)) return false;
  return true;
}

// ---------- Column detection ----------

const FIELDS = ['email', 'phone', 'name', 'first_name', 'last_name', 'city', 'tags', 'consent'];
const FIELD_LABELS = {
  email: 'Email', phone: 'Phone / WhatsApp', name: 'Full name', first_name: 'First name',
  last_name: 'Last name', city: 'City', tags: 'Tags / segment', consent: 'Accepts marketing (yes/no)',
};

function detectMapping(headers, rows) {
  const key = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
  const keys = headers.map(key);
  const map = {};
  const used = new Set();
  const pick = (field, test) => {
    if (map[field] !== undefined) return;
    const i = keys.findIndex((k, idx) => !used.has(idx) && test(k));
    if (i >= 0) { map[field] = i; used.add(i); }
  };

  pick('consent', (k) => /acceptsemail|acceptsmarketing|emailmarketing|optin|consent|subscribed/.test(k));
  pick('email', (k) => /^(e?mail|emailid|emailaddress)$/.test(k) || (k.includes('mail') && !k.includes('marketing')));
  pick('first_name', (k) => /^(firstname|fname|first|givenname)$/.test(k));
  pick('last_name', (k) => /^(lastname|lname|last|surname|familyname)$/.test(k));
  pick('phone', (k) => /phone|mobile|whatsapp|cell|^tel|contactno|contactnumber|^contact$|^number$|mob/.test(k));
  pick('name', (k) => /^(name|fullname|customername|customer|contactname|clientname)$/.test(k) || (k.endsWith('name') && !/first|last|company|user/.test(k)));
  pick('city', (k) => /city|town|district|location/.test(k));
  pick('tags', (k) => /^(tags?|segment|group|category|label|labels)$/.test(k));

  // Content-based fallback for email/phone when headers are unhelpful
  const sample = rows.slice(0, 100);
  const share = (i, fn) => sample.filter((r) => r[i] && fn(r[i])).length / Math.max(1, sample.filter((r) => r[i]).length);
  if (map.email === undefined) {
    const i = headers.findIndex((_, idx) => !used.has(idx) && share(idx, normalizeEmail) > 0.6);
    if (i >= 0) { map.email = i; used.add(i); }
  }
  if (map.phone === undefined) {
    const i = headers.findIndex((_, idx) => !used.has(idx) && share(idx, (v) => normalizePhone(v)) > 0.6);
    if (i >= 0) { map.phone = i; used.add(i); }
  }
  return map;
}

// ---------- Import into DB ----------

async function upsertContact(c, source) {
  const existing = await query(
    `SELECT id, tags, subscribed FROM contacts
     WHERE ($1::text IS NOT NULL AND lower(email) = $1) OR ($2::text IS NOT NULL AND phone = $2)
     ORDER BY (lower(email) = $1) DESC NULLS LAST LIMIT 1`,
    [c.email, c.phone]
  );
  if (existing.rows.length) {
    const row = existing.rows[0];
    const tags = Array.from(new Set([...(row.tags || []), ...c.tags]));
    // Never re-subscribe someone who unsubscribed; only allow an explicit "no" to unsubscribe
    const subscribed = row.subscribed && c.consent !== false;
    await query(
      `UPDATE contacts SET
         email = COALESCE(email, $2), phone = COALESCE(phone, $3),
         name = COALESCE(NULLIF($4, ''), name), city = COALESCE(NULLIF($5, ''), city),
         tags = $6, subscribed = $7,
         unsubscribed_at = CASE WHEN $7 = false AND subscribed THEN now() ELSE unsubscribed_at END,
         updated_at = now()
       WHERE id = $1`,
      [row.id, c.email, c.phone, c.name, c.city, tags, subscribed]
    ).catch(async (err) => {
      // Email/phone already belongs to another contact: update without touching those
      if (err.code !== '23505') throw err;
      await query(`UPDATE contacts SET name = COALESCE(NULLIF($2,''), name), city = COALESCE(NULLIF($3,''), city),
        tags = $4, updated_at = now() WHERE id = $1`, [row.id, c.name, c.city, tags]);
    });
    return 'updated';
  }
  await query(
    `INSERT INTO contacts (email, phone, name, city, tags, source, subscribed, unsubscribed_at)
     VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, $6, $7, CASE WHEN $7 THEN NULL ELSE now() END)`,
    [c.email, c.phone, c.name, c.city, c.tags, source, c.consent !== false]
  );
  return 'added';
}

async function runImport({ headers, rows, mapping, extraTags, source }) {
  const get = (r, f) => (mapping[f] !== undefined && mapping[f] !== '' ? (r[Number(mapping[f])] || '').trim() : '');
  const seen = new Set();
  const result = { added: 0, updated: 0, invalid: 0, duplicateInFile: 0, total: rows.length, problems: [] };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rawEmail = get(r, 'email');
    const rawPhone = get(r, 'phone');
    const email = normalizeEmail(rawEmail);
    const phone = normalizePhone(rawPhone);
    if (!email && !phone) {
      result.invalid++;
      if (result.problems.length < 25) {
        result.problems.push({ row: i + 2, reason: rawEmail || rawPhone ? `Invalid email/phone: ${rawEmail || rawPhone}` : 'No email or phone' });
      }
      continue;
    }
    const dedupeKey = email || phone;
    if (seen.has(dedupeKey)) { result.duplicateInFile++; continue; }
    seen.add(dedupeKey);

    let name = get(r, 'name');
    if (!name) name = [get(r, 'first_name'), get(r, 'last_name')].filter(Boolean).join(' ');
    const contact = {
      email, phone,
      name: name.replace(/\s+/g, ' ').trim(),
      city: get(r, 'city'),
      tags: Array.from(new Set([...normalizeTags(get(r, 'tags')), ...extraTags])),
      consent: parseConsent(get(r, 'consent')),
    };
    const outcome = await upsertContact(contact, source);
    result[outcome]++;
  }
  return result;
}

module.exports = {
  parseFile, detectMapping, runImport, upsertContact,
  normalizeEmail, normalizePhone, normalizeTags, FIELDS, FIELD_LABELS,
};
