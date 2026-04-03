import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

export async function initDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS monitors (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        url TEXT NOT NULL,
        interval_seconds INTEGER NOT NULL DEFAULT 60,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_active BOOLEAN NOT NULL DEFAULT true,
        tags TEXT NOT NULL DEFAULT ''
      );
    `);
    await client.query(`ALTER TABLE monitors ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT ''`);
    await client.query(`ALTER TABLE monitors ADD COLUMN IF NOT EXISTS is_paused BOOLEAN NOT NULL DEFAULT false`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS checks (
        id SERIAL PRIMARY KEY,
        monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        status_code INTEGER,
        response_time_ms INTEGER,
        is_up BOOLEAN NOT NULL,
        checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_checks_monitor_id_checked_at
      ON checks (monitor_id, checked_at DESC);
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS incidents (
        id SERIAL PRIMARY KEY,
        monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        duration_seconds INTEGER
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_incidents_monitor_id
      ON incidents (monitor_id, started_at DESC);
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id SERIAL PRIMARY KEY,
        url TEXT NOT NULL,
        events TEXT NOT NULL DEFAULT 'down,up',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('Database tables initialized');
  } finally {
    client.release();
  }
}

export default pool;
