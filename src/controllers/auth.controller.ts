import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

export class AuthController {
  async sendOTP(req: Request, res: Response, next: NextFunction) {
    try {
      const { phoneNumber } = req.body;
      const result = await authService.sendOTP(phoneNumber);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async verifyOTP(req: Request, res: Response, next: NextFunction) {
    try {
      const { phoneNumber, otp, role, fullName, gender } = req.body;
      const result = await authService.verifyOTP(phoneNumber, otp, role, fullName, gender);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async googleOAuth(req: Request, res: Response, next: NextFunction) {
    try {
      const { token, role, email, name } = req.body;
      const result = await authService.oauthLogin('google', token, role, email, name);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async appleOAuth(req: Request, res: Response, next: NextFunction) {
    try {
      const { token, role, email, name } = req.body;
      const result = await authService.oauthLogin('apple', token, role, email, name);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async refreshToken(req: Request, res: Response, next: NextFunction) {
    try {
      const { refreshToken } = req.body;
      const result = await authService.refreshToken(refreshToken);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async logout(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { refreshToken } = req.body;
      const result = await authService.logout(refreshToken);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
}

export const authController = new AuthController();
