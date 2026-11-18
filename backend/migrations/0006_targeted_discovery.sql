ALTER TABLE shop_job ADD COLUMN wish_id TEXT REFERENCES wishlist_item(id) ON DELETE CASCADE;
ALTER TABLE shop_job ADD COLUMN checked_at INTEGER;
ALTER TABLE shop_job ADD COLUMN last_error TEXT;
ALTER TABLE shop_job ADD COLUMN result_count INTEGER;
DROP INDEX shop_job_discovery;
CREATE UNIQUE INDEX shop_job_discovery ON shop_job(source) WHERE link_id IS NULL AND wish_id IS NULL;
CREATE UNIQUE INDEX shop_job_wish_search ON shop_job(source,wish_id) WHERE wish_id IS NOT NULL;
INSERT INTO shop_job(source,wish_id,due) SELECT 'eneba',id,0 FROM wishlist_item;
