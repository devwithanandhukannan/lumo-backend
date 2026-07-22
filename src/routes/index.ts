import { Router } from 'express';
import authRoutes from './auth.routes';
import userRoutes from './user.routes';
import professionalRoutes from './professional.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/pro', professionalRoutes);

export default router;
