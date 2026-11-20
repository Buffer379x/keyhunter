-- 0.6.1: daily budget per shop and even pacing (see jobs.rs).
-- NULL keeps the operator default (KEYHUNTER_SHOP_DAILY_JOBS or 500).
ALTER TABLE source_settings ADD COLUMN daily_jobs INTEGER CHECK(daily_jobs IS NULL OR daily_jobs BETWEEN 20 AND 2000);
-- Earliest start of the next paced job of a shop; survives restarts.
ALTER TABLE shop_state ADD COLUMN paced_until INTEGER NOT NULL DEFAULT 0;
-- 1 while a job serves a direct user action and therefore bypasses pacing.
ALTER TABLE shop_job ADD COLUMN initial INTEGER NOT NULL DEFAULT 0 CHECK(initial IN (0, 1));
-- Searches that have not run yet are first searches of a new wish.
UPDATE shop_job SET initial = 1 WHERE wish_id IS NOT NULL AND checked_at IS NULL;

