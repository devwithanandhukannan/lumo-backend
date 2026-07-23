import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { randomUUID, createHash } from 'crypto';
import { AppError, errorHandler, generateAccessToken, generateRefreshToken } from '@lumo/common';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://lumo_user:lumo_password@localhost:5432/lumo_db',
});

function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

// Firebase Admin Initialization
if (!process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
      const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
      initializeApp({ credential: cert(serviceAccount) });
    } else {
      initializeApp();
    }
  } catch (e) {}
}

app.get('/health', (req, res) => res.json({ status: 'UP', service: 'Auth Service' }));

// 1. Send OTP Request
app.post('/api/v1/auth/otp/send', async (req, res, next) => {
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

    console.log(`\n=======================================================`);
    console.log(`🔑 [ADMIN-AUTH-GATEWAY] Verification Code Generated for ${phoneNumber}:`);
    console.log(`👉 OTP CODE: >>> ${otp} <<<`);
    console.log(`=======================================================\n`);

    res.json({ success: true, message: 'OTP sent successfully', debugOtp: otp });
  } catch (err) { next(err); }
});

// 2. Verify OTP Request
app.post('/api/v1/auth/otp/verify', async (req, res, next) => {
  try {
    const { phoneNumber, otp, role = 'CUSTOMER', fullName, gender = 'OTHER' } = req.body;
    const otpRes = await pool.query('SELECT * FROM otps WHERE phone_number = $1', [phoneNumber]);
    const record = otpRes.rows[0];

    if (!record || record.otp !== otp) throw new AppError('Invalid OTP code', 400);
    await pool.query('DELETE FROM otps WHERE phone_number = $1', [phoneNumber]);

    let userRes = await pool.query('SELECT * FROM users WHERE phone_number = $1', [phoneNumber]);
    let user = userRes.rows[0];

    if (!user) {
      const userId = `usr-${randomUUID().slice(0, 8)}`;
      const insertRes = await pool.query(
        `INSERT INTO users (id, phone_number, full_name, role, gender, phone_verified, is_active)
         VALUES ($1, $2, $3, $4, $5, true, true) RETURNING *`,
        [userId, phoneNumber, fullName || 'New User', role, gender]
      );
      user = insertRes.rows[0];

      if (role === 'PROFESSIONAL') {
        await pool.query(
          `INSERT INTO professional_profiles (id, user_id, verification_status, coverage_radius_km)
           VALUES ($1, $2, 'PENDING', 50.00) ON CONFLICT (user_id) DO NOTHING`,
          [`pro-${randomUUID().slice(0, 8)}`, user.id]
        );
      }
    } else {
      await pool.query('UPDATE users SET phone_verified = true WHERE id = $1', [user.id]);
    }

    const payload = { userId: user.id, role: user.role, phoneNumber: user.phone_number };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    res.json({ success: true, data: { user, tokens: { accessToken, refreshToken } } });
  } catch (err) { next(err); }
});

// 3. Professional Email + Password Register
app.post('/api/v1/auth/pro/register', async (req, res, next) => {
  try {
    const { email, password, phoneNumber, fullName, gender = 'OTHER' } = req.body;
    if (!email || !password || !fullName) throw new AppError('Email, password and name are required', 400);

    const existing = await pool.query('SELECT * FROM users WHERE email = $1 OR (phone_number IS NOT NULL AND phone_number = $2)', [email, phoneNumber || '']);
    if (existing.rows.length > 0) throw new AppError('An account with this email or phone number already exists', 400);

    const userId = `usr-${randomUUID().slice(0, 8)}`;
    const passHash = hashPassword(password);

    const insertRes = await pool.query(
      `INSERT INTO users (id, email, password_hash, phone_number, full_name, role, gender, is_active)
       VALUES ($1, $2, $3, $4, $5, 'PROFESSIONAL', $6, true) RETURNING *`,
      [userId, email, passHash, phoneNumber || null, fullName, gender]
    );
    const user = insertRes.rows[0];

    await pool.query(
      `INSERT INTO professional_profiles (id, user_id, verification_status, coverage_radius_km, assigned_region)
       VALUES ($1, $2, 'PENDING', 50.00, 'Bangalore') ON CONFLICT (user_id) DO NOTHING`,
      [`pro-${randomUUID().slice(0, 8)}`, user.id]
    );

    const payload = { userId: user.id, role: user.role, email: user.email };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    res.status(201).json({
      success: true,
      data: {
        user,
        verificationStatus: 'PENDING',
        tokens: { accessToken, refreshToken }
      }
    });
  } catch (err) { next(err); }
});

// 4. Professional Email + Password Login
app.post('/api/v1/auth/pro/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) throw new AppError('Email and password required', 400);

    const userRes = await pool.query('SELECT * FROM users WHERE email = $1 AND role = \'PROFESSIONAL\'', [email]);
    const user = userRes.rows[0];

    if (!user || user.password_hash !== hashPassword(password)) {
      throw new AppError('Invalid email or password', 401);
    }

    const proRes = await pool.query('SELECT * FROM professional_profiles WHERE user_id = $1', [user.id]);
    const pro = proRes.rows[0];

    const payload = { userId: user.id, role: user.role, email: user.email };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    res.json({
      success: true,
      data: {
        user,
        verificationStatus: pro ? pro.verification_status : 'PENDING',
        coverageRadiusKm: pro ? parseFloat(pro.coverage_radius_km) : 50.0,
        tokens: { accessToken, refreshToken }
      }
    });
  } catch (err) { next(err); }
});

// 5. Send Email Code
app.post('/api/v1/auth/email/send', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) throw new AppError('Email address required', 400);

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;

    await pool.query(
      `INSERT INTO email_verifications (email, code, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET code = $2, expires_at = $3`,
      [email, code, expiresAt]
    );

    console.log(`📧 [EMAIL-VERIFY] Code for ${email}: >>> ${code} <<<`);

    res.json({ success: true, message: 'Verification email code sent', debugCode: code });
  } catch (err) { next(err); }
});

// 6. Verify Email Code
app.post('/api/v1/auth/email/verify', async (req, res, next) => {
  try {
    const { email, code } = req.body;
    const resVer = await pool.query('SELECT * FROM email_verifications WHERE email = $1', [email]);
    const rec = resVer.rows[0];

    if (!rec || rec.code !== code) throw new AppError('Invalid email verification code', 400);
    await pool.query('DELETE FROM email_verifications WHERE email = $1', [email]);
    await pool.query('UPDATE users SET email_verified = true WHERE email = $1', [email]);

    res.json({ success: true, message: 'Email verified successfully' });
  } catch (err) { next(err); }
});

// 7. Firebase Login
app.post('/api/v1/auth/firebase-login', async (req, res, next) => {
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
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    res.json({ success: true, data: { user, tokens: { accessToken, refreshToken } } });
  } catch (err) { next(err); }
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`🛡️ Auth Service running on port ${PORT}`);
});
