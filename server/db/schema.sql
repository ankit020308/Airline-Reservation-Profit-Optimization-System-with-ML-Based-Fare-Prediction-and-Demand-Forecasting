-- SkyPlatform: Complete Database Schema
-- Designed for multi-tenant distributed airline platform

-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- TENANTS (Airlines)
-- ============================================================
CREATE TABLE IF NOT EXISTS tenants (
    tenant_id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    iata_code       CHAR(2) UNIQUE NOT NULL,
    airline_name    VARCHAR(100) NOT NULL,
    logo_url        TEXT,
    base_currency   CHAR(3) DEFAULT 'INR',
    config          JSONB DEFAULT '{}',
    active          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    user_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    first_name      VARCHAR(100),
    last_name       VARCHAR(100),
    phone           VARCHAR(20),
    dob             DATE,
    nationality     CHAR(2),
    passport_no     TEXT,
    loyalty_tier    VARCHAR(20) DEFAULT 'BLUE',
    loyalty_points  INTEGER DEFAULT 0,
    preferences     JSONB DEFAULT '{}',
    role            VARCHAR(20) DEFAULT 'passenger',
    active          BOOLEAN DEFAULT TRUE,
    last_login      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
    session_id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID REFERENCES users(user_id) ON DELETE CASCADE,
    refresh_token   TEXT UNIQUE NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    ip_address      INET,
    user_agent      TEXT,
    revoked         BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AIRPORTS
-- ============================================================
CREATE TABLE IF NOT EXISTS airports (
    airport_id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    iata_code       CHAR(3) UNIQUE NOT NULL,
    name            VARCHAR(200) NOT NULL,
    city            VARCHAR(100) NOT NULL,
    country         VARCHAR(100) NOT NULL,
    country_code    CHAR(2) NOT NULL,
    latitude        DECIMAL(10,7),
    longitude       DECIMAL(10,7),
    timezone        VARCHAR(50),
    international   BOOLEAN DEFAULT FALSE
);

-- ============================================================
-- FLIGHTS
-- ============================================================
CREATE TABLE IF NOT EXISTS flights (
    flight_id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id           UUID REFERENCES tenants(tenant_id),
    flight_number       VARCHAR(10) NOT NULL,
    aircraft_type       VARCHAR(50),
    origin_iata         CHAR(3) REFERENCES airports(iata_code),
    dest_iata           CHAR(3) REFERENCES airports(iata_code),
    departure_time      TIMESTAMPTZ NOT NULL,
    arrival_time        TIMESTAMPTZ NOT NULL,
    duration_minutes    INTEGER NOT NULL,
    stops               INTEGER DEFAULT 0,
    status              VARCHAR(30) DEFAULT 'SCHEDULED',
    delay_minutes       INTEGER DEFAULT 0,
    cancellation_reason TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flights_route_date
    ON flights(origin_iata, dest_iata, departure_time);
CREATE INDEX IF NOT EXISTS idx_flights_tenant
    ON flights(tenant_id);

-- ============================================================
-- FLIGHT INVENTORY (per cabin)
-- ============================================================
CREATE TABLE IF NOT EXISTS flight_inventory (
    inventory_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    flight_id           UUID REFERENCES flights(flight_id) ON DELETE CASCADE,
    cabin_class         VARCHAR(20) NOT NULL,  -- ECONOMY, BUSINESS, FIRST
    physical_seats      INTEGER NOT NULL,
    overbooking_pct     DECIMAL(5,2) DEFAULT 0.00,
    actual_capacity     INTEGER NOT NULL,
    allocated_seats     INTEGER DEFAULT 0,
    locked_seats        INTEGER DEFAULT 0,
    base_fare           DECIMAL(12,2) NOT NULL,
    version             BIGINT DEFAULT 0,
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(flight_id, cabin_class)
);

-- ============================================================
-- SEAT LOCKS (Distributed Lock Table)
-- ============================================================
CREATE TABLE IF NOT EXISTS seat_locks (
    lock_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    flight_id       UUID REFERENCES flights(flight_id),
    cabin_class     VARCHAR(20) NOT NULL,
    count           INTEGER NOT NULL,
    booking_id      UUID,
    session_id      UUID,
    lock_token      TEXT UNIQUE NOT NULL,
    lock_type       VARCHAR(20) DEFAULT 'BOOKING',  -- BOOKING | REBOOKING
    expires_at      TIMESTAMPTZ NOT NULL,
    released        BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seat_locks_flight
    ON seat_locks(flight_id, released, expires_at);

-- ============================================================
-- BOOKINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS bookings (
    booking_id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pnr                 CHAR(6) UNIQUE NOT NULL,
    tenant_id           UUID REFERENCES tenants(tenant_id),
    user_id             UUID REFERENCES users(user_id),
    flight_id           UUID REFERENCES flights(flight_id),
    cabin_class         VARCHAR(20) NOT NULL,
    status              VARCHAR(30) DEFAULT 'INITIATED',
    -- INITIATED|HOLD|PAYMENT_PENDING|CONFIRMED|CANCELLED|EXPIRED|REBOOKED
    total_fare          DECIMAL(12,2) NOT NULL,
    currency            CHAR(3) DEFAULT 'INR',
    fare_basis          VARCHAR(5),
    fare_multipliers    JSONB,
    lock_token          TEXT,
    idempotency_key     UUID UNIQUE,
    hold_expires_at     TIMESTAMPTZ,
    confirmed_at        TIMESTAMPTZ,
    cancelled_at        TIMESTAMPTZ,
    cancel_reason       TEXT,
    refund_amount       DECIMAL(12,2),
    refund_status       VARCHAR(20),
    original_booking_id UUID,  -- for rebooking chain
    metadata            JSONB DEFAULT '{}',
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bookings_user      ON bookings(user_id);
CREATE INDEX IF NOT EXISTS idx_bookings_flight     ON bookings(flight_id);
CREATE INDEX IF NOT EXISTS idx_bookings_pnr        ON bookings(pnr);
CREATE INDEX IF NOT EXISTS idx_bookings_status     ON bookings(status);

-- ============================================================
-- BOOKING PASSENGERS
-- ============================================================
CREATE TABLE IF NOT EXISTS booking_passengers (
    passenger_id    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id      UUID REFERENCES bookings(booking_id) ON DELETE CASCADE,
    passenger_type  VARCHAR(10) NOT NULL,  -- ADULT|CHILD|INFANT
    first_name      VARCHAR(100) NOT NULL,
    last_name       VARCHAR(100) NOT NULL,
    dob             DATE,
    passport_no     TEXT,
    nationality     CHAR(2),
    seat_number     VARCHAR(5),
    meal_preference VARCHAR(20),
    frequent_flyer  TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PAYMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS payments (
    payment_id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    booking_id          UUID REFERENCES bookings(booking_id),
    user_id             UUID REFERENCES users(user_id),
    amount              DECIMAL(12,2) NOT NULL,
    currency            CHAR(3) DEFAULT 'INR',
    status              VARCHAR(20) DEFAULT 'PENDING',
    -- PENDING|PROCESSING|COMPLETED|FAILED|REFUNDED
    payment_method      VARCHAR(30),
    transaction_id      TEXT,
    gateway_response    JSONB,
    fraud_score         DECIMAL(5,2),
    fraud_flags         TEXT[],
    idempotency_key     UUID UNIQUE,
    processed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- FARE RULES (Pricing Engine)
-- ============================================================
CREATE TABLE IF NOT EXISTS fare_rules (
    rule_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID REFERENCES tenants(tenant_id),
    origin_iata     CHAR(3),
    dest_iata       CHAR(3),
    cabin_class     VARCHAR(20),
    fare_basis      VARCHAR(5) NOT NULL,
    multiplier      DECIMAL(6,4) NOT NULL,
    refundable      BOOLEAN DEFAULT FALSE,
    changeable      BOOLEAN DEFAULT FALSE,
    advance_purchase INTEGER DEFAULT 0,  -- min days
    min_stay        INTEGER,
    max_stay        INTEGER,
    valid_from      DATE,
    valid_to        DATE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AB TESTS
-- ============================================================
CREATE TABLE IF NOT EXISTS ab_tests (
    test_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(100) UNIQUE NOT NULL,
    description     TEXT,
    status          VARCHAR(20) DEFAULT 'ACTIVE',
    variants        JSONB NOT NULL,
    traffic_split   JSONB NOT NULL,
    metrics         JSONB DEFAULT '[]',
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    ended_at        TIMESTAMPTZ,
    winner          VARCHAR(50)
);

-- ============================================================
-- USER BEHAVIOR (Behavioral Tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_behavior (
    event_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID REFERENCES users(user_id),
    session_id      TEXT,
    event_type      VARCHAR(50) NOT NULL,
    event_data      JSONB NOT NULL,
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_behavior_user_time
    ON user_behavior(user_id, created_at DESC);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
    notification_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID REFERENCES users(user_id),
    booking_id      UUID,
    type            VARCHAR(30) NOT NULL,
    channel         VARCHAR(20) NOT NULL,  -- EMAIL|SMS|PUSH|IN_APP
    subject         TEXT,
    body            TEXT NOT NULL,
    status          VARCHAR(20) DEFAULT 'QUEUED',
    sent_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- FLIGHT OPERATIONS EVENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS flight_operations (
    ops_event_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    flight_id           UUID REFERENCES flights(flight_id),
    event_type          VARCHAR(30) NOT NULL,
    -- DELAYED|CANCELLED|GATE_CHANGED|BOARDING|DIVERTED
    original_departure  TIMESTAMPTZ,
    new_departure       TIMESTAMPTZ,
    delay_minutes       INTEGER DEFAULT 0,
    reason              TEXT,
    affected_pax_count  INTEGER DEFAULT 0,
    rebooking_triggered BOOLEAN DEFAULT FALSE,
    cascading_flights   TEXT[],
    resolution          JSONB,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- FARE ALERTS
-- ============================================================
CREATE TABLE IF NOT EXISTS fare_alerts (
    alert_id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID REFERENCES users(user_id),
    origin_iata     CHAR(3) NOT NULL,
    dest_iata       CHAR(3) NOT NULL,
    travel_date     DATE,
    cabin_class     VARCHAR(20) DEFAULT 'ECONOMY',
    target_price    DECIMAL(12,2),
    current_price   DECIMAL(12,2),
    triggered       BOOLEAN DEFAULT FALSE,
    active          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- COUPONS & LOYALTY
-- ============================================================
CREATE TABLE IF NOT EXISTS coupons (
    coupon_id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code            VARCHAR(20) UNIQUE NOT NULL,
    type            VARCHAR(20) NOT NULL,  -- PERCENT|FIXED|MILES
    value           DECIMAL(10,2) NOT NULL,
    min_fare        DECIMAL(10,2) DEFAULT 0,
    max_discount    DECIMAL(10,2),
    usage_limit     INTEGER,
    usage_count     INTEGER DEFAULT 0,
    user_id         UUID,   -- null = public
    valid_from      TIMESTAMPTZ,
    valid_to        TIMESTAMPTZ,
    active          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AUDIT LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
    log_id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID,
    action          VARCHAR(100) NOT NULL,
    resource_type   VARCHAR(50),
    resource_id     UUID,
    old_value       JSONB,
    new_value       JSONB,
    ip_address      INET,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
