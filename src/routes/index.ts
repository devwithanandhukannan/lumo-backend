import { Router } from 'express';
import authRoutes from './auth.routes';
import userRoutes from './user.routes';
import professionalRoutes from './professional.routes';
import bookingRoutes from './booking.routes';
import safetyRoutes from './safety.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/pro', professionalRoutes);
router.use('/', bookingRoutes);
router.use('/', safetyRoutes);

export default router;
