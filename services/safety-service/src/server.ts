import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from '@lumo/database';
import { authenticateToken, requireRoles, AuthenticatedRequest, AppError, errorHandler } from '@lumo/common';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5007;

app.use(cors());
app.use(express.json());

async function ensureSafetySchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sos_alerts (
          id VARCHAR(50) PRIMARY KEY,
          booking_id VARCHAR(50),
          triggered_by_user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          trigger_latitude NUMERIC(10,8),
          trigger_longitude NUMERIC(11,8),
          status VARCHAR(20) DEFAULT 'ACTIVE',
          notes TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          resolved_at TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS system_settings (
          setting_key VARCHAR(100) PRIMARY KEY,
          setting_value TEXT NOT NULL,
          description TEXT,
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      INSERT INTO system_settings (setting_key, setting_value, description) VALUES
      ('SOS_AUTO_DISPATCH_EMERGENCY', 'true', 'Auto dispatch emergency contacts on SOS trigger'),
      ('DEFAULT_COVERAGE_RADIUS_KM', '50', 'Default operational coverage radius for professionals in km'),
      ('PRO_VERIFICATION_REQUIRE_POLICE_PDF', 'true', 'Require mandatory police background clearance PDF upload'),
      ('PLATFORM_COMMISSION_PERCENTAGE', '10', 'Platform commission percentage per completed booking')
      ON CONFLICT (setting_key) DO NOTHING;
    `);
  } catch (err: any) {
    console.warn('⚠️ Safety schema warning:', err.message);
  }
}

ensureSafetySchema();

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Safety Control Center Service' }));

// 1. Trigger Emergency SOS
app.post('/api/v1/safety/sos/trigger', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
    await ensureSafetySchema();
    const userId = req.user!.userId;
    const { bookingId, latitude, longitude, notes } = req.body;
    const sosId = `sos-${randomUUID().slice(0, 8)}`;

    const insertRes = await pool.query(
      `INSERT INTO sos_alerts (id, booking_id, triggered_by_user_id, trigger_latitude, trigger_longitude, status, notes)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6) RETURNING *`,
      [sosId, bookingId || null, userId, latitude, longitude, notes || 'Emergency SOS Pressed']
    );

    console.log(`🚨 [SAFETY SCC] EMERGENCY SOS TRIGGERED by user ${userId}`);
    res.status(201).json({ success: true, data: insertRes.rows[0] });
  } catch (err) { next(err); }
});

// 2. Fetch Active SOS Alerts for Admin
app.get('/api/v1/admin/safety/sos', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    await ensureSafetySchema();
    const alerts = await pool.query(
      `SELECT s.*, u.full_name as user_name, u.phone_number as user_phone, u.role as user_role
       FROM sos_alerts s
       JOIN users u ON s.triggered_by_user_id = u.id
       ORDER BY CASE WHEN s.status = 'ACTIVE' THEN 1 ELSE 2 END, s.created_at DESC`
    );
    res.json({ success: true, data: alerts.rows });
  } catch (err) { next(err); }
});

// 3. Mark SOS Alert as RESOLVED (Admin)
app.patch('/api/v1/admin/safety/sos/:sosId/resolve', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const { sosId } = req.params;
    const updateRes = await pool.query(
      `UPDATE sos_alerts SET status = 'RESOLVED', resolved_at = NOW() WHERE id = $1 RETURNING *`,
      [sosId]
    );

    if (updateRes.rows.length === 0) throw new AppError('SOS Alert not found', 404);

    console.log(`✅ [SAFETY SCC] Emergency SOS Alert ${sosId} resolved by admin`);
    res.json({ success: true, data: updateRes.rows[0] });
  } catch (err) { next(err); }
});

app.post('/api/v1/admin/safety/sos/:sosId/resolve', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const { sosId } = req.params;
    const updateRes = await pool.query(
      `UPDATE sos_alerts SET status = 'RESOLVED', resolved_at = NOW() WHERE id = $1 RETURNING *`,
      [sosId]
    );

    if (updateRes.rows.length === 0) throw new AppError('SOS Alert not found', 404);

    console.log(`✅ [SAFETY SCC] Emergency SOS Alert ${sosId} resolved by admin`);
    res.json({ success: true, data: updateRes.rows[0] });
  } catch (err) { next(err); }
});

// 4. Admin: Fetch All Professionals & Document Verification Applications
app.get('/api/v1/admin/pro/verifications', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    await ensureSafetySchema();
    const pros = await pool.query(
      `SELECT u.id as user_id, u.full_name, u.email, u.phone_number, u.gender, u.email_verified, u.phone_verified,
              COALESCE(p.id, CONCAT('pro-', u.id)) as profile_id,
              COALESCE(p.verification_status, 'PENDING') as verification_status,
              COALESCE(p.documents, '{}'::jsonb) as documents,
              COALESCE(p.face_verification_url, u.avatar_url) as face_verification_url,
              p.face_verified,
              COALESCE(p.coverage_radius_km, 50.00) as coverage_radius_km,
              COALESCE(p.service_area, p.assigned_region, 'Kochi, Kerala') as service_area,
              COALESCE(p.assigned_region, p.service_area, 'Kochi, Kerala') as assigned_region,
              COALESCE(p.is_online, false) as is_online,
              COALESCE(p.rating_avg, 5.0) as rating_avg,
              u.created_at
       FROM users u
       LEFT JOIN professional_profiles p ON u.id = p.user_id
       WHERE u.role = 'PROFESSIONAL'
       ORDER BY CASE WHEN COALESCE(p.verification_status, 'PENDING') = 'PENDING' THEN 1 ELSE 2 END, u.created_at DESC`
    );

    res.json({ success: true, data: pros.rows });
  } catch (err) { next(err); }
});

// 5. Admin: Verify / Approve / Suspend / Reject Professional
app.post('/api/v1/admin/pro/:userId/verify', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { status, notes } = req.body;

    if (!['APPROVED', 'SUSPENDED', 'REJECTED', 'PENDING'].includes(status)) {
      throw new AppError('Invalid verification status', 400);
    }

    const proRes = await pool.query(
      `UPDATE professional_profiles
       SET verification_status = $1,
           verification_notes = $2,
           is_online = CASE WHEN $1 != 'APPROVED' THEN false ELSE is_online END,
           updated_at = NOW()
       WHERE user_id = $3 RETURNING *`,
      [status, notes || null, userId]
    );

    if (proRes.rows.length === 0) throw new AppError('Professional profile not found', 404);

    res.json({
      success: true,
      message: `Professional status updated to ${status}`,
      data: proRes.rows[0],
    });
  } catch (err) { next(err); }
});

// 6. Admin: Update Professional Coverage Radius (Default 50km) & Region
app.put('/api/v1/admin/pro/:userId/coverage', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { coverageRadiusKm, assignedRegion } = req.body;

    const updateRes = await pool.query(
      `UPDATE professional_profiles
       SET coverage_radius_km = COALESCE($1, coverage_radius_km),
           assigned_region = COALESCE($2, assigned_region),
           service_area = COALESCE($2, service_area),
           updated_at = NOW()
       WHERE user_id = $3 RETURNING *`,
      [coverageRadiusKm ? parseFloat(coverageRadiusKm) : null, assignedRegion || null, userId]
    );

    res.json({ success: true, data: updateRes.rows[0] });
  } catch (err) { next(err); }
});

// 7. Admin System Settings
app.get('/api/v1/admin/settings', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    await ensureSafetySchema();
    const settings = await pool.query('SELECT setting_key, setting_value, description, updated_at FROM system_settings');
    res.json({ success: true, data: settings.rows });
  } catch (err) { next(err); }
});

app.put('/api/v1/admin/settings/:settingKey', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const { settingKey } = req.params;
    const { value, description } = req.body;

    const updateRes = await pool.query(
      `INSERT INTO system_settings (setting_key, setting_value, description, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, description = COALESCE($3, system_settings.description), updated_at = NOW()
       RETURNING *`,
      [settingKey, value, description || null]
    );

    res.json({ success: true, data: updateRes.rows[0] });
  } catch (err) { next(err); }
});

app.use(errorHandler);

app.listen(PORT, () => console.log(`🚨 Safety Service running on port ${PORT}`));
