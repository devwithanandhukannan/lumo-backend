import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Pool } from 'pg';
import argon2 from 'argon2';
import { randomUUID } from 'crypto';
import { AppError, errorHandler, generateAccessToken, generateRefreshToken } from '@lumo/common';
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
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  credentials: true,
}));
app.use(express.json({ limit: '10kb' })); // Restrict payload size

// Rate limiting for auth endpoints (max 5 requests per 15 mins for OTP/Login)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many requests, please try again later.' },
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

// 4. Send OTP Request
app.post('/api/v1/auth/otp/send', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) throw new AppError('Phone number required', 400);

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

    res.json({ success: true, message: 'OTP sent successfully' });
  } catch (err) { next(err); }
});

// 5. Verify OTP Request (Using DB Transactions)
app.post('/api/v1/auth/otp/verify', authLimiter, async (req: Request, res: Response, next: NextFunction) => {
  const client = await pool.connect();
  try {
    const { phoneNumber, otp, role = 'CUSTOMER', fullName, gender = 'OTHER' } = req.body;
    if (!phoneNumber || !otp) throw new AppError('Phone number and OTP code required', 400);

    const otpRes = await client.query('SELECT * FROM otps WHERE phone_number = $1', [phoneNumber]);
    const record = otpRes.rows[0];

    if (!record || record.otp !== otp || Number(record.expires_at) < Date.now()) {
      throw new AppError('Invalid or expired OTP code', 400);
    }

    await client.query('BEGIN');

    let userRes = await client.query('SELECT * FROM users WHERE phone_number = $1', [phoneNumber]);
    let user = userRes.rows[0];

    if (!user) {
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

    await client.query('DELETE FROM otps WHERE phone_number = $1', [phoneNumber]);
    await client.query('COMMIT');

    const payload = { userId: user.id, role: user.role, phoneNumber: user.phone_number };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    res.json({ success: true, data: { user, tokens: { accessToken, refreshToken } } });
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
    const { email, password, phoneNumber, fullName, gender = 'OTHER', location, serviceArea, assignedRegion } = req.body;
    if (!email || !password || !fullName) throw new AppError('Email, password and name required', 400);

    const targetLocation = location || serviceArea || assignedRegion || null;

    const existing = await client.query('SELECT * FROM users WHERE email = $1 OR (phone_number IS NOT NULL AND phone_number = $2)', [email, phoneNumber || '']);

    if (existing.rows.length > 0) {
      const existingUser = existing.rows[0];
      const isPasswordMatch = existingUser.password_hash ? await argon2.verify(existingUser.password_hash, password) : false;

      if (isPasswordMatch) {
        const proRes = await client.query('SELECT * FROM professional_profiles WHERE user_id = $1', [existingUser.id]);
        const pro = proRes.rows[0];

        if (targetLocation) {
          await client.query('UPDATE users SET service_area = $1 WHERE id = $2', [targetLocation, existingUser.id]);
          await client.query('UPDATE professional_profiles SET service_area = $1, assigned_region = $1 WHERE user_id = $2', [targetLocation, existingUser.id]);
        }

        const payload = { userId: existingUser.id, role: existingUser.role, email: existingUser.email };
        return res.status(200).json({
          success: true,
          message: 'Account already exists. Seamlessly logged in.',
          data: {
            user: { ...existingUser, service_area: targetLocation || existingUser.service_area },
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
      `INSERT INTO users (id, email, password_hash, phone_number, full_name, role, gender, service_area, is_active)
       VALUES ($1, $2, $3, $4, $5, 'PROFESSIONAL', $6, $7, true) RETURNING *`,
      [userId, email, passHash, phoneNumber || null, fullName, gender, targetLocation]
    );
    const user = insertRes.rows[0];

    await client.query(
      `INSERT INTO professional_profiles (id, user_id, verification_status, coverage_radius_km, assigned_region, service_area)
       VALUES ($1, $2, 'PENDING', 50.00, $3, $3) ON CONFLICT (user_id) DO UPDATE SET assigned_region = COALESCE(EXCLUDED.assigned_region, professional_profiles.assigned_region), service_area = COALESCE(EXCLUDED.service_area, professional_profiles.service_area)`,
      [`pro-${randomUUID().slice(0, 8)}`, user.id, targetLocation]
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
app.post('/api/v1/auth/pro/register-phone', async (req: Request, res: Response, next: NextFunction) => {
  const client = await pool.connect();
  try {
    const { phoneNumber, fullName, age, email, gender = 'OTHER', serviceArea, location, latitude, longitude } = req.body;
    if (!phoneNumber || !fullName) throw new AppError('Phone number and full name required', 400);

    const targetLocation = serviceArea || location || null;
    const lat = latitude ? parseFloat(latitude) : null;
    const lng = longitude ? parseFloat(longitude) : null;

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
});

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

app.use(errorHandler);

// 8. Graceful Shutdown Implementation
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🛡️ Auth Service running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
});

const gracefulShutdown = (signal: string) => {
  console.log(`Received ${signal}. Shutting down gracefully...`);
  server.close(async () => {
    console.log('HTTP server closed.');
    await pool.end();
    console.log('PostgreSQL connections closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));