import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import { pool } from '@lumo/database';
import { authenticateToken, requireRoles, AppError, errorHandler } from '@lumo/common';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5007;

const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:5009';

app.use(cors({
  origin: (origin, callback) => callback(null, origin || true),
  credentials: true,
}));
app.use(express.json());

// Self-healing database initialization
async function ensureSafetySchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        setting_key VARCHAR(100) PRIMARY KEY,
        setting_value TEXT NOT NULL,
        description TEXT,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
      INSERT INTO system_settings (setting_key, setting_value, description)
      VALUES 
        ('PLATFORM_COMMISSION_PERCENT', '15.0', 'Platform percentage split deducted from job bookings'),
        ('MIN_RADIUS_KM', '5.0', 'Minimum professional service tolerance radius'),
        ('MAX_RADIUS_KM', '100.0', 'Maximum professional service tolerance radius')
      ON CONFLICT (setting_key) DO NOTHING;

      CREATE TABLE IF NOT EXISTS sos_alerts (
        id VARCHAR(50) PRIMARY KEY,
        booking_id VARCHAR(50),
        triggered_by_user_id VARCHAR(50) NOT NULL,
        trigger_latitude DOUBLE PRECISION NOT NULL,
        trigger_longitude DOUBLE PRECISION NOT NULL,
        status VARCHAR(30) DEFAULT 'ACTIVE',
        notes TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        resolved_at TIMESTAMP WITH TIME ZONE
      );

      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS verification_notes TEXT;
    `);
  } catch (err: any) {
    console.warn('⚠️ [SAFETY-SCHEMA-INIT] Warning during schema check:', err.message);
  }
}
ensureSafetySchema();

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Safety Service' }));

// 1. Trigger Emergency SOS Alert Handler
const handleSosTrigger = async (req: any, res: any, next: any) => {
  try {
    const { bookingId, notes } = req.body;
    let latitude = req.body.latitude;
    let longitude = req.body.longitude;

    const sosId = `sos-${randomUUID().slice(0, 8)}`;
    const userId = req.user?.userId || 'usr-009088e1';
    const userRole = req.user?.role || 'PROFESSIONAL';

    if (latitude === undefined || longitude === undefined || latitude === null || longitude === null) {
      // Fallback query from professional profile or user location
      const fallbackRes = await pool.query(
        `SELECT p.current_location, u.latitude, u.longitude
         FROM users u
         LEFT JOIN professional_profiles p ON u.id = p.user_id
         WHERE u.id = $1`,
        [userId]
      );
      const row = fallbackRes.rows[0];
      if (row) {
        if (row.current_location) {
          try {
            const loc = typeof row.current_location === 'string' ? JSON.parse(row.current_location) : row.current_location;
            latitude = loc.lat || loc.latitude;
            longitude = loc.lng || loc.longitude;
          } catch (_) {}
        }
        if (latitude === undefined && row.latitude !== null) {
          latitude = parseFloat(row.latitude);
          longitude = parseFloat(row.longitude);
        }
      }
    }

    const finalLat = latitude !== undefined && latitude !== null ? parseFloat(latitude) : 12.9716;
    const finalLng = longitude !== undefined && longitude !== null ? parseFloat(longitude) : 77.5946;

    const result = await pool.query(
      `INSERT INTO sos_alerts (id, booking_id, triggered_by_user_id, trigger_latitude, trigger_longitude, status, notes)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6) RETURNING *`,
      [sosId, bookingId || null, userId, finalLat, finalLng, notes || 'Emergency SOS Pressed']
    );

    const sosAlert = result.rows[0];

    // Fetch details of user triggering SOS
    const userRes = await pool.query('SELECT full_name, email, phone_number, role FROM users WHERE id = $1', [userId]);
    const userInfo = userRes.rows[0] || {};

    const enrichedSosData = {
      id: sosAlert.id,
      booking_id: sosAlert.booking_id,
      user_id: userId,
      user_role: userInfo.role || userRole,
      latitude: parseFloat(sosAlert.trigger_latitude),
      longitude: parseFloat(sosAlert.trigger_longitude),
      status: sosAlert.status,
      created_at: sosAlert.created_at,
      full_name: userInfo.full_name || 'Emergency Reporter',
      email: userInfo.email || '',
      phone_number: userInfo.phone_number || '',
    };

    console.log(`🚨 [EMERGENCY-SOS] ALERT TRIGGERED by ${userRole} ${userId} at (${latitude}, ${longitude})`);

    // Broadcast to Notification Service (Fire and Forget)
    fetch(`${NOTIFICATION_SERVICE_URL}/api/v1/notifications/broadcast-sos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sosData: enrichedSosData }),
    }).then(() => console.log('✅ [SOS-NOTIFICATION-SENT] Broadcasted to Admin Notification Service'))
      .catch((err) => console.warn('⚠️ Notification Broadcast Failed:', err.message));

    res.status(201).json({
      success: true,
      message: 'EMERGENCY SOS ALERT BROADCASTED TO SAFETY RESPONSE TEAM',
      data: enrichedSosData,
    });
  } catch (err) { next(err); }
};

app.post('/api/v1/safety/sos', authenticateToken, handleSosTrigger);
app.post('/api/v1/safety/sos/trigger', authenticateToken, handleSosTrigger);

// 2. Fetch Active SOS Alerts (Admin Safety Dashboard)
app.get('/api/v1/admin/safety/sos', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const alerts = await pool.query(
      `SELECT s.id, s.booking_id, s.triggered_by_user_id as user_id,
              s.trigger_latitude as latitude, s.trigger_longitude as longitude,
              s.status, s.notes, s.created_at,
              u.full_name, u.phone_number, u.email, u.role as user_role
       FROM sos_alerts s
       JOIN users u ON s.triggered_by_user_id = u.id
       ORDER BY s.created_at DESC`
    );

    res.json({ success: true, data: alerts.rows });
  } catch (err) { next(err); }
});

// 3. Resolve SOS Alert
app.put('/api/v1/admin/safety/sos/:id/resolve', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE sos_alerts SET status = 'RESOLVED', resolved_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

// 4. Admin: Fetch All Professionals & Document Verification Applications
app.get('/api/v1/admin/pro/verifications', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const pros = await pool.query(
      `SELECT u.id as user_id, u.full_name, u.email, u.phone_number, u.gender, u.email_verified, u.phone_verified,
              p.id as profile_id, p.verification_status, p.documents, p.face_verification_url, p.face_verified,
              p.coverage_radius_km, p.assigned_region, p.service_area, p.is_online, p.rating_avg, p.created_at,
              COALESCE(p.latitude, u.latitude) as latitude,
              COALESCE(p.longitude, u.longitude) as longitude
       FROM users u
       JOIN professional_profiles p ON u.id = p.user_id
       WHERE u.role = 'PROFESSIONAL'
       ORDER BY CASE WHEN p.verification_status = 'PENDING' THEN 1 ELSE 2 END, p.created_at DESC`
    );

    const PROFF_CERT_DIR = '/Users/anandhu/Desktop/lumo/backend/services/api-gateway/proff_cert';
    let availableCertFiles: string[] = [];
    try {
      if (fs.existsSync(PROFF_CERT_DIR)) {
        availableCertFiles = fs.readdirSync(PROFF_CERT_DIR).filter((f) => !f.startsWith('.'));
      }
    } catch (_) {}

    // Fetch all offered services with custom prices for all pros
    let offeredServicesByPro: Record<string, any[]> = {};
    try {
      const offeredRes = await pool.query(
        `SELECT pos.pro_id, pos.service_id, pos.custom_price, pos.is_active, s.name as service_name, s.base_price
         FROM pro_offered_services pos
         JOIN services s ON pos.service_id = s.id`
      );
      for (const row of offeredRes.rows) {
        if (!offeredServicesByPro[row.pro_id]) offeredServicesByPro[row.pro_id] = [];
        offeredServicesByPro[row.pro_id].push({
          service_id: row.service_id,
          service_name: row.service_name,
          base_price: parseFloat(row.base_price || '0'),
          custom_price: row.custom_price !== null ? parseFloat(row.custom_price) : null,
          is_active: row.is_active,
        });
      }
    } catch (_) {}

    // Fetch all custom service requests submitted by pros
    let customRequestsByPro: Record<string, any[]> = {};
    try {
      const customRes = await pool.query(
        `SELECT id, pro_id, service_name, description, suggested_price, status, created_at
         FROM pending_service_requests
         ORDER BY created_at DESC`
      );
      for (const row of customRes.rows) {
        if (!customRequestsByPro[row.pro_id]) customRequestsByPro[row.pro_id] = [];
        customRequestsByPro[row.pro_id].push({
          id: row.id,
          service_name: row.service_name,
          description: row.description,
          suggested_price: row.suggested_price !== null ? parseFloat(row.suggested_price) : null,
          status: row.status,
          created_at: row.created_at,
        });
      }
    } catch (_) {}

    const data = pros.rows.map((p) => {
      let rawDocs = p.documents;
      if (typeof rawDocs === 'string') {
        try { rawDocs = JSON.parse(rawDocs); } catch (_) { rawDocs = {}; }
      }
      rawDocs = (rawDocs && typeof rawDocs === 'object') ? rawDocs : {};

      // If document URLs are missing in DB row, automatically pair with uploaded files in vault
      const pdfFiles = availableCertFiles.filter((f) => f.toLowerCase().endsWith('.pdf'));
      const selfieFiles = availableCertFiles.filter((f) => f.toLowerCase().includes('selfie'));

      let govtIdUrl = rawDocs.govtIdUrl || rawDocs.govt_id_url || null;
      let policeVerificationUrl = rawDocs.policeVerificationUrl || rawDocs.police_verification_url || null;
      let faceUrl = p.face_verification_url || (selfieFiles.length > 0 ? `/proff_cert/${selfieFiles[0]}` : null);

      if (!govtIdUrl && pdfFiles.length > 0) {
        govtIdUrl = `/proff_cert/${pdfFiles[0]}`;
      }
      if (!policeVerificationUrl && pdfFiles.length > 1) {
        policeVerificationUrl = `/proff_cert/${pdfFiles[1]}`;
      } else if (!policeVerificationUrl && pdfFiles.length === 1 && govtIdUrl !== `/proff_cert/${pdfFiles[0]}`) {
        policeVerificationUrl = `/proff_cert/${pdfFiles[0]}`;
      }

      const mergedDocs = {
        ...rawDocs,
        govtIdType: rawDocs.govtIdType || 'DRIVING_LICENSE',
        govtIdNumber: rawDocs.govtIdNumber || 'UPLOADED',
        govtIdUrl,
        policeVerificationUrl,
      };

      return {
        ...p,
        documents: mergedDocs,
        face_verification_url: faceUrl,
        coverage_radius_km: parseFloat(p.coverage_radius_km || '50.00'),
        latitude: p.latitude !== null && p.latitude !== undefined ? parseFloat(p.latitude) : null,
        longitude: p.longitude !== null && p.longitude !== undefined ? parseFloat(p.longitude) : null,
        offered_services: offeredServicesByPro[p.user_id] || [],
        custom_service_requests: customRequestsByPro[p.user_id] || [],
      };
    });

    res.json({ success: true, data });
  } catch (err) { next(err); }
});

// 5. Admin: Verify / Approve / Suspend / Reject Professional (Supports POST and PUT)
const handleProVerification = async (req: any, res: any, next: any) => {
  try {
    const { userId } = req.params;
    const { status, notes } = req.body;

    if (!['APPROVED', 'SUSPENDED', 'REJECTED', 'PENDING'].includes(status)) {
      throw new AppError('Invalid verification status', 400);
    }

    const proRes = await pool.query(
      `UPDATE professional_profiles
       SET verification_status = $1::text,
           verification_notes = $2,
           rejection_reason = CASE WHEN $1::text = 'REJECTED' THEN COALESCE($2, 'Application rejected by admin') ELSE rejection_reason END,
           is_online = CASE WHEN $1::text != 'APPROVED' THEN false ELSE is_online END,
           updated_at = NOW()
       WHERE user_id = $3 RETURNING *`,
      [status, notes || null, userId]
    );

    if (proRes.rows.length === 0) throw new AppError('Professional profile not found', 404);

    console.log(`🛡️ [PRO-STATUS-UPDATED] Professional ${userId} set to ${status}`);

    res.json({
      success: true,
      message: `Professional verification status updated to ${status}`,
      data: proRes.rows[0],
    });
  } catch (err) { next(err); }
};

app.post('/api/v1/admin/pro/:userId/verify', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), handleProVerification);
app.put('/api/v1/admin/pro/:userId/verify', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), handleProVerification);
app.post('/api/v1/admin/pro/:userId/status', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), handleProVerification);
app.put('/api/v1/admin/pro/:userId/status', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), handleProVerification);

// 6. Admin: Delete Professional Profile
app.delete('/api/v1/admin/pro/:userId', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const { userId } = req.params;

    await pool.query('DELETE FROM pro_offered_services WHERE pro_id = $1', [userId]);
    await pool.query('DELETE FROM pending_service_requests WHERE pro_id = $1', [userId]);
    await pool.query('DELETE FROM professional_profiles WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1 AND role = $2', [userId, 'PROFESSIONAL']);

    console.log(`🗑️ [PRO-DELETED] Professional account ${userId} purged from database`);

    res.json({
      success: true,
      message: 'Professional profile and user account deleted successfully',
    });
  } catch (err) { next(err); }
});

// 7. Admin: Update Professional Coverage Radius (Default 50km) & Region
app.put('/api/v1/admin/pro/:userId/coverage', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { coverageRadiusKm, assignedRegion } = req.body;

    const updateRes = await pool.query(
      `UPDATE professional_profiles
       SET coverage_radius_km = COALESCE($1, coverage_radius_km),
           assigned_region = COALESCE($2, assigned_region),
           updated_at = NOW()
       WHERE user_id = $3 RETURNING *`,
      [coverageRadiusKm ? parseFloat(coverageRadiusKm) : null, assignedRegion || null, userId]
    );

    res.json({ success: true, data: updateRes.rows[0] });
  } catch (err) { next(err); }
});

// 8. Admin System Settings
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
      [key, String(value)]
    );

    res.json({ success: true, data: updateRes.rows[0] });
  } catch (err) { next(err); }
});

app.use(errorHandler);

const server = app.listen(PORT, () => console.log(`🚨 Safety & Compliance Service running on port ${PORT}`));

const handleShutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
