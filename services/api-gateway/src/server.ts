import express, { Request, Response } from 'express';
import cors from 'cors';
import proxy from 'express-http-proxy';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import http from 'http';

dotenv.config();

const app = express();
let PORT = Number(process.env.PORT) || 5000;

app.use(cors({
  origin: (origin, callback) => callback(null, origin || true),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Accept', 'Cookie'],
}));
app.use(express.json({ limit: '50mb' }));

// Downstream service target URLs
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:5001';
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:5002';
const PRO_SERVICE_URL = process.env.PRO_SERVICE_URL || 'http://localhost:5003';
const CATALOG_SERVICE_URL = process.env.CATALOG_SERVICE_URL || 'http://localhost:5004';
const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || 'http://localhost:5005';
const GEO_SERVICE_URL = process.env.GEO_SERVICE_URL || 'http://localhost:5006';
const SAFETY_SERVICE_URL = process.env.SAFETY_SERVICE_URL || 'http://localhost:5007';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:5009';

// Single unified static folder for /proff_cert document vault
const PROFF_CERT_DIR = path.resolve('/Users/anandhu/Desktop/lumo/backend/services/api-gateway/proff_cert');
if (!fs.existsSync(PROFF_CERT_DIR)) {
  try { fs.mkdirSync(PROFF_CERT_DIR, { recursive: true }); } catch (_) { }
}
console.log(`📂 [API-GATEWAY] Mounted static vault: ${PROFF_CERT_DIR}`);
app.use('/proff_cert', express.static(PROFF_CERT_DIR));

// Fallback proxy /proff_cert requests to pro-service
app.use('/proff_cert', proxy(PRO_SERVICE_URL, { proxyReqPathResolver: (req: Request) => `/proff_cert${req.url}` }));

// Gateway Health Check
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'UP',
    gateway: 'LUMO API Gateway Edge Proxy',
    port: PORT,
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SSE STREAMING PROXY — Must be registered BEFORE the generic notifications proxy
// express-http-proxy buffers responses and kills SSE. We use raw http.request
// with pipe to preserve the streaming connection.
// ─────────────────────────────────────────────────────────────────────────────
app.options('/api/v1/notifications/admin/sos-stream', (req: Request, res: Response) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control, Accept, Cookie');
  res.sendStatus(204);
});

app.get('/api/v1/notifications/admin/sos-stream', (req: Request, res: Response) => {
  const notifUrl = new URL(`${NOTIFICATION_SERVICE_URL}/api/v1/notifications/admin/sos-stream`);

  console.log(`🔴 [GATEWAY-SSE] Streaming SOS event pipe to admin → ${notifUrl.href}`);

  // Set SSE & CORS headers immediately on the gateway response
  const origin = req.headers.origin || '*';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if any
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control, Accept, Cookie');
  res.flushHeaders();

  const options = {
    hostname: notifUrl.hostname,
    port: Number(notifUrl.port) || 80,
    path: notifUrl.pathname + (notifUrl.search || ''),
    method: 'GET',
    headers: {
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Authorization': req.headers['authorization'] || '',
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    // Pipe the SSE stream directly from notification-service → gateway → client
    proxyRes.pipe(res, { end: true });

    proxyRes.on('error', (err) => {
      console.warn('⚠️ [GATEWAY-SSE] Proxy stream error:', err.message);
      try { res.end(); } catch (_) { }
    });
  });

  proxyReq.on('error', (err) => {
    console.error('❌ [GATEWAY-SSE] Failed to connect to notification service:', err.message);
    // Send error event to client so it can show an error state
    try {
      res.write(`data: ${JSON.stringify({ type: 'ERROR', message: 'Notification service unavailable' })}\n\n`);
      res.end();
    } catch (_) { }
  });

  // If the client disconnects, abort the upstream request
  req.on('close', () => {
    console.log('🔌 [GATEWAY-SSE] Admin client disconnected, aborting upstream SSE pipe');
    proxyReq.destroy();
  });

  proxyReq.end();
});

app.options('/api/v1/notifications/admin/sos-stream', (req: Request, res: Response) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control, Accept, Cookie');
  res.status(204).end();
});

// Helper for proxied microservice routes with credentials CORS header decoration
const createServiceProxy = (targetUrl: string, pathPrefix: string) =>
  proxy(targetUrl, {
    proxyReqPathResolver: (req: Request) => `${pathPrefix}${req.url}`,
    userResHeaderDecorator(headers: any, userReq: any) {
      const origin = userReq.headers.origin;
      if (origin) {
        headers['access-control-allow-origin'] = origin;
        headers['access-control-allow-credentials'] = 'true';
      }
      return headers;
    },
  });

// Route mappings to microservices
app.use('/api/v1/auth', createServiceProxy(AUTH_SERVICE_URL, '/api/v1/auth'));
app.use('/api/v1/users', createServiceProxy(USER_SERVICE_URL, '/api/v1/users'));
app.use('/api/v1/pro', createServiceProxy(PRO_SERVICE_URL, '/api/v1/pro'));
app.use('/api/v1/catalog', createServiceProxy(CATALOG_SERVICE_URL, '/api/v1/catalog'));
app.use('/api/v1/bookings', createServiceProxy(BOOKING_SERVICE_URL, '/api/v1/bookings'));
app.use('/api/v1/geo', createServiceProxy(GEO_SERVICE_URL, '/api/v1/geo'));
app.use('/api/v1/safety', createServiceProxy(SAFETY_SERVICE_URL, '/api/v1/safety'));
app.use('/api/v1/notifications', createServiceProxy(NOTIFICATION_SERVICE_URL, '/api/v1/notifications'));
app.use('/api/v1/admin', createServiceProxy(SAFETY_SERVICE_URL, '/api/v1/admin'));

const startServer = (targetPort: number) => {
  const server = app.listen(targetPort, '0.0.0.0', () => {
    PORT = targetPort;
    console.log(`=======================================================`);
    console.log(`🌐 LUMO API Gateway running on port ${PORT}`);
    console.log(`📂 Document Vault (/proff_cert) Enabled`);
    console.log(`🛡️ Forwarding Auth          -> ${AUTH_SERVICE_URL}`);
    console.log(`👤 Forwarding Users         -> ${USER_SERVICE_URL}`);
    console.log(`👷 Forwarding Pro           -> ${PRO_SERVICE_URL}`);
    console.log(`📦 Forwarding Booking       -> ${BOOKING_SERVICE_URL}`);
    console.log(`📍 Forwarding Geo           -> ${GEO_SERVICE_URL}`);
    console.log(`🚨 Forwarding Safety        -> ${SAFETY_SERVICE_URL}`);
    console.log(`🔔 Forwarding Notifications -> ${NOTIFICATION_SERVICE_URL}`);
    console.log(`📡 SSE Stream (direct pipe) -> ${NOTIFICATION_SERVICE_URL}/api/v1/notifications/admin/sos-stream`);
    console.log(`=======================================================`);
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE' && targetPort === 5000) {
      console.warn(`⚠️ Port 5000 is occupied (e.g., macOS AirPlay). Falling back to Port 8000 for API Gateway...`);
      startServer(8000);
    } else {
      console.error('API Gateway failed to start:', err);
    }
  });

  const handleShutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);
};

startServer(PORT);
