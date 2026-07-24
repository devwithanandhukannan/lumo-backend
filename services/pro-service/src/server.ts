import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { pool } from '@lumo/database';
import { authenticateToken, AuthenticatedRequest, AppError, errorHandler } from '@lumo/common';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5003;

// Ensure backend/proff_cert folder exists
const proffCertDir = path.join(process.cwd(), 'proff_cert');
if (!fs.existsSync(proffCertDir)) {
  fs.mkdirSync(proffCertDir, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/proff_cert', express.static(proffCertDir));

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
      message: 'Verification documents submitted for review',
      data: pro,
    });
  } catch (err) { next(err); }
});

// 3b. Upload File to Backend proff_cert Folder
app.post('/api/v1/pro/upload-doc', async (req, res, next) => {
  try {
    const { fileName, fileData, docType } = req.body;
    if (!fileData) throw new AppError('File content required', 400);

    const cleanName = (fileName || 'document.pdf').replaceAll(/[^a-zA-Z0-9_.-]/g, '_');
    const savedFileName = `${Date.now()}_${cleanName}`;
    const savePath = path.join(proffCertDir, savedFileName);

    const buffer = Buffer.from(fileData.replace(/^data:.*?;base64,/, ''), 'base64');
    fs.writeFileSync(savePath, buffer);

    console.log(`📄 [DOCUMENT-SAVED] Stored ${docType || 'doc'} in proff_cert folder: ${savedFileName}`);

    res.json({
      success: true,
      message: 'Document stored successfully in proff_cert folder',
      fileUrl: `/proff_cert/${savedFileName}`,
      savedFileName,
      localPath: savePath,
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

// 6. Get Job Invites (pending bookings within pro's coverage area)
app.get('/api/v1/pro/job-invites', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const proRes = await pool.query('SELECT * FROM professional_profiles WHERE user_id = $1', [req.user!.userId]);
    const pro = proRes.rows[0];
    if (!pro) throw new AppError('Professional profile not found', 404);

    // Fetch REQUESTED bookings where pro hasn't been assigned yet
    const bookingsRes = await pool.query(
      `SELECT b.*, s.name as service_name, s.base_price,
              u.full_name as customer_name, u.phone_number as customer_phone
       FROM bookings b
       JOIN services s ON b.service_id = s.id
       JOIN users u ON b.customer_id = u.id
       WHERE b.status = 'REQUESTED'
         AND b.pro_id IS NULL
       ORDER BY b.created_at DESC
       LIMIT 20`,
      []
    );

    res.json({ success: true, data: bookingsRes.rows });
  } catch (err) { next(err); }
});

// 7. Request a Custom Service (pending admin approval)
app.post('/api/v1/pro/service-request', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { serviceName, description, suggestedPrice, categoryId } = req.body;
    if (!serviceName) throw new AppError('Service name is required', 400);

    const id = `svc-req-${randomUUID().slice(0, 8)}`;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pending_service_requests (
          id VARCHAR(50) PRIMARY KEY,
          pro_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          service_name VARCHAR(100) NOT NULL,
          description TEXT,
          suggested_price NUMERIC(10,2),
          category_id VARCHAR(50),
          status VARCHAR(30) DEFAULT 'PENDING_ADMIN_APPROVAL',
          admin_notes TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `).catch(() => {});

    const result = await pool.query(
      `INSERT INTO pending_service_requests (id, pro_id, service_name, description, suggested_price, category_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, req.user!.userId, serviceName, description || '', suggestedPrice || null, categoryId || null]
    );

    res.status(201).json({ success: true, data: result.rows[0], message: 'Service request submitted for admin review.' });
  } catch (err) { next(err); }
});

// 8. Get Pro's custom service requests
app.get('/api/v1/pro/service-requests', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pending_service_requests (
          id VARCHAR(50) PRIMARY KEY,
          pro_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          service_name VARCHAR(100) NOT NULL,
          description TEXT,
          suggested_price NUMERIC(10,2),
          category_id VARCHAR(50),
          status VARCHAR(30) DEFAULT 'PENDING_ADMIN_APPROVAL',
          admin_notes TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `).catch(() => {});

    const result = await pool.query(
      `SELECT * FROM pending_service_requests WHERE pro_id = $1 ORDER BY created_at DESC`,
      [req.user!.userId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

app.use(errorHandler);

app.listen(PORT, '0.0.0.0', () => console.log(`👷 Pro Service running on port ${PORT}`));
