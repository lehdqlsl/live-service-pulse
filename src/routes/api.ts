import { Router, Request, Response } from 'express';
import pool from '../db';
import { startMonitor, stopMonitor } from '../services/checker';

const router = Router();

// POST /api/monitors - Add a URL to monitor
router.post('/monitors', async (req: Request, res: Response) => {
  try {
    const { name, url, interval } = req.body;

    if (!name || !url) {
      res.status(400).json({ error: 'name and url are required' });
      return;
    }

    const intervalSeconds = interval || 60;

    // Validate URL
    try {
      new URL(url);
    } catch {
      res.status(400).json({ error: 'Invalid URL' });
      return;
    }

    const result = await pool.query(
      `INSERT INTO monitors (name, url, interval_seconds) VALUES ($1, $2, $3) RETURNING *`,
      [name, url, intervalSeconds]
    );

    const monitor = result.rows[0];
    startMonitor({
      id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      interval_seconds: monitor.interval_seconds,
    });

    res.status(201).json(monitor);
  } catch (err) {
    console.error('Error creating monitor:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/monitors - List all monitors with latest status
router.get('/monitors', async (_req: Request, res: Response) => {
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
      ORDER BY m.created_at DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error('Error listing monitors:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/monitors/:id - Remove a monitor
router.delete('/monitors/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM monitors WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Monitor not found' });
      return;
    }

    stopMonitor(parseInt(id));
    res.json({ message: 'Monitor deleted', monitor: result.rows[0] });
  } catch (err) {
    console.error('Error deleting monitor:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/monitors/:id/history - Get check history
router.get('/monitors/:id/history', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT * FROM checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT 100`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stats - Overall statistics
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const monitors = await pool.query('SELECT COUNT(*) AS total FROM monitors WHERE is_active = true');
    const checks = await pool.query(`
      SELECT
        COUNT(*) AS total_checks,
        ROUND(AVG(CASE WHEN is_up THEN 1 ELSE 0 END) * 100, 2) AS overall_uptime,
        ROUND(AVG(response_time_ms)) AS avg_response_time
      FROM checks
      WHERE checked_at > NOW() - INTERVAL '24 hours'
    `);

    res.json({
      total_monitors: parseInt(monitors.rows[0].total),
      ...checks.rows[0],
    });
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
