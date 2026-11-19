ALTER TABLE app_settings ADD COLUMN wishlist_price_scope TEXT NOT NULL DEFAULT 'preferred' CHECK(wishlist_price_scope IN ('preferred','all'));
CREATE TABLE library_item (
    track_id TEXT PRIMARY KEY REFERENCES wishlist_item(id) ON DELETE CASCADE,
    acquired_at INTEGER NOT NULL
);
