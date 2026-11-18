# Broadcast — customer import + email campaigns

A small marketing app for your store:

- **Import** customers from CSV or Excel (.xlsx), including Shopify customer exports. Columns are detected automatically, Indian numbers are converted to `+91…`, invalid rows are skipped and duplicates merged.
- **Contacts**: search, filter by tag, bulk tag/untag/unsubscribe/delete, export CSV.
- **Campaigns**: personalised emails (`{{first_name}}`, `{{city}}`…), buttons, preview, test send, send now or schedule (IST).
- **Tracking**: sent, opened, clicked, failed per campaign.
- **Compliance**: unsubscribe link + one-click unsubscribe header in every email; unsubscribed people are never re-subscribed by a re-import.
- **Free-tier friendly**: respects Brevo's 300/day limit and continues big campaigns the next day automatically.

## Free services used
| Need | Service | Free allowance |
|---|---|---|
| Sending email | Brevo transactional API | 300 emails/day |
| Hosting | Render web service | Free (sleeps after 15 min idle) |
| Database | Render Postgres (or Neon / Supabase) | Render's free DB expires after 30 days — use Neon/Supabase for long term |

## Environment variables
| Name | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `ADMIN_PASSWORD` | yes | Password for the app login |
| `SESSION_SECRET` | recommended | Any long random string |
| `BREVO_API_KEY` | for real sending | Without it the app runs in **test mode** (emails are logged only) |
| `FROM_EMAIL`, `FROM_NAME` | recommended | Default sender; must be verified in Brevo |
| `BRAND_NAME` | recommended | Shown in the email header and unsubscribe page |
| `STORE_ADDRESS` | recommended | Contact address in the email footer |
| `DAILY_SEND_LIMIT` | no | Default 300 |
| `BASE_URL` | no | Public URL; Render sets `RENDER_EXTERNAL_URL` automatically |

## Run locally
```bash
npm install
DATABASE_URL=postgres://... ADMIN_PASSWORD=secret npm start
# open http://localhost:3000
```

## Deploy on Render
Push this repo to GitHub, then in Render: **New → Blueprint** and pick the repo. `render.yaml` creates the web service and a free database. Fill in `ADMIN_PASSWORD` and the other blank variables when asked.

## Brevo setup (10 minutes)
1. Sign up free at brevo.com.
2. **Senders, Domains & Dedicated IPs → Domains**: add your store domain and add the DNS records it shows (SPF/DKIM/DMARC) at your domain provider. This keeps you out of spam.
3. **Senders**: add the From address (e.g. `hello@yourstore.in`).
4. **SMTP & API → API keys**: generate a key and set it as `BREVO_API_KEY` on Render.

## Email formatting
```
Hi {{first_name|there}},

Use **DIWALI15** for 15% off. See the [lookbook](https://yourstore.in/lookbook).

[[Shop now]](https://yourstore.in/collections/new)
```
You can also paste full HTML.
