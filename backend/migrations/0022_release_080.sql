-- 0.8.0: the shopping cart. A wish is in it at most once (primary key); deleting the wish removes it,
-- and buying it ("Gekauft", wishlist::mark_owned) takes it out.
CREATE TABLE cart_item (
    wish_id TEXT PRIMARY KEY REFERENCES wishlist_item(id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL
);
