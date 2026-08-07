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

// Self-healing database migration check for FCM token column
(async () => {
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT;');
  } catch (err: any) {
    console.warn('⚠️ User Service DB Migration check:', err?.message || err);
  }
})();

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'User Service' }));

app.get('/api/v1/users/me', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const userRes = await pool.query('SELECT id, phone_number, email, full_name, role, gender, avatar_url FROM users WHERE id = $1', [req.user!.userId]);
    if (!userRes.rows[0]) throw new AppError('User not found', 404);
    res.json({ success: true, data: userRes.rows[0] });
  } catch (err) { next(err); }
});

app.post('/api/v1/users/fcm-token', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) throw new AppError('fcmToken required', 400);
    await pool.query('UPDATE users SET fcm_token = $1 WHERE id = $2', [fcmToken, req.user!.userId]);
    res.json({ success: true, message: 'FCM token updated successfully' });
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

// Update 10: Admin Customers vault endpoint
app.get('/api/v1/users/admin/customers', async (req, res, next) => {
  try {
    const customersRes = await pool.query(
      `SELECT u.id, u.phone_number, u.email, u.full_name, u.gender, u.is_active, u.created_at,
              u.service_area, u.latitude, u.longitude,
              (SELECT address_text FROM saved_locations WHERE user_id = u.id ORDER BY is_default DESC, created_at DESC LIMIT 1) as address_text,
              COUNT(b.id) as total_bookings,
              COALESCE(SUM(CASE WHEN b.status = 'COMPLETED' THEN b.total_amount ELSE 0 END), 0) as total_spent
       FROM users u
       LEFT JOIN bookings b ON b.customer_id = u.id
       WHERE u.role = 'CUSTOMER'
       GROUP BY u.id
       ORDER BY u.created_at DESC`
    );
    const data = customersRes.rows.map((u) => ({
      id: u.id,
      phoneNumber: u.phone_number,
      email: u.email,
      fullName: u.full_name || 'Customer',
      gender: u.gender || 'OTHER',
      location: u.service_area || u.address_text || (u.latitude && u.longitude ? `(${parseFloat(u.latitude).toFixed(4)}, ${parseFloat(u.longitude).toFixed(4)})` : 'Thottikkanam, Kerala'),
      isActive: u.is_active,
      createdAt: u.created_at,
      totalBookings: parseInt(u.total_bookings, 10) || 0,
      totalSpent: parseFloat(u.total_spent) || 0,
    }));
    res.json({ success: true, data });
  } catch (err) { next(err); }
});

app.use(errorHandler);

const server = app.listen(PORT, () => console.log(`👤 User Service running on port ${PORT}`));

const handleShutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
