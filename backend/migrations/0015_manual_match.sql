-- The owner confirmed a shop product by hand although its shop data (title, platform, product type) does not
-- match the wish automatically. Valid only for the confirmed fingerprint, like every confirmation (release 0.6.4).
ALTER TABLE offer_link ADD COLUMN manual_match INTEGER NOT NULL DEFAULT 0;
