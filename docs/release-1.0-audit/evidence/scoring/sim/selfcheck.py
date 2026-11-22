"""Checks the Python model against the expectations of the Rust unit tests (same inputs, same asserts).

Run: python3 -I selfcheck.py   (exit code 0 = all checks passed)
"""
import sys

import khsim as k

T0 = 1_800_000_000 - 1_800_000_000 % k.DAY
fails = []


def check(cond, what):
    print(("ok   " if cond else "FAIL ") + what)
    if not cond:
        fails.append(what)


# jobs.rs:2112-2125 pace_spreads_the_remaining_budget_over_the_rest_of_the_utc_day
check(k.pace_gap(T0, 500) == 172, "pace_gap(T0,500)=172")
check(k.pace_gap(T0, 120) == 720, "pace_gap(T0,120)=720")
check(k.pace_gap(T0 + k.DAY // 2, 120) == 360, "pace_gap(midday,120)=360")
check(k.pace_gap(T0, 10_000) == k.PACE_MIN, "pace_gap never below 20 s")
check(k.pace_gap(T0, 20) == k.PACE_MAX, "pace_gap never above 1 h")
check(k.pace_gap(T0 + k.DAY - 600, 0) == 600, "no budget left: wait for the new day")
check(k.pace_gap(T0 + k.DAY - 5, 1) == k.PACE_MIN, "pace_gap end of day")

# jobs.rs:2463-2488 price_trend_moves_slowly_and_maps_to_half_or_double_interval
check(k.price_position(1000, [1000]) is None, "position single price None")
check(k.price_position(1000, [1000, 1000]) is None, "position equal prices None")
check(k.price_position(1000, [3000, 1000, 2000]) == 0.0, "position cheapest 0")
check(k.price_position(2000, [3000, 1000, 2000]) == 0.5, "position middle 0.5")
check(k.price_position(3000, [3000, 1000, 2000]) == 1.0, "position most expensive 1")
check(abs(k.next_trend(0.5, 0.0) - 0.4) < 1e-9, "next_trend(0.5,0)=0.4")
check(k.next_trend(0.3, None) == 0.3, "next_trend without comparison unchanged")
s = 0.5
for _ in range(20):
    s = k.next_trend(s, 0.0)
check(s < 0.01, "20 cheapest measurements -> trend < 0.01")
check(abs(k.trend_pace(0.0) - 0.5) < 1e-9 and abs(k.trend_pace(0.5) - 1) < 1e-9 and abs(k.trend_pace(1.0) - 2) < 1e-9,
      "trend_pace 0/0.5/1 -> 0.5/1/2")
H = 3600
check(k.effective_interval(8 * H, False, 0.5) == 4 * H, "eff 8h pace .5 = 4h")
check(k.effective_interval(8 * H, False, 1.0) == 8 * H, "eff 8h pace 1 = 8h")
check(k.effective_interval(8 * H, False, 2.0) == 16 * H, "eff 8h pace 2 = 16h")
check(k.effective_interval(8 * H, True, 1.0) == 16 * H, "eff preview 8h = 16h")
check(k.effective_interval(k.WEEK, True, 2.0) == k.WEEK, "eff max a week")
check(k.effective_interval(900, False, 0.5) == 900, "eff min 15 min")

# offers.rs:739-763 score_follows_the_check_interval_factor
for pace, preview, score in [(0.5, False, 100), (0.707, False, 75), (1.0, False, 50), (None, False, 50),
                             (1.414, False, 25), (2.0, False, 0), (0.5, True, 50), (1.0, True, 0)]:
    check(k.score_0_100(pace, preview) == score, f"score({pace},{preview})={score}")


def offer(oid, game, valid, cents_fn):
    return k.Offer(id=oid, game=game, shop="eneba", valid=valid, ct=[float("-inf")], cents=[None])


# jobs.rs:2491-2577 cheap_regions_are_checked_more_often_expensive_and_sold_out_ones_less
prices = [100, 200, 300, None, 250]
offers = [k.Offer(id=i + 1, game=1, shop="eneba", valid=(i == 4), ct=[float("-inf")], cents=[prices[i]])
          for i in range(5)]
g = k.Game(id=1, offers=offers)
sim = k.Sim([g], [k.ShopCfg(limit=1_000_000)], k.POLICY_B, T0)
for j in list(sim.jobs.values()):            # only the product jobs of this wish
    if j.kind != "product":
        j.ver += 1
        j.key = None
        del sim.jobs[j.id]
t = T0
for _ in range(12):
    for o in offers:
        j = sim.job_of[o.id]
        j.due = t
        sim._push(j, t)
        shop = sim.shops["eneba"]
        shop.paced_until = 0
        got = sim.claim(shop, t)
        check(got is not None and got[0] is j, "claims the due link") if _ == 0 and o.id == 1 else None
        jj, cls, byp = got
        sim.complete(shop, jj, cls, sim.execute(shop, jj, t), t, t)
    t += 3600
rows = [(o.cheap_score, sim.job_of[o.id].pace, sim.job_of[o.id].due - sim.job_of[o.id].checked_at) for o in offers]
iv = 8 * 3600
check(rows[0][0] < 0.1 and rows[0][1] < 0.6 and rows[0][2] < iv * 6 // 10, f"cheapest: {rows[0]}")
check(abs(rows[1][1] - 1.0) < 0.1, f"middle: {rows[1]}")
check(rows[2][0] > 0.9 and rows[2][1] > 1.8 and rows[2][2] > iv * 18 // 10, f"most expensive: {rows[2]}")
check((rows[3][0], rows[3][1], rows[3][2]) == (0.5, k.SOLD_OUT_PACE, 2 * iv), f"sold out: {rows[3]}")
check(rows[4][0] > 0.65 and 1.3 < rows[4][1] < 1.5, f"DE-valid 2.50 not preferred: {rows[4]}")

# jobs.rs:2715-2818 demand_estimate_matches_an_unlimited_simulation (equal prices, previews x2)
games, oid = [], 0
for w in range(4):
    offs = []
    for n in range(5):
        oid += 1
        offs.append(k.Offer(id=oid, game=w * 2 + 1, shop="eneba", valid=n < 2, ct=[float("-inf")], cents=[2000]))
    games.append(k.Game(id=w * 2 + 1, offers=offs))
    offs = []
    for n in range(3):
        oid += 1
        offs.append(k.Offer(id=oid, game=w * 2 + 2, shop="eneba", valid=n < 1, ct=[float("-inf")], cents=[2000]))
    games.append(k.Game(id=w * 2 + 2, offers=offs, preview=True))
sim = k.Sim(games, [k.ShopCfg(limit=1_000_000)], k.POLICY_B, T0).run(T0 + 15 * k.DAY)
runs = sum(1 for e in sim.log if e[0] >= T0 + k.DAY)
est = 60 + 18 + 8 / 7 + 1
check(abs(runs / 14 - est) <= est * 0.03, f"unlimited simulation {runs / 14:.1f}/day vs estimate {est:.1f}/day")

# jobs.rs:1859-2045 budget_keeps_every_region_of_active_wishes_fresh_alike (300 products, budget 40)
games, oid = [], 0
for w in range(10):
    offs = []
    for n in range(10):
        oid += 1
        offs.append(k.Offer(id=oid, game=100 + w, shop="eneba", valid=n < 2, ct=[float("-inf")], cents=[2000]))
    games.append(k.Game(id=100 + w, offers=offs))
    for e in range(2):
        offs = []
        for n in range(10):
            oid += 1
            offs.append(k.Offer(id=oid, game=1000 + w * 10 + e, shop="eneba", valid=n < 2, ct=[float("-inf")],
                                cents=[2000]))
        games.append(k.Game(id=1000 + w * 10 + e, offers=offs, preview=True))
late = k.Game(id=9999, offers=[], created=T0 + 6 * k.DAY)
sim = k.Sim(games, [k.ShopCfg(limit=40)], k.POLICY_B, T0, events=[(T0 + 6 * k.DAY, k.ev_add_game(late))])
# the Rust test inserts every search unchecked (checked_at NULL): first runs are class 0
for j in sim.jobs.values():
    if j.kind == "search":
        j.checked_at = None
        sim._push(j, T0)
ok_stale = True
for day in range(5, 11):
    sim.run(T0 + day * k.DAY)
    for g in games:
        if g.preview:
            continue
        for o in g.offers:
            if o.observed_at is None or o.observed_at < T0 + day * k.DAY - 4 * k.DAY:
                ok_stale = False
check(ok_stale, "every region of an active wish at most four days old from day 5 on")
late_search = [e for e in sim.log if e[3] == "search" and e[0] >= T0 + 6 * k.DAY]
check(bool(late_search) and late_search[0][0] - (T0 + 6 * k.DAY) < 60, "a new wish is searched at once")
prev = [o for g in games if g.preview for o in g.offers]
never = sum(1 for o in prev if o.observed_at is None)
# The Rust test asserts this with stale_count(&previews, 0), i.e. COALESCE(observed_at,0) < 0, which is never
# true: the assertion is vacuous. Model and real code (xval/run_xval.sh, audit_budget_test_counts) both give
# 121 of 200 previews never measured, so a correct assertion would fail. Reported, not counted as a model error.
print(f"info previews never measured after 10 days: {never} of {len(prev)} (Rust asserts < half, vacuously)")
check(never == 121, "model matches the real code's 121/200 never-measured previews")
runs = len(sim.log)
check(40 * 9 <= runs <= 40 * 10, f"budget holds and is used: {runs} runs")
hours = {}
for e in sim.log:
    if e[0] >= T0 + k.DAY:
        hours[e[0] // 3600] = hours.get(e[0] // 3600, 0) + 1
check(max(hours.values()) <= 6, f"at most 6 jobs in one hour, got {max(hours.values())}")

print(f"{len(fails)} failed")
sys.exit(1 if fails else 0)
