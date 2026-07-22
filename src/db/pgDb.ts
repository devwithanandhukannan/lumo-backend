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
          phone_number VARCHAR(20) UNIQUE NOT NULL,
          email VARCHAR(255) UNIQUE,
          full_name VARCHAR(100) NOT NULL,
          role VARCHAR(30) NOT NULL,
          gender VARCHAR(20),
          avatar_url TEXT,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS otps (
          phone_number VARCHAR(20) PRIMARY KEY,
          otp VARCHAR(10) NOT NULL,
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

      CREATE TABLE IF NOT EXISTS training_modules (
          id VARCHAR(50) PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          description TEXT,
          duration_minutes INT NOT NULL,
          category VARCHAR(50) NOT NULL,
          passing_score INT NOT NULL,
          is_required BOOLEAN DEFAULT TRUE
      );

      CREATE TABLE IF NOT EXISTS user_training_progress (
          user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          module_id VARCHAR(50) NOT NULL REFERENCES training_modules(id) ON DELETE CASCADE,
          score INT NOT NULL,
          passed BOOLEAN NOT NULL,
          completed_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (user_id, module_id)
      );
    `);

    console.log('✅ PostgreSQL database schema ready!');
  } catch (err) {
    console.error('❌ Error initializing PostgreSQL tables:', err);
    throw err;
  } finally {
    client.release();
  }
};
