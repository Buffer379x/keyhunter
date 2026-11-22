CREATE TRIGGER channel_delivery_cancel AFTER UPDATE OF state ON alert_outbox WHEN NEW.state='cancelled' BEGIN
    UPDATE channel_delivery SET state='cancelled' WHERE outbox_id=NEW.id AND state='pending';
END;
CREATE TRIGGER event_log_retention AFTER INSERT ON event_log BEGIN
    DELETE FROM event_log WHERE at < NEW.at - 604800;
END;
CREATE TRIGGER price_observation_valid_cents AFTER INSERT ON price_observation
BEGIN
    UPDATE price_observation SET valid_cents = CASE WHEN NEW.availability = 'in_stock' AND NEW.activation = 'confirmed' THEN
        (SELECT MIN(CAST(json_extract(q.value, '$.cents') AS INTEGER)) FROM json_each(NEW.offers) q
        WHERE CAST(json_extract(q.value, '$.cents') AS INTEGER) BETWEEN 1 AND 10000000) END
    WHERE id = NEW.id;
END;
CREATE TABLE alert_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wish_id TEXT REFERENCES alert_rule(wish_id) ON DELETE CASCADE,
    scope TEXT,
    observed_at INTEGER NOT NULL,
    cents INTEGER,
    due INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','failed','cancelled')),
    sent_at INTEGER,
    lease_until INTEGER NOT NULL DEFAULT 0, game TEXT, mode TEXT CHECK(mode IN ('target','low')), basis TEXT CHECK(basis IN ('base','estimate')), reference_cents INTEGER, shop TEXT, region TEXT, country TEXT, url TEXT,
    UNIQUE(wish_id,scope,observed_at)
);
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
CREATE TABLE app_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    target_country TEXT,
    currency TEXT NOT NULL CHECK (currency = 'EUR')
, wishlist_price_scope TEXT NOT NULL DEFAULT 'preferred' CHECK(wishlist_price_scope IN ('preferred','all')), wishlist_columns TEXT NOT NULL DEFAULT '', fetch_paused_at INTEGER, wishlist_hidden TEXT NOT NULL DEFAULT '', wishlist_open TEXT NOT NULL DEFAULT 'button' CHECK(wishlist_open IN ('button', 'title', 'cover')), offers_columns TEXT NOT NULL DEFAULT '', offers_hidden TEXT NOT NULL DEFAULT '');
CREATE TABLE auth_throttle (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    attempts INTEGER NOT NULL,
    window_started_at INTEGER NOT NULL
);
CREATE TABLE cart_item (
    wish_id TEXT PRIMARY KEY REFERENCES wishlist_item(id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL
, source TEXT, scope TEXT NOT NULL DEFAULT 'world' CHECK(scope IN ('home', 'world')));
CREATE TABLE catalog_game (
    igdb_id INTEGER PRIMARY KEY CHECK (igdb_id > 0),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    fetched_at INTEGER NOT NULL
);
CREATE TABLE catalog_search (
    query_key TEXT PRIMARY KEY,
    result_ids TEXT NOT NULL CHECK (json_valid(result_ids)),
    fetched_at INTEGER NOT NULL
);
CREATE TABLE channel_delivery (
    outbox_id INTEGER NOT NULL REFERENCES alert_outbox(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','failed','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    due INTEGER NOT NULL,
    sent_at INTEGER,
    -- Short German reason of the last failure ("HTTP 401 · Unauthorized"); never contains a secret.
    error TEXT,
    PRIMARY KEY(outbox_id,channel)
);
CREATE TABLE edition_contents_cache (
    parent_id INTEGER NOT NULL,
    platform_id INTEGER NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY(parent_id,platform_id)
);
CREATE TABLE edition_scan (
    wish_id TEXT PRIMARY KEY REFERENCES wishlist_item(id) ON DELETE CASCADE,
    checked_at INTEGER,
    lease_until INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);
CREATE TABLE edition_watch (
    wish_id TEXT NOT NULL REFERENCES wishlist_item(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES wishlist_item(id) ON DELETE CASCADE,
    PRIMARY KEY(wish_id,track_id),
    CHECK(wish_id != track_id)
);
CREATE TABLE event_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    level TEXT NOT NULL CHECK(level IN ('info','warn','error')),
    area TEXT NOT NULL,
    message TEXT NOT NULL
);
CREATE TABLE game (
    id TEXT PRIMARY KEY,
    igdb_id INTEGER UNIQUE REFERENCES catalog_game(igdb_id),
    manual_title TEXT,
    manual_key TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    CHECK ((igdb_id IS NOT NULL AND manual_title IS NULL AND manual_key IS NULL)
        OR (igdb_id IS NULL AND manual_title IS NOT NULL AND manual_key IS NOT NULL))
);
CREATE TABLE job_run (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('product', 'search', 'discovery')),
    wish_id TEXT,
    link_id INTEGER,
    started_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    detail TEXT
);
CREATE TABLE notification_channel (
    kind TEXT PRIMARY KEY CHECK(kind IN ('ntfy','telegram','discord','email','gotify','pushover','webhook')),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    settings TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(settings))
);
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
    last_error TEXT, auto_discovered INTEGER NOT NULL DEFAULT 0 CHECK(auto_discovered IN (0,1)), confirmed_name TEXT, manual_match INTEGER NOT NULL DEFAULT 0, cheap_score REAL NOT NULL DEFAULT 0.5,
    UNIQUE(wish_id, source, url)
);
CREATE TABLE offer_link_block (
    wish_id TEXT NOT NULL REFERENCES wishlist_item(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    url TEXT NOT NULL,
    blocked_at INTEGER NOT NULL,
    PRIMARY KEY(wish_id, source, url)
);
CREATE TABLE owner (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE price_observation (
    id INTEGER PRIMARY KEY,
    link_id INTEGER NOT NULL REFERENCES offer_link(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    market TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    offers TEXT NOT NULL CHECK(json_valid(offers)),
    activation TEXT NOT NULL,
    availability TEXT NOT NULL, valid_cents INTEGER,
    UNIQUE(link_id, observed_at)
);
CREATE TABLE session (
    token_hash TEXT PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE TABLE shop_candidate (
    source TEXT NOT NULL REFERENCES shop_state(source),
    url TEXT NOT NULL,
    title_key TEXT NOT NULL,
    PRIMARY KEY(source, url)
);
CREATE TABLE shop_job (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL REFERENCES shop_state(source),
    link_id INTEGER UNIQUE REFERENCES offer_link(id) ON DELETE CASCADE,
    due INTEGER NOT NULL,
    lease_until INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    failures INTEGER NOT NULL DEFAULT 0
, wish_id TEXT REFERENCES wishlist_item(id) ON DELETE CASCADE, checked_at INTEGER, last_error TEXT, result_count INTEGER, search_page INTEGER NOT NULL DEFAULT 1, requested_at INTEGER NOT NULL DEFAULT 0, relevance INTEGER NOT NULL DEFAULT 1 CHECK(relevance IN (1, 2)), initial INTEGER NOT NULL DEFAULT 0 CHECK(initial IN (0, 1)), pace REAL NOT NULL DEFAULT 1);
CREATE TABLE shop_state (
    source TEXT PRIMARY KEY REFERENCES source_settings(id),
    retry_at INTEGER NOT NULL DEFAULT 0,
    last_success INTEGER,
    last_error TEXT,
    next_discovery INTEGER NOT NULL DEFAULT 0,
    budget_day INTEGER NOT NULL DEFAULT 0,
    jobs_today INTEGER NOT NULL DEFAULT 0
, paced_until INTEGER NOT NULL DEFAULT 0);
CREATE TABLE source_settings (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('shop', 'catalog')),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    fee_estimation_enabled INTEGER NOT NULL CHECK (fee_estimation_enabled IN (0, 1)),
    fee_basis_points INTEGER NOT NULL CHECK (fee_basis_points BETWEEN 0 AND 10000), configured INTEGER NOT NULL DEFAULT 1 CHECK(configured IN (0,1)), poll_interval_seconds INTEGER NOT NULL DEFAULT 28800 CHECK(poll_interval_seconds BETWEEN 900 AND 604800), daily_jobs INTEGER CHECK(daily_jobs IS NULL OR daily_jobs BETWEEN 20 AND 2000),
    CHECK (kind = 'shop' OR fee_estimation_enabled = 0)
);
CREATE TABLE sqlite_sequence(name,seq);
CREATE TABLE "wishlist_item" (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL REFERENCES game(id),
    platform_id INTEGER NOT NULL CHECK (platform_id IN (169, 49, 12, 11)),
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'wished' CHECK(state IN ('wished', 'preview', 'owned')),
    viewed_at INTEGER,
    acquired_at INTEGER, paused_at INTEGER, paused_until INTEGER,
    UNIQUE (game_id, platform_id)
);
CREATE INDEX alert_delivery ON alert_outbox(state,due,lease_until);
CREATE INDEX alert_event_rule ON alert_outbox(wish_id,id DESC);
CREATE INDEX edition_watch_track ON edition_watch(track_id);
CREATE INDEX event_log_recent ON event_log(at DESC, id DESC);
CREATE INDEX job_run_recent ON job_run(started_at DESC, id DESC);
CREATE INDEX offer_link_wish ON offer_link(wish_id);
CREATE INDEX price_history ON price_observation(link_id, market, fingerprint, observed_at DESC, valid_cents);
CREATE INDEX session_expiry ON session(expires_at);
CREATE INDEX shop_candidate_title ON shop_candidate(title_key);
CREATE UNIQUE INDEX shop_job_discovery ON shop_job(source) WHERE link_id IS NULL AND wish_id IS NULL;
CREATE INDEX shop_job_schedule ON shop_job(due, lease_until);
CREATE UNIQUE INDEX shop_job_wish_search ON shop_job(source,wish_id) WHERE wish_id IS NOT NULL;
CREATE INDEX wishlist_created ON wishlist_item(created_at DESC, id);
CREATE INDEX wishlist_item_state ON wishlist_item(state, created_at DESC);
