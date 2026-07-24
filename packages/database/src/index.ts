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
        ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS coverage_radius_km NUMERIC(5,2) DEFAULT 50.00;
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS assigned_region VARCHAR(100);
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS service_area TEXT;
        ALTER TABLE professional_profiles ADD COLUMN IF NOT EXISTS requested_location TEXT;
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

        CREATE TABLE IF NOT EXISTS service_categories (
            id VARCHAR(50) PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            description TEXT,
            icon_url TEXT,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS services (
            id VARCHAR(50) PRIMARY KEY,
            category_id VARCHAR(50) NOT NULL REFERENCES service_categories(id) ON DELETE CASCADE,
            name VARCHAR(100) NOT NULL,
            description TEXT,
            base_price NUMERIC(10,2) NOT NULL,
            duration_minutes INT NOT NULL DEFAULT 60,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );

        INSERT INTO service_categories (id, name, description) VALUES
        ('cat-clean', 'Cleaning Services', 'Home deep cleaning, kitchen & bathroom sanitization'),
        ('cat-elec', 'Electrical Repair', 'Wiring, switchboard, fan & appliance repairs'),
        ('cat-plumb', 'Plumbing Care', 'Tap leak fix, pipe repair & unblocking'),
        ('cat-salon', 'Salon & Spa', 'Home haircut, facial & grooming'),
        ('cat-safe', 'Safety Services', 'Verified safety escort & security')
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO services (id, category_id, name, description, base_price, duration_minutes) VALUES
        ('srv-clean-01', 'cat-clean', 'Home Deep Cleaning', 'Full house deep cleaning & sanitization', 499.00, 120),
        ('srv-clean-02', 'cat-clean', 'Kitchen Cleaning', 'Degreasing, counter & appliance cleaning', 349.00, 60),
        ('srv-elec-01', 'cat-elec', 'Switch & Socket Repair', 'Fix loose wiring, burnt sockets & switches', 199.00, 30),
        ('srv-elec-02', 'cat-elec', 'Fan Installation & Repair', 'Ceiling/exhaust fan mounting & regulator fix', 249.00, 45),
        ('srv-plumb-01', 'cat-plumb', 'Tap Leak Fix', 'Repair leaking taps, replace washers & valves', 249.00, 30),
        ('srv-plumb-02', 'cat-plumb', 'Pipe Leak Repair', 'Fix PVC/metal pipe joints & drainage leaks', 349.00, 60)
        ON CONFLICT (id) DO NOTHING;
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
