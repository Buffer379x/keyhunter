-- 1.0 (FUNC-02): the lowest valid quote of an observation that was in stock, whatever its activation, so the trend
-- of a target country elsewhere in the EU market can count it with the product's activation there (pricing::counts_in).
-- Same bounds as valid_cents (migration 0014); observations are immutable, so a trigger fills it once.
ALTER TABLE price_observation ADD COLUMN stock_cents INTEGER;
CREATE TRIGGER price_observation_stock_cents AFTER INSERT ON price_observation
BEGIN
    UPDATE price_observation SET stock_cents = CASE WHEN NEW.availability = 'in_stock' THEN
        (SELECT MIN(CAST(json_extract(q.value, '$.cents') AS INTEGER)) FROM json_each(NEW.offers) q
        WHERE CAST(json_extract(q.value, '$.cents') AS INTEGER) BETWEEN 1 AND 10000000) END
    WHERE id = NEW.id;
END;
UPDATE price_observation SET stock_cents = CASE WHEN availability = 'in_stock' THEN
    (SELECT MIN(CAST(json_extract(q.value, '$.cents') AS INTEGER)) FROM json_each(offers) q
    WHERE CAST(json_extract(q.value, '$.cents') AS INTEGER) BETWEEN 1 AND 10000000) END;
-- The trend reads a link's observations by time and filters the market of each (a set for EU targets).
DROP INDEX price_history;
CREATE INDEX price_history ON price_observation(link_id, fingerprint, observed_at DESC, market, valid_cents, stock_cents);

-- 1.0 (FUNC-13): consecutive "not found" or unreadable results of a product link; from 5 on it is checked four
-- times less often until a fetch succeeds again (jobs::dead_link).
ALTER TABLE shop_job ADD COLUMN dead_failures INTEGER NOT NULL DEFAULT 0;
