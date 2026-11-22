"""Cross-validation of the Python model (sim/khsim.py, policy B) against the real Rust scheduler.

  python3 xval.py make <dir>           writes scenario JSON files (fixed seeds)
  python3 xval.py compare <dir>        replays them in the model and compares with the Rust logs
                                       (<dir>/<name>.rust.jsonl, written by run_xval.sh)
"""
import json
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sim"))
import khsim as k  # noqa: E402

T0 = 1_800_000_000 - 1_800_000_000 % k.DAY
SCENARIOS = {"binding": dict(seed=11, budget=30, interval=4 * 3600, days=8),
             "loose": dict(seed=12, budget=200, interval=4 * 3600, days=8),
             "errors": dict(seed=13, budget=60, interval=2 * 3600, days=6, error_rate=0.35)}


def make(cfg):
    rnd = random.Random(cfg["seed"])
    sizes = [4, 3, 1]
    links = []
    for w, size in enumerate(sizes):
        for n in range(size):
            base = rnd.choice([900, 1500, 2400, 3100])
            t, states = T0 - k.DAY, []
            cents = base
            while t < T0 + cfg["days"] * k.DAY:
                roll = rnd.random()
                err = None
                if roll < cfg.get("error_rate", 0.08):
                    err = rnd.choice(["network", "network", "not_found", "invalid_response", "rate_limited"])
                elif roll < 0.25:
                    cents = None
                else:
                    cents = max(100, int(base * rnd.uniform(0.7, 1.2)))
                states.append((t, cents if err is None else None, err))
                t += rnd.randint(1800, 30 * 3600)
            links.append({"wish": w, "valid": n == 0, "states": states})
    return {"t0": T0, "days": cfg["days"], "budget": cfg["budget"], "interval": cfg["interval"],
            "duration": 2, "wishes": len(sizes), "links": links}


def model(sc):
    games = {}
    for n, l in enumerate(sc["links"]):
        st = l["states"]
        ct = [float("-inf")] + [s[0] for s in st]
        cents = [None] + [s[1] for s in st]
        fails = [(s[0], st[i + 1][0] if i + 1 < len(st) else float("inf"), s[2]) for i, s in enumerate(st) if s[2]]
        o = k.Offer(id=n + 1, game=l["wish"], shop="eneba", valid=l["valid"], ct=ct, cents=cents, fails=fails)
        games.setdefault(l["wish"], []).append(o)
    gl = [k.Game(id=w, offers=games[w]) for w in sorted(games)]
    shop = k.ShopCfg(interval=sc["interval"], limit=sc["budget"], duration=sc["duration"])
    sim = k.Sim(gl, [shop], k.POLICY_B, sc["t0"], jitter=lambda: 15)
    rows = []

    def after(j, o, outcome, t):
        n = j.offer - 1 if j.kind == "product" else -1
        rows.append([t, j.kind, n, outcome, j.due, j.pace, j.relevance, o.cheap_score if o else None])
    sim.after = after
    sim.run(sc["t0"] + sc["days"] * k.DAY)
    return rows


def compare(d):
    total_ok = True
    for name in SCENARIOS:
        sc = json.load(open(os.path.join(d, name + ".json")))
        py = model(sc)
        rust = [json.loads(line) for line in open(os.path.join(d, name + ".rust.jsonl"))]
        first = None
        for i, (a, b) in enumerate(zip(py, rust)):
            same = a[:5] == b[:5] and a[6] == b[6] and abs(a[5] - b[5]) < 1e-9 and \
                ((a[7] is None and b[7] is None) or (a[7] is not None and b[7] is not None and abs(a[7] - b[7]) < 1e-9))
            if not same:
                first = (i, a, b)
                break
        ok = first is None and len(py) == len(rust)
        total_ok &= ok
        outcomes = {}
        for r in rust:
            outcomes[r[3]] = outcomes.get(r[3], 0) + 1
        print(f"{name}: rust {len(rust)} jobs, model {len(py)} jobs, outcomes {outcomes}: "
              + ("IDENTICAL (time, kind, link, outcome, due, pace, relevance, cheap_score)" if ok else f"DIFF at {first}"))
    return total_ok


if __name__ == "__main__":
    cmd, d = sys.argv[1], sys.argv[2]
    if cmd == "make":
        os.makedirs(d, exist_ok=True)
        for name, cfg in SCENARIOS.items():
            json.dump(make(cfg), open(os.path.join(d, name + ".json"), "w"))
        print("written", list(SCENARIOS))
    else:
        sys.exit(0 if compare(d) else 1)
