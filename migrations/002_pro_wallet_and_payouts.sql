-- ============================================================
-- LUMO Migration 002: Professional Wallets & Payout Disbursements
-- Created: 2026-08-11
-- ============================================================

-- 1. Professional Wallets Table
CREATE TABLE IF NOT EXISTS pro_wallets (
    pro_id VARCHAR(50) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    locked_balance NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    total_earned NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    total_withdrawn NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Professional Payout Methods Table (Bank Accounts / UPI VPAs)
CREATE TABLE IF NOT EXISTS pro_payout_methods (
    id VARCHAR(50) PRIMARY KEY,
    pro_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(30) NOT NULL, -- 'UPI' | 'BANK_ACCOUNT'
    upi_id VARCHAR(100),
    account_holder_name VARCHAR(150),
    account_number VARCHAR(50),
    ifsc_code VARCHAR(20),
    bank_name VARCHAR(100),
    is_primary BOOLEAN DEFAULT TRUE,
    is_verified BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pro_payout_methods_pro
    ON pro_payout_methods(pro_id, is_primary);

-- 3. Payout Requests Table (Disbursement Orders)
CREATE TABLE IF NOT EXISTS payout_requests (
    id VARCHAR(50) PRIMARY KEY,
    pro_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount NUMERIC(10,2) NOT NULL,
    payout_method_type VARCHAR(30) NOT NULL, -- 'UPI' | 'BANK_ACCOUNT'
    payout_details JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(30) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'PROCESSING', 'COMPLETED', 'REJECTED', 'FAILED'
    utr_number VARCHAR(100),
    gateway_payout_id TEXT,
    processed_by VARCHAR(50) REFERENCES users(id) ON DELETE SET NULL,
    processed_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_requests_pro_status
    ON payout_requests(pro_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payout_requests_status
    ON payout_requests(status, created_at DESC);

-- 4. Professional Wallet Transactions Ledger Table
CREATE TABLE IF NOT EXISTS pro_wallet_transactions (
    id VARCHAR(50) PRIMARY KEY,
    pro_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    booking_id VARCHAR(50) REFERENCES bookings(id) ON DELETE SET NULL,
    payout_request_id VARCHAR(50) REFERENCES payout_requests(id) ON DELETE SET NULL,
    type VARCHAR(40) NOT NULL, -- 'JOB_EARNING', 'WITHDRAWAL', 'WITHDRAWAL_REFUND', 'BONUS', 'PENALTY'
    amount NUMERIC(10,2) NOT NULL,
    is_credit BOOLEAN NOT NULL,
    balance_after NUMERIC(10,2) NOT NULL,
    title VARCHAR(150) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pro_wallet_tx_pro
    ON pro_wallet_transactions(pro_id, created_at DESC);

-- 5. Auto-populate Wallets for existing professionals
INSERT INTO pro_wallets (pro_id, balance, total_earned, updated_at)
SELECT u.id, 
       COALESCE(SUM(b.total_amount), 0.00),
       COALESCE(SUM(b.total_amount), 0.00),
       NOW()
FROM users u
LEFT JOIN bookings b ON b.pro_id = u.id AND b.status = 'COMPLETED'
WHERE u.role = 'PROFESSIONAL'
GROUP BY u.id
ON CONFLICT (pro_id) DO NOTHING;
