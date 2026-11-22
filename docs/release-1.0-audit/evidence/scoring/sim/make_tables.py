"""Markdown tables from the result files (results/summary.md).

  python3 make_tables.py ../results
"""
import json
import os
import sys

d = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "results")
out = []
COLS = [("product_requests_per_day", "Abfragen/Tag", "{:.0f}"), ("detected_share", "erkannt", "{:.1%}"),
        ("attractive_missed_share", "attraktiv verpasst", "{:.1%}"), ("delay_mean_h", "Verzög. Ø h", "{:.2f}"),
        ("delay_p90_h", "Verzög. p90 h", "{:.2f}"), ("requests_per_detected", "Abfr./erkannte Änd.", "{:.1f}"),
        ("wrong_best_world_share", "Bestpreis weltweit falsch", "{:.1%}"),
        ("wrong_best_target_share", "Bestpreis Zielland falsch", "{:.1%}"),
        ("offer_not_current_share", "Angebote nicht aktuell (>24 h)", "{:.1%}"), ("max_age_h", "max. Alter h", "{:.0f}"),
        ("peak_per_hour", "Spitze/h", "{:.0f}")]


def fmt(v, f):
    if v is None:
        return "–"
    if isinstance(v, list):
        m, lo, hi = v
        s = f.format(m)
        if hi - lo > 1e-12 and f.endswith("%}"):
            s += f" ({lo:.1%}–{hi:.1%})"
        return s
    return f.format(v)


bs = json.load(open(os.path.join(d, "bench_summary.json")))
out.append("# Simulationsergebnisse (automatisch erzeugt)\n")
out.append("Mittelwert über 5 Seeds, in Klammern Minimum–Maximum. 45 Tage, Auswertung ab Tag 5.\n")
for regime, pols in bs.items():
    out.append(f"\n## {regime}\n")
    out.append("| Verfahren | " + " | ".join(c[1] for c in COLS) + " |")
    out.append("|---|" + "---|" * len(COLS))
    for p, row in pols.items():
        name = p + (f" (Intervall {row['calibrated_interval_h'][0]:.2f} h)" if "calibrated_interval_h" in row else "")
        out.append(f"| {name} | " + " | ".join(fmt(row.get(c[0]), c[2]) for c in COLS) + " |")
if os.path.exists(os.path.join(d, "sweep_summary.json")):
    sw = json.load(open(os.path.join(d, "sweep_summary.json")))
    out.append("\n## Wunschlistengröße bei Standardbudget 500/Tag (8 h, Mittel über 3 Seeds)\n")
    out.append("| Spiele | Verfahren | Abfragen/Tag | erkannt | attraktiv verpasst | Bestpreis weltweit falsch | Bestpreis Zielland falsch | nicht aktuell | max. Alter h |")
    out.append("|---|---|---|---|---|---|---|---|---|")
    for ng in sorted(sw, key=int):
        for p, r in sw[ng].items():
            out.append(f"| {ng} | {p} | {r['product_requests_per_day']:.0f} | {r['detected_share']:.1%} | "
                       f"{r['attractive_missed_share']:.1%} | {r['wrong_best_world_share']:.1%} | "
                       f"{r['wrong_best_target_share']:.1%} | {r['offer_not_current_share']:.1%} | {r['max_age_h']:.0f} |")
if os.path.exists(os.path.join(d, "edge.json")):
    ed = json.load(open(os.path.join(d, "edge.json")))
    out.append("\n## Randfälle (Rohwerte)\n")
    for name in sorted(ed):
        out.append(f"\n### {name}\n")
        v = ed[name]
        if isinstance(v, dict) and all(isinstance(x, dict) for x in v.values()):
            keys = sorted({kk for x in v.values() for kk in x})
            out.append("| Fall | " + " | ".join(keys) + " |")
            out.append("|---|" + "---|" * len(keys))
            for case, x in v.items():
                cells = []
                for kk in keys:
                    val = x.get(kk)
                    cells.append(f"{val:.3g}" if isinstance(val, float) else str(val))
                out.append(f"| {case} | " + " | ".join(cells) + " |")
        else:
            out.append("```\n" + json.dumps(v, indent=1) + "\n```")
if os.path.exists(os.path.join(d, "claim_bench.json")):
    cb = json.load(open(os.path.join(d, "claim_bench.json")))
    out.append(f"\n## Kosten der Scheduler-SQL (SQLite {cb['sqlite']}, Median ms)\n")
    out.append("| Jobs | fällig | pending (alle 3 s im Leerlauf) | claim | trend (andere Regionen) | demand | CPU-Anteil Leerlauf |")
    out.append("|---|---|---|---|---|---|---|")
    for r in cb["rows"]:
        out.append(f"| {r['jobs']} | {r['due_share']:.0%} | {r['pending_ms']:.2f} | {r['claim_ms']:.2f} | "
                   f"{r['trend_others_ms']:.3f} | {r['demand_ms']:.2f} | {r['idle_cpu_share_pct']:.3f} % |")
    out.append("\nQuery-Plan claim:\n```\n" + "\n".join(cb["plan_claim"]) + "\n```")
open(os.path.join(d, "summary.md"), "w").write("\n".join(out) + "\n")
print("written", os.path.join(d, "summary.md"))

# paired differences per seed against B (same traces), budget-matched variants
raw = json.load(open(os.path.join(d, "bench_raw.json")))
keys = [("detected_share", "erkannt"), ("attractive_missed_share", "attraktiv verpasst"),
        ("wrong_best_world_share", "Bestpreis weltweit falsch"), ("wrong_best_target_share", "Bestpreis Zielland falsch"),
        ("delay_mean_h", "Verzögerung Ø h")]
lines = ["\n## Gepaarte Differenzen zu B (gleiche Verläufe je Seed, gleiches Budget)\n",
         "Wert = Mittel der Differenz Variante − B; in Klammern: in wie vielen Seeds die Differenz negativ war.\n",
         "| Regime | Variante | " + " | ".join(k[1] for k in keys) + " |", "|---|---|" + "---|" * len(keys)]
for regime, seeds in raw.items():
    for p in ("A_gleiches_Budget", "C_gleiches_Budget"):
        cells = []
        for key, _ in keys:
            diffs = []
            for v in seeds.values():
                x = v.get(p) or v.get(p.replace("_gleiches_Budget", ""))
                diffs.append(x[key] - v["B"][key])
            scale = 100 if key.endswith("share") else 1
            unit = " pp" if scale == 100 else " h"
            cells.append(f"{scale * sum(diffs) / len(diffs):+.1f}{unit} ({sum(1 for z in diffs if z < 0)}/{len(diffs)})")
        lines.append(f"| {regime} | {p} | " + " | ".join(cells) + " |")
open(os.path.join(d, "summary.md"), "a").write("\n".join(lines) + "\n")
print("appended paired table")
