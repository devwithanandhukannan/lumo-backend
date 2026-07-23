import { randomUUID } from 'crypto';
import { pool } from '../db/pgDb';
import { AppError } from '../middleware/error.middleware';

export class BookingService {
  // 1. Fetch Categories
  async getCategories() {
    const res = await pool.query('SELECT * FROM service_categories WHERE is_active = true ORDER BY name ASC');
    return res.rows;
  }

  // 2. Fetch Services
  async getServices(categoryId?: string) {
    let query = 'SELECT s.*, c.name as category_name FROM services s JOIN service_categories c ON s.category_id = c.id WHERE s.is_active = true';
    const params: any[] = [];

    if (categoryId) {
      query += ' AND s.category_id = $1';
      params.push(categoryId);
    }

    query += ' ORDER BY s.name ASC';
    const res = await pool.query(query, params);
    return res.rows;
  }

  // 3. Create Booking Request
  async createBooking(
    customerId: string,
    serviceId: string,
    scheduledAt: string,
    addressText: string,
    latitude: number,
    longitude: number,
    femaleProPreferred: boolean = false
  ) {
    const serviceRes = await pool.query('SELECT * FROM services WHERE id = $1 AND is_active = true', [serviceId]);
    const service = serviceRes.rows[0];

    if (!service) {
      throw new AppError('Service not found or inactive', 404, 'SERVICE_NOT_FOUND');
    }

    const bookingId = `bk-${randomUUID().slice(0, 8)}`;
    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();
    const endOtp = Math.floor(1000 + Math.random() * 9000).toString();
    const totalAmount = parseFloat(service.base_price);

    const insertQuery = `
      INSERT INTO bookings (
        id, customer_id, service_id, status, scheduled_at, 
        address_text, latitude, longitude, female_pro_preferred, 
        start_otp, end_otp, total_amount
      )
      VALUES ($1, $2, $3, 'REQUESTED', $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `;

    const res = await pool.query(insertQuery, [
      bookingId,
      customerId,
      serviceId,
      scheduledAt || new Date().toISOString(),
      addressText,
      latitude,
      longitude,
      femaleProPreferred,
      startOtp,
      endOtp,
      totalAmount,
    ]);

    await pool.query(
      'INSERT INTO booking_state_logs (id, booking_id, status, notes) VALUES ($1, $2, $3, $4)',
      [`log-${randomUUID().slice(0, 8)}`, bookingId, 'REQUESTED', 'Booking request created by customer']
    );

    return res.rows[0];
  }

  // 4. Accept Booking (Provider)
  async acceptBooking(proUserId: string, bookingId: string) {
    const bookingRes = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    const booking = bookingRes.rows[0];

    if (!booking) {
      throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
    }

    if (booking.status !== 'REQUESTED') {
      throw new AppError(`Booking cannot be accepted. Current status: ${booking.status}`, 400, 'INVALID_BOOKING_STATE');
    }

    const updateRes = await pool.query(
      `UPDATE bookings 
       SET pro_id = $1, status = 'ACCEPTED', updated_at = NOW() 
       WHERE id = $2 
       RETURNING *`,
      [proUserId, bookingId]
    );

    await pool.query(
      'INSERT INTO booking_state_logs (id, booking_id, status, notes) VALUES ($1, $2, $3, $4)',
      [`log-${randomUUID().slice(0, 8)}`, bookingId, 'ACCEPTED', `Job accepted by provider ${proUserId}`]
    );

    return updateRes.rows[0];
  }

  // 5. Update Booking Status (Provider State Machine)
  async updateStatus(
    proUserId: string,
    bookingId: string,
    nextStatus: 'NAVIGATING' | 'ARRIVED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED',
    otpProvided?: string
  ) {
    const bookingRes = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    const booking = bookingRes.rows[0];

    if (!booking) {
      throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
    }

    if (booking.pro_id !== proUserId) {
      throw new AppError('You are not assigned to this booking', 403, 'FORBIDDEN');
    }

    // Verify OTP for IN_PROGRESS and COMPLETED transitions
    if (nextStatus === 'IN_PROGRESS') {
      if (!otpProvided || otpProvided !== booking.start_otp) {
        throw new AppError('Invalid Start Job OTP provided by customer', 400, 'INVALID_OTP');
      }
    } else if (nextStatus === 'COMPLETED') {
      if (!otpProvided || otpProvided !== booking.end_otp) {
        throw new AppError('Invalid Finish Job OTP provided by customer', 400, 'INVALID_OTP');
      }

      // Increment completed jobs count for provider
      await pool.query(
        'UPDATE professional_profiles SET total_jobs_completed = total_jobs_completed + 1 WHERE user_id = $1',
        [proUserId]
      );
    }

    const updateRes = await pool.query(
      'UPDATE bookings SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [nextStatus, bookingId]
    );

    await pool.query(
      'INSERT INTO booking_state_logs (id, booking_id, status, notes) VALUES ($1, $2, $3, $4)',
      [`log-${randomUUID().slice(0, 8)}`, bookingId, nextStatus, `State updated to ${nextStatus}`]
    );

    return updateRes.rows[0];
  }

  // 6. Get User Bookings
  async getUserBookings(userId: string, role: string) {
    const column = role === 'PROFESSIONAL' ? 'pro_id' : 'customer_id';
    const query = `
      SELECT b.*, s.name as service_name, u.full_name as counterparty_name, u.phone_number as counterparty_phone
      FROM bookings b
      JOIN services s ON b.service_id = s.id
      LEFT JOIN users u ON u.id = (CASE WHEN $2 = 'PROFESSIONAL' THEN b.customer_id ELSE b.pro_id END)
      WHERE b.${column} = $1
      ORDER BY b.created_at DESC
    `;
    const res = await pool.query(query, [userId, role]);
    return res.rows;
  }
}

export const bookingService = new BookingService();
