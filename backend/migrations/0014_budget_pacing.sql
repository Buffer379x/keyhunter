-- 0.6.1: daily budget per shop and even pacing (see jobs.rs).
-- NULL keeps the operator default (KEYHUNTER_SHOP_DAILY_JOBS or 500).
ALTER TABLE source_settings ADD COLUMN daily_jobs INTEGER CHECK(daily_jobs IS NULL OR daily_jobs BETWEEN 20 AND 2000);
-- Earliest start of the next paced job of a shop; survives restarts.
ALTER TABLE shop_state ADD COLUMN paced_until INTEGER NOT NULL DEFAULT 0;
-- 1 while a job serves a direct user action and therefore bypasses pacing.
ALTER TABLE shop_job ADD COLUMN initial INTEGER NOT NULL DEFAULT 0 CHECK(initial IN (0, 1));
-- Searches that have not run yet are first searches of a new wish.
UPDATE shop_job SET initial = 1 WHERE wish_id IS NOT NULL AND checked_at IS NULL;

-- Lowest valid quote of an observation that was in stock with confirmed activation for its
-- market, else NULL (same bounds as pricing::min_cents). Observations are immutable, so a
-- trigger fills it once for every writer. The 14-day badge trend reads only the index.
ALTER TABLE price_observation ADD COLUMN valid_cents INTEGER;
CREATE TRIGGER price_observation_valid_cents AFTER INSERT ON price_observation
BEGIN
    UPDATE price_observation SET valid_cents = CASE WHEN NEW.availability = 'in_stock' AND NEW.activation = 'confirmed' THEN
        (SELECT MIN(CAST(json_extract(q.value, '$.cents') AS INTEGER)) FROM json_each(NEW.offers) q
        WHERE CAST(json_extract(q.value, '$.cents') AS INTEGER) BETWEEN 1 AND 10000000) END
    WHERE id = NEW.id;
END;
UPDATE price_observation SET valid_cents = CASE WHEN availability = 'in_stock' AND activation = 'confirmed' THEN
    (SELECT MIN(CAST(json_extract(q.value, '$.cents') AS INTEGER)) FROM json_each(offers) q
    WHERE CAST(json_extract(q.value, '$.cents') AS INTEGER) BETWEEN 1 AND 10000000) END;
DROP INDEX price_history;
CREATE INDEX price_history ON price_observation(link_id, market, fingerprint, observed_at DESC, valid_cents);
