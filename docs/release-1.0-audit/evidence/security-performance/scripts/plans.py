import sqlite3, sys, time, json
c = sqlite3.connect(sys.argv[1])
ITEM = "LEFT JOIN wishlist_item t ON t.id=COALESCE(j.wish_id,l.wish_id)"
PAUSED_AT = "(SELECT fetch_paused_at FROM app_settings WHERE id=1)"
NOT_OWNED = "COALESCE(t.state,'wished')!='owned'"
WATCHED = "(COALESCE(t.state,'wished')!='preview' OR (COALESCE(t.viewed_at,0)>?2-1209600 AND EXISTS(SELECT 1 FROM edition_watch ew JOIN wishlist_item aw ON aw.id=ew.wish_id WHERE ew.track_id=t.id AND aw.state='wished' AND (aw.paused_at IS NULL OR (aw.paused_until IS NOT NULL AND aw.paused_until<=?2)))))"
ANY = "EXISTS(SELECT 1 FROM wishlist_item w WHERE w.state='wished')"
HELD = "(t.paused_at IS NULL OR (t.paused_until IS NOT NULL AND t.paused_until<=?2) OR j.requested_at>?2-900)"
queued = f"(j.link_id IS NULL OR l.review!='rejected') AND {NOT_OWNED} AND {WATCHED} AND {ANY} AND {HELD}"
def cls(w): return f"CASE WHEN j.requested_at>{w} THEN 0 WHEN t.state='preview' THEN 4 WHEN j.wish_id IS NOT NULL AND j.checked_at IS NULL THEN 0 WHEN j.link_id IS NULL AND j.wish_id IS NULL THEN 5 WHEN j.link_id IS NOT NULL THEN CASE WHEN j.relevance=1 THEN 1 ELSE 3 END WHEN j.search_page>1 THEN 1 ELSE 2 END"
def bypass(w): return f"(({cls(w)})=0 OR (j.initial=1 AND COALESCE(t.state,'wished')='wished' AND (j.wish_id IS NOT NULL OR (j.link_id IS NOT NULL AND l.observed_at IS NULL))))"
claimable = f"""FROM shop_job j JOIN source_settings s ON s.id=j.source JOIN shop_state p ON p.source=j.source
 LEFT JOIN offer_link l ON l.id=j.link_id {ITEM}
 WHERE j.source=?1 AND s.enabled AND s.configured AND p.retry_at<=?2 AND (p.budget_day!=?3 OR p.jobs_today<COALESCE(s.daily_jobs,?4))
 AND j.due<=?2 AND j.lease_until<=?2 AND (p.paced_until<=?2 OR {bypass('?5')}) AND ({PAUSED_AT} IS NULL OR {bypass('?5')}) AND {queued}"""
items = """SELECT w.id, w.game_id, w.platform_id, w.created_at, g.manual_title, c.payload, EXISTS(SELECT 1 FROM cart_item k WHERE k.wish_id = w.id) AS in_cart, w.paused_at IS NOT NULL AND (w.paused_until IS NULL OR w.paused_until > CAST(strftime('%s','now') AS INTEGER)) AS paused, w.paused_until, (SELECT COALESCE(SUM(json_array_length(l.latest, '$.offers')), 0) FROM offer_link l JOIN source_settings s ON s.id = l.source WHERE l.wish_id = w.id AND l.review = 'confirmed' AND s.enabled AND s.configured AND l.latest IS NOT NULL) AS offer_count, (SELECT COUNT(*) FROM offer_link l JOIN source_settings s ON s.id = l.source WHERE l.wish_id = w.id AND s.enabled AND s.configured AND (l.review = 'pending' OR (l.review = 'confirmed' AND l.confirmed_name IS NOT NULL AND l.confirmed_name != json_extract(l.latest, '$.name')))) AS review_count FROM wishlist_item w JOIN game g ON g.id = w.game_id LEFT JOIN catalog_game c ON c.igdb_id = g.igdb_id WHERE w.state='wished' ORDER BY w.created_at DESC, w.rowid DESC"""
RUNS = "FROM job_run r LEFT JOIN offer_link l ON l.id=r.link_id LEFT JOIN wishlist_item w ON w.id=COALESCE(r.wish_id,l.wish_id) LEFT JOIN game g ON g.id=w.game_id LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id"
RCOLS = "r.id,r.source,r.kind,r.wish_id,r.link_id, COALESCE(json_extract(c.payload,'$.name'),g.manual_title) AS game,json_extract(l.latest,'$.region') AS region, r.started_at,r.duration_ms,r.outcome,r.detail"
RFILTER = r"""WHERE (?1 IS NULL OR CASE WHEN r.outcome='ok' THEN 'ok' WHEN r.outcome IN ('rate_limited','not_found') THEN 'warn' ELSE 'error' END=?1) AND (?2 IS NULL OR COALESCE(json_extract(c.payload,'$.name'),g.manual_title) LIKE ?2 ESCAPE '\' OR r.detail LIKE ?2 ESCAPE '\' OR r.source LIKE ?2 ESCAPE '\' OR r.outcome LIKE ?2 ESCAPE '\' OR r.kind LIKE ?2 ESCAPE '\')"""
ids = json.dumps([r[0] for r in c.execute("SELECT id FROM wishlist_item WHERE state='wished'")])
links = json.dumps([r[0] for r in c.execute("SELECT id FROM offer_link")])
t = int(time.time()); start = t - t % 86400 - 13 * 86400
Q = {
 "wishlist_items (offer_count/review_count je Zeile)": (items, ()),
 "scheduler_claimable_exists (alle 3 s je Shop)": (f"SELECT EXISTS(SELECT 1 {claimable})", ("eneba", t, t // 86400, 500, t - 900)),
 "badges_job_summary": ("""SELECT COALESCE(j.wish_id,l.wish_id) AS item,MAX(j.checked_at),COALESCE(MAX(j.last_error IS NOT NULL),0),COALESCE(MAX((j.lease_until>?1 OR j.due<=?1) AND s.enabled AND s.configured AND (j.link_id IS NULL OR l.review!='rejected') AND COALESCE(w.state,'wished')!='owned' AND p.retry_at<=?1 AND (p.budget_day!=?2 OR p.jobs_today<COALESCE(s.daily_jobs,?3)) AND ((SELECT fetch_paused_at FROM app_settings WHERE id=1) IS NULL OR j.requested_at>?1-900)),0) FROM shop_job j JOIN source_settings s ON s.id=j.source JOIN shop_state p ON p.source=j.source LEFT JOIN offer_link l ON l.id=j.link_id LEFT JOIN wishlist_item w ON w.id=COALESCE(j.wish_id,l.wish_id) WHERE COALESCE(j.wish_id,l.wish_id) IN (SELECT value FROM json_each(?4)) GROUP BY 1""", (t, t // 86400, 500, ids)),
 "badges_links_of_items": ("""SELECT l.*, (s.enabled AND s.configured) AS enabled, s.fee_estimation_enabled, s.fee_basis_points, p.retry_at, COALESCE(j.lease_until>?,0) OR COALESCE(j.due<=? AND s.enabled AND p.retry_at<=? AND (p.budget_day!=? OR p.jobs_today<COALESCE(s.daily_jobs,?)) AND ((SELECT fetch_paused_at FROM app_settings WHERE id=1) IS NULL OR j.requested_at>?),0) AS queued FROM offer_link l JOIN source_settings s ON s.id=l.source JOIN shop_state p ON p.source=l.source LEFT JOIN shop_job j ON j.link_id=l.id WHERE l.wish_id IN (SELECT value FROM json_each(?)) ORDER BY l.id""", (t, t, t, t // 86400, 500, t - 900, ids)),
 "badges_trend_samples (Cache-Miss, alle Links)": ("""SELECT l.id, (SELECT p.valid_cents FROM price_observation p WHERE p.link_id=l.id AND p.market=?2 AND p.fingerprint=l.fingerprint AND p.observed_at<?3 ORDER BY p.observed_at DESC LIMIT 1), (SELECT group_concat(o.observed_at||':'||COALESCE(o.valid_cents,''),',') FROM price_observation o WHERE o.link_id=l.id AND o.market=?2 AND o.fingerprint=l.fingerprint AND o.observed_at>=?3 AND o.observed_at<=?4) FROM offer_link l WHERE l.id IN (SELECT value FROM json_each(?1))""", (links, "DE", start, t)),
 "status_backlog": (f"SELECT COUNT(*),MIN(j.due),SUM(j.requested_at>?3),SUM(j.link_id IS NOT NULL),SUM(j.wish_id IS NOT NULL) FROM shop_job j LEFT JOIN offer_link l ON l.id=j.link_id {ITEM} WHERE j.source=?1 AND j.due<=?2 AND j.lease_until<=?2 AND (j.link_id IS NULL OR l.review!='rejected') AND {NOT_OWNED} AND {WATCHED} AND {HELD}", ("eneba", t, t - 900)),
 "status_next_job": (f"SELECT MIN(CASE WHEN {bypass('?3')} THEN j.due ELSE MAX(j.due,?4) END) FROM shop_job j LEFT JOIN offer_link l ON l.id=j.link_id {ITEM} WHERE j.source=?1 AND {queued}", ("eneba", t, t - 900, t)),
 "status_demand": (f"SELECT MIN(j.link_id),MIN(j.wish_id),COALESCE(t.state,'wished')='preview',s.poll_interval_seconds,j.pace,COUNT(*) FROM shop_job j JOIN source_settings s ON s.id=j.source LEFT JOIN offer_link l ON l.id=j.link_id {ITEM} WHERE j.source=?1 AND s.enabled AND s.configured AND {queued} GROUP BY j.link_id IS NOT NULL,j.wish_id IS NOT NULL,3,4,5", ("eneba", t)),
 "status_upcoming_candidates": (f"SELECT j.id,j.source,j.link_id,j.wish_id,j.search_page,j.due,j.requested_at>?3 AS requested, {cls('?3')} AS class,{bypass('?3')} AS bypass, COALESCE(json_extract(c.payload,'$.name'),g.manual_title) AS game,json_extract(l.latest,'$.region') AS region FROM shop_job j LEFT JOIN offer_link l ON l.id=j.link_id {ITEM} LEFT JOIN game g ON g.id=t.game_id LEFT JOIN catalog_game c ON c.igdb_id=g.igdb_id WHERE j.source=?1 AND j.lease_until<=?2 AND (NOT ?4 OR {bypass('?3')}) AND {queued} ORDER BY MAX(j.due,CASE WHEN {bypass('?3')} THEN 0 ELSE ?5 END),class,j.due,j.id LIMIT ?6", ("eneba", t, t - 900, 0, t, 200)),
 "status_recent_runs": (f"SELECT {RCOLS} {RUNS} ORDER BY r.started_at DESC,r.id DESC LIMIT 25", ()),
 "status_errors_24h": ("SELECT COUNT(*) FROM job_run WHERE started_at>? AND outcome!='ok'", (t - 86400,)),
 "status_by_hour": ("SELECT (started_at-?2)/3600,COUNT(*) FROM job_run WHERE source=?1 AND started_at>=?2 AND started_at<?2+86400 GROUP BY 1", ("eneba", t - t % 86400)),
 "runs_count_q=Perf Halo (LIKE)": (f"SELECT COUNT(*) {RUNS} {RFILTER}", (None, "%Perf Halo%")),
 "runs_page_q=Perf Halo (LIKE)": (f"SELECT {RCOLS} {RUNS} {RFILTER} ORDER BY r.started_at DESC,r.id DESC LIMIT 50 OFFSET 0", (None, "%Perf Halo%")),
 "runs_count_ohne_filter": (f"SELECT COUNT(*) {RUNS} {RFILTER}", (None, None)),
 "log_count_q (LIKE)": (r"SELECT COUNT(*) FROM event_log WHERE (?1 IS NULL OR level=?1) AND (?2 IS NULL OR message LIKE ?2 ESCAPE '\' OR area LIKE ?2 ESCAPE '\')", (None, "%Perf%")),
}
for name, (sql, args) in Q.items():
    plan = [r[3] for r in c.execute("EXPLAIN QUERY PLAN " + sql, args)]
    ts = []
    for _ in range(5):
        a = time.perf_counter(); rows = c.execute(sql, args).fetchall(); ts.append((time.perf_counter() - a) * 1000)
    ts.sort()
    print(f"### {name}\nmedian {ts[2]:.1f} ms, rows {len(rows)}")
    for p in plan: print("   ", p)
