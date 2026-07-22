import { randomUUID } from 'crypto';
import { pool } from '../db/pgDb';
import { UserRole, Gender } from '../db/memoryDb';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt.utils';
import { config } from '../config';
import { AppError } from '../middleware/error.middleware';

export class AuthService {
  // 1. Send OTP
  async sendOTP(phoneNumber: string) {
    if (!phoneNumber || !phoneNumber.startsWith('+')) {
      throw new AppError('Valid phone number with country code (e.g., +919876543210) is required', 400, 'INVALID_PHONE');
    }

    const otp = config.nodeEnv === 'development' ? '123456' : Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + config.otpExpiryMinutes * 60 * 1000;

    await pool.query(
      `INSERT INTO otps (phone_number, otp, expires_at) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (phone_number) DO UPDATE SET otp = $2, expires_at = $3`,
      [phoneNumber, otp, expiresAt]
    );

    console.log(`[SMS-SERVICE-MOCK] OTP sent to ${phoneNumber}: ${otp}`);

    return {
      phoneNumber,
      message: `OTP sent successfully to ${phoneNumber}`,
      expiresInMinutes: config.otpExpiryMinutes,
      debugOtp: config.nodeEnv === 'development' ? otp : undefined,
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

  // 5. Logout
  async logout(refreshToken?: string) {
    if (refreshToken) {
      await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
    }
    return { message: 'Logged out successfully' };
  }
}

export const authService = new AuthService();
