import { randomUUID } from 'crypto';
import { pool } from '../db/pgDb';
import { AppError } from '../middleware/error.middleware';

// Haversine formula: returns distance in km
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export class BookingService {
  // 1. Fetch Categories
  async getCategories() {
    const res = await pool.query('SELECT * FROM service_categories WHERE is_active = true ORDER BY name ASC');
    return res.rows;
  }

  // 2. Fetch Services (with optional location-based availability check)
  async getServices(categoryId?: string, latitude?: number, longitude?: number) {
    let query = 'SELECT s.*, c.name as category_name FROM services s JOIN service_categories c ON s.category_id = c.id WHERE s.is_active = true';
    const params: any[] = [];

    if (categoryId) {
      query += ' AND s.category_id = $1';
      params.push(categoryId);
    }

    query += ' ORDER BY s.name ASC';
    const res = await pool.query(query, params);
    const services = res.rows;

    // If location given, count available pros per service
    if (latitude !== undefined && longitude !== undefined) {
      return await Promise.all(
        services.map(async (svc) => {
          const count = await this._countAvailablePros(svc.id, latitude, longitude);
          return { ...svc, available_pros_count: count, is_available: count > 0 };
        })
      );
    }

    return services;
  }

  // 3. List Professionals available for a specific service in customer range
  async getProsForService(
    serviceId: string,
    customerLat: number,
    customerLng: number,
    femaleOnly: boolean = false,
    sortBy: 'distance' | 'rating' | 'price' = 'distance'
  ) {
    const query = `
      SELECT u.id, u.full_name, u.gender, u.avatar_url,
             pp.latitude, pp.longitude, pp.rating_avg,
             pp.total_jobs_completed, pp.coverage_radius_km,
             pp.verification_status, pp.face_verified, pp.face_verification_url,
             COALESCE(pos.km_charge_per_km, pos.per_km_rate, 15.00) as km_charge_per_km,
             COALESCE(pos.custom_price, 200.00) as service_price
      FROM users u
      JOIN professional_profiles pp ON pp.user_id = u.id
      LEFT JOIN pro_offered_services pos ON (pos.pro_id = u.id AND pos.service_id = $1 AND pos.is_active = true)
      WHERE u.role = 'PROFESSIONAL'
        AND pp.verification_status IN ('APPROVED', 'PENDING')
        AND pp.is_blacklisted = false
        ${femaleOnly ? "AND u.gender = 'FEMALE'" : ''}
    `;

    const res = await pool.query(query, [serviceId]);
    const pros = res.rows;

    let nearbyPros = pros
      .map((p) => {
        let pLat = (p.latitude && !isNaN(parseFloat(p.latitude))) ? parseFloat(p.latitude) : NaN;
        let pLng = (p.longitude && !isNaN(parseFloat(p.longitude))) ? parseFloat(p.longitude) : NaN;

        if (isNaN(pLat) || isNaN(pLng)) {
          let curLoc = p.current_location;
          if (typeof curLoc === 'string') {
            try { curLoc = JSON.parse(curLoc); } catch (_) {}
          }
          if (curLoc && typeof curLoc === 'object') {
            pLat = parseFloat(curLoc.latitude || curLoc.lat || 'NaN');
            pLng = parseFloat(curLoc.longitude || curLoc.lng || 'NaN');
          }
        }

        if (isNaN(pLat) || isNaN(pLng) || (pLat === 0 && pLng === 0)) {
          pLat = 9.9312;
          pLng = 76.2673;
        }

        const distKm = haversineKm(customerLat, customerLng, pLat, pLng);
        const kmCharge = parseFloat(p.km_charge_per_km) || 15;
        const basePrice = parseFloat(p.service_price) || 0;
        const travelCharge = parseFloat((distKm * kmCharge).toFixed(2));
        const estimatedTotal = parseFloat((basePrice + travelCharge).toFixed(2));
        return {
          proId: p.id,
          name: p.full_name,
          gender: p.gender,
          avatarUrl: p.avatar_url || p.face_verification_url,
          isVerified: p.verification_status === 'APPROVED' || p.face_verified === true,
          verificationStatus: p.verification_status || 'APPROVED',
          ratingAvg: parseFloat(p.rating_avg) || 5.0,
          totalJobsCompleted: p.total_jobs_completed || 0,
          distanceKm: parseFloat(distKm.toFixed(2)),
          kmCharge,
          serviceBasePrice: basePrice,
          travelCharge,
          estimatedTotal,
          coverageRadiusKm: parseFloat(p.coverage_radius_km) || 50,
        };
      });

    const inRangePros = nearbyPros.filter((p) => p.distanceKm <= p.coverageRadiusKm);
    if (inRangePros.length > 0) {
      nearbyPros = inRangePros;
    }

    if (sortBy === 'rating') {
      nearbyPros.sort((a, b) => b.ratingAvg - a.ratingAvg);
    } else if (sortBy === 'price') {
      nearbyPros.sort((a, b) => a.estimatedTotal - b.estimatedTotal);
    } else {
      nearbyPros.sort((a, b) => a.distanceKm - b.distanceKm);
    }

    return nearbyPros;
  }

  // 4. Distance + charge estimate (before booking)
  async getBookingEstimate(
    serviceId: string,
    proId: string,
    customerLat: number,
    customerLng: number
  ) {
    const proRes = await pool.query(
      'SELECT latitude, longitude FROM professional_profiles WHERE user_id = $1',
      [proId]
    );
    const pro = proRes.rows[0];
    if (!pro || !pro.latitude) {
      return { distanceKm: 0, travelCharge: 0, basePrice: 0, total: 0, kmCharge: 15 };
    }

    const posRes = await pool.query(
      'SELECT custom_price, km_charge_per_km FROM pro_offered_services WHERE pro_id = $1 AND service_id = $2',
      [proId, serviceId]
    );
    const pos = posRes.rows[0];
    const svcRes = await pool.query('SELECT base_price FROM services WHERE id = $1', [serviceId]);
    const svc = svcRes.rows[0];

    const basePrice = parseFloat(pos?.custom_price || svc?.base_price || '0');
    const kmCharge = parseFloat(pos?.km_charge_per_km || '15');
    const distanceKm = parseFloat(haversineKm(customerLat, customerLng, pro.latitude, pro.longitude).toFixed(2));
    const travelCharge = parseFloat((distanceKm * kmCharge).toFixed(2));

    return {
      distanceKm,
      kmCharge,
      basePrice,
      travelCharge,
      total: parseFloat((basePrice + travelCharge).toFixed(2)),
    };
  }

  // 5. Create Booking Request
  async createBooking(
    customerId: string,
    serviceId: string,
    scheduledAt: string,
    addressText: string,
    latitude: number,
    longitude: number,
    femaleProPreferred: boolean = false,
    selectedProId?: string
  ) {
    const serviceRes = await pool.query('SELECT * FROM services WHERE id = $1 AND is_active = true', [serviceId]);
    const service = serviceRes.rows[0];
    if (!service) {
      throw new AppError('Service not found or inactive', 404, 'SERVICE_NOT_FOUND');
    }

    // Update 6: Gate booking on pro availability
    const availableCount = await this._countAvailablePros(serviceId, latitude, longitude, femaleProPreferred ? 'FEMALE' : undefined);
    if (availableCount === 0) {
      throw new AppError(
        'No approved professionals are currently available in your area for this service. Please try a different location or check back later.',
        404,
        'NO_PROS_AVAILABLE'
      );
    }

    // Validate the selected pro if provided
    if (selectedProId) {
      const proCheckRes = await pool.query(
        `SELECT pp.latitude, pp.longitude, pp.coverage_radius_km, pp.is_online, pp.verification_status, pp.is_blacklisted
         FROM professional_profiles pp WHERE pp.user_id = $1`,
        [selectedProId]
      );
      const pro = proCheckRes.rows[0];
      if (!pro || !pro.is_online || pro.verification_status !== 'APPROVED' || pro.is_blacklisted) {
        throw new AppError('The selected professional is not available at this time.', 400, 'PRO_NOT_AVAILABLE');
      }
      if (pro.latitude) {
        const dist = haversineKm(latitude, longitude, pro.latitude, pro.longitude);
        if (dist > parseFloat(pro.coverage_radius_km)) {
          throw new AppError('The selected professional is outside your service area.', 400, 'PRO_OUT_OF_RANGE');
        }
      }
    }

    // Update 1: Calculate distance and travel charge
    let distanceKm = 0;
    let travelCharge = 0;
    let kmCharge = 15;

    const proToUse = selectedProId || await this._findNearestPro(serviceId, latitude, longitude);
    if (proToUse) {
      const proLocRes = await pool.query(
        'SELECT latitude, longitude FROM professional_profiles WHERE user_id = $1',
        [proToUse]
      );
      const proLoc = proLocRes.rows[0];
      if (proLoc?.latitude) {
        const posRes = await pool.query(
          'SELECT km_charge_per_km FROM pro_offered_services WHERE pro_id = $1 AND service_id = $2',
          [proToUse, serviceId]
        );
        kmCharge = parseFloat(posRes.rows[0]?.km_charge_per_km || '15');
        distanceKm = parseFloat(haversineKm(latitude, longitude, proLoc.latitude, proLoc.longitude).toFixed(2));
        travelCharge = parseFloat((distanceKm * kmCharge).toFixed(2));
      }
    }

    // Update 5: Get customer sex for booking record
    const custRes = await pool.query('SELECT sex FROM users WHERE id = $1', [customerId]);
    const customerSex = custRes.rows[0]?.sex || null;

    const basePrice = parseFloat(service.base_price);
    const totalAmount = parseFloat((basePrice + travelCharge).toFixed(2));

    const bookingId = `bk-${randomUUID().slice(0, 8)}`;
    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();
    const endOtp = Math.floor(1000 + Math.random() * 9000).toString();

    const insertQuery = `
      INSERT INTO bookings (
        id, customer_id, service_id, status, scheduled_at,
        address_text, latitude, longitude, female_pro_preferred,
        start_otp, end_otp, total_amount, distance_km, travel_charge,
        customer_sex, selected_pro_id
      )
      VALUES ($1, $2, $3, 'REQUESTED', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *
    `;

    const res = await pool.query(insertQuery, [
      bookingId, customerId, serviceId,
      scheduledAt || new Date().toISOString(),
      addressText, latitude, longitude, femaleProPreferred,
      startOtp, endOtp, totalAmount, distanceKm, travelCharge,
      customerSex, selectedProId || null,
    ]);

    await pool.query(
      'INSERT INTO booking_state_logs (id, booking_id, status, notes) VALUES ($1, $2, $3, $4)',
      [`log-${randomUUID().slice(0, 8)}`, bookingId, 'REQUESTED', 'Booking request created by customer']
    );

    const booking = res.rows[0];
    return {
      ...booking,
      base_price: basePrice,
      distance_km: distanceKm,
      travel_charge: travelCharge,
      km_charge: kmCharge,
      total_amount: totalAmount,
    };
  }

  // 6. Accept Booking (Provider)
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
      `UPDATE bookings SET pro_id = $1, status = 'ACCEPTED', updated_at = NOW() WHERE id = $2 RETURNING *`,
      [proUserId, bookingId]
    );

    await pool.query(
      'INSERT INTO booking_state_logs (id, booking_id, status, notes) VALUES ($1, $2, $3, $4)',
      [`log-${randomUUID().slice(0, 8)}`, bookingId, 'ACCEPTED', `Job accepted by provider ${proUserId}`]
    );

    return updateRes.rows[0];
  }

  // 7. Update Booking Status (Provider State Machine)
  async updateStatus(
    proUserId: string,
    bookingId: string,
    nextStatus: 'NAVIGATING' | 'ARRIVED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED',
    otpProvided?: string
  ) {
    const bookingRes = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    const booking = bookingRes.rows[0];

    if (!booking) throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
    if (booking.pro_id !== proUserId) throw new AppError('You are not assigned to this booking', 403, 'FORBIDDEN');

    if (nextStatus === 'IN_PROGRESS') {
      if (!otpProvided || otpProvided !== booking.start_otp) {
        throw new AppError('Invalid Start Job OTP provided by customer', 400, 'INVALID_OTP');
      }
    } else if (nextStatus === 'COMPLETED') {
      if (!otpProvided || otpProvided !== booking.end_otp) {
        throw new AppError('Invalid Finish Job OTP provided by customer', 400, 'INVALID_OTP');
      }
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

  // 8. Get User Bookings (with customer sex for pro view)
  async getUserBookings(userId: string, role: string) {
    const column = role === 'PROFESSIONAL' ? 'pro_id' : 'customer_id';
    const query = `
      SELECT b.*, s.name as service_name,
             u.full_name as counterparty_name,
             u.phone_number as counterparty_phone,
             cust.sex as customer_sex
      FROM bookings b
      JOIN services s ON b.service_id = s.id
      LEFT JOIN users u ON u.id = (CASE WHEN $2 = 'PROFESSIONAL' THEN b.customer_id ELSE b.pro_id END)
      LEFT JOIN users cust ON cust.id = b.customer_id
      WHERE b.${column} = $1
      ORDER BY b.created_at DESC
    `;
    const res = await pool.query(query, [userId, role]);
    return res.rows;
  }

  // 9. Get Single Booking Details
  async getBookingById(bookingId: string, userId: string, role: string) {
    const query = `
      SELECT b.*, s.name as service_name,
             cu.full_name as customer_name,
             cu.phone_number as customer_phone,
             cu.latitude as customer_lat,
             cu.longitude as customer_lng,
             pu.full_name as pro_name,
             pu.phone_number as pro_phone,
             pp.latitude as pro_lat,
             pp.longitude as pro_lng,
             pp.rating_avg as pro_rating,
             pp.verification_status as pro_verification
      FROM bookings b
      LEFT JOIN services s ON b.service_id = s.id
      LEFT JOIN users cu ON b.customer_id = cu.id
      LEFT JOIN users pu ON b.pro_id = pu.id
      LEFT JOIN professional_profiles pp ON b.pro_id = pp.user_id
      WHERE b.id = $1
    `;
    const res = await pool.query(query, [bookingId]);
    if (res.rows.length === 0) {
      throw new AppError('Booking not found', 404, 'BOOKING_NOT_FOUND');
    }
    const booking = res.rows[0];
    if (booking.customer_id !== userId && booking.pro_id !== userId && role !== 'ADMIN' && role !== 'SUPER_ADMIN') {
      throw new AppError('Unauthorized to access this booking', 403, 'FORBIDDEN');
    }
    return booking;
  }

  // ─── PRIVATE HELPERS ──────────────────────────────────────────────────────

  private async _countAvailablePros(
    serviceId: string,
    customerLat: number,
    customerLng: number,
    genderFilter?: string
  ): Promise<number> {
    const query = `
      SELECT pp.latitude, pp.longitude, pp.coverage_radius_km
      FROM pro_offered_services pos
      JOIN professional_profiles pp ON pp.user_id = pos.pro_id
      JOIN users u ON u.id = pos.pro_id
      WHERE pos.service_id = $1
        AND pos.is_active = true
        AND pp.is_online = true
        AND pp.verification_status = 'APPROVED'
        AND pp.is_blacklisted = false
        AND pp.latitude IS NOT NULL
        ${genderFilter ? "AND u.gender = '" + genderFilter + "'" : ''}
    `;
    const res = await pool.query(query, [serviceId]);
    let count = 0;
    for (const p of res.rows) {
      const dist = haversineKm(customerLat, customerLng, p.latitude, p.longitude);
      if (dist <= parseFloat(p.coverage_radius_km || '50')) count++;
    }
    return count;
  }

  private async _findNearestPro(serviceId: string, lat: number, lng: number): Promise<string | null> {
    const query = `
      SELECT pp.user_id, pp.latitude, pp.longitude
      FROM pro_offered_services pos
      JOIN professional_profiles pp ON pp.user_id = pos.pro_id
      WHERE pos.service_id = $1
        AND pos.is_active = true
        AND pp.is_online = true
        AND pp.verification_status = 'APPROVED'
        AND pp.is_blacklisted = false
        AND pp.latitude IS NOT NULL
    `;
    const res = await pool.query(query, [serviceId]);
    if (res.rows.length === 0) return null;
    let nearest: string | null = null;
    let minDist = Infinity;
    for (const p of res.rows) {
      const dist = haversineKm(lat, lng, p.latitude, p.longitude);
      if (dist < minDist) { minDist = dist; nearest = p.user_id; }
    }
    return nearest;
  }
}

export const bookingService = new BookingService();
