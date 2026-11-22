import json, sys, time, urllib.request, statistics
base, cookie, csrf, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
words = ["Forza","Halo","Gears","Starfield","Fable","Avowed","Hellblade","Sea","Grounded","Pentiment","Ori","Cuphead","Hollow","Celeste","Hades","Tunic","Outer","Wilds","Doom","Quake"]
times = []
ok = 0
for i in range(n):
    title = f"Perf {words[i % len(words)]} {i:04d} Edition"
    platform = 169 if i % 3 else 49
    body = json.dumps({"manual_title": title, "platform_id": platform}).encode()
    req = urllib.request.Request(base + "/api/v1/wishlist", data=body, method="POST", headers={
        "Content-Type": "application/json", "Origin": base, "X-CSRF-Token": csrf, "Cookie": "keyhunter_session=" + cookie})
    t = time.perf_counter()
    try:
        with urllib.request.urlopen(req) as r:
            r.read(); ok += r.status in (200, 201)
    except urllib.error.HTTPError as e:
        print("ERR", e.code, e.read()[:200]); break
    times.append((time.perf_counter() - t) * 1000)
print(json.dumps({"added": ok, "median_ms": round(statistics.median(times), 2), "p95_ms": round(sorted(times)[int(len(times)*0.95)-1], 2), "max_ms": round(max(times), 2)}))
