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
        ROUND(AVG(response_time_ms)) AS avg_response_time
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

    res.render('dashboard', {
      monitors: result.rows,
      stats: statsResult.rows[0],
      sparklines,
      uptimeBars,
      incidents: incidentsResult.rows,
      webhooks: webhooksResult.rows,
      allTags,
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

    res.render('status', {
      monitors: result.rows,
      uptimeBars,
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

    res.render('history', {
      monitor: monitorResult.rows[0],
      checks: checksResult.rows,
      page,
      pages,
      total,
      histogram,
    });
  } catch (err) {
    console.error('History page error:', err);
    res.status(500).send('Internal server error');
  }
});

export default router;
