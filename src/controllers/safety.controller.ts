import { Request, Response, NextFunction } from 'express';
import { safetyService } from '../services/safety.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

export class SafetyController {
  async triggerSOS(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const { bookingId, latitude, longitude, notes } = req.body;

      const alert = await safetyService.triggerSOS(
        userId,
        bookingId,
        parseFloat(latitude),
        parseFloat(longitude),
        notes
      );

      res.status(201).json({ success: true, data: alert });
    } catch (err) {
      next(err);
    }
  }

  async getActiveSOSAlerts(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const alerts = await safetyService.getActiveSOSAlerts();
      res.status(200).json({ success: true, data: alerts });
    } catch (err) {
      next(err);
    }
  }

  async resolveSOSAlert(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { sosId } = req.params;
      const { notes } = req.body;

      const alert = await safetyService.resolveSOSAlert(sosId, notes || 'Resolved by admin');
      res.status(200).json({ success: true, data: alert });
    } catch (err) {
      next(err);
    }
  }

  async reportIncident(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const reportedByUserId = req.user!.userId;
      const { bookingId, againstUserId, severity, description, proofUrls } = req.body;

      const incident = await safetyService.reportIncident(
        reportedByUserId,
        bookingId,
        againstUserId,
        severity,
        description,
        proofUrls
      );

      res.status(201).json({ success: true, data: incident });
    } catch (err) {
      next(err);
    }
  }

  async getSystemSettings(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const settings = await safetyService.getSystemSettings();
      res.status(200).json({ success: true, data: settings });
    } catch (err) {
      next(err);
    }
  }

  async updateSystemSetting(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { key } = req.params;
      const { value } = req.body;

      const setting = await safetyService.updateSystemSetting(key, value);
      res.status(200).json({ success: true, data: setting });
    } catch (err) {
      next(err);
    }
  }
}

export const safetyController = new SafetyController();
