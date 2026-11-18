CREATE TABLE alert_rule (
    wish_id TEXT PRIMARY KEY REFERENCES wishlist_item(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK(mode IN ('target','low')),
    basis TEXT NOT NULL CHECK(basis IN ('base','estimate')),
    target_cents INTEGER CHECK(target_cents BETWEEN 1 AND 10000000),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    scope TEXT,
    previous_cents INTEGER,
    lowest_cents INTEGER,
    last_sent INTEGER,
    CHECK((mode='target')=(target_cents IS NOT NULL))
);
CREATE TABLE alert_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wish_id TEXT REFERENCES alert_rule(wish_id) ON DELETE CASCADE,
    scope TEXT,
    observed_at INTEGER NOT NULL,
    cents INTEGER,
    message TEXT NOT NULL,
    due INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','failed','cancelled')),
    sent_at INTEGER,
    lease_until INTEGER NOT NULL DEFAULT 0,
    UNIQUE(wish_id,scope,observed_at)
);
CREATE INDEX alert_delivery ON alert_outbox(state,due,lease_until);
CREATE INDEX alert_event_rule ON alert_outbox(wish_id,id DESC);
