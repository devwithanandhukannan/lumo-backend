import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { authenticateToken, AuthenticatedRequest, errorHandler } from '@lumo/common';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5010;

// Local Directory Storage Vault setup
const UPLOADS_DIR = path.resolve(__dirname, '../../../uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

app.use(cors({
  origin: (origin, callback) => callback(null, origin || true),
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));

app.get('/health', (req, res) => res.json({
  status: 'UP',
  service: 'Media Local Vault Service',
  storageType: 'LOCAL_DIRECTORY',
  uploadsPath: UPLOADS_DIR,
}));

// Local upload URL generator endpoint
app.post('/api/v1/media/upload-url', authenticateToken, async (req: AuthenticatedRequest, res) => {
  const { fileName } = req.body;
  const safeName = fileName ? fileName.replace(/[^a-zA-Z0-9.-]/g, '_') : 'file.jpg';
  const fileKey = `user-${req.user!.userId}_${randomUUID().slice(0, 8)}_${safeName}`;
  const uploadUrl = `http://localhost:${PORT}/api/v1/media/upload/${fileKey}`;

  res.json({
    success: true,
    data: {
      uploadUrl,
      fileKey,
      publicUrl: `http://localhost:5000/uploads/${fileKey}`,
      expiresInSeconds: 3600,
    },
  });
});

// Direct Local File Upload Endpoint (Base64 or Raw Buffer)
app.post('/api/v1/media/upload/:fileKey', authenticateToken, async (req: AuthenticatedRequest, res) => {
  const { fileKey } = req.params;
  const { base64Data } = req.body;

  try {
    const filePath = path.join(UPLOADS_DIR, fileKey);

    if (base64Data) {
      const buffer = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      fs.writeFileSync(filePath, buffer);
    } else {
      fs.writeFileSync(filePath, JSON.stringify(req.body));
    }

    const publicUrl = `http://localhost:5000/uploads/${fileKey}`;

    res.json({
      success: true,
      message: 'File saved successfully to local directory storage',
      data: {
        fileKey,
        publicUrl,
        sizeBytes: fs.statSync(filePath).size,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: 'Failed to write file to local disk', error: err.message });
  }
});

app.use(errorHandler);

const server = app.listen(PORT, () => {
  console.log(`📁 Media Local Vault Service running on port ${PORT}`);
  console.log(`📂 Storage directory: ${UPLOADS_DIR}`);
});

const handleShutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
