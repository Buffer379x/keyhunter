import json, sys, time, urllib.request, statistics
base, cookie = sys.argv[1], sys.argv[2]
runs = int(sys.argv[3]) if len(sys.argv) > 3 else 10
H = {"Cookie": "keyhunter_session=" + cookie}
def get(path):
    req = urllib.request.Request(base + path, headers=H)
    t = time.perf_counter()
    with urllib.request.urlopen(req) as r:
        body = r.read()
    return (time.perf_counter() - t) * 1000, body
_, wl = get("/api/v1/wishlist")
items = json.loads(wl)
wish = items[0]["id"] if items else None
# wish with most offers
best = max(items, key=lambda w: w.get("offer_count", 0)) if items else None
paths = ["/api/v1/wishlist", "/api/v1/wishlist/price-badges", "/api/v1/cart", "/api/v1/status/fetch",
         "/api/v1/log?page=1&per_page=50", "/api/v1/log?q=Perf&page=1&per_page=50",
         "/api/v1/status/fetch/runs?page=1&per_page=50", "/api/v1/status/fetch/runs?q=Perf%20Halo&page=1&per_page=50",
         "/api/v1/status/fetch/runs?tone=error&page=1&per_page=50",
         "/api/v1/library", "/api/v1/alerts", "/api/v1/settings", "/api/v1/sources/status", "/api/v1/me"]
if best: paths.append(f"/api/v1/wishlist/{best['id']}/offers")
out = {"wishes": len(items), "max_offer_count": best.get("offer_count") if best else None, "results": {}}
for p in paths:
    ts = []; size = 0
    for _ in range(runs):
        dt, body = get(p); ts.append(dt); size = len(body)
    key = p if "/offers" not in p else "/api/v1/wishlist/{id}/offers (meiste Angebote)"
    out["results"][key] = {"median_ms": round(statistics.median(ts), 1), "p95_ms": round(sorted(ts)[max(0, int(len(ts)*0.95)-1)], 1), "max_ms": round(max(ts),1), "bytes": size}
print(json.dumps(out, indent=1, ensure_ascii=False))
