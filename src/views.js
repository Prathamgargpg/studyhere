const { esc } = require('./campaigns');

const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
}) : '—');
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

const CSS = `
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f6f7f9;color:#18181b;font-size:15px}
a{color:#2f5bea;text-decoration:none}a:hover{text-decoration:underline}
header{background:#111;color:#fff;padding:0 16px;display:flex;align-items:center;gap:18px;flex-wrap:wrap;position:sticky;top:0;z-index:5}
header .logo{font-weight:700;padding:14px 0;margin-right:8px}header nav{display:flex;gap:4px;overflow-x:auto}
header nav a{color:#bbb;padding:14px 10px;white-space:nowrap}header nav a.on{color:#fff;box-shadow:inset 0 -3px #fff}header nav a:hover{text-decoration:none;color:#fff}
header .mode{margin-left:auto;font-size:12px;padding:3px 8px;border-radius:99px}
.live{background:#16a34a}.dry{background:#ca8a04}
@media(max-width:640px){header{gap:0}header nav{order:3;width:100%}header nav a{padding:10px 10px 12px}}
main{max-width:1050px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:22px;margin:4px 0 16px}h2{font-size:17px;margin:0 0 12px}
.card{background:#fff;border:1px solid #e4e4e7;border-radius:10px;padding:18px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
.stat{background:#fff;border:1px solid #e4e4e7;border-radius:10px;padding:14px}.stat b{display:block;font-size:24px}.stat span{color:#71717a;font-size:13px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 8px;border-bottom:1px solid #f0f0f2;vertical-align:top}
th{font-size:12px;text-transform:uppercase;color:#71717a;font-weight:600}.scroll{overflow-x:auto}
label{display:block;font-weight:600;font-size:13px;margin:12px 0 5px}
input[type=text],input[type=email],input[type=password],input[type=datetime-local],input[type=search],select,textarea{width:100%;padding:9px 10px;border:1px solid #d4d4d8;border-radius:7px;font:inherit;background:#fff}
textarea{min-height:260px;font-family:ui-monospace,Menlo,monospace;font-size:14px}
.btn{display:inline-block;background:#111;color:#fff;border:0;border-radius:7px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer}
.btn:hover{text-decoration:none;opacity:.9}.btn.sec{background:#fff;color:#111;border:1px solid #d4d4d8}.btn.danger{background:#dc2626}.btn.sm{padding:5px 10px;font-size:13px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:end}.row>*{flex:1;min-width:160px}.row>.btn,.row>form{flex:0 0 auto;min-width:0}
.flash{padding:12px 14px;border-radius:8px;margin-bottom:14px}.flash.ok{background:#dcfce7;color:#14532d}.flash.err{background:#fee2e2;color:#7f1d1d}.flash.info{background:#fef9c3;color:#713f12}
.tag{display:inline-block;background:#eef2ff;color:#3730a3;border-radius:99px;padding:1px 8px;font-size:12px;margin:1px 2px 1px 0}
.badge{display:inline-block;border-radius:99px;padding:2px 9px;font-size:12px;font-weight:600;background:#f4f4f5}
.b-sent{background:#dcfce7;color:#166534}.b-sending{background:#dbeafe;color:#1e40af}.b-scheduled{background:#fef9c3;color:#854d0e}.b-paused{background:#fee2e2;color:#991b1b}
.muted{color:#71717a;font-size:13px}.inline{display:inline}.right{text-align:right}
.help{background:#fafafa;border:1px dashed #d4d4d8;border-radius:8px;padding:12px;font-size:13px;line-height:1.6}
code{background:#f4f4f5;padding:1px 5px;border-radius:4px;font-size:13px}
iframe.preview{width:100%;height:560px;border:1px solid #e4e4e7;border-radius:8px;background:#fff}
`;

function layout(title, body, { active = '', flash = null, live = false } = {}) {
  const link = (href, label, key) => `<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`;
  const f = flash ? `<div class="flash ${esc(flash.type || 'ok')}">${esc(flash.msg)}</div>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Broadcast</title><style>${CSS}</style></head><body>
<header><span class="logo">📣 Broadcast</span><nav>
${link('/', 'Dashboard', 'home')}${link('/contacts', 'Contacts', 'contacts')}${link('/import', 'Import', 'import')}${link('/campaigns', 'Campaigns', 'campaigns')}${link('/settings', 'Setup', 'settings')}
</nav><span class="mode ${live ? 'live' : 'dry'}">${live ? 'Live sending' : 'Test mode'}</span></header>
<main>${f}${body}</main></body></html>`;
}

function loginPage(error) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title><style>${CSS}</style></head>
<body><main style="max-width:380px;margin-top:10vh"><div class="card"><h1>📣 Broadcast</h1>
${error ? `<div class="flash err">${esc(error)}</div>` : ''}
<form method="post" action="/login"><label>Admin password</label><input type="password" name="password" autofocus required>
<p><button class="btn" style="width:100%">Sign in</button></p></form></div></main></body></html>`;
}

const statusBadge = (s) => `<span class="badge b-${esc(s)}">${esc(s)}</span>`;

module.exports = { layout, loginPage, esc, fmtDate, pct, statusBadge };
