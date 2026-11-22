-- 0.8.3: event log (Settings › Log). Short German entries, kept for seven days; never secrets.
CREATE TABLE event_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    level TEXT NOT NULL CHECK(level IN ('info','warn','error')),
    area TEXT NOT NULL,
    message TEXT NOT NULL
);
CREATE INDEX event_log_recent ON event_log(at DESC, id DESC);
-- Every insert drops entries older than seven days (the index keeps this cheap).
CREATE TRIGGER event_log_retention AFTER INSERT ON event_log BEGIN
    DELETE FROM event_log WHERE at < NEW.at - 604800;
END;
