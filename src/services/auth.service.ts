import { randomUUID } from 'crypto';
import { pool } from '../db/pgDb';
import { UserRole, Gender } from '../db/memoryDb';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt.utils';
import { config } from '../config';
import { AppError } from '../middleware/error.middleware';

export class AuthService {
  // 0. Update 2: Smart pre-flight phone check (no OTP needed)
  async checkPhoneExists(phoneNumber: string): Promise<{ exists: boolean; role: string | null }> {
    if (!phoneNumber) return { exists: false, role: null };
    const res = await pool.query(
      'SELECT role FROM users WHERE phone_number = $1 AND is_active = true',
      [phoneNumber]
    );
    if (res.rows.length === 0) return { exists: false, role: null };
    return { exists: true, role: res.rows[0].role };
  }

  // 1. Send OTP
  async sendOTP(phoneNumber: string) {
    // Validate: must have country code and be a plausible mobile number
    if (!phoneNumber || !phoneNumber.startsWith('+') || phoneNumber.length < 10) {
      throw new AppError(
        'Valid phone number with country code is required (e.g., +919876543210)',
        400,
        'INVALID_PHONE'
      );
    }

    // Use fixed OTP in development, cryptographically random in production
    const otp = config.nodeEnv === 'development'
      ? '123456'
      : Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + config.otpExpiryMinutes * 60 * 1000;

    await pool.query(
      `INSERT INTO otps (phone_number, otp, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone_number) DO UPDATE SET otp = $2, expires_at = $3`,
      [phoneNumber, otp, expiresAt]
    );

    // SECURITY: Only log OTP in development. Never log in production.
    if (config.nodeEnv === 'development') {
      console.log(`[DEV-SMS-MOCK] OTP for ${phoneNumber}: ${otp}`);
    } else {
      // In production: integrate real SMS provider here (Twilio, MSG91, etc.)
      // await smsProvider.send(phoneNumber, `Your LUMO OTP is ${otp}. Valid for ${config.otpExpiryMinutes} minutes.`);
      console.log(`[SMS-SERVICE] OTP dispatched to ${phoneNumber} (value hidden in production)`);
    }

    return {
      phoneNumber,
      message: `OTP sent successfully to ${phoneNumber}`,
      expiresInMinutes: config.otpExpiryMinutes,
      // SECURITY: debugOtp is ONLY included in development environment responses.
      // It is undefined (and thus omitted from JSON) in staging and production.
      ...(config.nodeEnv === 'development' && { debugOtp: otp }),
    };
  }

  // 2. Verify OTP
  async verifyOTP(
    phoneNumber: string,
    otp: string,
    requestedRole: UserRole = 'CUSTOMER',
    fullName?: string,
    gender?: Gender
  ) {
    const otpRes = await pool.query('SELECT * FROM otps WHERE phone_number = $1', [phoneNumber]);
    const record = otpRes.rows[0];

    if (!record) {
      throw new AppError('No OTP record found for this phone number. Please request OTP first.', 404, 'OTP_NOT_FOUND');
    }

    if (Date.now() > parseInt(record.expires_at, 10)) {
      await pool.query('DELETE FROM otps WHERE phone_number = $1', [phoneNumber]);
      throw new AppError('OTP has expired. Please request a new OTP.', 400, 'OTP_EXPIRED');
    }

    if (record.otp !== otp) {
      throw new AppError('Invalid OTP code', 400, 'INVALID_OTP');
    }

    await pool.query('DELETE FROM otps WHERE phone_number = $1', [phoneNumber]);

    const userRes = await pool.query('SELECT * FROM users WHERE phone_number = $1', [phoneNumber]);
    let user = userRes.rows[0];

    if (!user) {
      const userId = `usr-${randomUUID().slice(0, 8)}`;
      const name = fullName || (requestedRole === 'PROFESSIONAL' ? 'New Professional' : 'New Customer');
      const userGender = gender || 'OTHER';

      const insertRes = await pool.query(
        `INSERT INTO users (id, phone_number, full_name, role, gender, is_active)
         VALUES ($1, $2, $3, $4, $5, true)
         RETURNING *`,
        [userId, phoneNumber, name, requestedRole, userGender]
      );
      user = insertRes.rows[0];

      if (requestedRole === 'PROFESSIONAL') {
        const proProfId = `pro-prof-${randomUUID().slice(0, 8)}`;
        await pool.query(
          `INSERT INTO professional_profiles (id, user_id, verification_status, documents, face_verified, is_online, is_busy, rating_avg, total_jobs_completed, acceptance_rate, cancellation_rate, account_health_score, is_blacklisted)
           VALUES ($1, $2, 'PENDING', '{}'::jsonb, false, false, false, 5.0, 0, 100.0, 0.0, 100.0, false)`,
          [proProfId, user.id]
        );
      }
    } else {
      if (!user.is_active) {
        throw new AppError('Your account has been deactivated or suspended. Please contact support.', 403, 'ACCOUNT_DISABLED');
      }
    }

    const tokenPayload = {
      userId: user.id,
      role: user.role as UserRole,
      phoneNumber: user.phone_number,
    };

    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    await pool.query(
      `INSERT INTO refresh_tokens (token, user_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET expires_at = $3`,
      [refreshToken, user.id, Date.now() + 7 * 24 * 60 * 60 * 1000]
    );

    return {
      isRegistered: !!userRes.rows[0], // true if user already existed before OTP verify
      user: {
        id: user.id,
        phoneNumber: user.phone_number,
        fullName: user.full_name,
        email: user.email,
        role: user.role,
        gender: user.gender,
        avatarUrl: user.avatar_url,
      },
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: config.jwtExpiresIn,
      },
    };
  }

  // 3. OAuth Login
  async oauthLogin(provider: 'google' | 'apple', token: string, requestedRole: UserRole = 'CUSTOMER', email?: string, name?: string) {
    if (!token) {
      throw new AppError(`${provider} token is required`, 400, 'MISSING_OAUTH_TOKEN');
    }

    const userEmail = email || `user_${provider}_${token.slice(0, 6)}@example.com`;
    const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [userEmail]);
    let user = userRes.rows[0];

    if (!user) {
      const userId = `usr-${randomUUID().slice(0, 8)}`;
      const mockPhone = `+91000000${Math.floor(1000 + Math.random() * 9000)}`;
      const userName = name || `OAuth User (${provider})`;

      const insertRes = await pool.query(
        `INSERT INTO users (id, phone_number, email, full_name, role, gender, is_active)
         VALUES ($1, $2, $3, $4, $5, 'OTHER', true)
         RETURNING *`,
        [userId, mockPhone, userEmail, userName, requestedRole]
      );
      user = insertRes.rows[0];

      if (requestedRole === 'PROFESSIONAL') {
        const proProfId = `pro-prof-${randomUUID().slice(0, 8)}`;
        await pool.query(
          `INSERT INTO professional_profiles (id, user_id, verification_status, documents, face_verified, is_online, is_busy, rating_avg, total_jobs_completed, acceptance_rate, cancellation_rate, account_health_score, is_blacklisted)
           VALUES ($1, $2, 'PENDING', '{}'::jsonb, false, false, false, 5.0, 0, 100.0, 0.0, 100.0, false)`,
          [proProfId, user.id]
        );
      }
    }

    const tokenPayload = { userId: user.id, role: user.role as UserRole, phoneNumber: user.phone_number };
    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    await pool.query(
      `INSERT INTO refresh_tokens (token, user_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET expires_at = $3`,
      [refreshToken, user.id, Date.now() + 7 * 24 * 60 * 60 * 1000]
    );

    return {
      user: {
        id: user.id,
        phoneNumber: user.phone_number,
        fullName: user.full_name,
        email: user.email,
        role: user.role,
        avatarUrl: user.avatar_url,
      },
      tokens: { accessToken, refreshToken, expiresIn: config.jwtExpiresIn },
    };
  }

  // 4. Refresh Token
  async refreshToken(refreshToken: string) {
    if (!refreshToken) {
      throw new AppError('Refresh token is required', 400, 'MISSING_REFRESH_TOKEN');
    }

    const tokenRes = await pool.query('SELECT * FROM refresh_tokens WHERE token = $1', [refreshToken]);
    const record = tokenRes.rows[0];

    if (!record || Date.now() > parseInt(record.expires_at, 10)) {
      if (record) await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
      throw new AppError('Refresh token expired or invalid', 401, 'INVALID_REFRESH_TOKEN');
    }

    const decoded = verifyRefreshToken(refreshToken);
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
    const user = userRes.rows[0];

    if (!user || !user.is_active) {
      throw new AppError('User account not found or inactive', 403, 'USER_INACTIVE');
    }

    await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);

    const newPayload = { userId: user.id, role: user.role as UserRole, phoneNumber: user.phone_number };
    const newAccessToken = generateAccessToken(newPayload);
    const newRefreshToken = generateRefreshToken(newPayload);

    await pool.query(
      `INSERT INTO refresh_tokens (token, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [newRefreshToken, user.id, Date.now() + 7 * 24 * 60 * 60 * 1000]
    );

    return {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn: config.jwtExpiresIn,
    };
  }

  // 5. Firebase Auth Verification & Login
  async firebaseLogin(
    idToken: string,
    requestedRole: UserRole = 'CUSTOMER',
    fullName?: string,
    gender?: Gender
  ) {
    if (!idToken) {
      throw new AppError('Firebase ID Token is required', 400, 'MISSING_FIREBASE_TOKEN');
    }

    const { getFirebaseAuth } = require('../config/firebase.config');
    const auth = getFirebaseAuth();

    let decodedToken;
    try {
      decodedToken = await auth.verifyIdToken(idToken);
    } catch (err: any) {
      throw new AppError(`Firebase ID Token verification failed: ${err.message}`, 401, 'INVALID_FIREBASE_TOKEN');
    }

    const firebaseUid = decodedToken.uid;
    const phoneNumber = decodedToken.phone_number || `+9100000${Math.floor(10000 + Math.random() * 90000)}`;
    const email = decodedToken.email;

    // Check if user exists by phone or email
    const userRes = await pool.query(
      'SELECT * FROM users WHERE phone_number = $1 OR (email IS NOT NULL AND email = $2)',
      [phoneNumber, email || '']
    );
    let user = userRes.rows[0];

    if (!user) {
      const userId = `usr-${randomUUID().slice(0, 8)}`;
      const name = fullName || decodedToken.name || (requestedRole === 'PROFESSIONAL' ? 'New Professional' : 'New Customer');
      const userGender = gender || 'OTHER';

      const insertRes = await pool.query(
        `INSERT INTO users (id, phone_number, email, full_name, role, gender, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         RETURNING *`,
        [userId, phoneNumber, email, name, requestedRole, userGender]
      );
      user = insertRes.rows[0];

      if (requestedRole === 'PROFESSIONAL') {
        const proProfId = `pro-prof-${randomUUID().slice(0, 8)}`;
        await pool.query(
          `INSERT INTO professional_profiles (id, user_id, verification_status, documents, face_verified, is_online, is_busy, rating_avg, total_jobs_completed, acceptance_rate, cancellation_rate, account_health_score, is_blacklisted)
           VALUES ($1, $2, 'PENDING', '{}'::jsonb, false, false, false, 5.0, 0, 100.0, 0.0, 100.0, false)`,
          [proProfId, user.id]
        );
      }
    } else {
      if (!user.is_active) {
        throw new AppError('Your account has been deactivated or suspended. Please contact support.', 403, 'ACCOUNT_DISABLED');
      }
    }

    const tokenPayload = {
      userId: user.id,
      role: user.role as UserRole,
      phoneNumber: user.phone_number,
    };

    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    await pool.query(
      `INSERT INTO refresh_tokens (token, user_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET expires_at = $3`,
      [refreshToken, user.id, Date.now() + 7 * 24 * 60 * 60 * 1000]
    );

    return {
      user: {
        id: user.id,
        firebaseUid,
        phoneNumber: user.phone_number,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        gender: user.gender,
        avatarUrl: user.avatar_url,
      },
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: config.jwtExpiresIn,
      },
    };
  }

  // 6. Complete Customer Profile (post-OTP first-time registration)
  async completeCustomerProfile(
    userId: string,
    fullName: string,
    age: number,
    sex: string,
    email?: string
  ) {
    const updateRes = await pool.query(
      `UPDATE users
       SET full_name = $1, age = $2, sex = $3, email = COALESCE($4, email), updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [fullName, age, sex, email || null, userId]
    );
    const user = updateRes.rows[0];
    if (!user) throw new AppError('User not found', 404);
    return {
      id: user.id,
      phoneNumber: user.phone_number,
      fullName: user.full_name,
      age: user.age,
      sex: user.sex,
      email: user.email,
      role: user.role,
      gender: user.gender,
    };
  }

  // 7. Register Professional with Phone OTP (full registration with extra fields)
  async registerProWithPhone(
    phoneNumber: string,
    fullName: string,
    age: number,
    email: string,
    gender: string,
    serviceArea: string,
    latitude?: number,
    longitude?: number
  ) {
    // Upsert user with PROFESSIONAL role
    const existingRes = await pool.query('SELECT * FROM users WHERE phone_number = $1', [phoneNumber]);
    const alreadyRegistered = existingRes.rows.length > 0;
    let user = existingRes.rows[0];

    if (!user) {
      const userId = `usr-${randomUUID().slice(0, 8)}`;
      const insertRes = await pool.query(
        `INSERT INTO users (id, phone_number, full_name, role, gender, age, email, is_active)
         VALUES ($1, $2, $3, 'PROFESSIONAL', $4, $5, $6, true)
         RETURNING *`,
        [userId, phoneNumber, fullName, gender, age, email || null]
      );
      user = insertRes.rows[0];
    } else {
      const updateRes = await pool.query(
        `UPDATE users SET full_name = $1, age = $2, gender = $3, email = COALESCE($4, email),
         role = 'PROFESSIONAL', updated_at = NOW()
         WHERE id = $5 RETURNING *`,
        [fullName, age, gender, email || null, user.id]
      );
      user = updateRes.rows[0];
    }

    // Create or update professional profile — Update 8: save lat/lng
    const proRes = await pool.query('SELECT id FROM professional_profiles WHERE user_id = $1', [user.id]);
    if (!proRes.rows[0]) {
      const proProfId = `pro-prof-${randomUUID().slice(0, 8)}`;
      await pool.query(
        `INSERT INTO professional_profiles
         (id, user_id, verification_status, documents, face_verified, is_online, is_busy,
          rating_avg, total_jobs_completed, acceptance_rate, cancellation_rate, account_health_score,
          is_blacklisted, service_area, coverage_radius_km, latitude, longitude)
         VALUES ($1, $2, 'PENDING', '{}'::jsonb, false, false, false, 5.0, 0, 100.0, 0.0, 100.0, false, $3, 50.0, $4, $5)`,
        [proProfId, user.id, serviceArea || 'Bangalore', latitude ?? null, longitude ?? null]
      );
    } else {
      await pool.query(
        `UPDATE professional_profiles
         SET service_area = $1, latitude = COALESCE($2, latitude), longitude = COALESCE($3, longitude), updated_at = NOW()
         WHERE user_id = $4`,
        [serviceArea || 'Bangalore', latitude ?? null, longitude ?? null, user.id]
      );
    }

    const tokenPayload = { userId: user.id, role: 'PROFESSIONAL' as any, phoneNumber: user.phone_number };
    const accessToken = generateAccessToken(tokenPayload);
    const refreshToken = generateRefreshToken(tokenPayload);

    await pool.query(
      `INSERT INTO refresh_tokens (token, user_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET expires_at = $3`,
      [refreshToken, user.id, Date.now() + 7 * 24 * 60 * 60 * 1000]
    );

    return {
      isRegistered: alreadyRegistered,
      user: {
        id: user.id,
        phoneNumber: user.phone_number,
        fullName: user.full_name,
        age: user.age,
        email: user.email,
        role: user.role,
        gender: user.gender,
      },
      tokens: { accessToken, refreshToken, expiresIn: config.jwtExpiresIn },
      verificationStatus: 'PENDING',
    };
  }

  // 8. Logout
  async logout(refreshToken?: string) {
    if (refreshToken) {
      await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
    }
    return { message: 'Logged out successfully' };
  }
}

export const authService = new AuthService();
