# Pulse — URL Uptime Monitor

A professional URL uptime monitoring dashboard built with Node.js, Express, TypeScript, and PostgreSQL.

## Features
- Real-time monitoring dashboard with dark theme
- Configurable check intervals per monitor
- Uptime percentage and response time tracking
- Auto-refreshing dashboard (every 30s)
- REST API for managing monitors

## Quick Start

```bash
# Set environment variables
export DATABASE_URL=postgresql://user:pass@localhost:5432/pulse
export PORT=3000

# Install and run
npm install
npm run build
npm start
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Health check |
| GET | / | Dashboard |
| POST | /api/monitors | Add monitor |
| GET | /api/monitors | List monitors |
| DELETE | /api/monitors/:id | Remove monitor |
| GET | /api/monitors/:id/history | Check history |
| GET | /api/stats | Overall stats |

## Docker

```bash
docker build -t pulse .
docker run -p 3000:3000 -e DATABASE_URL=... pulse
```

## License
MIT
