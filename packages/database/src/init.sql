-- Enable PostGIS Extension
CREATE EXTENSION IF NOT EXISTS postgis;

-- 1. Users Table
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

-- Seed Default Super Admin User
INSERT INTO users (id, phone_number, email, full_name, role, gender, email_verified, phone_verified)
VALUES ('usr-admin-001', '+919999999999', 'admin@lumo.in', 'Super Admin', 'SUPER_ADMIN', 'MALE', TRUE, TRUE)
ON CONFLICT (id) DO NOTHING;

-- 2. OTP Store
CREATE TABLE IF NOT EXISTS otps (
    phone_number VARCHAR(20) PRIMARY KEY,
    otp VARCHAR(10) NOT NULL,
    expires_at BIGINT NOT NULL
);

-- Email Verification Store
CREATE TABLE IF NOT EXISTS email_verifications (
    email VARCHAR(255) PRIMARY KEY,
    code VARCHAR(10) NOT NULL,
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

-- 6. Professional Offered Services & Custom Rates Table
CREATE TABLE IF NOT EXISTS pro_offered_services (
    id VARCHAR(50) PRIMARY KEY,
    pro_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id VARCHAR(50) NOT NULL,
    custom_price NUMERIC(10,2),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (pro_id, service_id)
);

-- 7. Training Modules Table
CREATE TABLE IF NOT EXISTS training_modules (
    id VARCHAR(50) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    duration_minutes INT NOT NULL,
    category VARCHAR(50) NOT NULL,
    passing_score INT NOT NULL,
    is_required BOOLEAN DEFAULT TRUE
);

-- 8. User Training Progress Table
CREATE TABLE IF NOT EXISTS user_training_progress (
    user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    module_id VARCHAR(50) NOT NULL REFERENCES training_modules(id) ON DELETE CASCADE,
    score INT NOT NULL,
    passed BOOLEAN NOT NULL,
    completed_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, module_id)
);

-- 9. System Settings Table
CREATE TABLE IF NOT EXISTS system_settings (
    setting_key VARCHAR(100) PRIMARY KEY,
    setting_value TEXT NOT NULL,
    description TEXT,
    is_encrypted BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO system_settings (setting_key, setting_value, description)
VALUES ('GOOGLE_MAPS_API_KEY', 'AIzaSyD9r59vIxUjLj3hiICvy9CYbXYbmil0Xb4', 'Google Maps Platform API Key for Geocoding & Distance Matrix')
ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value;

-- 10. Service Categories Table
CREATE TABLE IF NOT EXISTS service_categories (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    icon_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed Initial Categories
INSERT INTO service_categories (id, name, description) VALUES
('cat-clean', 'Cleaning Services', 'Home deep cleaning, kitchen & bathroom sanitization'),
('cat-elec', 'Electrical Repair', 'Wiring, switchboard, fan & appliance repairs'),
('cat-plumb', 'Plumbing Care', 'Tap leak fix, pipe repair & unblocking'),
('cat-salon', 'Salon & Spa', 'Home haircut, facial & grooming'),
('cat-safety', 'Safety Escort', 'Verified women safety escort & night security')
ON CONFLICT (id) DO NOTHING;

-- 11. Services Catalog Table
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

INSERT INTO services (id, category_id, name, description, base_price, duration_minutes) VALUES
('srv-clean-01', 'cat-clean', 'Home Deep Cleaning', 'Full house deep cleaning & sanitization', 499.00, 120),
('srv-clean-02', 'cat-clean', 'Kitchen Cleaning', 'Degreasing, counter & appliance cleaning', 349.00, 60),
('srv-elec-01', 'cat-elec', 'Switch & Socket Repair', 'Fix loose wiring, burnt sockets & switches', 199.00, 30),
('srv-elec-02', 'cat-elec', 'Fan Installation & Repair', 'Ceiling/exhaust fan mounting & regulator fix', 249.00, 45),
('srv-plumb-01', 'cat-plumb', 'Tap Leak Fix', 'Repair leaking taps, replace washers & valves', 249.00, 30),
('srv-plumb-02', 'cat-plumb', 'Pipe Leak Repair', 'Fix PVC/metal pipe joints & drainage leaks', 349.00, 60),
('srv-salon-01', 'cat-salon', 'Home Haircut (Female)', 'Professional hair trimming & styling at home', 499.00, 60),
('srv-safe-01', 'cat-safety', 'Women Safety Escort', 'Verified female safety escort for night travel', 999.00, 120)
ON CONFLICT (id) DO NOTHING;

-- 12. Bookings Table
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

-- 13. Booking State History Table
CREATE TABLE IF NOT EXISTS booking_state_logs (
    id VARCHAR(50) PRIMARY KEY,
    booking_id VARCHAR(50) NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    status VARCHAR(30) NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 14. SOS Alerts Table
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

-- 15. Misconduct Incidents Table
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
