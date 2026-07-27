import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from '@lumo/database';
import { authenticateToken, AuthenticatedRequest, AppError, errorHandler } from '@lumo/common';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5002;

app.use(cors({
  origin: (origin, callback) => callback(null, origin || true),
  credentials: true,
}));
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'User Service' }));

app.get('/api/v1/users/me', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const userRes = await pool.query('SELECT id, phone_number, email, full_name, role, gender, avatar_url FROM users WHERE id = $1', [req.user!.userId]);
    if (!userRes.rows[0]) throw new AppError('User not found', 404);
    res.json({ success: true, data: userRes.rows[0] });
  } catch (err) { next(err); }
});

app.post('/api/v1/users/locations', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { label, addressText, latitude, longitude, isDefault } = req.body;
    const locId = `loc-${randomUUID().slice(0, 8)}`;
    const insertRes = await pool.query(
      `INSERT INTO saved_locations (id, user_id, label, address_text, latitude, longitude, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [locId, req.user!.userId, label, addressText, latitude, longitude, Boolean(isDefault)]
    );
    res.status(201).json({ success: true, data: insertRes.rows[0] });
  } catch (err) { next(err); }
});

app.use(errorHandler);

const server = app.listen(PORT, () => console.log(`👤 User Service running on port ${PORT}`));

const handleShutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
