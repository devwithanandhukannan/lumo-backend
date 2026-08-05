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
      const latitude = req.query.latitude ? parseFloat(req.query.latitude as string) : undefined;
      const longitude = req.query.longitude ? parseFloat(req.query.longitude as string) : undefined;
      const services = await bookingService.getServices(categoryId, latitude, longitude);
      res.status(200).json({ success: true, data: services });
    } catch (err) {
      next(err);
    }
  }

  // Update 3: List available professionals for a service
  async getProsForService(req: Request, res: Response, next: NextFunction) {
    try {
      const { serviceId } = req.params;
      const lat = parseFloat(req.query.lat as string);
      const lng = parseFloat(req.query.lng as string);
      const femaleOnly = req.query.femaleOnly === 'true';
      const sortBy = (req.query.sortBy as 'distance' | 'rating' | 'price') || 'distance';
      if (isNaN(lat) || isNaN(lng)) {
        res.status(400).json({ success: false, message: 'lat and lng query params are required' });
        return;
      }
      const pros = await bookingService.getProsForService(serviceId, lat, lng, femaleOnly, sortBy);
      res.status(200).json({ success: true, data: pros });
    } catch (err) {
      next(err);
    }
  }

  // Update 1: Pre-booking charge estimate
  async getBookingEstimate(req: Request, res: Response, next: NextFunction) {
    try {
      const serviceId = req.query.serviceId as string;
      const proId = req.query.proId as string;
      const lat = parseFloat(req.query.lat as string);
      const lng = parseFloat(req.query.lng as string);
      if (!serviceId || !proId || isNaN(lat) || isNaN(lng)) {
        res.status(400).json({ success: false, message: 'serviceId, proId, lat, lng are required' });
        return;
      }
      const estimate = await bookingService.getBookingEstimate(serviceId, proId, lat, lng);
      res.status(200).json({ success: true, data: estimate });
    } catch (err) {
      next(err);
    }
  }

  async createBooking(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const customerId = req.user!.userId;
      const { serviceId, scheduledAt, addressText, latitude, longitude, femaleProPreferred, selectedProId } = req.body;

      // Mandatory Server-Side Pre-Flight Check against geo-service
      try {
        const geoCheckRes = await fetch('http://localhost:8000/api/v1/geo/check-suspension', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            latitude: parseFloat(latitude),
            longitude: parseFloat(longitude),
            locationName: addressText,
          }),
        });
        if (geoCheckRes.ok) {
          const geoData = await geoCheckRes.json();
          if (geoData.isSuspended && (geoData.suspension?.severity === 'FULL_BLACKOUT' || !geoData.suspension?.severity)) {
            res.status(403).json({
              success: false,
              message: geoData.suspension?.message || 'Emergency Service Blackout is active in your region.',
              suspension: geoData.suspension,
            });
            return;
          }
        }
      } catch (geoErr) {
        console.warn('⚠️ Geo service pre-flight check warning:', geoErr);
      }

      const booking = await bookingService.createBooking(
        customerId,
        serviceId,
        scheduledAt,
        addressText,
        parseFloat(latitude),
        parseFloat(longitude),
        Boolean(femaleProPreferred),
        selectedProId
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
