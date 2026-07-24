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

async function ensureSchema() {
  try {
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(20) DEFAULT 'OTHER';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS age INT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS sex VARCHAR(20);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

      CREATE TABLE IF NOT EXISTS professional_profiles (
          id VARCHAR(50) PRIMARY KEY,
          user_id VARCHAR(50) UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          verification_status VARCHAR(30) DEFAULT 'PENDING',
          verification_notes TEXT,
          documents JSONB DEFAULT '{}'::jsonb,
          face_verification_url TEXT,
          face_verified BOOLEAN DEFAULT FALSE,
          is_online BOOLEAN DEFAULT FALSE,
          is_busy BOOLEAN DEFAULT FALSE,
          current_location JSONB,
          service_area TEXT DEFAULT 'Bangalore',
          assigned_region TEXT DEFAULT 'Bangalore',
          coverage_radius_km NUMERIC(6,2) DEFAULT 50.00,
          rating_avg NUMERIC(3,2) DEFAULT 5.0,
          total_jobs_completed INT DEFAULT 0,
          acceptance_rate NUMERIC(5,2) DEFAULT 100.0,
          cancellation_rate NUMERIC(5,2) DEFAULT 0.0,
          account_health_score NUMERIC(5,2) DEFAULT 100.0,
          is_blacklisted BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS verification_status VARCHAR(30) DEFAULT 'PENDING';
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS verification_notes TEXT;
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS documents JSONB DEFAULT '{}'::jsonb;
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS face_verification_url TEXT;
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS face_verified BOOLEAN DEFAULT FALSE;
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT FALSE;
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS is_busy BOOLEAN DEFAULT FALSE;
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS current_location JSONB;
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS service_area TEXT DEFAULT 'Bangalore';
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS assigned_region TEXT DEFAULT 'Bangalore';
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS coverage_radius_km NUMERIC(6,2) DEFAULT 50.00;
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS rating_avg NUMERIC(3,2) DEFAULT 5.0;
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS total_jobs_completed INT DEFAULT 0;
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS acceptance_rate NUMERIC(5,2) DEFAULT 100.0;
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS cancellation_rate NUMERIC(5,2) DEFAULT 0.0;
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS account_health_score NUMERIC(5,2) DEFAULT 100.0;
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS is_blacklisted BOOLEAN DEFAULT FALSE;
    `);
  } catch (err: any) {
    console.warn('⚠️ Schema migration warning:', err.message);
  }
}

// Run schema migration on startup
ensureSchema();

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
    await ensureSchema();
    const { phoneNumber, otp, role = 'CUSTOMER', fullName, gender = 'OTHER' } = req.body;
    const otpRes = await pool.query('SELECT * FROM otps WHERE phone_number = $1', [phoneNumber]);
    const record = otpRes.rows[0];

    if (!record || record.otp !== otp) throw new AppError('Invalid OTP code', 400);

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

    // Clear OTP after user creation/verification succeeds
    await pool.query('DELETE FROM otps WHERE phone_number = $1', [phoneNumber]);

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

    // Auto-migrate column if missing
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)').catch(() => {});

    const passHash = hashPassword(password);
    const existing = await pool.query('SELECT * FROM users WHERE email = $1 OR (phone_number IS NOT NULL AND phone_number = $2)', [email, phoneNumber || '']);
    
    if (existing.rows.length > 0) {
      const existingUser = existing.rows[0];
      // If password matches existing account, seamlessly log in
      if (existingUser.password_hash === passHash) {
        const proRes = await pool.query('SELECT * FROM professional_profiles WHERE user_id = $1', [existingUser.id]);
        const pro = proRes.rows[0];

        const payload = { userId: existingUser.id, role: existingUser.role, email: existingUser.email };
        const accessToken = generateAccessToken(payload);
        const refreshToken = generateRefreshToken(payload);

        return res.status(200).json({
          success: true,
          message: 'Account already exists. Seamlessly logged in.',
          data: {
            user: existingUser,
            verificationStatus: pro ? pro.verification_status : 'PENDING',
            tokens: { accessToken, refreshToken }
          }
        });
      }
      throw new AppError('An account with this email address already exists. Please tap Sign In.', 400);
    }

    const userId = `usr-${randomUUID().slice(0, 8)}`;

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

// 8. Pro Register Phone (Step 2 Onboarding Update)
app.post('/api/v1/auth/pro/register-phone', async (req, res, next) => {
  try {
    await ensureSchema();
    const { phoneNumber, fullName, age, email, gender, serviceArea } = req.body;
    if (!phoneNumber || !fullName) throw new AppError('Phone number and full name required', 400);

    let userRes = await pool.query('SELECT * FROM users WHERE phone_number = $1', [phoneNumber]);
    let user = userRes.rows[0];

    if (user) {
      const selectedArea = serviceArea && serviceArea.trim() !== '' ? serviceArea.trim() : 'Kochi, Kerala';

      const updateRes = await pool.query(
        `UPDATE users 
         SET full_name = $1, age = $2, email = COALESCE($3, email), gender = $4, service_area = $5, updated_at = NOW() 
         WHERE id = $6 RETURNING *`,
        [fullName, age || null, email || null, gender || 'MALE', selectedArea, user.id]
      );
      user = updateRes.rows[0];

      await pool.query(
        `INSERT INTO professional_profiles (id, user_id, verification_status, coverage_radius_km, assigned_region, service_area)
         VALUES ($1, $2, 'PENDING', 50.00, $3, $3)
         ON CONFLICT (user_id) DO UPDATE SET assigned_region = $3, service_area = $3, updated_at = NOW()`,
        [`pro-${randomUUID().slice(0, 8)}`, user.id, selectedArea]
      );
    } else {
      const userId = `usr-${randomUUID().slice(0, 8)}`;
      const insertRes = await pool.query(
        `INSERT INTO users (id, phone_number, full_name, age, email, role, gender, service_area, phone_verified, is_active)
         VALUES ($1, $2, $3, $4, $5, 'PROFESSIONAL', $6, $7, true, true) RETURNING *`,
        [userId, phoneNumber, fullName, age || null, email || null, gender || 'MALE', serviceArea || 'Bangalore']
      );
      user = insertRes.rows[0];
    }

    await pool.query(
      `INSERT INTO professional_profiles (id, user_id, verification_status, service_area, coverage_radius_km)
       VALUES ($1, $2, 'PENDING', $3, 50.00)
       ON CONFLICT (user_id) DO UPDATE SET service_area = $3`,
      [`pro-${randomUUID().slice(0, 8)}`, user.id, serviceArea || 'Bangalore']
    );

    const payload = { userId: user.id, role: user.role, phoneNumber: user.phone_number };
    const accessToken = generateAccessToken(payload);
    const refreshToken = generateRefreshToken(payload);

    res.json({
      success: true,
      data: {
        user,
        verificationStatus: 'PENDING',
        tokens: { accessToken, refreshToken }
      }
    });
  } catch (err) { next(err); }
});

// 9. Customer Complete Profile
app.post('/api/v1/auth/customer/complete-profile', async (req, res, next) => {
  try {
    await ensureSchema();
    const { fullName, age, sex, email } = req.body;
    const userId = (req as any).user?.userId;

    if (!userId) {
      return res.json({ success: true, message: 'Profile updated locally' });
    }

    const updateRes = await pool.query(
      `UPDATE users 
       SET full_name = COALESCE($1, full_name), age = COALESCE($2, age), sex = COALESCE($3, sex), email = COALESCE($4, email), updated_at = NOW() 
       WHERE id = $5 RETURNING *`,
      [fullName, age, sex, email, userId]
    );

    res.json({ success: true, data: updateRes.rows[0] });
  } catch (err) { next(err); }
});

app.use(errorHandler);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🛡️ Auth Service running on port ${PORT}`);
});
