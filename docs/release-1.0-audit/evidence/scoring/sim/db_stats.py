"""Aggregate statistics of the old real database copy (schema 0010, before migration 0012). Read-only:
the database and its WAL are copied to a scratch directory first and opened with mode=ro. Only counts,
rates and ratios are printed - no names, URLs, prices of identifiable products, hashes or tokens.

  python3 db_stats.py <path/to/keyhunter.db> <scratch-dir>
"""
import collections
import json
import os
import shutil
import sqlite3
import statistics as st
import sys


def main(src, scratch):
    os.makedirs(scratch, exist_ok=True)
    for suffix in ("", "-wal"):
        if os.path.exists(src + suffix):
            shutil.copy(src + suffix, os.path.join(scratch, "copy.db" + suffix))
    db = sqlite3.connect(f"file:{os.path.join(scratch, 'copy.db')}?mode=ro", uri=True)
    out = {"schema_version": db.execute("SELECT MAX(version) FROM _sqlx_migrations").fetchone()[0]}
    rows = db.execute("SELECT o.link_id, l.wish_id, o.observed_at, o.offers, o.availability FROM price_observation o "
                      "JOIN offer_link l ON l.id=o.link_id ORDER BY o.link_id, o.observed_at").fetchall()
    per = collections.defaultdict(list)
    for lid, wish, t, offers, avail in rows:
        cents = [q.get("cents") for q in json.loads(offers) if isinstance(q, dict) and isinstance(q.get("cents"), int)
                 and 1 <= q["cents"] <= 10_000_000]
        per[(wish, lid)].append((t, min(cents) if cents and avail == "in_stock" else None))
    ts = [r[2] for r in rows]
    gaps = [b[0] - a[0] for v in per.values() for a, b in zip(v, v[1:])]
    pairs = [(a[1], b[1]) for v in per.values() for a, b in zip(v, v[1:])]
    priced = [(a, b) for a, b in pairs if a and b]
    link_days = sum(gaps) / 86400
    rel = [abs(b - a) / a for a, b in priced]
    out.update({
        "observations": len(rows), "span_hours": round((max(ts) - min(ts)) / 3600, 1),
        "links_with_observations": len(per), "observations_per_link_median": st.median(len(v) for v in per.values()),
        "observations_per_link_max": max(len(v) for v in per.values()),
        "gap_hours_deciles": [round(x / 3600, 1) for x in st.quantiles(gaps, n=10)],
        "consecutive_pairs": len(pairs), "priced_pairs": len(priced),
        "sold_out_share_of_observations": round(sum(1 for r in rows if r[4] != "in_stock") / len(rows), 3),
        "stock_transitions": sum(1 for a, b in pairs if (a is None) != (b is None)),
        "changes_per_link_day": {f">{th:g}%": round(sum(1 for x in rel if x > th / 100) / link_days, 3)
                                 for th in (0, 0.5, 2, 5, 10)},
        "drops": sum(1 for a, b in priced if b < a), "rises": sum(1 for a, b in priced if b > a),
        "link_errors": dict(db.execute("SELECT COALESCE(last_error,'none'), COUNT(*) FROM offer_link GROUP BY 1")),
    })
    latest = collections.defaultdict(dict)
    for (wish, lid), v in per.items():
        last = [x for x in v if x[1]]
        if last:
            latest[wish][lid] = last[-1][1]
    out["priced_links_per_wish"] = dict(sorted(collections.Counter(len(d) for d in latest.values()).items()))
    ratios = sorted(max(d.values()) / min(d.values()) for d in latest.values() if len(d) >= 2)
    out["max_min_ratio_per_wish"] = {"median": round(st.median(ratios), 2), "min": round(ratios[0], 2),
                                     "max": round(ratios[-1], 2), "n": len(ratios)}
    out["share_within_10pct_of_min_median"] = round(st.median(
        sum(1 for p in d.values() if p <= 1.1 * min(d.values())) / len(d) for d in latest.values() if len(d) >= 3), 2)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
