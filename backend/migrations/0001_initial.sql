CREATE TABLE owner (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE session (
    token_hash TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX session_expiry ON session(expires_at);
CREATE TABLE auth_throttle (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    attempts INTEGER NOT NULL,
    window_started_at INTEGER NOT NULL
);
INSERT INTO auth_throttle VALUES (1, 0, 0);
CREATE TABLE app_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    target_country TEXT,
    currency TEXT NOT NULL CHECK (currency = 'EUR')
);
INSERT INTO app_settings VALUES (1, NULL, 'EUR');
CREATE TABLE source_settings (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('shop', 'catalog')),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    fee_estimation_enabled INTEGER NOT NULL CHECK (fee_estimation_enabled IN (0, 1)),
    fee_basis_points INTEGER NOT NULL CHECK (fee_basis_points BETWEEN 0 AND 10000),
    CHECK (kind = 'shop' OR fee_estimation_enabled = 0)
);
INSERT INTO source_settings VALUES ('eneba', 'shop', 1, 0, 200);
INSERT INTO source_settings VALUES ('igdb', 'catalog', 1, 0, 0);
