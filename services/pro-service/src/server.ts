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

// Single unified static folder for /proff_cert document vault
const PROFF_CERT_DIR = path.resolve('/Users/anandhu/Desktop/lumo/backend/services/api-gateway/proff_cert');
if (!fs.existsSync(PROFF_CERT_DIR)) {
  try { fs.mkdirSync(PROFF_CERT_DIR, { recursive: true }); } catch (_) { }
}

app.use(cors({
  origin: (origin, callback) => callback(null, origin || true),
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));

console.log(`📂 [PRO-SERVICE] Mounted static vault: ${PROFF_CERT_DIR}`);
app.use('/proff_cert', express.static(PROFF_CERT_DIR));

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Pro Service' }));

// 1. Fetch Account Health & Rating Metrics
app.get('/api/v1/pro/health', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const userRes = await pool.query('SELECT latitude, longitude, service_area FROM users WHERE id = $1', [req.user!.userId]);
    const user = userRes.rows[0];
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
        assignedRegion: pro.assigned_region || pro.service_area || user?.service_area || 'Kochi, Kerala',
        serviceArea: pro.service_area || user?.service_area || 'Kochi, Kerala',
        latitude: parseFloat(pro.latitude || user?.latitude || '9.9312'),
        longitude: parseFloat(pro.longitude || user?.longitude || '76.2673'),
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
      `SELECT pos.id as offered_id, pos.pro_id, pos.service_id, pos.custom_price, pos.is_active,
              s.name as service_name, s.base_price, s.description, COALESCE(c.name, 'General') as category_name
       FROM pro_offered_services pos
       JOIN services s ON pos.service_id = s.id
       LEFT JOIN service_categories c ON s.category_id = c.id
       WHERE pos.pro_id = $1 AND pos.is_active = true AND s.is_active = true`,
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

    const currentDocs = (pro?.documents && typeof pro.documents === 'object') ? pro.documents : {};

    const docs = {
      ...currentDocs,
      govtIdType: govtIdType || currentDocs.govtIdType || 'DRIVING_LICENSE',
      govtIdNumber: govtIdNumber || currentDocs.govtIdNumber || 'UPLOADED',
      govtIdUrl: govtIdUrl || currentDocs.govtIdUrl || null,
      policeVerificationUrl: policeVerificationUrl || currentDocs.policeVerificationUrl || null,
      certifications: certifications || currentDocs.certifications || [],
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

// 3b. Upload File to Backend proff_cert Vault (Stores Exact Binary File & Updates Database)
app.post('/api/v1/pro/upload-doc', async (req, res, next) => {
  try {
    const { fileName, fileData, docType, userId } = req.body;
    if (!fileData) throw new AppError('File content required', 400);

    const cleanName = (fileName || 'document.pdf').replaceAll(/[^a-zA-Z0-9_.-]/g, '_');
    const savedFileName = `${Date.now()}_${cleanName}`;
    const fileUrl = `/proff_cert/${savedFileName}`;

    // Decode exact Base64 binary payload from mobile device
    const buffer = Buffer.from(fileData.replace(/^data:.*?;base64,/, ''), 'base64');

    if (!fs.existsSync(PROFF_CERT_DIR)) {
      fs.mkdirSync(PROFF_CERT_DIR, { recursive: true });
    }

    const targetPath = path.join(PROFF_CERT_DIR, savedFileName);
    fs.writeFileSync(targetPath, buffer);
    console.log(`📄 [DOCUMENT-SAVED] Saved ${savedFileName} (${buffer.length} bytes) -> ${targetPath}`);

    // Update database record if userId or authenticated session is present
    const targetUserId = userId || (req as any).user?.userId;
    if (targetUserId) {
      const lowerName = cleanName.toLowerCase();
      const lowerDoc = (docType || '').toLowerCase();

      const isSelfie = lowerDoc.includes('selfie') || lowerName.includes('selfie') || lowerName.includes('face');
      const isPolice = lowerDoc.includes('police') || lowerDoc.includes('pcc') || lowerName.includes('police') || lowerName.includes('clearance') || lowerName.includes('pcc');
      const isGovtId = lowerDoc.includes('gov') || lowerDoc.includes('id') || lowerName.includes('id') || lowerName.includes('license') || lowerName.includes('passport') || lowerName.includes('voter') || (!isSelfie && !isPolice);

      const proRes = await pool.query('SELECT * FROM professional_profiles WHERE user_id = $1', [targetUserId]);
      const pro = proRes.rows[0];

      if (pro) {
        const currentDocs = (pro.documents && typeof pro.documents === 'object') ? pro.documents : {};
        
        // Smart URL assignment: fill govtIdUrl first, then policeVerificationUrl
        let targetGovtIdUrl = currentDocs.govtIdUrl || (isGovtId ? fileUrl : null);
        let targetPoliceUrl = currentDocs.policeVerificationUrl || (isPolice ? fileUrl : null);

        if (isGovtId && !targetGovtIdUrl) targetGovtIdUrl = fileUrl;
        if (isPolice && !targetPoliceUrl) targetPoliceUrl = fileUrl;

        // Fallback: if govtIdUrl is present but policeUrl is missing and file is not selfie, assign to policeUrl
        if (!isSelfie && targetGovtIdUrl && targetGovtIdUrl !== fileUrl && !targetPoliceUrl) {
          targetPoliceUrl = fileUrl;
        }

        const updatedDocs = {
          ...currentDocs,
          govtIdType: currentDocs.govtIdType || 'DRIVING_LICENSE',
          govtIdNumber: currentDocs.govtIdNumber || 'UPLOADED',
          govtIdUrl: targetGovtIdUrl,
          policeVerificationUrl: targetPoliceUrl,
          updatedAt: new Date().toISOString(),
        };

        await pool.query(
          `UPDATE professional_profiles
           SET documents = $1,
               face_verification_url = CASE WHEN $2 THEN $3 ELSE face_verification_url END,
               face_verified = CASE WHEN $2 THEN true ELSE face_verified END,
               verification_status = 'PENDING',
               updated_at = NOW()
           WHERE user_id = $4`,
          [JSON.stringify(updatedDocs), isSelfie, isSelfie ? fileUrl : null, targetUserId]
        );
        console.log(`💾 [DOCUMENTS-SAVED-DB] Saved document URL (${fileUrl}) into PostgreSQL database for user ${targetUserId} ✓`);
      }
    }

    res.json({
      success: true,
      message: 'Document uploaded and saved to database',
      fileUrl,
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
    const selectedServiceIds = services.map((s: any) => s.serviceId).filter(Boolean);

    if (selectedServiceIds.length > 0) {
      const placeholders = selectedServiceIds.map((_: any, i: number) => `$${i + 2}`).join(',');
      await pool.query(
        `UPDATE pro_offered_services SET is_active = false, updated_at = NOW() WHERE pro_id = $1 AND service_id NOT IN (${placeholders})`,
        [proId, ...selectedServiceIds]
      );
    } else {
      await pool.query(`UPDATE pro_offered_services SET is_active = false, updated_at = NOW() WHERE pro_id = $1`, [proId]);
    }

    for (const item of services) {
      if (!item.serviceId) continue;
      const customPrice = item.customPrice ? parseFloat(item.customPrice) : null;
      const kmCharge = item.kmCharge ? parseFloat(item.kmCharge) : 15.00;
      await pool.query(
        `INSERT INTO pro_offered_services (id, pro_id, service_id, custom_price, km_charge_per_km, per_km_rate, is_active)
         VALUES ($1, $2, $3, $4, $5, $5, true)
         ON CONFLICT (pro_id, service_id)
         DO UPDATE SET custom_price = EXCLUDED.custom_price,
                       km_charge_per_km = EXCLUDED.km_charge_per_km,
                       per_km_rate = EXCLUDED.per_km_rate,
                       is_active = true,
                       updated_at = NOW()`,
        [`pos-${randomUUID().slice(0, 8)}`, proId, item.serviceId, customPrice, kmCharge]
      );
    }

    res.json({ success: true, message: 'Offered services and custom rates saved' });
  } catch (err) { next(err); }
});

// 4b. Update Price for an Offered Service
app.post('/api/v1/pro/offered-services/update-price', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { serviceId, customPrice, kmCharge } = req.body;
    const proId = req.user!.userId;
    const priceVal = customPrice !== undefined && customPrice !== null && customPrice !== '' ? parseFloat(customPrice) : null;
    const kmVal = kmCharge !== undefined && kmCharge !== null && kmCharge !== '' ? parseFloat(kmCharge) : null;

    await pool.query(
      `UPDATE pro_offered_services 
       SET custom_price = COALESCE($1, custom_price),
           km_charge_per_km = COALESCE($2, km_charge_per_km),
           per_km_rate = COALESCE($2, per_km_rate),
           updated_at = NOW() 
       WHERE pro_id = $3 AND service_id = $4`,
      [priceVal, kmVal, proId, serviceId]
    );
    res.json({ success: true, message: 'Custom rate & travel fee per km updated' });
  } catch (err) { next(err); }
});

// 4c. Toggle Active Status for an Offered Service
app.post('/api/v1/pro/offered-services/toggle', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { serviceId, isActive } = req.body;
    const proId = req.user!.userId;
    await pool.query(
      `UPDATE pro_offered_services SET is_active = $1, updated_at = NOW() WHERE pro_id = $2 AND service_id = $3`,
      [Boolean(isActive), proId, serviceId]
    );
    res.json({ success: true, message: 'Offered service status updated' });
  } catch (err) { next(err); }
});

// 4d. Delete an Offered Service
app.post('/api/v1/pro/offered-services/delete', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { serviceId } = req.body;
    const proId = req.user!.userId;
    await pool.query(
      `DELETE FROM pro_offered_services WHERE pro_id = $1 AND service_id = $2`,
      [proId, serviceId]
    );
    res.json({ success: true, message: 'Offered service removed' });
  } catch (err) { next(err); }
});

// 5. Fetch My Custom Service Requests
app.get('/api/v1/pro/custom-services/my-requests', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const proId = req.user!.userId;
    const requests = await pool.query(
      `SELECT * FROM pending_service_requests WHERE pro_id = $1 ORDER BY created_at DESC`,
      [proId]
    );
    res.json({ success: true, data: requests.rows });
  } catch (err) { next(err); }
});

// 5b. Toggle Active Status for a Custom Service Request
app.post('/api/v1/pro/custom-services/toggle', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    const { requestId, isActive } = req.body;
    const proId = req.user!.userId;
    const reqRes = await pool.query(
      `UPDATE pending_service_requests SET is_active = $1, updated_at = NOW() WHERE id = $2 AND pro_id = $3 RETURNING service_name`,
      [Boolean(isActive), requestId, proId]
    );
    const serviceName = reqRes.rows[0]?.service_name;
    if (serviceName) {
      const srvRes = await pool.query('SELECT id FROM services WHERE LOWER(name) = LOWER($1)', [serviceName]);
      const srvId = srvRes.rows[0]?.id;
      if (srvId) {
        await pool.query(
          `UPDATE pro_offered_services SET is_active = $1, updated_at = NOW() WHERE pro_id = $2 AND service_id = $3`,
          [Boolean(isActive), proId, srvId]
        );
      }
    }
    res.json({ success: true, message: 'Custom service request status updated' });
  } catch (err) { next(err); }
});

// 5. Request New Custom Service (Pending Admin Approval)
const handleCustomServiceRequest = async (req: AuthenticatedRequest, res: any, next: any) => {
  try {
    const { serviceName, description, suggestedPrice, kmCharge } = req.body;
    if (!serviceName) throw new AppError('Service name required', 400);

    const requestId = `svc-req-${randomUUID().slice(0, 8)}`;
    const proId = req.user?.userId;

    if (!proId) {
      throw new AppError('Unauthorized: Professional authentication required', 401);
    }

    const result = await pool.query(
      `INSERT INTO pending_service_requests (id, pro_id, service_name, description, suggested_price, km_charge_per_km, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING_ADMIN_APPROVAL') RETURNING *`,
      [requestId, proId, serviceName, description || '', suggestedPrice ? parseFloat(suggestedPrice) : null, kmCharge ? parseFloat(kmCharge) : 15.00]
    );

    res.status(201).json({
      success: true,
      message: 'New service request submitted for Super Admin approval',
      data: result.rows[0],
    });
  } catch (err) { next(err); }
};

app.post('/api/v1/pro/request-service', authenticateToken, handleCustomServiceRequest);
app.post('/api/v1/pro/service-request', authenticateToken, handleCustomServiceRequest);

// 6. Toggle Duty Status (Online / Offline)
const handleDutyStatus = async (req: AuthenticatedRequest, res: any, next: any) => {
  try {
    const { isOnline, latitude, longitude } = req.body;
    const proId = req.user!.userId;

    const proRes = await pool.query('SELECT * FROM professional_profiles WHERE user_id = $1', [proId]);
    const pro = proRes.rows[0];

    if (!pro) throw new AppError('Professional profile not found', 404);
    if (pro.verification_status !== 'APPROVED') {
      throw new AppError('Cannot go online. Your profile verification status is PENDING or SUSPENDED.', 403);
    }

    const lat = latitude !== undefined && latitude !== null ? parseFloat(latitude) : (pro.latitude ? parseFloat(pro.latitude) : (pro.current_location?.latitude || pro.current_location?.lat || 9.9312));
    const lng = longitude !== undefined && longitude !== null ? parseFloat(longitude) : (pro.longitude ? parseFloat(pro.longitude) : (pro.current_location?.longitude || pro.current_location?.lng || 76.2673));

    const locJson = JSON.stringify({ latitude: lat, longitude: lng, lat: lat, lng: lng, updatedAt: new Date().toISOString() });

    const updateRes = await pool.query(
      `UPDATE professional_profiles
       SET is_online = $1, current_location = $2, latitude = $3, longitude = $4, updated_at = NOW()
       WHERE user_id = $5 RETURNING *`,
      [Boolean(isOnline), locJson, lat, lng, proId]
    );

    res.json({
      success: true,
      message: `Duty status updated to ${isOnline ? 'ONLINE' : 'OFFLINE'}`,
      data: updateRes.rows[0],
    });
  } catch (err) { next(err); }
};

app.put('/api/v1/pro/duty-status', authenticateToken, handleDutyStatus);
app.post('/api/v1/pro/duty-status', authenticateToken, handleDutyStatus);

app.use(errorHandler);

app.listen(PORT, () => console.log(`👷 Professional Service running on port ${PORT}`));
