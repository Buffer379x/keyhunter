-- 0.9.0: a wish can be paused on its own, independent of the global pause. paused_at is set while
-- paused; paused_until is the end (NULL: until resumed by hand). Its automatic checks wait, a check
-- the owner requests still runs.
ALTER TABLE wishlist_item ADD COLUMN paused_at INTEGER;
ALTER TABLE wishlist_item ADD COLUMN paused_until INTEGER;
