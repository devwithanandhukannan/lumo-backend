import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from '@lumo/database';
import { authenticateToken, requireRoles, AuthenticatedRequest, AppError, errorHandler } from '@lumo/common';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5007;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Safety Control Center Service' }));

app.post('/api/v1/safety/sos/trigger', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const userId = req.user!.userId;
    const { bookingId, latitude, longitude, notes } = req.body;
    const sosId = `sos-${randomUUID().slice(0, 8)}`;

    const insertRes = await pool.query(
      `INSERT INTO sos_alerts (id, booking_id, triggered_by_user_id, trigger_latitude, trigger_longitude, status, notes)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6) RETURNING *`,
      [sosId, bookingId || null, userId, latitude, longitude, notes || 'Emergency SOS Pressed']
    );

    console.log(`🚨 [SAFETY SCC] EMERGENCY SOS TRIGGERED by user ${userId}`);
    res.status(201).json({ success: true, data: insertRes.rows[0] });
  } catch (err) { next(err); }
});

app.get('/api/v1/admin/safety/sos', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const alerts = await pool.query(
      `SELECT s.*, u.full_name as user_name, u.phone_number as user_phone FROM sos_alerts s JOIN users u ON s.triggered_by_user_id = u.id ORDER BY s.created_at DESC`
    );
    res.json({ success: true, data: alerts.rows });
  } catch (err) { next(err); }
});

app.get('/api/v1/admin/settings', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const settings = await pool.query('SELECT setting_key, setting_value, description, updated_at FROM system_settings');
    res.json({ success: true, data: settings.rows });
  } catch (err) { next(err); }
});

app.put('/api/v1/admin/settings/:key', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    const updateRes = await pool.query(
      `INSERT INTO system_settings (setting_key, setting_value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW() RETURNING *`,
      [key, value]
    );

    res.json({ success: true, data: updateRes.rows[0] });
  } catch (err) { next(err); }
});

app.use(errorHandler);

app.listen(PORT, () => console.log(`🚨 Safety Service running on port ${PORT}`));
