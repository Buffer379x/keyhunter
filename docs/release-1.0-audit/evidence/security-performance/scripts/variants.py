import json, sys
qs = json.load(open(sys.argv[1]))
up_sql, up_args = qs["status_upcoming_candidates"]
ANY = "EXISTS(SELECT 1 FROM wishlist_item w WHERE w.state='wished')"
out = {}
out["upcoming_original"] = [up_sql, up_args]
out["upcoming_ohne_ANY_ACTIVE_WISH"] = [up_sql.replace(ANY, "1"), up_args]
out["upcoming_ANY_als_skalar"] = [up_sql.replace(ANY, "(SELECT COUNT(*)>0 FROM (SELECT 1 FROM wishlist_item w WHERE w.state='wished' LIMIT 1))"), up_args]
# claim inner select (as in jobs.rs claim): uses claimable + class
cl_sql, cl_args = qs["scheduler_claimable_exists (alle 3 s je Shop)"]
claimable = cl_sql[len("SELECT EXISTS(SELECT 1 "):-1]
cls = "CASE WHEN j.requested_at>?5 THEN 0 WHEN t.state='preview' THEN 4 WHEN j.wish_id IS NOT NULL AND j.checked_at IS NULL THEN 0 WHEN j.link_id IS NULL AND j.wish_id IS NULL THEN 5 WHEN j.link_id IS NOT NULL THEN CASE WHEN j.relevance=1 THEN 1 ELSE 3 END WHEN j.search_page>1 THEN 1 ELSE 2 END"
claim = f"""SELECT id FROM (SELECT j.id AS id, j.due AS due, {cls} AS class {claimable}
  AND NOT EXISTS(SELECT 1 FROM shop_job running WHERE running.source=j.source AND running.lease_until>?2))
  ORDER BY CASE WHEN class=0 THEN 0 WHEN (SELECT CASE WHEN q.budget_day=?3 THEN q.jobs_today ELSE 0 END FROM shop_state q WHERE q.source=?1)%4=3 THEN CASE WHEN class>=2 THEN 1 ELSE 2 END ELSE class END, due, id LIMIT 1"""
out["claim_select_original"] = [claim, cl_args]
out["claim_select_ohne_ANY_ACTIVE_WISH"] = [claim.replace(ANY, "1"), cl_args]
json.dump(out, open(sys.argv[2], "w"))
