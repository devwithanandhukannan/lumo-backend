import { Router } from 'express';
import { bookingController } from '../controllers/booking.controller';
import { authenticateToken, requireRoles } from '../middleware/auth.middleware';
import { validateRequest } from '../middleware/validate.middleware';
import { z } from 'zod';

const router = Router();

const createBookingSchema = z.object({
  serviceId: z.string().min(1, 'serviceId is required'),
  scheduledAt: z.string().optional(),
  addressText: z.string().min(3, 'addressText is required'),
  latitude: z.number(),
  longitude: z.number(),
  femaleProPreferred: z.boolean().optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(['NAVIGATING', 'ARRIVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
  otp: z.string().optional(),
});

// Public catalog routes
router.get('/catalog/categories', (req, res, next) => bookingController.getCategories(req, res, next));
router.get('/catalog/services', (req, res, next) => bookingController.getServices(req, res, next));

// Authenticated booking routes
router.post('/bookings', authenticateToken, requireRoles(['CUSTOMER']), validateRequest(createBookingSchema), (req, res, next) => bookingController.createBooking(req, res, next));
router.get('/bookings/my-bookings', authenticateToken, (req, res, next) => bookingController.getMyBookings(req, res, next));

// Provider job management routes
router.post('/pro/bookings/:bookingId/accept', authenticateToken, requireRoles(['PROFESSIONAL']), (req, res, next) => bookingController.acceptBooking(req, res, next));
router.post('/pro/bookings/:bookingId/status', authenticateToken, requireRoles(['PROFESSIONAL']), validateRequest(updateStatusSchema), (req, res, next) => bookingController.updateStatus(req, res, next));

export default router;
