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
    await client.query(`ALTER TABLE monitors ADD COLUMN IF NOT EXISTS depends_on INTEGER REFERENCES monitors(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE monitors ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE monitors ADD COLUMN IF NOT EXISTS alert_threshold_ms INTEGER`);
    await client.query(`ALTER TABLE monitors ADD COLUMN IF NOT EXISTS alert_enabled BOOLEAN NOT NULL DEFAULT false`);
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
    await client.query(`ALTER TABLE checks ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0`);
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
    await client.query(`
      CREATE TABLE IF NOT EXISTS notification_channels (
        id SERIAL PRIMARY KEY,
        type TEXT NOT NULL,
        config JSONB NOT NULL DEFAULT '{}',
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ssl_checks (
        id SERIAL PRIMARY KEY,
        monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        issuer TEXT,
        subject TEXT,
        valid_from TIMESTAMPTZ,
        valid_to TIMESTAMPTZ,
        days_remaining INTEGER,
        checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_ssl_checks_monitor_id
      ON ssl_checks (monitor_id, checked_at DESC);
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        key_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // Maintenance windows
    await client.query(`
      CREATE TABLE IF NOT EXISTS maintenance_windows (
        id SERIAL PRIMARY KEY,
        monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        start_time TIMESTAMPTZ NOT NULL,
        end_time TIMESTAMPTZ NOT NULL,
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Monitor groups
    await client.query(`
      CREATE TABLE IF NOT EXISTS monitor_groups (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        color TEXT DEFAULT '#6366f1',
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Add group_id to monitors
    await client.query(`ALTER TABLE monitors ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES monitor_groups(id) ON DELETE SET NULL`);

    // Insert default settings if not present
    await client.query(`
      INSERT INTO settings (key, value) VALUES ('checks_retention_days', '90')
      ON CONFLICT (key) DO NOTHING
    `);
    console.log('Database tables initialized');
  } finally {
    client.release();
  }
}

export async function runRetentionCleanup(): Promise<void> {
  try {
    const result = await pool.query("SELECT value FROM settings WHERE key = 'checks_retention_days'");
    const days = result.rows.length > 0 ? parseInt(result.rows[0].value) : 90;
    if (days <= 0) return;

    const checksResult = await pool.query(
      `DELETE FROM checks WHERE checked_at < NOW() - INTERVAL '1 day' * $1`,
      [days]
    );
    const sslResult = await pool.query(
      `DELETE FROM ssl_checks WHERE checked_at < NOW() - INTERVAL '1 day' * $1`,
      [days]
    );
    console.log(`Retention cleanup: removed ${checksResult.rowCount} checks, ${sslResult.rowCount} ssl_checks older than ${days} days`);
  } catch (err) {
    console.error('Retention cleanup error:', err);
  }
}

export default pool;
