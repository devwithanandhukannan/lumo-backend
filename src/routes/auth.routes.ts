import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { validateRequest } from '../middleware/validate.middleware';
import { authenticateToken } from '../middleware/auth.middleware';
import { z } from 'zod';

const router = Router();

const sendOtpSchema = z.object({
  phoneNumber: z.string().min(10, 'Phone number must include country code (e.g., +919876543210)'),
});

const verifyOtpSchema = z.object({
  phoneNumber: z.string().min(10),
  otp: z.string().length(6, 'OTP must be 6 digits'),
  role: z.enum(['CUSTOMER', 'PROFESSIONAL', 'ADMIN', 'SUPER_ADMIN']).optional(),
  fullName: z.string().optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
});

const oauthSchema = z.object({
  token: z.string().min(1, 'OAuth token is required'),
  role: z.enum(['CUSTOMER', 'PROFESSIONAL']).optional(),
  email: z.string().email().optional(),
  name: z.string().optional(),
});

const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

router.post('/otp/send', validateRequest(sendOtpSchema), (req, res, next) => authController.sendOTP(req, res, next));
router.post('/otp/verify', validateRequest(verifyOtpSchema), (req, res, next) => authController.verifyOTP(req, res, next));
router.post('/oauth/google', validateRequest(oauthSchema), (req, res, next) => authController.googleOAuth(req, res, next));
router.post('/oauth/apple', validateRequest(oauthSchema), (req, res, next) => authController.appleOAuth(req, res, next));
router.post('/token/refresh', validateRequest(refreshTokenSchema), (req, res, next) => authController.refreshToken(req, res, next));
router.post('/logout', authenticateToken, (req, res, next) => authController.logout(req, res, next));

export default router;
