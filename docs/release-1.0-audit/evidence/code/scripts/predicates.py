"""Reproduce: the scheduler skips the jobs of a paused wish, the display predicates still call them queued/pending.
SQL constants (jobs.rs) and the display queries (price_badges.rs, offers.rs) are extracted verbatim from the sources;
the format! composition of claimable()/class()/bypass() (jobs.rs:202-246) is rebuilt below. Schema from all migrations, in memory."""
import sqlite3, glob, os, re, sys, time
repo = sys.argv[1]
src = lambda p: open(os.path.join(repo, 'backend/src', p)).read()
con = sqlite3.connect(':memory:'); con.isolation_level = None
for f in sorted(glob.glob(os.path.join(repo, 'backend/migrations/*.sql'))):
    con.executescript(open(f).read())
jobs = src('jobs.rs')
const = lambda name: re.search(r'const %s: &str = "(.*?)";' % name, jobs, re.S).group(1)
ITEM, PAUSED_AT, NOT_OWNED, WATCHED, ANY, NOT_HELD = (const(n) for n in
    ['ITEM', 'PAUSED_AT', 'NOT_OWNED', 'WATCHED_IF_PREVIEW', 'ANY_ACTIVE_WISH', 'NOT_HELD'])
queued = f"(j.link_id IS NULL OR l.review!='rejected') AND {NOT_OWNED} AND {WATCHED} AND {ANY} AND {NOT_HELD}"
cls = lambda w: f"""CASE WHEN j.requested_at>{w} THEN 0 WHEN t.state='preview' THEN 4
    WHEN j.wish_id IS NOT NULL AND j.checked_at IS NULL THEN 0 WHEN j.link_id IS NULL AND j.wish_id IS NULL THEN 5
    WHEN j.link_id IS NOT NULL THEN CASE WHEN j.relevance=1 THEN 1 ELSE 3 END WHEN j.search_page>1 THEN 1 ELSE 2 END"""
bypass = lambda w: f"""(({cls(w)})=0 OR (j.initial=1 AND COALESCE(t.state,'wished')='wished'
    AND (j.wish_id IS NOT NULL OR (j.link_id IS NOT NULL AND l.observed_at IS NULL))))"""
# claimable() of jobs.rs (format! arguments: bypass("?5"), bypass("?5"), queued())
claimable = f"""FROM shop_job j JOIN source_settings s ON s.id=j.source JOIN shop_state p ON p.source=j.source
    LEFT JOIN offer_link l ON l.id=j.link_id {ITEM}
    WHERE j.source=?1 AND s.enabled AND s.configured AND p.retry_at<=?2
    AND (p.budget_day!=?3 OR p.jobs_today<COALESCE(s.daily_jobs,?4))
    AND j.due<=?2 AND j.lease_until<=?2 AND (p.paced_until<=?2 OR {bypass('?5')})
    AND ({PAUSED_AT} IS NULL OR {bypass('?5')}) AND {queued}"""
badges_sql = re.search(r'let jobs: Vec<JobSummary> = sqlx::query_as\("(.*?)"\)', src('price_badges.rs'), re.S).group(1)
links_sql = re.search(r'pub\(crate\) async fn links<.*?sqlx::query_as\("(.*?)"\)', src('offers.rs'), re.S).group(1)
t = int(time.time()); day = t // 86400
con.executescript(f"""
INSERT INTO game(id,manual_title,manual_key,created_at) VALUES('g','Game','game',0),('h','Other','other',0);
INSERT INTO wishlist_item(id,game_id,platform_id,created_at,paused_at) VALUES('paused','g',169,0,{t-3600}),('active','h',169,0,NULL);
INSERT INTO offer_link(id,wish_id,source,url,review) VALUES(1,'paused','eneba','https://www.eneba.com/de/xbox-a-key-x','confirmed');
INSERT INTO shop_job(source,link_id,due,checked_at) VALUES('eneba',1,{t-60},{t-30000});
""")
claim = con.execute("SELECT COUNT(*) " + claimable + " AND j.link_id=1", (  'eneba', t, day, 500, t-900)).fetchone()[0]
pending = con.execute(badges_sql, (t, day, 500, '["paused"]')).fetchall()
queued_link = con.execute("SELECT queued FROM (" + links_sql.replace(' ORDER BY l.id', '') + ")", (t, t, t, day, 500, t-900, 'paused')).fetchall()
print("paused wish, product job due 60 s ago")
print("  scheduler (jobs.rs claimable):         claimable rows =", claim)
con.execute("UPDATE wishlist_item SET paused_at=NULL WHERE id='paused'")
print("  same job after resuming the wish:      claimable rows =", con.execute("SELECT COUNT(*) " + claimable + " AND j.link_id=1", ('eneba', t, day, 500, t-900)).fetchone()[0])
con.execute("UPDATE wishlist_item SET paused_at=? WHERE id='paused'", (t-3600,))
print("  wishlist badge (price_badges.rs):      pending =", [bool(r[3]) for r in pending])
print("  offers tab (offers.rs links):          queued  =", [bool(r[0]) for r in queued_link])
