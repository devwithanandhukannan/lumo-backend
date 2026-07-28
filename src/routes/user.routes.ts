import { Router } from 'express';
import { userController } from '../controllers/user.controller';
import { authenticateToken } from '../middleware/auth.middleware';
import { validateRequest } from '../middleware/validate.middleware';
import { z } from 'zod';

const router = Router();

const updateProfileSchema = z.object({
  fullName: z.string().min(2).optional(),
  email: z.string().email().optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  avatarUrl: z.string().url().optional(),
});

const addLocationSchema = z.object({
  label: z.string().min(1, 'Location label is required (e.g. Home, Office)'),
  addressText: z.string().min(5, 'Address text is required'),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  isDefault: z.boolean().optional(),
});

router.use(authenticateToken);

router.get('/me', (req, res, next) => userController.getMe(req, res, next));
router.put('/me/profile', validateRequest(updateProfileSchema), (req, res, next) => userController.updateProfile(req, res, next));
router.get('/me/locations', (req, res, next) => userController.getSavedLocations(req, res, next));
router.post('/me/locations', validateRequest(addLocationSchema), (req, res, next) => userController.addSavedLocation(req, res, next));
router.delete('/me/locations/:id', (req, res, next) => userController.deleteSavedLocation(req, res, next));

// Update 10: Admin Customers management endpoint
router.get('/admin/customers', (req, res, next) => userController.getAllCustomers(req as any, res, next));

export default router;

