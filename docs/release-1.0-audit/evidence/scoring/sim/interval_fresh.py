"""Interplay of the shop interval with the fixed 24 h freshness rule (pricing.rs:18): share of offers whose
price no longer counts as current, and wrong best prices, for intervals the settings allow (15 min - 7 days).

  python3 interval_fresh.py > ../results/interval_fresh.json
"""
import json
import run_scenarios as rs
import khsim as k

H = 3600
out = {}
for iv in (8 * H, 12 * H, 16 * H, 24 * H):
    for name in ("A", "B", "C"):
        m = rs.evaluate(rs.simulate(rs.POLICIES[name], 1, 40, 2000, iv))
        out[f"{iv // H} h | {name}"] = {kk: round(m[kk], 4) for kk in (
            "product_requests_per_day", "offer_not_current_share", "wrong_best_world_share", "wrong_best_target_share",
            "detected_share", "max_age_h")}
print(json.dumps(out, indent=1))
