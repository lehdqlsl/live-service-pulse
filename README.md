# Pulse v2.1.0 — URL Uptime Monitor

A professional URL uptime monitoring dashboard built with Node.js, Express, TypeScript, and PostgreSQL.

## Features

### Monitoring
- Real-time monitoring dashboard with dark theme
- Configurable check intervals per monitor
- Monitor groups with color-coded organization
- Monitor dependencies (skip checks when parent is down)
- Automatic retries with configurable max retry count
- Response time alert thresholds
- Maintenance windows to suppress alerts during planned downtime
- Startup seed monitors via `SEED_MONITORS` env var

### Dashboard & UI
- Live-updating dashboard via SSE and WebSocket
- Response time sparkline charts per monitor
- 24-hour uptime bar visualization per monitor
- Status badges (SVG) for embedding
- Public status page
- Monitor detail page with full history, stats, SSL info
- Paginated check history with response time histogram
- Monthly SLA reports with P95 latency and downtime tracking
- Dark-themed error page for unhandled errors
- Dashboard search and tag filtering

### Notifications
- Webhook notifications for up/down/slow events
- Slack integration (incoming webhooks)
- Discord integration (webhook embeds)
- Notification channel management

### Reliability & Operations
- Graceful shutdown (SIGTERM/SIGINT) — stops monitors, closes WebSocket, drains DB pool
- Enhanced `/health` endpoint with DB pool stats, monitor counts, WebSocket clients, uptime
- In-memory rate limiting for API routes (100 req/min per IP)
- Request logging middleware (method, path, status, response time)
- Data retention with configurable cleanup
- SSL certificate monitoring and expiry alerts
- Prometheus-compatible `/metrics` endpoint
- Incident tracking with automatic detection and resolution

### API & Integration
- REST API for monitors, incidents, webhooks, settings, groups, maintenance windows
- SSE endpoint for real-time check/incident events
- API key management
- SVG status badges

## Quick Start

```bash
# Set environment variables
export DATABASE_URL=postgresql://user:pass@localhost:5432/pulse
export PORT=3000

# Optional: auto-create monitors on first start
export SEED_MONITORS='[{"name":"Google","url":"https://google.com","interval":60}]'

# Install and run
npm install
npm run build
npm start
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Enhanced health check (status, version, DB pool, WS clients) |
| GET | / | Dashboard |
| GET | /status | Public status page |
| GET | /reports | Monthly SLA reports |
| GET | /metrics | Prometheus metrics |
| GET | /monitors/:id | Monitor detail page |
| GET | /badge/:id | SVG status badge |
| POST | /api/monitors | Add monitor |
| GET | /api/monitors | List monitors |
| PATCH | /api/monitors/:id | Update monitor |
| DELETE | /api/monitors/:id | Remove monitor |
| GET | /api/monitors/:id/history | Check history |
| GET | /api/monitors/:id/sparkline | Last 60 response times |
| GET | /api/stats | Overall stats |
| GET | /api/incidents | Recent incidents |
| POST | /api/webhooks | Add webhook |
| GET | /api/webhooks | List webhooks |
| DELETE | /api/webhooks/:id | Remove webhook |
| POST | /api/channels | Add notification channel |
| GET | /api/channels | List notification channels |
| DELETE | /api/channels/:id | Remove notification channel |
| GET | /api/settings | Get settings |
| PUT | /api/settings | Update settings |
| POST | /api/groups | Create monitor group |
| PUT | /api/groups/:id | Update monitor group |
| DELETE | /api/groups/:id | Delete monitor group |
| POST | /api/maintenance | Create maintenance window |
| DELETE | /api/maintenance/:id | Delete maintenance window |
| GET | /api/events | SSE real-time event stream |

## Rate Limiting

API routes (`/api/*`) are rate-limited to 100 requests per minute per IP. Exceeding the limit returns `429 Too Many Requests` with a `retryAfter` field. Health, metrics, status, and badge endpoints are not rate-limited.

## Webhooks

Configure webhooks to receive POST notifications when monitors go down, come back up, or respond slowly. Payload format:

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
