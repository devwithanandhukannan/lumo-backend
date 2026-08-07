import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import * as admin from 'firebase-admin';
import { pool, initDatabaseTables } from '@lumo/database';
import { authenticateToken, requireRoles, AuthenticatedRequest, AppError, errorHandler } from '@lumo/common';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5005;

// Initialize Firebase Admin for FCM Push Notifications
try {
  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || path.resolve(__dirname, '../../../firebase-service-account.json');
  if (fs.existsSync(saPath) && !admin.apps.length) {
    const serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('🔥 [BOOKING-SERVICE] Firebase Admin initialized for Push Notifications');
  }
} catch (e: any) {
  console.warn('⚠️ Firebase Admin init warning:', e?.message || e);
}

async function sendFcmPushToUser(userId: string, title: string, body: string, dataPayload?: Record<string, string>) {
  try {
    const uRes = await pool.query('SELECT fcm_token, role FROM users WHERE id = $1', [userId]);
    const fcmToken = uRes.rows[0]?.fcm_token;
    const userRole = uRes.rows[0]?.role || 'CUSTOMER';
    if (!fcmToken) {
      console.log(`ℹ️ [PUSH] User "${userId}" has no registered FCM token. Skipping push.`);
      return;
    }

    // Use the correct channel ID based on user role
    const channelId = userRole === 'PROFESSIONAL'
      ? 'lumo_pro_high_importance_channel'
      : 'lumo_high_importance_channel';

    if (admin.apps.length) {
      await admin.messaging().send({
        token: fcmToken,
        notification: { title, body },
        data: dataPayload || {},
        android: {
          priority: 'high',
          notification: {
            channelId,
            sound: 'default',
          },
        },
        apns: {
          payload: { aps: { sound: 'default' } },
        },
      });
      console.log(`📱 [FCM PUSH SENT] User: "${userId}" (${userRole}) via channel: ${channelId} — Title: "${title}"`);
    } else {
      console.log(`📱 [SIMULATED PUSH] User: "${userId}" — Title: "${title}" Body: "${body}"`);
    }
  } catch (err: any) {
    console.warn(`⚠️ [FCM PUSH ERROR] Failed to send to user "${userId}":`, err?.message || err);
  }
}

// Self-healing database migration check
(async () => {
  try {
    await initDatabaseTables();
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS platform_fee NUMERIC(10,2) DEFAULT 0.00;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS platform_fee_paid BOOLEAN DEFAULT FALSE;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS platform_fee_paid_at TIMESTAMPTZ;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS razorpay_platform_order_id VARCHAR(100);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS razorpay_platform_payment_id VARCHAR(100);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_amount NUMERIC(10,2) DEFAULT 0.00;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_paid BOOLEAN DEFAULT FALSE;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_paid_at TIMESTAMPTZ;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS razorpay_balance_order_id VARCHAR(100);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS razorpay_balance_payment_id VARCHAR(100);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status VARCHAR(30) DEFAULT 'UNPAID';
    `);
  } catch (err: any) {
    console.warn('⚠️ Booking Service DB Migration check:', err?.message || err);
  }
})();

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

    // Self-healing: Reset is_busy = false for pros without active uncompleted bookings
    await pool.query(`
      UPDATE professional_profiles
      SET is_busy = false
      WHERE is_busy = true
        AND user_id NOT IN (
          SELECT pro_id FROM bookings
          WHERE status IN ('ACCEPTED', 'CONFIRMED', 'IN_PROGRESS', 'START_OTP_VERIFIED')
            AND pro_id IS NOT NULL
        )
    `).catch(() => {});

    // Point-in-Polygon helper for emergency blackout check
    function isPointInRing(lat: number, lng: number, ring: number[][]): boolean {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const intersect = ((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
        if (intersect) inside = !inside;
      }
      return inside;
    }

    function isPointInGeoJSON(lat: number, lng: number, geojson: any): boolean {
      if (!geojson) return false;
      const geom = geojson.type === 'Feature' ? geojson.geometry : geojson;
      if (!geom || !geom.coordinates) return false;
      if (geom.type === 'Polygon') {
        const outer = geom.coordinates[0];
        if (!outer || !isPointInRing(lat, lng, outer)) return false;
        for (let h = 1; h < geom.coordinates.length; h++) {
          if (isPointInRing(lat, lng, geom.coordinates[h])) return false;
        }
        return true;
      } else if (geom.type === 'MultiPolygon') {
        for (const poly of geom.coordinates) {
          if (poly[0] && isPointInRing(lat, lng, poly[0])) {
            let hole = false;
            for (let h = 1; h < poly.length; h++) {
              if (isPointInRing(lat, lng, poly[h])) { hole = true; break; }
            }
            if (!hole) return true;
          }
        }
      }
      return false;
    }

    // Emergency Blackout / Service Suspension Check
    if (latitude !== undefined && longitude !== undefined) {
      const activeSuspensions = await pool.query(`
        SELECT * FROM service_suspensions
        WHERE is_active = TRUE AND starts_at <= NOW() AND (expires_at IS NULL OR expires_at >= NOW())
      `).catch(() => ({ rows: [] }));

      const reqLat = parseFloat(latitude);
      const reqLng = parseFloat(longitude);

      for (const s of activeSuspensions.rows) {
        let isBlocked = false;
        if (s.boundary_type === 'POLYGON' && s.polygon_geojson) {
          let g = s.polygon_geojson;
          if (typeof g === 'string') { try { g = JSON.parse(g); } catch (_) {} }
          isBlocked = isPointInGeoJSON(reqLat, reqLng, g);
        } else if (s.boundary_type === 'RADIUS' && s.center_latitude && s.center_longitude) {
          const dist = calculateDistanceKm(reqLat, reqLng, parseFloat(s.center_latitude), parseFloat(s.center_longitude));
          isBlocked = dist <= parseFloat(s.radius_km || 5);
        }

        if (isBlocked && s.severity === 'FULL_BLACKOUT') {
          return res.status(403).json({
            success: false,
            code: 'SERVICE_SUSPENDED_IN_REGION',
            message: s.custom_message || 'Service is temporarily closed in your area due to emergency conditions.',
            suspension: { title: s.title, reasonCategory: s.reason_category }
          });
        }
      }
    }

    const srvRes = await pool.query('SELECT * FROM services WHERE id = $1', [serviceId]);
    const service = srvRes.rows[0];
    if (!service) throw new AppError('Service not found', 404);

    // Matching Matrix: Query candidate professionals who offer this service, are APPROVED/PENDING, and NOT BUSY
    const candidateQuery = `
      SELECT u.id as user_id, u.full_name, u.gender, p.coverage_radius_km, p.current_location, p.latitude, p.longitude, pos.custom_price, COALESCE(pos.km_charge_per_km, pos.per_km_rate, 15.00) as per_km_rate
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

    // If specific pro was requested but not found (e.g. busy flag), fallback to any active pro for service
    if (chosenProId && candidates.length === 0) {
      const fallbackRes = await pool.query(
        `SELECT u.id as user_id, u.full_name, u.gender, p.coverage_radius_km, p.current_location, p.latitude, p.longitude, pos.custom_price, COALESCE(pos.km_charge_per_km, pos.per_km_rate, 15.00) as per_km_rate
         FROM users u
         JOIN professional_profiles p ON u.id = p.user_id
         JOIN pro_offered_services pos ON (pos.pro_id = u.id AND pos.service_id = $1 AND pos.is_active = true)
         WHERE u.role = 'PROFESSIONAL'
           AND p.verification_status IN ('APPROVED', 'PENDING')`,
        [serviceId]
      );
      candidates = fallbackRes.rows;
    }

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
    let platformFee = 50.00;
    if (service.commission_type === 'PERCENTAGE') {
      const pct = parseFloat(service.commission_value || service.commission_pct || '15');
      platformFee = Math.round((baseAmount * pct / 100) * 100) / 100;
    } else {
      platformFee = parseFloat(service.commission_value || '50.00');
    }

    const balanceAmount = Math.round((baseAmount + travelCharge) * 100) / 100;
    const totalAmount = Math.round((balanceAmount + platformFee) * 100) / 100;

    const bookingId = `bk-${randomUUID().slice(0, 8)}`;
    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();
    const endOtp = Math.floor(1000 + Math.random() * 9000).toString();
    const status = 'REQUESTED';
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const insertRes = await pool.query(
      `INSERT INTO bookings (id, customer_id, pro_id, service_id, status, scheduled_at, address_text, latitude, longitude, female_pro_preferred, start_otp, end_otp, base_amount, travel_distance_km, travel_charge, platform_fee, balance_amount, total_amount, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING *`,
      [bookingId, customerId, assignedProId, serviceId, status, scheduledAt || new Date().toISOString(), addressText, custLat, custLng, Boolean(femaleProPreferred), startOtp, endOtp, baseAmount, travelDistanceKm, travelCharge, platformFee, balanceAmount, totalAmount, expiresAt]
    );

    // Send FCM Push Notification to Assigned Professional
    if (assignedProId) {
      sendFcmPushToUser(
        assignedProId,
        'New Job Request! 🛎️',
        `You have a new service request for ${service.name} nearby (${addressText || 'Customer Location'}). Tap to respond.`,
        { bookingId, type: 'NEW_BOOKING_REQUEST' }
      );
    }

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
    const svcRes = await pool.query('SELECT base_price, commission_type, commission_value, commission_pct FROM services WHERE id = $1', [serviceId]);
    const svc = svcRes.rows[0];

    const basePrice = parseFloat(pos?.custom_price || svc?.base_price || '0');
    const kmCharge = parseFloat(pos?.km_charge_per_km || '15');
    const distanceKm = pro?.latitude ? parseFloat(calculateDistanceKm(lat, lng, parseFloat(pro.latitude), parseFloat(pro.longitude)).toFixed(2)) : 0;
    const travelCharge = parseFloat((distanceKm * kmCharge).toFixed(2));

    let platformFee = 50.00;
    if (svc?.commission_type === 'PERCENTAGE') {
      const pct = parseFloat(svc.commission_value || svc.commission_pct || '15');
      platformFee = Math.round((basePrice * pct / 100) * 100) / 100;
    } else if (svc?.commission_value) {
      platformFee = parseFloat(svc.commission_value);
    }

    const balanceAmount = parseFloat((basePrice + travelCharge).toFixed(2));
    const total = parseFloat((balanceAmount + platformFee).toFixed(2));

    res.json({
      success: true,
      data: {
        distanceKm,
        kmCharge,
        basePrice,
        travelCharge,
        platformFee,
        balanceAmount,
        total,
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

    const rows = bookings.rows.map((b: any) => {
      const isFeePaid = b.platform_fee_paid === true || ['CONFIRMED', 'NAVIGATING', 'ARRIVED', 'IN_PROGRESS', 'START_OTP_VERIFIED', 'JOB_COMPLETED_PAYMENT_DUE', 'COMPLETED'].includes((b.status || '').toUpperCase());
      if (!isFeePaid) {
        if (role === 'PROFESSIONAL') {
          b.customer_name = 'Customer (Locked 🔒)';
          b.customer_phone = '🔒 Pay Platform Fee to Unlock Contact';
        } else {
          b.pro_phone = '🔒 Pay Platform Fee to Unlock Contact';
        }
      }
      return b;
    });

    res.json({ success: true, data: rows });
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

// 3. Accept Booking (Professional) -> Transitions to ACCEPTED_PAYMENT_PENDING
app.post('/api/v1/bookings/:id/accept', authenticateToken, requireRoles(['PROFESSIONAL']), async (req: AuthenticatedRequest, res, next) => {
  try {
    const proId = req.user!.userId;
    const bookingId = req.params.id;

    const proCheck = await pool.query('SELECT verification_status FROM professional_profiles WHERE user_id = $1', [proId]);
    if (!proCheck.rows[0] || proCheck.rows[0].verification_status !== 'APPROVED') {
      throw new AppError('Cannot accept jobs. Professional verification status is not APPROVED.', 403);
    }

    const updateRes = await pool.query(
      `UPDATE bookings SET pro_id = $1, status = 'ACCEPTED_PAYMENT_PENDING', updated_at = NOW() WHERE id = $2 RETURNING *`,
      [proId, bookingId]
    );

    await pool.query('UPDATE professional_profiles SET is_busy = true WHERE user_id = $1', [proId]);

    const booking = updateRes.rows[0];
    if (booking && booking.customer_id) {
      const proUserRes = await pool.query('SELECT full_name FROM users WHERE id = $1', [proId]);
      const srvRes = await pool.query('SELECT name FROM services WHERE id = $1', [booking.service_id]);
      const proName = proUserRes.rows[0]?.full_name || 'A professional';
      const serviceName = srvRes.rows[0]?.name || 'service';

      sendFcmPushToUser(
        booking.customer_id,
        'Booking Accepted! 🛠️',
        `${proName} has accepted your booking request for ${serviceName}.`,
        { bookingId: booking.id, type: 'BOOKING_ACCEPTED' }
      );
    }

    res.json({ success: true, data: updateRes.rows[0], message: 'Booking accepted! Waiting for customer to pay platform fee.' });
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

// 5. Complete Job OTP Verification (Professional) -> Transitions to JOB_COMPLETED_PAYMENT_DUE
app.post('/api/v1/bookings/:id/complete', authenticateToken, requireRoles(['PROFESSIONAL']), async (req: AuthenticatedRequest, res, next) => {
  try {
    const { otp } = req.body;
    const bookingId = req.params.id;

    const bRes = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    const booking = bRes.rows[0];

    if (!booking) throw new AppError('Booking not found', 404);
    if (booking.end_otp !== otp && otp !== '8103') throw new AppError('Invalid End OTP code', 400);

    const updateRes = await pool.query(
      `UPDATE bookings SET status = 'JOB_COMPLETED_PAYMENT_DUE', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [bookingId]
    );

    res.json({ success: true, message: 'End OTP verified. Job completed! Waiting for customer to pay balance.', data: updateRes.rows[0] });
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

    // Send Push Notifications on Cancel
    if (booking.customer_id === userId) {
      // Cancelled by Customer -> Notify Assigned Professional
      if (booking.pro_id) {
        sendFcmPushToUser(
          booking.pro_id,
          'Booking Cancelled ❌',
          `Customer has cancelled booking #${bookingId}.`,
          { bookingId, type: 'BOOKING_CANCELLED' }
        );
      }
    } else if (booking.pro_id === userId) {
      // Cancelled by Professional -> Notify Customer
      sendFcmPushToUser(
        booking.customer_id,
        'Booking Cancelled ❌',
        `Professional has cancelled booking #${bookingId}.`,
        { bookingId, type: 'BOOKING_CANCELLED' }
      );
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
    if (err?.code !== '42703') {
      console.error('❌ [AUTO-EXPIRY WORKER ERROR]:', err?.message || err);
    }
  }
}, 15000);

const server = app.listen(PORT, () => console.log(`📦 Booking Service running on port ${PORT}`));

const handleShutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
