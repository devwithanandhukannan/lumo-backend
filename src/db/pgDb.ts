import { Pool } from 'pg';
import { config } from '../config';

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.name,
  user: config.db.user,
  password: config.db.password,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('connect', () => {
  console.log('🐘 PostgreSQL client connected to database');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected PostgreSQL pool error:', err);
});

export const initDatabaseTables = async () => {
  const client = await pool.connect();
  try {
    console.log('🚀 Initializing PostgreSQL tables...');

    await client.query(`
      CREATE EXTENSION IF NOT EXISTS postgis;

      CREATE TABLE IF NOT EXISTS users (
          id VARCHAR(50) PRIMARY KEY,
          phone_number VARCHAR(20) UNIQUE,
          email VARCHAR(255) UNIQUE,
          password_hash VARCHAR(255),
          full_name VARCHAR(100) NOT NULL,
          role VARCHAR(30) NOT NULL,
          gender VARCHAR(20) DEFAULT 'OTHER',
          avatar_url TEXT,
          email_verified BOOLEAN DEFAULT FALSE,
          phone_verified BOOLEAN DEFAULT FALSE,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(20) DEFAULT 'OTHER';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS age INT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS sex VARCHAR(20);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
      ALTER TABLE users ALTER COLUMN phone_number DROP NOT NULL;

      CREATE TABLE IF NOT EXISTS otps (
          phone_number VARCHAR(20) PRIMARY KEY,
          otp VARCHAR(10) NOT NULL,
          expires_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS email_verifications (
          email VARCHAR(255) PRIMARY KEY,
          code VARCHAR(10) NOT NULL,
          expires_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
          token TEXT PRIMARY KEY,
          user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS saved_locations (
          id VARCHAR(50) PRIMARY KEY,
          user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          label VARCHAR(50) NOT NULL,
          address_text TEXT NOT NULL,
          latitude DOUBLE PRECISION NOT NULL,
          longitude DOUBLE PRECISION NOT NULL,
          is_default BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS professional_profiles (
          id VARCHAR(50) PRIMARY KEY,
          user_id VARCHAR(50) UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          verification_status VARCHAR(30) DEFAULT 'PENDING',
          verification_notes TEXT,
          documents JSONB DEFAULT '{}'::jsonb,
          face_verification_url TEXT,
          face_verified BOOLEAN DEFAULT FALSE,
          coverage_radius_km NUMERIC(5,2) DEFAULT 50.00,
          assigned_region VARCHAR(100) DEFAULT 'Bangalore',
          is_online BOOLEAN DEFAULT FALSE,
          is_busy BOOLEAN DEFAULT FALSE,
          current_location JSONB,
          rating_avg NUMERIC(3,2) DEFAULT 5.0,
          total_jobs_completed INT DEFAULT 0,
          acceptance_rate NUMERIC(5,2) DEFAULT 100.0,
          cancellation_rate NUMERIC(5,2) DEFAULT 0.0,
          account_health_score NUMERIC(5,2) DEFAULT 100.0,
          is_blacklisted BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS pro_offered_services (
          id VARCHAR(50) PRIMARY KEY,
          pro_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          service_id VARCHAR(50) NOT NULL,
          custom_price NUMERIC(10,2),
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE (pro_id, service_id)
      );

      -- Add columns if missing in case tables already existed
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS coverage_radius_km NUMERIC(5,2) DEFAULT 50.00;
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS assigned_region VARCHAR(100) DEFAULT 'Bangalore';

      -- Update 8: Proper lat/lng columns on professional_profiles for proximity queries
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
      ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS service_area VARCHAR(200);

      -- Update 1: Per-professional per-service km charge
      ALTER TABLE pro_offered_services ADD COLUMN IF NOT EXISTS km_charge_per_km NUMERIC(8,2) DEFAULT 15.00;
      ALTER TABLE pro_offered_services ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

      -- Update 1/5/6: Booking columns for distance, charge breakdown, customer sex, chosen pro
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS distance_km NUMERIC(6,2);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS travel_charge NUMERIC(10,2) DEFAULT 0;
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_sex VARCHAR(20);
      ALTER TABLE bookings ADD COLUMN IF NOT EXISTS selected_pro_id VARCHAR(50);
    `);

    console.log('✅ PostgreSQL database schema ready!');
  } catch (err) {
    console.error('❌ Error initializing PostgreSQL tables:', err);
  } finally {
    client.release();
  }
};
