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

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Safety Control Center Service' }));

// 1. Trigger Emergency SOS
app.post('/api/v1/safety/sos/trigger', authenticateToken, async (req: AuthenticatedRequest, res, next) => {
  try {
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
    const pros = await pool.query(
      `SELECT u.id as user_id, u.full_name, u.email, u.phone_number, u.gender, u.email_verified, u.phone_verified,
              p.id as profile_id, p.verification_status, p.documents, p.face_verification_url, p.face_verified,
              p.coverage_radius_km, p.assigned_region, p.is_online, p.rating_avg, p.created_at
       FROM users u
       JOIN professional_profiles p ON u.id = p.user_id
       WHERE u.role = 'PROFESSIONAL'
       ORDER BY CASE WHEN p.verification_status = 'PENDING' THEN 1 ELSE 2 END, p.created_at DESC`
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
      [key, value]
    );

    res.json({ success: true, data: updateRes.rows[0] });
  } catch (err) { next(err); }
});

// 5a. Admin: Delete Professional Account Permanently
app.delete('/api/v1/admin/pro/:userId', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const { userId } = req.params;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM professional_profiles WHERE user_id = $1', [userId]);
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
      await client.query('COMMIT');
      console.log(`🗑️ [ADMIN-DELETE-PRO] Permanently deleted professional user ${userId}`);
      res.json({ success: true, message: `Professional account ${userId} permanently deleted` });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

// 5b. Admin: Fetch Pending Location Change Requests
app.get('/api/v1/admin/pro/location-requests', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const requests = await pool.query(
      `SELECT r.*, u.full_name as pro_name, u.phone_number as pro_phone, u.email as pro_email
       FROM pro_location_change_requests r
       JOIN users u ON r.pro_id = u.id
       ORDER BY CASE WHEN r.status = 'PENDING_ADMIN_APPROVAL' THEN 1 ELSE 2 END, r.created_at DESC`
    );
    res.json({ success: true, data: requests.rows });
  } catch (err) { next(err); }
});

// 5c. Admin: Approve Location Change Request
app.post('/api/v1/admin/pro/location-requests/:requestId/approve', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const { requestId } = req.params;
    const reqRes = await pool.query('SELECT * FROM pro_location_change_requests WHERE id = $1', [requestId]);
    const reqItem = reqRes.rows[0];

    if (!reqItem) throw new AppError('Location change request not found', 404);

    await pool.query(
      `UPDATE pro_location_change_requests SET status = 'APPROVED', updated_at = NOW() WHERE id = $1`,
      [requestId]
    );

    await pool.query(
      `UPDATE professional_profiles
       SET service_area = $1, assigned_region = $1, requested_location = NULL, location_change_status = 'APPROVED', updated_at = NOW()
       WHERE user_id = $2`,
      [reqItem.requested_location, reqItem.pro_id]
    );

    await pool.query('UPDATE users SET service_area = $1 WHERE id = $2', [reqItem.requested_location, reqItem.pro_id]);

    console.log(`✅ [ADMIN-LOCATION-APPROVED] Approved location change for pro ${reqItem.pro_id} to "${reqItem.requested_location}"`);

    res.json({ success: true, message: `Location updated to ${reqItem.requested_location}` });
  } catch (err) { next(err); }
});

// 5d. Admin: Reject Location Change Request
app.post('/api/v1/admin/pro/location-requests/:requestId/reject', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const { requestId } = req.params;
    const { reason } = req.body;

    const reqRes = await pool.query('SELECT * FROM pro_location_change_requests WHERE id = $1', [requestId]);
    const reqItem = reqRes.rows[0];

    if (!reqItem) throw new AppError('Location change request not found', 404);

    await pool.query(
      `UPDATE pro_location_change_requests SET status = 'REJECTED', admin_reason = $1, updated_at = NOW() WHERE id = $2`,
      [reason || 'Location change rejected by admin', requestId]
    );

    await pool.query(
      `UPDATE professional_profiles
       SET requested_location = NULL, location_change_status = 'REJECTED', location_change_reason = $1, updated_at = NOW()
       WHERE user_id = $2`,
      [reason || 'Location change rejected by admin', reqItem.pro_id]
    );

    res.json({ success: true, message: 'Location change request rejected' });
  } catch (err) { next(err); }
});

// 5e. Admin: List All Custom Service Requests
app.get('/api/v1/admin/pro/service-requests', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const requests = await pool.query(
      `SELECT r.*, u.full_name as pro_name, u.email as pro_email, u.phone_number as pro_phone
       FROM pending_service_requests r
       JOIN users u ON r.pro_id = u.id
       ORDER BY CASE WHEN r.status = 'PENDING_ADMIN_APPROVAL' THEN 1 ELSE 2 END, r.created_at DESC`
    );
    res.json({ success: true, data: requests.rows });
  } catch (err) { next(err); }
});

// 5f. Admin: Approve Custom Service Request
app.post('/api/v1/admin/pro/service-requests/:requestId/approve', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const { requestId } = req.params;
    const reqRes = await pool.query('SELECT * FROM pending_service_requests WHERE id = $1', [requestId]);
    const reqItem = reqRes.rows[0];
    if (!reqItem) throw new AppError('Service request not found', 404);

    // 1. Ensure default category exists
    let catRes = await pool.query('SELECT id FROM service_categories LIMIT 1');
    let categoryId = catRes.rows[0]?.id;
    if (!categoryId) {
      categoryId = 'cat-custom-general';
      await pool.query(
        `INSERT INTO service_categories (id, name, description)
         VALUES ($1, 'Custom Services', 'Partner custom created services')
         ON CONFLICT (id) DO NOTHING`,
        [categoryId]
      );
    }

    // 2. Create service in catalog
    const serviceId = `srv-${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO services (id, category_id, name, description, base_price)
       VALUES ($1, $2, $3, $4, $5)`,
      [serviceId, categoryId, reqItem.service_name, reqItem.description || '', reqItem.suggested_price || 499.00]
    );

    // 3. Link service to professional with custom price
    await pool.query(
      `INSERT INTO pro_offered_services (id, pro_id, service_id, custom_price, is_active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (pro_id, service_id) DO UPDATE SET custom_price = $4, is_active = true`,
      [`pos-${randomUUID().slice(0, 8)}`, reqItem.pro_id, serviceId, reqItem.suggested_price || 499.00]
    );

    // 4. Update request status to APPROVED
    await pool.query(
      `UPDATE pending_service_requests SET status = 'APPROVED', updated_at = NOW() WHERE id = $1`,
      [requestId]
    );

    console.log(`✅ [ADMIN-CUSTOM-SERVICE-APPROVED] Approved custom service "${reqItem.service_name}" for pro ${reqItem.pro_id}`);

    res.json({ success: true, message: `Custom service "${reqItem.service_name}" approved and published to catalog!` });
  } catch (err) { next(err); }
});

// 5g. Admin: Reject Custom Service Request
app.post('/api/v1/admin/pro/service-requests/:requestId/reject', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), async (req, res, next) => {
  try {
    const { requestId } = req.params;
    const { reason } = req.body;

    const reqRes = await pool.query('SELECT * FROM pending_service_requests WHERE id = $1', [requestId]);
    const reqItem = reqRes.rows[0];
    if (!reqItem) throw new AppError('Service request not found', 404);

    await pool.query(
      `UPDATE pending_service_requests SET status = 'REJECTED', admin_notes = $1, updated_at = NOW() WHERE id = $2`,
      [reason || 'Service request rejected by admin', requestId]
    );

    res.json({ success: true, message: 'Custom service request rejected' });
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
