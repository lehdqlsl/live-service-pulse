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

    res.render('dashboard', {
      monitors: result.rows,
      stats: statsResult.rows[0],
      sparklines,
      incidents: incidentsResult.rows,
      webhooks: webhooksResult.rows,
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Internal server error');
  }
});

export default router;
