-- Phase A scheduling: requested refreshes, relevance for adaptive intervals and a fetch history.
ALTER TABLE shop_job ADD COLUMN requested_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shop_job ADD COLUMN relevance INTEGER NOT NULL DEFAULT 1 CHECK(relevance IN (1, 2));
CREATE TABLE job_run (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('product', 'search', 'discovery')),
    wish_id TEXT,
    link_id INTEGER,
    started_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    detail TEXT
);
CREATE INDEX job_run_recent ON job_run(started_at DESC, id DESC);
