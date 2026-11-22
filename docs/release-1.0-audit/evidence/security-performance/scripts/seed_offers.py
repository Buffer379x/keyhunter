"""Synthetic offers for the audit fixture DB only: 4 links per wish, N observations per link, job runs, log."""
import hashlib, json, random, sqlite3, sys, time
db, obs_per_link, runs_total, log_total = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
random.seed(7)
c = sqlite3.connect(db)
c.execute("PRAGMA foreign_keys=ON")
t = int(time.time())
wishes = c.execute("SELECT w.id, g.manual_title, w.platform_id FROM wishlist_item w JOIN game g ON g.id=w.game_id WHERE w.state='wished'").fetchall()
regions = [("eneba", "Europe", ["DE","FR","AT"], "DE", "europe"), ("eneba", "Global", ["DE","TR","US"], "DE", "global"),
           ("eneba", "Turkey", ["TR"], "TR", "turkey"), ("driffle", "Europe", ["DE","FR"], "DE", None)]
def fp(pid, plat): return hashlib.sha256(json.dumps([2, pid, True, [plat]], separators=(",", ":")).encode()).hexdigest()
links = 0; obs = 0
for n, (wid, title, plat) in enumerate(wishes):
    slug = "-".join(title.lower().split())
    base = random.randint(900, 6900)
    for k, (src, region, allowed, market, suffix) in enumerate(regions):
        pid = f"syn-{n}-{k}"
        url = (f"https://www.eneba.com/de/xbox-{slug}-xbox-live-key-{suffix}" if src == "eneba"
               else f"https://driffle.com/{slug}-xbox-live-digital-key-europe-p{100000+n}")
        name = f"{title} (Xbox) Xbox Live Key {region.upper()}"
        cents = int(base * random.uniform(0.7, 1.3))
        product = {"id": pid, "name": name, "title": title, "platform_ids": [plat], "key_game": True, "region": region,
                   "allowed": allowed, "blocked": [], "purchase_country": market,
                   "offers": [{"id": f"o{j}", "cents": cents + 37 * j, "seller": f"Seller {j}"} for j in range(3)], "availability": "in_stock"}
        f = fp(pid, plat)
        cur = c.execute("INSERT INTO offer_link(wish_id,source,url,review,fingerprint,latest,observed_at,attempted_at,confirmed_name,auto_discovered) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (wid, src, url, "confirmed", f, json.dumps(product), t - 600, t - 600, name, 1))
        link = cur.lastrowid; links += 1
        c.execute("INSERT INTO shop_job(source,link_id,due,checked_at,pace) VALUES(?,?,?,?,1)", (src, link, t + random.randint(600, 86400), t - 600))
        rows = []
        for i in range(obs_per_link):
            at = t - 600 - i * 28800
            p = int(cents * random.uniform(0.85, 1.15))
            avail = "in_stock" if random.random() > 0.05 else "sold_out"
            offers = json.dumps([{"id": f"o{j}", "cents": p + 37 * j, "seller": f"Seller {j}"} for j in range(3)]) if avail == "in_stock" else "[]"
            rows.append((link, pid, at, market, f, offers, "confirmed" if market == "DE" else "blocked", avail))
        c.executemany("INSERT INTO price_observation(link_id,product_id,observed_at,market,fingerprint,offers,activation,availability) VALUES(?,?,?,?,?,?,?,?)", rows)
        obs += len(rows)
link_ids = [r[0] for r in c.execute("SELECT id FROM offer_link")]
outcomes = ["ok"] * 90 + ["network"] * 4 + ["not_found"] * 3 + ["rate_limited"] * 2 + ["invalid_response"]
c.executemany("INSERT INTO job_run(source,kind,wish_id,link_id,started_at,duration_ms,outcome,detail) VALUES(?,?,?,?,?,?,?,?)",
              [(random.choice(["eneba", "driffle"]), "product", None, random.choice(link_ids), t - random.randint(0, 29 * 86400),
                random.randint(300, 4000), random.choice(outcomes), None) for _ in range(runs_total)])
c.executemany("INSERT INTO event_log(at,level,area,message) VALUES(?,?,?,?)",
              [(t - random.randint(0, 6 * 86400), random.choice(["info", "info", "warn", "error"]), random.choice(["Abruf", "Wunschliste", "Preisalarme"]),
                f"Synthetischer Eintrag {i} zu „Perf Halo {i % 500:04d} Edition“") for i in range(log_total)])
c.commit()
print(json.dumps({"wishes": len(wishes), "links": links, "observations": obs, "job_runs": runs_total, "log": log_total}))
c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
c.close()
