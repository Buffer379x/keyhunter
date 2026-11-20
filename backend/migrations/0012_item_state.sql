-- One state column instead of side tables (audit ARC-01): an item is a wish, a hidden
-- edition preview or an owned library entry. A backup is written before this runs.
ALTER TABLE wishlist_item ADD COLUMN state TEXT NOT NULL DEFAULT 'wished' CHECK(state IN ('wished', 'preview', 'owned'));
ALTER TABLE wishlist_item ADD COLUMN viewed_at INTEGER;
ALTER TABLE wishlist_item ADD COLUMN acquired_at INTEGER;

-- Abort (and roll back) if an item were both a preview and owned; no known database has one.
CREATE TEMP TABLE migration_check(ok INTEGER NOT NULL CHECK(ok = 1));
INSERT INTO migration_check SELECT NOT EXISTS(SELECT 1 FROM edition_preview p JOIN library_item b ON b.track_id = p.track_id);

UPDATE wishlist_item SET state = 'owned', acquired_at = (SELECT acquired_at FROM library_item b WHERE b.track_id = wishlist_item.id)
WHERE id IN (SELECT track_id FROM library_item);
UPDATE wishlist_item SET state = 'preview', viewed_at = (SELECT viewed_at FROM edition_preview p WHERE p.track_id = wishlist_item.id)
WHERE id IN (SELECT track_id FROM edition_preview);

-- Every moved row must have arrived.
INSERT INTO migration_check SELECT (SELECT COUNT(*) FROM wishlist_item WHERE state = 'owned' AND acquired_at IS NOT NULL) = (SELECT COUNT(*) FROM library_item);
INSERT INTO migration_check SELECT (SELECT COUNT(*) FROM wishlist_item WHERE state = 'preview' AND viewed_at IS NOT NULL) = (SELECT COUNT(*) FROM edition_preview);
DROP TABLE migration_check;

DROP TABLE edition_preview;
DROP TABLE library_item;
CREATE INDEX wishlist_item_state ON wishlist_item(state, created_at DESC);
