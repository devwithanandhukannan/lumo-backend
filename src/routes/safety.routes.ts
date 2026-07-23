import { Router } from 'express';
import { safetyController } from '../controllers/safety.controller';
import { authenticateToken, requireRoles } from '../middleware/auth.middleware';
import { validateRequest } from '../middleware/validate.middleware';
import { z } from 'zod';

const router = Router();

const sosTriggerSchema = z.object({
  bookingId: z.string().optional(),
  latitude: z.number(),
  longitude: z.number(),
  notes: z.string().optional(),
});

const reportIncidentSchema = z.object({
  bookingId: z.string().min(1, 'bookingId is required'),
  againstUserId: z.string().min(1, 'againstUserId is required'),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  description: z.string().min(5, 'Detailed description is required'),
  proofUrls: z.array(z.string()).optional(),
});

const updateSettingSchema = z.object({
  value: z.string().min(1, 'Setting value is required'),
});

// SOS & Safety routes
router.post('/safety/sos/trigger', authenticateToken, validateRequest(sosTriggerSchema), (req, res, next) => safetyController.triggerSOS(req, res, next));
router.post('/safety/incidents', authenticateToken, validateRequest(reportIncidentSchema), (req, res, next) => safetyController.reportIncident(req, res, next));

// Admin Safety Control Center (SCC) routes
router.get('/admin/safety/sos', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), (req, res, next) => safetyController.getActiveSOSAlerts(req, res, next));
router.patch('/admin/safety/sos/:sosId/resolve', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), (req, res, next) => safetyController.resolveSOSAlert(req, res, next));

// Admin System Settings (Google Maps API Key management)
router.get('/admin/settings', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), (req, res, next) => safetyController.getSystemSettings(req, res, next));
router.put('/admin/settings/:key', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), validateRequest(updateSettingSchema), (req, res, next) => safetyController.updateSystemSetting(req, res, next));

export default router;
