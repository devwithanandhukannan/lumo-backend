import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Pool } from 'pg';
import argon2 from 'argon2';
import { randomUUID } from 'crypto';
import { AppError, errorHandler, generateAccessToken, generateRefreshToken, authenticateToken, requireRoles, AuthenticatedRequest } from '@lumo/common';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

import path from 'path';
import fs from 'fs';

dotenv.config();

// Enforce essential environment variables in production
if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
  throw new Error('FATAL: DATABASE_URL environment variable is required in production.');
}

const app = express();
const PORT = Number(process.env.PORT) || 5001;

// 1. Security & Middleware Configuration
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => callback(null, origin || true),
  credentials: true,
}));
app.use(express.json({ limit: '10kb' })); // Restrict payload size

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 15 : 500,
  message: { success: false, error: 'Too many authentication attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://lumo_user:lumo_password@localhost:5432/lumo_db',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// 2. Firebase Admin Initialization
if (getApps().length === 0) {
  try {
    const rawSaPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || 'firebase-service-account.json';
    const candidatePaths = [
      path.isAbsolute(rawSaPath) ? rawSaPath : path.resolve(process.cwd(), rawSaPath),
      path.resolve(__dirname, '../firebase-service-account.json'),
      path.resolve(__dirname, '../../../firebase-service-account.json'),
    ];

    let loaded = false;
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        const serviceAccount = require(p);
        initializeApp({ credential: cert(serviceAccount) });
        console.log(`🔥 Firebase Admin SDK initialized successfully via ${p} (Project: ${serviceAccount.project_id})`);
        loaded = true;
        break;
      }
    }

    if (!loaded) {
      initializeApp();
      console.log('🔥 Firebase Admin SDK initialized via Application Default Credentials');
    }
  } catch (err: any) {
    console.warn('⚠️ Firebase Admin SDK initialization warning:', err.message);
  }
}

// 3. Healthcheck
app.get('/health', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'UP', database: 'CONNECTED', service: 'Auth Service' });
  } catch (err) {
    res.status(500).json({ status: 'DOWN', database: 'DISCONNECTED' });
  }
});

// Update 2: Smart pre-flight phone existence check
app.get('/api/v1/auth/check-phone', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const phone = req.query.phone as string;
    if (!phone) {
      res.status(400).json({ success: false, message: 'phone query param is required' });
      return;
    }
    const userRes = await pool.query('SELECT role FROM users WHERE phone_number = $1 AND is_active = true', [phone]);
    if (userRes.rows.length === 0) {
      res.json({ success: true, data: { exists: false, role: null } });
    } else {
      res.json({ success: true, data: { exists: true, role: userRes.rows[0].role } });
    }
  } catch (err) { next(err); }
});

// 4. Send OTP Request
app.post('/api/v1/auth/otp/send', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phoneNumber, checkRegistered, isSignInMode } = req.body;
    if (!phoneNumber) throw new AppError('Phone number required', 400);

    const checkRequired = Boolean(checkRegistered || isSignInMode);
    if (checkRequired) {
      const userRes = await pool.query(
        "SELECT id FROM users WHERE phone_number = $1 AND role = 'PROFESSIONAL'",
        [phoneNumber]
      );
      if (userRes.rows.length === 0) {
        throw new AppError('No registered professional account found with this mobile number. Please switch to the Register tab to create an account.', 404);
      }
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000;

    await pool.query(
      `INSERT INTO otps (phone_number, otp, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (phone_number) DO UPDATE SET otp = $2, expires_at = $3`,
      [phoneNumber, otp, expiresAt]
    );

    // Development-only log
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DEV ONLY] OTP for ${phoneNumber}: ${otp}`);
    }

    res.json({ success: true, message: 'OTP sent successfully', debugOtp: process.env.NODE_ENV !== 'production' ? otp : undefined });
  } catch (err) { next(err); }
});

// Helper: Serialize Set-Cookie header
const serializeCookie = (
  name: string,
  value: string,
  options: { maxAge?: number; httpOnly?: boolean; path?: string; sameSite?: 'Lax' | 'Strict' | 'None'; secure?: boolean }
) => {
  let cookieStr = `${name}=${encodeURIComponent(value)}`;
  if (options.maxAge !== undefined) cookieStr += `; Max-Age=${Math.floor(options.maxAge / 1000)}`;
  if (options.path) cookieStr += `; Path=${options.path}`;
  if (options.httpOnly) cookieStr += `; HttpOnly`;
  if (options.secure) cookieStr += `; Secure`;
  if (options.sameSite) cookieStr += `; SameSite=${options.sameSite}`;
  return cookieStr;
};

// Helper: Parse Cookie Header
const parseCookies = (cookieHeader?: string): Record<string, string> => {
  const list: Record<string, string> = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    const name = parts[0]?.trim();
    if (!name) return;
    const value = parts.slice(1).join('=').trim();
    list[name] = decodeURIComponent(value);
  });
  return list;
};

// Admin Login Handler (Email & Password with 15m Access Token & HttpOnly Refresh Cookie)
const handleAdminLogin = async (req: Request, res: Response, next: NextFunction) => {
  const client = await pool.connect();
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      throw new AppError('Email and password required', 400);
    }

    const cleanEmail = email.trim().toLowerCase();

    await client.query('BEGIN');
    let userRes = await client.query('SELECT * FROM users WHERE LOWER(email) = $1', [cleanEmail]);
    let user = userRes.rows[0];

    if (!user) {
      // Automatic seed for admin@lumo.in or admin email during initial setup
      if (cleanEmail === 'admin@lumo.in' || cleanEmail.includes('admin')) {
        const userId = `usr-admin-${randomUUID().slice(0, 8)}`;
        const passHash = await argon2.hash(password);
        const existingPhoneRes = await client.query('SELECT id FROM users WHERE phone_number = $1', ['+919999999999']);
        const adminPhone = existingPhoneRes.rows.length === 0 ? '+919999999999' : `+91999${Date.now().toString().slice(-7)}`;
        const insertRes = await client.query(
          `INSERT INTO users (id, phone_number, email, password_hash, full_name, role, gender, email_verified, phone_verified, is_active)
           VALUES ($1, $2, $3, $4, 'Super Admin', 'SUPER_ADMIN', 'MALE', true, true, true) RETURNING *`,
          [userId, adminPhone, cleanEmail, passHash]
        );
        user = insertRes.rows[0];
      } else {
        throw new AppError('Invalid email or password', 401);
      }
    } else {
      if (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN') {
        throw new AppError('Access denied. Admin privileges required.', 403);
      }

      if (!user.password_hash) {
        // Set password_hash if user existed without one (e.g. init.sql seed)
        const passHash = await argon2.hash(password);
        const updateRes = await client.query(
          'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING *',
          [passHash, user.id]
        );
        user = updateRes.rows[0];
      } else {
        const isValidPassword = await argon2.verify(user.password_hash, password);
        if (!isValidPassword) {
          throw new AppError('Invalid email or password', 401);
        }
      }
    }

    await client.query('COMMIT');

    const tokenPayload = { userId: user.id, role: user.role, email: user.email };
    const accessToken = generateAccessToken(tokenPayload, '15m');
    const refreshToken = generateRefreshToken(tokenPayload);

    // Save refresh token to DB
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    await pool.query(
      `INSERT INTO refresh_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET expires_at = $3`,
      [refreshToken, user.id, expiresAt]
    );

    // Set HttpOnly Cookie for Refresh Token
    res.setHeader(
      'Set-Cookie',
      serializeCookie('admin_refresh_token', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/',
      })
    );

    res.json({
      success: true,
      message: 'Admin authentication successful',
      data: {
        accessToken,
        user: {
          id: user.id,
          email: user.email,
          full_name: user.full_name,
          role: user.role,
        },
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// Admin Refresh Token Handler
const handleAdminRefresh = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const refreshToken = cookies['admin_refresh_token'] || req.body?.refreshToken;

    if (!refreshToken) {
      throw new AppError('Refresh token missing', 401);
    }

    const { verifyRefreshToken } = require('@lumo/common');
    const decoded = verifyRefreshToken(refreshToken);
    const tokenRes = await pool.query('SELECT * FROM refresh_tokens WHERE token = $1', [refreshToken]);
    const record = tokenRes.rows[0];

    if (!record || Number(record.expires_at) < Date.now()) {
      if (record) await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
      throw new AppError('Invalid or expired refresh token', 401);
    }

    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
    const user = userRes.rows[0];
    if (!user || !user.is_active) {
      throw new AppError('User account not found or inactive', 401);
    }

    const tokenPayload = { userId: user.id, role: user.role, email: user.email };
    const newAccessToken = generateAccessToken(tokenPayload, '15m');
    const newRefreshToken = generateRefreshToken(tokenPayload);

    await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    await pool.query(
      `INSERT INTO refresh_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)`,
      [newRefreshToken, user.id, expiresAt]
    );

    res.setHeader(
      'Set-Cookie',
      serializeCookie('admin_refresh_token', newRefreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/',
      })
    );

    res.json({
      success: true,
      data: {
        accessToken: newAccessToken,
        user: {
          id: user.id,
          email: user.email,
          full_name: user.full_name,
          role: user.role,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// Admin Logout Handler
const handleAdminLogout = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const refreshToken = cookies['admin_refresh_token'] || req.body?.refreshToken;

    if (refreshToken) {
      await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
    }

    res.setHeader(
      'Set-Cookie',
      serializeCookie('admin_refresh_token', '', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'Lax',
        maxAge: 0,
        path: '/',
      })
    );

    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
};

// Admin Password Reset Handler (Requires active Admin session & verifies current password)
const handleAdminResetPassword = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const client = await pool.connect();
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
      throw new AppError('New password must be at least 6 characters long', 400);
    }

    if (confirmPassword && newPassword !== confirmPassword) {
      throw new AppError('New password and confirm password do not match', 400);
    }

    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError('Authentication required to reset password', 401);
    }

    const userRes = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];

    if (!user) {
      throw new AppError('Admin account not found', 404);
    }

    if (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN') {
      throw new AppError('Access denied. Admin privileges required.', 403);
    }

    if (user.password_hash) {
      if (!currentPassword) {
        throw new AppError('Current password is required to set a new password', 400);
      }
      const isValid = await argon2.verify(user.password_hash, currentPassword);
      if (!isValid) {
        throw new AppError('Current password is incorrect', 400);
      }
    }

    const newPasswordHash = await argon2.hash(newPassword);
    await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newPasswordHash, user.id]);

    res.json({
      success: true,
      message: 'Admin password updated successfully. Please use your new password next time you log in.',
    });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
};

app.post('/api/v1/auth/admin/login', handleAdminLogin);
app.post('/api/v1/auth/admin-login', handleAdminLogin);
app.post('/api/v1/auth/admin/refresh', handleAdminRefresh);
app.post('/api/v1/auth/refresh', handleAdminRefresh);
app.post('/api/v1/auth/admin/logout', handleAdminLogout);
app.post('/api/v1/auth/logout', handleAdminLogout);
app.post('/api/v1/auth/admin/reset-password', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), handleAdminResetPassword);
app.post('/api/v1/auth/admin/change-password', authenticateToken, requireRoles(['ADMIN', 'SUPER_ADMIN']), handleAdminResetPassword);

// 5. Verify OTP Request (Using DB Transactions)
app.post('/api/v1/auth/otp/verify', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const client = await pool.connect();
  try {
    const { phoneNumber, otp, role = 'CUSTOMER', fullName, gender = 'OTHER', isSignInMode } = req.body;
    if (!phoneNumber || !otp) throw new AppError('Phone number and OTP code required', 400);

    const otpRes = await client.query('SELECT * FROM otps WHERE phone_number = $1', [phoneNumber]);
    const record = otpRes.rows[0];

    if (!record || record.otp !== String(otp) || Number(record.expires_at) < Date.now()) {
      throw new AppError('Invalid or expired OTP code', 400);
    }

    await client.query('BEGIN');

    let userRes = await client.query('SELECT * FROM users WHERE phone_number = $1', [phoneNumber]);
    let user = userRes.rows[0];

    if (!user) {
      if (isSignInMode) {
        throw new AppError('No registered account found with this mobile number. Please switch to Register tab to create an account.', 404);
      }
      const userId = `usr-${randomUUID().slice(0, 8)}`;
      const insertRes = await client.query(
        `INSERT INTO users (id, phone_number, full_name, role, gender, phone_verified, is_active)
         VALUES ($1, $2, $3, $4, $5, true, true) RETURNING *`,
        [userId, phoneNumber, fullName || 'New User', role, gender]
      );
      user = insertRes.rows[0];

      if (role === 'PROFESSIONAL') {
        await client.query(
          `INSERT INTO professional_profiles (id, user_id, verification_status, coverage_radius_km)
           VALUES ($1, $2, 'PENDING', 50.00) ON CONFLICT (user_id) DO NOTHING`,
          [`pro-${randomUUID().slice(0, 8)}`, user.id]
        );
      }
    } else {
      await client.query('UPDATE users SET phone_verified = true WHERE id = $1', [user.id]);
    }

    let proRes = await client.query('SELECT * FROM professional_profiles WHERE user_id = $1', [user.id]);
    let pro = proRes.rows[0];

    await client.query('DELETE FROM otps WHERE phone_number = $1', [phoneNumber]);
    await client.query('COMMIT');

    const isRegistered = user.role === 'CUSTOMER'
      ? Boolean(user.full_name && user.full_name !== 'New User' && user.full_name !== 'Customer')
      : Boolean(
          user.full_name &&
          user.full_name !== 'New User' &&
          user.full_name !== 'Professional' &&
          pro?.face_verification_url
        );

    const payload = { userId: user.id, role: user.role, phoneNumber: user.phone_number };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    res.json({
      success: true,
      data: {
        user,
        profile: pro || null,
        isRegistered,
        verificationStatus: pro ? pro.verification_status : 'PENDING',
        tokens: { accessToken, refreshToken },
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// 6. Professional Register (Argon2 Password Hashing)
app.post('/api/v1/auth/pro/register', async (req: Request, res: Response, next: NextFunction) => {
  const client = await pool.connect();
  try {
    const { email, password, phoneNumber, fullName, gender = 'OTHER', location, serviceArea, assignedRegion, latitude, longitude } = req.body;
    if (!email || !password || !fullName) throw new AppError('Email, password and name required', 400);

    const targetLocation = location || serviceArea || assignedRegion || null;
    const lat = latitude ? parseFloat(latitude) : null;
    const lng = longitude ? parseFloat(longitude) : null;

    const existing = await client.query('SELECT * FROM users WHERE email = $1 OR (phone_number IS NOT NULL AND phone_number = $2)', [email, phoneNumber || '']);

    if (existing.rows.length > 0) {
      const existingUser = existing.rows[0];
      const isPasswordMatch = existingUser.password_hash ? await argon2.verify(existingUser.password_hash, password) : false;

      if (isPasswordMatch) {
        const proRes = await client.query('SELECT * FROM professional_profiles WHERE user_id = $1', [existingUser.id]);
        const pro = proRes.rows[0];

        if (targetLocation || lat !== null) {
          await client.query('UPDATE users SET service_area = COALESCE($1, service_area), latitude = COALESCE($2, latitude), longitude = COALESCE($3, longitude) WHERE id = $4', [targetLocation, lat, lng, existingUser.id]);
          await client.query('UPDATE professional_profiles SET service_area = COALESCE($1, service_area), assigned_region = COALESCE($1, assigned_region), latitude = COALESCE($2, latitude), longitude = COALESCE($3, longitude) WHERE user_id = $4', [targetLocation, lat, lng, existingUser.id]);
        }

        const payload = { userId: existingUser.id, role: existingUser.role, email: existingUser.email };
        return res.status(200).json({
          success: true,
          message: 'Account already exists. Seamlessly logged in.',
          data: {
            user: { ...existingUser, service_area: targetLocation || existingUser.service_area, latitude: lat || existingUser.latitude, longitude: lng || existingUser.longitude },
            verificationStatus: pro ? pro.verification_status : 'PENDING',
            tokens: { accessToken: generateAccessToken(payload), refreshToken: generateRefreshToken(payload) }
          }
        });
      }
      throw new AppError('An account with this email address already exists.', 400);
    }

    await client.query('BEGIN');
    const passHash = await argon2.hash(password);
    const userId = `usr-${randomUUID().slice(0, 8)}`;

    const insertRes = await client.query(
      `INSERT INTO users (id, email, password_hash, phone_number, full_name, role, gender, service_area, latitude, longitude, is_active)
       VALUES ($1, $2, $3, $4, $5, 'PROFESSIONAL', $6, $7, $8, $9, true) RETURNING *`,
      [userId, email, passHash, phoneNumber || null, fullName, gender, targetLocation, lat, lng]
    );
    const user = insertRes.rows[0];

    await client.query(
      `INSERT INTO professional_profiles (id, user_id, verification_status, coverage_radius_km, assigned_region, service_area, latitude, longitude)
       VALUES ($1, $2, 'PENDING', 50.00, $3, $3, $4, $5) ON CONFLICT (user_id) DO UPDATE SET assigned_region = COALESCE(EXCLUDED.assigned_region, professional_profiles.assigned_region), service_area = COALESCE(EXCLUDED.service_area, professional_profiles.service_area), latitude = COALESCE(EXCLUDED.latitude, professional_profiles.latitude), longitude = COALESCE(EXCLUDED.longitude, professional_profiles.longitude)`,
      [`pro-${randomUUID().slice(0, 8)}`, user.id, targetLocation, lat, lng]
    );

    await client.query('COMMIT');

    const payload = { userId: user.id, role: user.role, email: user.email };
    res.status(201).json({
      success: true,
      data: {
        user,
        verificationStatus: 'PENDING',
        tokens: { accessToken: generateAccessToken(payload), refreshToken: generateRefreshToken(payload) }
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// 6b. Professional Register via Phone Onboarding (Updates Profile, Email, Age & Location)
async function geocodeAddressText(addressText: string): Promise<{ lat: number; lng: number } | null> {
  if (!addressText || !addressText.trim()) return null;
  try {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyD9r59vIxUjLj3hiICvy9CYbXYbmil0Xb4';
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addressText.trim())}&key=${apiKey}`;
    const res = await fetch(url);
    const data = (await res.json()) as any;
    if (data.status === 'OK' && data.results && data.results.length > 0) {
      const loc = data.results[0].geometry.location;
      return { lat: parseFloat(loc.lat), lng: parseFloat(loc.lng) };
    }
  } catch (e) {
    console.warn('Geocoding helper warning:', e);
  }
  return null;
}

const handleProRegisterPhone = async (req: Request, res: Response, next: NextFunction) => {
  const client = await pool.connect();
  try {
    const { phoneNumber, fullName, age, email, gender = 'OTHER', serviceArea, location, latitude, longitude } = req.body;
    if (!phoneNumber || !fullName) throw new AppError('Phone number and full name required', 400);

    const targetLocation = serviceArea || location || null;
    let lat = latitude !== undefined && latitude !== null ? parseFloat(latitude) : null;
    let lng = longitude !== undefined && longitude !== null ? parseFloat(longitude) : null;

    if ((lat === null || lng === null) && targetLocation) {
      const geo = await geocodeAddressText(targetLocation);
      if (geo) {
        lat = geo.lat;
        lng = geo.lng;
      }
    }

    let userRes = await client.query('SELECT * FROM users WHERE phone_number = $1', [phoneNumber]);
    let user = userRes.rows[0];

    await client.query('BEGIN');

    if (!user) {
      const userId = `usr-${randomUUID().slice(0, 8)}`;
      const insertRes = await client.query(
        `INSERT INTO users (id, phone_number, full_name, email, age, gender, role, service_area, latitude, longitude, phone_verified, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, 'PROFESSIONAL', $7, $8, $9, true, true) RETURNING *`,
        [userId, phoneNumber, fullName, email || null, age || null, gender, targetLocation, lat, lng]
      );
      user = insertRes.rows[0];
    } else {
      const updateRes = await client.query(
        `UPDATE users
         SET full_name = COALESCE($1, full_name),
             email = COALESCE($2, email),
             age = COALESCE($3, age),
             gender = COALESCE($4, gender),
             service_area = COALESCE($5, service_area),
             latitude = COALESCE($6, latitude),
             longitude = COALESCE($7, longitude),
             role = 'PROFESSIONAL',
             updated_at = NOW()
         WHERE id = $8 RETURNING *`,
        [fullName, email || null, age || null, gender, targetLocation, lat, lng, user.id]
      );
      user = updateRes.rows[0];
    }

    let proRes = await client.query('SELECT * FROM professional_profiles WHERE user_id = $1', [user.id]);
    let pro = proRes.rows[0];

    if (!pro) {
      const insertProRes = await client.query(
        `INSERT INTO professional_profiles (id, user_id, verification_status, coverage_radius_km, assigned_region, service_area, latitude, longitude)
         VALUES ($1, $2, 'PENDING', 50.00, $3, $3, $4, $5) RETURNING *`,
        [`pro-${randomUUID().slice(0, 8)}`, user.id, targetLocation, lat, lng]
      );
      pro = insertProRes.rows[0];
    } else {
      const updateProRes = await client.query(
        `UPDATE professional_profiles
         SET service_area = COALESCE($1, service_area),
             assigned_region = COALESCE($1, assigned_region),
             latitude = COALESCE($2, latitude),
             longitude = COALESCE($3, longitude),
             updated_at = NOW()
         WHERE user_id = $4 RETURNING *`,
        [targetLocation, lat, lng, user.id]
      );
      pro = updateProRes.rows[0];
    }

    await client.query('COMMIT');

    console.log(`📱 [PRO-REGISTER-PHONE] Registered/Updated pro ${user.full_name} (${user.email || 'No Email'}) at location "${targetLocation || 'Not set'}"`);

    res.status(200).json({
      success: true,
      message: 'Professional profile details saved',
      data: {
        user,
        verificationStatus: pro ? pro.verification_status : 'PENDING',
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

app.post('/api/v1/auth/pro/register-phone', handleProRegisterPhone);
app.post('/api/v1/auth/register-phone', handleProRegisterPhone);

// 7. Firebase Login
app.post('/api/v1/auth/firebase-login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { idToken, role = 'CUSTOMER', fullName } = req.body;
    if (!idToken) throw new AppError('Firebase ID Token required', 400);

    const decoded = await getAuth().verifyIdToken(idToken);
    const phoneNumber = decoded.phone_number || `+9100000${Math.floor(10000 + Math.random() * 90000)}`;

    let userRes = await pool.query('SELECT * FROM users WHERE phone_number = $1', [phoneNumber]);
    let user = userRes.rows[0];

    if (!user) {
      const userId = `usr-${randomUUID().slice(0, 8)}`;
      const insertRes = await pool.query(
        `INSERT INTO users (id, phone_number, full_name, role, gender, is_active) VALUES ($1, $2, $3, $4, $5, true) RETURNING *`,
        [userId, phoneNumber, fullName || 'Firebase User', role, 'OTHER']
      );
      user = insertRes.rows[0];
    }

    const payload = { userId: user.id, role: user.role, phoneNumber: user.phone_number };
    res.json({
      success: true,
      data: {
        user,
        tokens: { accessToken: generateAccessToken(payload), refreshToken: generateRefreshToken(payload) }
      }
    });
  } catch (err) { next(err); }
});

// 8. Complete Customer Profile
app.post('/api/v1/auth/customer/complete-profile', authenticateToken, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { fullName, name, age, sex, gender, email, addressText, serviceArea, latitude, longitude } = req.body;
    const userId = req.user!.userId;
    const finalName = fullName || name;
    if (!finalName) throw new AppError('Full name is required', 400);

    const userGender = sex || gender || 'OTHER';
    const areaText = serviceArea || addressText || 'Thottikkanam, Kerala';
    const latVal = latitude ? latitude.toString() : '9.94840000';
    const lngVal = longitude ? longitude.toString() : '77.19310000';

    const updateRes = await pool.query(
      `UPDATE users
       SET full_name = $1,
           age = COALESCE($2, age),
           gender = $3,
           sex = $3,
           email = COALESCE($4, email),
           service_area = COALESCE($5, service_area),
           latitude = COALESCE($6, latitude),
           longitude = COALESCE($7, longitude),
           role = 'CUSTOMER',
           updated_at = NOW()
       WHERE id = $8 RETURNING *`,
      [finalName, age ? parseInt(age, 10) : null, userGender, email || null, areaText, latVal, lngVal, userId]
    );

    if (updateRes.rowCount === 0) throw new AppError('Customer user account not found', 404);

    // Save location into saved_locations
    const locId = `loc-${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO saved_locations (id, user_id, label, address_text, latitude, longitude, is_default)
       VALUES ($1, $2, 'Home', $3, $4, $5, true)
       ON CONFLICT (id) DO NOTHING`,
      [locId, userId, areaText, parseFloat(latVal), parseFloat(lngVal)]
    ).catch(() => {});

    console.log(`👤 [CUSTOMER-PROFILE-COMPLETED] Saved customer ${finalName} (${userId}) location [${areaText} (${latVal}, ${lngVal})] into PostgreSQL database`);

    res.json({
      success: true,
      message: 'Customer profile completed successfully',
      data: updateRes.rows[0],
    });
  } catch (err) { next(err); }
});

app.use(errorHandler);

// 8. Graceful Shutdown Implementation
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🛡️ Auth Service running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
});

const gracefulShutdown = (signal: string) => {
  server.close(() => process.exit(0));
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));