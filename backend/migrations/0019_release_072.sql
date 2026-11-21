-- 0.7.2: Driffle candidates come from its product sitemaps instead of one collection page. The old
-- candidates are read again; the first pass over all sitemaps starts right away.
DELETE FROM shop_candidate WHERE source='driffle';
UPDATE shop_state SET next_discovery=0 WHERE source='driffle';
UPDATE shop_job SET due=0 WHERE source='driffle' AND link_id IS NULL AND wish_id IS NULL;
