import { Response, NextFunction } from 'express';
import { userService } from '../services/user.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

export class UserController {
  async getMe(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const result = await userService.getUserProfile(userId);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  async updateProfile(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const { fullName, email, gender, avatarUrl } = req.body;
      const updatedUser = await userService.updateProfile(userId, { fullName, email, gender, avatarUrl });
      res.status(200).json({ success: true, data: updatedUser });
    } catch (err) {
      next(err);
    }
  }

  async getSavedLocations(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const locations = await userService.getSavedLocations(userId);
      res.status(200).json({ success: true, data: locations });
    } catch (err) {
      next(err);
    }
  }

  async addSavedLocation(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const { label, addressText, latitude, longitude, isDefault } = req.body;
      const newLoc = await userService.addSavedLocation(userId, {
        label,
        addressText,
        latitude,
        longitude,
        isDefault,
      });
      res.status(201).json({ success: true, data: newLoc });
    } catch (err) {
      next(err);
    }
  }

  async deleteSavedLocation(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const locationId = req.params.id as string;
      const result = await userService.deleteSavedLocation(userId, locationId);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }
}

export const userController = new UserController();
