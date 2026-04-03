import http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import pool, { initDatabase, runRetentionCleanup } from './db';
import apiRouter from './routes/api';
import dashboardRouter from './routes/dashboard';
import metricsRouter from './routes/metrics';
import { startAllMonitors, stopAllMonitors } from './services/checker';
import { setupWebSocket, getWss, getClientCount } from './services/websocket';

const app = express();
const server = http.createServer(app);
const PORT = parseInt(process.env.PORT || '3000', 10);
const startTime = Date.now();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- Request Logging Middleware ---
app.use((req: Request, res: Response, next: NextFunction) => {
  // Skip static files
  if (req.path.match(/\.(css|js|ico|png|jpg|svg|woff2?|ttf|map)$/)) {
    return next();
  }
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// --- Rate Limiting for /api/* ---
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 100;
const RATE_WINDOW_MS = 60_000;

function getRateLimitMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    let entry = rateLimitMap.get(ip);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
      rateLimitMap.set(ip, entry);
    }

    entry.count++;

    if (entry.count > RATE_LIMIT) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.status(429).json({ error: 'Too many requests', retryAfter });
      return;
    }

    next();
  };
}

// --- Health endpoint (enhanced) ---
app.get('/health', async (_req: Request, res: Response) => {
  let dbConnected = true;
  try {
    await pool.query('SELECT 1');
  } catch {
    dbConnected = false;
  }

  let monitorStats = { total: 0, active: 0, paused: 0 };
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE is_active AND NOT is_paused)::int AS active,
        COUNT(*) FILTER (WHERE is_paused)::int AS paused
      FROM monitors
    `);
    monitorStats = result.rows[0];
  } catch {
    // db unreachable
  }

  const status = dbConnected ? 'ok' : 'degraded';

  res.json({
    status,
    version: '2.1.0',
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    monitors: monitorStats,
    db: {
      connected: dbConnected,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    },
    ws: {
      clients: getClientCount(),
    },
  });
});

// Routes
app.use('/', dashboardRouter);
app.use('/api', getRateLimitMiddleware(), apiRouter);
app.use('/metrics', metricsRouter);

// --- Error page (catch-all error handler) ---
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  const isDev = process.env.NODE_ENV !== 'production';
  res.status(500).render('error', {
    message: err.message || 'Something went wrong',
    stack: isDev ? err.stack : null,
  });
});

// --- Seed Monitors ---
async function seedMonitors(): Promise<void> {
  const seedEnv = process.env.SEED_MONITORS;
  if (!seedEnv) return;

  try {
    const countResult = await pool.query('SELECT COUNT(*)::int AS cnt FROM monitors');
    if (countResult.rows[0].cnt > 0) return;

    const seeds = JSON.parse(seedEnv) as { name: string; url: string; interval?: number }[];
    for (const seed of seeds) {
      await pool.query(
        'INSERT INTO monitors (name, url, interval_seconds) VALUES ($1, $2, $3)',
        [seed.name, seed.url, seed.interval || 60]
      );
    }
    console.log(`Seeded ${seeds.length} monitors from SEED_MONITORS`);
  } catch (err) {
    console.error('Failed to seed monitors:', err);
  }
}

// --- Graceful Shutdown ---
function gracefulShutdown(signal: string): void {
  console.log(`\nReceived ${signal}. Pulse shutting down...`);
  stopAllMonitors();

  const wss = getWss();
  if (wss) {
    wss.close();
  }

  server.close(() => {
    pool.end().then(() => {
      console.log('Shutdown complete.');
      process.exit(0);
    }).catch(() => {
      process.exit(1);
    });
  });

  // Force exit after 10s
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Start
async function main() {
  try {
    await initDatabase();
    await runRetentionCleanup();
    await seedMonitors();
    await startAllMonitors();
    setupWebSocket(server);

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Pulse v2.1.0 running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

main();
