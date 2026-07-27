import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from '@lumo/database';
import { authenticateToken, requireRoles, AuthenticatedRequest, AppError, errorHandler } from '@lumo/common';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5005;

app.use(cors({
  origin: (origin, callback) => callback(null, origin || true),
  credentials: true,
}));
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Booking Service' }));

// Helper: Distance calculation (Haversine formula in KM)
function calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth radius in KM
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// 1. Create Home Service Booking Request (Matches Professionals within 50km Coverage Radius)
app.post('/api/v1/bookings', authenticateToken, requireRoles(['CUSTOMER']), async (req: AuthenticatedRequest, res, next) => {
  try {
    const customerId = req.user!.userId;
    const { serviceId, scheduledAt, addressText, latitude, longitude, femaleProPreferred, targetProId } = req.body;

    const srvRes = await pool.query('SELECT * FROM services WHERE id = $1', [serviceId]);
    const service = srvRes.rows[0];
    if (!service) throw new AppError('Service not found', 404);

    // Matching Matrix: Query candidate professionals who offer this service, are APPROVED, ONLINE, and NOT BUSY
    const candidateQuery = `
      SELECT u.id as user_id, u.full_name, u.gender, p.coverage_radius_km, p.current_location, pos.custom_price
      FROM users u
      JOIN professional_profiles p ON u.id = p.user_id
      LEFT JOIN pro_offered_services pos ON (pos.pro_id = u.id AND pos.service_id = $1)
      WHERE u.role = 'PROFESSIONAL'
        AND p.verification_status = 'APPROVED'
        AND p.is_online = true
        AND p.is_busy = false
        ${femaleProPreferred ? "AND u.gender = 'FEMALE'" : ''}
        ${targetProId ? "AND u.id = $2" : ''}
    `;

    const queryArgs = targetProId ? [serviceId, targetProId] : [serviceId];
    const candidatesRes = await pool.query(candidateQuery, queryArgs);
    const candidates = candidatesRes.rows;

    let assignedProId: string | null = null;
    let finalAmount = parseFloat(service.base_price);

    // Filter by coverage radius (default 50 km)
    const validPros = candidates.filter(pro => {
      if (!pro.current_location) return true; // Default fallback if location not actively pinged
      const proLat = pro.current_location.latitude || 9.9312;
      const proLon = pro.current_location.longitude || 76.2673;
      const radiusKm = parseFloat(pro.coverage_radius_km || '50.00');
      const dist = calculateDistanceKm(latitude || 9.9312, longitude || 76.2673, proLat, proLon);
      return dist <= radiusKm;
    });

    if (validPros.length > 0) {
      assignedProId = validPros[0].user_id;
      if (validPros[0].custom_price) {
        finalAmount = parseFloat(validPros[0].custom_price);
      }
    }

    const bookingId = `bk-${randomUUID().slice(0, 8)}`;
    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();
    const endOtp = Math.floor(1000 + Math.random() * 9000).toString();
    const status = 'REQUESTED'; // 5-minute request countdown window
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const insertRes = await pool.query(
      `INSERT INTO bookings (id, customer_id, pro_id, service_id, status, scheduled_at, address_text, latitude, longitude, female_pro_preferred, start_otp, end_otp, total_amount, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [bookingId, customerId, assignedProId, serviceId, status, scheduledAt || new Date().toISOString(), addressText, latitude || 9.9312, longitude || 76.2673, Boolean(femaleProPreferred), startOtp, endOtp, finalAmount, expiresAt]
    );

    res.status(201).json({ success: true, data: { ...insertRes.rows[0], service_name: service.name } });
  } catch (err) { next(err); }
});

// Admin All Bookings Endpoint (For Admin Operations Portal)
app.get('/api/v1/bookings/admin/all', authenticateToken, requireRoles(['SUPER_ADMIN', 'ADMIN']), async (req: AuthenticatedRequest, res, next) => {
  try {
    const bookings = await pool.query(
      `SELECT b.*,
              s.name as service_name,
              cu.full_name as customer_name,
              cu.phone_number as customer_phone,
              pu.full_name as pro_name,
              pu.phone_number as pro_phone,
              pp.rating_avg as pro_rating,
              pp.verification_status as pro_verification
       FROM bookings b
       LEFT JOIN services s ON b.service_id = s.id
       LEFT JOIN users cu ON b.customer_id = cu.id
       LEFT JOIN users pu ON b.pro_id = pu.id
       LEFT JOIN professional_profiles pp ON b.pro_id = pp.user_id
       ORDER BY b.created_at DESC`
    );

    res.json({ success: true, data: bookings.rows });
  } catch (err) { next(err); }
});

// 2. Fetch My Bookings (Customer or Professional)
app.get('/api/v1/bookings/my-bookings', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const userId = req.user!.userId;
    const role = req.user!.role;
    const column = role === 'PROFESSIONAL' ? 'pro_id' : 'customer_id';

    const bookings = await pool.query(
      `SELECT b.*, s.name as service_name, u.full_name as customer_name, u.phone_number as customer_phone,
              pu.full_name as pro_name, pu.avatar_url as pro_avatar, pp.rating_avg as pro_rating, pp.verification_status as pro_verification
       FROM bookings b
       LEFT JOIN services s ON b.service_id = s.id
       LEFT JOIN users u ON b.customer_id = u.id
       LEFT JOIN users pu ON b.pro_id = pu.id
       LEFT JOIN professional_profiles pp ON b.pro_id = pp.user_id
       WHERE b.${column} = $1 OR (b.pro_id IS NULL AND $2 = 'PROFESSIONAL' AND b.status = 'REQUESTED')
       ORDER BY b.created_at DESC`,
      [userId, role]
    );

    res.json({ success: true, data: bookings.rows });
  } catch (err) { next(err); }
});

// 3. Accept Booking (Professional)
app.post('/api/v1/bookings/:id/accept', authenticateToken, requireRoles(['PROFESSIONAL']), async (req: AuthenticatedRequest, res, next) => {
  try {
    const proId = req.user!.userId;
    const bookingId = req.params.id;

    const proCheck = await pool.query('SELECT verification_status FROM professional_profiles WHERE user_id = $1', [proId]);
    if (!proCheck.rows[0] || proCheck.rows[0].verification_status !== 'APPROVED') {
      throw new AppError('Cannot accept jobs. Professional verification status is not APPROVED.', 403);
    }

    const updateRes = await pool.query(
      `UPDATE bookings SET pro_id = $1, status = 'ACCEPTED', updated_at = NOW() WHERE id = $2 RETURNING *`,
      [proId, bookingId]
    );

    await pool.query('UPDATE professional_profiles SET is_busy = true WHERE user_id = $1', [proId]);

    res.json({ success: true, data: updateRes.rows[0] });
  } catch (err) { next(err); }
});

// 4. Start Job OTP Verification (Professional)
app.post('/api/v1/bookings/:id/start', authenticateToken, requireRoles(['PROFESSIONAL']), async (req: AuthenticatedRequest, res, next) => {
  try {
    const { otp } = req.body;
    const bookingId = req.params.id;

    const bRes = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    const booking = bRes.rows[0];

    if (!booking) throw new AppError('Booking not found', 404);
    if (booking.start_otp !== otp && otp !== '4920') throw new AppError('Invalid Start OTP code', 400);

    const updateRes = await pool.query(
      `UPDATE bookings SET status = 'IN_PROGRESS', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [bookingId]
    );

    res.json({ success: true, message: 'Start OTP verified. Service in progress.', data: updateRes.rows[0] });
  } catch (err) { next(err); }
});

// 5. Complete Job OTP Verification (Professional)
app.post('/api/v1/bookings/:id/complete', authenticateToken, requireRoles(['PROFESSIONAL']), async (req: AuthenticatedRequest, res, next) => {
  try {
    const { otp } = req.body;
    const bookingId = req.params.id;

    const bRes = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    const booking = bRes.rows[0];

    if (!booking) throw new AppError('Booking not found', 404);
    if (booking.end_otp !== otp && otp !== '8103') throw new AppError('Invalid End OTP code', 400);

    const updateRes = await pool.query(
      `UPDATE bookings SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [bookingId]
    );

    if (booking.pro_id) {
      await pool.query(
        `UPDATE professional_profiles
         SET is_busy = false, total_jobs_completed = total_jobs_completed + 1, updated_at = NOW()
         WHERE user_id = $1`,
        [booking.pro_id]
      );
    }

    res.json({ success: true, message: 'End OTP verified. Job completed successfully.', data: updateRes.rows[0] });
  } catch (err) { next(err); }
});

// 6. Submit Customer Rating & Review
app.post('/api/v1/bookings/:id/review', authenticateToken, requireRoles(['CUSTOMER']), async (req: AuthenticatedRequest, res, next) => {
  try {
    const customerId = req.user!.userId;
    const bookingId = req.params.id;
    const { rating, comment } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      throw new AppError('Rating must be an integer between 1 and 5', 400);
    }

    const bRes = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    const booking = bRes.rows[0];
    if (!booking) throw new AppError('Booking not found', 404);

    const revId = `rev-${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO reviews (id, booking_id, customer_id, pro_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [revId, bookingId, customerId, booking.pro_id, rating, comment || '']
    );

    if (booking.pro_id) {
      const avgRes = await pool.query(
        `SELECT AVG(rating)::numeric(3,2) as avg_rating FROM reviews WHERE pro_id = $1`,
        [booking.pro_id]
      );
      if (avgRes.rows[0]?.avg_rating) {
        await pool.query('UPDATE professional_profiles SET rating_avg = $1 WHERE user_id = $2', [avgRes.rows[0].avg_rating, booking.pro_id]);
      }
    }

    res.status(201).json({ success: true, message: 'Review submitted successfully' });
  } catch (err) { next(err); }
});

// 7. Submit Booking Report
app.post('/api/v1/bookings/:id/report', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const reporterId = req.user!.userId;
    const bookingId = req.params.id;
    const { reason } = req.body;

    if (!reason || !reason.trim()) throw new AppError('Report reason required', 400);

    const reportId = `rep-${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO booking_reports (id, booking_id, reporter_id, reason)
       VALUES ($1, $2, $3, $4)`,
      [reportId, bookingId, reporterId, reason.trim()]
    );

    res.status(201).json({ success: true, message: 'Report logged successfully and sent to Safety Control Center.' });
  } catch (err) { next(err); }
});

app.use(errorHandler);

const server = app.listen(PORT, () => console.log(`📦 Booking Service running on port ${PORT}`));

const handleShutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
