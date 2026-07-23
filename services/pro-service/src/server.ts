import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from '@lumo/database';
import { authenticateToken, AuthenticatedRequest, AppError, errorHandler } from '@lumo/common';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5003;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Pro Service' }));

// 1. Fetch Account Health & Rating Metrics
app.get('/api/v1/pro/health', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const proRes = await pool.query('SELECT * FROM professional_profiles WHERE user_id = $1', [req.user!.userId]);
    const pro = proRes.rows[0];
    if (!pro) throw new AppError('Professional profile not found', 404);

    res.json({
      success: true,
      data: {
        accountHealthScore: parseFloat(pro.account_health_score),
        ratingAvg: parseFloat(pro.rating_avg),
        totalJobsCompleted: pro.total_jobs_completed,
        acceptanceRate: parseFloat(pro.acceptance_rate),
        cancellationRate: parseFloat(pro.cancellation_rate),
        verificationStatus: pro.verification_status,
        coverageRadiusKm: parseFloat(pro.coverage_radius_km || '50.00'),
        assignedRegion: pro.assigned_region || 'Bangalore',
        isOnline: pro.is_online,
      },
    });
  } catch (err) { next(err); }
});

// 2. Fetch Full Professional Profile & Documents
app.get('/api/v1/pro/profile', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const userRes = await pool.query('SELECT id, phone_number, email, full_name, role, gender, avatar_url, email_verified, phone_verified FROM users WHERE id = $1', [req.user!.userId]);
    const user = userRes.rows[0];
    if (!user) throw new AppError('User not found', 404);

    const proRes = await pool.query('SELECT * FROM professional_profiles WHERE user_id = $1', [user.id]);
    const pro = proRes.rows[0];

    const servicesRes = await pool.query(
      `SELECT pos.*, s.name as service_name, s.base_price, c.name as category_name
       FROM pro_offered_services pos
       JOIN services s ON pos.service_id = s.id
       JOIN service_categories c ON s.category_id = c.id
       WHERE pos.pro_id = $1`,
      [user.id]
    );

    res.json({
      success: true,
      data: {
        user,
        profile: pro ? {
          ...pro,
          coverage_radius_km: parseFloat(pro.coverage_radius_km || '50.00'),
          rating_avg: parseFloat(pro.rating_avg),
          account_health_score: parseFloat(pro.account_health_score),
        } : null,
        offeredServices: servicesRes.rows,
      },
    });
  } catch (err) { next(err); }
});

// 3. Upload Verification Documents (Govt ID, Police Clearance PDF, Face Selfie)
app.post('/api/v1/pro/documents', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { govtIdType, govtIdNumber, govtIdUrl, policeVerificationUrl, faceSelfieUrl, certifications } = req.body;

    const proRes = await pool.query('SELECT * FROM professional_profiles WHERE user_id = $1', [req.user!.userId]);
    let pro = proRes.rows[0];

    const docs = {
      ...(pro?.documents || {}),
      govtIdType,
      govtIdNumber,
      govtIdUrl,
      policeVerificationUrl,
      certifications: certifications || [],
      updatedAt: new Date().toISOString(),
    };

    // Updating documents places account into PENDING re-verification review state
    if (!pro) {
      const insertRes = await pool.query(
        `INSERT INTO professional_profiles (id, user_id, verification_status, documents, face_verification_url, face_verified, is_online)
         VALUES ($1, $2, 'PENDING', $3, $4, $5, false) RETURNING *`,
        [`pro-${randomUUID().slice(0, 8)}`, req.user!.userId, JSON.stringify(docs), faceSelfieUrl || null, Boolean(faceSelfieUrl)]
      );
      pro = insertRes.rows[0];
    } else {
      const updateRes = await pool.query(
        `UPDATE professional_profiles
         SET verification_status = 'PENDING',
             documents = $1,
             face_verification_url = COALESCE($2, face_verification_url),
             face_verified = CASE WHEN $2 IS NOT NULL THEN true ELSE face_verified END,
             is_online = false,
             updated_at = NOW()
         WHERE user_id = $3 RETURNING *`,
        [JSON.stringify(docs), faceSelfieUrl || null, req.user!.userId]
      );
      pro = updateRes.rows[0];
    }

    res.json({
      success: true,
      message: 'Verification documents submitted. Profile set to PENDING admin review.',
      data: pro,
    });
  } catch (err) { next(err); }
});

// 4. Save Offered Services & Custom Pricing
app.post('/api/v1/pro/offered-services', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { services } = req.body; // Array of { serviceId, customPrice }
    if (!Array.isArray(services)) throw new AppError('Services array required', 400);

    const proId = req.user!.userId;

    for (const item of services) {
      await pool.query(
        `INSERT INTO pro_offered_services (id, pro_id, service_id, custom_price, is_active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (pro_id, service_id) DO UPDATE SET custom_price = $4, is_active = true`,
        [`pos-${randomUUID().slice(0, 8)}`, proId, item.serviceId, item.customPrice ? parseFloat(item.customPrice) : null]
      );
    }

    const updated = await pool.query(
      `SELECT pos.*, s.name as service_name, s.base_price
       FROM pro_offered_services pos
       JOIN services s ON pos.service_id = s.id
       WHERE pos.pro_id = $1`,
      [proId]
    );

    res.json({ success: true, data: updated.rows });
  } catch (err) { next(err); }
});

// 5. Toggle Online/Offline Duty (Requires APPROVED Verification Status)
app.post('/api/v1/pro/status', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { isOnline, latitude, longitude } = req.body;

    const proRes = await pool.query('SELECT * FROM professional_profiles WHERE user_id = $1', [req.user!.userId]);
    const pro = proRes.rows[0];

    if (!pro) throw new AppError('Professional profile not found', 404);

    if (isOnline && pro.verification_status !== 'APPROVED') {
      throw new AppError(`Cannot go online. Account verification status is ${pro.verification_status}. Admin review required.`, 403);
    }

    const locationJson = (latitude && longitude) ? JSON.stringify({ latitude, longitude, updatedAt: new Date().toISOString() }) : pro.current_location;

    await pool.query(
      `UPDATE professional_profiles SET is_online = $1, current_location = COALESCE($2, current_location), updated_at = NOW() WHERE user_id = $3`,
      [Boolean(isOnline), locationJson, req.user!.userId]
    );

    res.json({ success: true, isOnline: Boolean(isOnline), message: `Status updated to ${isOnline ? 'ONLINE' : 'OFFLINE'}` });
  } catch (err) { next(err); }
});

app.use(errorHandler);

app.listen(PORT, () => console.log(`👷 Pro Service running on port ${PORT}`));
