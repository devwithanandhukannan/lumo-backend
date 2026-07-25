import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5009;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Accept'],
}));
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// In-Memory SSE Client Pool
// Each entry holds the Response object and a heartbeat interval timer
// ─────────────────────────────────────────────────────────────────────────────
interface SseClient {
  id: string;
  res: Response;
  heartbeatTimer: ReturnType<typeof setInterval>;
}

const sseClients: Map<string, SseClient> = new Map();

function removeClient(clientId: string) {
  const client = sseClients.get(clientId);
  if (client) {
    clearInterval(client.heartbeatTimer);
    sseClients.delete(clientId);
    console.log(`🔌 [SSE] Client ${clientId} removed — Active connections: ${sseClients.size}`);
  }
}

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Notification Service', activeStreams: sseClients.size }));

// ─────────────────────────────────────────────────────────────────────────────
// 1. Admin Real-Time SOS Alert Stream (Server-Sent Events)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/v1/notifications/admin/sos-stream', (req: Request, res: Response) => {
  // Set all required SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const clientId = `admin-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  console.log(`🔔 [SSE] New admin connected: ${clientId} — Total streams: ${sseClients.size + 1}`);

  // Send connection confirmation immediately
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', clientId, message: 'Real-time Emergency SOS Stream Established' })}\n\n`);

  // Send heartbeat every 20 seconds to prevent timeout/proxy buffering issues
  const heartbeatTimer = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`); // SSE comment line — keeps connection alive, not parsed as event
    } catch (_) {
      removeClient(clientId);
    }
  }, 20000);

  const client: SseClient = { id: clientId, res, heartbeatTimer };
  sseClients.set(clientId, client);

  // Clean up when client disconnects
  req.on('close', () => {
    removeClient(clientId);
  });

  req.on('error', () => {
    removeClient(clientId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Broadcast SOS Alert to All Active Admin SSE Clients
// Called internally by the Safety Service after a new SOS is saved to DB
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/v1/notifications/broadcast-sos', (req: Request, res: Response) => {
  try {
    const { sosData } = req.body;
    if (!sosData) {
      return res.status(400).json({ success: false, message: 'SOS payload required' });
    }

    const activeCount = sseClients.size;
    console.log(`🚨 [BROADCAST-SOS] Pushing emergency alert to ${activeCount} active admin streams — SOS ID: ${sosData.id}`);

    const payload = `data: ${JSON.stringify({
      type: 'EMERGENCY_SOS',
      timestamp: new Date().toISOString(),
      data: sosData,
    })}\n\n`;

    const deadClients: string[] = [];

    sseClients.forEach((client, clientId) => {
      try {
        client.res.write(payload);
      } catch (err: any) {
        console.warn(`⚠️ [BROADCAST] Failed to write to client ${clientId}:`, err.message);
        deadClients.push(clientId);
      }
    });

    // Clean up any dead connections found during broadcast
    deadClients.forEach(removeClient);

    res.json({
      success: true,
      broadcastCount: activeCount,
      message: `Emergency SOS broadcasted to ${activeCount} connected admin dashboards`,
    });
  } catch (err: any) {
    console.error('❌ [BROADCAST-SOS] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Server startup
// ─────────────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => console.log(`🔔 Notification Service running on port ${PORT}`));

const handleShutdown = () => {
  console.log('🛑 [NOTIFICATION] Shutting down — closing all SSE streams...');
  sseClients.forEach((client) => {
    try {
      clearInterval(client.heartbeatTimer);
      client.res.end();
    } catch (_) {}
  });
  sseClients.clear();
  server.close(() => process.exit(0));
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
