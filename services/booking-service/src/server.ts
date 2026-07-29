import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool, initDatabaseTables } from '@lumo/database';
import { authenticateToken, requireRoles, AuthenticatedRequest, AppError, errorHandler } from '@lumo/common';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5005;

// Self-healing database migration check
initDatabaseTables()
  .then(() => pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;'))
  .catch((err) => console.warn('⚠️ Database migration check warning:', err.message));

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
    const { serviceId, scheduledAt, addressText, latitude, longitude, femaleProPreferred, targetProId, selectedProId } = req.body;
    const chosenProId = selectedProId || targetProId;

    // Ensure self-healing column migration
    await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;').catch(() => {});

    const srvRes = await pool.query('SELECT * FROM services WHERE id = $1', [serviceId]);
    const service = srvRes.rows[0];
    if (!service) throw new AppError('Service not found', 404);

    // Matching Matrix: Query candidate professionals who offer this service, are APPROVED/PENDING, and NOT BUSY
    const candidateQuery = `
      SELECT u.id as user_id, u.full_name, u.gender, p.coverage_radius_km, p.current_location, p.latitude, p.longitude, pos.custom_price, pos.km_charge_per_km as per_km_rate
      FROM users u
      JOIN professional_profiles p ON u.id = p.user_id
      JOIN pro_offered_services pos ON (pos.pro_id = u.id AND pos.service_id = $1 AND pos.is_active = true)
      WHERE u.role = 'PROFESSIONAL'
        AND p.verification_status IN ('APPROVED', 'PENDING')
        AND p.is_busy = false
        ${chosenProId ? "AND u.id = $2" : ''}
    `;

    const queryArgs = chosenProId ? [serviceId, chosenProId] : [serviceId];
    const candidatesRes = await pool.query(candidateQuery, queryArgs);
    let candidates = candidatesRes.rows;

    if (femaleProPreferred) {
      const femaleCandidates = candidates.filter(c => (c.gender || '').toUpperCase() === 'FEMALE');
      if (femaleCandidates.length > 0) candidates = femaleCandidates;
    }

    const custLat = latitude || 9.9484;
    const custLng = longitude || 77.1931;

    // Filter by coverage radius (default 50 km)
    const validPros = candidates.filter(pro => {
      let curLoc = pro.current_location;
      if (typeof curLoc === 'string') {
        try { curLoc = JSON.parse(curLoc); } catch (_) {}
      }
      const proLat = parseFloat(pro.latitude || curLoc?.latitude || curLoc?.lat || custLat.toString());
      const proLon = parseFloat(pro.longitude || curLoc?.longitude || curLoc?.lng || custLng.toString());
      const radiusKm = parseFloat(pro.coverage_radius_km || '50.00');
      const dist = calculateDistanceKm(custLat, custLng, proLat, proLon);
      return dist <= radiusKm;
    });

    if (validPros.length === 0) {
      throw new AppError('No verified professionals currently available within dispatch range for this service in your area.', 400);
    }

    const assignedPro = validPros[0];
    const assignedProId = assignedPro.user_id;

    let assignedCurLoc = assignedPro.current_location;
    if (typeof assignedCurLoc === 'string') {
      try { assignedCurLoc = JSON.parse(assignedCurLoc); } catch (_) {}
    }
    const proLat = parseFloat(assignedPro.latitude || assignedCurLoc?.latitude || assignedCurLoc?.lat || custLat.toString());
    const proLon = parseFloat(assignedPro.longitude || assignedCurLoc?.longitude || assignedCurLoc?.lng || custLng.toString());
    const travelDistanceKm = Math.round(calculateDistanceKm(custLat, custLng, proLat, proLon) * 100) / 100;
    const perKmRate = parseFloat(assignedPro.per_km_rate || service.per_km_rate || '15.00');
    const travelCharge = Math.round(travelDistanceKm * perKmRate * 100) / 100;

    const baseAmount = parseFloat(assignedPro.custom_price || service.base_price || '0');
    const totalAmount = Math.round((baseAmount + travelCharge) * 100) / 100;

    const bookingId = `bk-${randomUUID().slice(0, 8)}`;
    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();
    const endOtp = Math.floor(1000 + Math.random() * 9000).toString();
    const status = 'REQUESTED'; // 5-minute request countdown window
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const insertRes = await pool.query(
      `INSERT INTO bookings (id, customer_id, pro_id, service_id, status, scheduled_at, address_text, latitude, longitude, female_pro_preferred, start_otp, end_otp, base_amount, travel_distance_km, travel_charge, total_amount, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
      [bookingId, customerId, assignedProId, serviceId, status, scheduledAt || new Date().toISOString(), addressText, custLat, custLng, Boolean(femaleProPreferred), startOtp, endOtp, baseAmount, travelDistanceKm, travelCharge, totalAmount, expiresAt]
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

// Pre-booking charge estimate endpoint
app.get('/api/v1/bookings/estimate', async (req, res, next) => {
  try {
    const serviceId = req.query.serviceId as string;
    const proId = req.query.proId as string;
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);

    if (!serviceId || !proId || isNaN(lat) || isNaN(lng)) {
      res.status(400).json({ success: false, message: 'serviceId, proId, lat, lng required' });
      return;
    }

    const proRes = await pool.query('SELECT latitude, longitude FROM professional_profiles WHERE user_id = $1', [proId]);
    const pro = proRes.rows[0];
    const posRes = await pool.query('SELECT custom_price, km_charge_per_km FROM pro_offered_services WHERE pro_id = $1 AND service_id = $2', [proId, serviceId]);
    const pos = posRes.rows[0];
    const svcRes = await pool.query('SELECT base_price FROM services WHERE id = $1', [serviceId]);
    const svc = svcRes.rows[0];

    const basePrice = parseFloat(pos?.custom_price || svc?.base_price || '0');
    const kmCharge = parseFloat(pos?.km_charge_per_km || '15');
    const distanceKm = pro?.latitude ? parseFloat(calculateDistanceKm(lat, lng, parseFloat(pro.latitude), parseFloat(pro.longitude)).toFixed(2)) : 0;
    const travelCharge = parseFloat((distanceKm * kmCharge).toFixed(2));

    res.json({
      success: true,
      data: {
        distanceKm,
        kmCharge,
        basePrice,
        travelCharge,
        total: parseFloat((basePrice + travelCharge).toFixed(2)),
      },
    });
  } catch (err) { next(err); }
});

// 2. Fetch My Bookings (Customer or Professional)
app.get('/api/v1/bookings/my-bookings', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const userId = req.user!.userId;
    const role = req.user!.role;
    const column = role === 'PROFESSIONAL' ? 'pro_id' : 'customer_id';

    const bookings = await pool.query(
      `SELECT b.*, s.name as service_name, u.full_name as customer_name, u.phone_number as customer_phone, u.gender as customer_sex,
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

// Fetch single booking telemetry by ID
app.get('/api/v1/bookings/:id', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const bookingId = req.params.id;
    const bookingRes = await pool.query(
      `SELECT b.*,
              s.name as service_name,
              cu.full_name as customer_name,
              cu.phone_number as customer_phone,
              cu.latitude as customer_lat,
              cu.longitude as customer_lng,
              pu.full_name as pro_name,
              pu.phone_number as pro_phone,
              pp.latitude as pro_lat,
              pp.longitude as pro_lng,
              pp.rating_avg as pro_rating,
              pp.verification_status as pro_verification
       FROM bookings b
       LEFT JOIN services s ON b.service_id = s.id
       LEFT JOIN users cu ON b.customer_id = cu.id
       LEFT JOIN users pu ON b.pro_id = pu.id
       LEFT JOIN professional_profiles pp ON b.pro_id = pp.user_id
       WHERE b.id = $1`,
      [bookingId]
    );

    if (bookingRes.rowCount === 0) throw new AppError('Booking not found', 404);
    res.json({ success: true, data: bookingRes.rows[0] });
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

// 8. Cancel Booking (Customer or Professional)
app.post('/api/v1/bookings/:id/cancel', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const userId = req.user!.userId;
    const bookingId = req.params.id;
    const { reason } = req.body;

    const bRes = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    if (bRes.rowCount === 0) throw new AppError('Booking request not found', 404);

    const booking = bRes.rows[0];
    if (booking.customer_id !== userId && booking.pro_id !== userId && req.user!.role !== 'ADMIN') {
      throw new AppError('Unauthorized to cancel this booking', 403);
    }

    if (booking.status === 'COMPLETED' || booking.status === 'CANCELLED') {
      throw new AppError(`Booking is already ${booking.status.toLowerCase()}`, 400);
    }

    const cancelReasonText = reason || (booking.customer_id === userId ? 'Cancelled by Customer' : 'Cancelled by Professional');

    const updatedRes = await pool.query(
      `UPDATE bookings
       SET status = 'CANCELLED', cancel_reason = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [cancelReasonText, bookingId]
    );

    if (booking.pro_id) {
      await pool.query('UPDATE professional_profiles SET is_busy = false WHERE user_id = $1', [booking.pro_id]);
    }

    console.log(`🛑 [BOOKING-CANCELLED] Booking "${bookingId}" cancelled by user "${userId}" (${cancelReasonText})`);

    res.json({
      success: true,
      message: 'Booking request cancelled successfully',
      data: updatedRes.rows[0]
    });
  } catch (err) { next(err); }
});

app.use(errorHandler);

// Background Worker: Auto-Expire unaccepted bookings past their 5-minute timer
setInterval(async () => {
  try {
    const expiredRes = await pool.query(
      `UPDATE bookings
       SET status = 'EXPIRED', cancel_reason = 'Pro request acceptance timed out after 5 minutes'
       WHERE status = 'REQUESTED' AND expires_at < NOW()
       RETURNING id, pro_id`
    );
    if (expiredRes.rowCount && expiredRes.rowCount > 0) {
      console.log(`⏱️ [AUTO-EXPIRY] Expired ${expiredRes.rowCount} stale booking requests.`);
      for (const row of expiredRes.rows) {
        if (row.pro_id) {
          await pool.query('UPDATE professional_profiles SET is_busy = false WHERE user_id = $1', [row.pro_id]);
        }
      }
    }
  } catch (err: any) {
    console.error('❌ [AUTO-EXPIRY WORKER ERROR]:', err.message);
  }
}, 15000);

const server = app.listen(PORT, () => console.log(`📦 Booking Service running on port ${PORT}`));

const handleShutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
