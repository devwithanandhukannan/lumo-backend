import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { pool, initDatabaseTables } from '@lumo/database';
import { authenticateToken, AuthenticatedRequest, AppError, errorHandler } from '@lumo/common';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5003;

// Ensure both local proff_cert and root backend/proff_cert folders exist
const proffCertDir = path.join(process.cwd(), 'proff_cert');
const rootCertDir = path.resolve(process.cwd(), '../../proff_cert');

if (!fs.existsSync(proffCertDir)) {
  fs.mkdirSync(proffCertDir, { recursive: true });
}
if (!fs.existsSync(rootCertDir)) {
  fs.mkdirSync(rootCertDir, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/proff_cert', express.static(proffCertDir));
app.use('/proff_cert', express.static(rootCertDir));

// Ensure database tables exist
initDatabaseTables().catch((err: any) => console.error('Database table init failed in pro-service:', err));

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
        verificationNotes: pro.verification_notes || null,
        coverageRadiusKm: parseFloat(pro.coverage_radius_km || '50.00'),
        assignedRegion: pro.assigned_region || pro.service_area || null,
        serviceArea: pro.service_area || pro.assigned_region || null,
        requestedLocation: pro.requested_location || null,
        locationChangeStatus: pro.location_change_status || null,
        locationChangeReason: pro.location_change_reason || null,
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
          service_area: pro.service_area || user.service_area || null,
          assigned_region: pro.assigned_region || pro.service_area || user.service_area || null,
          verification_notes: pro.verification_notes || null,
          requested_location: pro.requested_location || null,
          location_change_status: pro.location_change_status || null,
        } : null,
        offeredServices: servicesRes.rows,
      },
    });
  } catch (err) { next(err); }
});

// 3. Upload Verification Documents (Govt ID, Police Clearance PDF, Face Selfie, Exact Location)
app.post('/api/v1/pro/documents', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { govtIdType, govtIdNumber, govtIdUrl, policeVerificationUrl, faceSelfieUrl, certifications, location, serviceArea } = req.body;

    const proRes = await pool.query('SELECT * FROM professional_profiles WHERE user_id = $1', [req.user!.userId]);
    let pro = proRes.rows[0];

    const targetLocation = location || serviceArea || null;
    if (targetLocation) {
      await pool.query('UPDATE users SET service_area = $1 WHERE id = $2', [targetLocation, req.user!.userId]);
    }

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
        `INSERT INTO professional_profiles (id, user_id, verification_status, documents, face_verification_url, face_verified, service_area, assigned_region, is_online)
         VALUES ($1, $2, 'PENDING', $3, $4, $5, $6, $6, false) RETURNING *`,
        [`pro-${randomUUID().slice(0, 8)}`, req.user!.userId, JSON.stringify(docs), faceSelfieUrl || null, Boolean(faceSelfieUrl), targetLocation]
      );
      pro = insertRes.rows[0];
    } else {
      const updateRes = await pool.query(
        `UPDATE professional_profiles
         SET verification_status = 'PENDING',
             verification_notes = NULL,
             documents = $1,
             face_verification_url = COALESCE($2, face_verification_url),
             face_verified = CASE WHEN $2 IS NOT NULL THEN true ELSE face_verified END,
             service_area = COALESCE($3, service_area),
             assigned_region = COALESCE($3, assigned_region),
             is_online = false,
             updated_at = NOW()
         WHERE user_id = $4 RETURNING *`,
        [JSON.stringify(docs), faceSelfieUrl || null, targetLocation, req.user!.userId]
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

// 3b. Upload File to Backend proff_cert Folders
app.post('/api/v1/pro/upload-doc', async (req, res, next) => {
  try {
    const { fileName, fileData, docType } = req.body;
    if (!fileData) throw new AppError('File content required', 400);

    const cleanName = (fileName || 'document.pdf').replaceAll(/[^a-zA-Z0-9_.-]/g, '_');
    const savedFileName = `${Date.now()}_${cleanName}`;

    const savePath1 = path.join(proffCertDir, savedFileName);
    const savePath2 = path.join(rootCertDir, savedFileName);

    const buffer = Buffer.from(fileData.replace(/^data:.*?;base64,/, ''), 'base64');

    fs.writeFileSync(savePath1, buffer);
    try { fs.writeFileSync(savePath2, buffer); } catch (_) {}

    console.log(`📄 [DOCUMENT-SAVED] Stored ${docType || 'doc'} in proff_cert folders: ${savedFileName}`);

    res.json({
      success: true,
      message: 'Document stored successfully in proff_cert folder',
      fileUrl: `/proff_cert/${savedFileName}`,
      savedFileName,
      localPath: savePath1,
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

// 4b. Instant Edit Custom Price (No Admin Verification Required)
app.post('/api/v1/pro/offered-services/update-price', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { serviceId, customPrice } = req.body;
    if (!serviceId) throw new AppError('Service ID required', 400);

    const proId = req.user!.userId;
    const priceNum = customPrice !== undefined && customPrice !== null ? parseFloat(customPrice) : null;

    const result = await pool.query(
      `INSERT INTO pro_offered_services (id, pro_id, service_id, custom_price, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (pro_id, service_id) DO UPDATE SET custom_price = $4, updated_at = NOW() RETURNING *`,
      [`pos-${randomUUID().slice(0, 8)}`, proId, serviceId, priceNum]
    );

    res.json({
      success: true,
      message: 'Custom rate updated instantly!',
      data: result.rows[0],
    });
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

app.post('/api/v1/pro/service-request', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
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

// 5b. Fetch My Custom Service Requests
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

// 6. Toggle Duty Status (Online / Offline)
const handleDutyStatusToggle = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
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
};

app.put('/api/v1/pro/duty-status', authenticateToken, handleDutyStatusToggle as any);
app.post('/api/v1/pro/duty-status', authenticateToken, handleDutyStatusToggle as any);
app.put('/api/v1/pro/status', authenticateToken, handleDutyStatusToggle as any);
app.post('/api/v1/pro/status', authenticateToken, handleDutyStatusToggle as any);

// 7. Request Location Change / Update (Pending Admin Approval)
app.post('/api/v1/pro/location-change-request', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { requestedLocation, reason, latitude, longitude } = req.body;
    if (!requestedLocation) throw new AppError('Requested location is required', 400);

    const proId = req.user!.userId;
    const requestId = `loc-req-${randomUUID().slice(0, 8)}`;
    const lat = latitude ? parseFloat(latitude) : null;
    const lng = longitude ? parseFloat(longitude) : null;

    const proRes = await pool.query('SELECT service_area, assigned_region FROM professional_profiles WHERE user_id = $1', [proId]);
    const currentLoc = proRes.rows[0]?.service_area || proRes.rows[0]?.assigned_region || 'Not set';

    await pool.query(
      `INSERT INTO pro_location_change_requests (id, pro_id, current_location, requested_location, latitude, longitude, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_ADMIN_APPROVAL')`,
      [requestId, proId, currentLoc, requestedLocation, lat, lng]
    );

    await pool.query(
      `UPDATE professional_profiles
       SET requested_location = $1, requested_latitude = $2, requested_longitude = $3, location_change_status = 'PENDING_ADMIN_APPROVAL', location_change_reason = $4, updated_at = NOW()
       WHERE user_id = $5`,
      [requestedLocation, lat, lng, reason || null, proId]
    );

    res.status(201).json({
      success: true,
      message: 'Location change request submitted for Admin approval',
      data: { requestId, requestedLocation, status: 'PENDING_ADMIN_APPROVAL' },
    });
  } catch (err) { next(err); }
});

app.use(errorHandler);

app.listen(PORT, () => console.log(`👷 Professional Service running on port ${PORT}`));
