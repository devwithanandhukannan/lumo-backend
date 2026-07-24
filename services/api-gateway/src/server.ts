import express, { Request, Response } from 'express';
import cors from 'cors';
import proxy from 'express-http-proxy';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
let PORT = Number(process.env.PORT) || 5000;

app.use(cors());
app.use(express.json());

// Downstream service target URLs
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:5001';
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:5002';
const PRO_SERVICE_URL = process.env.PRO_SERVICE_URL || 'http://localhost:5003';
const CATALOG_SERVICE_URL = process.env.CATALOG_SERVICE_URL || 'http://localhost:5004';
const BOOKING_SERVICE_URL = process.env.BOOKING_SERVICE_URL || 'http://localhost:5005';
const SAFETY_SERVICE_URL = process.env.SAFETY_SERVICE_URL || 'http://localhost:5007';

// Gateway Health Check
app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'UP',
    gateway: 'LUMO API Gateway Edge Proxy',
    port: PORT,
    timestamp: new Date().toISOString(),
  });
});

// Route mappings to microservices
app.use('/api/v1/auth', proxy(AUTH_SERVICE_URL, { proxyReqPathResolver: (req: Request) => `/api/v1/auth${req.url}` }));
app.use('/api/v1/users', proxy(USER_SERVICE_URL, { proxyReqPathResolver: (req: Request) => `/api/v1/users${req.url}` }));
app.use('/api/v1/pro', proxy(PRO_SERVICE_URL, { proxyReqPathResolver: (req: Request) => `/api/v1/pro${req.url}` }));
app.use('/api/v1/catalog', proxy(CATALOG_SERVICE_URL, { proxyReqPathResolver: (req: Request) => `/api/v1/catalog${req.url}` }));
app.use('/api/v1/bookings', proxy(BOOKING_SERVICE_URL, { proxyReqPathResolver: (req: Request) => `/api/v1/bookings${req.url}` }));
app.use('/api/v1/safety', proxy(SAFETY_SERVICE_URL, { proxyReqPathResolver: (req: Request) => `/api/v1/safety${req.url}` }));
app.use('/api/v1/admin', proxy(SAFETY_SERVICE_URL, { proxyReqPathResolver: (req: Request) => `/api/v1/admin${req.url}` }));

const startServer = (targetPort: number) => {
  const server = app.listen(targetPort, '0.0.0.0', () => {
    PORT = targetPort;
    console.log(`=======================================================`);
    console.log(`🌐 LUMO API Gateway running on port ${PORT}`);
    console.log(`🛡️ Forwarding Auth     -> ${AUTH_SERVICE_URL}`);
    console.log(`👤 Forwarding Users    -> ${USER_SERVICE_URL}`);
    console.log(`👷 Forwarding Pro      -> ${PRO_SERVICE_URL}`);
    console.log(`📦 Forwarding Booking  -> ${BOOKING_SERVICE_URL}`);
    console.log(`🚨 Forwarding Safety   -> ${SAFETY_SERVICE_URL}`);
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
};

startServer(PORT);
