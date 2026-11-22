"""Metrics of one simulation run, computed afterwards from the fetch log and the ground-truth traces.

Relevant price change (definition used throughout the audit):
  For every game two prices matter (core use case): WORLD = cheapest in-stock offer of all regions,
  TARGET = cheapest in-stock offer valid in the target country (this one also drives price alerts,
  alerts.rs:279-330). A change of one offer is RELEVANT when it moves WORLD or TARGET by at least
  max(2 %, 20 ct), or makes one of them appear/disappear (restock / everything sold out).
  It is ATTRACTIVE when it lowers WORLD or TARGET by at least 10 %.
  It is DETECTED when the first successful fetch of that offer after the change still shows the new
  state (same stock state, price within max(2 %, 20 ct)); otherwise it was MISSED (the state was gone
  before anyone looked). Delay = fetch time - change time. Changes whose state is still unchanged and
  unfetched at the end of the run are censored (not counted).
Displayed best price: what the app shows/alerts on (pricing.rs:120-160): the cheapest offer whose last
  fetch succeeded, is at most 24 h old in app time (observed_at <= now and now - observed_at <= FRESH),
  in stock and (for TARGET) valid. WRONG = differs from the truth by >= max(2 %, 20 ct) or one side missing.
"""
import bisect
import statistics as st
from collections import Counter, defaultdict

from khsim import DAY, FRESH, score_0_100

REL_MIN, REL_PCT, ATTRACTIVE = 20, 0.02, 0.10


def relevant(v1, v2):
    if v1 is None and v2 is None:
        return False
    if v1 is None or v2 is None:
        return True
    return abs(v2 - v1) >= max(REL_PCT * v1, REL_MIN)


def same_state(a, b):
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) < max(REL_PCT * b, REL_MIN)


def q(values, p):
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, int(p * len(s)))]


def game_events(game, w0, w1):
    """Relevant events of one game: (time, offer, metric, before, after, attractive)."""
    offers = [o for o in game.offers]
    times = sorted({t for o in offers for t in o.ct[1:] if w0 <= t < w1 and t >= getattr(o, "visible_from", 0)})
    out = []
    for t in times:
        changed = [o for o in offers if bisect.bisect_left(o.ct, t) < len(o.ct) and o.ct[bisect.bisect_left(o.ct, t)] == t]
        for metric in ("world", "target"):
            sel = [o for o in offers if metric == "world" or o.valid]
            if not sel:
                continue
            before = [o.state_at(t - 1e-6) for o in sel]
            after = [o.state_at(t) for o in sel]
            vb = min([c for c in before if c is not None], default=None)
            va = min([c for c in after if c is not None], default=None)
            if relevant(vb, va):
                attractive = vb is not None and va is not None and va <= vb * (1 - ATTRACTIVE)
                attractive |= vb is None and va is not None
                for o in changed:
                    if any(x is o for x in sel):
                        out.append((t, o, metric, vb, va, attractive))
    return out


def evaluate(sim, w0, w1, sample=600, duration=2):
    log = [e for e in sim.log]
    games = list(sim.games.values())
    by_offer = defaultdict(list)          # offer -> [(r, a, ok, cents)]
    for r, a, shop, kind, oid, outcome, cents, cls, sb, pb in log:
        if kind == "product":
            by_offer[oid].append((r, a, outcome == "ok", cents, sb, pb))
    win = [e for e in log if w0 <= e[0] < w1]
    days = (w1 - w0) / DAY
    res = {"requests_per_day": len(win) / days,
           "product_requests_per_day": sum(1 for e in win if e[3] == "product") / days,
           "outcomes": dict(Counter(e[5] for e in win)),
           "throttled": sum(1 for e in win if e[5] == "rate_limited")}
    hours = Counter(int(e[0] // 3600) for e in win)
    res["peak_per_hour"] = max(hours.values()) if hours else 0
    # relevant events and their detection
    det, missed, att_missed, att_total, delays, att_delays = 0, 0, 0, 0, [], []
    by_metric = defaultdict(lambda: [0, 0, []])
    detecting = set()                      # (offer, fetch r) that detected something
    sale_miss = defaultdict(lambda: [0, 0])
    for g in games:
        for t, o, metric, vb, va, att in game_events(g, w0, w1 - 2 * DAY):
            new = o.state_at(t)
            fetches = by_offer.get(o.id, [])
            i = bisect.bisect_left(fetches, (t,))
            hit = None
            while i < len(fetches):
                if fetches[i][2]:
                    hit = fetches[i]
                    break
                i += 1
            if hit is None:
                nxt = bisect.bisect_right(o.ct, t)
                if nxt >= len(o.ct) or o.ct[nxt] >= w1:
                    continue  # censored
                ok = False
            else:
                ok = same_state(hit[3], new)
            m = by_metric[metric]
            if ok:
                det += 1
                m[0] += 1
                d = hit[0] + duration - t
                delays.append(d)
                m[2].append(d)
                detecting.add((o.id, hit[0]))
                if att:
                    att_delays.append(d)
            else:
                missed += 1
                m[1] += 1
            if att:
                att_total += 1
                att_missed += not ok
                # sale length bucket (only events that start a sale of this offer)
                for s, e, fac in getattr(o, "meta", {}).get("sales", []):
                    if abs(s - t) < 1:
                        b = sale_miss[int(round((e - s) / 3600))]
                        b[0] += 1
                        b[1] += not ok
    res.update({
        "relevant_events": det + missed, "detected": det, "missed": missed,
        "detected_share": det / max(1, det + missed),
        "attractive_events": att_total, "attractive_missed": att_missed,
        "attractive_missed_share": att_missed / max(1, att_total),
        "delay_mean_h": (st.mean(delays) / 3600) if delays else None,
        "delay_median_h": (st.median(delays) / 3600) if delays else None,
        "delay_p90_h": (q(delays, 0.9) / 3600) if delays else None,
        "attractive_delay_mean_h": (st.mean(att_delays) / 3600) if att_delays else None,
        "requests_per_detected": len([e for e in win if e[3] == "product"]) / max(1, det),
        "by_metric": {m: {"detected": v[0], "missed": v[1],
                          "delay_mean_h": (st.mean(v[2]) / 3600) if v[2] else None} for m, v in by_metric.items()},
        "sale_hours_missed": {h: f"{v[1]}/{v[0]}" for h, v in sorted(sale_miss.items())},
    })
    # yield of fetches by display score at fetch time (B/C: score from the job's pace before the fetch)
    yield_b = defaultdict(lambda: [0, 0])
    for oid, fs in by_offer.items():
        o = sim.offers[oid]
        g = sim.games[o.game]
        for r, a, okf, cents, sb, pb in fs:
            if not (w0 <= r < w1) or o.observed_at is None:
                continue
            sc = score_0_100(pb, g.preview)
            b = yield_b[min(sc // 20, 4)]
            b[0] += 1
            b[1] += (oid, r) in detecting
    res["yield_by_score"] = {f"{k * 20}-{k * 20 + 19 if k < 4 else 100}": {"fetches": v[0], "detections": v[1],
                             "per_100_fetches": round(100 * v[1] / v[0], 2) if v[0] else None}
                             for k, v in sorted(yield_b.items())}
    # time-sampled display error and staleness
    offs = [o for g in games for o in g.offers]
    ptr = {o.id: 0 for o in offs}
    state = {o.id: None for o in offs}   # [success r, success app time (observed_at), cents, last attempt ok]
    wrong = {"world": [0, 0], "target": [0, 0]}
    stale_n = tot_n = 0
    ages = []
    max_age = 0
    t = w0
    off_at = getattr(sim, "offset_at", lambda r: 0)
    while t < w1:
        a_now = t + off_at(t)
        cur = {}
        for o in offs:
            fs = by_offer.get(o.id, [])
            i = ptr[o.id]
            while i < len(fs) and fs[i][0] + duration <= t:
                r, a, okf, cents = fs[i][:4]
                if okf:
                    state[o.id] = [r, a + duration, cents, True]
                elif state[o.id] is not None:
                    state[o.id][3] = False
                i += 1
            ptr[o.id] = i
            vis = getattr(o, "visible_from", 0)
            if t < vis or not sim.games[o.game].active:
                cur[o.id] = None
                continue
            tot_n += 1
            stt = state[o.id]
            if stt is None:
                stale_n += 1
                cur[o.id] = None
                age = t - max(vis, w0)
            else:
                age = t - stt[0]
                fresh = stt[1] <= a_now and a_now - stt[1] <= FRESH
                stale_n += not fresh
                cur[o.id] = stt[2] if (fresh and stt[3]) else None
            ages.append(age)
            max_age = max(max_age, age)
        for g in games:
            if not g.active:
                continue
            for metric in ("world", "target"):
                sel = [o for o in g.offers if (metric == "world" or o.valid) and t >= getattr(o, "visible_from", 0)]
                if not sel:
                    continue
                truth = min([c for c in (o.state_at(t) for o in sel) if c is not None], default=None)
                shown = min([cur[o.id] for o in sel if cur[o.id] is not None], default=None)
                w = wrong[metric]
                w[1] += 1
                w[0] += not (same_state(shown, truth) if truth is not None else shown is None)
        t += sample
    res["offer_not_current_share"] = stale_n / max(1, tot_n)
    res["max_age_h"] = max_age / 3600
    res["p99_age_h"] = (q(ages, 0.99) or 0) / 3600
    res["mean_age_h"] = (st.mean(ages) / 3600) if ages else None
    res["wrong_best_world_share"] = wrong["world"][0] / max(1, wrong["world"][1])
    res["wrong_best_target_share"] = wrong["target"][0] / max(1, wrong["target"][1])
    return res
