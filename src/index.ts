import http from 'http';
import express from 'express';
import path from 'path';
import { initDatabase, runRetentionCleanup } from './db';
import apiRouter from './routes/api';
import dashboardRouter from './routes/dashboard';
import metricsRouter from './routes/metrics';
import { startAllMonitors } from './services/checker';
import { setupWebSocket } from './services/websocket';

const app = express();
const server = http.createServer(app);
const PORT = parseInt(process.env.PORT || '3000', 10);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Health endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.8.0' });
});

// Routes
app.use('/', dashboardRouter);
app.use('/api', apiRouter);
app.use('/metrics', metricsRouter);

// Start
async function main() {
  try {
    await initDatabase();
    await runRetentionCleanup();
    await startAllMonitors();
    setupWebSocket(server);

    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Pulse v1.8.0 running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

main();
