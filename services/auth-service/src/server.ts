import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool, initDatabaseTables } from '@lumo/database';
import { generateAccessToken, generateRefreshToken, AppError, errorHandler } from '@lumo/common';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { randomUUID } from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());

// Initialize Firebase Admin
if (getApps().length === 0) {
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

    const otp = '123456';
    const expiresAt = Date.now() + 5 * 60 * 1000;

    await pool.query(
      `INSERT INTO otps (phone_number, otp, expires_at) VALUES ($1, $2, $3)
       ON CONFLICT (phone_number) DO UPDATE SET otp = $2, expires_at = $3`,
      [phoneNumber, otp, expiresAt]
    );

    res.json({ success: true, message: 'OTP sent', debugOtp: otp });
  } catch (err) { next(err); }
});

app.post('/api/v1/auth/otp/verify', async (req, res, next) => {
  try {
    const { phoneNumber, otp, role = 'CUSTOMER', fullName, gender } = req.body;
    const otpRes = await pool.query('SELECT * FROM otps WHERE phone_number = $1', [phoneNumber]);
    const record = otpRes.rows[0];

    if (!record || record.otp !== otp) throw new AppError('Invalid OTP', 400);
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
        `INSERT INTO users (id, phone_number, email, full_name, role, gender, is_active) VALUES ($1, $2, $3, $4, $5, 'OTHER', true) RETURNING *`,
        [userId, phoneNumber, decoded.email, fullName || decoded.name || 'Firebase User', role]
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

app.listen(PORT, async () => {
  await initDatabaseTables();
  console.log(`🛡️ Auth Service running on port ${PORT}`);
});
