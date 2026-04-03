# Pulse — URL Uptime Monitor

A professional URL uptime monitoring dashboard built with Node.js, Express, TypeScript, and PostgreSQL.

## Features
- Real-time monitoring dashboard with dark theme
- Configurable check intervals per monitor
- Uptime percentage and response time tracking
- Response time sparkline charts per monitor
- Automatic incident detection and timeline
- Webhook notifications for up/down events
- Auto-refreshing dashboard (every 30s)
- REST API for managing monitors, incidents, and webhooks

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
| GET | /api/monitors/:id/sparkline | Last 60 response times |
| GET | /api/stats | Overall stats |
| GET | /api/incidents | Recent incidents |
| POST | /api/webhooks | Add webhook |
| GET | /api/webhooks | List webhooks |
| DELETE | /api/webhooks/:id | Remove webhook |

## Webhooks

Configure webhooks to receive POST notifications when monitors go down or come back up. Payload format:

```json
{
  "event": "down",
  "monitor": { "id": 1, "name": "Example", "url": "https://example.com" },
  "status_code": null,
  "response_time_ms": 15000,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Docker

```bash
docker build -t pulse .
docker run -p 3000:3000 -e DATABASE_URL=... pulse
```

## License
MIT
