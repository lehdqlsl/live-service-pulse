import { Router, Request, Response } from 'express';
import pool from '../db';
import { startMonitor, stopMonitor } from '../services/checker';

const router = Router();

// POST /api/monitors - Add a URL to monitor
router.post('/monitors', async (req: Request, res: Response) => {
  try {
    const { name, url, interval, tags } = req.body;

    if (!name || !url) {
      res.status(400).json({ error: 'name and url are required' });
      return;
    }

    const intervalSeconds = interval || 60;
    const tagsStr = tags || '';

    // Validate URL
    try {
      new URL(url);
    } catch {
      res.status(400).json({ error: 'Invalid URL' });
      return;
    }

    const result = await pool.query(
      `INSERT INTO monitors (name, url, interval_seconds, tags) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, url, intervalSeconds, tagsStr]
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

// PATCH /api/monitors/:id - Update a monitor
router.patch('/monitors/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, url, interval, tags } = req.body;

    const fields: string[] = [];
    const values: (string | number)[] = [];
    let idx = 1;

    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name); }
    if (url !== undefined) {
      try { new URL(url); } catch { res.status(400).json({ error: 'Invalid URL' }); return; }
      fields.push(`url = $${idx++}`); values.push(url);
    }
    if (interval !== undefined) { fields.push(`interval_seconds = $${idx++}`); values.push(interval); }
    if (tags !== undefined) { fields.push(`tags = $${idx++}`); values.push(tags); }

    if (fields.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(parseInt(id));
    const result = await pool.query(
      `UPDATE monitors SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Monitor not found' });
      return;
    }

    // Restart monitor if url or interval changed
    if (url !== undefined || interval !== undefined) {
      const monitor = result.rows[0];
      stopMonitor(parseInt(id));
      startMonitor({
        id: monitor.id,
        name: monitor.name,
        url: monitor.url,
        interval_seconds: monitor.interval_seconds,
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating monitor:', err);
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

// GET /api/monitors/:id/history - Get check history (paginated)
router.get('/monitors/:id/history', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
    const offset = (page - 1) * limit;

    const countResult = await pool.query(
      'SELECT COUNT(*) AS total FROM checks WHERE monitor_id = $1',
      [id]
    );
    const total = parseInt(countResult.rows[0].total);
    const pages = Math.ceil(total / limit);

    const result = await pool.query(
      `SELECT * FROM checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    );

    res.json({ data: result.rows, total, page, pages });
  } catch (err) {
    console.error('Error fetching history:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/monitors/:id/uptime-bar - 24 hourly uptime buckets
router.get('/monitors/:id/uptime-bar', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT
        date_trunc('hour', checked_at) AS hour,
        COUNT(*) AS total,
        SUM(CASE WHEN is_up THEN 1 ELSE 0 END) AS up_count
      FROM checks
      WHERE monitor_id = $1 AND checked_at > NOW() - INTERVAL '24 hours'
      GROUP BY date_trunc('hour', checked_at)
      ORDER BY hour ASC
    `, [id]);

    const buckets: { hour: string; uptime: number }[] = [];
    const now = new Date();
    for (let i = 23; i >= 0; i--) {
      const h = new Date(now);
      h.setMinutes(0, 0, 0);
      h.setHours(h.getHours() - i);
      const hourStr = h.toISOString().slice(0, 13);
      const row = result.rows.find((r: { hour: Date }) => new Date(r.hour).toISOString().slice(0, 13) === hourStr);
      if (row) {
        buckets.push({ hour: hourStr, uptime: Math.round((parseInt(row.up_count) / parseInt(row.total)) * 100) });
      } else {
        buckets.push({ hour: hourStr, uptime: -1 });
      }
    }

    res.json(buckets);
  } catch (err) {
    console.error('Error fetching uptime bar:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/monitors/:id/sparkline - Last 60 response times
router.get('/monitors/:id/sparkline', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT response_time_ms FROM checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT 60`,
      [id]
    );
    res.json(result.rows.reverse().map((r: { response_time_ms: number }) => r.response_time_ms));
  } catch (err) {
    console.error('Error fetching sparkline:', err);
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

// GET /api/incidents - List recent incidents
router.get('/incidents', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT i.*, m.name AS monitor_name, m.url AS monitor_url
      FROM incidents i
      JOIN monitors m ON m.id = i.monitor_id
      ORDER BY i.started_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching incidents:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/webhooks - Add a webhook
router.post('/webhooks', async (req: Request, res: Response) => {
  try {
    const { url, events } = req.body;

    if (!url) {
      res.status(400).json({ error: 'url is required' });
      return;
    }

    try {
      new URL(url);
    } catch {
      res.status(400).json({ error: 'Invalid URL' });
      return;
    }

    const result = await pool.query(
      'INSERT INTO webhooks (url, events) VALUES ($1, $2) RETURNING *',
      [url, events || 'down,up']
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating webhook:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/webhooks - List webhooks
router.get('/webhooks', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT * FROM webhooks ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing webhooks:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/webhooks/:id - Remove a webhook
router.delete('/webhooks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM webhooks WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }

    res.json({ message: 'Webhook deleted', webhook: result.rows[0] });
  } catch (err) {
    console.error('Error deleting webhook:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
