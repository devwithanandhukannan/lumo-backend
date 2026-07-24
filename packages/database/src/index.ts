import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'lumo_db',
  user: process.env.DB_USER || 'lumo_user',
  password: process.env.DB_PASSWORD || 'lumo_password',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const initDatabaseTables = async (): Promise<void> => {
  try {
    const client = await pool.connect();
    try {
      const sqlPath = path.join(__dirname, 'init.sql');
      if (fs.existsSync(sqlPath)) {
        const sql = fs.readFileSync(sqlPath, 'utf8');
        await client.query(sql);
      }
      // Self-healing schema migrations for legacy database instances
      await client.query(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(20) DEFAULT 'OTHER';
        ALTER TABLE users ADD COLUMN IF NOT EXISTS age INT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS sex VARCHAR(20);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS service_area TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,8);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS longitude NUMERIC(11,8);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS coverage_radius_km NUMERIC(5,2) DEFAULT 50.00;
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS assigned_region VARCHAR(100);
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS service_area TEXT;
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,8);
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS longitude NUMERIC(11,8);
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS requested_location TEXT;
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS requested_latitude NUMERIC(10,8);
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS requested_longitude NUMERIC(11,8);
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS location_change_status VARCHAR(30);
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS location_change_reason TEXT;
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS verification_notes TEXT;

        CREATE TABLE IF NOT EXISTS pro_offered_services (
            id VARCHAR(50) PRIMARY KEY,
            pro_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            service_id VARCHAR(50) NOT NULL REFERENCES services(id) ON DELETE CASCADE,
            custom_price NUMERIC(10,2),
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (pro_id, service_id)
        );

        CREATE TABLE IF NOT EXISTS pro_location_change_requests (
            id VARCHAR(50) PRIMARY KEY,
            pro_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            current_location TEXT,
            requested_location TEXT NOT NULL,
            latitude NUMERIC(10,8),
            longitude NUMERIC(11,8),
            status VARCHAR(30) DEFAULT 'PENDING_ADMIN_APPROVAL',
            admin_reason TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS pending_service_requests (
            id VARCHAR(50) PRIMARY KEY,
            pro_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            service_name VARCHAR(100) NOT NULL,
            description TEXT,
            suggested_price NUMERIC(10,2),
            category_id VARCHAR(50),
            status VARCHAR(30) DEFAULT 'PENDING_ADMIN_APPROVAL',
            admin_notes TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
      `);
      console.log('🐘 PostgreSQL database tables & schema migrations initialized successfully');
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.warn('⚠️ Database connection or table initialization warning:', err.message);
  }
};

// Trigger table initialization on pool import
initDatabaseTables();
