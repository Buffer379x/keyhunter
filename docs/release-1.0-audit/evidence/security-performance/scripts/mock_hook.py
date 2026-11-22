import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        with open(sys.argv[2], "a") as f:
            f.write(json.dumps({"path": self.path, "headers": {k: (v if k.lower() != "authorization" else v[:7] + "…") for k, v in self.headers.items()}, "body": body.decode()[:400]}) + "\n")
        status = 500 if "fail" in self.path else 200
        payload = json.dumps({"message": "interne Antwort des Zielsystems: Zeile 1, Version 9.9 (" + "x" * 300 + ")"}).encode()
        self.send_response(status); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
