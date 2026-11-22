# 03 – Funktionaler End-to-End-Audit, Datenqualität und QA (KeyHunter 0.9.1)

Rolle: Senior QA Engineer (Funktion, Datenqualität, Teststrategie). Stand: Branch `audit/release-1.0`, Commit `490a8fb` (Tag 0.9.1).
Belege: `docs/release-1.0-audit/evidence/functional/`. Alle Prüfungen offline: gemockter IGDB-Katalog (`backend/examples/catalog_fixture.rs`),
synthetische Shop-Daten, keine Anfrage an Händler, IGDB oder Microsoft.

## 1. Kurzfazit

- **Die Preis-Pipeline ist defensiv gebaut und hält das wichtigste Versprechen:** Ein fehlgeschlagener Abruf, ein Preis von 0, ein negativer oder absurder Betrag und ausverkaufte Ware erscheinen nirgends als gültiger Preis. Geprüft wurde das im Code (`pricing.rs`), über die API mit 14 injizierten Fällen und in der Oberfläche.
- **Alle vorhandenen Suiten sind grün und stabil:** 173 Backend-Tests, 71 Frontend-Unit-Tests, 73 E2E-Tests in zwei Läufen ohne Flakes und 22 visuelle Tests, ohne dass sich eine Baseline geändert hat.
- **Persistenz und Update sind belegt:** Nach einem Neustart sind alle Daten identisch. Ein Upgrade einer Datenbank aus 0.5.0 auf 0.9.1 legt die Sicherung an und überträgt alle Zustände. Mit dem Vorgänger-Image funktioniert auch der Rückweg.
- **Datenqualität, zwei echte Lücken:**
  1. Die Identität eines Spiels hängt nur am normalisierten Titel. Gleichnamige Spiele werden deshalb automatisch zugeordnet, etwa „Doom“ von 1993 und von 2016 (FUNC-01).
  2. Eine manuelle Bestätigung übergeht den Keytyp. Ein Konto-Angebot wird so zum gültigen „Key-Preis“ (FUNC-04).
- **Ein Datenflussfehler im 0.9.0-Feature „EU-Zielländer“:** Für AT, FR usw. bleiben der 14-Tage-Trend und der Zielland-Verlauf dauerhaft leer, obwohl der aktuelle Preis zählt (FUNC-02).
- **Die größte QA-Lücke:** Die Preisoberfläche wird in 22 von 26 E2E-Specs nur gegen handgeschriebene JSON-Mocks geprüft. Einen Vertragstest zwischen Backend und Frontend gibt es nicht. FUNC-02 konnte deshalb unbemerkt bleiben (FUNC-06).

| Kategorie | Bewertung | Begründung |
|---|---|---|
| Funktionalität | **7/10** | Breiter, konsistenter Funktionsumfang. Alle 339 automatisierten Tests sind grün, Persistenz, Upgrade und Restore sind belegt. Abzüge gibt es für die EU-Trend-/Verlaufslücke, die Darstellung veralteter Preise und die manuelle Bestätigung von Nicht-Keys. |
| Zuverlässigkeit der Preisabfragen | **6/10** (nur offline belegt) | Starke Kette aus Cent-Grenzen, EUR-Zwang, Bestand, 24-h-Frische, Leases, Retry-Leiter, Tagesbudget und robots.txt, und es entsteht kein Nullpreis. Allerdings ist die HTTP-Fehlerklassifizierung ungetestet. Die Reader hängen an internen Seitenstrukturen und nutzen synthetische Fixtures. Parserbrüche werden nicht eskaliert. Intervalle über 24 h kollidieren mit der Frischegrenze. |
| Datenqualität | **6/10** | Standard und Premium, DLC, Konto und PC-Key trennt die automatische Zuordnung nachweislich (Proben D–K). Probleme machen die Titel-only-Identität (Reboot wird automatisch bestätigt), die manuelle Bestätigung ohne Keytyp-Prüfung, falsch-negative Namensvarianten und der EU-Verlauf. |
| Testabdeckung und QA | **7/10** | Viele echte Assertions: rund 490 in den Rust-Integrationstests, 331 in den Frontend-Unit-Tests und 873 `expect` in E2E. Migrationen und die Job-Engine sind auf DB-Ebene getestet, Visual Regression läuft in CI. Lücken bestehen beim Contract zwischen Backend und Frontend, bei der HTTP-Schicht, beim EU-Verlauf, bei automatisierter Accessibility und bei der Aktualität der Parser gegenüber dem Live-Markup. |

## 2. Funktionsinventur

Die Inventur stammt aus `backend/src/lib.rs:261-326` (43 API-Routen), aus `frontend/src/App.tsx` und `features/*` sowie aus `docs/`. Testabkürzungen: **RU** Rust-Unit (`src/**`), **RI** Rust-Integration (`backend/tests/*.rs`, Router und SQLite in-process), **FU** Frontend-Unit (`frontend/tests`), **E2E** Playwright gegen den Fixture-Server (Zusatz **(M)**: Preisdaten per `page.route` gemockt), **VR** visueller Abgleich, **A** in diesem Audit geprüft.

| # | Funktion | Einstieg | Test heute | A |
|---|---|---|---|---|
| 1 | Ersteinrichtung (Code und Passphrase), Login, Logout, Sitzung 12 h, Login-Drossel | `/setup`, `/session`, `/me` | RI (6), E2E `app` | API |
| 2 | Katalogsuche IGDB: Titel, IGDB-ID, Plattform oder „Alle“, Cache 1 h, Ausfall ≠ leer | `/catalog/search` | RU, RI, E2E `catalog`, `release063/081` | API (19 Fälle) |
| 3 | Spieldetail, Editionen, Editionsvergleich (Microsoft-Katalog) | `/catalog/games/{id}[/editions\|/edition-comparison]` | RU `contents` (2), RI, E2E `release070` | Code |
| 4 | Vormerken (Katalog oder manuell), Dubletten, Plattform- und Typprüfung | `POST /wishlist` | RI (5), E2E `wishlist`, `catalog` | API (17 Fälle) |
| 5 | Wunschliste: Sortierung, Filter-Chips, Text- und Shopfilter, Seiten, Spalten, KPI-Kacheln | `GET /wishlist`, UI | FU `wishlist-*`, E2E (M) `wishlist`, `release071/074/082/091` | E2E-Lauf |
| 6 | Editionswechsel, Vorschau, Hintergrund-Tracking | `/wishlist/{id}/editions`, `/preview` | RI (3), RU `jobs` (2), E2E `release042` (M) | API |
| 7 | Preis-Tab, Angebote-Tab, Verlauf, Score, Preis-Badges, Trend | `/wishlist/{id}/offers`, `/wishlist/price-badges` | RU `pricing`, `history`, `offers`; RI (5); FU; E2E (M); VR (M) | API und UI mit injizierten Daten |
| 8 | Zuordnung prüfen, bestätigen (auch von Hand), ablehnen, löschen, Link von Hand | `PUT/DELETE /wishlist/{id}/offers/{link}`, `POST …/offers` | RU, RI (3), E2E `release064/073` (M) | API |
| 9 | „Jetzt prüfen“ | `POST …/offers/refresh` | RI, RU `jobs` | Code |
| 10 | Preisalarme (Zielpreis oder Tiefstpreis, Grund- oder Schätzpreis), Alarmliste | `/wishlist/{id}/alert`, `/alerts` | RU `alerts` (2), RI, E2E `alarms-library`, `release050` (M) | API |
| 11 | Benachrichtigungskanäle (ntfy, Telegram, Discord, SMTP, Gotify, Pushover, Webhook), Testnachricht | `/alerts/channels/*` | RU `notify` (12), RI, E2E `release090-notifications` | nur Code (Tiefe: SEC) |
| 12 | Warenkorb mit Shop und Preisgrundlage je Spiel | `/cart` | RI (2), FU `cart-model`, E2E `release080/081/091` (M) | API |
| 13 | Bibliothek: Kauf, direkt hinzufügen, wiederherstellen, löschen | `/library`, `…/purchase`, `…/restore` | RI (4), E2E `release072/081`, `alarms-library` | API |
| 14 | Pause je Wunsch und global | `PUT …/pause`, `POST /status/fetch/pause` | RU `jobs` (2), RI (2), E2E `release071/090` | API |
| 15 | Abrufstatus (Budget, Bedarf, nächste Abrufe, Läufe) | `/status/fetch[/runs]` | RU `jobs` (3), RI, E2E `settings-sections` (M) | API |
| 16 | Ereignislog (7 Tage, Filter, Suche, Seiten) | `/log` | RU `eventlog` (3), RI, E2E `release083` | API |
| 17 | Einstellungen: Zielland, Shops, Intervall, Tagesbudget, Gebühren, Spalten, IGDB-Zugang | `/settings`, `/settings/igdb` | RI (8), E2E `settings-sections`, `shell`, `app` | API |
| 18 | Export der Wunschliste als JSON (Einstellungen › Allgemein); **kein Import** | Frontend `wishlist-export.ts` | **kein Test** (E2E prüft nur, dass der Knopf in der Liste fehlt) | Code |
| 19 | Hintergrund: Eneba-Suche und -Sitemap, Driffle-Sitemaps, Produktabrufe, Budget, Pacing, Retry, Leases | `jobs.rs`, `shops/*` | RU `jobs` (24), `shops` (55) | Code; **in der Fixture nicht lauffähig** (`run_background=false`, `lib.rs:146-151`) |
| 20 | Sicherung vor Migration, Fingerabdruck-Upgrade | `lib.rs:389-440`, `shops/mod.rs:203` | RU `migration_tests` (6), `shops` | echtes Upgrade 0.5.0 → 0.9.1 und Restore |
| 21 | Health `/health/live`, `/health/ready` (Heartbeat 300 s) | `lib.rs:332-358` | RI | curl |

## 3. Testläufe (exakte Zahlen)

| Suite | Befehl | Ergebnis | Laufzeit | Stabilität |
|---|---|---|---|---|
| Backend | `cargo test --locked` (Docker, `work/check/target-func`) | **173 passed**, 0 failed, 0 ignored (Lib 119, `api.rs` 14, `catalog_wishlist.rs` 40, Doc 0) | 1:29 min inkl. Kompilierung, Tests ca. 25 s | 0 Warnungen |
| Frontend-Unit | `npm test` (17 Dateien) | **71 passed**, 0 skipped | 0,35 s | – |
| E2E | `KEYHUNTER_TEST_PORT=38781 sh deploy/browser-check.sh --reporter=line` | **73 passed** (26 Specs) | 3,0 min | 2. Lauf ebenfalls 73/73 (2,8 min), `retries: 0` |
| Visual | `KEYHUNTER_TEST_PORT=38791 sh deploy/visual-check.sh` | **22 passed**, 24 Baselines unverändert | 40 s | `git status` sauber |
| Audit-Proben | `frontend/e2e/tmp-audit-func` (5 Tests, gelöscht) und Rust-Proben in einer Scratch-Kopie | 5/5 bzw. 2/2 | 26 s | – |

Details: `evidence/functional/test-runs.txt`, `backend-test-names.txt`.

**Hinweis zur Testinfrastruktur:** `deploy/browser-check.sh` startet alle Specs unter `frontend/e2e/` außer `visual/`. Temporäre Unterordner fließen also mit ein. Der zweite Lauf wurde deshalb mit der expliziten Liste der 26 Repo-Specs gestartet.

## 4. Datenfluss der Preise und Nachweis „kein Nullpreis“

**Kette:**

1. Parser (`shops/eneba.rs:7-169`, `driffle.rs:7-136`)
2. `Product` mit Angeboten von 1 bis 10.000.000 Cent, nur EUR, nur vorrätig, keine Vorbestellung
3. `jobs::complete` (`jobs.rs:551-731`): `offer_link.latest` und unveränderliche `price_observation` mit Trigger `valid_cents` (Migration 0014)
4. `pricing::evaluate` (`pricing.rs:116-176`), eine Regel für alle Ansichten
5. Ausgabe: Badges (`price_badges.rs`), Angebote (`offers.rs:309-459`), Warenkorb und Alarme (`alerts.rs:279-344`, Zustellung nur, wenn der Preis noch gilt, `alerts.rs:479-492`)

**Fehlschlag:** `latest` und `observed_at` bleiben unverändert, nur `last_error` und `attempted_at` werden gesetzt (`jobs.rs:672-690`). Der Grund `SourceError` macht den Wert zum „zuletzt bekannten“ Preis. Er zählt weder als Bestpreis noch für Alarme.

Mit Daten geprüft, die direkt in die Fixture-Datenbank injiziert wurden (`evidence/functional/api-probes.txt` §3, Screenshots `offers-injected-1366.png`, `preis-injected-1366.png`):

| Fall | API-Ergebnis | Oberfläche |
|---|---|---|
| Angebot 0 ct, −500 ct, 10.000.001 ct | `no_price`, keine Quote, nicht `eligible` | „kein Preis“; die Pille sagt aber „nicht in DE gültig“ (FUNC-12) |
| Angebote [0, 2222] | nur 2222 zählt und ist bester Preis | 22,22 € „bester“ |
| Beobachtung 30 h alt | `stale`, `last_known` | „veraltet · vor 1 T“, Preis und Ersparnis jedoch wie aktuell (FUNC-03) |
| letzter Abruf fehlgeschlagen | `source_error`, `last_known` = 15,00 € | Pille „Abruffehler“, Preis −7,22 € gegenüber DE, Warenkorb-Knopf aktiv (FUNC-03) |
| Verfügbarkeit unbekannt / ausverkauft | `availability_unknown` / `sold_out` | „Verfügbarkeit unbekannt“ / „ausverkauft“ |
| Premium-Edition, Konto, nur PC | `mismatch`, `can_confirm=false` | „Zuordnung prüfen“ |
| Argentinien (DE unbekannt), DE gesperrt | `activation_unknown` / `activation_blocked` | als weltweit günstiger mit Grund ausgewiesen, nicht als DE-Preis |
| Badge | `cents` 2222 (DE), `world` 900 (Argentinien) | Kernanwendungsfall „günstigste Region gegen Zielland“ korrekt |
| `/offers` liefert 500 | – | „Interner Fehler … Erneut laden“, kein Preis. Daneben steht „wird geladen …“ dauerhaft (UX) |
| Backend 4 s verzögert | – | „Wird geladen …“, kein Platzhalterwert (`slow-preis-during-1366.png`) |

**Unterscheidet die Oberfläche bestätigte, veraltete, geschätzte und unbekannte Angaben?**

- **Bestätigt:** ja, Pillen „in DE aktivierbar“ und „Zuordnung bestätigt / Von dir bestätigt“.
- **Geschätzt:** ja, Umschalter „Gesamtpreis geschätzt“, „geschätzt gesamt …“ und „Mit Gebühren“.
- **Unbekannt:** ja, „Noch nicht abgefragt“, „Kein Angebot“, „Aktivierung ungeklärt“.
- **Veraltet oder fehlerhaft:** nur teilweise. Badge und Preis-Tab kennzeichnen den Wert als „Zuletzt bekannt“. Im Angebote-Tab werden diese Zeilen aber wie aktuelle Angebote mit Ersparnis und Warenkorb-Aktion gezeigt (FUNC-03).

## 5. Funktionsprüfungen (API und UI gegen eigene Fixture, Port 38781)

| Bereich | Ergebnis |
|---|---|
| Suche | Exakt, Groß-/Kleinschreibung, IGDB-ID (`1001`, `#1002`, `igdb:`), „Alle“-Plattform, leer, Ausfall (503, kein leeres Ergebnis), Längen- und Steuerzeichenprüfung, SQL- und HTML-Literale korrekt. Unscharfe Schreibweisen liegen vollständig bei IGDB und sind offline **nicht verifiziert**. Der Cache-Schlüssel normalisiert innere Leerzeichen nicht: „FORZA␣␣horizon 5“ erzeugt einen zweiten IGDB-Abruf (Kleinigkeit). DLC-Treffer werden geliefert, aber nicht wählbar angeboten. |
| Vormerken | Dubletten werden idempotent behandelt (200 `created=false`). DLC, PC und falsche Plattform werden abgewiesen (422/400). Manuelle Titel bleiben ungeprüft. „Halo Infinite!“ und „Halo Infinite“ ergeben zwei Wünsche mit identischem Abgleichschlüssel (`title_key`). |
| Edition | Eine Vorschau ändert die gemerkte Edition nicht. Eine fremde oder DLC-Edition wird mit 422 abgewiesen. `catalog::editions` lässt nur Editionen für Series oder One zu (`catalog/mod.rs:288`), 360-Editionen fehlen also in der Auswahl (bewusst? undokumentiert). |
| Alarme | Validierung: Ziel 1 bis 10 Mio. Cent, Modus und Basis. Ein Alarm entsteht nur aus einem frisch gemessenen Zielland-Preis und wird vor der Zustellung erneut geprüft. Ohne Kanal wird die Regel gespeichert und der Hinweis erscheint. |
| Warenkorb, Bibliothek, Pause, Log, Einstellungen | Alle Positiv- und Negativfälle liefern die erwarteten Codes (`api-probes.txt` §5). Pausen sind auf höchstens ein Jahr begrenzt, Kauf ist idempotent (2. Aufruf 404). |
| Persistenz | Prozess beendet und mit demselben Datenverzeichnis neu gestartet: Hashes von Wunschliste (4), Bibliothek (1), Warenkorb (1), Alarmen, Einstellungen und Alarmregel sind identisch. Die Sitzung bleibt gültig. |
| Update und Restore | `keyhunter:0.5.0` (offline, `--network none`) legt Schema 10 an, dazu kommen synthetische 0.5-Daten. Die 0.9.1-Fixture migriert auf 27, legt `backups/keyhunter-schema-0010-*.db` an und überträgt `state`, `viewed_at` und `acquired_at`. Den Fingerabdruck stellt sie von v1 auf v2 um, Alarmregel, Preis und `valid_cents` bleiben korrekt. Rückweg: Mit der Sicherung startet 0.5.0 unverändert (`integrity_check ok`). |
| Negativfälle | Offline gibt es keinen Absturz und keine erfundenen Werte. Ein Shop-Ausfall ist nur auf Unit-Ebene simuliert (Fixture ohne Worker). Bei ungültigem JSON, falschem Typ oder zu großem Body antwortet Axum mit `text/plain` auf Englisch ohne `code` (FUNC-15). Das Frontend zeigt dann eine generische deutsche Meldung. |
| Manuelle Bestätigung | Ohne `manual` lehnt der Server mit 409 ab. Mit `manual:true` wird auch ein Konto-Angebot (`key_game=false`) oder ein reines PC-Produkt bestätigt und danach als bester DE-Preis (3,00 €) und im Badge gewertet (FUNC-04). |

## 6. Hintergrundjobs (Code-Analyse; in der Fixture nicht ausführbar)

- **Ein Worker pro Shop** (`jobs.rs:136-171`), Schleife alle 2–3 s. Der Claim erfolgt in einer Transaktion mit 180-s-Lease (`jobs.rs:285-303`). `NOT EXISTS(… running …)` erlaubt höchstens einen aktiven Job pro Shop, auch mit mehreren Prozessen auf derselben Datenbank. `complete` prüft das Lease-Token, ein verspätetes Ergebnis wird verworfen (`jobs.rs:590-606`). **Keine doppelten oder konkurrierenden Jobs.**
- **Neustart:** Leases, `paced_until`, Tagesbudget und Suchseiten liegen in der Datenbank. Abgelaufene Leases sind nach höchstens 180 s wieder frei, und nach einem Neustart gibt es keinen Abruf-Burst. Getestet ist das in `jobs::tests::persistent_lease_budget_and_source_pause`.
- **Intervalle:** Shop-Intervall (Standard 8 h) × 2 bei Vorschau × Tempo 0,5–2, begrenzt auf 15 min bis 7 Tage (`jobs.rs:419-423`). Suchen laufen wöchentlich, Discovery täglich, Driffle alle 4,5 h.
- **Retry:** Netzwerkfehler und 429/503 werden nach 2, 10 und 60 min wiederholt, danach im Intervall. Retry-After pausiert den Shop für 60 s bis 7 Tage, ein 403 für 1 h. Parse-Fehler und 404 warten ein volles Intervall (`jobs.rs:377-406`). Die Timeouts liegen bei 5 s Connect, 15 s gesamt und höchstens 20 s Crawl-Delay, deutlich unter dem Lease.
- **Lücken:** Dauerhafte Fehler werden nicht eskaliert (FUNC-13). Die Abbildung der HTTP-Statuscodes ist ungetestet (FUNC-07). Die Frischegrenze von 24 h passt nicht zu Intervallen über 12–24 h (FUNC-05). Die Score- und Tempo-Logik selbst bewertet der SCORE-Bericht.

## 7. Datenqualität und Matching

**Regeln:**

- **Automatische Bestätigung** (`offers.rs:68-84`): gleicher Titelschlüssel aus Katalogname, „X standard edition“ oder „X standard“, `key_game` und exakt die Plattform des Wunsches.
- **„Bestätigbar“** (`offers.rs:88-93`): zusätzlich IGDB-Aliase. Ein 360- oder Original-Xbox-Wunsch akzeptiert auch One-Keys.
- **`key_game`:**
  - Eneba: Typ GAME, DRM xbox, digital, kein `linkedProduct`, Slug ohne account/konto/dlc/upgrade/gift (`eneba.rs:34-41`).
  - Driffle: `productTypes == ["game"]`, Slug- und Titelwörter (`driffle.rs:45-55`).
- **Fingerabdruck:** Produkt-ID, Keytyp und Plattformen, ohne Titel (`shops/mod.rs:183-186`).
- **Aktivierung:** nur aus strukturierten Länderlisten; eine Sperre hat Vorrang (`shops/mod.rs:171-179`).

**Reproduzierbare Proben** (Rust-Testmodul in einer Scratch-Kopie mit realistischen Titeln, Ausgabe `evidence/functional/matching-probes.txt`, Quelltext `matching-probes.rs.txt`):

| Fall | `matches` (von Hand) | `auto_matches` | Bewertung |
|---|---|---|---|
| A Wunsch „Doom“ (1993, Xbox One) ↔ Key „DOOM“ (2016) | ja | **ja** | **Fehlzuordnung, automatisch** (FUNC-01) |
| B Original-Xbox-Wunsch „Star Wars: Battlefront II“ (2005) ↔ One-Key (2017) | **ja** | nein | Fehlzuordnung wird als „Vorschlag prüfen“ angeboten (FUNC-01) |
| L 360-Wunsch „Fable II“ ↔ One-Key gleichen Titels | ja | nein | gewollt (0.8.2) |
| D Basisspiel ↔ „… standard edition“ | ja | ja | korrekt |
| E Basisspiel ↔ „… premium edition“ | nein | nein | korrekt (Standard ≠ Premium) |
| F/G Edition ↔ gleiche Edition / „… premium“ ohne „edition“ | ja / nein | ja / nein | korrekt / falsch-negativ |
| I Basisspiel ↔ GOTY · J „Deluxe“ ↔ „Digital Deluxe“ · K Remaster ↔ Original | nein | nein | korrekt / J falsch-negativ |
| C Series-X\|S-Wunsch ↔ Key nur „Xbox One“ | nein | nein | falsch-negativ, obwohl abwärtskompatibel (FUNC-14) |
| H IGDB-Alias „Halo MCC“ | ja | nein | nur von Hand, vertretbar |
| M manueller Titel | ja | nein | korrekt (nie automatisch) |

| Eneba-Name (Parser) | Titel | Folge |
|---|---|---|
| `Forza Horizon 5 (Xbox Series X\|S) XBOX LIVE Key EUROPE` | „forza horizon 5“ | korrekt |
| `… (Xbox Series X\|S/PC) XBOX LIVE Key TURKEY` | „forza horizon 5 xbox series x s“ | falsch-negativ |
| `Forza Horizon 4 Standard Edition (Xbox One/Windows 10) …` | „… standard edition xbox one windows 10“ | falsch-negativ |
| `STAR WARS Battlefront II (2017) XBOX LIVE Key EUROPE` | „star wars battlefront ii 2017“ | Ein Jahr im Namen verhindert zufällig die Fehlzuordnung |
| `… Xbox Live Account` / `… Xbox Series X\|S Key GLOBAL` | „“ | `key_game=false`, also sicher |

**Prüfung der geforderten Unterscheidungen:**

| Unterscheidung | Ergebnis |
|---|---|
| Standard vs. Premium | korrekt |
| Xbox- vs. PC-Key | korrekt: reiner PC-Key hat keine Plattform-ID |
| Vollspiel vs. DLC | korrekt: Typ und Slug |
| Aktivierungscode vs. Konto | automatisch korrekt, von Hand **nicht** (FUNC-04) |
| EU-Key vs. regional gesperrter Key | korrekt über Länderliste; das Regionslabel zählt nicht |

**Bundles:** IGDB-„Bundle“ ohne `version_parent` ist nicht wählbar (`provider.rs:491-503`). Ob wichtige Sammlungen wie die Halo MCC davon betroffen sind, ist offline **nicht verifiziert**.

**Datenquellen:**

| Quelle | Zugriff | Verlässlichkeit | Dokumentation der erlaubten Nutzung |
|---|---|---|---|
| IGDB | offizielle API, OAuth über Twitch, 350 ms Abstand, Retry-After | hoch; Klassifizierung (`game_type`, Aliase) teils lückenhaft | allgemein („Provider-/Bild-/Cachebedingungen beachten“, `data-sources.md:13`), ohne Verweis auf die Twitch-/IGDB-Nutzungsbedingungen und Attributionspflicht |
| Eneba | HTML-Produktseiten (`__APOLLO_STATE__`), Suchseite (`__ALGOLIA_STATE__`), Sitemap; robots.txt mit Crawl-Delay | mittel: interne Seitenstruktur, Verkäufer unbekannt, Gebühren nur geschätzt | nur robots.txt; Nutzungsbedingungen nicht geprüft oder dokumentiert (FUNC-09) |
| Driffle | `__NEXT_DATA__` plus JSON-LD mit Kreuzprüfung von Preis, Verkäufer und ID; Sitemaps | mittel bis hoch (doppelte Prüfung), aber ebenfalls interne Struktur | wie Eneba |
| Microsoft | `displaycatalog.mp.microsoft.com/v7.0` (`catalog/contents.rs:58`) | undokumentierte interne API, kann ohne Ankündigung brechen; Fehler werden als „unbekannt“ gezeigt | als „öffentlicher Katalog“ bezeichnet (`data-sources.md:49`), ohne Nutzungsgrundlage |

Die Shop-Fixtures sind seit 0.9.1 synthetisch („scanner-safe“). Die Parser-Tests prüfen damit das Verhalten gegenüber einer nachgebauten Struktur, nicht gegenüber dem aktuellen Live-Markup. Das ist **nicht verifiziert**: Live-Anfragen waren nicht erlaubt.

## 8. Befunde

Prioritäten: P0 Release-Blocker, P1 muss vor 1.0, P2 sollte vor 1.0, P3 später. Aufwand in Stunden.

### FUNC-01 – Titel-only-Identität: gleichnamige Spiele werden zugeordnet (P2, Datenqualität)
- **Beschreibung:** Die automatische Bestätigung vergleicht nur den normalisierten Titel, die Plattform und den Keytyp. Erscheinungsjahr, IGDB-ID und Mehrdeutigkeit spielen keine Rolle. Gleichnamige Neuauflagen werden deshalb automatisch zugeordnet. Über die 360- und Original-Xbox-Regel werden außerdem neue Spiele alten Wünschen als „Vorschlag prüfen“ angeboten.
- **Nachweis:** Proben A und B in `matching-probes.txt`.
- **Dateien:** `backend/src/offers.rs:47-93`, `backend/src/jobs.rs:819-839`.
- **Ursache:** Der Abgleichschlüssel ist `title_key` (`shops/mod.rs:231-238`). Die Shops liefern keine Store-ID.
- **Auswirkung:** Preise und Alarme eines anderen Spiels landen beim Wunsch, und das bleibt still, weil die Bestätigung automatisch erfolgt.
- **Verbesserung:** Die automatische Bestätigung nur zulassen, wenn der Titelschlüssel im Katalog-Cache auf der Plattform eindeutig ist (Vergleich der `catalog_game`-Einträge mit gleichem Schlüssel). Steht im Shopnamen eine Jahreszahl, muss sie zum Erscheinungsjahr passen. Für 360- und Original-Xbox-Wünsche im Prüfdialog „anderes Erscheinungsjahr möglich“ anzeigen.
- **Aufwand:** 3–6 h. **Risiko:** mittel (mehr Handbestätigungen). **Ziel:** 1.0.

### FUNC-02 – EU-Zielland außer DE: Trend und Zielland-Verlauf bleiben leer (P2, Datenfluss)
- **Nachweis:** `api-probes.txt` §4.
  - Zielland AT, Produkt in DE und AT aktivierbar: `best_base` 2399 ist `eligible`, aber `trend` enthält 14 × `null` und der Zielland-Verlauf hat 0 Punkte.
  - Zurück auf DE: 14 Werte und 16 Punkte.
- **Dateien:** `price_badges.rs:179-199` (`p.market=?2`), `offers.rs:390` (`market == target`), `jobs.rs:636-639` (Beobachtung speichert `activation(market)`).
- **Ursache:** 0.9.0 hat die EU-Regel `same_market` nur in `pricing::evaluate` eingeführt. Verlauf und Trend vergleichen weiterhin den exakten Markt, und die Shops werden aus DE gelesen.
- **Auswirkung:** Die Funktion „EU-Zielländer“ ist für alle Länder außer DE nur halb nutzbar: Sparkline, Zielland-Verlauf, „Tiefstwert 90 Tage“ und Preis-Visier bleiben leer.
- **Verbesserung:** In beiden Abfragen den Markt über `same_market` (bzw. die EU-Liste) zulassen. Die Aktivierung für das Ziel aus der aktuellen Länderliste des Links ableiten, die per Fingerabdruck an dieselbe Produktidentität gebunden ist. Dazu einen Regressionstest mit AT.
- **Aufwand:** 3–5 h. **Risiko:** mittel. **Ziel:** 1.0.

### FUNC-03 – Veraltete oder fehlerhafte Preise wirken im Angebote-Tab wie aktuelle (P2, UI-Datenqualität)
- **Nachweis:** `offers-injected-1366.png`.
  - Bei „Abruffehler“ stehen 15,00 € mit orange hervorgehobener Ersparnis „−7,22 €“ gegenüber DE, und der Warenkorb-Knopf ist aktiv. Die Spalte „Gesehen“ zeigt „vor 3 Min.“.
  - „veraltet“ zeigt 19,99 € mit „−2,23 €“.
- **Dateien:** `frontend/src/features/Offers.tsx:76-93`. `offers-model.ts:76` kennt den Zustand (`current`), nutzt ihn aber nur für die Zusammenfassung.
- **Auswirkung:** Die Nutzerin hält einen ungeprüften alten Preis für ein günstigeres aktuelles Angebot und legt ihn in den Warenkorb.
- **Verbesserung:** Für `!row.current` den Preis abgeschwächt anzeigen, die Differenz als „–“, keinen Warenkorb-Knopf, und bei `source_error` „zuletzt bekannt“ statt der Beobachtungszeit.
- **Aufwand:** 1–3 h. **Risiko:** gering. **Ziel:** 1.0.

### FUNC-04 – Manuelle Bestätigung übergeht Keytyp und Plattform (P2, Datenqualität)
- **Nachweis:** `api-probes.txt` §8. Ein Konto-Angebot (`key_game=false`) wird mit `manual:true` bestätigt und ist danach `eligible`, bester DE-Preis und Badge mit 3,00 €. Ein reines PC-Produkt lässt sich ebenso bestätigen.
- **Dateien:** `offers.rs:570-586`, `offers.rs:410-411` (die Produktansicht enthält weder `key_game` noch `platform_ids`), `frontend/src/features/LinkReview.tsx:58-60` (der Hinweis nennt nur „Titel, Edition oder Plattform“).
- **Auswirkung:** Genau die geforderte Trennung zwischen Aktivierungscode und Konto-Verkauf hängt allein am Blick der Nutzerin auf die Shopseite. Den Grund der Abweichung zeigt KeyHunter nicht.
- **Verbesserung:** Die konkreten Abweichungsgründe ausgeben (`title`, `platform`, `key_type`). Für `key_game=false` die Handbestätigung sperren oder eine zweite, ausdrückliche Warnung verlangen.
- **Aufwand:** 2–4 h. **Risiko:** gering. **Ziel:** 1.0.

### FUNC-05 – Frischegrenze 24 h gegen Abrufintervalle bis 7 Tage (P2, Zuverlässigkeit)
- **Beschreibung:** Die Oberfläche bietet Intervalle von 24, 48, 72 und 168 h an (`frontend/src/features/settings/format.ts:9`). Das Tempo verdoppelt teure oder ausverkaufte Produkte, die Vorschau verdoppelt erneut (`jobs.rs:419-423`). `FRESH` liegt fest bei 24 h (`pricing.rs:18`).
- **Folge:** Ab 12 h Intervall werden teure Regionen, ab 24 h alle Preise planmäßig „veraltet“, und Vorschauen werden das schon beim Standard von 8 h zeitweise (8 × 2 × 2 = 32 h). Danach gibt es keinen aktuellen Preis, kein `world`, keinen Bestpreis und die Badges zeigen „zuletzt bekannt“. Alarme lösen weiter direkt nach einer Messung aus. Einen Hinweis in den Einstellungen gibt es nicht.
- **Verbesserung:** Die Frische an das effektive Intervall koppeln, etwa `max(24 h, 1,25 × check_every)`. Alternativ Intervalle über 12 h mit Hinweis versehen oder entfernen. Mit dem SCORE-Bericht abstimmen.
- **Aufwand:** 2–4 h. **Risiko:** mittel. **Ziel:** 1.0.

### FUNC-06 – Preisoberfläche nur gegen Mocks getestet, kein Backend-Frontend-Contract (P2, QA)
- **Nachweis:** 22 von 26 E2E-Specs und die Visual-Spec setzen `page.route`-Mocks für `offers`, `price-badges`, `cart`, `alerts` und `status`. Die Fixture-Saat `KEYHUNTER_FIXTURE_PRICES` (`catalog_fixture.rs:165-263`) nutzt kein Skript und kein Test. FUNC-02 und FUNC-03 wären mit echten Backend-Daten aufgefallen.
- **Verbesserung:** Eine E2E-Spec mit `KEYHUNTER_FIXTURE_PRICES=1`, wobei die Saat um die Fälle aus §4 und ein EU-Ziel erweitert wird. Assertions auf gerenderte Werte, nicht auf JSON. Optional eine JSON-Schema-Momentaufnahme der API-Antworten in `tests/api.rs`.
- **Aufwand:** 4–8 h. **Risiko:** gering. **Ziel:** 1.0.

### FUNC-07 – HTTP-Fehlerklassifizierung der Shop-Abrufe ungetestet (P2, QA und Zuverlässigkeit)
- **Beschreibung:** `shops/http.rs:134-190` bildet 429/503 mit Retry-After (Sekunden oder HTTP-Datum), 401/403/3xx, 404, sonstige Codes, Body-Limit und Timeout auf `ShopError` ab. Dafür gibt es keinen Test. Lokal ist der Pfad auch nicht prüfbar, weil `Session::open` öffentliche IP-Adressen erzwingt. Von dieser Abbildung hängen die Retry-Leiter und die Shop-Pausen ab (§6).
- **Verbesserung:** Eine reine Funktion `classify(status, headers)` herauslösen und mit einer Tabelle testen, Body-Limit und Präfixmodus über einen injizierbaren Client.
- **Aufwand:** 2–3 h. **Risiko:** gering. **Ziel:** 1.0.

### FUNC-08 – Dokumentation widerspricht dem Verhalten (P2, Doku)
- **Nachweise:**
  - `docs/data-sources.md:41` sagt „Varianten, die im Zielland nicht zählen können, werden dreimal seltener … abgefragt“. Tatsächlich werden seit 0.6.5 alle Regionen gleich behandelt, mit Tempo 0,5–2 (`jobs.rs:17-19`).
  - `docs/data-sources.md:59` spricht von „100 Wunschlistenplätzen“. Seit 0.9.0 gibt es keine Obergrenze.
  - `docs/operations.md:43` sagt, das Budget gehe an „Preise aktiver Wünsche, die im Zielland gelten können“. Klasse 1 umfasst aber jede Region (`jobs.rs:9`).
- **Verbesserung:** Die Abschnitte aktualisieren und nach Releases geordnete Altlasten zusammenfassen.
- **Aufwand:** 2–3 h. **Risiko:** keines. **Ziel:** 1.0.

### FUNC-09 – Erlaubte Nutzung der Datenquellen nicht dokumentiert (P2, Datenquellen)
- **Beschreibung:** Für Eneba und Driffle ist nur die Beachtung von robots.txt belegt. Eine Bewertung der Nutzungsbedingungen fehlt. Die Microsoft-Schnittstelle ist undokumentiert, und für IGDB fehlen die konkreten Bedingungen (Twitch Developer Agreement, Attribution).
- **Nachweis:** `docs/data-sources.md:3-27, 49`.
- **Auswirkung:** Für einen öffentlichen GitHub-Release ist unklar, auf welcher Grundlage gelesen wird.
- **Verbesserung:** Je Quelle festhalten: Rechtsgrundlage bzw. Nutzungsbedingungen (Stand, Link), Kennung, Limits, was gespeichert wird, Attribution. Dazu der Hinweis „für private Nutzung“.
- **Nicht verifiziert:** Inhalt der aktuellen Nutzungsbedingungen (keine Live-Abrufe erlaubt).
- **Aufwand:** 2–4 h. **Risiko:** keines. **Ziel:** 1.0.

### FUNC-10 – Verlauf rechnet mit Rohwerten statt gültigen Preisen (P3, Datenfluss)
- **Beschreibung:** `offers.rs:378-397` nimmt das Minimum **aller** Angebote einer Beobachtung. Das Legacy-Feld `history` liefert dadurch 0, −500 und 10.000.001. Eine Beobachtung [0, 2222] wird zur Lücke im Verlauf.
- **Nachweis:** `api-probes.txt` §3. Mit einer echt migrierten 0.5-Datenbank (§7) zeigt der Verlauf `None` bei `valid_cents` 2799 bzw. 2499.
- **Einordnung:** Praktisch abgefangen, weil alle Parser seit 0.2.0 nur 1–10 Mio. Cent speichern.
- **Verbesserung:** Mit `pricing::valid_cents` filtern und das Feld `history` entfernen; das Frontend nutzt `histories`.
- **Aufwand:** 0,5–1 h. **Risiko:** gering. **Ziel:** 1.1.

### FUNC-11 – Angebotszähler der Liste und des Detail-Tabs widersprechen sich (P3)
- **Beschreibung:** `wishlist.rs:38` (`offer_count`) zählt alle Angebote bestätigter Links, auch veraltete, fehlerhafte und ungültige. Der Tab zählt Zeilen mit Preis.
- **Nachweis:** Probe: Liste „10 Angebote“, Tab „Angebote 6“ (`wishlist-injected-1366.png`).
- **Aufwand:** 0,5–1 h. **Ziel:** 1.1.

### FUNC-12 – „nicht in DE gültig“ bei fehlendem gültigen Preis (P3, UI-Text)
- **Beschreibung:** In `offers-model.ts:53-57` fehlt ein Label für `no_price` (ebenso für `mismatch`). Die Gültigkeitspille fällt deshalb auf „nicht in DE gültig“ zurück.
- **Verbesserung:** Label „Kein gültiger Preis“ ergänzen.
- **Aufwand:** 0,5 h. **Ziel:** 1.1.

### FUNC-13 – Dauerhafte Fehler werden nicht eskaliert (P3, Zuverlässigkeit)
- **Beschreibung:** Bei einem Parserbruch (`invalid_response`) läuft jeder Produktjob weiter und schreibt je Lauf einen Fehler ins Log (`jobs.rs:709`, `record` statt `record_once`). Das sind bis zu Budget-Anzahl Einträge pro Tag und Shop. Ein ausgelistetes Produkt (404) wird unbegrenzt im Intervall weiter abgefragt.
- **Verbesserung:** Nach N aufeinanderfolgenden Parse-Fehlern über verschiedene Links den Shop pausieren und einmal melden („Shopseite geändert, Reader-Update nötig“). Links nach K-mal 404 ruhen lassen.
- **Aufwand:** 3–5 h. **Risiko:** mittel. **Ziel:** 1.1.

### FUNC-14 – Falsch-negative Zuordnung bei Namensvarianten (P3, Datenqualität)
- **Beschreibung:**
  - Plattformangaben in Klammern verhindern jede Zuordnung („(Xbox One)“, „(Xbox Series X|S/PC)“, „(Xbox One/Windows 10)“; `eneba.rs:187-204`).
  - Ein Series-X|S-Wunsch akzeptiert keinen reinen One-Key (Probe C).
- **Nachweis:** Proben C, G und J sowie die Eneba-Namensproben.
- **Auswirkung:** Günstigere Angebote fehlen, entgegen dem Kernanwendungsfall. Abhilfe ist nur per Link von Hand möglich.
- **Nicht verifiziert:** wie häufig diese Namensformen live vorkommen.
- **Verbesserung:** Bekannte Plattform-Klammern vor dem Suffix entfernen. One-Keys für Series-Wünsche nur von Hand zulassen, analog zur 0.8.2-Regel.
- **Aufwand:** 2–4 h. **Risiko:** mittel. **Ziel:** 1.1.

### FUNC-15 – Extractor-Fehler ohne einheitliches Fehlerformat (P3, API)
- **Beschreibung:** Bei falschem Typ, ungültigem JSON und Body über 16 KiB antwortet die API mit `text/plain` auf Englisch und ohne `code` (`api-probes.txt` §2). Das Frontend fällt auf „Die Anfrage konnte nicht abgeschlossen werden.“ zurück.
- **Verbesserung:** Ein eigener `JsonRejection`-Handler, der `ApiError` erzeugt.
- **Aufwand:** 1–2 h. **Ziel:** 1.1.

## 9. QA-Kapitel

**Testpyramide (Ist):**

| Ebene | Umfang | Qualität |
|---|---|---|
| Rust-Unit | 119 Tests | echte Entscheidungstabellen (Pricing, Retry-Leiter, Tempo), Parser-Goldtests mit Variantenmutation (55), Migrationen mit Altdaten (6), Job-Engine über Claim und Complete mit synthetischen Ergebnissen (43 Aufrufstellen) |
| Rust-Integration | 54 Tests (In-Process-Router und SQLite) | Auth, CSRF, Origin, Persistenz, Limits, Kaskaden; rund 490 Assertions |
| Frontend-Unit | 71 Tests | Modelle (Sortierung, Spalten, Badges, Warenkorb), 331 Assertions |
| E2E | 73 Tests | stabil, mit vielen Interaktionen, aber 22/26 Specs mit Daten-Mocks |
| Visual | 22 Tests, 24 Baselines | fest gepinntes Image; nur gemockte Daten |
| Accessibility | – | nicht automatisiert; nur einzelne Tastatur- und ARIA-Prüfungen in E2E |

Es gibt kaum Smoke-Tests: Fast alle Tests prüfen konkrete Werte. Die Struktur ist eher eine Raute als eine Pyramide, und die Lücke liegt in der Mitte: Contract und HTTP-Schicht.

**Kritische Lücken (nach Wirkung):**

1. Contract zwischen Backend und Frontend für Preise (FUNC-06)
2. EU-Zielland in Verlauf und Trend (FUNC-02)
3. Mehrdeutige Titel beim Matching (FUNC-01)
4. HTTP-Klassifizierung (FUNC-07)
5. Live-Aktualität der Parser-Fixtures: kein Kanarienlauf vor dem Release
6. Export ohne Test
7. Keine automatische Accessibility-Prüfung

**Vorgeschlagene neue Tests** (alle mit reproduzierbaren Mock-Daten, ohne Netz):

| Test | Ebene | Mock-Daten und Erwartung |
|---|---|---|
| `ambiguous_titles_are_never_auto_confirmed` | RU `jobs`/`offers` | zwei `catalog_game` „Doom“ (1993/2016, Plattform 49) und Produkt „doom“ [49] → `review` bleibt `pending` |
| `manual_confirmation_refuses_non_key_products` | RI | Link mit `key_game=false`, `PUT … manual:true` → 409 bzw. `reasons` enthält den Keytyp |
| `eu_target_history_and_trend_follow_same_market` | RI | Beobachtungen `market=DE`, Produkt erlaubt AT; Ziel AT → `trend` ≠ alles `null`, `histories.preferred` nicht leer |
| `history_ignores_invalid_quotes` | RU `offers`/`history` | Beobachtung `[0,2222]` → Punkt 2222 |
| `freshness_covers_the_effective_interval` | RU `pricing` | Intervall 48 h, Tempo 1, Alter 30 h → nach Neuregelung nicht `stale` |
| `shop_http_status_classification` | RU `shops::http` | Tabelle 200/301/401/403/404/429 (Sek. und Datum)/500/503 → `ShopError`; Retry-After auf 60 s bis 7 Tage begrenzt |
| `eneba_title_strips_platform_parentheses` | RU `eneba` | Namen aus §7 → Titel ohne Plattformteil |
| `offers_ui_with_real_backend_data` | E2E | Fixture mit erweitertem Seed (§4) → keine Ersparnis und kein Warenkorb bei veralteten Zeilen, kein „0,00 €“, AT-Trend sichtbar |
| `wishlist_export_contains_all_wishes` | E2E | Download abfangen und JSON-Felder prüfen |
| `upgrade_from_oldest_supported_schema` | RI | Schema 10 mit Altdaten aus Migrationsschritten (wie `migration_tests`) → Fingerabdruck v2, `valid_cents`, Zustände |
| Parser-Kanarienlauf | manuell vor dem Release | ein dokumentierter, gedrosselter Live-Abruf je Shop mit Diff gegen die Fixture-Struktur (außerhalb CI) |

## 10. Vorgeschlagene Release-1.0-Kriterien

| ID | Bereich | Kriterium (objektiv prüfbar) | Status |
|---|---|---|---|
| K01 | Funktion | Backend-, Frontend-Unit-, E2E- und Visual-Suiten grün auf dem Release-Commit | **bestanden** (173 / 71 / 73 / 22) |
| K02 | Funktion | E2E zweimal ohne Retries ohne Fehlschlag | **bestanden** |
| K03 | Funktion | Kernpfad Suche → Vormerken → Angebot → Alarm → Kauf → Bibliothek über die API fehlerfrei | **bestanden** (Fixture; echter Shop-Abruf nicht testbar) |
| K04 | Fehlerbehandlung | Kein Null-, Negativ- oder Fehlerpreis in Badge, Preis, Angeboten, Warenkorb oder Alarm | **bestanden** |
| K05 | Fehlerbehandlung | Veraltete, fehlerhafte, geschätzte und unbekannte Angaben in jeder Preisansicht eindeutig gekennzeichnet und nicht als Ersparnis oder Aktion angeboten | **fehlgeschlagen** (FUNC-03, FUNC-12) |
| K06 | Fehlerbehandlung | Katalog- oder Shop-Ausfall wird nie als leeres Ergebnis gezeigt | **bestanden** (Katalog per API, Shop auf Unit-Ebene) |
| K07 | Fehlerbehandlung | HTTP-Fehlerklassen und Retry-After per Test abgesichert | **nicht getestet** (FUNC-07) |
| K08 | Datenkonsistenz | Automatische Zuordnung nur bei eindeutiger Identität, keine bekannte Fehlzuordnungsklasse | **fehlgeschlagen** (FUNC-01) |
| K09 | Datenkonsistenz | Nicht-Key-Produkte können nicht als Key-Preis zählen | **fehlgeschlagen** (FUNC-04) |
| K10 | Datenkonsistenz | Preis, Trend und Verlauf folgen derselben Zielland-Regel (auch EU) | **fehlgeschlagen** (FUNC-02) |
| K11 | Datenkonsistenz | Persistenz aller Nutzerdaten über einen Neustart | **bestanden** |
| K12 | Datenkonsistenz | Höchstens ein aktiver Job pro Shop, Wiederaufnahme nach Neustart ohne Burst | **bestanden** (Unit/DB und Code; Container-Neustart mit Worker nicht getestet) |
| K13 | Updatefähigkeit | Upgrade vom ältesten unterstützten Stand (0.5.0) ohne Datenverlust mit automatischer Sicherung | **bestanden** |
| K14 | Backup/Recovery | Rückweg mit Vor-Migrations-Sicherung und Vorgänger-Image | **bestanden** |
| K15 | Backup/Recovery | Dokumentiertes Kaltbackup (Container stoppen, Verzeichnis kopieren) praktisch wiederhergestellt | **nicht getestet** |
| K16 | Doku | Betriebs- und Datenquellen-Doku entspricht dem Verhalten | **fehlgeschlagen** (FUNC-08) |
| K17 | Doku | Erlaubte Nutzung je Datenquelle dokumentiert | **fehlgeschlagen** (FUNC-09) |
| K18 | Funktion | Parser gegen aktuelles Live-Markup geprüft (Kanarienlauf) | **nicht getestet** (Live-Anfragen untersagt) |
| K19 | Security | Keine offenen SEC-Befunde P0/P1; CSRF-Ablehnung ohne Token | **nicht getestet** durch FUNC (CSRF-Probe 403 bestanden; Status aus SEC-Bericht) |
| K20 | Responsive | Kernansichten 375–2560 px ohne horizontalen Overflow | **nicht getestet** durch FUNC (RESP-Bericht) |
| K21 | Accessibility | Automatisierter a11y-Scan der Kernansichten ohne kritische Verstöße | **nicht getestet** (kein Werkzeug im Repo) |
| K22 | Performance | Wunschliste mit ≥ 100 Einträgen inklusive Badges schnell; Badge-Abfragen unabhängig von der Anzahl | **nicht getestet** durch FUNC (vorhandene RI-Tests mit 100 Einträgen grün; Messung im PERF-Bericht) |
| K23 | Deployment | CI `checks.yml` inklusive `fmt`, `clippy -D warnings` und `npm audit` grün auf dem Release-Tag | **nicht getestet** (`deploy/check.sh` durfte nicht laufen) |

## 11. Geprüfte Befehle und Grenzen

**Ausgeführt:**

- `docker run … keyhunter-build-tools:local cargo test --locked` mit `CARGO_TARGET_DIR=work/check/target-func`: 173/173.
- `npm test`: 71/71.
- `KEYHUNTER_TEST_PORT=38781 sh deploy/browser-check.sh --reporter=line`: 73/73. Zweiter Lauf mit den 26 Repo-Specs: 73/73.
- `KEYHUNTER_TEST_PORT=38791 sh deploy/visual-check.sh`: 22/22, Baselines unverändert.
- Eigene Fixture auf 38781 mit `KEYHUNTER_FIXTURE_PRICES=1`: rund 70 API-Proben per curl mit Origin und CSRF, synthetische `offer_link`-Injektion per Python/SQLite in das lokale Fixture-Verzeichnis, Neustart-Persistenz.
- Playwright-Proben in `frontend/e2e/tmp-audit-func/` (5/5, danach gelöscht).
- Rust-Matching-Proben in einer Scratch-Kopie (`cargo test --lib audit_probe`).
- Offline-Upgrade und -Restore mit `keyhunter:0.5.0` (`--network none`) und der 0.9.1-Fixture.

**Grenzen:**

- **Keine Live-Abrufe:** Echte Shop- und IGDB-Antworten, unscharfe Suche, aktuelle Seitenstruktur, tatsächliche Gebühren, Linkgültigkeit und Nutzungsbedingungen sind **nicht verifiziert**.
- Die Fixture startet keine Hintergrundjobs (`run_background=false`). Scheduling, Leases, Retry und Neustart-Wiederaufnahme sind nur durch Code-Analyse und die vorhandenen DB-Tests belegt.
- Ein Container-Neustart des Produktionsimages mit laufenden Workern wurde nicht durchgeführt, da das Netz gesperrt sein musste.
- Benachrichtigungskanäle wurden nur per Code und Unit-Tests betrachtet (Tiefe: SEC).
- `deploy/check.sh` (fmt, clippy, `npm ci`, Build) wurde gemäß Vorgabe nicht ausgeführt.
- Die Daten in `work/phase_b_database` und `work/local` wurden nicht verwendet.
- Temporäre Daten unter `work/check/browser.func*`, `upgrade.func*` und `restore.func*` wurden nach dem Audit entfernt.
