import socket, sys, time, urllib.request
host, port, n, hold = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4])
socks = []
for i in range(n):
    s = socket.create_connection((host, port))
    s.sendall(f"POST /api/v1/session HTTP/1.1\r\nHost: {host}:{port}\r\nOrigin: http://{host}:{port}\r\nContent-Type: application/json\r\nContent-Length: 15000\r\n\r\n{{".encode())
    socks.append(s)
time.sleep(0.5)
def probe(path):
    t = time.perf_counter()
    try:
        with urllib.request.urlopen(f"http://{host}:{port}{path}", timeout=8) as r:
            r.read(); return f"{r.status} {(time.perf_counter()-t)*1000:.0f}ms"
    except urllib.error.HTTPError as e:
        return f"{e.code} {(time.perf_counter()-t)*1000:.0f}ms"
    except Exception as e:
        return f"TIMEOUT/{type(e).__name__} {(time.perf_counter()-t)*1000:.0f}ms"
for path in ["/health/live", "/health/ready", "/api/v1/setup", "/api/v1/me", "/"]:
    print(f"{n} haengende POST /api/v1/session -> GET {path}: {probe(path)}")
time.sleep(hold)
alive = 0
for s in socks:
    try:
        s.sendall(b" "); alive += 1
    except OSError: pass
print(f"nach {hold:.0f}s noch offen: {alive}/{n}")
for s in socks: s.close()
time.sleep(0.3)
print("danach GET /api/v1/setup:", probe("/api/v1/setup"))
