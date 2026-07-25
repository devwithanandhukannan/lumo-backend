import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { authenticateToken, AuthenticatedRequest, errorHandler } from '@lumo/common';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5010;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Media Vault Service' }));

app.post('/api/v1/media/upload-url', authenticateToken, async (req: AuthenticatedRequest, res) => {
  const { fileName, fileType } = req.body;
  const mockS3Key = `uploads/${req.user!.userId}/${randomUUID()}_${fileName}`;
  const mockPresignedUrl = `https://lumo-vault.s3.amazonaws.com/${mockS3Key}?mock_signature=abc123xyz`;

  res.json({
    success: true,
    data: {
      uploadUrl: mockPresignedUrl,
      fileKey: mockS3Key,
      expiresInSeconds: 900,
    },
  });
});

app.use(errorHandler);

const server = app.listen(PORT, () => console.log(`📁 Media Service running on port ${PORT}`));

const handleShutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
