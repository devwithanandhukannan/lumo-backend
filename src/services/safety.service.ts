import { randomUUID } from 'crypto';
import { pool } from '../db/pgDb';
import { AppError } from '../middleware/error.middleware';

export class SafetyService {
  // 1. Trigger Instant SOS Emergency
  async triggerSOS(userId: string, bookingId: string | undefined, latitude: number, longitude: number, notes?: string) {
    const sosId = `sos-${randomUUID().slice(0, 8)}`;

    const res = await pool.query(
      `INSERT INTO sos_alerts (id, booking_id, triggered_by_user_id, trigger_latitude, trigger_longitude, status, notes)
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6)
       RETURNING *`,
      [sosId, bookingId || null, userId, latitude, longitude, notes || 'Emergency SOS Button Pressed']
    );

    console.log(`🚨 [SAFETY-CONTROL-CENTER] EMERGENCY SOS TRIGGERED by user ${userId} at GPS (${latitude}, ${longitude})`);

    return res.rows[0];
  }

  // 2. Fetch Active SOS Alerts for Admin Dashboard
  async getActiveSOSAlerts() {
    const res = await pool.query(`
      SELECT s.*, u.full_name as user_name, u.phone_number as user_phone, u.role as user_role
      FROM sos_alerts s
      JOIN users u ON s.triggered_by_user_id = u.id
      ORDER BY s.created_at DESC
    `);
    return res.rows;
  }

  // 3. Resolve SOS Alert (Admin)
  async resolveSOSAlert(sosId: string, resolutionNotes: string) {
    const res = await pool.query(
      `UPDATE sos_alerts 
       SET status = 'RESOLVED', notes = COALESCE(notes, '') || ' | Resolution: ' || $1, resolved_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [resolutionNotes, sosId]
    );

    if (res.rowCount === 0) {
      throw new AppError('SOS Alert record not found', 404, 'NOT_FOUND');
    }

    return res.rows[0];
  }

  // 4. Report Misconduct Incident
  async reportIncident(
    reportedByUserId: string,
    bookingId: string,
    againstUserId: string,
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
    description: string,
    proofUrls: string[] = []
  ) {
    const incidentId = `inc-${randomUUID().slice(0, 8)}`;

    const res = await pool.query(
      `INSERT INTO misconduct_incidents (id, booking_id, reported_by_user_id, against_user_id, severity, description, proof_urls, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'PENDING_REVIEW')
       RETURNING *`,
      [incidentId, bookingId, reportedByUserId, againstUserId, severity, description, JSON.stringify(proofUrls)]
    );

    // If critical severity, reduce account health score or suspend provider
    if (severity === 'CRITICAL') {
      await pool.query(
        `UPDATE professional_profiles 
         SET account_health_score = GREATEST(0.0, account_health_score - 30.0),
             verification_status = 'SUSPENDED'
         WHERE user_id = $1`,
        [againstUserId]
      );
    }

    return res.rows[0];
  }

  // 5. Get System Settings (Admin API Keys)
  async getSystemSettings() {
    const res = await pool.query('SELECT setting_key, setting_value, description, updated_at FROM system_settings');
    return res.rows;
  }

  // 6. Update System Setting Key (Admin)
  async updateSystemSetting(key: string, value: string) {
    const res = await pool.query(
      `INSERT INTO system_settings (setting_key, setting_value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()
       RETURNING *`,
      [key, value]
    );
    return res.rows[0];
  }
}

export const safetyService = new SafetyService();
