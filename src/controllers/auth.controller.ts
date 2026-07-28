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

  async firebaseLogin(req: Request, res: Response, next: NextFunction) {
    try {
      const { idToken, role, fullName, gender } = req.body;
      const result = await authService.firebaseLogin(idToken, role, fullName, gender);
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

  // NEW: Complete customer profile after OTP
  async completeCustomerProfile(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { fullName, age, sex, email } = req.body;
      const userId = req.user!.userId;
      const result = await authService.completeCustomerProfile(userId, fullName, parseInt(age), sex, email);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  // NEW: Register professional with phone OTP
  async registerProWithPhone(req: Request, res: Response, next: NextFunction) {
    try {
      const { phoneNumber, fullName, age, email, gender, serviceArea, latitude, longitude } = req.body;
      const result = await authService.registerProWithPhone(
        phoneNumber, fullName, parseInt(age), email, gender, serviceArea,
        latitude ? parseFloat(latitude) : undefined,
        longitude ? parseFloat(longitude) : undefined
      );
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  // Update 2: Check if phone is already registered
  async checkPhone(req: Request, res: Response, next: NextFunction) {
    try {
      const phone = req.query.phone as string;
      if (!phone) {
        res.status(400).json({ success: false, message: 'phone query param is required' });
        return;
      }
      const result = await authService.checkPhoneExists(phone);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
}

export const authController = new AuthController();
