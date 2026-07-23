import { Request, Response, NextFunction } from 'express';
import { bookingService } from '../services/booking.service';
import { AuthenticatedRequest } from '../middleware/auth.middleware';

export class BookingController {
  async getCategories(req: Request, res: Response, next: NextFunction) {
    try {
      const categories = await bookingService.getCategories();
      res.status(200).json({ success: true, data: categories });
    } catch (err) {
      next(err);
    }
  }

  async getServices(req: Request, res: Response, next: NextFunction) {
    try {
      const categoryId = req.query.categoryId as string | undefined;
      const services = await bookingService.getServices(categoryId);
      res.status(200).json({ success: true, data: services });
    } catch (err) {
      next(err);
    }
  }

  async createBooking(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const customerId = req.user!.userId;
      const { serviceId, scheduledAt, addressText, latitude, longitude, femaleProPreferred } = req.body;

      const booking = await bookingService.createBooking(
        customerId,
        serviceId,
        scheduledAt,
        addressText,
        parseFloat(latitude),
        parseFloat(longitude),
        Boolean(femaleProPreferred)
      );

      res.status(201).json({ success: true, data: booking });
    } catch (err) {
      next(err);
    }
  }

  async acceptBooking(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const proUserId = req.user!.userId;
      const { bookingId } = req.params;

      const booking = await bookingService.acceptBooking(proUserId, bookingId);
      res.status(200).json({ success: true, data: booking });
    } catch (err) {
      next(err);
    }
  }

  async updateStatus(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const proUserId = req.user!.userId;
      const { bookingId } = req.params;
      const { status, otp } = req.body;

      const booking = await bookingService.updateStatus(proUserId, bookingId, status, otp);
      res.status(200).json({ success: true, data: booking });
    } catch (err) {
      next(err);
    }
  }

  async getMyBookings(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.userId;
      const role = req.user!.role;

      const bookings = await bookingService.getUserBookings(userId, role);
      res.status(200).json({ success: true, data: bookings });
    } catch (err) {
      next(err);
    }
  }
}

export const bookingController = new BookingController();
