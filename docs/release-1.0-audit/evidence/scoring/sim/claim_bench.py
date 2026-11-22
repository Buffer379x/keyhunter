"""Cost of the real scheduler SQL (jobs.rs) as a function of queue size, on SQLite via Python's sqlite3.

The SQL strings are assembled exactly like jobs.rs:188-245 and 284-296 (format! of the same constants);
the schema comes from applying backend/migrations/*.sql in order. Python's SQLite (3.46.x) is close to,
but not necessarily identical with, the SQLite bundled by sqlx; numbers are an approximation.

  python3 claim_bench.py [--sizes 100,1000,3000,10000,30000]
"""
import argparse
import glob
import json
import os
import sqlite3
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", ".."))
DAY = 86400

ITEM = "LEFT JOIN wishlist_item t ON t.id=COALESCE(j.wish_id,l.wish_id)"
PAUSED_AT = "(SELECT fetch_paused_at FROM app_settings WHERE id=1)"
NOT_OWNED = "COALESCE(t.state,'wished')!='owned'"
WATCHED_IF_PREVIEW = ("(COALESCE(t.state,'wished')!='preview' OR (COALESCE(t.viewed_at,0)>?2-1209600 AND EXISTS(SELECT 1 FROM "
                      "edition_watch ew JOIN wishlist_item aw ON aw.id=ew.wish_id WHERE ew.track_id=t.id AND aw.state='wished' "
                      "AND (aw.paused_at IS NULL OR (aw.paused_until IS NOT NULL AND aw.paused_until<=?2)))))")
ANY_ACTIVE_WISH = "EXISTS(SELECT 1 FROM wishlist_item w WHERE w.state='wished')"
NOT_HELD = "(t.paused_at IS NULL OR (t.paused_until IS NOT NULL AND t.paused_until<=?2) OR j.requested_at>?2-900)"


def queued():
    return (f"(j.link_id IS NULL OR l.review!='rejected') AND {NOT_OWNED} AND {WATCHED_IF_PREVIEW} AND "
            f"{ANY_ACTIVE_WISH} AND {NOT_HELD}")


def klass(w):
    return (f"CASE WHEN j.requested_at>{w} THEN 0 WHEN t.state='preview' THEN 4 WHEN j.wish_id IS NOT NULL AND "
            f"j.checked_at IS NULL THEN 0 WHEN j.link_id IS NULL AND j.wish_id IS NULL THEN 5 WHEN j.link_id IS NOT NULL "
            f"THEN CASE WHEN j.relevance=1 THEN 1 ELSE 3 END WHEN j.search_page>1 THEN 1 ELSE 2 END")


def bypass(w):
    return (f"(({klass(w)})=0 OR (j.initial=1 AND COALESCE(t.state,'wished')='wished' AND (j.wish_id IS NOT NULL OR "
            f"(j.link_id IS NOT NULL AND l.observed_at IS NULL))))")


def claimable():
    return (f"FROM shop_job j JOIN source_settings s ON s.id=j.source JOIN shop_state p ON p.source=j.source "
            f"LEFT JOIN offer_link l ON l.id=j.link_id {ITEM} WHERE j.source=?1 AND s.enabled AND s.configured AND "
            f"p.retry_at<=?2 AND (p.budget_day!=?3 OR p.jobs_today<COALESCE(s.daily_jobs,?4)) AND j.due<=?2 AND "
            f"j.lease_until<=?2 AND (p.paced_until<=?2 OR {bypass('?5')}) AND ({PAUSED_AT} IS NULL OR {bypass('?5')}) "
            f"AND {queued()}")


PENDING = f"SELECT EXISTS(SELECT 1 {claimable()})"
CLAIM = (f"UPDATE shop_job SET lease_until=?6,lease_token=?7 WHERE id=(SELECT id FROM (SELECT j.id AS id, j.due AS due, "
         f"{klass('?5')} AS class {claimable()} AND NOT EXISTS(SELECT 1 FROM shop_job running WHERE "
         f"running.source=j.source AND running.lease_until>?2)) ORDER BY CASE WHEN class=0 THEN 0 WHEN (SELECT CASE "
         f"WHEN q.budget_day=?3 THEN q.jobs_today ELSE 0 END FROM shop_state q WHERE q.source=?1)%4=3 THEN CASE WHEN "
         f"class>=2 THEN 1 ELSE 2 END ELSE class END, due, id LIMIT 1) RETURNING id,link_id,failures,wish_id,search_page")
TREND = ("SELECT l.latest FROM offer_link l JOIN source_settings s ON s.id=l.source WHERE l.wish_id=? AND l.id!=? AND "
         "l.review='confirmed' AND s.enabled AND s.configured AND l.latest IS NOT NULL AND l.observed_at>?")
DEMAND = (f"SELECT MIN(j.link_id),MIN(j.wish_id),COALESCE(t.state,'wished')='preview',s.poll_interval_seconds,j.pace,COUNT(*) "
          f"FROM shop_job j JOIN source_settings s ON s.id=j.source LEFT JOIN offer_link l ON l.id=j.link_id {ITEM} "
          f"WHERE j.source=?1 AND s.enabled AND s.configured AND {queued()} GROUP BY j.link_id IS NOT NULL,"
          f"j.wish_id IS NOT NULL,3,4,5")


def build(n_jobs, due_share, t):
    db = sqlite3.connect(":memory:")
    for f in sorted(glob.glob(os.path.join(ROOT, "backend", "migrations", "*.sql"))):
        db.executescript(open(f).read())
    k = 8
    wishes = max(1, n_jobs // (k + 1))
    latest = json.dumps({"id": "x", "name": "Game", "title": "Game", "platform_ids": [169], "key_game": True,
                         "region": "Global", "allowed": ["DE"], "blocked": [], "purchase_country": "DE",
                         "offers": [{"id": "q", "cents": 2000, "seller": None}], "availability": "in_stock"})
    db.execute("BEGIN")
    n = 0
    for w in range(wishes):
        wid = f"w{w}"
        db.execute("INSERT INTO game(id,manual_title,manual_key,created_at) VALUES(?,?,?,0)", (wid, wid, wid))
        db.execute("INSERT INTO wishlist_item(id,game_id,platform_id,created_at) VALUES(?,?,169,0)", (wid, wid))
        db.execute("INSERT INTO shop_job(source,wish_id,due,checked_at) VALUES('eneba',?,?,?)", (wid, t + 3 * DAY, t - DAY))
        for i in range(k):
            lid = db.execute("INSERT INTO offer_link(wish_id,source,url,review,latest,observed_at) VALUES(?,'eneba',?,"
                             "'confirmed',?,?) RETURNING id", (wid, f"https://www.eneba.com/x-{w}-{i}", latest, t - 3600)).fetchone()[0]
            n += 1
            due = t - 600 if (n * 7919 % 1000) < due_share * 1000 else t + 3600 + n % 28800
            db.execute("INSERT INTO shop_job(source,link_id,due,pace) VALUES('eneba',?,?,?)", (lid, due, 0.5 + (n % 7) / 4))
    db.execute("UPDATE shop_state SET paced_until=0")
    db.execute("COMMIT")
    return db, wishes * (k + 1) + 2


def timed(db, sql, params, reps):
    best = []
    for _ in range(reps):
        c = time.perf_counter()
        db.execute("SAVEPOINT b")
        db.execute(sql, params).fetchall()
        db.execute("ROLLBACK TO b")
        db.execute("RELEASE b")
        best.append(time.perf_counter() - c)
    best.sort()
    return best[len(best) // 2] * 1000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sizes", default="100,1000,3000,10000,30000")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "results", "claim_bench.json"))
    a = ap.parse_args()
    t = 1_800_000_000 - 1_800_000_000 % DAY + 12 * 3600
    p = (("eneba", t, t // DAY, 500, t - 900))
    res = {"sqlite": sqlite3.sqlite_version, "rows": []}
    for n in (int(x) for x in a.sizes.split(",")):
        for due_share in (0.0, 0.3):
            db, jobs = build(n, due_share, t)
            reps = 30 if n <= 3000 else 8
            row = {"jobs": jobs, "due_share": due_share,
                   "pending_ms": timed(db, PENDING, p, reps),
                   "claim_ms": timed(db, CLAIM, p + (t + 180, "token"), reps),
                   "trend_others_ms": timed(db, TREND, ("w1", 5, t - 7 * DAY), reps),
                   "demand_ms": timed(db, DEMAND, ("eneba", t), reps)}
            row["idle_cpu_share_pct"] = row["pending_ms"] / 3000 * 100   # one EXISTS every 3 s while idle (jobs.rs:151)
            res["rows"].append(row)
            print(row, flush=True)
    db, _ = build(1000, 0.3, t)
    res["plan_claim"] = [r[3] for r in db.execute("EXPLAIN QUERY PLAN " + CLAIM, p + (t + 180, "token")).fetchall()]
    res["plan_pending"] = [r[3] for r in db.execute("EXPLAIN QUERY PLAN " + PENDING, p).fetchall()]
    json.dump(res, open(a.out, "w"), indent=1)
    print("\n".join(res["plan_claim"]))


if __name__ == "__main__":
    main()
