-- Release 0.7.0: the owner pauses the automatic shop checks (Abrufstatus) and resumes them later.
-- NULL = running; otherwise the time the pause began. Direct user actions (refresh, first search) still run.
ALTER TABLE app_settings ADD COLUMN fetch_paused_at INTEGER;
