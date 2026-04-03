import { Router, Request, Response } from 'express';
import pool from '../db';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT
        m.*,
        c.status_code AS latest_status_code,
        c.response_time_ms AS latest_response_time,
        c.is_up AS latest_is_up,
        c.checked_at AS last_checked,
        stats.uptime_pct,
        stats.avg_response_time,
        stats.total_checks
      FROM monitors m
      LEFT JOIN LATERAL (
        SELECT status_code, response_time_ms, is_up, checked_at
        FROM checks WHERE monitor_id = m.id
        ORDER BY checked_at DESC LIMIT 1
      ) c ON true
      LEFT JOIN LATERAL (
        SELECT
          ROUND(AVG(CASE WHEN is_up THEN 1 ELSE 0 END) * 100, 2) AS uptime_pct,
          ROUND(AVG(response_time_ms)) AS avg_response_time,
          COUNT(*) AS total_checks
        FROM checks WHERE monitor_id = m.id
      ) stats ON true
      ORDER BY m.created_at DESC
    `);

    const statsResult = await pool.query(`
      SELECT
        COUNT(DISTINCT monitor_id) AS active_monitors,
        COUNT(*) AS total_checks,
        ROUND(AVG(CASE WHEN is_up THEN 1 ELSE 0 END) * 100, 1) AS overall_uptime,
        ROUND(AVG(response_time_ms)) AS avg_response_time,
        (SELECT COUNT(DISTINCT monitor_id) FROM checks WHERE checked_at > NOW() - INTERVAL '1 hour') AS connection_count
      FROM checks
      WHERE checked_at > NOW() - INTERVAL '24 hours'
    `);

    // Fetch sparkline data for each monitor
    const sparklines: Record<number, number[]> = {};
    for (const m of result.rows) {
      const sparkResult = await pool.query(
        'SELECT response_time_ms FROM checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT 60',
        [m.id]
      );
      sparklines[m.id] = sparkResult.rows.reverse().map((r: { response_time_ms: number }) => r.response_time_ms);
    }

    // Fetch mini-sparkline data (last 5 checks) for each monitor
    const miniSparklines: Record<number, number[]> = {};
    for (const m of result.rows) {
      const miniResult = await pool.query(
        'SELECT response_time_ms FROM checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT 5',
        [m.id]
      );
      miniSparklines[m.id] = miniResult.rows.reverse().map((r: { response_time_ms: number }) => r.response_time_ms);
    }

    // Fetch uptime bar data for each monitor (24 hourly buckets)
    const uptimeBars: Record<number, { hour: string; uptime: number }[]> = {};
    for (const m of result.rows) {
      const barResult = await pool.query(`
        SELECT
          date_trunc('hour', checked_at) AS hour,
          COUNT(*) AS total,
          SUM(CASE WHEN is_up THEN 1 ELSE 0 END) AS up_count
        FROM checks
        WHERE monitor_id = $1 AND checked_at > NOW() - INTERVAL '24 hours'
        GROUP BY date_trunc('hour', checked_at)
        ORDER BY hour ASC
      `, [m.id]);

      const buckets: { hour: string; uptime: number }[] = [];
      const now = new Date();
      for (let i = 23; i >= 0; i--) {
        const h = new Date(now);
        h.setMinutes(0, 0, 0);
        h.setHours(h.getHours() - i);
        const hourStr = h.toISOString().slice(0, 13);
        const row = barResult.rows.find((r: { hour: Date }) => new Date(r.hour).toISOString().slice(0, 13) === hourStr);
        if (row) {
          buckets.push({ hour: hourStr, uptime: Math.round((parseInt(row.up_count) / parseInt(row.total)) * 100) });
        } else {
          buckets.push({ hour: hourStr, uptime: -1 });
        }
      }
      uptimeBars[m.id] = buckets;
    }

    // Fetch recent incidents
    const incidentsResult = await pool.query(`
      SELECT i.*, m.name AS monitor_name, m.url AS monitor_url
      FROM incidents i
      JOIN monitors m ON m.id = i.monitor_id
      ORDER BY i.started_at DESC
      LIMIT 20
    `);

    // Fetch webhooks
    const webhooksResult = await pool.query('SELECT * FROM webhooks ORDER BY created_at DESC');

    // Collect all unique tags
    const allTags: string[] = [];
    for (const m of result.rows) {
      if (m.tags) {
        m.tags.split(',').map((t: string) => t.trim()).filter((t: string) => t).forEach((t: string) => {
          if (!allTags.includes(t)) allTags.push(t);
        });
      }
    }

    // Fetch notification channels
    const channelsResult = await pool.query('SELECT * FROM notification_channels ORDER BY created_at DESC');

    // Fetch latest SSL check for each monitor
    const sslData: Record<number, { issuer: string; subject: string; valid_from: string; valid_to: string; days_remaining: number; checked_at: string } | null> = {};
    for (const m of result.rows) {
      const sslResult = await pool.query(
        'SELECT * FROM ssl_checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT 1',
        [m.id]
      );
      sslData[m.id] = sslResult.rows.length > 0 ? sslResult.rows[0] : null;
    }

    // Fetch API keys
    const apiKeysResult = await pool.query('SELECT id, name, created_at, last_used_at FROM api_keys ORDER BY created_at DESC');

    // Footer stats: total checks ever, uptime streak, last incident
    const footerStatsResult = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM checks) AS total_checks_ever,
        (SELECT MAX(started_at) FROM incidents) AS last_incident_at
    `);
    const footerStats = footerStatsResult.rows[0];

    // Uptime streak: hours since last unresolved or most-recent incident
    const streakResult = await pool.query(`
      SELECT EXTRACT(EPOCH FROM (NOW() - COALESCE(
        (SELECT COALESCE(resolved_at, started_at) FROM incidents ORDER BY started_at DESC LIMIT 1),
        (SELECT MIN(checked_at) FROM checks)
      ))) / 3600 AS streak_hours
    `);
    footerStats.streak_hours = Math.floor(parseFloat(streakResult.rows[0]?.streak_hours) || 0);

    res.render('dashboard', {
      monitors: result.rows,
      stats: statsResult.rows[0],
      sparklines,
      miniSparklines,
      uptimeBars,
      sslData,
      incidents: incidentsResult.rows,
      webhooks: webhooksResult.rows,
      channels: channelsResult.rows,
      apiKeys: apiKeysResult.rows,
      allTags,
      footerStats,
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Internal server error');
  }
});

// GET /status - Public status page
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT
        m.*,
        c.status_code AS latest_status_code,
        c.response_time_ms AS latest_response_time,
        c.is_up AS latest_is_up,
        c.checked_at AS last_checked,
        stats.uptime_pct,
        stats.avg_response_time
      FROM monitors m
      LEFT JOIN LATERAL (
        SELECT status_code, response_time_ms, is_up, checked_at
        FROM checks WHERE monitor_id = m.id
        ORDER BY checked_at DESC LIMIT 1
      ) c ON true
      LEFT JOIN LATERAL (
        SELECT
          ROUND(AVG(CASE WHEN is_up THEN 1 ELSE 0 END) * 100, 2) AS uptime_pct,
          ROUND(AVG(response_time_ms)) AS avg_response_time
        FROM checks WHERE monitor_id = m.id
      ) stats ON true
      WHERE m.is_active = true
      ORDER BY m.created_at DESC
    `);

    // Fetch uptime bar data for each monitor (24 hourly buckets)
    const uptimeBars: Record<number, { hour: string; uptime: number }[]> = {};
    for (const m of result.rows) {
      const barResult = await pool.query(`
        SELECT
          date_trunc('hour', checked_at) AS hour,
          COUNT(*) AS total,
          SUM(CASE WHEN is_up THEN 1 ELSE 0 END) AS up_count
        FROM checks
        WHERE monitor_id = $1 AND checked_at > NOW() - INTERVAL '24 hours'
        GROUP BY date_trunc('hour', checked_at)
        ORDER BY hour ASC
      `, [m.id]);

      const buckets: { hour: string; uptime: number }[] = [];
      const now = new Date();
      for (let i = 23; i >= 0; i--) {
        const h = new Date(now);
        h.setMinutes(0, 0, 0);
        h.setHours(h.getHours() - i);
        const hourStr = h.toISOString().slice(0, 13);
        const row = barResult.rows.find((r: { hour: Date }) => new Date(r.hour).toISOString().slice(0, 13) === hourStr);
        if (row) {
          buckets.push({ hour: hourStr, uptime: Math.round((parseInt(row.up_count) / parseInt(row.total)) * 100) });
        } else {
          buckets.push({ hour: hourStr, uptime: -1 });
        }
      }
      uptimeBars[m.id] = buckets;
    }

    // Recent incidents
    const incidentsResult = await pool.query(`
      SELECT i.*, m.name AS monitor_name, m.url AS monitor_url
      FROM incidents i
      JOIN monitors m ON m.id = i.monitor_id
      ORDER BY i.started_at DESC
      LIMIT 20
    `);

    // Overall uptime
    const statsResult = await pool.query(`
      SELECT
        ROUND(AVG(CASE WHEN is_up THEN 1 ELSE 0 END) * 100, 1) AS overall_uptime
      FROM checks
      WHERE checked_at > NOW() - INTERVAL '24 hours'
    `);

    // Fetch latest SSL check for each monitor
    const sslData: Record<number, { days_remaining: number } | null> = {};
    for (const m of result.rows) {
      const sslResult = await pool.query(
        'SELECT days_remaining FROM ssl_checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT 1',
        [m.id]
      );
      sslData[m.id] = sslResult.rows.length > 0 ? sslResult.rows[0] : null;
    }

    res.render('status', {
      monitors: result.rows,
      uptimeBars,
      sslData,
      incidents: incidentsResult.rows,
      overallUptime: statsResult.rows[0].overall_uptime,
    });
  } catch (err) {
    console.error('Status page error:', err);
    res.status(500).send('Internal server error');
  }
});

// GET /history/:id - Paginated history page for a monitor
router.get('/history/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;

    const monitorResult = await pool.query('SELECT * FROM monitors WHERE id = $1', [id]);
    if (monitorResult.rows.length === 0) {
      res.status(404).send('Monitor not found');
      return;
    }

    const countResult = await pool.query('SELECT COUNT(*) AS total FROM checks WHERE monitor_id = $1', [id]);
    const total = parseInt(countResult.rows[0].total);
    const pages = Math.ceil(total / limit);

    const checksResult = await pool.query(
      'SELECT * FROM checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT $2 OFFSET $3',
      [id, limit, offset]
    );

    // Histogram data
    const histResult = await pool.query(`
      SELECT
        SUM(CASE WHEN response_time_ms >= 0 AND response_time_ms < 100 THEN 1 ELSE 0 END) AS "0-100",
        SUM(CASE WHEN response_time_ms >= 100 AND response_time_ms < 200 THEN 1 ELSE 0 END) AS "100-200",
        SUM(CASE WHEN response_time_ms >= 200 AND response_time_ms < 500 THEN 1 ELSE 0 END) AS "200-500",
        SUM(CASE WHEN response_time_ms >= 500 AND response_time_ms < 1000 THEN 1 ELSE 0 END) AS "500-1000",
        SUM(CASE WHEN response_time_ms >= 1000 THEN 1 ELSE 0 END) AS "1000+"
      FROM checks
      WHERE monitor_id = $1 AND response_time_ms IS NOT NULL
    `, [id]);

    const histRow = histResult.rows[0];
    const histogram = [
      { range: '0-100ms', count: parseInt(histRow['0-100']) || 0 },
      { range: '100-200ms', count: parseInt(histRow['100-200']) || 0 },
      { range: '200-500ms', count: parseInt(histRow['200-500']) || 0 },
      { range: '500-1000ms', count: parseInt(histRow['500-1000']) || 0 },
      { range: '1000ms+', count: parseInt(histRow['1000+']) || 0 },
    ];

    // Timeseries data for chart
    const timeseriesResult = await pool.query(
      `SELECT response_time_ms, checked_at FROM checks
       WHERE monitor_id = $1 AND checked_at > NOW() - INTERVAL '24 hours'
       ORDER BY checked_at ASC`,
      [id]
    );

    // Fetch latest SSL info
    const sslResult = await pool.query(
      'SELECT * FROM ssl_checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT 1',
      [id]
    );
    const sslInfo = sslResult.rows.length > 0 ? sslResult.rows[0] : null;

    res.render('history', {
      monitor: monitorResult.rows[0],
      checks: checksResult.rows,
      page,
      pages,
      total,
      histogram,
      timeseries: timeseriesResult.rows,
      sslInfo,
    });
  } catch (err) {
    console.error('History page error:', err);
    res.status(500).send('Internal server error');
  }
});

// GET /reports - Monthly SLA report page
router.get('/reports', async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const monthParam = (req.query.month as string) || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const [year, month] = monthParam.split('-').map(Number);
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;

    const result = await pool.query(`
      SELECT
        m.id, m.name, m.url,
        COUNT(c.id)::int AS total_checks,
        SUM(CASE WHEN c.is_up THEN 1 ELSE 0 END)::int AS successful_checks,
        ROUND(AVG(CASE WHEN c.is_up THEN 1 ELSE 0 END) * 100, 4) AS uptime_pct,
        ROUND(AVG(c.response_time_ms)) AS avg_response_ms,
        ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY c.response_time_ms)) AS p95_response_ms,
        MAX(c.response_time_ms) AS max_response_ms,
        (SELECT COUNT(*)::int FROM incidents i
         WHERE i.monitor_id = m.id
         AND i.started_at >= $1::date AND i.started_at < ($1::date + INTERVAL '1 month')) AS incidents_count,
        (SELECT COALESCE(SUM(COALESCE(i.duration_seconds, EXTRACT(EPOCH FROM (LEAST(NOW(), ($1::date + INTERVAL '1 month')::timestamptz) - i.started_at))::int)), 0)
         FROM incidents i
         WHERE i.monitor_id = m.id
         AND i.started_at >= $1::date AND i.started_at < ($1::date + INTERVAL '1 month')) AS total_downtime_seconds
      FROM monitors m
      LEFT JOIN checks c ON c.monitor_id = m.id
        AND c.checked_at >= $1::date AND c.checked_at < ($1::date + INTERVAL '1 month')
      GROUP BY m.id, m.name, m.url
      ORDER BY m.name ASC
    `, [startDate]);

    const monitors = result.rows.map(r => ({
      ...r,
      total_downtime_minutes: Math.round((parseInt(r.total_downtime_seconds) || 0) / 60),
      uptime_pct: r.uptime_pct !== null ? parseFloat(r.uptime_pct) : null,
    }));

    // Compute overall summary
    const totalChecks = monitors.reduce((s, m) => s + (m.total_checks || 0), 0);
    const totalSuccessful = monitors.reduce((s, m) => s + (m.successful_checks || 0), 0);
    const overallUptime = totalChecks > 0 ? (totalSuccessful / totalChecks * 100) : null;
    const avgResponse = monitors.filter(m => m.avg_response_ms).length > 0
      ? Math.round(monitors.reduce((s, m) => s + (parseFloat(m.avg_response_ms) || 0), 0) / monitors.filter(m => m.avg_response_ms).length)
      : null;
    const totalIncidents = monitors.reduce((s, m) => s + (m.incidents_count || 0), 0);
    const totalDowntime = monitors.reduce((s, m) => s + (m.total_downtime_minutes || 0), 0);

    // Build prev/next month strings
    const prevDate = new Date(year, month - 2, 1);
    const nextDate = new Date(year, month, 1);
    const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
    const nextMonth = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}`;
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

    res.render('reports', {
      monitors,
      month: monthParam,
      monthLabel: `${monthNames[month - 1]} ${year}`,
      prevMonth,
      nextMonth,
      summary: { totalChecks, totalSuccessful, overallUptime, avgResponse, totalIncidents, totalDowntime },
    });
  } catch (err) {
    console.error('Report page error:', err);
    res.status(500).send('Internal server error');
  }
});

export default router;
