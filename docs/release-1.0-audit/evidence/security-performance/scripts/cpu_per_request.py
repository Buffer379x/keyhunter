"""CPU time of the container per request (cgroup cpu.stat delta), robust against host load."""
import json, subprocess, sys, time, urllib.request, statistics
base, cookie, container, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
def usage():
    out = subprocess.run(["docker", "exec", container, "sh", "-c", "grep usage_usec /sys/fs/cgroup/cpu.stat"], capture_output=True, text=True).stdout
    return int(out.split()[1])
H = {"Cookie": "keyhunter_session=" + cookie}
def get(p):
    t = time.perf_counter()
    with urllib.request.urlopen(urllib.request.Request(base + p, headers=H)) as r: b = r.read()
    return (time.perf_counter() - t) * 1000, len(b)
items = json.loads(urllib.request.urlopen(urllib.request.Request(base + "/api/v1/wishlist", headers=H)).read())
best = max(items, key=lambda w: w.get("offer_count", 0))
paths = ["/api/v1/wishlist", "/api/v1/wishlist/price-badges?anchor=", "/api/v1/status/fetch", "/api/v1/status/fetch/runs?page=1&per_page=50",
         "/api/v1/status/fetch/runs?q=Perf%20Halo&page=1&per_page=50", "/api/v1/log?page=1&per_page=50", "/api/v1/cart", f"/api/v1/wishlist/{best['id']}/offers"]
# baseline: idle CPU for the same wall time is subtracted roughly by measuring idle 5 s
u0 = usage(); time.sleep(5); idle_per_s = (usage() - u0) / 5
res = {}
for p in paths:
    get(p)
    u = usage(); t0 = time.perf_counter(); lat = []
    for _ in range(n):
        dt, size = get(p); lat.append(dt)
    wall = time.perf_counter() - t0
    cpu = (usage() - u - idle_per_s * wall) / n / 1000
    key = p if "/offers" not in p else "/api/v1/wishlist/{id}/offers"
    res[key] = {"cpu_ms_per_req": round(cpu, 1), "median_ms": round(statistics.median(lat), 1), "min_ms": round(min(lat), 1), "bytes": size}
print(json.dumps({"n": n, "idle_cpu_ms_per_s": round(idle_per_s / 1000, 2), "results": res}, indent=1, ensure_ascii=False))
