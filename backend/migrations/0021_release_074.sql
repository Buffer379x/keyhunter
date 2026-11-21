-- 0.7.4: the box "Weiteren Shop hinzufügen" is gone. Every built-in shop reader is always listed in
-- Key-Shops; the switch "Aktiv" (enabled) is the only control. A shop that was not added (or was removed)
-- before stays switched off, so nothing starts fetching on its own.
UPDATE source_settings SET enabled=0 WHERE kind='shop' AND configured=0;
UPDATE source_settings SET configured=1 WHERE kind='shop';
