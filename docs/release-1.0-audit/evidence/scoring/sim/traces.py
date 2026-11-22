"""Synthetic price traces with fixed seeds (documented generator, see README.md).

A game has K regional offers (K drawn from KS, median 4 like the real DB copy). Region 0 is valid in the
target country; every other region is valid with probability P_VALID. Valid regions cost 1.00-1.45 x the
game's base price, the others 0.45-1.30 x (cheap foreign keys), so the cheapest region worldwide is usually
not activatable in the target country (core use case).

Each offer follows one volatility profile (piecewise-constant price, integer cents):
  stable    no small moves
  micro     3-12 moves/day of ~0.4 % (marketplace sellers undercutting each other)
  moderate  0.5-1.5 moves/day of ~7 %
  volatile  1-3 moves/day of ~12 %
All small moves revert towards the region level. On top: time-limited sales (15-50 % off for 6 h-7 d),
sold-out episodes (mean 2.5 d) and short transient fetch failures (mean 15 min).
"""
import math
import random

from khsim import DAY, Game, Offer

KS = [1, 2, 3, 4, 4, 4, 5, 6, 8, 10, 12, 16]
P_VALID = 0.3
PROFILES = {  # weight, moves/day range, relative step sd, sales per day, sold-out episodes per day
    "stable": (0.35, (0.0, 0.0), 0.0, 1 / 25, 1 / 12),
    "micro": (0.35, (3.0, 12.0), 0.004, 1 / 12, 1 / 12),
    "moderate": (0.22, (0.5, 1.5), 0.07, 1 / 8, 1 / 10),
    "volatile": (0.08, (1.0, 3.0), 0.12, 1 / 5, 1 / 8),
}
SALE_HOURS = [6, 12, 24, 48, 96, 168]
SALE_WEIGHTS = [2, 3, 3, 2, 1, 1]


def poisson_times(rnd, rate_per_day, t0, t1):
    out, t = [], t0
    if rate_per_day <= 0:
        return out
    while True:
        t += rnd.expovariate(rate_per_day / DAY)
        if t >= t1:
            return out
        out.append(t)


def offer_trace(rnd, level, profile, t0, t1, fail_rate=1 / 7, sold_out_scale=1.0, sale_scale=1.0):
    """Returns (ct, cents, fails, meta) for one offer between t0 and t1 (real seconds)."""
    _, moves, sd, sales_rate, so_rate = PROFILES[profile]
    rate = rnd.uniform(*moves) if moves[1] > 0 else 0.0
    # small moves (mean-reverting)
    points = {t0: level}
    cur = level
    for t in poisson_times(rnd, rate, t0, t1):
        cur = cur + 0.3 * (level - cur) + rnd.gauss(0, sd * level)
        cur = max(cur, 0.3 * level)
        points[t] = cur
    sales = []
    for t in poisson_times(rnd, sales_rate * sale_scale, t0, t1):
        hours = rnd.choices(SALE_HOURS, SALE_WEIGHTS)[0]
        sales.append((t, t + hours * 3600, 1 - rnd.uniform(0.15, 0.5)))
    sold = []
    for t in poisson_times(rnd, so_rate * sold_out_scale, t0, t1):
        sold.append((t, t + min(rnd.expovariate(1 / (2.5 * DAY)), 20 * DAY)))
    fails = []
    for t in poisson_times(rnd, fail_rate, t0, t1):
        fails.append((t, t + rnd.expovariate(1 / 900), "network"))
    bounds = sorted(set(list(points) + [s for s, _, _ in sales] + [e for _, e, _ in sales]
                        + [s for s, _ in sold] + [e for _, e in sold]))
    lv_times = sorted(points)
    ct, cents = [float("-inf")], [int(round(level))]
    li = 0
    for b in bounds:
        while li + 1 < len(lv_times) and lv_times[li + 1] <= b:
            li += 1
        lv = points[lv_times[li]]
        if any(s <= b < e for s, e in sold):
            c = None
        else:
            f = 1.0
            for s, e, fac in sales:
                if s <= b < e:
                    f = min(f, fac)
            c = max(1, int(round(lv * f)))
        if c != cents[-1]:
            ct.append(b)
            cents.append(c)
    return ct, cents, fails, {"profile": profile, "sales": sales, "level": level}


def make_game(rnd, gid, oid0, t0, t1, shops=("eneba",), k=None, **kw):
    k = k or rnd.choice(KS)
    base = math.exp(rnd.gauss(math.log(2500), 0.5))
    offers = []
    names = list(PROFILES)
    weights = [PROFILES[n][0] for n in names]
    for i in range(k):
        valid = i == 0 or rnd.random() < P_VALID
        level = base * (rnd.uniform(1.0, 1.45) if valid else rnd.uniform(0.45, 1.3))
        profile = rnd.choices(names, weights)[0]
        ct, cents, fails, meta = offer_trace(rnd, level, profile, t0 - 2 * DAY, t1, **kw)
        o = Offer(id=oid0 + i, game=gid, shop=shops[i % len(shops)], valid=valid, ct=ct, cents=cents, fails=fails)
        o.meta = meta
        offers.append(o)
    return Game(id=gid, offers=offers)


def portfolio(seed, n_games, t0, days, shops=("eneba",), **kw):
    rnd = random.Random(seed)
    games, oid = [], 1
    for g in range(n_games):
        game = make_game(rnd, g + 1, oid, t0, t0 + days * DAY, shops=shops, **kw)
        oid += len(game.offers)
        games.append(game)
    return games


def observed_stats(games, t0, days, gap=12.5 * 3600):
    """The generator seen like the real DB copy: one look every ~12.5 h (rates per link-day)."""
    pairs = allpairs = ch = c2 = c5 = c10 = so = n = 0
    for g in games:
        for o in g.offers:
            t = t0
            prev = o.state_at(t)
            while t + gap < t0 + days * DAY:
                t += gap
                cur = o.state_at(t)
                n += 1
                allpairs += 1
                so += cur is None
                if prev is not None and cur is not None:
                    pairs += 1
                    rel = abs(cur - prev) / prev
                    ch += rel > 0
                    c2 += rel > 0.02
                    c5 += rel > 0.05
                    c10 += rel > 0.10
                prev = cur
    days_obs = allpairs * gap / DAY  # like db_stats.py: all consecutive pairs count as observed time
    return {"per_link_day_any": ch / days_obs, "gt2": c2 / days_obs, "gt5": c5 / days_obs,
            "gt10": c10 / days_obs, "sold_out_share": so / n}
