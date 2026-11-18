CREATE TABLE shop_state (
    source TEXT PRIMARY KEY REFERENCES source_settings(id),
    retry_at INTEGER NOT NULL DEFAULT 0,
    last_success INTEGER,
    last_error TEXT,
    next_discovery INTEGER NOT NULL DEFAULT 0,
    budget_day INTEGER NOT NULL DEFAULT 0,
    jobs_today INTEGER NOT NULL DEFAULT 0
);
INSERT INTO shop_state(source) VALUES ('eneba');

CREATE TABLE shop_candidate (
    source TEXT NOT NULL REFERENCES shop_state(source),
    url TEXT NOT NULL,
    title_key TEXT NOT NULL,
    PRIMARY KEY(source, url)
);
CREATE INDEX shop_candidate_title ON shop_candidate(title_key);

CREATE TABLE offer_link (
    id INTEGER PRIMARY KEY,
    wish_id TEXT NOT NULL REFERENCES wishlist_item(id) ON DELETE CASCADE,
    source TEXT NOT NULL REFERENCES shop_state(source),
    url TEXT NOT NULL,
    review TEXT NOT NULL DEFAULT 'pending' CHECK(review IN ('pending', 'confirmed', 'rejected')),
    fingerprint TEXT,
    latest TEXT CHECK(latest IS NULL OR json_valid(latest)),
    observed_at INTEGER,
    attempted_at INTEGER,
    last_error TEXT,
    UNIQUE(wish_id, source, url)
);
CREATE INDEX offer_link_wish ON offer_link(wish_id);

CREATE TABLE shop_job (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL REFERENCES shop_state(source),
    link_id INTEGER UNIQUE REFERENCES offer_link(id) ON DELETE CASCADE,
    due INTEGER NOT NULL,
    lease_until INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    failures INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX shop_job_discovery ON shop_job(source) WHERE link_id IS NULL;
CREATE INDEX shop_job_schedule ON shop_job(due, lease_until);
INSERT INTO shop_job(source, due) VALUES ('eneba', 0);

CREATE TABLE price_observation (
    id INTEGER PRIMARY KEY,
    link_id INTEGER NOT NULL REFERENCES offer_link(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    market TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    offers TEXT NOT NULL CHECK(json_valid(offers)),
    activation TEXT NOT NULL,
    availability TEXT NOT NULL,
    UNIQUE(link_id, observed_at)
);
CREATE INDEX price_history ON price_observation(link_id, market, fingerprint, observed_at DESC);
