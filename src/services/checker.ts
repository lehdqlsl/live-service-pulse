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
}

export async function startAllMonitors(): Promise<void> {
  // Clear existing timers
  for (const [id] of timers) {
    stopMonitor(id);
  }

  try {
    const result = await pool.query(
      'SELECT id, name, url, interval_seconds FROM monitors WHERE is_active = true'
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
