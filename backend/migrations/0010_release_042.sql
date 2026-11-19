CREATE TABLE edition_watch (
    wish_id TEXT NOT NULL REFERENCES wishlist_item(id) ON DELETE CASCADE,
    track_id TEXT NOT NULL REFERENCES wishlist_item(id) ON DELETE CASCADE,
    PRIMARY KEY(wish_id,track_id),
    CHECK(wish_id != track_id)
);
CREATE INDEX edition_watch_track ON edition_watch(track_id);
CREATE TABLE edition_scan (
    wish_id TEXT PRIMARY KEY REFERENCES wishlist_item(id) ON DELETE CASCADE,
    checked_at INTEGER,
    lease_until INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);
