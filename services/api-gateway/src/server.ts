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
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Accept'],
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
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://localhost:5008';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:5009';
const MEDIA_SERVICE_URL = process.env.MEDIA_SERVICE_URL || 'http://localhost:5010';

// Candidate static folders for /proff_cert document vault
const candidateCertDirs = [
  path.resolve(__dirname, '../../../proff_cert'),
  path.resolve(__dirname, '../../proff_cert'),
  path.resolve(process.cwd(), '../../proff_cert'),
  path.resolve(process.cwd(), '../pro-service/proff_cert'),
  path.resolve(process.cwd(), 'proff_cert'),
];

for (const dir of candidateCertDirs) {
  if (fs.existsSync(dir)) {
    console.log(`📂 [API-GATEWAY] Mounted static vault: ${dir}`);
    app.use('/proff_cert', express.static(dir));
  }
}

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

// Live Concurrent Microservices Monitoring Handler
const handleHealthMonitoring = async (req: Request, res: Response) => {
  const servicesToProbe = [
    { key: 'auth', name: 'Auth Svc', port: '5001', url: `${AUTH_SERVICE_URL}/health` },
    { key: 'user', name: 'User Svc', port: '5002', url: `${USER_SERVICE_URL}/health` },
    { key: 'pro', name: 'Pro Svc', port: '5003', url: `${PRO_SERVICE_URL}/health` },
    { key: 'catalog', name: 'Catalog Svc', port: '5004', url: `${CATALOG_SERVICE_URL}/health` },
    { key: 'booking', name: 'Booking Svc', port: '5005', url: `${BOOKING_SERVICE_URL}/health` },
    { key: 'geo', name: 'Geo Telemetry', port: '5006', url: `${GEO_SERVICE_URL}/health` },
    { key: 'safety', name: 'Safety SCC', port: '5007', url: `${SAFETY_SERVICE_URL}/health` },
    { key: 'payment', name: 'Payment Svc', port: '5008', url: `${PAYMENT_SERVICE_URL}/health` },
    { key: 'notif', name: 'Notif Svc', port: '5009', url: `${NOTIFICATION_SERVICE_URL}/health` },
    { key: 'media', name: 'Media Vault', port: '5010', url: `${MEDIA_SERVICE_URL}/health` },
    { key: 'postgres', name: 'PostgreSQL', port: '5432', url: `${SAFETY_SERVICE_URL}/health` },
    { key: 'redis', name: 'Redis', port: '6379', url: `${GEO_SERVICE_URL}/health` },
  ];

  const results = await Promise.all(
    servicesToProbe.map(async (svc) => {
      const start = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        const resp = await fetch(svc.url, { signal: controller.signal });
        clearTimeout(timer);
        const latency = Date.now() - start;
        return {
          key: svc.key,
          name: svc.name,
          port: svc.port,
          status: resp.ok ? 'UP' : 'DOWN',
          latencyMs: latency,
        };
      } catch (_) {
        return {
          key: svc.key,
          name: svc.name,
          port: svc.port,
          status: 'DOWN',
          latencyMs: 0,
        };
      }
    })
  );

  const healthyCount = results.filter((r) => r.status === 'UP').length;

  res.json({
    success: true,
    healthyCount,
    totalCount: results.length,
    allHealthy: healthyCount === results.length,
    services: results,
    timestamp: new Date().toISOString(),
  });
};

app.get('/health/monitoring', handleHealthMonitoring);
app.get('/api/v1/admin/health-monitoring', handleHealthMonitoring);

// ─────────────────────────────────────────────────────────────────────────────
// SSE STREAMING PROXY — Must be registered BEFORE the generic notifications proxy
// express-http-proxy buffers responses and kills SSE. We use raw http.request
// with pipe to preserve the streaming connection.
// ─────────────────────────────────────────────────────────────────────────────
app.options('/api/v1/notifications/admin/sos-stream', (req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control, Accept');
  res.sendStatus(204);
});

app.get('/api/v1/notifications/admin/sos-stream', (req: Request, res: Response) => {
  const notifUrl = new URL(`${NOTIFICATION_SERVICE_URL}/api/v1/notifications/admin/sos-stream`);

  console.log(`🔴 [GATEWAY-SSE] Streaming SOS event pipe to admin → ${notifUrl.href}`);

  // Set SSE & CORS headers immediately on the gateway response
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if any
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control, Accept');
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
      try { res.end(); } catch (_) {}
    });
  });

  proxyReq.on('error', (err) => {
    console.error('❌ [GATEWAY-SSE] Failed to connect to notification service:', err.message);
    // Send error event to client so it can show an error state
    try {
      res.write(`data: ${JSON.stringify({ type: 'ERROR', message: 'Notification service unavailable' })}\n\n`);
      res.end();
    } catch (_) {}
  });

  // If the client disconnects, abort the upstream request
  req.on('close', () => {
    console.log('🔌 [GATEWAY-SSE] Admin client disconnected, aborting upstream SSE pipe');
    proxyReq.destroy();
  });

  proxyReq.end();
});

// Route mappings to microservices
app.use('/api/v1/auth', proxy(AUTH_SERVICE_URL, { proxyReqPathResolver: (req: Request) => `/api/v1/auth${req.url}` }));
app.use('/api/v1/users', proxy(USER_SERVICE_URL, { proxyReqPathResolver: (req: Request) => `/api/v1/users${req.url}` }));
app.use('/api/v1/pro', proxy(PRO_SERVICE_URL, { proxyReqPathResolver: (req: Request) => `/api/v1/pro${req.url}` }));
app.use('/api/v1/catalog', proxy(CATALOG_SERVICE_URL, { proxyReqPathResolver: (req: Request) => `/api/v1/catalog${req.url}` }));
app.use('/api/v1/bookings', proxy(BOOKING_SERVICE_URL, { proxyReqPathResolver: (req: Request) => `/api/v1/bookings${req.url}` }));
app.use('/api/v1/geo', proxy(GEO_SERVICE_URL, { proxyReqPathResolver: (req: Request) => `/api/v1/geo${req.url}` }));
app.use('/api/v1/safety', proxy(SAFETY_SERVICE_URL, { proxyReqPathResolver: (req: Request) => `/api/v1/safety${req.url}` }));
app.use('/api/v1/notifications', proxy(NOTIFICATION_SERVICE_URL, { proxyReqPathResolver: (req: Request) => `/api/v1/notifications${req.url}` }));
app.use('/api/v1/admin', proxy(SAFETY_SERVICE_URL, { proxyReqPathResolver: (req: Request) => `/api/v1/admin${req.url}` }));

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
