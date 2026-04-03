import http from 'http';
import https from 'https';
import { URL } from 'url';
import { EventEmitter } from 'events';
import pool from '../db';
import { broadcast } from './websocket';

export const checkerEvents = new EventEmitter();

interface Monitor {
  id: number;
  name: string;
  url: string;
  interval_seconds: number;
  depends_on?: number | null;
  max_retries: number;
  alert_threshold_ms?: number | null;
  alert_enabled: boolean;
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

async function fireWebhooks(event: 'down' | 'up' | 'slow', monitor: Monitor, statusCode: number | null, responseTime: number): Promise<void> {
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
      const isSlow = event === 'slow';
      const statusText = isDown ? 'DOWN' : (isSlow ? 'SLOW' : 'UP');
      const color = isDown ? '#ef4444' : (isSlow ? '#f59e0b' : '#22c55e');

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
            color: isDown ? 0xef4444 : (isSlow ? 0xf59e0b : 0x22c55e),
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

async function isInMaintenance(monitorId: number): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT 1 FROM maintenance_windows WHERE monitor_id = $1 AND start_time <= NOW() AND end_time >= NOW() LIMIT 1`,
      [monitorId]
    );
    return result.rows.length > 0;
  } catch {
    return false;
  }
}

async function handleIncidents(monitor: Monitor, isUp: boolean, statusCode: number | null, responseTime: number): Promise<void> {
  const wasUp = monitorState.get(monitor.id);
  monitorState.set(monitor.id, isUp);

  // First check for this monitor — just record state, don't create incident
  if (wasUp === undefined) return;

  // During maintenance windows, skip incident creation and webhooks
  const maintenance = await isInMaintenance(monitor.id);
  if (maintenance) return;

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
    const incDown = {
      type: 'started',
      monitorId: monitor.id,
      monitorName: monitor.name,
      monitorUrl: monitor.url,
      startedAt: new Date().toISOString(),
    };
    broadcast('incident', incDown);
    checkerEvents.emit('incident', incDown);
    broadcast('status_change', {
      monitorId: monitor.id,
      isUp: false,
      statusCode,
      responseTime,
    });
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
    const incUp = {
      type: 'resolved',
      monitorId: monitor.id,
      monitorName: monitor.name,
      monitorUrl: monitor.url,
      resolvedAt: new Date().toISOString(),
    };
    broadcast('incident', incUp);
    checkerEvents.emit('incident', incUp);
    broadcast('status_change', {
      monitorId: monitor.id,
      isUp: true,
      statusCode,
      responseTime,
    });
    fireWebhooks('up', monitor, statusCode, responseTime);
  }
}

// Single HTTP check attempt (no retry logic)
async function singleCheck(monitor: Monitor): Promise<{ statusCode: number | null; isUp: boolean; responseTime: number }> {
  const start = Date.now();
  let statusCode: number | null = null;
  let isUp = false;

  try {
    const parsed = new URL(monitor.url);
    const client = parsed.protocol === 'https:' ? https : http;

    const result = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = client.get(monitor.url, { timeout: 15000 }, (res) => {
        res.resume();
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
  return { statusCode, isUp, responseTime };
}

// Check if the parent monitor is down (for dependency skipping)
async function isParentDown(dependsOn: number): Promise<boolean> {
  try {
    const result = await pool.query(
      `SELECT is_up FROM checks WHERE monitor_id = $1 ORDER BY checked_at DESC LIMIT 1`,
      [dependsOn]
    );
    if (result.rows.length === 0) return false;
    return !result.rows[0].is_up;
  } catch {
    return false;
  }
}

async function checkUrl(monitor: Monitor): Promise<void> {
  // Dependency check: if parent is down, skip this monitor
  if (monitor.depends_on) {
    const parentDown = await isParentDown(monitor.depends_on);
    if (parentDown) {
      // Record a skipped check
      try {
        await pool.query(
          `INSERT INTO checks (monitor_id, status_code, response_time_ms, is_up, checked_at, retry_count)
           VALUES ($1, NULL, 0, false, NOW(), 0)`,
          [monitor.id]
        );
      } catch (err) {
        console.error(`Failed to store skipped check for monitor ${monitor.id}:`, err);
      }

      const checkData = {
        monitorId: monitor.id,
        monitorName: monitor.name,
        isUp: false,
        responseTime: 0,
        statusCode: null,
        checkedAt: new Date().toISOString(),
        skipped: true,
      };
      broadcast('check', checkData);
      checkerEvents.emit('check', checkData);
      return;
    }
  }

  // Perform check with retries
  let lastResult = await singleCheck(monitor);
  let retryCount = 0;

  if (!lastResult.isUp && monitor.max_retries > 0) {
    for (let i = 0; i < monitor.max_retries; i++) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5s delay between retries
      lastResult = await singleCheck(monitor);
      retryCount = i + 1;
      if (lastResult.isUp) break;
    }
  }

  const { statusCode, isUp, responseTime } = lastResult;

  try {
    await pool.query(
      `INSERT INTO checks (monitor_id, status_code, response_time_ms, is_up, checked_at, retry_count)
       VALUES ($1, $2, $3, $4, NOW(), $5)`,
      [monitor.id, statusCode, responseTime, isUp, retryCount]
    );
  } catch (err) {
    console.error(`Failed to store check for monitor ${monitor.id}:`, err);
  }

  const checkData = {
    monitorId: monitor.id,
    monitorName: monitor.name,
    isUp,
    responseTime,
    statusCode,
    checkedAt: new Date().toISOString(),
    retryCount,
  };
  broadcast('check', checkData);
  checkerEvents.emit('check', checkData);

  await handleIncidents(monitor, isUp, statusCode, responseTime);

  // Response time alert (skip during maintenance)
  if (isUp && monitor.alert_enabled && monitor.alert_threshold_ms && responseTime > monitor.alert_threshold_ms) {
    const inMaint = await isInMaintenance(monitor.id);
    if (!inMaint) {
      fireWebhooks('slow', monitor, statusCode, responseTime);
    }
  }
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
      'SELECT id, name, url, interval_seconds, depends_on, max_retries, alert_threshold_ms, alert_enabled FROM monitors WHERE is_active = true AND is_paused = false'
    );
    for (const monitor of result.rows) {
      scheduleMonitor(monitor);
    }
    console.log(`Started monitoring ${result.rows.length} URLs`);
  } catch (err) {
    console.error('Failed to start monitors:', err);
  }
}

export function stopAllMonitors(): void {
  for (const [id] of timers) {
    stopMonitor(id);
  }
}

export function startMonitor(monitor: Monitor): void {
  stopMonitor(monitor.id);
  scheduleMonitor(monitor);
}
