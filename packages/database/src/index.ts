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
        ALTER TABLE users ALTER COLUMN phone_number DROP NOT NULL;

        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS coverage_radius_km NUMERIC(5,2) DEFAULT 50.00;
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS assigned_region VARCHAR(100);
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS service_area TEXT;
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS latitude NUMERIC(10,8);
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS longitude NUMERIC(11,8);
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS requested_location TEXT;
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS requested_latitude NUMERIC(10,8);
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS requested_longitude NUMERIC(11,8);
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS location_change_status VARCHAR(30);
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS verification_notes TEXT;

        ALTER TABLE services ADD COLUMN IF NOT EXISTS per_km_rate NUMERIC(10,2) DEFAULT 15.00;
        ALTER TABLE services ADD COLUMN IF NOT EXISTS commission_type VARCHAR(20) DEFAULT 'FLAT';
        ALTER TABLE services ADD COLUMN IF NOT EXISTS commission_value NUMERIC(10,2) DEFAULT 50.00;
        ALTER TABLE services ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2) DEFAULT 15.00;

        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS travel_distance_km NUMERIC(6,2) DEFAULT 0.00;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS travel_charge NUMERIC(10,2) DEFAULT 0.00;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS base_amount NUMERIC(10,2) DEFAULT 0.00;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS platform_fee NUMERIC(10,2) DEFAULT 0.00;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS platform_fee_paid BOOLEAN DEFAULT FALSE;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS platform_fee_paid_at TIMESTAMPTZ;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS razorpay_platform_order_id VARCHAR(100);
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS razorpay_platform_payment_id VARCHAR(100);
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_amount NUMERIC(10,2) DEFAULT 0.00;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_paid BOOLEAN DEFAULT FALSE;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_paid_at TIMESTAMPTZ;
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS razorpay_balance_order_id VARCHAR(100);
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS razorpay_balance_payment_id VARCHAR(100);
        ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status VARCHAR(30) DEFAULT 'UNPAID';


        ALTER TABLE pro_offered_services ADD COLUMN IF NOT EXISTS km_charge_per_km NUMERIC(8,2) DEFAULT 15.00;
        ALTER TABLE pro_offered_services ADD COLUMN IF NOT EXISTS per_km_rate NUMERIC(8,2) DEFAULT 15.00;

        CREATE TABLE IF NOT EXISTS reviews (
            id VARCHAR(50) PRIMARY KEY,
            booking_id VARCHAR(50) NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
            customer_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            pro_id VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL,
            rating INT NOT NULL CHECK (rating >= 1 AND rating <= 5),
            comment TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS booking_reports (
            id VARCHAR(50) PRIMARY KEY,
            booking_id VARCHAR(50) NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
            reporter_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            reason TEXT NOT NULL,
            status VARCHAR(30) DEFAULT 'OPEN',
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS pro_offered_services (
            id VARCHAR(50) PRIMARY KEY,
            pro_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            service_id VARCHAR(50) NOT NULL,
            custom_price NUMERIC(10,2),
            per_km_rate NUMERIC(10,2) DEFAULT 15.00,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
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

        CREATE TABLE IF NOT EXISTS bookings (
            id VARCHAR(50) PRIMARY KEY,
            customer_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            pro_id VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL,
            service_id VARCHAR(50) NOT NULL,
            status VARCHAR(30) NOT NULL DEFAULT 'REQUESTED',
            scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            address_text TEXT NOT NULL DEFAULT '',
            latitude DOUBLE PRECISION NOT NULL DEFAULT 0.0,
            longitude DOUBLE PRECISION NOT NULL DEFAULT 0.0,
            female_pro_preferred BOOLEAN DEFAULT FALSE,
            start_otp VARCHAR(6) NOT NULL DEFAULT '1234',
            end_otp VARCHAR(6) NOT NULL DEFAULT '5678',
            total_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
            cancellation_reason TEXT,
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
