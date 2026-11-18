const express = require('express');
const multer = require('multer');
const cookieSession = require('cookie-session');
const crypto = require('crypto');
const Papa = require('papaparse');

const { query, migrate } = require('./db');
const importer = require('./importer');
const camp = require('./campaigns');
const { sendEmail, isLive } = require('./mailer');
const { layout, loginPage, esc, fmtDate, pct, statusBadge } = require('./views');

const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is not set — set it before deploying!');

app.use(cookieSession({
  name: 'bc_session',
  secret: process.env.SESSION_SECRET || crypto.createHash('sha256').update('bc:' + ADMIN_PASSWORD).digest('hex'),
  maxAge: 30 * 24 * 3600 * 1000,
  sameSite: 'lax',
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const flash = (req, type, msg) => { req.session.flash = { type, msg }; };
const render = (req, res, title, body, active) => {
  const f = req.session.flash; req.session.flash = null;
  res.send(layout(title, body, { active, flash: f, live: isLive() }));
};
const backTo = (req) => { const r = req.get('Referer') || ''; try { const u = new URL(r); return u.pathname + u.search; } catch (_) { return '/contacts'; } };
const DEFAULT_FROM_EMAIL = () => process.env.FROM_EMAIL || '';
const DEFAULT_FROM_NAME = () => process.env.FROM_NAME || camp.brandName();

// ================= Public routes (no login) =================

app.get('/health', (req, res) => res.send('ok'));

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
app.get('/t/o/:token.gif', wrap(async (req, res) => {
  await query(`UPDATE messages SET opened_at = COALESCE(opened_at, now()) WHERE token = $1`, [req.params.token]);
  res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0' }).send(GIF);
}));

app.get('/t/c/:token', wrap(async (req, res) => {
  const url = String(req.query.u || '');
  const r = await query(
    `SELECT m.id, c.name, c.city, c.email, c.phone, cp.body, cp.subject
     FROM messages m JOIN campaigns cp ON cp.id = m.campaign_id LEFT JOIN contacts c ON c.id = m.contact_id
     WHERE m.token = $1`, [req.params.token]);
  const row = r.rows[0];
  if (!row) return res.status(404).send('Link not found');
  // Only redirect to links that are actually in the email (prevents open-redirect abuse)
  const { html } = camp.renderEmail({ body: row.body, subject: row.subject }, row, { tracking: false });
  if (!camp.extractLinks(html).includes(url)) return res.status(400).send('Invalid link');
  await query(`UPDATE messages SET clicked_at = COALESCE(clicked_at, now()), opened_at = COALESCE(opened_at, now()), clicks = clicks + 1 WHERE id = $1`, [row.id]);
  res.redirect(302, url);
}));

const unsubPage = (title, text, form = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f6f7f9;margin:0}div{max-width:420px;margin:12vh auto;background:#fff;border:1px solid #e4e4e7;border-radius:10px;padding:28px;text-align:center}
button{background:#111;color:#fff;border:0;border-radius:7px;padding:11px 20px;font-size:15px;font-weight:600;cursor:pointer}</style></head>
<body><div><h2>${esc(title)}</h2><p>${text}</p>${form}</div></body></html>`;

app.get('/u/:token', wrap(async (req, res) => {
  const c = (await query('SELECT email, subscribed FROM contacts WHERE unsub_token = $1', [req.params.token])).rows[0];
  if (!c) return res.status(404).send(unsubPage('Link not valid', 'This unsubscribe link has expired or is invalid.'));
  if (!c.subscribed) return res.send(unsubPage('You are unsubscribed', `${esc(c.email || 'You')} will not receive marketing emails from ${esc(camp.brandName())}.`));
  res.send(unsubPage('Unsubscribe?', `Stop marketing emails from ${esc(camp.brandName())} to ${esc(c.email || 'this address')}?`,
    `<form method="post"><button>Yes, unsubscribe me</button></form>`));
}));

// Also handles RFC 8058 one-click unsubscribe from Gmail/Yahoo
app.post('/u/:token', wrap(async (req, res) => {
  const r = await query(`UPDATE contacts SET subscribed = false, unsubscribed_at = now(), updated_at = now()
    WHERE unsub_token = $1 RETURNING email`, [req.params.token]);
  if (!r.rows.length) return res.status(404).send(unsubPage('Link not valid', 'This unsubscribe link has expired or is invalid.'));
  res.send(unsubPage('You are unsubscribed', `You won't receive marketing emails from ${esc(camp.brandName())} anymore.`));
}));

// ================= Auth =================

app.get('/login', (req, res) => res.send(loginPage()));
app.post('/login', (req, res) => {
  const given = Buffer.from(String(req.body.password || ''));
  const real = Buffer.from(ADMIN_PASSWORD);
  if (ADMIN_PASSWORD && given.length === real.length && crypto.timingSafeEqual(given, real)) {
    req.session.authed = true;
    return res.redirect('/');
  }
  res.status(401).send(loginPage(ADMIN_PASSWORD ? 'Wrong password.' : 'Set the ADMIN_PASSWORD environment variable first.'));
});
app.post('/logout', (req, res) => { req.session = null; res.redirect('/login'); });

app.use((req, res, next) => (req.session && req.session.authed ? next() : res.redirect('/login')));

// ================= Dashboard =================

app.get('/', wrap(async (req, res) => {
  const s = (await query(`SELECT count(*)::int total,
      count(*) FILTER (WHERE subscribed)::int subscribed,
      count(*) FILTER (WHERE subscribed AND email IS NOT NULL)::int emailable,
      count(*) FILTER (WHERE phone IS NOT NULL)::int phones
    FROM contacts`)).rows[0];
  const today = await camp.sentToday();
  const recent = (await query(`SELECT cp.*, (SELECT count(*) FROM messages m WHERE m.campaign_id = cp.id AND m.status='sent')::int sent
    FROM campaigns cp ORDER BY cp.created_at DESC LIMIT 5`)).rows;

  const steps = [];
  if (!isLive()) steps.push('Add your free <b>Brevo API key</b> to start real sending — see <a href="/settings">Setup</a>. Until then, campaigns run in test mode and nothing is emailed.');
  if (!s.total) steps.push('Import your customers from a CSV or Excel file on the <a href="/import">Import</a> page.');

  render(req, res, 'Dashboard', `
    <h1>Dashboard</h1>
    ${steps.length ? `<div class="flash info">${steps.join('<br>')}</div>` : ''}
    <div class="grid">
      <div class="stat"><b>${s.total}</b><span>Contacts</span></div>
      <div class="stat"><b>${s.emailable}</b><span>Can receive email</span></div>
      <div class="stat"><b>${s.phones}</b><span>Have phone numbers</span></div>
      <div class="stat"><b>${today} / ${camp.dailyLimit()}</b><span>Emails sent today</span></div>
    </div>
    <div class="card"><div class="row" style="align-items:center"><h2 style="margin:0">Recent campaigns</h2>
      <form method="post" action="/campaigns/new" class="right"><button class="btn sm">+ New campaign</button></form></div>
      ${recent.length ? `<div class="scroll"><table><tr><th>Name</th><th>Status</th><th>Sent</th><th>Created</th></tr>
      ${recent.map((c) => `<tr><td><a href="/campaigns/${c.id}">${esc(c.name)}</a></td><td>${statusBadge(c.status)}</td><td>${c.sent}</td><td class="muted">${fmtDate(c.created_at)}</td></tr>`).join('')}
      </table></div>` : '<p class="muted">No campaigns yet.</p>'}
    </div>`, 'home');
}));

// ================= Contacts =================

function contactFilter(q) {
  const where = []; const params = [];
  if (q.q) { params.push(`%${q.q.trim().toLowerCase()}%`); where.push(`(lower(coalesce(name,'')) LIKE $${params.length} OR lower(coalesce(email,'')) LIKE $${params.length} OR coalesce(phone,'') LIKE $${params.length} OR lower(coalesce(city,'')) LIKE $${params.length})`); }
  if (q.tag) { params.push(q.tag); where.push(`$${params.length} = ANY(tags)`); }
  if (q.status === 'subscribed') where.push('subscribed');
  if (q.status === 'unsubscribed') where.push('NOT subscribed');
  if (q.has === 'email') where.push('email IS NOT NULL');
  if (q.has === 'phone') where.push('phone IS NOT NULL');
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

async function allTags() {
  return (await query(`SELECT t, count(*)::int n FROM contacts, unnest(tags) t GROUP BY t ORDER BY t`)).rows;
}

app.get('/contacts', wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const per = 50;
  const f = contactFilter(req.query);
  const total = (await query(`SELECT count(*)::int n FROM contacts ${f.sql}`, f.params)).rows[0].n;
  const rows = (await query(`SELECT * FROM contacts ${f.sql} ORDER BY created_at DESC, id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`, f.params)).rows;
  const tags = await allTags();
  const qs = (extra) => new URLSearchParams({ ...req.query, ...extra }).toString();
  const sel = (name, val) => (req.query[name] === val ? 'selected' : '');

  render(req, res, 'Contacts', `
    <h1>Contacts <span class="muted">(${total})</span></h1>
    <div class="card"><form method="get" class="row">
      <div><label>Search</label><input type="search" name="q" value="${esc(req.query.q || '')}" placeholder="Name, email, phone, city"></div>
      <div><label>Tag</label><select name="tag"><option value="">All tags</option>${tags.map((t) => `<option value="${esc(t.t)}" ${sel('tag', t.t)}>${esc(t.t)} (${t.n})</option>`).join('')}</select></div>
      <div><label>Status</label><select name="status"><option value="">Everyone</option><option value="subscribed" ${sel('status', 'subscribed')}>Subscribed</option><option value="unsubscribed" ${sel('status', 'unsubscribed')}>Unsubscribed</option></select></div>
      <div><label>Has</label><select name="has"><option value="">Any</option><option value="email" ${sel('has', 'email')}>Email</option><option value="phone" ${sel('has', 'phone')}>Phone</option></select></div>
      <button class="btn">Filter</button>
      <a class="btn sec" href="/contacts/export.csv?${qs({})}">Export CSV</a>
    </form></div>

    <form method="post" action="/contacts/bulk" id="bulk">
    <div class="card">
      <div class="row" style="margin-bottom:10px">
        <div><label>With selected</label><select name="action">
          <option value="tag">Add tag</option><option value="untag">Remove tag</option>
          <option value="unsubscribe">Mark unsubscribed</option><option value="delete">Delete</option></select></div>
        <div><label>Tag</label><input type="text" name="tag" placeholder="e.g. vip"></div>
        <button class="btn sec" onclick="return document.querySelectorAll('input[name=ids]:checked').length>0 || (alert('Select contacts first'),false)">Apply</button>
      </div>
      <div class="scroll"><table>
        <tr><th><input type="checkbox" onclick="document.querySelectorAll('input[name=ids]').forEach(c=>c.checked=this.checked)"></th><th>Name</th><th>Email</th><th>Phone</th><th>City</th><th>Tags</th><th>Status</th></tr>
        ${rows.map((c) => `<tr>
          <td><input type="checkbox" name="ids" value="${c.id}"></td>
          <td>${esc(c.name || '—')}</td><td>${esc(c.email || '—')}</td><td>${esc(c.phone || '—')}</td><td>${esc(c.city || '—')}</td>
          <td>${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td>
          <td>${c.subscribed ? '<span class="badge b-sent">subscribed</span>' : '<span class="badge b-paused">unsubscribed</span>'}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="muted">No contacts found. <a href="/import">Import a file</a>.</td></tr>'}
      </table></div>
      <p class="muted">
        ${page > 1 ? `<a href="?${qs({ page: page - 1 })}">← Prev</a> · ` : ''}Page ${page} of ${Math.max(1, Math.ceil(total / per))}
        ${page * per < total ? ` · <a href="?${qs({ page: page + 1 })}">Next →</a>` : ''}
      </p>
    </div></form>

    <div class="card"><h2>Add a contact</h2>
      <form method="post" action="/contacts" class="row">
        <div><label>Name</label><input type="text" name="name"></div>
        <div><label>Email</label><input type="email" name="email"></div>
        <div><label>Phone</label><input type="text" name="phone" placeholder="98765 43210"></div>
        <div><label>City</label><input type="text" name="city"></div>
        <div><label>Tags</label><input type="text" name="tags" placeholder="vip, mumbai"></div>
        <button class="btn">Add</button>
      </form></div>`, 'contacts');
}));

app.post('/contacts', wrap(async (req, res) => {
  const email = importer.normalizeEmail(req.body.email);
  const phone = importer.normalizePhone(req.body.phone);
  if (!email && !phone) { flash(req, 'err', 'Enter a valid email or phone number.'); return res.redirect('/contacts'); }
  const r = await importer.upsertContact({
    email, phone, name: (req.body.name || '').trim(), city: (req.body.city || '').trim(),
    tags: importer.normalizeTags(req.body.tags), consent: null,
  }, 'manual');
  flash(req, 'ok', r === 'added' ? 'Contact added.' : 'Contact already existed — details updated.');
  res.redirect('/contacts');
}));

app.post('/contacts/bulk', wrap(async (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  const tag = importer.normalizeTags(req.body.tag)[0];
  if (!ids.length) { flash(req, 'err', 'No contacts selected.'); return res.redirect(backTo(req)); }
  const a = req.body.action;
  if ((a === 'tag' || a === 'untag') && !tag) { flash(req, 'err', 'Enter a tag name.'); return res.redirect(backTo(req)); }
  if (a === 'tag') await query(`UPDATE contacts SET tags = array_append(array_remove(tags, $2), $2), updated_at = now() WHERE id = ANY($1)`, [ids, tag]);
  else if (a === 'untag') await query(`UPDATE contacts SET tags = array_remove(tags, $2), updated_at = now() WHERE id = ANY($1)`, [ids, tag]);
  else if (a === 'unsubscribe') await query(`UPDATE contacts SET subscribed = false, unsubscribed_at = now() WHERE id = ANY($1) AND subscribed`, [ids]);
  else if (a === 'delete') await query(`DELETE FROM contacts WHERE id = ANY($1)`, [ids]);
  flash(req, 'ok', `Done — ${ids.length} contact(s) updated.`);
  res.redirect(backTo(req));
}));

app.get('/contacts/export.csv', wrap(async (req, res) => {
  const f = contactFilter(req.query);
  const rows = (await query(`SELECT name, email, phone, city, array_to_string(tags, ', ') AS tags,
    CASE WHEN subscribed THEN 'yes' ELSE 'no' END AS subscribed, created_at FROM contacts ${f.sql} ORDER BY id`, f.params)).rows;
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="contacts.csv"' });
  res.send('﻿' + Papa.unparse(rows));
}));

// ================= Import =================

app.get('/import', (req, res) => {
  render(req, res, 'Import', `
    <h1>Import contacts</h1>
    <div class="card"><form method="post" action="/import" enctype="multipart/form-data">
      <label>CSV or Excel (.xlsx) file</label><input type="file" name="file" accept=".csv,.xlsx,.txt" required>
      <p><button class="btn">Upload &amp; preview</button></p></form>
      <div class="help">The first row should be column headings. Columns like <b>Name, First Name, Email, Phone, Mobile, WhatsApp, City, Tags</b> are detected automatically — you can fix the matching on the next screen.<br>
      Shopify customer exports work as-is (Customers → Export). Indian 10-digit numbers are converted to <code>+91</code> format, and duplicates are merged.</div>
    </div>`, 'import');
});

app.post('/import', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) { flash(req, 'err', 'Choose a file to upload.'); return res.redirect('/import'); }
  let parsed;
  try { parsed = await importer.parseFile(req.file.buffer, req.file.originalname); } catch (err) {
    flash(req, 'err', err.message); return res.redirect('/import');
  }
  const r = await query(`INSERT INTO imports (filename, headers, rows) VALUES ($1, $2, $3) RETURNING id`,
    [req.file.originalname, JSON.stringify(parsed.headers), JSON.stringify(parsed.rows)]);
  if (parsed.truncated) flash(req, 'info', 'Only the first 50,000 rows will be imported. Split the file to import the rest.');
  res.redirect(`/import/${r.rows[0].id}`);
}));

app.get('/import/:id', wrap(async (req, res) => {
  const imp = (await query('SELECT * FROM imports WHERE id = $1', [req.params.id])).rows[0];
  if (!imp) { flash(req, 'err', 'That upload expired. Please upload again.'); return res.redirect('/import'); }
  const { headers, rows } = imp;
  const map = importer.detectMapping(headers, rows);
  const select = (field) => `<select name="map_${field}"><option value="">— not in file —</option>
    ${headers.map((h, i) => `<option value="${i}" ${map[field] === i ? 'selected' : ''}>${esc(h)}</option>`).join('')}</select>`;
  const preview = rows.slice(0, 5);
  render(req, res, 'Match columns', `
    <h1>Match columns <span class="muted">· ${esc(imp.filename)} · ${rows.length} rows</span></h1>
    <form method="post">
    <div class="card"><h2>Which column holds what?</h2>
      <div class="grid">${importer.FIELDS.map((f) => `<div><label>${importer.FIELD_LABELS[f]}</label>${select(f)}</div>`).join('')}</div>
      <p class="muted">You need at least an Email or a Phone column. If you have both Full name and First/Last name, Full name is used.</p>
      <label>Add a tag to everyone in this file (optional)</label>
      <input type="text" name="extra_tags" placeholder="e.g. diwali-2026, instagram-leads">
      <label style="font-weight:400;display:flex;gap:8px;align-items:start;margin-top:16px">
        <input type="checkbox" name="consent" value="1" required style="margin-top:3px">
        <span>These people are my customers or have agreed to hear from my store, and I can send them marketing messages.</span></label>
      <p><button class="btn">Import ${rows.length} rows</button> <a href="/import" class="btn sec">Cancel</a></p>
    </div></form>
    <div class="card"><h2>First rows of your file</h2><div class="scroll"><table>
      <tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>
      ${preview.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}
    </table></div></div>`, 'import');
}));

app.post('/import/:id', wrap(async (req, res) => {
  const imp = (await query('SELECT * FROM imports WHERE id = $1', [req.params.id])).rows[0];
  if (!imp) { flash(req, 'err', 'That upload expired. Please upload again.'); return res.redirect('/import'); }
  const mapping = {};
  for (const f of importer.FIELDS) if (req.body[`map_${f}`] !== undefined && req.body[`map_${f}`] !== '') mapping[f] = Number(req.body[`map_${f}`]);
  if (mapping.email === undefined && mapping.phone === undefined) {
    flash(req, 'err', 'Pick the Email or Phone column.'); return res.redirect(`/import/${imp.id}`);
  }
  const result = await importer.runImport({
    headers: imp.headers, rows: imp.rows, mapping,
    extraTags: importer.normalizeTags(req.body.extra_tags), source: `import:${imp.filename}`,
  });
  await query('DELETE FROM imports WHERE id = $1', [imp.id]);
  render(req, res, 'Import done', `
    <h1>Import finished</h1>
    <div class="grid">
      <div class="stat"><b>${result.added}</b><span>New contacts</span></div>
      <div class="stat"><b>${result.updated}</b><span>Existing contacts updated</span></div>
      <div class="stat"><b>${result.duplicateInFile}</b><span>Duplicates in file (merged)</span></div>
      <div class="stat"><b>${result.invalid}</b><span>Skipped (no valid email/phone)</span></div>
    </div>
    ${result.problems.length ? `<div class="card"><h2>Skipped rows</h2><table><tr><th>Row</th><th>Reason</th></tr>
      ${result.problems.map((p) => `<tr><td>${p.row}</td><td>${esc(p.reason)}</td></tr>`).join('')}</table>
      ${result.invalid > result.problems.length ? `<p class="muted">…and ${result.invalid - result.problems.length} more.</p>` : ''}</div>` : ''}
    <p><a class="btn" href="/contacts">View contacts</a> <a class="btn sec" href="/import">Import another file</a></p>`, 'import');
}));

// ================= Campaigns =================

app.get('/campaigns', wrap(async (req, res) => {
  const rows = (await query(`SELECT cp.*,
      count(m.id)::int total,
      count(m.id) FILTER (WHERE m.status='sent')::int sent,
      count(m.id) FILTER (WHERE m.opened_at IS NOT NULL)::int opened,
      count(m.id) FILTER (WHERE m.clicked_at IS NOT NULL)::int clicked,
      count(m.id) FILTER (WHERE m.status='failed')::int failed
    FROM campaigns cp LEFT JOIN messages m ON m.campaign_id = cp.id GROUP BY cp.id ORDER BY cp.created_at DESC`)).rows;
  render(req, res, 'Campaigns', `
    <div class="row" style="align-items:center"><h1>Campaigns</h1>
      <form method="post" action="/campaigns/new" class="right"><button class="btn">+ New campaign</button></form></div>
    <div class="card"><div class="scroll"><table>
      <tr><th>Name</th><th>Status</th><th>Audience</th><th>Sent</th><th>Opened</th><th>Clicked</th><th>Failed</th><th>When</th></tr>
      ${rows.map((c) => `<tr><td><a href="/campaigns/${c.id}">${esc(c.name)}</a></td><td>${statusBadge(c.status)}</td>
        <td>${c.audience_tag ? `<span class="tag">${esc(c.audience_tag)}</span>` : 'All subscribed'}</td>
        <td>${c.sent}${c.total ? ` / ${c.total}` : ''}</td><td>${pct(c.opened, c.sent)}</td><td>${pct(c.clicked, c.sent)}</td><td>${c.failed}</td>
        <td class="muted">${fmtDate(c.status === 'scheduled' ? c.scheduled_at : c.started_at || c.created_at)}</td></tr>`).join('')
        || '<tr><td colspan="8" class="muted">No campaigns yet.</td></tr>'}
    </table></div><p class="muted">Open rates are approximate — some email apps block tracking images.</p></div>`, 'campaigns');
}));

app.post('/campaigns/new', wrap(async (req, res) => {
  const r = await query(`INSERT INTO campaigns (name, subject, from_name, from_email, body) VALUES ($1, $2, $3, $4, $5) RETURNING id`, [
    `Campaign ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })}`,
    '', DEFAULT_FROM_NAME(), DEFAULT_FROM_EMAIL(),
    `Hi {{first_name|there}},\n\nOur new collection just dropped — and you get early access.\n\nUse code **EARLY10** for 10% off your next order.\n\n[[Shop the collection]](https://example.com)\n\nSee you soon,\n{{brand}}`,
  ]);
  res.redirect(`/campaigns/${r.rows[0].id}`);
}));

const getCampaign = async (id) => (await query('SELECT * FROM campaigns WHERE id = $1', [id])).rows[0];

app.get('/campaigns/:id', wrap(async (req, res) => {
  const c = await getCampaign(req.params.id);
  if (!c) return res.redirect('/campaigns');
  const tags = await allTags();
  const editable = c.status === 'draft';
  const count = await camp.audienceCount(c.audience_tag);
  const stats = (await query(`SELECT count(*)::int total,
      count(*) FILTER (WHERE status='sent')::int sent, count(*) FILTER (WHERE status='queued')::int queued,
      count(*) FILTER (WHERE status='failed')::int failed, count(*) FILTER (WHERE status='skipped')::int skipped,
      count(*) FILTER (WHERE opened_at IS NOT NULL)::int opened, count(*) FILTER (WHERE clicked_at IS NOT NULL)::int clicked
    FROM messages WHERE campaign_id = $1`, [c.id])).rows[0];
  const d = (v) => (editable ? '' : 'disabled');

  let actions = '';
  if (c.status === 'draft') {
    actions = `
      <div class="card"><h2>Send</h2>
        <p>This will go to <b>${count}</b> subscribed contact(s) with an email address${c.audience_tag ? ` tagged <span class="tag">${esc(c.audience_tag)}</span>` : ''}.
        ${!isLive() ? '<br><span class="muted">Test mode: emails are logged, not delivered, until you add a Brevo API key.</span>' : ''}
        ${count > camp.dailyLimit() ? `<br><span class="muted">That's more than your daily limit of ${camp.dailyLimit()}, so it will spread over ${Math.ceil(count / camp.dailyLimit())} days automatically.</span>` : ''}</p>
        <div class="row">
          <form method="post" action="/campaigns/${c.id}/send" onsubmit="return confirm('Send to ${count} contacts now?')"><button class="btn">Send now</button></form>
          <form method="post" action="/campaigns/${c.id}/schedule" class="row" style="flex:1;min-width:260px">
            <div><label>Or schedule (IST)</label><input type="datetime-local" name="when" required></div><button class="btn sec">Schedule</button></form>
        </div></div>
      <div class="card"><h2>Send a test</h2>
        <form method="post" action="/campaigns/${c.id}/test" class="row"><div><input type="email" name="to" placeholder="you@example.com" required></div><button class="btn sec">Send test email</button></form>
        <p class="muted">Save your changes first. The test uses a sample name ("Priya") for the {{first_name}} field.</p></div>`;
  } else {
    actions = `<div class="card"><h2>Progress</h2>
      ${c.note ? `<div class="flash info">${esc(c.note)}</div>` : ''}
      <div class="grid">
        <div class="stat"><b>${stats.sent} / ${stats.total}</b><span>Sent</span></div>
        <div class="stat"><b>${stats.queued}</b><span>Waiting</span></div>
        <div class="stat"><b>${pct(stats.opened, stats.sent)}</b><span>Opened (${stats.opened})</span></div>
        <div class="stat"><b>${pct(stats.clicked, stats.sent)}</b><span>Clicked (${stats.clicked})</span></div>
        <div class="stat"><b>${stats.failed}</b><span>Failed</span></div>
      </div>
      <div class="row">
        ${c.status === 'scheduled' ? `<p style="flex:1">Scheduled for <b>${fmtDate(c.scheduled_at)}</b> IST.</p><form method="post" action="/campaigns/${c.id}/unschedule"><button class="btn sec">Cancel schedule &amp; edit</button></form>` : ''}
        ${c.status === 'sending' ? `<form method="post" action="/campaigns/${c.id}/pause"><button class="btn sec">Pause</button></form>` : ''}
        ${c.status === 'paused' ? `<form method="post" action="/campaigns/${c.id}/resume"><button class="btn">Resume</button></form>` : ''}
        <form method="post" action="/campaigns/${c.id}/duplicate"><button class="btn sec">Duplicate</button></form>
        ${c.status === 'sending' || c.status === 'paused' ? '<a class="btn sec" href="">Refresh</a>' : ''}
      </div></div>
      ${stats.total ? await recipientsTable(c.id) : ''}`;
  }

  render(req, res, c.name, `
    <div class="row" style="align-items:center"><h1>${esc(c.name)} ${statusBadge(c.status)}</h1>
      ${editable ? `<form method="post" action="/campaigns/${c.id}/delete" class="right" onsubmit="return confirm('Delete this draft?')"><button class="btn sm danger">Delete</button></form>` : ''}</div>
    <form method="post" action="/campaigns/${c.id}"><div class="card">
      <div class="row">
        <div><label>Campaign name (only you see this)</label><input type="text" name="name" value="${esc(c.name)}" ${d()} required></div>
        <div><label>Audience</label><select name="audience_tag" ${d()}><option value="">All subscribed contacts</option>
          ${tags.map((t) => `<option value="${esc(t.t)}" ${c.audience_tag === t.t ? 'selected' : ''}>Tag: ${esc(t.t)} (${t.n})</option>`).join('')}</select></div>
      </div>
      <div class="row">
        <div><label>From name</label><input type="text" name="from_name" value="${esc(c.from_name)}" ${d()}></div>
        <div><label>From email (must be verified in Brevo)</label><input type="email" name="from_email" value="${esc(c.from_email)}" ${d()} placeholder="hello@yourstore.in"></div>
      </div>
      <label>Subject</label><input type="text" name="subject" value="${esc(c.subject)}" ${d()} placeholder="{{first_name}}, your early access is here 🎉">
      <label>Message</label><textarea name="body" ${d()}>${esc(c.body)}</textarea>
      <div class="help">Personalise with <code>{{first_name}}</code>, <code>{{name}}</code>, <code>{{city}}</code>, <code>{{brand}}</code>. Add a fallback like <code>{{first_name|there}}</code>.<br>
      <code>**bold**</code> · <code>[link text](https://...)</code> · a line with only <code>[[Button text]](https://...)</code> becomes a button. Blank line = new paragraph. You can also paste full HTML.<br>
      An unsubscribe link and your store details are added to the footer automatically.</div>
      ${editable ? '<p><button class="btn">Save</button></p>' : ''}
    </div></form>
    ${actions}
    <div class="card"><h2>Preview</h2><iframe class="preview" src="/campaigns/${c.id}/preview"></iframe></div>`, 'campaigns');
}));

async function recipientsTable(id) {
  const rows = (await query(`SELECT email, status, sent_at, opened_at, clicked_at, error FROM messages WHERE campaign_id = $1
    ORDER BY (status = 'failed') DESC, id LIMIT 200`, [id])).rows;
  return `<div class="card"><h2>Recipients</h2><div class="scroll"><table>
    <tr><th>Email</th><th>Status</th><th>Sent</th><th>Opened</th><th>Clicked</th></tr>
    ${rows.map((m) => `<tr><td>${esc(m.email)}${m.error ? `<br><span class="muted">${esc(m.error)}</span>` : ''}</td><td>${esc(m.status)}</td>
      <td class="muted">${fmtDate(m.sent_at)}</td><td>${m.opened_at ? '✓' : ''}</td><td>${m.clicked_at ? '✓' : ''}</td></tr>`).join('')}
  </table></div>${rows.length === 200 ? '<p class="muted">Showing the first 200.</p>' : ''}</div>`;
}

app.post('/campaigns/:id', wrap(async (req, res) => {
  const c = await getCampaign(req.params.id);
  if (!c) return res.redirect('/campaigns');
  if (c.status !== 'draft') { flash(req, 'err', 'Only drafts can be edited.'); return res.redirect(`/campaigns/${c.id}`); }
  const b = req.body;
  await query(`UPDATE campaigns SET name=$2, subject=$3, from_name=$4, from_email=$5, body=$6, audience_tag=NULLIF($7,'') WHERE id=$1`,
    [c.id, (b.name || 'Untitled').trim(), (b.subject || '').trim(), (b.from_name || '').trim(), (b.from_email || '').trim().toLowerCase(), b.body || '', b.audience_tag || '']);
  flash(req, 'ok', 'Saved.');
  res.redirect(`/campaigns/${c.id}`);
}));

app.get('/campaigns/:id/preview', wrap(async (req, res) => {
  const c = await getCampaign(req.params.id);
  if (!c) return res.status(404).end();
  const sample = (await query(`SELECT * FROM contacts WHERE subscribed AND email IS NOT NULL AND ($1::text IS NULL OR $1 = ANY(tags)) ORDER BY id LIMIT 1`, [c.audience_tag])).rows[0]
    || { name: 'Priya Sharma', city: 'Chennai', email: 'priya@example.com' };
  const { html, subject } = camp.renderEmail(c, sample, { tracking: false });
  res.send(html.replace('<body', `<body data-subject="${esc(subject)}"`).replace(/(<table role="presentation" width="100%")/,
    `<div style="max-width:600px;margin:16px auto 0;font:13px sans-serif;color:#555;padding:0 12px"><b>Subject:</b> ${esc(subject) || '<i>(no subject yet)</i>'}<br><span style="color:#999">Previewing as ${esc(sample.name || sample.email)}</span></div>$1`));
}));

function validateForSend(c) {
  if (!c.subject.trim()) return 'Add a subject line first.';
  if (!c.body.trim()) return 'Write the message first.';
  if (!importer.normalizeEmail(c.from_email)) return 'Add a valid From email (one you have verified in Brevo).';
  return null;
}

app.post('/campaigns/:id/test', wrap(async (req, res) => {
  const c = await getCampaign(req.params.id);
  const to = importer.normalizeEmail(req.body.to);
  const problem = validateForSend(c) || (!to && 'Enter a valid email for the test.');
  if (problem) { flash(req, 'err', problem); return res.redirect(`/campaigns/${c.id}`); }
  const { html, subject } = camp.renderEmail(c, { name: 'Priya Sharma', city: 'Chennai', email: to }, { tracking: false });
  const r = await sendEmail({ fromName: c.from_name, fromEmail: c.from_email, to, subject: `[Test] ${subject}`, html });
  if (r.ok) flash(req, r.dryRun ? 'info' : 'ok', r.dryRun ? 'Test mode: the test email was logged, not sent. Add your Brevo API key to send for real.' : `Test email sent to ${to}.`);
  else flash(req, 'err', `Couldn't send: ${r.error}`);
  res.redirect(`/campaigns/${c.id}`);
}));

app.post('/campaigns/:id/send', wrap(async (req, res) => {
  const c = await getCampaign(req.params.id);
  if (!c || c.status !== 'draft') return res.redirect(`/campaigns/${req.params.id}`);
  const problem = validateForSend(c) || ((await camp.audienceCount(c.audience_tag)) === 0 && 'No subscribed contacts with an email in this audience.');
  if (problem) { flash(req, 'err', problem); return res.redirect(`/campaigns/${c.id}`); }
  await camp.startCampaign(c.id);
  setImmediate(camp.tick);
  flash(req, 'ok', 'Sending started. Refresh this page to watch progress.');
  res.redirect(`/campaigns/${c.id}`);
}));

app.post('/campaigns/:id/schedule', wrap(async (req, res) => {
  const c = await getCampaign(req.params.id);
  if (!c || c.status !== 'draft') return res.redirect(`/campaigns/${req.params.id}`);
  const problem = validateForSend(c);
  if (problem) { flash(req, 'err', problem); return res.redirect(`/campaigns/${c.id}`); }
  const when = new Date(`${req.body.when}:00+05:30`);
  if (Number.isNaN(when.getTime()) || when < new Date()) { flash(req, 'err', 'Pick a time in the future.'); return res.redirect(`/campaigns/${c.id}`); }
  await query(`UPDATE campaigns SET status='scheduled', scheduled_at=$2 WHERE id=$1`, [c.id, when]);
  flash(req, 'ok', `Scheduled for ${fmtDate(when)} IST.`);
  res.redirect(`/campaigns/${c.id}`);
}));

const setStatus = (from, to, msg) => wrap(async (req, res) => {
  await query(`UPDATE campaigns SET status=$3, note=NULL ${to === 'draft' ? ', scheduled_at=NULL' : ''} WHERE id=$1 AND status=$2`, [req.params.id, from, to]);
  if (to === 'sending') setImmediate(camp.tick);
  flash(req, 'ok', msg);
  res.redirect(`/campaigns/${req.params.id}`);
});
app.post('/campaigns/:id/unschedule', setStatus('scheduled', 'draft', 'Schedule cancelled. You can edit the campaign again.'));
app.post('/campaigns/:id/pause', setStatus('sending', 'paused', 'Paused.'));
app.post('/campaigns/:id/resume', setStatus('paused', 'sending', 'Resumed.'));

app.post('/campaigns/:id/duplicate', wrap(async (req, res) => {
  const r = await query(`INSERT INTO campaigns (name, subject, from_name, from_email, body, audience_tag)
    SELECT name || ' (copy)', subject, from_name, from_email, body, audience_tag FROM campaigns WHERE id=$1 RETURNING id`, [req.params.id]);
  res.redirect(r.rows[0] ? `/campaigns/${r.rows[0].id}` : '/campaigns');
}));

app.post('/campaigns/:id/delete', wrap(async (req, res) => {
  await query(`DELETE FROM campaigns WHERE id=$1 AND status='draft'`, [req.params.id]);
  flash(req, 'ok', 'Draft deleted.');
  res.redirect('/campaigns');
}));

// ================= Setup =================

app.get('/settings', (req, res) => {
  const row = (ok, label, help) => `<tr><td>${ok ? '✅' : '⚠️'}</td><td><b>${label}</b><br><span class="muted">${help}</span></td></tr>`;
  render(req, res, 'Setup', `
    <h1>Setup</h1>
    <div class="card"><h2>Checklist</h2><table>
      ${row(isLive(), 'BREVO_API_KEY', 'Free Brevo account → Settings → SMTP &amp; API → API keys → Generate. Paste it as an environment variable on Render.')}
      ${row(!!process.env.FROM_EMAIL, 'FROM_EMAIL / FROM_NAME', 'Default sender for new campaigns. In Brevo, add it under Senders, Domains &amp; Dedicated IPs and authenticate your domain (SPF/DKIM) so emails don\'t land in spam.')}
      ${row(!!process.env.BRAND_NAME, 'BRAND_NAME', 'Shown at the top of every email and on the unsubscribe page.')}
      ${row(!!process.env.STORE_ADDRESS, 'STORE_ADDRESS', 'A contact address in the email footer — expected by Gmail and anti-spam rules.')}
      ${row(true, `DAILY_SEND_LIMIT = ${camp.dailyLimit()}`, 'Brevo\'s free plan allows 300 emails per day. Bigger campaigns automatically continue the next day.')}
      ${row(!!(process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL), `Public URL: ${esc(camp.baseUrl())}`, 'Used for unsubscribe, open and click tracking links. Render sets this automatically.')}
    </table></div>
    <div class="card"><h2>Good practice</h2><div class="help">
      • Only email people who bought from you or opted in. Every email includes an unsubscribe link, and unsubscribed contacts are never emailed again — even if you re-import them.<br>
      • Start with small batches to warm up your sender reputation.<br>
      • On Render's free plan the app sleeps after 15 minutes without visitors. Scheduled campaigns start when it wakes; a free uptime monitor (e.g. UptimeRobot pinging <code>/health</code> every 10 min) keeps it awake.
    </div></div>
    <form method="post" action="/logout"><button class="btn sec">Sign out</button></form>`, 'settings');
});

// ================= Errors & start =================

app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) { flash(req, 'err', 'File too large (max 15 MB).'); return res.redirect('/import'); }
  res.status(500).send(layout('Error', `<div class="flash err">Something went wrong: ${esc(err.message)}</div><a href="/" class="btn sec">Back</a>`, { live: isLive() }));
});

const PORT = process.env.PORT || 3000;
migrate().then(() => {
  app.listen(PORT, () => console.log(`Broadcast running on :${PORT} (${isLive() ? 'LIVE' : 'test mode'})`));
  camp.startWorker();
}).catch((err) => { console.error('Database setup failed:', err); process.exit(1); });
