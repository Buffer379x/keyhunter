import json, sys
plans, db = sys.argv[1], sys.argv[2]
src = open(plans).read().split("for name, (sql, args) in Q.items():")[0]
sys.argv = [plans, db]
g = {"__name__": "x"}
exec(src, g)
json.dump({k: [v[0], list(v[1])] for k, v in g["Q"].items()}, open(db + ".queries.json", "w"))
