"""Apply the pending KeyHunter migrations to a scratch COPY of an old database (aggregates only)."""
import sqlite3, glob, os, sys, hashlib
db, mig = sys.argv[1], sys.argv[2]
con = sqlite3.connect(db); con.isolation_level = None
con.execute("PRAGMA foreign_keys=ON")
applied = [r[0] for r in con.execute("SELECT version FROM _sqlx_migrations WHERE success ORDER BY version")]
print("applied before:", applied[0], "...", applied[-1], "count", len(applied))
files = sorted(glob.glob(os.path.join(mig, '*.sql')))
mismatch = []
for f in files:
    v = int(os.path.basename(f).split('_')[0])
    if v in applied:
        stored = con.execute("SELECT hex(checksum) FROM _sqlx_migrations WHERE version=?", (v,)).fetchone()[0]
        if stored != hashlib.sha384(open(f, 'rb').read()).hexdigest().upper():
            mismatch.append(v)
print("checksum mismatches of applied migrations:", mismatch)
tables = ['wishlist_item', 'offer_link', 'price_observation', 'alert_rule', 'game']
count = lambda: {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in tables}
print("rows before:", count())
for f in files:
    v = int(os.path.basename(f).split('_')[0])
    if v in applied:
        continue
    sql = open(f).read()
    try:
        # sqlx wraps each migration in a transaction unless it starts with "-- no-transaction".
        con.executescript(sql if sql.startswith('-- no-transaction') else "BEGIN;\n" + sql + "\nCOMMIT;")
        print("applied", os.path.basename(f))
    except Exception as e:
        print("FAILED", os.path.basename(f), type(e).__name__, e)
        break
print("foreign_key_check rows:", len(con.execute("PRAGMA foreign_key_check").fetchall()))
print("integrity_check:", con.execute("PRAGMA integrity_check").fetchone()[0])
print("rows after:", count())
