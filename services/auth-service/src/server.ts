import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
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

// Auth API Endpoints
app.post('/api/v1/auth/otp/send', async (req, res, next) => {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) throw new AppError('Phone number required', 400);

    // Generate random 6-digit verification code
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000;

    await pool.query(
      `INSERT INTO otps (phone_number, otp, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (phone_number) DO UPDATE SET otp = $2, expires_at = $3`,
      [phoneNumber, otp, expiresAt]
    );

    // Print to backend terminal server console for developer copy-paste
    console.log(`\n=======================================================`);
    console.log(`🔑 [ADMIN-AUTH-GATEWAY] Verification Code Generated for ${phoneNumber}:`);
    console.log(`👉 OTP CODE: >>> ${otp} <<<`);
    console.log(`=======================================================\n`);

    res.json({ success: true, message: 'OTP sent to terminal console' });
  } catch (err) { next(err); }
});

app.post('/api/v1/auth/otp/verify', async (req, res, next) => {
  try {
    const { phoneNumber, otp, role = 'CUSTOMER', fullName, gender } = req.body;
    const otpRes = await pool.query('SELECT * FROM otps WHERE phone_number = $1', [phoneNumber]);
    const record = otpRes.rows[0];

    if (!record || record.otp !== otp) throw new AppError('Invalid OTP code', 400);
    await pool.query('DELETE FROM otps WHERE phone_number = $1', [phoneNumber]);

    let userRes = await pool.query('SELECT * FROM users WHERE phone_number = $1', [phoneNumber]);
    let user = userRes.rows[0];

    if (!user) {
      const userId = `usr-${randomUUID().slice(0, 8)}`;
      const insertRes = await pool.query(
        `INSERT INTO users (id, phone_number, full_name, role, gender, is_active) VALUES ($1, $2, $3, $4, $5, true) RETURNING *`,
        [userId, phoneNumber, fullName || 'New User', role, gender || 'OTHER']
      );
      user = insertRes.rows[0];

      if (role === 'PROFESSIONAL') {
        await pool.query(
          `INSERT INTO professional_profiles (id, user_id, verification_status) VALUES ($1, $2, 'PENDING')`,
          [`pro-${randomUUID().slice(0, 8)}`, user.id]
        );
      }
    }

    const payload = { userId: user.id, role: user.role, phoneNumber: user.phone_number };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    res.json({ success: true, data: { user, tokens: { accessToken, refreshToken } } });
  } catch (err) { next(err); }
});

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
