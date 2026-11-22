-- 0.9.0: notification channels. One row per built-in channel with its switch and the settings that are not secret;
-- tokens, passwords and secret URLs live in <data>/notification-secrets.json (0600), like the IGDB access.
CREATE TABLE notification_channel (
    kind TEXT PRIMARY KEY CHECK(kind IN ('ntfy','telegram','discord','email','gotify','pushover','webhook')),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    settings TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(settings))
);
-- ntfy starts switched on, so an existing /config/ntfy.env keeps delivering after the update.
INSERT INTO notification_channel(kind,enabled) VALUES
    ('ntfy',1),('telegram',0),('discord',0),('email',0),('gotify',0),('pushover',0),('webhook',0);

-- What an alert reports, so every channel formats its own message (the finished text is no longer stored).
ALTER TABLE alert_outbox ADD COLUMN game TEXT;
ALTER TABLE alert_outbox ADD COLUMN mode TEXT CHECK(mode IN ('target','low'));
ALTER TABLE alert_outbox ADD COLUMN basis TEXT CHECK(basis IN ('base','estimate'));
-- The target price ("target") or the lowest price before ("low").
ALTER TABLE alert_outbox ADD COLUMN reference_cents INTEGER;
ALTER TABLE alert_outbox ADD COLUMN shop TEXT;
ALTER TABLE alert_outbox ADD COLUMN region TEXT;
ALTER TABLE alert_outbox ADD COLUMN country TEXT;
ALTER TABLE alert_outbox ADD COLUMN url TEXT;
UPDATE alert_outbox SET
    game=(SELECT COALESCE(g.manual_title,json_extract(c.payload,'$.name')) FROM wishlist_item w JOIN game g ON g.id=w.game_id
        LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id WHERE w.id=alert_outbox.wish_id),
    mode=(SELECT mode FROM alert_rule r WHERE r.wish_id=alert_outbox.wish_id),
    basis=(SELECT basis FROM alert_rule r WHERE r.wish_id=alert_outbox.wish_id),
    reference_cents=(SELECT target_cents FROM alert_rule r WHERE r.wish_id=alert_outbox.wish_id)
WHERE wish_id IS NOT NULL;
ALTER TABLE alert_outbox DROP COLUMN message;

-- Delivery of one outbox row through one channel, with its own attempts and backoff. The rows are created when the
-- alert is due, for the channels active then; the outbox row stays pending until every delivery is final.
CREATE TABLE channel_delivery (
    outbox_id INTEGER NOT NULL REFERENCES alert_outbox(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','failed','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    due INTEGER NOT NULL,
    sent_at INTEGER,
    -- Short German reason of the last failure ("HTTP 401 · Unauthorized"); never contains a secret.
    error TEXT,
    PRIMARY KEY(outbox_id,channel)
);
-- A cancelled alert (rule changed, game bought) stops its open deliveries too.
CREATE TRIGGER channel_delivery_cancel AFTER UPDATE OF state ON alert_outbox WHEN NEW.state='cancelled' BEGIN
    UPDATE channel_delivery SET state='cancelled' WHERE outbox_id=NEW.id AND state='pending';
END;
