import express from 'express';
import path from 'path';
import { initDatabase } from './db';
import apiRouter from './routes/api';
import dashboardRouter from './routes/dashboard';
import { startAllMonitors } from './services/checker';

const app = express();
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
  res.json({ status: 'ok', version: '1.2.0' });
});

// Routes
app.use('/', dashboardRouter);
app.use('/api', apiRouter);

// Start
async function main() {
  try {
    await initDatabase();
    await startAllMonitors();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Pulse v1.2.0 running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

main();
