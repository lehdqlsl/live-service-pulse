import { Router, Request, Response } from 'express';
import pool from '../db';

const router = Router();

// GET /metrics - Prometheus-compatible metrics endpoint
router.get('/', async (_req: Request, res: Response) => {
  try {
    // Monitor counts
    const monitorsResult = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_active AND NOT is_paused) AS active,
        COUNT(*) FILTER (WHERE is_paused) AS paused,
        COUNT(*) FILTER (WHERE NOT is_active) AS inactive,
        COUNT(*) AS total
      FROM monitors
    `);
    const mc = monitorsResult.rows[0];

    // Recent check stats (last 5 minutes)
    const checksResult = await pool.query(`
      SELECT
        COUNT(*) AS total_checks,
        COUNT(*) FILTER (WHERE is_up) AS up_checks,
        COUNT(*) FILTER (WHERE NOT is_up) AS down_checks,
        COALESCE(AVG(response_time_ms), 0) AS avg_response_ms,
        COALESCE(MAX(response_time_ms), 0) AS max_response_ms,
        COALESCE(MIN(response_time_ms), 0) AS min_response_ms,
        COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY response_time_ms), 0) AS p50_response_ms,
        COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms), 0) AS p95_response_ms,
        COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY response_time_ms), 0) AS p99_response_ms
      FROM checks
      WHERE checked_at > NOW() - INTERVAL '5 minutes'
    `);
    const cs = checksResult.rows[0];

    // Per-monitor latest status
    const perMonitorResult = await pool.query(`
      SELECT
        m.id, m.name,
        c.is_up, c.response_time_ms, c.status_code
      FROM monitors m
      LEFT JOIN LATERAL (
        SELECT is_up, response_time_ms, status_code
        FROM checks WHERE monitor_id = m.id
        ORDER BY checked_at DESC LIMIT 1
      ) c ON true
      WHERE m.is_active = true
    `);

    // Open incidents
    const incidentsResult = await pool.query(
      'SELECT COUNT(*) AS open_incidents FROM incidents WHERE resolved_at IS NULL'
    );

    // SSL certificates expiring soon
    const sslResult = await pool.query(`
      SELECT COUNT(DISTINCT monitor_id) AS expiring_soon
      FROM ssl_checks sc
      WHERE sc.days_remaining < 30
      AND sc.checked_at = (SELECT MAX(checked_at) FROM ssl_checks WHERE monitor_id = sc.monitor_id)
    `);

    // Pool stats
    const poolStats = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };

    // Format as Prometheus text
    const lines: string[] = [
      '# HELP pulse_monitors_total Total number of monitors',
      '# TYPE pulse_monitors_total gauge',
      `pulse_monitors_total ${mc.total}`,
      `pulse_monitors_active ${mc.active}`,
      `pulse_monitors_paused ${mc.paused}`,
      '',
      '# HELP pulse_checks_total Checks in last 5 minutes',
      '# TYPE pulse_checks_total gauge',
      `pulse_checks_total ${cs.total_checks}`,
      `pulse_checks_up ${cs.up_checks}`,
      `pulse_checks_down ${cs.down_checks}`,
      '',
      '# HELP pulse_response_time_ms Response time statistics (5min window)',
      '# TYPE pulse_response_time_ms gauge',
      `pulse_response_time_avg_ms ${Math.round(cs.avg_response_ms)}`,
      `pulse_response_time_min_ms ${cs.min_response_ms}`,
      `pulse_response_time_max_ms ${cs.max_response_ms}`,
      `pulse_response_time_p50_ms ${Math.round(cs.p50_response_ms)}`,
      `pulse_response_time_p95_ms ${Math.round(cs.p95_response_ms)}`,
      `pulse_response_time_p99_ms ${Math.round(cs.p99_response_ms)}`,
      '',
      '# HELP pulse_incidents_open Currently open incidents',
      '# TYPE pulse_incidents_open gauge',
      `pulse_incidents_open ${incidentsResult.rows[0].open_incidents}`,
      '',
      '# HELP pulse_ssl_expiring_soon SSL certs expiring within 30 days',
      '# TYPE pulse_ssl_expiring_soon gauge',
      `pulse_ssl_expiring_soon ${sslResult.rows[0].expiring_soon}`,
      '',
      '# HELP pulse_db_pool Database connection pool stats',
      '# TYPE pulse_db_pool gauge',
      `pulse_db_pool_total ${poolStats.total}`,
      `pulse_db_pool_idle ${poolStats.idle}`,
      `pulse_db_pool_waiting ${poolStats.waiting}`,
      '',
    ];

    // Per-monitor metrics
    lines.push('# HELP pulse_monitor_up Monitor up status (1=up, 0=down)');
    lines.push('# TYPE pulse_monitor_up gauge');
    for (const m of perMonitorResult.rows) {
      const label = m.name.replace(/"/g, '\\"');
      lines.push(`pulse_monitor_up{monitor="${label}",id="${m.id}"} ${m.is_up ? 1 : 0}`);
    }
    lines.push('');
    lines.push('# HELP pulse_monitor_response_ms Latest response time per monitor');
    lines.push('# TYPE pulse_monitor_response_ms gauge');
    for (const m of perMonitorResult.rows) {
      const label = m.name.replace(/"/g, '\\"');
      lines.push(`pulse_monitor_response_ms{monitor="${label}",id="${m.id}"} ${m.response_time_ms || 0}`);
    }

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(lines.join('\n') + '\n');
  } catch (err) {
    console.error('Metrics error:', err);
    res.status(500).send('# Error generating metrics\n');
  }
});

export default router;
