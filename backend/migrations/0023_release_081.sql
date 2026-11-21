-- no-transaction
-- 0.8.1: wishes and library entries for Xbox 360 (IGDB 12) and the original Xbox (11) as well. The platform
-- CHECK of wishlist_item cannot be altered in place, so the table is rebuilt the way SQLite documents it:
-- foreign keys off (only possible outside a transaction), new table, copy, drop, rename, indexes, check.
-- Every table that references wishlist_item keeps its rows: the ids are copied unchanged.
-- Also 0.8.1: every cart entry has a shop (NULL: the cheapest one) and a price scope ('world': any region,
-- 'home': valid in the target country).
PRAGMA foreign_keys=OFF;
BEGIN;
CREATE TABLE wishlist_item_new (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL REFERENCES game(id),
    platform_id INTEGER NOT NULL CHECK (platform_id IN (169, 49, 12, 11)),
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'wished' CHECK(state IN ('wished', 'preview', 'owned')),
    viewed_at INTEGER,
    acquired_at INTEGER,
    UNIQUE (game_id, platform_id)
);
INSERT INTO wishlist_item_new(id,game_id,platform_id,created_at,state,viewed_at,acquired_at)
    SELECT id,game_id,platform_id,created_at,state,viewed_at,acquired_at FROM wishlist_item;
DROP TABLE wishlist_item;
ALTER TABLE wishlist_item_new RENAME TO wishlist_item;
CREATE INDEX wishlist_created ON wishlist_item(created_at DESC, id);
CREATE INDEX wishlist_item_state ON wishlist_item(state, created_at DESC);
ALTER TABLE cart_item ADD COLUMN source TEXT;
ALTER TABLE cart_item ADD COLUMN scope TEXT NOT NULL DEFAULT 'world' CHECK(scope IN ('home', 'world'));
COMMIT;
PRAGMA foreign_keys=ON;
