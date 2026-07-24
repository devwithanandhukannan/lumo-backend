-- Enable PostGIS Extension
CREATE EXTENSION IF NOT EXISTS postgis;

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(50) PRIMARY KEY,
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE,
    full_name VARCHAR(100) NOT NULL,
    role VARCHAR(30) NOT NULL,
    gender VARCHAR(20),
    age INT,
    sex VARCHAR(20),
    avatar_url TEXT,
    email_verified BOOLEAN DEFAULT FALSE,
    phone_verified BOOLEAN DEFAULT FALSE,
    password_hash TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed Default Super Admin User for Authentication Validation
INSERT INTO users (id, phone_number, email, full_name, role)
VALUES ('usr-admin-001', '+919999999999', 'admin@lumo.in', 'Super Admin', 'SUPER_ADMIN')
ON CONFLICT (id) DO NOTHING;

-- 2. OTP Store
CREATE TABLE IF NOT EXISTS otps (
    phone_number VARCHAR(20) PRIMARY KEY,
    otp VARCHAR(10) NOT NULL,
    expires_at BIGINT NOT NULL
);

-- 3. Refresh Tokens Store
CREATE TABLE IF NOT EXISTS refresh_tokens (
    token TEXT PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
);

-- 4. Saved Locations Table
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

-- 5. Professional Profiles Table
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
    service_area TEXT,
    assigned_region TEXT,
    requested_location TEXT,
    location_change_status VARCHAR(30),
    location_change_reason TEXT,
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

-- 5b. Location Change Requests Table
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

-- 5c. Pro Offered Services (with commission hidden from pros)
ALTER TABLE IF EXISTS services ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2) DEFAULT 15.00;

-- 5d. Pending Custom Service Requests from Professionals
CREATE TABLE IF NOT EXISTS pending_service_requests (
    id VARCHAR(50) PRIMARY KEY,
    pro_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_name VARCHAR(100) NOT NULL,
    description TEXT,
    suggested_price NUMERIC(10,2),
    category_id VARCHAR(50) REFERENCES service_categories(id),
    status VARCHAR(30) DEFAULT 'PENDING_ADMIN_APPROVAL',
    admin_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Training Modules Table
CREATE TABLE IF NOT EXISTS training_modules (
    id VARCHAR(50) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    duration_minutes INT NOT NULL,
    category VARCHAR(50) NOT NULL,
    passing_score INT NOT NULL,
    is_required BOOLEAN DEFAULT TRUE
);

-- 7. User Training Progress Table
CREATE TABLE IF NOT EXISTS user_training_progress (
    user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module_id VARCHAR(50) NOT NULL REFERENCES training_modules(id) ON DELETE CASCADE,
    score INT NOT NULL,
    passed BOOLEAN NOT NULL,
    completed_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, module_id)
);

-- 8. System Settings & Dynamic API Keys Table
CREATE TABLE IF NOT EXISTS system_settings (
    setting_key VARCHAR(100) PRIMARY KEY,
    setting_value TEXT NOT NULL,
    description TEXT,
    is_encrypted BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default Google Maps API key
INSERT INTO system_settings (setting_key, setting_value, description)
VALUES ('GOOGLE_MAPS_API_KEY', 'AIzaSyD9r59vIxUjLj3hiICvy9CYbXYbmil0Xb4', 'Google Maps Platform API Key for Geocoding & Distance Matrix')
ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value;

-- 9. Service Categories Table
CREATE TABLE IF NOT EXISTS service_categories (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    icon_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. Services Catalog Table
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

-- 11. Bookings Table
CREATE TABLE IF NOT EXISTS bookings (
    id VARCHAR(50) PRIMARY KEY,
    customer_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pro_id VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL,
    service_id VARCHAR(50) NOT NULL REFERENCES services(id),
    status VARCHAR(30) NOT NULL DEFAULT 'REQUESTED',
    scheduled_at TIMESTAMPTZ NOT NULL,
    address_text TEXT NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    female_pro_preferred BOOLEAN DEFAULT FALSE,
    start_otp VARCHAR(6) NOT NULL,
    end_otp VARCHAR(6) NOT NULL,
    total_amount NUMERIC(10,2) NOT NULL,
    cancellation_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 12. Booking State History Table
CREATE TABLE IF NOT EXISTS booking_state_logs (
    id VARCHAR(50) PRIMARY KEY,
    booking_id VARCHAR(50) NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    status VARCHAR(30) NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 13. SOS Alerts Table
CREATE TABLE IF NOT EXISTS sos_alerts (
    id VARCHAR(50) PRIMARY KEY,
    booking_id VARCHAR(50) REFERENCES bookings(id) ON DELETE CASCADE,
    triggered_by_user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    trigger_latitude DOUBLE PRECISION NOT NULL,
    trigger_longitude DOUBLE PRECISION NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

-- 14. Misconduct Incidents Table
CREATE TABLE IF NOT EXISTS misconduct_incidents (
    id VARCHAR(50) PRIMARY KEY,
    booking_id VARCHAR(50) NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    reported_by_user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    against_user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    severity VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
    description TEXT NOT NULL,
    proof_urls JSONB DEFAULT '[]'::jsonb,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING_REVIEW',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
