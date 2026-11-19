ALTER TABLE source_settings ADD COLUMN configured INTEGER NOT NULL DEFAULT 1 CHECK(configured IN (0,1));
ALTER TABLE source_settings ADD COLUMN poll_interval_seconds INTEGER NOT NULL DEFAULT 28800 CHECK(poll_interval_seconds BETWEEN 900 AND 604800);
UPDATE source_settings SET configured=0 WHERE id='driffle'
    AND NOT EXISTS(SELECT 1 FROM offer_link WHERE source='driffle')
    AND NOT EXISTS(SELECT 1 FROM shop_state WHERE source='driffle' AND last_success IS NOT NULL);
CREATE TABLE edition_preview (
    track_id TEXT PRIMARY KEY REFERENCES wishlist_item(id) ON DELETE CASCADE,
    viewed_at INTEGER NOT NULL
);
CREATE TABLE edition_contents_cache (
    parent_id INTEGER NOT NULL,
    platform_id INTEGER NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY(parent_id,platform_id)
);
