# 10 · Audit-Nachweise

Sammlung der durchgeführten Befehle, Testläufe, Messwerte, Nachprüfungen und Grenzen. Die ausführlichen Protokolle stehen am Ende jedes Fachdokuments („Geprüfte Befehle und Grenzen“). Die Rohdaten liegen unter `evidence/`: 193 Dateien, etwa 11 MB, keine Datei über 500 KB, keine Secrets.

## 1. Rahmen

- **Stand:** Branch `audit/release-1.0` auf Commit `490a8fb` (= Tag 0.9.1). Am Anwendungscode, an Styles, Tests, Konfiguration und Migrationen ist nichts geändert. `git status` zeigt nur `docs/release-1.0-audit/`.
- **Testinstanzen:** Fixture-Server `work/check/target/debug/examples/catalog_fixture` mit `frontend/dist`, jeweils eigener Port und eigener Datenordner (38781–38787), danach gestoppt und gelöscht. Produktions-Image `keyhunter:0.9.1` und ältere Images (0.5.0, 0.8.3, 0.9.0) als eigene Container mit `--network none` bzw. gesperrtem DNS, danach entfernt.
- **Keine externen Anfragen:** keine an Shops, IGDB/Twitch, Microsoft-Katalog oder Benachrichtigungsdienste. Ausnahmen waren Paket-Downloads für Analysewerkzeuge (npm-Pakete per `npx`, Docker-Images für osv-scanner, cargo-audit, Trivy und Playwright) und Abfragen der eigenen GitHub-Repo-Metadaten durch den Lead.
- **Daten:** Die einzige echte Datenbankkopie (`work/phase_b_database/keyhunter.db`, Schema 10, 221 Beobachtungen über 35 h) wurde nur read-only und aggregiert genutzt. Keine Hashes, Tokens oder Sitzungen ausgelesen. `work/local/` wurde nicht gelesen.
- **Team:** sechs Prüf-Agenten (Code, Funktion/QA, Designsystem, Responsive/UX, Security/Performance, Scoring) und ein Agent für die 1:1-Vorschau. Synthese, Nachprüfungen und Dokumente 01, 07, 08, 09 und 10 stammen vom Lead.

## 2. Testläufe

| Lauf | Befehl | Ergebnis | Quelle |
|---|---|---|---|
| Rust | `cargo test --locked` (Docker, eigene Target-Ordner) | 173/173 (Lib 119, `api.rs` 14, `catalog_wishlist.rs` 40), mehrfach unabhängig | 02, 03 |
| Rust-Lint | `cargo fmt --check`, `cargo clippy --all-targets -D warnings` | 0 / 0 | 02 |
| Rust pedantic | `cargo clippy -W clippy::pedantic -W dead_code` | 182 Warnungen, keine `dead_code` | `evidence/code/clippy-pedantic.txt` |
| Frontend-Unit | `npm test` | 71/71 | 02, 03 |
| TypeScript | `tsc` über `src` / über `tests`+`e2e` (Scratch-tsconfig) | 0 / 53 Fehler (9 echte Signatur-Abweichungen) | `evidence/code/tsc-tests.txt` |
| E2E | `KEYHUNTER_TEST_PORT=38781 sh deploy/browser-check.sh` | 73/73, zweimal ohne Retries | `evidence/functional/test-runs.txt` |
| Visual | `sh deploy/visual-check.sh` (eigener Port, ohne Update) | 22/22, Baselines unverändert | 03, 04 |
| CI 0.9.1 | GitHub `checks` (PR #17), `container.yml` (Tag 0.9.1) | beide grün | Lead, `gh run` |
| Upgrade | `keyhunter:0.5.0` → 0.9.1 offline; 0.8.3 → 0.9.1; 0.9.0 → 0.9.1 | Schema 10 → 27 mit Sicherung, Daten vollständig; Downgrade bricht mit klarer Meldung ab | 03, 06, Lead (Release 0.9.1) |
| Restore | Vor-Migrations-Sicherung mit 0.5.0-Image gestartet | läuft, DB intakt | 03 |
| Migrationskette | 0011–0027 auf Kopie der alten DB (Python-sqlite) | `foreign_key_check` 0, `integrity_check` ok, Prüfsummen 0001–0010 unverändert | `evidence/code/migration-upgrade-check.txt` |
| Scheduler-Kreuzvalidierung | `sh evidence/scoring/xval/run_xval.sh <scratch>` | 232 / 435 / 354 Jobs, Python-Modell und Rust-Code jeweils IDENTICAL | 11 |
| Simulation | `python3 evidence/scoring/sim/run_scenarios.py all` | 5 Seeds × Szenarien, 351 s; Selbsttest 42/42 | 11, `evidence/scoring/README.md` |

## 3. Messwerte (Auswahl)

| Messung | Wert | Quelle |
|---|---|---|
| `/status/fetch` CPU bei 500 Wünschen | 256,6 ms (Ursache PERF-01) | 06 §4.2 |
| Claim in der Schreibtransaktion | 35 ms bei 500 Wünschen | 06 |
| `/wishlist`, `/wishlist/price-badges` | 124 ms (442 KB) / 115 ms (302 KB) | 06 |
| Container Leerlauf | 25,5–36,2 MiB RAM, 0,2 % CPU; Image 162 MB (41,7 MB komprimiert); „ready“ nach 0,5–0,9 s | 06 §5 |
| Frontend | JS 461 KB (140 KB gzip), CSS 63 KB, 23 Requests, FCP 96 ms, LCP 280 ms, **CLS 0,42** | 06 §4.5 |
| Polling bei Abrufrückstand | 3-s-Takt, ≈ 6 MB/min, 3,8 % CPU je Tab | 06 PERF-02 |
| Responsive | 240 Messungen, 0 × Dokument-Overflow; Angebote-Tabelle 1228 px; Öffnen-Knopf bei x = 974 (Viewport 768) | `evidence/responsive/messwerte.csv` |
| axe-core 4.10.3 | 38 Scans; 1366 px: 261 Knoten (227 Kontrast), 375 px: 145; 0 critical | `evidence/responsive/axe-verstoesse.csv` |
| Kontrast | `--faint` 2,1–2,8 : 1, `--muted` 3,9–4,3 : 1 | `evidence/design/inventory/` |
| CSS-Inventur | 15 Stylesheets, 805 Regeln, 369 Klassen, 118 Tokens (70 Aliase, 58 ungenutzt), 64 mehrfach definierte Klassen | `evidence/design/inventory/inventory.md` |
| Code-Duplikate (jscpd) | Backend-Produktion 1–2 %, Frontend 0,25 %, `catalog_wishlist.rs` 24,9 % | `evidence/code/jscpd.txt` |
| Abhängigkeiten | npm audit 0/0; osv-scanner und cargo-audit: RUSTSEC-2026-0592 (url), RUSTSEC-2026-0459 (libsqlite3-sys); Trivy: 430 OS-Funde im Basisimage, keiner behebbar | `evidence/security-performance/` |
| Scoring-Simulation (R1, 5 Seeds) | erkannt A 83,3 % / B 83,9 % / C 86,7 %; Zielland-Preis falsch A 11,4 % / B 13,9 % / C 10,0 % | 11 §6 |
| Budget-Sättigung | 500 Abrufe/Tag: bei 100 Spielen 23 % der Angebote > 24 h, bei 300 Spielen 75 % | 11 §4 |

## 4. Nachprüfungen durch den Lead

Agenten-Ergebnisse wurden nicht ungeprüft übernommen. Der Lead hat selbst nachgeprüft:

| Befund | Nachprüfung | Ergebnis |
|---|---|---|
| „1“ im Tab (DS-01) | `frontend/index.html` gelesen. Alle Icon-URLs gegen `keyhunter:0.9.1` mit curl geprüft (200, korrekte Content-Types). Code nach `document.title`/Badges durchsucht. Icons vergrößert gerendert (`evidence/lead/favicon-zoom.png`, Skript daneben). | Titel statisch und sauber. Die „1“ ist das Schlüsselloch der 32er-SVG bei 16 px. Die optische `favicon-16.svg` ist nicht verlinkt. |
| CSS-Ladereihenfolge (DS-06) | Importe in `main.tsx` und den Feature-Modulen | bestätigt (`Cart.tsx:13`, `SettingsPage.tsx:15`, `Library.tsx:8` importieren eigene Stylesheets) |
| FUNC-02 | `price_badges.rs:189-192` | bestätigt: Trend filtert `p.market = Zielland`, die EU-Regel aus 0.9.0 fehlt dort |
| CODE-01 | Screenshot `detail-paused` aus der 0.9.0-Abnahme des Leads | bestätigt: pausiertes Spiel zeigt „Wird gesucht …“ |
| SCORE-05 | `jobs.rs:2019-2025` | bestätigt: zwei Zusicherungen vergleichen mit Zeitpunkt 0 und können nie fehlschlagen |
| SEC-01 | `auth.rs:113-132` | bestätigt: eine Drossel-Zeile `id = 1` für alle Clients, Zählung vor der Passphrase-Prüfung |
| PERF-01 | `jobs.rs:196`, Verwendung in `queued()` | Struktur bestätigt (unkorreliertes `EXISTS`); die Zeitmessung stammt von SEC/PERF |
| RESP-01, RESP-02 | `evidence/responsive/r01…`, `r04…` angesehen | bestätigt |
| K23 (CI) | `gh run` von PR #17 und `container.yml` 0.9.1 | grün |
| Secret-Scanning | GitHub-Alarme | 0 offen (Alarm #1 aus 0.9.0 war ein Test-Platzhalter und wurde in 0.9.1 behoben) |

## 5. Screenshots und visuelle Nachweise

| Ordner | Inhalt |
|---|---|
| `evidence/lead/` | Favicon-Vergrößerung inkl. Tab-Nachbildung hell/dunkel |
| `evidence/design/screens/` | 37 Ansichten bei 1440/1920 px |
| `evidence/design/favicon/` | Vergleichsblatt heute und Varianten A/B/C, SVG-Varianten |
| `evidence/design/fixes/` | Vorher/Nachher der Kontrast-Tokens (per CSSOM im laufenden System) |
| `evidence/responsive/` | 9 Kontaktbögen (alle Kernansichten × 6 Viewports), 21 Einzelbelege `r01…r21` |
| `evidence/functional/` | Angebote/Preis mit injizierten Daten, langsame Antwort, 500er-Fehler |
| `evidence/security-performance/` | XSS-Probe (Titel als Text dargestellt) |
| `work/release-1.0-design-preview/` (außerhalb des Repos) | 1:1-Vorschau mit Vorher/Nachher, siehe README dort |

## 6. Nicht prüfbare oder nicht geprüfte Bereiche

| Bereich | Grund | Nachholen in |
|---|---|---|
| Echte Shop-Abrufe, aktuelles Markup, echte Gebühren, Rate-Limit-Grenzen | Live-Anfragen ausdrücklich untersagt | Phase F, Kanarienlauf nach Freigabe |
| Unscharfe IGDB-Suche, Bundle-Einordnung (z. B. Halo MCC) | IGDB nicht abgefragt, die Fixture antwortet auch ohne Zugangsdaten | Phase F, manuell |
| Hintergrund-Worker im laufenden Container (Leases, Neustart während eines Jobs) | Die Fixture startet keine Worker. Belegt nur über DB-Tests, Simulation und Code. | Phase E (Integrationstest mit Mock-Shop) |
| Echte Unraid-Installation | keine Hardware im Audit | Phase F (K50) |
| Firefox, Safari/iOS, Android, Screenreader, Forced Colors | nicht installiert bzw. nicht verfügbar; WebKit nur als Smoke-Test im Playwright-Image | Phase D/E |
| Testabdeckung in Prozent | kein Coverage-Werkzeug im Build-Image | optional, Phase E |
| Historische Scoring-Wiedergabe | nur 221 echte Beobachtungen; Benchmark deshalb synthetisch, als eingeschränkt gekennzeichnet | nach 1.0 mit gesammelten Daten |
| Kaltbackup praktisch wiederhergestellt (K15) | nicht durchgeführt | Phase F |

## 7. Aufräumen

Alle temporären Playwright-Ordner (`frontend/e2e/tmp-audit-*`), Datenordner unter `work/check/` und Container sind entfernt. Zurück bleiben nur die Build-Ordner `work/check/target-*` der Agenten; sie sind gitignoriert und können gelöscht werden. Das prüfe ich vor der Übergabe (siehe Abschlussmeldung).
