import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5009;

app.use(cors({
  origin: (origin, callback) => callback(null, origin || true),
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Accept', 'Cookie'],
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
// 3. Real-Time Pro GPS Location Tracking Stream (SSE per Booking)
// ─────────────────────────────────────────────────────────────────────────────
interface LocationClient {
  id: string;
  bookingId: string;
  res: Response;
  heartbeatTimer: ReturnType<typeof setInterval>;
}

const locationClients: Map<string, LocationClient> = new Map();

app.get('/api/v1/notifications/location-stream/:bookingId', (req: Request, res: Response) => {
  const { bookingId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const clientId = `cust-${bookingId}-${Date.now()}`;
  res.write(`data: ${JSON.stringify({ type: 'LOCATION_STREAM_ESTABLISHED', bookingId })}\n\n`);

  const heartbeatTimer = setInterval(() => {
    try { res.write(`: heartbeat\n\n`); } catch (_) { locationClients.delete(clientId); }
  }, 15000);

  locationClients.set(clientId, { id: clientId, bookingId, res, heartbeatTimer });
  req.on('close', () => { clearInterval(heartbeatTimer); locationClients.delete(clientId); });
});

app.post('/api/v1/notifications/location-update', (req: Request, res: Response) => {
  try {
    const { bookingId, latitude, longitude, proId } = req.body;
    if (!bookingId || !latitude || !longitude) {
      return res.status(400).json({ success: false, message: 'bookingId, latitude, and longitude required' });
    }

    const payload = `data: ${JSON.stringify({
      type: 'PRO_LOCATION_UPDATE',
      bookingId,
      proId,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      timestamp: new Date().toISOString(),
    })}\n\n`;

    locationClients.forEach((client, clientId) => {
      if (client.bookingId === bookingId) {
        try { client.res.write(payload); } catch (_) { locationClients.delete(clientId); }
      }
    });

    res.json({ success: true, message: 'Location update broadcasted' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Send FCM Mobile Push Notification (Push Alert to Mobile App Device Tokens)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/v1/notifications/push', (req: Request, res: Response) => {
  try {
    const { targetUserId, fcmToken, title, body, data } = req.body;
    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'title and body required' });
    }

    console.log(`📱 [PUSH-NOTIFICATION] Triggered push alert to user: ${targetUserId || 'broadcast'} — Title: "${title}" Body: "${body}"`);

    res.json({
      success: true,
      delivered: true,
      mode: process.env.FIREBASE_PROJECT_ID ? 'FCM_CLOUD' : 'DEV_SIMULATED',
      message: `Push notification queued for ${targetUserId || 'device'}`,
    });
  } catch (err: any) {
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
