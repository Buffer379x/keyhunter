# Evidenz: Scoring-/Scheduler-Audit (SCORE)

Offline-Simulation und Messungen zu `docs/release-1.0-audit/11_SCORING_ALGORITHM_AUDIT.md`.
Nur Python-3-Standardbibliothek (getestet mit Python 3.14.4, SQLite 3.46.1; numpy ist nicht installiert und wird nicht gebraucht).
Keine Netzwerkzugriffe, keine Änderungen am Anwendungscode.

## Inhalt

| Datei | Zweck |
|---|---|
| `sim/khsim.py` | Modell des Schedulers v0.9.1 (`backend/src/jobs.rs`), Policies A (feste Intervalle), B (aktuell), C (Kandidat) und Ablationen. Jede Regel mit Quellzeile. |
| `sim/traces.py` | Generator synthetischer Preisverläufe (feste Seeds, Parameter im Kopf der Datei). |
| `sim/metrics.py` | Kennzahlen und die Definition „relevante Preisänderung“ (Kopf der Datei). |
| `sim/run_scenarios.py` | Benchmark R1–R3 (5 Seeds, budgetgleich kalibriert), Wunschlisten-Sweep, Randfälle E1–E14. |
| `sim/interval_fresh.py` | Zusammenspiel Shop-Intervall ↔ feste 24-h-Aktualitätsregel. |
| `sim/claim_bench.py` | Laufzeit der echten Scheduler-SQL (aus `jobs.rs` zusammengesetzt) bei 100–30 000 Jobs. |
| `sim/selfcheck.py` | Modell gegen die Erwartungswerte der Rust-Unit-Tests (`jobs.rs`, `offers.rs`). |
| `sim/db_stats.py` | Aggregierte Kennzahlen der alten echten DB-Kopie (nur Zählwerte, Kopie read-only). |
| `sim/make_tables.py` | Erzeugt `results/summary.md` aus den JSON-Ergebnissen. |
| `xval/audit_xval.rs`, `xval/run_xval.sh`, `xval/xval.py` | Kreuzvalidierung: dieselben Szenarien laufen durch die **echten** Rust-Funktionen `claim`/`complete` (in einer Scratch-Kopie von `backend/`) und durch das Python-Modell; die Job-Folgen werden verglichen. |
| `results/` | Alle Ergebnisse (JSON, `summary.md`, Kreuzvalidierungs-Logs). |

## Befehle (aus dem Repository-Root)

```sh
cd docs/release-1.0-audit/evidence/scoring/sim
python3 selfcheck.py                                   # 42 Prüfungen, Exit 0
python3 run_scenarios.py all --out ../results          # Benchmark + Sweep + Randfälle (≈ 6 min auf 8 Kernen)
python3 interval_fresh.py > ../results/interval_fresh.json
python3 claim_bench.py                                 # SQL-Kosten -> ../results/claim_bench.json
python3 make_tables.py ../results                      # -> ../results/summary.md
python3 db_stats.py <projektordner>/work/phase_b_database/keyhunter.db <scratch-ordner>   # nur aggregiert; die DB liegt außerhalb des Repos
cd ../xval && python3 xval.py compare results           # Vergleich mit den gespeicherten Rust-Logs (ohne Docker)
```

Kreuzvalidierung neu erzeugen (Docker-Image `keyhunter-build-tools:local`, eigenes Target `work/check/target-score`,
Scratch-Kopie des Backends; das Repository wird nicht verändert):

```sh
sh docs/release-1.0-audit/evidence/scoring/xval/run_xval.sh <scratch-ordner>
```

## Nachtrag 1.0 (Phase B)

`sim/khsim.py` enthält seit 1.0 die Backoff-Regel für tote Links (FUNC-13/SCORE-06, `jobs::dead_link`): Nach fünf
„nicht gefunden“ bzw. „nicht lesbar“ in Folge wartet ein Produktlink das Vierfache seines Intervalls, bis ein Abruf
gelingt. `xval/results/errors.rust.jsonl` stammt aus dem Code mit dieser Regel; alle drei Szenarien sind damit wieder
IDENTICAL. Die übrigen Ergebnisse unter `results/` sind der Stand des Audits (0.9.1).

## Determinismus

Alle Zufallswerte stammen aus `random.Random(seed)`. Zwei Läufe mit gleichem Seed erzeugen ein identisches Abruf-Log
(Hash in `results/edge.json`, E12). Die Ergebnisse hängen nicht von der Rechnerzeit ab (simulierte Uhr).

## Grenzen

- Die echte DB-Kopie (221 Beobachtungen, 35 h, Schema 0010) reicht für keine historische Wiedergabe; sie dient nur der
  groben Kalibrierung des Generators (`results/db_stats.json`). Der Generator ist etwas ruhiger als diese Stichprobe
  (Änderungen > 2 %: 0,25 statt 0,45 je Link und Tag), die Schlussfolgerungen sind also eher konservativ.
- Nicht modelliert: angeforderte Aktualisierungen („Jetzt prüfen“), mehrseitige Suchen, Editionsvorschauen im Benchmark
  (nur in der Selbstprüfung), Driffle-Sitemap-Takt, echte Antwortzeiten (fest 2 s bzw. 10 s).
- Die SQL-Laufzeiten stammen aus Pythons SQLite, nicht aus der von sqlx gebündelten Bibliothek.
