"""Benchmark and edge-case runs of the scheduler model (A fixed, B current, C candidate).

  python3 run_scenarios.py all   --out ../results      (everything below, ~10-20 min on 8 cores)
  python3 run_scenarios.py bench --out ../results      (regimes R1-R3, seeds 1-5, budget-matched)
  python3 run_scenarios.py sweep --out ../results      (wishlist size sweep at the default budget)
  python3 run_scenarios.py edge  --out ../results      (SPEC 10A F edge cases)

All randomness comes from random.Random(seed); runs are deterministic (see E12).
"""
import argparse
import hashlib
import json
import math
import multiprocessing as mp
import os
import random
import statistics as st
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import khsim as k  # noqa: E402
import metrics  # noqa: E402
import traces  # noqa: E402

T0 = 1_800_000_000 - 1_800_000_000 % k.DAY
DAYS, WARM = 45, 5
H = 3600
P = k.Policy
POLICIES = {
    "A": k.POLICY_A,
    "B": k.POLICY_B,
    "C": P("C", trend="gap"),
}
ABLATIONS = {
    "C-ohne-Zielland": P("C-ohne-Zielland", trend="gap", target_aware=False),
    "C-R4": P("C-R4", trend="gap", gap_ratio=4.0),
    "B+Streckung": P("B+Streckung", stretch=True),
    "C+Kontext": P("C+Kontext", trend="gap", context_refresh=True),
    "C+ausverkauft1": P("C+ausverkauft1", trend="gap", soldout_pace=1.0),
}
REGIMES = {  # name: (games, daily budget, shop interval)
    "R1 ausreichend (40 Spiele, Budget 2000)": (40, 2000, 8 * H),
    "R2 knapp (80 Spiele, Budget 500)": (80, 500, 8 * H),
    "R3 sehr knapp (300 Spiele, Budget 500)": (300, 500, 8 * H),
    "R3b gross (300 Spiele, Budget 2000)": (300, 2000, 8 * H),
}
KEYS = ["product_requests_per_day", "detected_share", "attractive_missed_share", "delay_mean_h", "delay_p90_h",
        "attractive_delay_mean_h", "requests_per_detected", "offer_not_current_share", "wrong_best_world_share",
        "wrong_best_target_share", "max_age_h", "p99_age_h", "peak_per_hour", "relevant_events", "throttled"]


def with_interval(pol, iv):
    d = dict(pol.__dict__)
    d["interval_override"] = int(iv)
    d["name"] = f"{pol.name}@{iv / H:.2f}h"
    return k.Policy(**d)


def simulate(pol, seed, ngames, limit, interval, days=DAYS, events=None, shops=None, games=None, **kw):
    games = games if games is not None else traces.portfolio(seed, ngames, T0, days, **kw)
    shops = shops or [k.ShopCfg(interval=interval, limit=limit)]
    rnd = random.Random(seed * 7919)
    sim = k.Sim(games, shops, pol, T0, jitter=lambda: rnd.randint(0, 30), events=events)
    c = time.process_time()
    sim.run(T0 + days * k.DAY)
    sim.cpu = time.process_time() - c
    return sim


def evaluate(sim, days=DAYS, warm=WARM, sample=600):
    m = metrics.evaluate(sim, T0 + warm * k.DAY, T0 + days * k.DAY, sample=sample)
    m["sim_cpu_s"] = sim.cpu
    m["fetches"] = len(sim.log)
    return m


def product_rate(sim, warm=WARM, days=DAYS):
    n = sum(1 for e in sim.log if e[3] == "product" and e[0] >= T0 + warm * k.DAY)
    return n / (days - warm)


def calibrate(pol, seed, ngames, limit, interval, target_rate, lo=1 * H, hi=48 * H):
    """Base interval at which `pol` makes `target_rate` product requests per day (bisection on log scale)."""
    for _ in range(12):
        mid = math.sqrt(lo * hi)
        r = product_rate(simulate(with_interval(pol, mid), seed, ngames, limit, interval))
        if r > target_rate:
            lo = mid
        else:
            hi = mid
    return math.sqrt(lo * hi)


def calibrate_quality(pol, seed, ngames, limit, interval, target, key="detected_share", lo=1 * H, hi=48 * H):
    """Base interval at which `pol` reaches the detection share `target` (quality-matched)."""
    for _ in range(10):
        mid = math.sqrt(lo * hi)
        v = evaluate(simulate(with_interval(pol, mid), seed, ngames, limit, interval))[key]
        if v > target:
            lo = mid
        else:
            hi = mid
    return math.sqrt(lo * hi)


# ---------------------------------------------------------------------------------------------------------
def bench_job(args):
    regime, seed = args
    ng, limit, iv = REGIMES[regime]
    out = {}
    sims = {}
    for name, pol in POLICIES.items():
        sims[name] = simulate(pol, seed, ng, limit, iv)
        out[name] = evaluate(sims[name], sample=600 if ng <= 100 else 1200)
    rate_b = product_rate(sims["B"])
    # budget-matched variants where the plain run used a different number of requests than B
    for name in ("A", "C"):
        if abs(product_rate(sims[name]) - rate_b) > 0.02 * rate_b:
            ivc = calibrate(POLICIES[name], seed, ng, limit, iv, rate_b)
            m = evaluate(simulate(with_interval(POLICIES[name], ivc), seed, ng, limit, iv),
                         sample=600 if ng <= 100 else 1200)
            m["calibrated_interval_h"] = ivc / H
            out[name + "_gleiches_Budget"] = m
    if ng <= 100:
        for name, pol in ABLATIONS.items():
            out[name] = evaluate(simulate(pol, seed, ng, limit, iv))
    if regime.startswith("R1"):
        # quality-matched: the interval at which A / C detect as many relevant changes as B
        for name in ("A", "C"):
            ivq = calibrate_quality(POLICIES[name], seed, ng, limit, iv, out["B"]["detected_share"])
            m = evaluate(simulate(with_interval(POLICIES[name], ivq), seed, ng, limit, iv))
            m["calibrated_interval_h"] = ivq / H
            out[name + "_gleiche_Erkennung"] = m
    return regime, seed, out


def summarize(runs):
    """runs: {regime: {seed: {policy: metrics}}} -> {regime: {policy: {key: (mean, min, max)}}}"""
    out = {}
    for regime, seeds in runs.items():
        pols = sorted({p for s in seeds.values() for p in s})
        out[regime] = {}
        for p in pols:
            row = {}
            # a seed without a "_gleiches_Budget" run already matched B within 2 %: its plain run counts
            def pick(s, p=p):
                if p in s:
                    return s[p]
                base = p.replace("_gleiches_Budget", "")
                return s.get(base) if p.endswith("_gleiches_Budget") else None
            for key in KEYS + ["calibrated_interval_h", "sim_cpu_s"]:
                vals = [pick(s)[key] for s in seeds.values() if pick(s) is not None and pick(s).get(key) is not None]
                if key == "calibrated_interval_h" and p.endswith("_gleiches_Budget"):
                    vals = [pick(s).get(key, 8.0) for s in seeds.values() if pick(s) is not None]
                if vals:
                    row[key] = (st.mean(vals), min(vals), max(vals))
            out[regime][p] = row
    return out


def bench(outdir, seeds):
    jobs = [(r, s) for r in REGIMES for s in seeds]
    runs = {}
    with mp.Pool(min(8, os.cpu_count() or 1)) as pool:
        for regime, seed, out in pool.imap_unordered(bench_job, jobs):
            runs.setdefault(regime, {})[seed] = out
            print("done", regime, seed, flush=True)
    json.dump(runs, open(os.path.join(outdir, "bench_raw.json"), "w"), indent=1, default=str)
    json.dump(summarize(runs), open(os.path.join(outdir, "bench_summary.json"), "w"), indent=1)


# ---------------------------------------------------------------------------------------------------------
def sweep_job(args):
    ng, name, seed = args
    m = evaluate(simulate(POLICIES[name], seed, ng, 500, 8 * H), sample=600 if ng <= 100 else 1800)
    return ng, name, seed, {kk: m[kk] for kk in KEYS}


def sweep(outdir, seeds):
    jobs = [(ng, name, s) for ng in (10, 25, 50, 100, 200, 400) for name in POLICIES for s in seeds]
    res = {}
    with mp.Pool(min(8, os.cpu_count() or 1)) as pool:
        for ng, name, seed, m in pool.imap_unordered(sweep_job, jobs):
            res.setdefault(str(ng), {}).setdefault(name, {})[seed] = m
    summ = {ng: {name: {kk: st.mean(v[kk] for v in d.values() if v[kk] is not None) for kk in KEYS}
                 for name, d in by.items()} for ng, by in res.items()}
    json.dump(summ, open(os.path.join(outdir, "sweep_summary.json"), "w"), indent=1)


# ---------------------------------------------------------------------------------------------------------
def special_game(gid, oid0, prices, valid, profile_fn=None):
    offers = []
    for i, (p, v) in enumerate(zip(prices, valid)):
        o = k.Offer(id=oid0 + i, game=gid, shop="eneba", valid=v, ct=[float("-inf")], cents=[p])
        o.meta = {"sales": []}
        offers.append(o)
    return k.Game(id=gid, offers=offers)


def background(seed, ng):
    return traces.portfolio(seed, ng, T0, 130)


def first_obs_delays(sim, offers, since):
    out = []
    for o in offers:
        t = [e[0] for e in sim.log if e[3] == "product" and e[4] == o.id and e[5] == "ok"]
        out.append((min(t) - since) if t else None)
    return out


def detection_after(sim, o, t):
    f = [e[0] for e in sim.log if e[3] == "product" and e[4] == o.id and e[5] == "ok" and e[0] >= t]
    return (f[0] - t) / H if f else None


def fetch_count(sim, offers, r0, r1):
    ids = {o.id for o in offers}
    return sum(1 for e in sim.log if e[3] == "product" and e[4] in ids and r0 <= e[0] < r1)


def edge_job(name):
    res = {}
    loads = {"ohne Engpass (40 Spiele, Budget 2000)": (40, 2000), "Engpass (80 Spiele, Budget 500)": (80, 500)}
    pols = POLICIES
    if name == "E1_neues_Spiel":
        for load, (ng, lim) in loads.items():
            for pname, pol in pols.items():
                for user in (True, False):
                    games = background(1, ng)
                    new = traces.make_game(random.Random(99), 9000, 90000, T0, T0 + 30 * k.DAY, k=8)
                    for o in new.offers:
                        o.visible_from = T0 + 10 * k.DAY
                    if user:
                        ev = [(T0 + 10 * k.DAY, k.ev_add_game(new, user=True))]
                    else:  # the same offers appear through a discovery run (no direct user action)
                        new.offers, offs = [], new.offers
                        ev = [(T0 + 10 * k.DAY, k.ev_add_game(new, user=False))] + \
                             [(T0 + 10 * k.DAY + 1, k.ev_add_offer(o, initial=False)) for o in offs]
                        new.offers = []
                    sim = simulate(pol, 1, ng, lim, 8 * H, days=20, events=ev, games=games)
                    offs = [o for o in sim.offers.values() if o.game == 9000]
                    d = [x for x in first_obs_delays(sim, offs, T0 + 10 * k.DAY) if x is not None]
                    n10 = []
                    for o in offs:
                        t = sorted(e[0] for e in sim.log if e[4] == o.id and e[5] == "ok")
                        n10.append((t[9] - (T0 + 10 * k.DAY)) / H if len(t) >= 10 else None)
                    res[f"{load} | {pname} | {'Nutzeraktion' if user else 'per Discovery'}"] = {
                        "first_price_max_min": max(d) / 60 if d else None, "first_price_mean_min": st.mean(d) / 60 if d else None,
                        "never": len(offs) - len(d), "tenth_obs_mean_h": st.mean([x for x in n10 if x]) if any(n10) else None}
    elif name == "E2_lange_stabil_dann_Sturz":
        # 10 copies of a game whose six regions stay constant for 100 days; then one region drops by 60 %
        # (at 10 different phases between day 100 and day 104). Delay = first successful fetch after the drop.
        for load, (ng, lim) in loads.items():
            for which in ("teuerste Region (nicht gültig)", "beste Zielland-Region (Mitte)"):
                for pname, pol in pols.items():
                    games = background(2, ng)
                    specials, drops = [], []
                    for c in range(10):
                        g = special_game(9001 + c, 91000 + 10 * c, [1500, 1900, 2400, 2900, 3400, 3900],
                                         [False, False, True, False, True, False])
                        o = g.offers[5] if which.startswith("teuerste") else g.offers[2]
                        t_drop = T0 + 100 * k.DAY + c * 37 * 997 + 1234
                        o.ct.append(t_drop)
                        o.cents.append(int(o.cents[0] * 0.4))
                        specials.append(g)
                        drops.append((o, t_drop))
                    sim = simulate(pol, 2, ng, lim, 8 * H, days=110, games=games + specials)
                    d = [detection_after(sim, o, t) for o, t in drops]
                    res[f"{load} | {which} | {pname}"] = {
                        "detect_mean_h": st.mean(d), "detect_max_h": max(d),
                        "fetches_per_day_offer_before": st.mean(fetch_count(sim, [o], T0 + 80 * k.DAY, T0 + 100 * k.DAY) / 20
                                                                for o, _ in drops),
                        "max_gap_h_before": max(max(b - a for a, b in zip(f, f[1:])) / H for f in (
                            [e[0] for e in sim.log if e[4] == o.id and T0 + 80 * k.DAY <= e[0] < T0 + 100 * k.DAY]
                            for o, _ in drops))}
    elif name in ("E3_viele_Minimalaenderungen", "E4_guenstig_und_stabil", "E5_teuer_und_volatil"):
        for pname, pol in pols.items():
            games = background(3, 40)
            rnd = random.Random(5)
            if name == "E3_viele_Minimalaenderungen":
                g = special_game(9002, 92000, [2000, 2004, 2008, 2012, 2016, 2020], [True, False, True, False, False, False])
                for o in g.offers:
                    t, c = T0, o.cents[0]
                    while t < T0 + 45 * k.DAY:
                        t += rnd.expovariate(10 / k.DAY)
                        c = int(round(2010 + 0.5 * (c - 2010) + rnd.gauss(0, 6)))
                        o.ct.append(t)
                        o.cents.append(c)
            elif name == "E4_guenstig_und_stabil":
                g = special_game(9002, 92000, [900, 2000, 2200, 2500], [False, True, True, False])
                for o in g.offers[1:]:
                    t = T0
                    while t < T0 + 45 * k.DAY:
                        t += rnd.expovariate(1 / k.DAY)
                        o.ct.append(t)
                        o.cents.append(int(o.cents[0] * rnd.uniform(0.9, 1.1)))
            else:
                g = special_game(9002, 92000, [1500, 1700, 2000, 2400], [False, True, True, False])
                o = g.offers[3]
                t = T0
                while t < T0 + 45 * k.DAY:  # swings of +-30 %, about every 1.3 days a 6 h dip below everyone
                    t += rnd.expovariate(3 / k.DAY)
                    if rnd.random() < 0.25:
                        o.ct += [t, t + 6 * H]
                        o.cents += [1200, int(2400 * rnd.uniform(0.7, 1.3))]
                        t += 6 * H
                    else:
                        o.ct.append(t)
                        o.cents.append(int(2400 * rnd.uniform(0.7, 1.3)))
            sim = simulate(pol, 3, 40, 2000, 8 * H, games=games + [g])
            m = metrics.evaluate(sim, T0 + WARM * k.DAY, T0 + DAYS * k.DAY)
            ev = [e for e in metrics.game_events(g, T0 + WARM * k.DAY, T0 + (DAYS - 2) * k.DAY)]
            per = [round(fetch_count(sim, [o], T0 + WARM * k.DAY, T0 + DAYS * k.DAY) / (DAYS - WARM), 2) for o in g.offers]
            res[pname] = {"fetches_per_day_by_offer": per, "relevant_events_game": len(ev),
                          "final_scores": [k.score_0_100(sim.job_of[o.id].pace, False) for o in g.offers],
                          "portfolio_detected_share": m["detected_share"]}
            if name == "E5_teuer_und_volatil":
                dips = [t for t, c in zip(g.offers[3].ct, g.offers[3].cents) if c == 1200 and t > T0 + WARM * k.DAY]
                seen = 0
                for t in dips:
                    f = [e for e in sim.log if e[4] == g.offers[3].id and e[5] == "ok" and t <= e[0] < t + 6 * H]
                    seen += bool(f)
                res[pname]["dips_seen"] = f"{seen}/{len(dips)}"
    elif name == "E7_Ausfaelle":
        for case in ("Shop-Ausfall 3 Tage", "15 % tote Links (404)"):
            for pname, pol in list(pols.items()) + [("C+Backoff", P("C+Backoff", trend="gap", perm_backoff=True)),
                                                    ("B+Backoff", P("B+Backoff", perm_backoff=True))]:
                games = traces.portfolio(4, 80, T0, DAYS)
                shops = [k.ShopCfg(limit=500)]
                if case.startswith("Shop"):
                    shops[0].outages = [(T0 + 10 * k.DAY, T0 + 13 * k.DAY)]
                else:
                    rnd = random.Random(44)
                    for g in games:
                        for o in g.offers:
                            if rnd.random() < 0.15:
                                o.fails.append((T0 + 5 * k.DAY, float("inf"), "not_found"))
                                o.dead = True
                sim = simulate(pol, 4, 80, 500, 8 * H, shops=shops, games=games)
                if case.startswith("Shop"):
                    out = [e for e in sim.log if T0 + 10 * k.DAY <= e[0] < T0 + 13 * k.DAY]
                    # time until 95 % of offers have a fresh success after the outage
                    t_end = T0 + 13 * k.DAY
                    offs = [o for g in games for o in g.offers]
                    first = {}
                    for e in sim.log:
                        if e[0] >= t_end and e[5] == "ok" and e[3] == "product" and e[4] not in first:
                            first[e[4]] = e[0]
                    ts = sorted(first.values())
                    t95 = (ts[int(0.95 * len(offs)) - 1] - t_end) / H if len(ts) >= int(0.95 * len(offs)) else None
                    res[f"{case} | {pname}"] = {"requests_during_outage": len(out), "per_day": len(out) / 3,
                                                "hours_until_95pct_refreshed": t95}
                else:
                    m = evaluate(sim)
                    dead = {o.id for g in games for o in g.offers if getattr(o, "dead", False)}
                    wasted = sum(1 for e in sim.log if e[4] in dead and e[0] >= T0 + WARM * k.DAY)
                    res[f"{case} | {pname}"] = {"dead_share_of_requests": wasted / max(1, len(
                        [e for e in sim.log if e[0] >= T0 + WARM * k.DAY])),
                        "detected_share": m["detected_share"], "wrong_best_target_share": m["wrong_best_target_share"],
                        "wrong_best_world_share": m["wrong_best_world_share"]}
    elif name == "E8_striktes_Rate_Limit":
        for lim in (500, 200):
            for pname, pol in pols.items():
                shops = [k.ShopCfg(limit=lim, rate_limit=(10, 3600))]
                sim = simulate(pol, 5, 80, lim, 8 * H, shops=shops)
                m = evaluate(sim)
                res[f"Budget {lim}, Shop erlaubt 10/h | {pname}"] = {kk: m[kk] for kk in (
                    "requests_per_day", "product_requests_per_day", "throttled", "detected_share", "wrong_best_target_share",
                    "offer_not_current_share", "peak_per_hour")}
                res[f"Budget {lim}, Shop erlaubt 10/h | {pname}"]["throttled_per_day"] = m["throttled"] / (DAYS - WARM)
    elif name == "E9_tausende_Angebote":
        for ng, lim in ((600, 2000), (600, 500)):
            for pname, pol in pols.items():
                sim = simulate(pol, 6, ng, lim, 8 * H, days=20)
                m = evaluate(sim, days=20, sample=3600)
                res[f"{ng} Spiele ({len(sim.offers)} Angebote), Budget {lim} | {pname}"] = {
                    kk: m[kk] for kk in ("product_requests_per_day", "detected_share", "wrong_best_target_share",
                                         "wrong_best_world_share", "offer_not_current_share", "max_age_h", "sim_cpu_s")}
    elif name == "E10_Neustart":
        for pname, pol in pols.items():
            ev = [(T0 + 3 * k.DAY + 12 * H, k.ev_crash("eneba", 2 * H))]
            sim = simulate(pol, 7, 80, 500, 8 * H, days=6, events=ev)
            t_r = T0 + 3 * k.DAY + 14 * H
            after = [e for e in sim.log if t_r <= e[0] < t_r + H]
            before = [e for e in sim.log if t_r - 4 * H <= e[0] < t_r - 3 * H]
            day3 = [e for e in sim.log if T0 + 3 * k.DAY <= e[0] < T0 + 4 * k.DAY]
            crashed = sim.crashed[0][1] if sim.crashed else None
            redo = [e[0] for e in sim.log if crashed and e[0] >= t_r and sim.jobs[crashed].offer == e[4]]
            res[pname] = {"jobs_first_hour_after_restart": len(after), "jobs_same_hour_day_before": len(before),
                          "jobs_on_crash_day": len(day3) + 1, "crashed_job_rerun_after_min": (redo[0] - t_r) / 60 if redo else None}
    elif name == "E11_Zeitspruenge":
        for jump, label in ((6 * H, "+6 h"), (-6 * H, "-6 h"), (-25 * H, "-25 h")):
            for pname, pol in pols.items():
                ev = [(T0 + 10 * k.DAY + 3 * H, k.ev_clock_jump(jump))]
                sim = simulate(pol, 8, 40, 2000, 8 * H, days=16, events=ev)
                m = metrics.evaluate(sim, T0 + 10 * k.DAY + 3 * H, T0 + 12 * k.DAY + 3 * H)
                base = metrics.evaluate(sim, T0 + 8 * k.DAY + 3 * H, T0 + 10 * k.DAY + 3 * H)
                n_after = sum(1 for e in sim.log if T0 + 10 * k.DAY + 3 * H <= e[0] < T0 + 11 * k.DAY + 3 * H)
                n_before = sum(1 for e in sim.log if T0 + 9 * k.DAY + 3 * H <= e[0] < T0 + 10 * k.DAY + 3 * H)
                res[f"{label} | {pname}"] = {"requests_24h_before": n_before, "requests_24h_after": n_after,
                                             "not_current_before": base["offer_not_current_share"],
                                             "not_current_48h_after": m["offer_not_current_share"],
                                             "wrong_target_before": base["wrong_best_target_share"],
                                             "wrong_target_48h_after": m["wrong_best_target_share"]}
    elif name == "E12_Gleichstand_Determinismus":
        hashes = []
        for rep in range(2):
            sim = simulate(k.POLICY_B, 9, 40, 500, 8 * H, days=10)
            hashes.append(hashlib.sha256(json.dumps(sim.log).encode()).hexdigest()[:16])
        # ties: 60 links with identical due and score are claimed strictly by id
        g = special_game(1, 1, [2000] * 60, [True] * 60)
        sim = simulate(k.POLICY_B, 9, 0, 1000, 8 * H, days=1, games=[g])
        order = [e[4] for e in sim.log if e[3] == "product"][:60]
        res = {"same_seed_log_hashes": hashes, "identical": hashes[0] == hashes[1],
               "tie_order_is_by_id": order == sorted(order),
               "note": "jitter (0-30 s) only on failures, from the random lease token in production (jobs.rs:583)"}
    elif name == "E13_unterschiedliche_Shops":
        for pname, pol in pols.items():
            games = traces.portfolio(10, 80, T0, DAYS, shops=("eneba", "driffle"))
            shops = [k.ShopCfg("eneba", limit=500, duration=2), k.ShopCfg("driffle", limit=150, duration=10, searches=False)]
            sim = simulate(pol, 10, 80, 500, 8 * H, shops=shops, games=games)
            m = evaluate(sim)
            ages = {}
            for sname in ("eneba", "driffle"):
                ids = {o.id for o in sim.offers.values() if o.shop == sname}
                ages[sname] = sum(1 for e in sim.log if e[4] in ids and e[0] >= T0 + WARM * k.DAY) / (DAYS - WARM) / len(ids)
            res[pname] = {"fetches_per_offer_day": ages, "detected_share": m["detected_share"],
                          "wrong_best_target_share": m["wrong_best_target_share"],
                          "wrong_best_world_share": m["wrong_best_world_share"]}
    elif name == "E14_fehlerhafte_Daten":
        for kind in ("1 ct", "x50"):
            for pname, pol in pols.items():
                games = traces.portfolio(11, 40, T0, 20)
                g = special_game(9003, 93000, [1500, 1800, 2100, 2500, 3000, 3600], [False, True, True, False, True, False])
                bad = g.offers[3]
                tb = T0 + 10 * k.DAY
                bad.ct += [tb, tb + 4 * H]
                bad.cents += [1 if kind == "1 ct" else 2500 * 50, 2500]
                sim = simulate(pol, 11, 40, 2000, 8 * H, days=20, games=games + [g])
                others = [o for o in g.offers if o is not bad]
                res[f"{kind} | {pname}"] = {
                    "game_fetches_per_day_before": fetch_count(sim, others, tb - 3 * k.DAY, tb) / 3,
                    "game_fetches_per_day_after": fetch_count(sim, others, tb, tb + 3 * k.DAY) / 3,
                    "bad_price_fetched": any(e[4] == bad.id and e[6] in (1, 125000) for e in sim.log)}
    return name, res


EDGES = ["E1_neues_Spiel", "E2_lange_stabil_dann_Sturz", "E3_viele_Minimalaenderungen", "E4_guenstig_und_stabil",
         "E5_teuer_und_volatil", "E7_Ausfaelle", "E8_striktes_Rate_Limit", "E9_tausende_Angebote", "E10_Neustart",
         "E11_Zeitspruenge", "E12_Gleichstand_Determinismus", "E13_unterschiedliche_Shops", "E14_fehlerhafte_Daten"]


def edge(outdir, names=None):
    res = {}
    with mp.Pool(min(8, os.cpu_count() or 1)) as pool:
        for name, r in pool.imap_unordered(edge_job, names or EDGES):
            res[name] = r
            print("done", name, flush=True)
    path = os.path.join(outdir, "edge.json")
    old = json.load(open(path)) if (names and os.path.exists(path)) else {}
    old.update(res)
    json.dump(old, open(path, "w"), indent=1, default=str)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["all", "bench", "sweep", "edge", "resummarize"])
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "results"))
    ap.add_argument("--seeds", default="1-5")
    ap.add_argument("--only", default=None, help="comma separated edge case names")
    a = ap.parse_args()
    lo, hi = (int(x) for x in a.seeds.split("-"))
    seeds = list(range(lo, hi + 1))
    os.makedirs(a.out, exist_ok=True)
    t = time.time()
    if a.what in ("all", "bench"):
        bench(a.out, seeds)
    if a.what == "resummarize":
        raw = json.load(open(os.path.join(a.out, "bench_raw.json")))
        json.dump(summarize(raw), open(os.path.join(a.out, "bench_summary.json"), "w"), indent=1)
    if a.what in ("all", "sweep"):
        sweep(a.out, seeds[:3])
    if a.what in ("all", "edge"):
        edge(a.out, a.only.split(",") if a.only else None)
    print(f"finished in {time.time() - t:.0f} s")
