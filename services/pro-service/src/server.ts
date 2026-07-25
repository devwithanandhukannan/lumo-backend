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

// Ensure candidate proff_cert folders exist and mount static serving
const candidateCertDirs = [
  path.resolve(process.cwd(), 'proff_cert'),
  path.resolve(process.cwd(), '../api-gateway/proff_cert'),
  path.resolve(process.cwd(), '../../proff_cert'),
  path.resolve(__dirname, '../../../proff_cert'),
  path.resolve(__dirname, '../../../services/api-gateway/proff_cert'),
];

for (const dir of candidateCertDirs) {
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  }
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));

for (const dir of candidateCertDirs) {
  if (fs.existsSync(dir)) {
    console.log(`📂 [PRO-SERVICE] Mounted static vault: ${dir}`);
    app.use('/proff_cert', express.static(dir));
  }
}

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
        assignedRegion: pro.assigned_region || pro.service_area || 'Kochi, Kerala',
        serviceArea: pro.service_area || 'Kochi, Kerala',
        isOnline: pro.is_online,
      },
    });
  } catch (err) { next(err); }
});

// 2. Fetch Full Professional Profile & Documents
app.get('/api/v1/pro/profile', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const userRes = await pool.query('SELECT id, phone_number, email, full_name, role, gender, avatar_url, service_area, email_verified, phone_verified FROM users WHERE id = $1', [req.user!.userId]);
    const user = userRes.rows[0];
    if (!user) throw new AppError('User not found', 404);

    const proRes = await pool.query('SELECT * FROM professional_profiles WHERE user_id = $1', [user.id]);
    const pro = proRes.rows[0];

    const servicesRes = await pool.query(
      `SELECT pos.*, s.name as service_name, s.base_price, s.description, c.name as category_name
       FROM pro_offered_services pos
       JOIN services s ON pos.service_id = s.id
       JOIN service_categories c ON s.category_id = c.id
       WHERE pos.pro_id = $1 AND pos.is_active = true`,
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
          service_area: pro.service_area || user.service_area || 'Kochi, Kerala',
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

// 3b. Upload File to Backend proff_cert Folders (Stores Exact Binary File Content)
app.post('/api/v1/pro/upload-doc', async (req, res, next) => {
  try {
    const { fileName, fileData, docType } = req.body;
    if (!fileData) throw new AppError('File content required', 400);

    const cleanName = (fileName || 'document.pdf').replaceAll(/[^a-zA-Z0-9_.-]/g, '_');
    const savedFileName = `${Date.now()}_${cleanName}`;

    // Decode exact Base64 binary payload from mobile device
    const buffer = Buffer.from(fileData.replace(/^data:.*?;base64,/, ''), 'base64');

    // Write exact binary file to ALL vault folders
    for (const dir of candidateCertDirs) {
      if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      }
      try {
        fs.writeFileSync(path.join(dir, savedFileName), buffer);
        console.log(`📄 [DOCUMENT-SAVED] Wrote ${savedFileName} (${buffer.length} bytes) -> ${dir}`);
      } catch (err: any) {
        console.warn(`⚠️ Could not write to ${dir}: ${err.message}`);
      }
    }

    res.json({
      success: true,
      message: 'Exact binary document stored successfully in proff_cert vault',
      fileUrl: `/proff_cert/${savedFileName}`,
      savedFileName,
      byteSize: buffer.length,
    });
  } catch (err) { next(err); }
});

// 4. Save Offered Services & Custom Pricing
app.post('/api/v1/pro/offered-services', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { services } = req.body;
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

    res.json({ success: true, message: 'Offered services and custom rates saved' });
  } catch (err) { next(err); }
});

// 5. Request New Custom Service (Pending Admin Approval)
app.post('/api/v1/pro/request-service', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { serviceName, description, suggestedPrice } = req.body;
    if (!serviceName) throw new AppError('Service name required', 400);

    const requestId = `svc-req-${randomUUID().slice(0, 8)}`;
    const proId = req.user!.userId;

    const result = await pool.query(
      `INSERT INTO pending_service_requests (id, pro_id, service_name, description, suggested_price, status)
       VALUES ($1, $2, $3, $4, $5, 'PENDING_ADMIN_APPROVAL') RETURNING *`,
      [requestId, proId, serviceName, description || '', suggestedPrice ? parseFloat(suggestedPrice) : null]
    );

    res.status(201).json({
      success: true,
      message: 'New service request submitted for Super Admin approval',
      data: result.rows[0],
    });
  } catch (err) { next(err); }
});

// 5a. Get my custom service requests
app.get('/api/v1/pro/custom-services/my-requests', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const proId = req.user!.userId;
    const result = await pool.query(
      `SELECT * FROM pending_service_requests WHERE pro_id = $1 ORDER BY created_at DESC`,
      [proId]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { next(err); }
});

// 5b. Toggle custom service request active/inactive
app.post('/api/v1/pro/custom-services/toggle', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { requestId, isActive } = req.body;
    const proId = req.user!.userId;
    if (!requestId) throw new AppError('requestId is required', 400);

    const result = await pool.query(
      `UPDATE pending_service_requests SET status = $1, updated_at = NOW()
       WHERE id = $2 AND pro_id = $3 RETURNING *`,
      [isActive ? 'PENDING_ADMIN_APPROVAL' : 'INACTIVE', requestId, proId]
    );
    if (result.rowCount === 0) throw new AppError('Service request not found', 404);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

// 6. Toggle Duty Status (Online / Offline)
app.put('/api/v1/pro/duty-status', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { isOnline, latitude, longitude } = req.body;
    const proId = req.user!.userId;

    const proRes = await pool.query('SELECT * FROM professional_profiles WHERE user_id = $1', [proId]);
    const pro = proRes.rows[0];

    if (!pro) throw new AppError('Professional profile not found', 404);
    if (pro.verification_status !== 'APPROVED') {
      throw new AppError('Cannot go online. Your profile verification status is PENDING or SUSPENDED.', 403);
    }

    const locJson = (latitude !== undefined && longitude !== undefined)
      ? JSON.stringify({ lat: latitude, lng: longitude, updatedAt: new Date().toISOString() })
      : pro.current_location;

    const updateRes = await pool.query(
      `UPDATE professional_profiles
       SET is_online = $1, current_location = $2, updated_at = NOW()
       WHERE user_id = $3 RETURNING *`,
      [Boolean(isOnline), locJson, proId]
    );

    res.json({
      success: true,
      message: `Duty status updated to ${isOnline ? 'ONLINE' : 'OFFLINE'}`,
      data: updateRes.rows[0],
    });
  } catch (err) { next(err); }
});

app.use(errorHandler);

const server = app.listen(PORT, () => console.log(`👷 Professional Service running on port ${PORT}`));

const handleShutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
