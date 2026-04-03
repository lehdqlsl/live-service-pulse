import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const clients = new Set<WebSocket>();

let wss: WebSocketServer | null = null;

export function setupWebSocket(server: http.Server): void {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  console.log('WebSocket server ready on /ws');
}

export function getClientCount(): number {
  return clients.size;
}

export function getWss(): WebSocketServer | null {
  return wss;
}

export function broadcast(event: string, data: Record<string, unknown>): void {
  const message = JSON.stringify({ event, data, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}
