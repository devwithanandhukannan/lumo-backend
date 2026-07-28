import { Router } from 'express';
import { professionalController } from '../controllers/professional.controller';
import { authenticateToken, requireRoles } from '../middleware/auth.middleware';
import { validateRequest } from '../middleware/validate.middleware';
import { z } from 'zod';

const router = Router();

const documentSubmitSchema = z.object({
  govtIdType: z.enum(['AADAAR', 'PASSPORT', 'DRIVING_LICENSE', 'VOTER_ID']),
  govtIdNumber: z.string().min(4, 'Government ID number is required'),
  govtIdDocUrl: z.string().url('Valid document upload URL required'),
  policeVerificationPdfUrl: z.string().url('Police verification PDF URL required'),
  certifications: z.array(z.string()).optional(),
});

const faceVerifySchema = z.object({
  faceImageUrl: z.string().url('Valid face selfie image URL required'),
});

const dutyStatusSchema = z.object({
  isOnline: z.boolean(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

const submitQuizSchema = z.object({
  score: z.number().min(0).max(100),
});

// Require authenticated user with role PROFESSIONAL
router.use(authenticateToken);
router.use(requireRoles(['PROFESSIONAL', 'ADMIN', 'SUPER_ADMIN']));

router.post('/onboarding/documents', validateRequest(documentSubmitSchema), (req, res, next) =>
  professionalController.submitDocuments(req, res, next)
);

router.post('/onboarding/face-verification', validateRequest(faceVerifySchema), (req, res, next) =>
  professionalController.submitFaceVerification(req, res, next)
);

router.get('/onboarding/status', (req, res, next) => professionalController.getVerificationStatus(req, res, next));
router.get('/health', (req, res, next) => professionalController.getAccountHealth(req, res, next));
router.put('/duty-status', validateRequest(dutyStatusSchema), (req, res, next) =>
  professionalController.updateDutyStatus(req, res, next)
);
router.get('/training/modules', (req, res, next) => professionalController.getTrainingModules(req, res, next));
router.post('/training/modules/:id/complete', validateRequest(submitQuizSchema), (req, res, next) =>
  professionalController.submitTrainingQuiz(req, res, next)
);

// Offered Services Management
router.post('/offered-services', (req, res, next) => professionalController.saveOfferedServices(req as any, res, next));
router.get('/offered-services', (req, res, next) => professionalController.getOfferedServices(req as any, res, next));
router.post('/offered-services/update-price', (req, res, next) => professionalController.updateServicePrice(req as any, res, next));
router.post('/offered-services/toggle', (req, res, next) => professionalController.toggleServiceStatus(req as any, res, next));
router.post('/offered-services/delete', (req, res, next) => professionalController.deleteOfferedService(req as any, res, next));

export default router;

