import { Router, Request, Response } from 'express';
import pool from '../db';
import { startMonitor, stopMonitor, checkerEvents } from '../services/checker';

const router = Router();

// SSE endpoint for real-time updates
router.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send initial keepalive
  res.write(':ok\n\n');

  const onCheck = (data: { monitorId: number; isUp: boolean; responseTime: number; statusCode: number | null; checkedAt: string }) => {
    res.write(`event: check\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const onIncident = (data: { type: string; monitorId: number; monitorName: string; monitorUrl: string; startedAt?: string; resolvedAt?: string }) => {
    res.write(`event: incident\ndata: ${JSON.stringify(data)}\n\n`);
  };

  checkerEvents.on('check', onCheck);
  checkerEvents.on('incident', onIncident);

  // Keepalive every 15s
  const keepalive = setInterval(() => {
    res.write(':ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(keepalive);
    checkerEvents.off('check', onCheck);
    checkerEvents.off('incident', onIncident);
  });
});

// POST /api/monitors - Add a URL to monitor
router.post('/monitors', async (req: Request, res: Response) => {
  try {
    const { name, url, interval, tags, depends_on, max_retries, alert_threshold_ms, alert_enabled, group_id } = req.body;

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
      `INSERT INTO monitors (name, url, interval_seconds, tags, depends_on, max_retries, alert_threshold_ms, alert_enabled, group_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [name, url, intervalSeconds, tagsStr, depends_on || null, max_retries || 0, alert_threshold_ms || null, alert_enabled || false, group_id || null]
    );

    const monitor = result.rows[0];
    startMonitor({
      id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      interval_seconds: monitor.interval_seconds,
      depends_on: monitor.depends_on || null,
      max_retries: monitor.max_retries || 0,
      alert_threshold_ms: monitor.alert_threshold_ms || null,
      alert_enabled: monitor.alert_enabled || false,
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
    const { name, url, interval, tags, depends_on, max_retries, alert_threshold_ms, alert_enabled, group_id } = req.body;

    const fields: string[] = [];
    const values: (string | number | boolean | null)[] = [];
    let idx = 1;

    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name); }
    if (url !== undefined) {
      try { new URL(url); } catch { res.status(400).json({ error: 'Invalid URL' }); return; }
      fields.push(`url = $${idx++}`); values.push(url);
    }
    if (interval !== undefined) { fields.push(`interval_seconds = $${idx++}`); values.push(interval); }
    if (tags !== undefined) { fields.push(`tags = $${idx++}`); values.push(tags); }
    if (depends_on !== undefined) { fields.push(`depends_on = $${idx++}`); values.push(depends_on || null); }
    if (max_retries !== undefined) { fields.push(`max_retries = $${idx++}`); values.push(max_retries); }
    if (alert_threshold_ms !== undefined) { fields.push(`alert_threshold_ms = $${idx++}`); values.push(alert_threshold_ms || null); }
    if (alert_enabled !== undefined) { fields.push(`alert_enabled = $${idx++}`); values.push(alert_enabled); }
    if (group_id !== undefined) { fields.push(`group_id = $${idx++}`); values.push(group_id || null); }

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
        depends_on: monitor.depends_on || null,
        max_retries: monitor.max_retries || 0,
        alert_threshold_ms: monitor.alert_threshold_ms || null,
        alert_enabled: monitor.alert_enabled || false,
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

// DELETE /api/monitors/bulk - Delete multiple monitors
router.delete('/monitors/bulk', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'ids array is required' });
      return;
    }
    const placeholders = ids.map((_: number, i: number) => `$${i + 1}`).join(',');
    const result = await pool.query(
      `DELETE FROM monitors WHERE id IN (${placeholders}) RETURNING *`,
      ids
    );
    for (const m of result.rows) {
      stopMonitor(m.id);
    }
    res.json({ message: `Deleted ${result.rows.length} monitors`, deleted: result.rows });
  } catch (err) {
    console.error('Error bulk deleting monitors:', err);
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

// PATCH /api/monitors/:id/pause - Pause a monitor
router.patch('/monitors/:id/pause', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE monitors SET is_paused = true WHERE id = $1 RETURNING *',
      [parseInt(id)]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Monitor not found' });
      return;
    }
    stopMonitor(parseInt(id));
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error pausing monitor:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/monitors/:id/resume - Resume a monitor
router.patch('/monitors/:id/resume', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE monitors SET is_paused = false WHERE id = $1 RETURNING *',
      [parseInt(id)]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Monitor not found' });
      return;
    }
    const monitor = result.rows[0];
    startMonitor({
      id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      interval_seconds: monitor.interval_seconds,
      depends_on: monitor.depends_on || null,
      max_retries: monitor.max_retries || 0,
      alert_threshold_ms: monitor.alert_threshold_ms || null,
      alert_enabled: monitor.alert_enabled || false,
    });
    res.json(monitor);
  } catch (err) {
    console.error('Error resuming monitor:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/monitors/:id/histogram - Response time distribution
router.get('/monitors/:id/histogram', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT
        SUM(CASE WHEN response_time_ms >= 0 AND response_time_ms < 100 THEN 1 ELSE 0 END) AS "0-100",
        SUM(CASE WHEN response_time_ms >= 100 AND response_time_ms < 200 THEN 1 ELSE 0 END) AS "100-200",
        SUM(CASE WHEN response_time_ms >= 200 AND response_time_ms < 500 THEN 1 ELSE 0 END) AS "200-500",
        SUM(CASE WHEN response_time_ms >= 500 AND response_time_ms < 1000 THEN 1 ELSE 0 END) AS "500-1000",
        SUM(CASE WHEN response_time_ms >= 1000 THEN 1 ELSE 0 END) AS "1000+"
      FROM checks
      WHERE monitor_id = $1 AND response_time_ms IS NOT NULL
    `, [id]);

    const row = result.rows[0];
    const buckets = [
      { range: '0-100ms', count: parseInt(row['0-100']) || 0 },
      { range: '100-200ms', count: parseInt(row['100-200']) || 0 },
      { range: '200-500ms', count: parseInt(row['200-500']) || 0 },
      { range: '500-1000ms', count: parseInt(row['500-1000']) || 0 },
      { range: '1000ms+', count: parseInt(row['1000+']) || 0 },
    ];
    res.json(buckets);
  } catch (err) {
    console.error('Error fetching histogram:', err);
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

// GET /api/monitors/:id/timeseries - Response time time-series data
router.get('/monitors/:id/timeseries', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const hours = Math.min(168, Math.max(1, parseInt(req.query.hours as string) || 24));
    const result = await pool.query(
      `SELECT response_time_ms, checked_at FROM checks
       WHERE monitor_id = $1 AND checked_at > NOW() - INTERVAL '1 hour' * $2
       ORDER BY checked_at ASC`,
      [id, hours]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching timeseries:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reports/monthly - Monthly SLA report per monitor
router.get('/reports/monthly', async (req: Request, res: Response) => {
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

    res.json({ month: monthParam, monitors });
  } catch (err) {
    console.error('Error fetching monthly report:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/channels - Add a notification channel
router.post('/channels', async (req: Request, res: Response) => {
  try {
    const { type, config, enabled } = req.body;
    if (!type || !['webhook', 'slack', 'discord'].includes(type)) {
      res.status(400).json({ error: 'type must be webhook, slack, or discord' });
      return;
    }
    if (!config || !config.url) {
      res.status(400).json({ error: 'config.url is required' });
      return;
    }
    try { new URL(config.url); } catch { res.status(400).json({ error: 'Invalid URL in config' }); return; }
    const result = await pool.query(
      'INSERT INTO notification_channels (type, config, enabled) VALUES ($1, $2, $3) RETURNING *',
      [type, JSON.stringify(config), enabled !== false]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating channel:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/channels - List notification channels
router.get('/channels', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT * FROM notification_channels ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing channels:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/channels/:id - Remove a notification channel
router.delete('/channels/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM notification_channels WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Channel not found' });
      return;
    }
    res.json({ message: 'Channel deleted', channel: result.rows[0] });
  } catch (err) {
    console.error('Error deleting channel:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/export/monitors - CSV export of all monitors
router.get('/export/monitors', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT m.id, m.name, m.url, m.interval_seconds, m.is_active, m.is_paused, m.tags, m.created_at,
        stats.uptime_pct, stats.avg_response_time
      FROM monitors m
      LEFT JOIN LATERAL (
        SELECT
          ROUND(AVG(CASE WHEN is_up THEN 1 ELSE 0 END) * 100, 2) AS uptime_pct,
          ROUND(AVG(response_time_ms)) AS avg_response_time
        FROM checks WHERE monitor_id = m.id
      ) stats ON true
      ORDER BY m.created_at DESC
    `);

    const header = 'id,name,url,interval_seconds,is_active,is_paused,tags,created_at,uptime_pct,avg_response_time';
    const rows = result.rows.map(r =>
      [r.id, `"${(r.name || '').replace(/"/g, '""')}"`, `"${r.url}"`, r.interval_seconds, r.is_active, r.is_paused, `"${r.tags}"`, r.created_at, r.uptime_pct || '', r.avg_response_time || ''].join(',')
    );
    const csv = [header, ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="monitors.csv"');
    res.send(csv);
  } catch (err) {
    console.error('Error exporting monitors:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/export/checks - CSV export of checks
router.get('/export/checks', async (req: Request, res: Response) => {
  try {
    const { monitor_id, from, to } = req.query;
    const conditions: string[] = [];
    const values: (string | number)[] = [];
    let idx = 1;

    if (monitor_id) { conditions.push(`c.monitor_id = $${idx++}`); values.push(parseInt(monitor_id as string)); }
    if (from) { conditions.push(`c.checked_at >= $${idx++}`); values.push(from as string); }
    if (to) { conditions.push(`c.checked_at <= $${idx++}`); values.push(to as string); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(`
      SELECT c.id, c.monitor_id, m.name AS monitor_name, c.status_code, c.response_time_ms, c.is_up, c.checked_at
      FROM checks c JOIN monitors m ON m.id = c.monitor_id
      ${where}
      ORDER BY c.checked_at DESC LIMIT 10000
    `, values);

    const header = 'id,monitor_id,monitor_name,status_code,response_time_ms,is_up,checked_at';
    const rows = result.rows.map(r =>
      [r.id, r.monitor_id, `"${(r.monitor_name || '').replace(/"/g, '""')}"`, r.status_code || '', r.response_time_ms || '', r.is_up, r.checked_at].join(',')
    );
    const csv = [header, ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="checks.csv"');
    res.send(csv);
  } catch (err) {
    console.error('Error exporting checks:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/export/incidents - CSV export of incidents
router.get('/export/incidents', async (req: Request, res: Response) => {
  try {
    const { from, to } = req.query;
    const conditions: string[] = [];
    const values: string[] = [];
    let idx = 1;

    if (from) { conditions.push(`i.started_at >= $${idx++}`); values.push(from as string); }
    if (to) { conditions.push(`i.started_at <= $${idx++}`); values.push(to as string); }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    const result = await pool.query(`
      SELECT i.id, i.monitor_id, m.name AS monitor_name, m.url AS monitor_url, i.started_at, i.resolved_at, i.duration_seconds
      FROM incidents i JOIN monitors m ON m.id = i.monitor_id
      ${where}
      ORDER BY i.started_at DESC LIMIT 10000
    `, values);

    const header = 'id,monitor_id,monitor_name,monitor_url,started_at,resolved_at,duration_seconds';
    const rows = result.rows.map(r =>
      [r.id, r.monitor_id, `"${(r.monitor_name || '').replace(/"/g, '""')}"`, `"${r.monitor_url}"`, r.started_at, r.resolved_at || '', r.duration_seconds || ''].join(',')
    );
    const csv = [header, ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="incidents.csv"');
    res.send(csv);
  } catch (err) {
    console.error('Error exporting incidents:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Maintenance Windows ──

// POST /api/maintenance - Create a maintenance window
router.post('/maintenance', async (req: Request, res: Response) => {
  try {
    const { monitor_id, start_time, end_time, reason } = req.body;
    if (!monitor_id || !start_time || !end_time) {
      res.status(400).json({ error: 'monitor_id, start_time, and end_time are required' });
      return;
    }
    if (new Date(end_time) <= new Date(start_time)) {
      res.status(400).json({ error: 'end_time must be after start_time' });
      return;
    }
    const result = await pool.query(
      'INSERT INTO maintenance_windows (monitor_id, start_time, end_time, reason) VALUES ($1, $2, $3, $4) RETURNING *',
      [monitor_id, start_time, end_time, reason || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating maintenance window:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/maintenance - List active and upcoming maintenance windows
router.get('/maintenance', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT mw.*, m.name AS monitor_name
      FROM maintenance_windows mw
      JOIN monitors m ON m.id = mw.monitor_id
      WHERE mw.end_time >= NOW()
      ORDER BY mw.start_time ASC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing maintenance windows:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/maintenance/:id - Delete a maintenance window
router.delete('/maintenance/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM maintenance_windows WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Maintenance window not found' });
      return;
    }
    res.json({ message: 'Maintenance window deleted', window: result.rows[0] });
  } catch (err) {
    console.error('Error deleting maintenance window:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Monitor Groups ──

// POST /api/groups - Create a group
router.post('/groups', async (req: Request, res: Response) => {
  try {
    const { name, description, color, sort_order } = req.body;
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    const result = await pool.query(
      'INSERT INTO monitor_groups (name, description, color, sort_order) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, description || null, color || '#6366f1', sort_order || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating group:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/groups - List all groups
router.get('/groups', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT * FROM monitor_groups ORDER BY sort_order ASC, name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error listing groups:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/groups/:id - Update a group
router.patch('/groups/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, description, color, sort_order } = req.body;
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    let idx = 1;
    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(name); }
    if (description !== undefined) { fields.push(`description = $${idx++}`); values.push(description); }
    if (color !== undefined) { fields.push(`color = $${idx++}`); values.push(color); }
    if (sort_order !== undefined) { fields.push(`sort_order = $${idx++}`); values.push(sort_order); }
    if (fields.length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
    values.push(parseInt(id));
    const result = await pool.query(
      `UPDATE monitor_groups SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (result.rows.length === 0) { res.status(404).json({ error: 'Group not found' }); return; }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating group:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/groups/:id - Delete a group
router.delete('/groups/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM monitor_groups WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) { res.status(404).json({ error: 'Group not found' }); return; }
    res.json({ message: 'Group deleted', group: result.rows[0] });
  } catch (err) {
    console.error('Error deleting group:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/settings - Get all settings
router.get('/settings', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query('SELECT key, value FROM settings ORDER BY key');
    const settings: Record<string, string> = {};
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }
    res.json(settings);
  } catch (err) {
    console.error('Error fetching settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/settings - Update settings
router.patch('/settings', async (req: Request, res: Response) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      res.status(400).json({ error: 'Request body must be an object of key-value pairs' });
      return;
    }
    for (const [key, value] of Object.entries(updates)) {
      if (key === 'checks_retention_days') {
        const days = parseInt(value as string);
        if (isNaN(days) || days < 1 || days > 3650) {
          res.status(400).json({ error: 'checks_retention_days must be between 1 and 3650' });
          return;
        }
      }
      await pool.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
        [key, String(value)]
      );
    }
    const result = await pool.query('SELECT key, value FROM settings ORDER BY key');
    const settings: Record<string, string> = {};
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }
    res.json(settings);
  } catch (err) {
    console.error('Error updating settings:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
