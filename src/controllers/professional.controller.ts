import { Response, NextFunction } from 'express';
import { professionalService } from '../services/professional.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

export class ProfessionalController {
  async submitDocuments(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const { govtIdType, govtIdNumber, govtIdDocUrl, policeVerificationPdfUrl, certifications } = req.body;
      const result = await professionalService.submitDocuments(userId, {
        govtIdType,
        govtIdNumber,
        govtIdDocUrl,
        policeVerificationPdfUrl,
        certifications,
      });
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async submitFaceVerification(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const { faceImageUrl } = req.body;
      const result = await professionalService.submitFaceVerification(userId, faceImageUrl);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async getVerificationStatus(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const result = await professionalService.getVerificationStatus(userId);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async getAccountHealth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const result = await professionalService.getAccountHealth(userId);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async updateDutyStatus(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const { isOnline, latitude, longitude } = req.body;
      const result = await professionalService.updateDutyStatus(userId, { isOnline, latitude, longitude });
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async getTrainingModules(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const result = await professionalService.getTrainingModules(userId);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async submitTrainingQuiz(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const moduleId = req.params.id as string;
      const { score } = req.body;
      const result = await professionalService.submitTrainingQuiz(userId, moduleId, score);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async saveOfferedServices(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const { services } = req.body;
      const result = await professionalService.saveOfferedServices(userId, services);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async getOfferedServices(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const result = await professionalService.getOfferedServices(userId);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async updateServicePrice(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const { serviceId, customPrice, kmCharge } = req.body;
      const result = await professionalService.updateServicePrice(userId, serviceId, customPrice, kmCharge);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async toggleServiceStatus(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const { serviceId, isActive } = req.body;
      const result = await professionalService.toggleServiceStatus(userId, serviceId, isActive);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async deleteOfferedService(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const { serviceId } = req.body;
      const result = await professionalService.deleteOfferedService(userId, serviceId);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
}

export const professionalController = new ProfessionalController();

