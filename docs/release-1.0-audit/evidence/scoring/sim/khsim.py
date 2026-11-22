"""Offline model of the KeyHunter v0.9.1 shop scheduler (backend/src/jobs.rs) and two alternatives.

Pure Python 3 standard library. Times are integer seconds. The model keeps two clocks:
real time `r` (drives the synthetic price traces) and app time `a = r + clock_offset`
(what `now()` returns, lib.rs:102; used for due, pacing, budget day, freshness).

Policy "B" re-implements the current rules faithfully; every rule cites its source line.
Policy "A" is the same machinery with fixed intervals (no trend, no relevance classes).
Policy "C*" variants are the audit candidates (see docs/release-1.0-audit/11_SCORING_ALGORITHM_AUDIT.md).

The scheduler only ever sees what a fetch returned at fetch time (no data leakage):
`execute()` reads the trace at the fetch's real time and hands the scheduler a product
(price or sold out) or an error, nothing else.
"""
from __future__ import annotations

import bisect
import heapq
import math
from collections import deque
from dataclasses import dataclass, field

# ---- constants (source lines refer to backend/src unless noted) -------------------------
DAY = 86400                      # jobs.rs:64
WEEK = 7 * DAY                   # jobs.rs:65
RETRY_LADDER = (120, 600, 3600)  # jobs.rs:67
REQUEST_WINDOW = 900             # jobs.rs:71
DEFAULT_DAILY_JOBS = 500         # jobs.rs:78
PACE_MIN, PACE_MAX = 20, 3600    # jobs.rs:82-83
TREND_WEIGHT = 0.2               # jobs.rs:426
PACE_FASTEST = 0.5               # jobs.rs:428
SOLD_OUT_PACE = 2.0              # jobs.rs:431
MIN_INTERVAL = 900               # jobs.rs:433
TREND_PRICE_AGE = WEEK           # jobs.rs:435
LEASE = 180                      # jobs.rs:303 (lease_until = t + 180)
FRESH = 24 * 3600                # pricing.rs:18 (older observations are not a current price)
SLEEP_AFTER_JOB = 2              # jobs.rs:150
SLEEP_IDLE = 3                   # jobs.rs:151
DENIED_PAUSE = 3600              # shops/mod.rs:263
THROTTLE_DEFAULT = 900           # shops/http.rs:162 (Retry-After missing)
TRANSIENT = ("network", "rate_limited")  # jobs.rs:393


def rround(x: float) -> int:
    """f64::round for x >= 0 (half away from zero)."""
    return math.floor(x + 0.5)


def pace_gap(t: int, remaining: int) -> int:
    """jobs.rs:107-110: rest of the UTC day / remaining budget, clamped to 20 s .. 1 h."""
    rest = DAY - t % DAY
    return min(max(rest // max(remaining, 1), PACE_MIN), PACE_MAX)


def effective_interval(interval: int, preview: bool, pace: float) -> int:
    """jobs.rs:419-423."""
    factor = 2 if preview else 1
    paced = (interval * factor) * min(max(pace, PACE_FASTEST), SOLD_OUT_PACE)
    return min(max(rround(paced), min(MIN_INTERVAL, interval)), WEEK)


def price_position(own: int, prices: list[int]):
    """jobs.rs:439-442: (own-min)/(max-min); None for <2 prices or all equal."""
    lo, hi = min(prices), max(prices)
    return (own - lo) / (hi - lo) if hi > lo else None


def next_trend(score: float, position) -> float:
    """jobs.rs:445-449: EWMA with weight 0.2, unchanged without comparison."""
    s = score if position is None else score + TREND_WEIGHT * (position - score)
    return min(max(s, 0.0), 1.0)


def trend_pace(score: float) -> float:
    """jobs.rs:452-454: 0 -> 0.5, 0.5 -> 1, 1 -> 2."""
    return 2.0 ** (2.0 * score - 1.0)


def score_0_100(pace, preview: bool) -> int:
    """offers.rs:180-186 (display score; the None cases are handled by the caller)."""
    factor = min(max(1.0 if pace is None else pace, 0.5), 2.0) * (2.0 if preview else 1.0)
    v = 50.0 * (1.0 - math.log2(factor))
    return 0 if v <= 0 else min(rround(v), 100)


# ---- policies -------------------------------------------------------------------------------
@dataclass
class Policy:
    name: str
    trend: str = "minmax"         # "minmax" (B, jobs.rs:458-496), "none" (A), "gap" (C)
    soldout_pace: float = SOLD_OUT_PACE   # pace of a sold-out product (B: 2)
    relevance_classes: bool = True        # B: sold out -> claim class 3 (jobs.rs:216, 407-415)
    stretch: bool = False                 # C: stretch all product intervals when demand > budget
    stretch_share: float = 0.85           # share of the budget the stretched plan aims at
    perm_backoff: bool = False            # C: doubling wait for not_found/invalid_response
    gap_ratio: float = 2.0                # C "gap": price ratio that counts as fully irrelevant
    target_aware: bool = True             # C "gap": also position against best valid target price
    interval_override: int | None = None  # A_eq / C_eq: product base interval instead of the shop's
    context_refresh: bool = False         # C variant: pull next-best offers forward when the best moved

    def base_interval(self, shop_interval: int, kind: str) -> int:
        return self.interval_override if (self.interval_override and kind == "product") else shop_interval


POLICY_A = Policy("A", trend="none", soldout_pace=1.0, relevance_classes=False)
POLICY_B = Policy("B")


# ---- world ------------------------------------------------------------------------------------
@dataclass(eq=False)
class Offer:
    """One offer_link with its product job. Trace fields are ground truth (never read by policy)."""
    id: int
    game: int
    shop: str
    valid: bool                    # activatable in the target country (seen in product data)
    ct: list                       # change times (real), ct[0] = -inf sentinel
    cents: list                    # price at each change (None = sold out)
    fails: list = field(default_factory=list)  # [(start, end, code)] real time; end may be inf
    created: int = 0               # real time the link appears
    initial: bool = False          # created by a direct user action (jobs.rs:30-38)
    # scheduler-visible state (offer_link)
    obs: tuple | None = None       # (cents or None) of `latest`
    observed_at: int | None = None # app time
    last_error: str | None = None
    cheap_score: float = 0.5       # migration 0016

    def state_at(self, r: float):
        i = bisect.bisect_right(self.ct, r) - 1
        return self.cents[i]

    def fail_at(self, r: float):
        for s, e, code in self.fails:
            if s <= r < e:
                return code
        return None


@dataclass(eq=False)
class Game:
    id: int
    offers: list
    active: bool = True            # wished and not paused
    preview: bool = False
    created: int = 0


@dataclass
class ShopCfg:
    name: str = "eneba"
    interval: int = 8 * 3600       # source_settings.poll_interval_seconds (migration 0008 default)
    limit: int = DEFAULT_DAILY_JOBS
    duration: int = 2              # seconds per request incl. robots delay (shops/http.rs:74, delay>=2)
    rate_limit: tuple | None = None  # (max requests, window seconds) -> 429 beyond
    retry_after: int = THROTTLE_DEFAULT
    outages: list = field(default_factory=list)  # [(start, end)] shop-wide network errors (real time)
    searches: bool = True          # only Eneba has wish searches (jobs.rs:892)


class Job:
    __slots__ = ("id", "shop", "kind", "offer", "game", "due", "failures", "relevance", "pace",
                 "initial", "checked_at", "lease_until", "ver", "key", "rate")

    def __init__(self, jid, shop, kind, offer=None, game=None, due=0, initial=False):
        self.id, self.shop, self.kind, self.offer, self.game = jid, shop, kind, offer, game
        self.due, self.failures, self.relevance, self.pace = due, 0, 1, 1.0
        self.initial, self.checked_at, self.lease_until, self.ver = initial, None, 0, 0
        self.key, self.rate = None, 0.0


class ShopState:
    def __init__(self, cfg: ShopCfg):
        self.cfg = cfg
        self.retry_at = 0
        self.budget_day = 0
        self.jobs_today = 0
        self.paced_until = 0
        self.heaps = {}            # (class, bypass) -> heap of (due, id, ver)
        self.next_attempt = 0
        self.requests = deque()    # real times, for the rate limit model
        self.demand = 0.0          # unstretched planned jobs/day (C stretch; mirrors jobs::demand)
        self.down_until = -1
        self.crash_next = None


# ---- simulation ---------------------------------------------------------------------------------
class Sim:
    def __init__(self, games, shops, policy: Policy, t0: int, jitter=None, events=None,
                 target_valid=True):
        self.games = {g.id: g for g in games}
        self.offers = {o.id: o for g in games for o in g.offers}
        self.shops = {c.name: ShopState(c) for c in shops}
        self.policy = policy
        self.t0 = t0
        self.offset = 0
        self.jitter = jitter or (lambda: 15)  # token "aa" -> 0xaa % 31 = 15 (jobs.rs:583)
        self.events = sorted(events or [], key=lambda e: e[0])
        self.jobs = {}
        self.log = []          # (r, a, shop, kind, offer_id, outcome, cents, class, score_before, pace_before)
        self.crashed = []
        self.offset_hist = [(float("-inf"), 0)]   # (real time, clock offset from then on)
        self.after = None      # optional callback(job, offer, outcome, r) after each completion
        self.next_id = 1
        self.job_of = {}       # offer id -> product job
        self.gamelinks = {}    # game id -> offers
        for g in games:
            self.gamelinks[g.id] = list(g.offers)
        # discovery job per shop (migrations 0003/0004), due 0
        for name in self.shops:
            self._add_job(Job(self._nid(), name, "discovery", due=0))
        for g in games:
            if g.created <= t0:
                self._create_game_jobs(g, t0, user=False)

    # -- job bookkeeping
    def _nid(self):
        self.next_id += 1
        return self.next_id

    def _create_game_jobs(self, g: Game, a: int, user: bool):
        if self.shops.get("eneba") and self.shops["eneba"].cfg.searches:
            j = Job(self._nid(), "eneba", "search", game=g.id, due=a, initial=user)
            # an existing wish has already been searched once (steady state); a new one has not
            j.checked_at = None if user else a - DAY
            self._add_job(j)
        for o in g.offers:
            self._add_offer_job(o, a, initial=user)

    def _add_offer_job(self, o: Offer, a: int, initial: bool):
        j = Job(self._nid(), o.shop, "product", offer=o.id, game=o.game, due=a, initial=initial)
        o.initial = initial
        self.job_of[o.id] = j
        self._add_job(j)

    def _add_job(self, j: Job):
        self.jobs[j.id] = j
        self._push(j, self.t0)
        if j.kind == "product":
            self._set_rate(j)

    def _active(self, j: Job) -> bool:
        if j.kind == "discovery":
            return any(g.active for g in self.games.values())
        return self.games[j.game].active

    def _class(self, j: Job) -> int:
        """jobs.rs:209-220 (requested refreshes are not modelled)."""
        g = self.games.get(j.game) if j.game is not None else None
        if g is not None and g.preview:
            return 4
        if j.kind == "search" and j.checked_at is None:
            return 0
        if j.kind == "discovery":
            return 5
        if j.kind == "product":
            if not self.policy.relevance_classes:
                return 1
            return 1 if j.relevance == 1 else 3
        return 2  # search_page>1 -> 1 is not modelled (single-page searches)

    def _bypass(self, j: Job, cls: int) -> bool:
        """jobs.rs:223-229."""
        if cls == 0:
            return True
        g = self.games.get(j.game) if j.game is not None else None
        wished = g is None or (g.active and not g.preview)
        if j.initial and wished:
            if j.kind == "search":
                return True
            if j.kind == "product" and self.offers[j.offer].observed_at is None:
                return True
        return False

    def _push(self, j: Job, a: int):
        j.ver += 1
        if not self._active(j):
            j.key = None
            return
        cls = self._class(j)
        key = (cls, self._bypass(j, cls))
        j.key = key
        heapq.heappush(self.shops[j.shop].heaps.setdefault(key, []), (j.due, j.id, j.ver))

    def _top(self, heap):
        while heap:
            due, jid, ver = heap[0]
            j = self.jobs.get(jid)
            if j is None or j.ver != ver or j.key is None:
                heapq.heappop(heap)
                continue
            return j
        return None

    def reindex_game(self, gid: int, a: int):
        """After a wish was paused, resumed or removed (queued(), jobs.rs:202-206)."""
        for j in list(self.jobs.values()):
            if j.game == gid or j.kind == "discovery":
                if j.key is not None or j.lease_until <= a:
                    self._push(j, a)
                if j.kind == "product":
                    self._set_rate(j)

    # -- planned demand (jobs.rs:909-936), only used by the C stretch rule
    def _set_rate(self, j: Job):
        s = self.shops[j.shop]
        s.demand -= j.rate
        g = self.games[j.game]
        if g.active:
            iv = self._interval(j, j.pace, stretched=False)
            j.rate = DAY / iv
        else:
            j.rate = 0.0
        s.demand += j.rate

    def _stretch(self, shop: ShopState) -> float:
        if not self.policy.stretch:
            return 1.0
        n_games = sum(1 for g in self.games.values() if g.active)
        other = (n_games * DAY / max(WEEK, shop.cfg.interval) if shop.cfg.searches else 0.0) \
            + DAY / max(DAY, shop.cfg.interval)
        need = shop.demand + other
        return max(1.0, need / (self.policy.stretch_share * shop.cfg.limit))

    def _interval(self, j: Job, pace: float, stretched=True) -> int:
        shop = self.shops[j.shop]
        base = self.policy.base_interval(shop.cfg.interval, j.kind)
        g = self.games[j.game] if j.game is not None else None
        iv = effective_interval(base, bool(g and g.preview), pace)
        if stretched and j.kind == "product":
            st = self._stretch(shop)
            if st > 1.0:
                iv = min(rround(iv * st), WEEK)
        return iv

    # -- claim (jobs.rs:259-336)
    def claim(self, shop: ShopState, a: int):
        if shop.retry_at > a:                                    # jobs.rs:236 p.retry_at<=?2
            return None
        day = a // DAY
        used_before = shop.jobs_today if shop.budget_day == day else 0
        limit = shop.cfg.limit
        if used_before >= limit:                                 # jobs.rs:237
            return None
        fourth = used_before % 4 == 3                            # jobs.rs:290
        best = None
        for (cls, byp), heap in shop.heaps.items():
            j = self._top(heap)
            if j is None or j.due > a or j.lease_until > a:      # jobs.rs:238
                continue
            if not byp and shop.paced_until > a:                 # jobs.rs:238 pacing unless bypass
                continue
            rank = 0 if cls == 0 else ((1 if cls >= 2 else 2) if fourth else cls)  # jobs.rs:288-292
            k = (rank, j.due, j.id)
            if best is None or k < best[0]:
                best = (k, j, cls, byp)
        if best is None:
            return None
        _, j, cls, byp = best
        j.lease_until = a + LEASE
        heapq.heappop(shop.heaps[(cls, byp)])
        j.ver += 1
        j.key = None
        used = used_before + 1                                   # jobs.rs:317-325
        shop.jobs_today, shop.budget_day = used, day
        if not byp:                                              # jobs.rs:326-331
            shop.paced_until = a + pace_gap(a, limit - used)
        return j, cls, byp

    def next_ready(self, shop: ShopState, a: int):
        """Earliest app time at which some job could be claimed (exact for this state)."""
        best = None
        for (cls, byp), heap in shop.heaps.items():
            j = self._top(heap)
            if j is None:
                continue
            t = max(j.due, j.lease_until)
            if not byp:
                t = max(t, shop.paced_until)
            best = t if best is None else min(best, t)
        if best is None:
            return None
        best = max(best, shop.retry_at)
        day = max(best, a) // DAY
        used = shop.jobs_today if shop.budget_day == day else 0
        if used >= shop.cfg.limit:
            best = max(best, (day + 1) * DAY)
        return best

    # -- execute: the only place that reads ground truth, at the real fetch time
    def execute(self, shop: ShopState, j: Job, r: int):
        cfg = shop.cfg
        for s, e in cfg.outages:
            if s <= r < e:
                return ("err", "network")
        if cfg.rate_limit:
            n, w = cfg.rate_limit
            q = shop.requests
            while q and q[0] <= r - w:
                q.popleft()
            q.append(r)
            if len(q) > n:
                return ("err", "rate_limited")
        if j.kind != "product":
            return ("ok", None)
        o = self.offers[j.offer]
        code = o.fail_at(r)
        if code:
            return ("err", code)
        return ("ok", o.state_at(r))

    # -- trend (jobs.rs:458-496) and the C alternative
    def trend(self, j: Job, o: Offer, cents, a: int):
        p = self.policy
        if p.trend == "none":
            return (o.cheap_score, 1.0 if cents is not None else p.soldout_pace)
        if cents is None:                                        # jobs.rs:472-476
            return (o.cheap_score, p.soldout_pace)
        others = []
        for o2 in self.gamelinks[o.game]:                        # jobs.rs:477-492
            if o2.id == o.id or o2.obs is None or o2.observed_at is None:
                continue
            if o2.observed_at <= a - TREND_PRICE_AGE or o2.obs[0] is None:
                continue
            others.append((o2.obs[0], o2.valid))
        if p.trend == "minmax":
            prices = [c for c, _ in others] + [cents]
            s = next_trend(o.cheap_score, price_position(cents, prices))
            return (s, trend_pace(s))
        # "gap": position = log(own/min)/log(R) against the cheapest worldwide and, for an offer
        # valid in the target country, against the cheapest valid one; the smaller counts.
        lr = math.log(p.gap_ratio)
        world = min([c for c, _ in others] + [cents])
        pos = min(max(math.log(cents / world) / lr, 0.0), 1.0)
        if p.target_aware and o.valid:
            tgt = min([c for c, v in others if v] + [cents])
            pos = min(pos, min(max(math.log(cents / tgt) / lr, 0.0), 1.0))
        s = next_trend(o.cheap_score, pos)
        return (s, trend_pace(s))

    # -- complete (jobs.rs:551-729)
    def complete(self, shop: ShopState, j: Job, cls: int, result, a: int, r: int):
        ok, val = result
        o = self.offers.get(j.offer) if j.kind == "product" else None
        score_before, pace_before = (o.cheap_score if o else None), j.pace
        prev = o.obs if o else None
        trend = None
        relevance = None
        if ok == "ok" and j.kind == "product":
            relevance = 1 if val is not None else 2              # jobs.rs:408-415
            trend = self.trend(j, o, val, a)                     # jobs.rs:575-580
        pace = trend[1] if trend else 1.0                        # jobs.rs:581
        interval = self._interval(j, pace)                       # jobs.rs:582
        if ok == "ok":
            if j.kind == "product":
                due = a + interval                               # jobs.rs:385
            elif j.kind == "search":
                due = a + max(WEEK, interval)                    # jobs.rs:371,387
            else:
                due = a + max(DAY, interval)                     # jobs.rs:372,389 (Eneba)
            failures = 0
        else:
            code = val
            if code in TRANSIENT and j.failures < len(RETRY_LADDER):
                retry = RETRY_LADDER[j.failures]                 # jobs.rs:392-396
            else:
                retry = interval                                 # jobs.rs:396-397
                if self.policy.perm_backoff and code in ("not_found", "invalid_response"):
                    retry = min(interval * (2 ** min(j.failures, 3)), WEEK)
            pause = shop.cfg.retry_after if code == "rate_limited" else (DENIED_PAUSE if code == "access_denied" else 0)
            due = a + max(pause, retry + self.jitter())          # jobs.rs:399-402
            failures = min(j.failures + 1, 20)
            if pause:
                shop.retry_at = max(shop.retry_at, a + pause)    # jobs.rs:681-688
        j.due, j.failures, j.lease_until = due, failures, 0      # jobs.rs:590-602
        if j.kind == "product":
            j.initial = False                                    # jobs.rs:586-588
        elif j.kind == "search" and ok == "ok":
            j.initial = False
        j.checked_at = a                                         # jobs.rs:608-617
        if relevance is not None:
            j.relevance = relevance
        if trend is not None:
            j.pace = trend[1]
            self._set_rate(j)
        if o is not None:
            if ok == "ok":
                o.obs, o.observed_at, o.last_error = (val,), a, None   # jobs.rs:623-625
                o.cheap_score = trend[0]                              # jobs.rs:628-634
            else:
                o.last_error = val                                    # jobs.rs:673-679
        self.log.append((r, a, shop.cfg.name, j.kind, j.offer, "ok" if ok == "ok" else val,
                         val if ok == "ok" else None, cls, score_before, pace_before))
        self._push(j, a)
        if self.after:
            self.after(j, o, "ok" if ok == "ok" else val, r)
        if self.policy.context_refresh and o is not None and ok == "ok":
            self._context(o, prev, a)

    def _context(self, o: Offer, prev, a: int):
        """C variant: the fetched offer was the game's best (worldwide or valid in the target country) and
        rose by >= 2 % or sold out: the next two candidates of that set with an observation older than one hour
        become due now (still paced and budgeted)."""
        if prev is None or prev[0] is None:
            return
        new = o.obs[0]
        if new is not None and new <= prev[0] * 1.02:
            return
        for valid_only in (False, True):
            if valid_only and not o.valid:
                continue
            pool = [x for x in self.gamelinks[o.game] if x.obs is not None and x.obs[0] is not None
                    and x.observed_at is not None and a - x.observed_at <= FRESH and (x.valid or not valid_only)]
            others = [x for x in pool if x.id != o.id]
            if not others or min(x.obs[0] for x in others) < prev[0]:
                continue  # o was not the best of this set
            for x in sorted(others, key=lambda x: (x.obs[0], x.id))[:2]:
                if x.observed_at < a - 3600:
                    jx = self.job_of[x.id]
                    if jx.key is not None and jx.due > a:
                        jx.due = a
                        self._push(jx, a)

    def offset_at(self, r):
        i = bisect.bisect_right([h[0] for h in self.offset_hist], r) - 1
        return self.offset_hist[i][1]

    # -- events and main loop
    def apply_events(self, upto_r: int):
        while self.events and self.events[0][0] <= upto_r:
            r, fn = self.events.pop(0)
            fn(self, r)

    def run(self, r_end: int):
        for s in self.shops.values():
            s.next_attempt = self.t0
        while True:
            shop = min(self.shops.values(), key=lambda s: s.next_attempt)
            r = shop.next_attempt
            if r >= r_end:
                break
            if self.events and self.events[0][0] <= r:
                self.apply_events(r)
                continue
            if r < shop.down_until:
                shop.next_attempt = shop.down_until
                continue
            a = r + self.offset
            got = self.claim(shop, a)
            if got and shop.crash_next:
                j = got[0]
                down, shop.crash_next = shop.crash_next, None

                def release(sim2, r2, j=j):
                    sim2._push(j, r2 + sim2.offset)
                bisect.insort(self.events, (r + LEASE, release), key=lambda e: e[0])
                self.crashed.append((r, j.id))
                shop.down_until = r + down
                shop.next_attempt = r + down
                continue
            if got:
                j, cls, byp = got
                res = self.execute(shop, j, r)
                d = shop.cfg.duration
                self.complete(shop, j, cls, res, a + d, r)
                shop.next_attempt = r + d + SLEEP_AFTER_JOB
            else:
                ready = self.next_ready(shop, a)
                cap = self.events[0][0] if self.events else r_end
                target_r = cap if ready is None else min(ready - self.offset, cap)
                k = max(1, math.ceil((target_r - r) / SLEEP_IDLE))
                shop.next_attempt = r + SLEEP_IDLE * k
        return self


# ---- scenario event helpers ---------------------------------------------------------------------
def ev_add_game(game: Game, user: bool = True):
    """A wish is saved: search (class 0) and indexed candidates with initial=1 (jobs.rs:891-900)."""
    def fn(sim: Sim, r):
        a = r + sim.offset
        sim.games[game.id] = game
        sim.gamelinks[game.id] = list(game.offers)
        for o in game.offers:
            sim.offers[o.id] = o
        sim._create_game_jobs(game, a, user=user)
    return fn


def ev_add_offer(offer: Offer, initial: bool = False):
    """A link appears later (e.g. found by a discovery run: initial=0, jobs.rs:39)."""
    def fn(sim: Sim, r):
        a = r + sim.offset
        sim.offers[offer.id] = offer
        sim.gamelinks[offer.game].append(offer)
        sim.games[offer.game].offers.append(offer)
        sim._add_offer_job(offer, a, initial)
    return fn


def ev_clock_jump(delta: int):
    """The system clock jumps by `delta` seconds (NTP correction, wrong RTC after a restart)."""
    def fn(sim: Sim, r):
        sim.offset += delta
        sim.offset_hist.append((r, sim.offset))
    return fn


def ev_crash(shop_name: str, down: int):
    """The container stops while a job is running: the next claimed job is never completed (budget counted,
    paced_until set at claim, jobs.rs:317-331); its lease (jobs.rs:303, 180 s) holds it, its due stays, so it is
    the most overdue job afterwards; the worker is back after `down` seconds; paced_until survives."""
    def fn(sim: Sim, r):
        sim.shops[shop_name].crash_next = down
    return fn
