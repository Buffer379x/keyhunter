# 08 · Roadmap von 0.9.1 zu 1.0

Priorisierter Maßnahmenplan aus allen Befunden der Dokumente 02–07 und 11. Die Prioritäten sind die der Fachdokumente, mit einer Ausnahme: **SEC-01 hat der Lead auf P1 angehoben** (Begründung in 06 §3.3). Stunden sind menschliche Entwicklerstunden als Spanne; die KI-Ausführung ist separat geschätzt.

**Grundsätze:** kein Rewrite, keine neuen Frameworks, keine Datenmigration mit Datenverlust. Jede Phase endet mit grünen Suiten (Rust, Frontend-Unit, E2E, Visual) und einem lauffähigen Image. Phasen, die dieselben Dateien berühren, laufen nacheinander, nie parallel.

## Überblick

| Phase | Ziel | Prio-Inhalt | Std. (Mensch) | Abhängig von |
|---|---|---|---|---|
| 0 | Werkzeuge und Sicherheitsnetz | P2 | 8–15 | – |
| A | Kritische Fehler, Security, Hot-Path-Performance | P1/P2 | 14–30 | 0 |
| B | Zuverlässigkeit und Datenqualität | P2 | 24–45 | 0, A (Pending-Regel) |
| C | Code-Cleanup und Architektur | P2/P3 | 16–28 | 0 (Lint), B |
| D | Designsystem, Responsive und UX | P1/P2 | 35–65 | 0 (Baselines), C (CSS-Reihenfolge) |
| E | QA und Regressionstests | P2 | 10–18 | B, D |
| F | Release-Vorbereitung | P1/P2 | 14–26 | alle |
| **Summe** | | | **≈ 120–225 h** | |

Rund 40 % davon (Phase D) betrifft Layout und Bedienung, 30 % Zuverlässigkeit und Datenqualität (A, B), der Rest Aufräumen, Tests und Release.

---

## Phase 0 – Werkzeuge und Sicherheitsnetz (vor allen Änderungen)

1. **Ziel:** Jede folgende Änderung wird automatisch formatiert, gelintet und visuell abgesichert. Das macht die großen CSS- und Layoutänderungen in Phase D erst risikoarm.
2. **Aufgaben:**
   - CODE-04: Prettier (oder dprint) und ESLint mit minimaler Konfiguration, Umformatierung als eigener Commit, beides in `deploy/check.sh` und `checks.yml`.
   - DS-08: Visual-Regression um 768 px, um Listen mit vielen und langen Einträgen, um die Angebote-Tabelle mit 9+ Zeilen sowie um Warenkorb und Einstellungen › Log erweitern. Neue Baselines auf dem **unveränderten** 0.9.1-Stand aufnehmen, damit Phase D echte Diffs zeigt.
   - CODE-13: `tsc` über `tests/` und `e2e/` (eigene `tsconfig`), die 9 echten Signatur-Abweichungen beheben.
   - SEC-04 (CI-Teil): `cargo audit` oder osv-scanner in `checks.yml`.
3. **Priorität:** P2, aber Voraussetzung für alles Weitere.
4. **Abhängigkeiten:** keine.
5. **Dateien:** `frontend/package.json`, neue Lint- und Format-Konfiguration, `deploy/check.sh`, `.github/workflows/checks.yml`, `frontend/e2e/visual/core-views.spec.ts` und Baselines, `frontend/tsconfig*.json`.
6. **Aufwand:** 8–15 h.
7. **Risiken:** Das Umformatieren erzeugt einen großen Diff; als reinen Format-Commit ohne inhaltliche Änderung halten. Neue Baselines dürfen nur den Ist-Zustand festhalten.
8. **Teststrategie:** Alle Suiten vor und nach dem Format-Commit identisch grün. Die neuen Baselines laufen zweimal stabil.
9. **Akzeptanz:**
   - `npm run lint` und `npm run format:check` laufen in CI und sind grün.
   - `tsc` über `tests`/`e2e` meldet 0 Fehler.
   - Visual-Suite mit ≥ 30 Ansichten, davon 768 px und lange Titel.
   - `cargo audit` läuft in CI.
10. **Modell:** **Sonnet 5.5, Effort medium.** Mechanische, klar umrissene Arbeit. Für die Auswahl der Baseline-Ansichten genügt eine kurze Prüfung durch Opus. Keine Subagents, alles berührt dieselben Konfigurationsdateien.

## Phase A – Kritische Fehler, Security, Hot-Path-Performance

1. **Ziel:** Kein Client ohne Anmeldung kann den Eigentümer aussperren. Der Scheduler bleibt bei großen Listen schnell. Keine Dauerlast durch Polling.
2. **Aufgaben:**
   - **SEC-01 (P1):** Drossel je Peer-Adresse (`ConnectInfo`, im Speicher) plus höhere globale Obergrenze; optional vertrauenswürdiger Proxy für `X-Forwarded-For`.
   - **SEC-02 (P2):** Timeouts für Request und Body (tower-http `TimeoutLayer` bzw. Body-Timeout) und Limit gleichzeitiger Logins.
   - **PERF-01 (P1):** `ANY_ACTIVE_WISH` als skalaren Ausdruck einmal pro Abfrage auswerten (z. B. `(SELECT COUNT(*) … LIMIT 1)` gebunden als Parameter oder CTE). Zeitmessung bei 500 Wünschen als Test.
   - **CODE-01 + PERF-02 (P2):** Eine einzige Rust-Funktion bzw. ein SQL-Fragment für „Job wartet wirklich“ (Pause, Budget, Lease, Vorschau), genutzt von Scheduler, `pending`/`queued`, Badges und `upcoming`. Das Frontend pollt nur, solange ein *vom Eigentümer ausgelöster* Abruf läuft, sonst im 60-s-Takt.
   - **PERF-03/04 (P2):** `CompressionLayer` (gzip/br) und `Cache-Control` (`index.html` no-cache, gehashte Assets immutable).
   - **SEC-04 (P2):** `url` und `libsqlite3-sys` bzw. sqlx aktualisieren, sobald behobene Versionen verfügbar sind; sonst Begründung dokumentieren.
   - **SEC-03 (P2):** Passphrase ändern und alle Sitzungen beenden (System-Tab).
3. **Priorität:** zwei P1, fünf P2.
4. **Abhängigkeiten:** Phase 0.
5. **Dateien:** `backend/src/auth.rs`, `backend/src/lib.rs` (Layer), `backend/src/jobs.rs`, `backend/src/offers.rs`, `backend/src/price_badges.rs`, `frontend/src/features/useOffersView.ts`, `Wishlist.tsx`, `settings/System.tsx`, `Cargo.toml`/`Cargo.lock`.
6. **Aufwand:** 14–30 h.
7. **Risiken:**
   - Drossel hinter einem Proxy: Ohne Trusted-Proxy-Option gelten alle Anfragen als eine Quelle, das Verhalten bleibt also wie heute. Das muss dokumentiert werden.
   - Die gemeinsame Pending-Regel berührt das Herz des Schedulers. Die vorhandenen 24 Job-Tests und die Kreuzvalidierung aus 11 (`evidence/scoring/xval`) müssen identisch bleiben.
8. **Teststrategie:**
   - Neue Integrationstests: Aussperrversuch von Quelle A, Login von Quelle B klappt; hängender Body nach Timeout abgebrochen.
   - Zeittest für `/status/fetch` und Claim bei 500 Wünschen.
   - Ein Pausen-Test prüft `pending=false`.
   - Kompressions- und Cache-Header über curl-Probe.
   - Kreuzvalidierung des Schedulers erneut ausführen: alle Jobs identisch.
9. **Akzeptanz:**
   - K19 und K22 sind ✅, ebenso K29, K35 und K36.
   - Die Kreuzvalidierung aus 11 meldet „IDENTICAL“.
10. **Modell:** **Opus 5.5, Effort high.** Sicherheitskritisch und nebenläufig: Lease, Transaktion, Drossel. SEC-03 als klar umrissene UI- und API-Arbeit kann **Sonnet 5.5** übernehmen. Zwei Subagents sind möglich, weil die Dateien getrennt sind: (a) auth/lib-Layer, (b) jobs/offers/badges.

## Phase B – Zuverlässigkeit und Datenqualität

1. **Ziel:** Jede Preisansicht ist ehrlich, und Zuordnungen sind eindeutig. Das Zielland-Versprechen von 0.9.0 gilt vollständig.
2. **Aufgaben:**
   - **FUNC-02:** Trend und Zielland-Verlauf nutzen dieselbe Marktregel wie der Preis (`pricing::same_market` statt `market = Zielland`). Der Fehler stammt aus 0.9.0.
   - **FUNC-01:** Automatische Zuordnung zusätzlich über das Erscheinungsjahr bzw. eine eindeutige Katalogkennung absichern. Gleichnamige Titel sind „zu prüfen“ statt automatisch zugeordnet; die 360-/Xbox-Regel nur mit Jahresabgleich.
   - **FUNC-04:** Die Bestätigung von Hand prüft Keytyp und Plattform weiter (Konto- und PC-only-Angebote zählen nie). Der Prüfdialog nennt den Grund.
   - **FUNC-03, FUNC-12, RESP-11:**
     - Veraltete Angebote, solche mit Abruffehler und unbekannte Angebote zeigen keine Ersparnis und keinen Warenkorb-Knopf.
     - Ein fehlgeschlagener Abruf heißt im Detail „Abruf fehlgeschlagen“, nicht „keine Angebote“.
     - Fehlt ein gültiger Preis, heißt es nicht mehr „nicht in DE gültig“.
   - **FUNC-05 / SCORE-04:** Die Frischegrenze folgt dem Intervall, z. B. `max(24 h, 2 × effektives Intervall)`, oder die Intervallauswahl wird auf ≤ 24 h begrenzt. Eine der beiden Varianten wählen und dokumentieren.
   - **RESP-14:** Der Warenkorb kennzeichnet INT-Angebote, die im Zielland nicht sicher aktivierbar sind.
   - **SCORE-03 / RESP-19 / PROD-04:** „Score“ umbenennen in „Prüftempo“ (häufig, normal, selten) und standardmäßig ausblenden, oder entfernen.
   - **SCORE-05:** Den wirkungslosen Fairness-Test reparieren (Stichzeit statt 0). Schlägt er danach fehl, die Klassen-2–5-Quote dokumentieren, das Verhalten aber erst in 1.1 ändern.
   - **FUNC-11:** Angebotszahl in Liste und Detail mit derselben Definition berechnen.
   - **FUNC-13 / SCORE-06:** Backoff für dauerhaft tote Links (404 oder Parserfehler n-mal hintereinander, dann Intervall ×4 und eine Log-Meldung).
3. **Priorität:** P2, aber K05, K08, K09 und K10 sind Pflichtkriterien.
4. **Abhängigkeiten:** Phase A wegen der gemeinsamen Pending-Regel in `offers.rs`/`jobs.rs`.
5. **Dateien:** `backend/src/price_badges.rs`, `history.rs`, `pricing.rs`, `offers.rs`, `shops/mod.rs`, `jobs.rs`, `frontend/src/features/Offers.tsx`, `offers-model.ts`, `PriceTab.tsx`, `LinkReview.tsx`, `Cart.tsx`, `cart-model.ts`, `offers-columns.ts`, `settings/format.ts`.
6. **Aufwand:** 24–45 h.
7. **Risiken:**
   - Strengere Zuordnung kann bisher korrekt zugeordnete Links in „zu prüfen“ verschieben. Bestehende bestätigte Links bleiben unangetastet; die neue Regel gilt nur für Neuzuordnungen.
   - Die Frischeregel ändert, was als „aktuell“ zählt, und damit KPI und Alarme. Release Notes nötig.
8. **Teststrategie:**
   - Rust-Proben aus 03 (`evidence/functional/matching-probes.rs.txt`) als echte Tests übernehmen: Doom 1993/2016, Battlefront II 2005/2017, Konto-Angebot von Hand bestätigt.
   - EU-Zielland-Integrationstest (AT) für Preis, Trend und Verlauf.
   - E2E mit Fixture-Preisdaten (`KEYHUNTER_FIXTURE_PRICES`) statt Mocks für Angebote und Preis-Tab (FUNC-06).
9. **Akzeptanz:**
   - K05, K08, K09 und K10 sind ✅, ebenso K26, K27, K47 und K48.
   - Kein bestehender bestätigter Link ändert durch das Update seinen Status (Migrationstest mit der 0.9.1-DB).
10. **Modell:** **Opus 5.5, Effort high bis xhigh** für FUNC-01, FUNC-02, FUNC-04 und FUNC-05, weil Datenqualität und Fachlogik subtil sind. Die UI-Kennzeichnungen (FUNC-03, RESP-11, RESP-14, SCORE-03) übernimmt **Sonnet 5.5, Effort high**, nach Abschluss der Backend-Arbeit. Nicht parallel an `offers.rs` arbeiten.

## Phase C – Code-Cleanup und Architektur

1. **Ziel:** Redundanzen und toten Code entfernen, einheitliche Fehlerform, die Doku stimmt.
2. **Aufgaben:**
   - **CODE-02 / FUNC-15 / SEC-06:** Eigene Extraktoren bzw. ein Rejection-Handler für JSON-, Query- und Path-Fehler. Einheitliche deutsche JSON-Fehler mit `code`; Anmeldung vor dem Parsen des Bodys.
   - **CODE-05:** Toten Code entfernen: `wishlist_price_scope` mit einer Migration, die die Spalte belässt und nur nicht mehr liest; den Endpunkt `/catalog/games/{id}/editions` ohne Aufrufer; `OffersView.history`; die Frontend-Pfade für „older server“; `onBack`.
   - **CODE-08 / PERF-06:** Navigationszähler über ein schlankes `/counts`, `/status/fetch` nur einmal pollen, N+1 in `attach` (PERF-08) auflösen.
   - **DS-05, DS-06, DS-07, DS-11:**
     - CSS-Ladereihenfolge korrigieren: Feature-Stylesheets nach `tokens`/`ui` laden, zentral in `main.tsx`.
     - Ungenutzte Alias-Tokens, doppelte Regeln und tote Klassen entfernen.
     - Diese Punkte dürfen nichts sichtbar ändern: Die Visual-Suite aus Phase 0 muss pixelgleich bleiben.
   - **Doku (CODE-09, FUNC-08, SCORE-10, PERF-14):** `docs/*.md`, `.env.example` und das Unraid-Template auf den Code-Stand bringen.
   - **CODE-15:** CI-Prüfung, dass ausgelieferte Migrationen unverändert bleiben (Prüfsummenliste).
   - **CODE-11 (Teil):** `DAY` einmal definieren, benannte Konstanten für die 900-s-Werte.
3. **Priorität:** P2, bis auf CODE-11 (P3, nur mitnehmen, wenn die Dateien ohnehin offen sind).
4. **Abhängigkeiten:** Phase 0 (Lint, Baselines), Phase B wegen der Überschneidungen in `offers.rs` und `price_badges.rs`.
5. **Dateien:** `backend/src/lib.rs`, `catalog/mod.rs`, `settings.rs`, `wishlist.rs`, `jobs.rs`, `frontend/src/App.tsx`, `main.tsx`, `styles/*.css`, `docs/*.md`, `.env.example`, `deploy/unraid/keyhunter.xml`, CI.
6. **Aufwand:** 16–28 h.
7. **Risiken:**
   - Das Entfernen von „older server“-Pfaden ist nur sicher, weil Frontend und Backend im selben Image ausgeliefert werden; das im Code festhalten.
   - CSS-Reihenfolge: Die Pixelgleichheit muss die Visual-Suite belegen.
8. **Teststrategie:**
   - API-Test über alle Routen: falscher Body führt zu 401 ohne Sitzung und zu deutschem JSON mit `code` mit Sitzung.
   - Visual-Suite pixelgleich nach dem CSS-Aufräumen.
   - Doku-Werte, wo möglich, per Test gegen Konstanten abgleichen (Budgetgrenzen).
9. **Akzeptanz:**
   - K16 ✅.
   - 0 ungenutzte Exporte laut knip, außer dokumentierten Ausnahmen.
   - 0 doppelt definierte Klassen zwischen den Stylesheets, außer dokumentierten Overrides.
   - Alle Fehlerantworten im JSON-Format.
10. **Modell:**
    - **Sonnet 5.5, Effort medium:** Doku, CSS-Aufräumen, toter Code.
    - **Opus 5.5, Effort high:** Fehlerform-Refactoring (berührt alle Handler) und die Abfrage-Konsolidierung.
    - Subagents möglich für Doku und CSS, weil die Dateien getrennt sind.

## Phase D – Designsystem, Responsive und UX

1. **Ziel:** Auf Phone, Tablet und Laptop voll bedienbar, mit einheitlichen Zuständen, gutem Kontrast und sichtbarem Fokus. Das Favicon ist korrekt.
2. **Aufgaben:** Umsetzung nach der **1:1-Vorschau** in `work/release-1.0-design-preview/`, siehe README dort.
   - **P1:** RESP-01 (Karten der Wunschliste auf Phones), RESP-02 (Angebote-Tabelle auf Phone und Tablet, vollständig bei 1366×768), RESP-03 (Öffnen-Aktion auf Tablets), DS-01 (Favicon-Variante, `index.html`-Links, `npm run brand:icons`).
   - **P2:**
     - RESP-04 bis RESP-10, RESP-12, RESP-13, RESP-15;
     - DS-02 (Kontrast-Tokens), DS-03 (Fokusring), DS-04 (einheitliche Zustände), DS-09 (eine Cover-Komponente);
     - PERF-05 (CLS der KPI-Kacheln);
     - PROD-02 (Erststart-Checkliste, gemeinsam mit RESP-15), PROD-03 (Tab „Infos“ → „Zuordnungen“), PROD-14 (Budget-Engpass sichtbar).
   - **P3, nur wenn die Dateien ohnehin offen sind:** RESP-16, RESP-18, RESP-20, DS-10, DS-19.
3. **Priorität:** vier P1, Rest P2/P3.
4. **Abhängigkeiten:** Phase 0 (Baselines) und Phase C (CSS-Ladereihenfolge, tote Regeln entfernt). Die UI-Kennzeichnungen aus Phase B sollten vorher fertig sein, weil sie dieselben Komponenten berühren.
5. **Dateien:**
   - `frontend/src/styles/tokens.css`, `ui.css`, `wishlist.css`, `offers.css`, `detail.css`, `shell.css`, `cart.css`;
   - `WishlistRow.tsx`, `Wishlist.tsx`, `Offers.tsx`, `GameDetail.tsx`, `CatalogSearch.tsx`, `App.tsx` (Drawer), `ui/Tabs.tsx`, `ui/Help.tsx`, `ui/Toaster.tsx`, `AuthScreen.tsx`, `GameCover.tsx`/`catalog-ui.tsx`;
   - `frontend/public/*`, `frontend/index.html`.
6. **Aufwand:** 35–65 h.
7. **Risiken:**
   - Viele Visual-Baselines ändern sich. Nur gegen die freigegebene Vorschau abnehmen.
   - Touch-Größen (`pointer: coarse`) dürfen das Desktop-Layout nicht verändern.
   - Favicon-Caches der Browser: Dateinamen versionieren (DS-20) oder Hinweis in die Release Notes.
8. **Teststrategie:**
   - Messspecs aus 05 und der Vorschau als dauerhafte E2E-Tests übernehmen: kein Container-Overflow bei 375, 430, 768 und 1366 px, alle Aktionen sichtbar, Touch-Ziele ≥ 44 px bei `hasTouch`.
   - axe-Scan in E2E mit 0 `serious`-Kontrastverstößen.
   - Visual-Baselines nach Abnahme neu aufnehmen.
   - Kurzer WebKit-Durchlauf im Playwright-Image.
9. **Akzeptanz:**
   - K39, K40, K21, K41 und K42 sind ✅, ebenso K43 und K52.
   - Die Vorschau-Screenshots und die neuen Baselines stimmen sichtbar überein.
10. **Modell:**
    - **Opus 5.5, Effort high:** Layout und visuelle Urteile, mit Screenshot-Abnahme durch das Modell selbst.
    - **Sonnet 5.5, Effort medium:** Textkorrekturen und Token-Werte.
    - Keine parallelen Agents auf denselben Stylesheets; höchstens ein zweiter für Erststart und Favicon (andere Dateien).

## Phase E – QA und Regressionstests

1. **Ziel:** Die Fehlerklassen dieses Audits können nicht unbemerkt zurückkehren.
2. **Aufgaben:**
   - **FUNC-06:** E2E-Specs für Preis-Tab, Angebote und Wunschliste mit Fixture-Preisdaten, kein Mock. Ein Contract-Test prüft, dass die TypeScript-Typen zu den Rust-JSON-Formen passen, z. B. per JSON-Schema-Snapshot aus den RI-Tests.
   - **FUNC-07:** Tests für die HTTP-Fehlerklassifizierung der Shop-Abrufe gegen einen lokalen Mock-Server (429 mit Retry-After, 503, 403, Timeout).
   - **a11y:** Den axe-Scan aus 05 als festen E2E-Test aufnehmen.
   - **CODE-03:** Ein Test über alle Routen: ohne Sitzung 401, ohne CSRF 403.
   - Übernommene Messspecs aus Phase D, Migrationstest mit einer 0.9.1-Datenbank auf 1.0.
3. **Priorität:** P2.
4. **Abhängigkeiten:** B, D.
5. **Dateien:** `frontend/e2e/*`, `backend/tests/*`, `backend/src/shops/http.rs` (Test-Seam), CI.
6. **Aufwand:** 10–18 h.
7. **Risiken:** Flakiness neuer E2E-Tests. Zwei Läufe ohne Retries sind Pflicht (K02).
8. **Teststrategie:** Die neuen Tests müssen gegen die 0.9.1-Fehler nachweislich rot sein; den Test zuerst auf dem alten Stand laufen lassen.
9. **Akzeptanz:** K07, K21 (automatisiert) und K25 sind ✅. Alle in diesem Audit bestätigten Fehler haben einen Regressionstest.
10. **Modell:** **Sonnet 5.5, Effort high** zum Schreiben der Tests, **Opus 5.5** für ein kurzes Review der Testabdeckung je Befund. Subagents nach Testebene möglich (Rust gegen E2E).

## Phase F – Release-Vorbereitung

1. **Ziel:** 1.0 ist installier-, aktualisier- und wiederherstellbar, dokumentiert und auf echtem Unraid abgenommen.
2. **Aufgaben:**
   - **FUNC-09:** Erlaubte Nutzung je Datenquelle dokumentieren: Eneba, Driffle, IGDB, Microsoft-Katalog; robots-Handling, Drosselung, Zweck.
   - **SEC-07:** Beispielkonfigurationen für Reverse Proxy (Caddy, Nginx Proxy Manager, Traefik) inkl. HSTS-Hinweis.
   - **PROD-01:** Import der Wunschliste (JSON aus dem Export) und eine Seite „Sichern & Wiederherstellen“.
   - **PROD-13:** Ein manueller oder automatischer Kanarienlauf der Parser vor dem Release, nur mit erlaubtem, minimalem Abruf und mit Zustimmung des Eigentümers.
   - **K50:** Abnahmetest auf echtem Unraid (Template-Installation, Update von 0.9.1, Neustart, Backup und Restore).
   - **K15:** Kaltbackup praktisch wiederherstellen.
   - Release Notes 1.0 mit Verhaltensänderungen (Frische, Zuordnung, Drossel, Score).
   - Optional **SEC-05 und SEC-10:** schlankeres Basisimage, Healthcheck ohne curl, gepinnte Digests. Sonst 1.1.
3. **Priorität:** P1 (K50, Release Notes) und P2.
4. **Abhängigkeiten:** alle Phasen.
5. **Dateien:** `docs/*`, `deploy/*`, `Dockerfile`, `frontend/src/features/settings/System.tsx`, `wishlist-export.ts`, neue Import-Route in `backend/src/wishlist.rs`.
6. **Aufwand:** 14–26 h, ohne Unraid-Wartezeit.
7. **Risiken:** Der Import muss Dubletten und Bibliothekskonflikte genauso behandeln wie das Vormerken. Den Kanarienlauf nur nach ausdrücklicher Freigabe.
8. **Teststrategie:** Export, dann Import in eine leere Instanz, Ergebnis identisch. Upgrade-Test 0.9.1 → 1.0 mit echter Datenbank-Kopie, Sicherung und Rückweg.
9. **Akzeptanz:** Alle Pflichtkriterien in 09 sind ✅, kein offener P0/P1, die Release Notes sind freigegeben.
10. **Modell:** **Sonnet 5.5, Effort medium** für Doku und Import. **Opus 5.5, Effort high** für das abschließende Release-Review. Den Unraid-Test macht der Eigentümer, das Modell liefert die Checkliste.

---

## Was auf 1.1 oder später warten darf

- **Scoring:** Kandidat C (etwa 20 % weniger Abfragen bei gleicher Erkennung), Rate-Limit-Anpassung (SCORE-08), Pause bei Netzausfall (SCORE-07), Uhr-Rücksprung (SCORE-09) und die Normierung (SCORE-01/02). Siehe 11 §8: kein Blocker, messbarer Nutzen erst mit Umsetzung.
- **Code und Architektur:** Frontend-State (CODE-07, 12–20 h), Aufteilung von `jobs.rs`/`notify.rs` (CODE-12), zentraler Auth-Layer (CODE-03; der Test kommt schon in Phase E), Kommentar-Rauschen (CODE-18), doppelte Hilfsfunktionen (CODE-17).
- **Design:** DS-12 bis DS-18 und DS-20 (Meldungsstile, Icon-Buttons, Einstellungs-Muster, Leerfläche, Mono/Sans, Dialoge, PWA-Icons).
- **Performance und Betrieb:** PERF-07 bis PERF-13, SEC-05/08/09/10.
- **Produkt:** PROD-05 bis PROD-08 und PROD-12 (Inbox, relativer Alarm, Tiefstwert-Zeitraum).

## KI-Ausführung: Dauer und Tokenbedarf

Die Werte sind grobe Erfahrungswerte aus den Releases 0.8–0.9.1 dieses Projekts, keine Messung. Sie gelten je Phase inklusive Testläufen und Screenshot-Abnahme.

| Phase | Ausführungsdauer KI | Tokens (Größenordnung) | Hinweis |
|---|---|---|---|
| 0 | 1–2 h | 1–2 Mio. | Hauptsächlich Läufe der Suiten |
| A | 2–4 h | 2–4 Mio. | Ein bis zwei Subagents |
| B | 3–6 h | 3–6 Mio. | Hoher Anteil Fachlogik-Analyse |
| C | 2–4 h | 2–4 Mio. | |
| D | 4–8 h | 5–10 Mio. | Viele Screenshot-Runden |
| E | 2–4 h | 2–4 Mio. | |
| F | 2–3 h | 1–3 Mio. | Ohne Unraid-Test |

Empfehlung: Phasen 0 bis C als zwei Releases (0.9.2: 0 und A; 0.9.3: B und C), Phase D als 0.9.4 mit Freigabe der Vorschau, danach E und F als 1.0. So bleibt jede Stufe einzeln prüf- und rücknehmbar.
