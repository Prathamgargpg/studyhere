const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add a Postgres connection string (Render, Neon or Supabase).');
  process.exit(1);
}

// Optional: keep this app's tables in their own schema, so it can safely share
// a database with another app (e.g. PG_SCHEMA=broadcast).
const SCHEMA = (process.env.PG_SCHEMA || '').replace(/[^a-z0-9_]/gi, '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  ...(SCHEMA ? { options: `-c search_path=${SCHEMA}` } : {}),
});

const query = (text, params) => pool.query(text, params);

async function migrate() {
  if (SCHEMA) await query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  await query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      email TEXT,
      phone TEXT,
      name TEXT,
      city TEXT,
      tags TEXT[] NOT NULL DEFAULT '{}',
      source TEXT,
      subscribed BOOLEAN NOT NULL DEFAULT TRUE,
      unsub_token TEXT NOT NULL UNIQUE DEFAULT md5(random()::text || clock_timestamp()::text),
      unsubscribed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS contacts_email_uq ON contacts (lower(email)) WHERE email IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS contacts_phone_uq ON contacts (phone) WHERE phone IS NOT NULL;
    CREATE INDEX IF NOT EXISTS contacts_tags_idx ON contacts USING GIN (tags);

    CREATE TABLE IF NOT EXISTS imports (
      id SERIAL PRIMARY KEY,
      filename TEXT,
      headers JSONB NOT NULL,
      rows JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      from_name TEXT NOT NULL DEFAULT '',
      from_email TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      audience_tag TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      scheduled_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
      email TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE DEFAULT md5(random()::text || clock_timestamp()::text),
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      sent_at TIMESTAMPTZ,
      opened_at TIMESTAMPTZ,
      clicked_at TIMESTAMPTZ,
      clicks INTEGER NOT NULL DEFAULT 0,
      UNIQUE (campaign_id, contact_id)
    );
    CREATE INDEX IF NOT EXISTS messages_status_idx ON messages (campaign_id, status);
    CREATE INDEX IF NOT EXISTS messages_sent_idx ON messages (sent_at);
  `);
  // Drop abandoned import previews older than a day
  await query(`DELETE FROM imports WHERE created_at < now() - interval '1 day'`);
}

module.exports = { pool, query, migrate };
