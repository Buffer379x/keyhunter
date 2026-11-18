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
CREATE TABLE game (
    id TEXT PRIMARY KEY,
    igdb_id INTEGER UNIQUE REFERENCES catalog_game(igdb_id),
    manual_title TEXT,
    manual_key TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    CHECK ((igdb_id IS NOT NULL AND manual_title IS NULL AND manual_key IS NULL)
        OR (igdb_id IS NULL AND manual_title IS NOT NULL AND manual_key IS NOT NULL))
);
CREATE TABLE wishlist_item (
    id TEXT PRIMARY KEY,
    game_id TEXT NOT NULL REFERENCES game(id),
    platform_id INTEGER NOT NULL CHECK (platform_id IN (169, 49)),
    created_at INTEGER NOT NULL,
    UNIQUE (game_id, platform_id)
);
CREATE INDEX wishlist_created ON wishlist_item(created_at DESC, id);
