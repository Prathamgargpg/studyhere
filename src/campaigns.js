const { query } = require('./db');
const { sendEmail, isLive } = require('./mailer');

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 3;

const baseUrl = () =>
  (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const dailyLimit = () => Number(process.env.DAILY_SEND_LIMIT || 300);
const brandName = () => process.env.BRAND_NAME || 'Our store';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Rendering ----------

function mergeFields(text, contact, { html }) {
  const first = (contact.name || '').trim().split(/\s+/)[0] || '';
  const values = {
    first_name: first, name: contact.name || '', city: contact.city || '',
    email: contact.email || '', phone: contact.phone || '', brand: brandName(),
  };
  return text.replace(/\{\{\s*([a-z_]+)\s*(?:\|\s*([^}]*))?\}\}/gi, (m, key, fallback) => {
    const k = key.toLowerCase();
    if (!(k in values)) return m;
    const v = values[k] || (fallback || '').trim();
    return html ? esc(v) : v;
  });
}

// Plain text with light formatting -> HTML. Real HTML is passed through untouched.
function bodyToHtml(body) {
  if (/<(p|div|table|br|h[1-6]|img|a)\b/i.test(body)) return body;
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" style="color:#2f5bea">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" style="color:#2f5bea">$2</a>');
  return body.replace(/\r/g, '').split(/\n{2,}/).map((block) => {
    const btn = block.trim().match(/^\[\[([^\]]+)\]\]\((https?:\/\/[^\s)]+)\)$/);
    if (btn) {
      return `<p style="margin:24px 0;text-align:center"><a href="${esc(btn[2])}" style="background:#111;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;display:inline-block;font-weight:600">${esc(btn[1])}</a></p>`;
    }
    return `<p style="margin:0 0 16px">${block.split('\n').map(inline).join('<br>')}</p>`;
  }).join('\n');
}

function extractLinks(html) {
  const out = [];
  html.replace(/href\s*=\s*"(https?:\/\/[^"]+)"/gi, (_, u) => out.push(u.replace(/&amp;/g, '&')));
  return out;
}

function renderEmail(campaign, contact, { token, unsubToken, tracking = true } = {}) {
  const merged = mergeFields(campaign.body, contact, { html: true });
  let inner = bodyToHtml(merged);
  if (tracking && token) {
    inner = inner.replace(/href\s*=\s*"(https?:\/\/[^"]+)"/gi, (_, u) =>
      `href="${baseUrl()}/t/c/${token}?u=${encodeURIComponent(u.replace(/&amp;/g, '&'))}"`);
  }
  const unsubUrl = unsubToken ? `${baseUrl()}/u/${unsubToken}` : '#';
  const address = process.env.STORE_ADDRESS ? `<br>${esc(process.env.STORE_ADDRESS)}` : '';
  const pixel = tracking && token ? `<img src="${baseUrl()}/t/o/${token}.gif" width="1" height="1" alt="" style="display:block;border:0">` : '';
  const html = `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:8px">
<tr><td style="padding:28px 28px 8px;font-size:20px;font-weight:700;color:#111">${esc(brandName())}</td></tr>
<tr><td style="padding:8px 28px 20px;font-size:15px;line-height:1.6;color:#222">${inner}</td></tr>
</table>
<p style="max-width:600px;font-size:12px;line-height:1.5;color:#777;margin:16px auto 0;text-align:center">
You're getting this email because you're a customer of ${esc(brandName())}.${address}<br>
<a href="${unsubUrl}" style="color:#777">Unsubscribe</a></p>
${pixel}
</td></tr></table></body></html>`;
  return { html, subject: mergeFields(campaign.subject, contact, { html: false }), unsubUrl };
}

// ---------- Audience & lifecycle ----------

async function audienceCount(tag) {
  const r = await query(
    `SELECT count(*)::int AS n FROM contacts WHERE subscribed AND email IS NOT NULL AND ($1::text IS NULL OR $1 = ANY(tags))`,
    [tag || null]
  );
  return r.rows[0].n;
}

async function startCampaign(id) {
  const c = (await query('SELECT * FROM campaigns WHERE id = $1', [id])).rows[0];
  if (!c) throw new Error('Campaign not found');
  await query(
    `INSERT INTO messages (campaign_id, contact_id, email)
     SELECT $1, id, email FROM contacts
     WHERE subscribed AND email IS NOT NULL AND ($2::text IS NULL OR $2 = ANY(tags))
     ON CONFLICT DO NOTHING`,
    [id, c.audience_tag || null]
  );
  await query(`UPDATE campaigns SET status = 'sending', started_at = COALESCE(started_at, now()), note = NULL WHERE id = $1`, [id]);
}

async function sentToday() {
  const r = await query(
    `SELECT count(*)::int AS n FROM messages
     WHERE status = 'sent' AND sent_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`
  );
  return r.rows[0].n;
}

// ---------- Worker ----------

let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const due = await query(`SELECT id FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= now()`);
    for (const row of due.rows) await startCampaign(row.id);

    const active = await query(`SELECT * FROM campaigns WHERE status = 'sending' ORDER BY started_at`);
    for (const campaign of active.rows) {
      const remaining = dailyLimit() - (await sentToday());
      if (remaining <= 0) {
        await query(`UPDATE campaigns SET note = $2 WHERE id = $1`, [campaign.id,
          `Daily limit of ${dailyLimit()} emails reached. Sending continues automatically after midnight (IST).`]);
        break;
      }
      const batch = await query(
        `SELECT m.*, c.name, c.city, c.phone, c.subscribed, c.unsub_token
         FROM messages m LEFT JOIN contacts c ON c.id = m.contact_id
         WHERE m.campaign_id = $1 AND m.status = 'queued' ORDER BY m.id LIMIT $2`,
        [campaign.id, Math.min(BATCH_SIZE, remaining)]
      );

      if (!batch.rows.length) {
        await query(`UPDATE campaigns SET status = 'sent', finished_at = now(), note = NULL WHERE id = $1`, [campaign.id]);
        continue;
      }
      await query(`UPDATE campaigns SET note = NULL WHERE id = $1 AND note LIKE 'Daily limit%'`, [campaign.id]);

      for (const m of batch.rows) {
        if (!m.contact_id || !m.subscribed) {
          await query(`UPDATE messages SET status = 'skipped', error = 'Unsubscribed or deleted' WHERE id = $1`, [m.id]);
          continue;
        }
        const contact = { name: m.name, city: m.city, email: m.email, phone: m.phone };
        const { html, subject, unsubUrl } = renderEmail(campaign, contact, { token: m.token, unsubToken: m.unsub_token });
        const res = await sendEmail({
          fromName: campaign.from_name, fromEmail: campaign.from_email,
          to: m.email, toName: m.name, subject, html, unsubscribeUrl: unsubUrl,
        });
        if (res.ok) {
          await query(`UPDATE messages SET status = 'sent', sent_at = now(), attempts = attempts + 1, error = NULL WHERE id = $1`, [m.id]);
        } else if (res.fatal || /sender/i.test(res.error || '')) {
          await query(`UPDATE messages SET attempts = attempts + 1, error = $2 WHERE id = $1`, [m.id, res.error]);
          await query(`UPDATE campaigns SET status = 'paused', note = $2 WHERE id = $1`, [campaign.id,
            `Paused: ${res.error}. Fix the Brevo API key or verify the sender email in Brevo, then press Resume.`]);
          break;
        } else {
          const attempts = m.attempts + 1;
          const status = res.retry && attempts < MAX_ATTEMPTS ? 'queued' : 'failed';
          await query(`UPDATE messages SET status = $2, attempts = $3, error = $4 WHERE id = $1`, [m.id, status, attempts, res.error]);
          if (res.retry) break; // back off until next tick
        }
        if (isLive()) await new Promise((r) => setTimeout(r, 120));
      }
    }
  } catch (err) {
    console.error('Worker error:', err);
  } finally {
    running = false;
  }
}

function startWorker() {
  setInterval(tick, Number(process.env.WORKER_INTERVAL_MS || 15000));
  setTimeout(tick, 2000);
}

module.exports = {
  renderEmail, extractLinks, mergeFields, audienceCount, startCampaign, sentToday,
  dailyLimit, baseUrl, brandName, tick, startWorker, esc,
};
