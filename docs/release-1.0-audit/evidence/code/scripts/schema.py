import sqlite3, glob, sys, os
mig = sys.argv[1]
con = sqlite3.connect(':memory:')
con.isolation_level = None
for f in sorted(glob.glob(os.path.join(mig, '*.sql'))):
    sql = open(f).read()
    con.executescript(sql)
for (name, sql) in con.execute("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type DESC, name"):
    print(sql + ';')
