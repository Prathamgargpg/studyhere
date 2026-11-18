// Sends email through Brevo's free transactional API.
// With no BREVO_API_KEY set, runs in dry-run mode: emails are logged, not sent.

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

function isLive() {
  return Boolean(process.env.BREVO_API_KEY);
}

async function sendEmail({ fromName, fromEmail, to, toName, subject, html, unsubscribeUrl }) {
  if (!isLive()) {
    console.log(`[dry-run] to=${to} subject="${subject}"`);
    return { ok: true, dryRun: true };
  }
  const body = {
    sender: { name: fromName || undefined, email: fromEmail },
    to: [{ email: to, name: toName || undefined }],
    subject,
    htmlContent: html,
  };
  if (unsubscribeUrl) {
    body.headers = {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }
  let res;
  try {
    res = await fetch(BREVO_URL, {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, retry: true, error: `Network error: ${err.message}` };
  }
  if (res.ok) return { ok: true };
  const text = await res.text().catch(() => '');
  let msg = text;
  try { msg = JSON.parse(text).message || text; } catch (_) { /* keep raw */ }
  return {
    ok: false,
    retry: res.status === 429 || res.status >= 500,
    fatal: res.status === 401 || res.status === 403,
    error: `Brevo ${res.status}: ${msg}`.slice(0, 500),
  };
}

module.exports = { sendEmail, isLive };
