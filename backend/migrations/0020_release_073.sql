-- 0.7.3: product mappings the owner deleted as completely wrong. The link itself and its price history
-- are gone; this row keeps the automatic search from suggesting the same product for the same wish again.
-- Adding the link by hand lifts the block.
CREATE TABLE offer_link_block (
    wish_id TEXT NOT NULL REFERENCES wishlist_item(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    url TEXT NOT NULL,
    blocked_at INTEGER NOT NULL,
    PRIMARY KEY(wish_id, source, url)
);
