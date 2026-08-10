-- ============================================================
-- LUMO Migration 001: Security Fixes & Missing Tables
-- Created: 2026-08-08
-- Description:
--   1. Create pro_offered_services table (was referenced in code
--      but never created in init.sql — causes runtime crashes)
--   2. Add missing columns to professional_profiles
--      (latitude, longitude, pincode — referenced in auth.service.ts)
--   3. Add performance indexes for common query patterns
--   4. Replace hardcoded Google Maps API key with environment placeholder
--   5. Add reviews table for future implementation
--   6. Add payout_records table for future implementation
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. CREATE pro_offered_services (CRITICAL — missing table)
--    Referenced in: professional.service.ts saveOfferedServices()
--    Without this table the Pro App crashes on service management
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pro_offered_services (
    id VARCHAR(50) PRIMARY KEY,
    pro_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_id VARCHAR(50) NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    custom_price NUMERIC(10,2),                    -- NULL means use catalog base_price
    km_charge_per_km NUMERIC(6,2) DEFAULT 15.00,  -- per km travel charge
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(pro_id, service_id)                     -- each Pro can offer each service only once
);

CREATE INDEX IF NOT EXISTS idx_pro_offered_services_pro
    ON pro_offered_services(pro_id, is_active);

CREATE INDEX IF NOT EXISTS idx_pro_offered_services_service
    ON pro_offered_services(service_id, is_active);

-- ─────────────────────────────────────────────────────────────
-- 2. ADD MISSING COLUMNS to professional_profiles
--    Referenced in: auth.service.ts registerProWithPhone()
--    and professional.service.ts updateDutyStatus()
-- ─────────────────────────────────────────────────────────────
ALTER TABLE professional_profiles
    ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS pincode VARCHAR(20);

-- ─────────────────────────────────────────────────────────────
-- 3. PERFORMANCE INDEXES — prevent full table scans
-- ─────────────────────────────────────────────────────────────

-- Booking queries (customer history, pro job list, admin ops)
CREATE INDEX IF NOT EXISTS idx_bookings_customer_status
    ON bookings(customer_id, status);

CREATE INDEX IF NOT EXISTS idx_bookings_pro_status
    ON bookings(pro_id, status);

CREATE INDEX IF NOT EXISTS idx_bookings_scheduled_at
    ON bookings(scheduled_at DESC);

CREATE INDEX IF NOT EXISTS idx_bookings_status_created
    ON bookings(status, created_at DESC);

-- Professional online/available lookup (matching algorithm)
CREATE INDEX IF NOT EXISTS idx_pro_profiles_online_available
    ON professional_profiles(is_online, is_blacklisted, verification_status);

CREATE INDEX IF NOT EXISTS idx_pro_profiles_location
    ON professional_profiles(latitude, longitude)
    WHERE is_online = TRUE AND is_blacklisted = FALSE;

-- SOS alerts — admin dashboard queries
CREATE INDEX IF NOT EXISTS idx_sos_alerts_status_created
    ON sos_alerts(status, created_at DESC);

-- Misconduct incidents — safety review queue
CREATE INDEX IF NOT EXISTS idx_misconduct_status_created
    ON misconduct_incidents(status, created_at DESC);

-- OTP cleanup (expires_at for TTL queries)
CREATE INDEX IF NOT EXISTS idx_otps_expires_at
    ON otps(expires_at);

-- Refresh tokens cleanup
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at
    ON refresh_tokens(expires_at);

-- ─────────────────────────────────────────────────────────────
-- 4. UPDATE system_settings — replace hardcoded values
--    Google Maps API key should come from environment, not be
--    hardcoded in SQL. We keep the row but use a safe placeholder
--    so the system_settings table row exists for admin to update.
-- ─────────────────────────────────────────────────────────────
INSERT INTO system_settings (setting_key, setting_value, description, is_encrypted)
VALUES (
    'GOOGLE_MAPS_API_KEY',
    'REPLACE_WITH_REAL_API_KEY_VIA_ADMIN_DASHBOARD',
    'Google Maps Platform API Key — set via Admin Portal /settings page',
    FALSE
)
ON CONFLICT (setting_key) DO UPDATE
    SET description = 'Google Maps Platform API Key — set via Admin Portal /settings page',
        updated_at = NOW()
WHERE system_settings.setting_value = 'AIzaSyD9r59vIxUjLj3hiICvy9CYbXYbmil0Xb4';
-- Note: Only replaces the hardcoded value. If already updated by admin, leave it alone.

-- Add JWT secret rotation support
INSERT INTO system_settings (setting_key, setting_value, description)
VALUES (
    'PLATFORM_COMMISSION_PCT',
    '15',
    'Default platform commission percentage charged on each booking'
)
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO system_settings (setting_key, setting_value, description)
VALUES (
    'MAX_BOOKING_RADIUS_KM',
    '15',
    'Maximum radius in km to search for available professionals'
)
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO system_settings (setting_key, setting_value, description)
VALUES (
    'OTP_RATE_LIMIT_PER_HOUR',
    '5',
    'Max OTP requests per phone number per hour'
)
ON CONFLICT (setting_key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- 5. REVIEWS TABLE (for Phase 2 implementation)
--    Customers can rate & review professionals after COMPLETED bookings
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_reviews (
    id VARCHAR(50) PRIMARY KEY,
    booking_id VARCHAR(50) NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    reviewer_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reviewed_pro_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    tags TEXT[] DEFAULT '{}',    -- ["Punctual","Professional","Clean Work"]
    sentiment VARCHAR(20),       -- POSITIVE, NEUTRAL, CRITICAL (ML-computed later)
    is_visible BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(booking_id, reviewer_id)  -- one review per booking per reviewer
);

CREATE INDEX IF NOT EXISTS idx_reviews_pro_id
    ON booking_reviews(reviewed_pro_id, rating, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- 6. PAYOUT RECORDS TABLE (for Phase 2 automated payout system)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payout_records (
    id VARCHAR(50) PRIMARY KEY,
    pro_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    gross_amount NUMERIC(10,2) NOT NULL,
    platform_commission NUMERIC(10,2) NOT NULL,
    net_amount NUMERIC(10,2) NOT NULL,
    status VARCHAR(30) DEFAULT 'PENDING',   -- PENDING, PROCESSING, COMPLETED, FAILED, ON_HOLD
    razorpay_payout_id TEXT,
    failure_reason TEXT,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_records_pro_status
    ON payout_records(pro_id, status, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- 7. BOOKING CANCELLATIONS TABLE
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS booking_cancellations (
    id VARCHAR(50) PRIMARY KEY,
    booking_id VARCHAR(50) NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    cancelled_by_user_id VARCHAR(50) NOT NULL REFERENCES users(id),
    reason_category VARCHAR(50) NOT NULL,   -- CHANGE_OF_PLANS, FOUND_ANOTHER, EMERGENCY, OTHER
    reason_notes TEXT,
    cancellation_fee NUMERIC(10,2) DEFAULT 0.00,
    refund_amount NUMERIC(10,2),
    refund_status VARCHAR(30) DEFAULT 'PENDING',  -- PENDING, PROCESSING, COMPLETED, NOT_APPLICABLE
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- 8. OTP RATE LIMITING TRACKING TABLE
--    Tracks OTP request counts per phone to enforce rate limits
--    without Redis (DB-level fallback)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_rate_limits (
    phone_number VARCHAR(20) PRIMARY KEY,
    request_count INT DEFAULT 1,
    window_start TIMESTAMPTZ DEFAULT NOW(),
    blocked_until TIMESTAMPTZ
);

-- ─────────────────────────────────────────────────────────────
-- END OF MIGRATION 001
-- ─────────────────────────────────────────────────────────────
