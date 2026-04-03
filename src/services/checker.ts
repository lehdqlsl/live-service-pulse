import http from 'http';
import https from 'https';
import { URL } from 'url';
import pool from '../db';

interface Monitor {
  id: number;
  name: string;
  url: string;
  interval_seconds: number;
}

const timers: Map<number, NodeJS.Timeout> = new Map();
const monitorState: Map<number, boolean> = new Map(); // track last known up/down

function postJSON(url: string, payload: string, headers: Record<string, string> = {}): void {
  try {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)), ...headers },
      timeout: 10000,
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch {
    // ignore delivery failures
  }
}

async function fireWebhooks(event: 'down' | 'up', monitor: Monitor, statusCode: number | null, responseTime: number): Promise<void> {
  const timestamp = new Date().toISOString();
  const basePayload = {
    event,
    monitor: { id: monitor.id, name: monitor.name, url: monitor.url },
    status_code: statusCode,
    response_time_ms: responseTime,
    timestamp,
  };

  // Legacy webhooks
  try {
    const result = await pool.query('SELECT url, events FROM webhooks');
    for (const wh of result.rows) {
      const events = (wh.events as string).split(',').map((e: string) => e.trim());
      if (!events.includes(event)) continue;
      postJSON(wh.url, JSON.stringify(basePayload));
    }
  } catch {
    // ignore db errors for webhooks
  }

  // Notification channels
  try {
    const result = await pool.query('SELECT type, config FROM notification_channels WHERE enabled = true');
    for (const ch of result.rows) {
      const config = ch.config as { url: string };
      const isDown = event === 'down';
      const statusText = isDown ? 'DOWN' : 'UP';
      const color = isDown ? '#ef4444' : '#22c55e';

      if (ch.type === 'webhook') {
        postJSON(config.url, JSON.stringify(basePayload));
      } else if (ch.type === 'slack') {
        const slackPayload = JSON.stringify({
          attachments: [{
            color,
            title: `${monitor.name} is ${statusText}`,
            text: `URL: ${monitor.url}\nStatus Code: ${statusCode || 'N/A'}\nResponse Time: ${responseTime}ms`,
            ts: Math.floor(Date.now() / 1000),
          }],
        });
        postJSON(config.url, slackPayload);
      } else if (ch.type === 'discord') {
        const discordPayload = JSON.stringify({
          embeds: [{
            title: `${monitor.name} is ${statusText}`,
            color: isDown ? 0xef4444 : 0x22c55e,
            fields: [
              { name: 'URL', value: monitor.url, inline: true },
              { name: 'Status Code', value: String(statusCode || 'N/A'), inline: true },
              { name: 'Response Time', value: `${responseTime}ms`, inline: true },
            ],
            timestamp,
          }],
        });
        postJSON(config.url, discordPayload);
      }
    }
  } catch {
    // ignore channel errors
  }
}

async function handleIncidents(monitor: Monitor, isUp: boolean, statusCode: number | null, responseTime: number): Promise<void> {
  const wasUp = monitorState.get(monitor.id);
  monitorState.set(monitor.id, isUp);

  // First check for this monitor — just record state, don't create incident
  if (wasUp === undefined) return;

  // Transition from up to down — create incident
  if (wasUp && !isUp) {
    try {
      await pool.query(
        'INSERT INTO incidents (monitor_id, started_at) VALUES ($1, NOW())',
        [monitor.id]
      );
    } catch (err) {
      console.error(`Failed to create incident for monitor ${monitor.id}:`, err);
    }
    fireWebhooks('down', monitor, statusCode, responseTime);
  }

  // Transition from down to up — resolve incident
  if (!wasUp && isUp) {
    try {
      await pool.query(
        `UPDATE incidents SET resolved_at = NOW(), duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER
         WHERE monitor_id = $1 AND resolved_at IS NULL`,
        [monitor.id]
      );
    } catch (err) {
      console.error(`Failed to resolve incident for monitor ${monitor.id}:`, err);
    }
    fireWebhooks('up', monitor, statusCode, responseTime);
  }
}

async function checkUrl(monitor: Monitor): Promise<void> {
  const start = Date.now();
  let statusCode: number | null = null;
  let isUp = false;

  try {
    const parsed = new URL(monitor.url);
    const client = parsed.protocol === 'https:' ? https : http;

    const result = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = client.get(monitor.url, { timeout: 15000 }, (res) => {
        res.resume(); // consume response
        resolve({ statusCode: res.statusCode || 0 });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
    });

    statusCode = result.statusCode;
    isUp = statusCode >= 200 && statusCode < 400;
  } catch {
    isUp = false;
  }

  const responseTime = Date.now() - start;

  try {
    await pool.query(
      `INSERT INTO checks (monitor_id, status_code, response_time_ms, is_up, checked_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [monitor.id, statusCode, responseTime, isUp]
    );
  } catch (err) {
    console.error(`Failed to store check for monitor ${monitor.id}:`, err);
  }

  await handleIncidents(monitor, isUp, statusCode, responseTime);
}

function scheduleMonitor(monitor: Monitor): void {
  // Run immediately on first schedule
  checkUrl(monitor);

  const interval = setInterval(() => {
    checkUrl(monitor);
  }, monitor.interval_seconds * 1000);

  timers.set(monitor.id, interval);
}

export function stopMonitor(monitorId: number): void {
  const timer = timers.get(monitorId);
  if (timer) {
    clearInterval(timer);
    timers.delete(monitorId);
  }
  monitorState.delete(monitorId);
}

export async function startAllMonitors(): Promise<void> {
  // Clear existing timers
  for (const [id] of timers) {
    stopMonitor(id);
  }

  try {
    const result = await pool.query(
      'SELECT id, name, url, interval_seconds FROM monitors WHERE is_active = true AND is_paused = false'
    );
    for (const monitor of result.rows) {
      scheduleMonitor(monitor);
    }
    console.log(`Started monitoring ${result.rows.length} URLs`);
  } catch (err) {
    console.error('Failed to start monitors:', err);
  }
}

export function startMonitor(monitor: Monitor): void {
  stopMonitor(monitor.id);
  scheduleMonitor(monitor);
}
