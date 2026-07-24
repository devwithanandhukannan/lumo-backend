import express from 'express';
import cors from 'cors';
import path from 'path';
import routes from './routes';
import { errorHandler } from './middleware/error.middleware';

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static documents vault & selfie verification uploads
const rootCertDir = path.resolve(process.cwd(), 'proff_cert');
const proCertDir = path.resolve(process.cwd(), 'services/pro-service/proff_cert');

app.use('/proff_cert', express.static(rootCertDir));
app.use('/proff_cert', express.static(proCertDir));

// Health Check Endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'UP',
    service: 'LUMO Safety-First Backend Services',
    timestamp: new Date().toISOString(),
  });
});

// Register API v1 Routes
app.use('/api/v1', routes);

// 404 Route Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl} not found`,
    },
  });
});

// Global Error Handler
app.use(errorHandler);

export default app;
