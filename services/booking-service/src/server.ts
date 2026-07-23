import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from '@lumo/database';
import { authenticateToken, requireRoles, AuthenticatedRequest, AppError, errorHandler } from '@lumo/common';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5005;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Booking Service' }));

app.post('/api/v1/bookings', authenticateToken, requireRoles(['CUSTOMER']), async (req: AuthenticatedRequest, res, next) => {
  try {
    const customerId = req.user!.userId;
    const { serviceId, scheduledAt, addressText, latitude, longitude, femaleProPreferred } = req.body;

    const srvRes = await pool.query('SELECT * FROM services WHERE id = $1', [serviceId]);
    const service = srvRes.rows[0];
    if (!service) throw new AppError('Service not found', 404);

    const bookingId = `bk-${randomUUID().slice(0, 8)}`;
    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();
    const endOtp = Math.floor(1000 + Math.random() * 9000).toString();

    const insertRes = await pool.query(
      `INSERT INTO bookings (id, customer_id, service_id, status, scheduled_at, address_text, latitude, longitude, female_pro_preferred, start_otp, end_otp, total_amount)
       VALUES ($1, $2, $3, 'REQUESTED', $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [bookingId, customerId, serviceId, scheduledAt || new Date().toISOString(), addressText, latitude, longitude, Boolean(femaleProPreferred), startOtp, endOtp, parseFloat(service.base_price)]
    );

    res.status(201).json({ success: true, data: insertRes.rows[0] });
  } catch (err) { next(err); }
});

app.get('/api/v1/bookings/my-bookings', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const userId = req.user!.userId;
    const role = req.user!.role;
    const column = role === 'PROFESSIONAL' ? 'pro_id' : 'customer_id';

    const bookings = await pool.query(
      `SELECT b.*, s.name as service_name FROM bookings b JOIN services s ON b.service_id = s.id WHERE b.${column} = $1 ORDER BY b.created_at DESC`,
      [userId]
    );

    res.json({ success: true, data: bookings.rows });
  } catch (err) { next(err); }
});

app.use(errorHandler);

app.listen(PORT, () => console.log(`📦 Booking Service running on port ${PORT}`));
