# KeyHunter 0.9.1 – Code- und Architektur-Audit vor Release 1.0

Rolle: Principal Engineer / Software Architect (Kürzel `code`, Befundpräfix CODE) · Stand: Branch `audit/release-1.0` = Tag 0.9.1 (Commit 490a8fb) · Datum: 2026-11-22
Umfang: SPEC Abschnitt 3 – Backend (`backend/src`, `backend/tests`, `backend/examples`, Migrationen), Frontend (`frontend/src`, `frontend/tests`, Struktur von `frontend/e2e`), Build/CI, Doku gegen Code.
Abgrenzung: Die Mathematik des Scorings (`jobs.rs`) bewertet `11_SCORING_ALGORITHM_AUDIT.md`; Sicherheit (SEC) und Laufzeitmessungen (PERF) haben eigene Berichte. Hier nur strukturelle Querverweise.
Rohdaten: `docs/release-1.0-audit/evidence/code/` (gekürzt, reproduzierbar, Skripte unter `scripts/`).

---

## 1 Ergebnis in Kürze

Die Codebasis ist **für 1.0 ausreichend wartbar, ein Rewrite ist nicht gerechtfertigt**. Das Backend ist sauber: Standard-Clippy mit `-D warnings` und `rustfmt` laufen fehlerfrei, `unwrap`/`expect` gibt es nur bei festen Konstanten und Invarianten, und 173 Backend-Tests sowie 71 Unit-Tests im Frontend laufen grün. Die Architektur ist dem Zweck angemessen: ein Prozess, SQLite, eine persistente Job-Warteschlange mit Leases und eine Sicherung vor Migrationen. Es gibt keine überflüssigen Bibliotheken.

Die Schulden liegen woanders. Dieselben Fachregeln stehen an mehreren Stellen, vor allem als SQL-Fragmente: Ob ein Abruf „wartet“, entscheiden sechs Stellen (der Scheduler und fünf Kopien für die Anzeige) mit jeweils leicht anderen Bedingungen. Daraus folgt ein **bestätigter Fehler**: Ein pausierter Wunsch erscheint als „wartet/wird gesucht“, und die Seiten pollen dann alle 3 s (CODE-01). Dazu kommen ein unformatiertes, sehr dichtes Frontend ohne Linter, Frontend-Zustand in zwei „God Components“, uneinheitliche API-Fehlerformen, toter Code aus früheren Releases und teilweise veraltete Doku.

| Kategorie | Bewertung | Begründung (Belege in Abschnitt 2–4) |
|---|---|---|
| Codequalität | **6/10** | Backend lint-sauber und gut getestet. Abzüge: das Frontend ist unformatiert und ohne Lint (380 Zeilen über 160 Zeichen), Fachregeln sind doppelt implementiert, was einen bestätigten Fehler verursacht, dazu toter Code und uneinheitliche Fehlerformen. |
| Architektur | **7/10** | Einfache, robuste Grundstruktur ohne Overengineering. Abzüge: Scheduler-Regeln sind in Anzeige-SQL kopiert, zwei Module mischen viele Aufgaben, der Frontend-Zustand sitzt zentral in `Wishlist.tsx`/`App.tsx` und die Navigation ist selbst gebaut (synthetisches `popstate`). |
| Wartbarkeit | **6/10** | Gutes Testnetz und erklärende Kommentare. Abzüge: Dichte und Größe einzelner Dateien, 194 Versionsvermerke in Kommentaren, E2E-Specs nach Release statt nach Funktion sortiert, Tests nicht typgeprüft, Doku teils veraltet. |

**Die drei wichtigsten Erkenntnisse**
1. **Duplizierte Scheduler-Regeln laufen auseinander** (CODE-01, bestätigt per SQL-Reproduktion und echter API). Der Scheduler überspringt pausierte Wünsche, Badge und Angebots-Tab melden sie aber als `pending`/`queued`. Das ist ein Architekturmuster, kein Einzelfehler.
2. **Für das Frontend gibt es weder Formatierung noch Lint- oder Typprüfung der Tests** (CODE-04, CODE-13). Das ist die günstigste Stellschraube für die Wartbarkeit. Sie sollte als erster Schritt vor allen weiteren 1.0-Änderungen kommen.
3. **Altlasten lassen sich klar von Kompatibilität trennen** (CODE-05, CODE-06, Abschnitt 6). Toter Code sind: eine wirkungslose Einstellung, drei Endpunkte ohne Aufrufer im Frontend, ein mitgeschleppter Verlaufsdatensatz und einige UI-Reste. Bewusste und weiter nötige Kompatibilität sind: das Fingerprint-Upgrade aus 0.5, die alte `ntfy.env` und gespeicherte Sortierformate.

**Empfehlung vor 1.0 (P2, ca. 17–31 h):** CODE-04 (zuerst, als eigener Commit), CODE-01, CODE-02, CODE-05, CODE-08, CODE-09. Alles andere ist für 1.1 oder später.

---

## 2 Messwerte

| Messgröße | Wert | Quelle |
|---|---|---|
| Rust-Produktionscode (ohne Inline-Tests) | 9 931 Zeilen in 23 Dateien | `evidence/code/sizes.txt` |
| Rust-Tests | 5 437 Zeilen inline + 4 208 Zeilen `backend/tests` (Verhältnis Test:Code ≈ 1:1) | `sizes.txt` |
| Größte Rust-Dateien (Produktion) | `jobs.rs` 1 300 (gesamt 2 972), `notify.rs` 1 164 (2 024), `wishlist.rs` 817, `offers.rs` 698, `price_badges.rs` 582 | `sizes.txt` |
| Rust-Funktionen über 100 Zeilen (Produktion) | 8, z. B. `lib.rs:153 create_app_inner` (187), `jobs.rs:551 complete` (166), `eneba.rs:7 parse` (153), `alerts.rs:464 deliver_one` (149), `offers.rs:309 list` (145) | `clippy-pedantic.txt` |
| Frontend TS/TSX | 5 896 Zeilen, 82 Dateien, 406 KB; im Schnitt 68 Zeichen je Zeile (Rust: 37); 380 Zeilen über 160, 73 über 250, die längste 1 055 Zeichen (`CatalogSearch.tsx:122`) | `sizes.txt` |
| Größte Frontend-Dateien (Bytes) | `Wishlist.tsx` 31 KB (22 `useState`, 13 Effekte, 11 API-Aufrufe), `App.tsx` 18 KB (20 `useState`, 12 Effekte) | `sizes.txt` |
| CSS | 1 328 Zeilen in 15 Dateien (12 global in `main.tsx`, 3 in Komponenten importiert) | `main.tsx:4-15` |
| Lint Rust | `cargo fmt --check` 0, `cargo clippy -D warnings` 0; pedantic: 182 Warnungen, davon **keine** wegen `dead_code`; `#[allow]` nur 1× (`jobs.rs:550`) | `clippy-pedantic.txt` |
| `unwrap`/`expect` außerhalb von Tests | 11, alle auf konstante URLs/CSS-Selektoren oder Job-Invarianten (`jobs.rs:621,655`) | `grep`, Abschnitt 9 |
| Duplikate (jscpd, exakte Token-Klone) | Backend-Produktion ≈ 1–2 %, `tests/catalog_wishlist.rs` 24,9 %, Frontend `src` 0,25 %, E2E 3,7 % | `jscpd.txt` |
| Unbenutzte Frontend-Exporte (knip) | 17 Exporte; davon 4 Funktionen bzw. Komponenten und 1 Prop wirklich tot, der Rest nur unnötig exportiert; 3 „ungenutzte“ Abhängigkeiten sind falsch positiv | `knip-unused.txt` |
| Doppelte Crate-Versionen | `base64`, `hashbrown`, `syn` (transitiv), `tower-http` 0.6 über reqwest und 0.7 direkt; 270 Crates im Baum | `dependencies.txt` |
| Tests | Backend 173/173 bestanden, Frontend-Unit 71/71, E2E 78 Tests in 27 Specs (hier nicht ausgeführt) | `cargo-test.txt` |

---

## 3 Architektur: Ist-Stand und Bewertung

### 3.1 Backend
Ein Axum-Prozess (`lib.rs:141-345`) liefert REST unter `/api/v1` und die gebaute SPA. Je Fachbereich gibt es ein Modul mit Handlern und SQL (`wishlist`, `offers`, `cart`, `alerts`, `settings`, `eventlog`, `catalog`). Dazu kommen drei Hintergrundschleifen: ein Worker je Shop (`jobs.rs:136`), die Editionsvorbereitung (`edition_tracking.rs:137`) und die Alarm-Outbox (`alerts.rs:412`). Die Shop-Adapter (`shops/eneba.rs`, `shops/driffle.rs`) sitzen hinter einem gemeinsamen HTTP-Client mit DNS-Pinning, robots.txt und Abstand je Host (`shops/http.rs:36-112`). Der Katalog ist als Trait austauschbar (`catalog/provider.rs:73`).

*Stärken:* Nur Standard-Crates, kein ORM, kein Queue-Dienst. Werte werden konsequent gebunden; komponierte SQL besteht nur aus Konstanten (`AssertSqlSafe`, `jobs.rs:54`). Leases und Pacing liegen persistent in SQLite. Ressourcen sind begrenzt: Pool mit 4 Verbindungen, `ConcurrencyLimit` 16, Body 16 KiB, 4 Passwort-Slots, ein Trend-Cache mit Obergrenze (`price_badges.rs:131`), Aufbewahrungsfristen für Log, Läufe und Beobachtungen. Der Fehlertyp ist einheitlich (`lib.rs:57-101`, deutsche Meldung plus stabiler `code`).

*Schwächen:* Fachregeln stecken als SQL-Strings in mehreren Modulen (CODE-01, CODE-11). `jobs.rs` und `notify.rs` vereinen Worker, Persistenz, Fachlogik und HTTP-Handler (CODE-12). Jeder Handler prüft Anmeldung und CSRF selbst (CODE-03). Shop-Fähigkeiten sind implizit, etwa die Suche nur bei Eneba (`jobs.rs:522`, `jobs.rs:892`). Shops lassen sich in Tests nicht injizieren (CODE-13).

### 3.2 Frontend
React 19 ohne Router und ohne State-Bibliothek. `App.tsx` ist Shell, Seitenwahl und Navigation in einem. Die Seiten liegen unter `features/`, die UI-Primitive unter `ui/` (Barrel `ui/index.ts`) und zusätzlich in `components.tsx`. Positiv: Die Fachlogik ist in reine, unit-getestete Module ausgelagert (`*-model.ts`, `*-sort.ts`, `*-columns.ts`, 17 Testdateien). `api.ts` ist ein schlanker `fetch`-Wrapper mit Typen und `HttpError`.

*Schwächen:* `Wishlist.tsx` steuert Liste, Detailseite, Editionen, Verlauf/History-API, Warenkorb, Pause, Kauf, KPIs und drei Poll-Schleifen. `GameDetail` bekommt 29 Props. `csrf` wird an 14 Komponenten durchgereicht, `onError` an 18 (CODE-07). Die Navigation dispatcht an 4 Stellen ein synthetisches `popstate`. Bereichsübergreifende Signale laufen über `window`-Events (`CART_CHANGED`, `FETCH_STATUS_CHANGED`, `NOTIFY`). Das ist einfach und funktioniert, ist aber unsichtbar gekoppelt: Der Dispatch fehlt nirgends, wird aber auch durch nichts erzwungen. 13 localStorage-Schlüssel verteilen sich auf 4 Dateien, jeweils mit eigener try/catch-Hülle. Das Muster „Laden, Abbrechen, Pollen“ ist 10× nachgebaut.

### 3.3 Datenbank und Migrationen
27 eingebettete sqlx-Migrationen. Vor offenen Migrationen legt `lib.rs:389-440` eine Kopie per `VACUUM INTO` an (`<data>/backups`, die drei neuesten bleiben). Jede Migration läuft in einer eigenen Transaktion. Der einzige Tabellenneubau `0023_release_081.sql` folgt mit `-- no-transaction`, FK aus und eigenem `BEGIN/COMMIT` dem SQLite-Verfahren. Die Migrationstests (`lib.rs:442-822`) decken 0012, 0014, 0023, 0027 und die Sicherung ab. **Gemessen:** Die Kette 0011–0027 läuft auf einer Kopie der echten Alt-Datenbank (Schema 10) fehlerfrei durch. `foreign_key_check` liefert 0 Zeilen, `integrity_check` ist ok, die Zeilenzahlen bleiben gleich, und die Prüfsummen von 0001–0010 stimmen mit den Dateien überein (`evidence/code/migration-upgrade-check.txt`). Endschema: `evidence/code/schema-after-0027.sql`. Schwächen: siehe CODE-15.

### 3.4 Build, CI, Auslieferung
Mehrstufiges Dockerfile, Toolchains auf Digest bzw. Version festgelegt. CI führt `deploy/check.sh` (fmt, clippy, Tests, Build), `npm audit`, E2E und visuelle Tests aus. Es fehlen: Lint/Format fürs Frontend, eine Typprüfung der Tests, ein Abgleich der dreifach gepflegten Versionsnummer (CODE-16) und ein Schutz gegen nachträglich geänderte Migrationen (CODE-15).

---

## 4 Befunde

| ID | Prio | Kurztitel | Aufwand | Ziel |
|---|---|---|---|---|
| CODE-01 | P2 | Duplizierte „wartet/läuft“-Regeln: pausierte Wünsche gelten als ausstehend, 3-s-Polling | 3–6 h | 1.0 |
| CODE-02 | P2 | API-Fehlerformen uneinheitlich: Extraktor-Fehler als englischer Klartext vor der Anmeldeprüfung | 3–5 h | 1.0 |
| CODE-03 | P3 | Anmeldung/CSRF in jedem Handler einzeln, keine strukturelle Absicherung | 4–6 h | 1.1 |
| CODE-04 | P2 | Frontend ohne Formatter und Linter, extrem dichte Zeilen | 2–4 h | 1.0 |
| CODE-05 | P2 | Toter Code und veraltete Workarounds (Einstellung, Endpunkte, Felder, UI-Reste) | 3–5 h | 1.0 |
| CODE-06 | P3 | Kompatibilitätsschichten ordnen: nötige behalten, Frontend-„older server“-Pfade entfernen | 2–3 h | 1.1 |
| CODE-07 | P3 | Frontend-Zustand: God Components, Prop Drilling, selbst gebaute Navigation | 12–20 h | 1.1 |
| CODE-08 | P2 | Unnötige Netzwerk- und DB-Abfragen (Navigationszähler, doppeltes Polling, N+1) | 4–8 h | 1.0 |
| CODE-09 | P2 | Doku widerspricht dem Code (Limits, Priorisierung, Layout, Env-Werte) | 2–3 h | 1.0 |
| CODE-10 | P3 | Konfiguration teilweise am `Config` vorbei, ungültige Werte still ignoriert | 1–2 h | 1.1 |
| CODE-11 | P3 | Magic Numbers und mehrfach definierte Konstanten (900 s mit fünf Bedeutungen, Preisgrenze, Plattform-IDs) | 3–4 h | 1.1 |
| CODE-12 | P3 | Übergroße Module mit gemischter Verantwortung (`jobs.rs`, `notify.rs`, `lib.rs`) | 4–8 h | 1.1 |
| CODE-13 | P3 | Testbarkeit und Teststruktur: Tests nicht typgeprüft, E2E nach Release, Shops nicht injizierbar | 3–6 h | 1.1 |
| CODE-14 | P3 | Logging und Überwachung der Hintergrundschleifen lückenhaft | 2–3 h | 1.1 |
| CODE-15 | P3 | Migrationen: kein Schutz gegen geänderte Altmigrationen, Release-Namen, irreführender Kommentar | 1 h | 1.0 |
| CODE-16 | P3 | Versions- und Toolchain-Angaben mehrfach gepflegt, doppelte Crate-Versionen | 1 h | 1.1 |
| CODE-17 | P3 | Doppelte Hilfsfunktionen und Label-Tabellen im Frontend | 2–3 h | 1.1 |
| CODE-18 | P3 | Kommentar-Rauschen: 194 Versionsvermerke, Historie statt Verhalten | 2–3 h | 1.1 |

### CODE-01 · P2 · Architektur / Korrektheit – Duplizierte „wartet/läuft“-Regeln laufen auseinander
- **Beschreibung:** Ob ein Shop-Job ausgeführt wird, entscheidet der Scheduler mit `claimable()`/`queued()` (`jobs.rs:188-246`). Für die Anzeige stehen eigene, gekürzte Kopien dieser Regel in `offers.rs:233-243` (`links`, Feld `queued`), `offers.rs:252-257` (`links_of_items`), `offers.rs:415-416` (`discovery_running`), `offers.rs:427-430` (Suchstatus) und `price_badges.rs:259-263` (`pending`). Sie berücksichtigen weder die Pause pro Wunsch (`NOT_HELD`, `jobs.rs:199`) noch das 14-Tage-Fenster für Vorschauen (`WATCHED_IF_PREVIEW`, `jobs.rs:195`), „kein aktiver Wunsch“ (`ANY_ACTIVE_WISH`) oder konsequent `s.configured`.
- **Nachweis (bestätigt):** `evidence/code/paused-wish-predicates.txt`. (a) `scripts/predicates.py` übernimmt die SQL-Konstanten aus `jobs.rs` sowie die Anzeige-SQL aus `price_badges.rs` und `offers.rs` wörtlich aus dem Quellcode und bildet nur die `format!`-Komposition von `claimable()` nach. Ergebnis für einen pausierten Wunsch mit fälligem Job: Scheduler 0 Zeilen (nach dem Fortsetzen 1), Badge `pending=True`, Angebots-Tab `queued=True`. (b) Auf dem Fixture-Server über die echte API: vor der Pause `pending: False`; nach `PUT …/pause` und fälligem Job `pending: True` und `queued: [True]`, obwohl `paused: True`.
- **Betroffen:** `backend/src/offers.rs`, `backend/src/price_badges.rs`, `backend/src/jobs.rs`. Folgen im Frontend: `Wishlist.tsx:163-164`, `useOffersView.ts:27-28`, `WishlistRow.tsx:72`, `PriceBadge.tsx:8`, `GameDetail.tsx:77`.
- **Ursache:** Die Regel ist bei jedem neuen Feature (0.7.0 globale Pause, 0.9.0 Pause pro Wunsch) im Scheduler gewachsen, die Kopien wurden nicht mitgezogen.
- **Auswirkung:** Ein pausierter Wunsch zeigt nach Ablauf seines Intervalls dauerhaft „Wird gesucht …“ bzw. „Suche eingeplant“, solange noch kein Preis da ist. Die Wunschliste pollt `/wishlist/price-badges` alle 3 s statt alle 30 s, die Detailseite `/offers` alle 3 s statt alle 60 s – unbegrenzt, solange der Tab sichtbar ist. Das kostet keine Händleranfragen, aber lokale Last, und vor allem stimmt der angezeigte Zustand nicht.
- **Verbesserung:** Eine einzige Regel „Job ist lauffähig“ als Rust-Funktion in `jobs.rs` (z. B. `pub(crate) fn runnable(now: &str, window: &str) -> String`). Daraus setzen sich `claimable()` und alle Anzeige-Abfragen zusammen. Bewusste Unterschiede (Lease aktiv → „läuft“, Budget erschöpft → „pausiert“) bleiben als eigene, benannte Zusätze. Dazu ein Regressionstest in `tests/catalog_wishlist.rs`: pausierter Wunsch mit fälligem Job ergibt `pending=false`, `queued=false` und Suchstatus `paused`. Kein neues Datenmodell, keine Migration.
- **Aufwand / Risiko / Ziel:** 3–6 h · mittel (zentrale Abfragen, aber gut mit Tests abgedeckt) · 1.0.

### CODE-02 · P2 · Fehlerbehandlung / API-Konsistenz – Extraktor-Fehler umgehen `ApiError`
- **Beschreibung:** 41 Handler-Parameter nutzen Axums `Json`/`Query`/`Path` direkt. Deren Fehler (400/413/415/422) kommen als englischer `text/plain` ohne `code` und werden ausgewertet, bevor der Handler die Anmeldung prüft. Nur `eventlog.rs:217`, `notify.rs:1067` und `jobs.rs:1153` fangen die Rejection ab.
- **Nachweis:** `evidence/code/api-error-shapes.txt` (curl gegen den Fixture-Server). Ohne Sitzung liefert `PUT /api/v1/settings` mit `{}` den Status 422 und „missing field \`currency\`“ statt 401. `GET /catalog/games/abc` liefert 400 „Cannot parse \`abc\` to a \`i64\`“. Ein Body von 20 KB liefert 413 im Klartext.
- **Betroffen:** alle Handler-Module; `frontend/src/api.ts:121-122` zeigt dafür nur die Ersatzmeldung „Die Anfrage konnte nicht abgeschlossen werden.“
- **Ursache:** Der Fehlervertrag (`lib.rs:57-88`) wurde für die Handler definiert, aber nicht für die Extraktor-Ebene.
- **Auswirkung:** Clients (und spätere Skripte) erhalten zwei Fehlerformate. Nutzer sehen unspezifische Meldungen. Unangemeldete Clients erfahren Feldnamen (geringe Relevanz, der Code ist öffentlich).
- **Verbesserung:** Kleine Wrapper `ApiJson<T>`, `ApiQuery<T>` und `ApiPath<T>` (manuelles `FromRequest`/`FromRequestParts`, etwa 40 Zeilen in `lib.rs`), die jede Rejection auf `ApiError(400|413|415, "<deutsche Meldung>")` abbilden; Vorlage ist das vorhandene Muster in `notify.rs:1067`. Danach per Suchen und Ersetzen in den Handlern einsetzen. Dass die Anmeldung vor dem Parsen geprüft wird, liefert CODE-03.
- **Aufwand / Risiko / Ziel:** 3–5 h · gering · 1.0.

### CODE-03 · P3 · Architektur / Robustheit – Anmeldung und CSRF pro Handler
- **Beschreibung:** 45 Aufrufe von `auth::authenticate` und 26 von `auth::require_csrf` verteilen sich auf 49 Handler-Bindungen (`lib.rs:261-326`). Heute fehlt kein Aufruf. Ein neuer Handler ohne Prüfung fiele aber weder dem Compiler noch einem Test auf, denn es gibt keinen Test, der alle geschützten Routen ohne Cookie prüft (`tests/api.rs` testet einzelne).
- **Ursache:** gewachsene Handler-Struktur.
- **Auswirkung:** Risiko bei künftigen Erweiterungen; doppelter Boilerplate-Code (jscpd-Klone `cart.rs:194-201` ↔ `wishlist.rs:367-374`).
- **Verbesserung:** Den Router in einen öffentlichen Teil (`/setup`, `/session`, Health) und einen geschützten Teil mit `route_layer(middleware::from_fn_with_state(…))` aufteilen. Die Sitzung als Extraktor `Session` (Request-Extension) bereitstellen, CSRF als `CsrfSession`. Ein Test iteriert alle geschützten Pfade und erwartet 401. Nebeneffekt: 401 kommt vor Parse-Fehlern (CODE-02). Querverweis SEC.
- **Aufwand / Risiko / Ziel:** 4–6 h · mittel (berührt alle Handler, aber mechanisch) · 1.1 (zusammen mit CODE-02 auch schon für 1.0 sinnvoll).

### CODE-04 · P2 · Konventionen / Wartbarkeit – Frontend ohne Formatter und Linter
- **Beschreibung:** In `frontend/package.json` gibt es weder Prettier noch ESLint. Der Code ist stark verdichtet: 68 Zeichen pro Zeile im Schnitt, 380 Zeilen über 160 Zeichen, 73 über 250 (`CatalogSearch.tsx:122` 1 055 Zeichen, `App.tsx:276` 514, `InfosTab.tsx:82` 444, `Wishlist.tsx:395` 412). Mehrere Anweisungen stehen in einer Zeile, und der Stil ist uneinheitlich (`cents:number|null` in `api.ts:54` neben `cents: number | null`). Es gibt keine Prüfung der Hook-Abhängigkeiten; Ausnahmen werden nur per Kommentar begründet (`App.tsx:79`).
- **Nachweis:** `evidence/code/sizes.txt`; `package.json:6-14`.
- **Auswirkung:** Diffs lassen sich schwer prüfen, Merge-Konflikte werden wahrscheinlicher, und fehlende Effekt-Abhängigkeiten bleiben unentdeckt. Jede weitere 1.0-Änderung, etwa aus dem Design-Audit, wird dadurch teurer.
- **Verbesserung:** Als Dev-Abhängigkeiten Prettier (`printWidth` 120) und ESLint mit `typescript-eslint` und `eslint-plugin-react-hooks` (nur Regeln `rules-of-hooks` und `exhaustive-deps`) aufnehmen. **Einmal formatieren, als eigener Commit ohne Logikänderung**, und mit den visuellen Tests (`deploy/visual-check.sh`) und E2E absichern. Danach `npm run lint` in `deploy/check.sh` aufnehmen. Kein weiteres Regelwerk.
- **Aufwand / Risiko / Ziel:** 2–4 h (plus Durchsicht der `exhaustive-deps`-Meldungen) · gering · 1.0, als erster Schritt vor den anderen Änderungen.

### CODE-05 · P2 · Toter Code / veraltete Workarounds
- **Beschreibung (alles per grep oder knip geprüft, `evidence/code/knip-unused.txt`):**
  1. Einstellung `wishlist_price_scope`: Sie wirkt seit 0.6.1 nicht mehr (`price_badges.rs:269 let _ = scope;`, Aufruf nur mit `"preferred"` in `price_badges.rs:270,498`). Der Zweig `"all"` in `pricing.rs:75-81` ist unerreichbar. Trotzdem wird sie gelesen, validiert, gespeichert und getestet (`settings.rs:105-128,207,276`, `price_badges.rs:77`, `tests/catalog_wishlist.rs:1130-1150`), obwohl es keine Oberfläche dafür gibt (`api.ts:20`).
  2. Endpunkte ohne Aufrufer im Frontend: `GET /catalog/games/{id}/editions` (`catalog/mod.rs:269-292`) wird weder vom Frontend noch von Tests oder der Doku genutzt und filtert noch auf `169|49` ohne Xbox 360 und Xbox (`:288`). `POST /wishlist/{id}/preview` (`wishlist.rs:307`) und `GET /catalog/games/{id}` (`catalog/mod.rs:225`) werden nur von Backend-Tests aufgerufen.
  3. Rohfeld `history` in `OffersView` (`offers.rs:282-292,392-397`): Es ist seit 0.4.0 durch `histories` ersetzt und wird im Frontend nur noch als Rückfall gelesen (`PriceTab.tsx:37`, `HistoryTab.tsx:16`). Trotzdem wird es bei jedem Aufruf von `/offers` aufgebaut und übertragen.
  4. Frontend: `notifyError` (`notify.ts:15`), `clockText` (`settings/format.ts`), `needsReview` (`WishlistRow.tsx:16`, nie aufgerufen), die Komponente `PriceBadge` (`PriceBadge.tsx:19`, nur die Helfer werden genutzt) und `ui/Toast.tsx` samt `.toast`-CSS (`ui.css:163-168`) werden in Produktion nirgends verwendet, nur im Dev-Katalog `/_ui`. Die Prop `onBack` (`GameDetail.tsx:29-30`, „Kept for compatibility“) wird von `Wishlist.tsx:395` übergeben, aber nie gelesen. Die Aliase `const setMessage = notify` (`Wishlist.tsx:93`, `Library.tsx:47`, `PriceAlerts.tsx:83`) führen zu 7 wirkungslosen Aufrufen `setMessage('')`.
  5. `frontend/tsconfig.tsbuildinfo` ist versioniert, obwohl es ein Build-Artefakt ist.
- **Ursache:** Beim Umbau (Preisumfang 0.6.1, Popups 0.9.1, Editionsvorbereitung 0.4.2) wurde nur ergänzt, nicht aufgeräumt.
- **Auswirkung:** irreführende API und Tests, unnötige Nutzlast und Rechenzeit (Punkt 3), Rauschen beim Lesen.
- **Verbesserung:** Punkte 1–5 entfernen. Für Punkt 1 die DB-Spalte **behalten** (keine Migration nötig) und nur das API-Feld, die Validierung und den toten Zweig streichen. Serde ignoriert unbekannte Felder, also schaden auch alte, noch gecachte Frontends nicht, die das Feld weiter mitschicken. Die betroffenen Backend-Tests umstellen (Vorschau über `/wishlist/{id}/editions`). `history` aus dem Response entfernen, sobald der Rückfall im Frontend weg ist (beide stammen aus demselben Image).
- **Aufwand / Risiko / Ziel:** 3–5 h · gering · 1.0.

### CODE-06 · P3 · Rückwärtskompatibilität – Schichten ordnen
- **Beschreibung:** Die Kompatibilitätspfade sind zum Teil nötig, zum Teil gegenstandslos (vollständige Tabelle in Abschnitt 6). Gegenstandslos sind die Frontend-Vorkehrungen für „ältere Server“ (`api.ts:10,26,64,97,128`, `WishlistRow.tsx:27`, optionale Felder samt `??`-Rückfällen). Frontend und Backend werden im selben Image ausgeliefert, ein neues Frontend trifft also nie auf ein altes Backend. Umgekehrt ist der Fall möglich: Ein gecachtes altes Frontend trifft nach einem Update auf ein neues Backend, weil `index.html` ohne `Cache-Control` ausgeliefert wird (`api-error-shapes.txt`, unten; Querverweis PERF). Felder, die alte Clients lesen, darf das Backend deshalb nur mit einem Release Abstand entfernen.
- **Verbesserung:** Optionale Frontend-Felder schrittweise zu Pflichtfeldern machen und die Rückfälle streichen. Für `index.html` `Cache-Control: no-cache` setzen, damit nach einem Update sofort das neue Frontend lädt; dann reicht als Regel „ein Release Abstand“. Fingerprint-Upgrade und `ntfy.env` behalten (siehe Abschnitt 6).
- **Aufwand / Risiko / Ziel:** 2–3 h · gering · 1.1.

### CODE-07 · P3 · State Management Frontend – God Components, Prop Drilling, eigene Navigation
- **Beschreibung:** `Wishlist.tsx` (451 Zeilen, 31 KB) vereint Liste, Detail, Editionen und Vorschau, Tab-Routing, History-Tiefe (`:59-76,229-262`), vier Aktionen (`:276-341`), KPIs und drei Poll-Schleifen (`:155-188`). `GameDetail` erhält 29 Props (`GameDetail.tsx:27-41`), die zum Teil nur durchgereicht werden (`offersColumns`, `offersHidden`, `csrf`, `targetLabel` laufen über App → Wishlist → GameDetail). `csrf` wird an 14 und `onError` an 18 Stellen übergeben. Die Navigation verteilt sich auf `App.tsx:25-28,108-165`, `Wishlist.tsx:61-76` und `settings/sections.ts`; vier synthetische `PopStateEvent`s dienen als Ereignisbus (`App.tsx:125,164`, `PriceAlerts.tsx:65`, `sections.ts:27`). Die 401-Behandlung ist doppelt und uneinheitlich: `resetSession` (`App.tsx:89`) setzt mehr Zustand zurück als der 401-Zweig (`App.tsx:103`), und dort steht dieselbe Bedingung zweimal (`:101,103`).
- **Auswirkung:** Änderungen an der Detailseite berühren den Listen-Code. Fehler im Zusammenspiel von Zurück-Navigation und Fokus sind schwer zu finden, auch wenn sie heute durch E2E abgedeckt sind (`release091.spec.ts`, `wishlist.spec.ts`).
- **Verbesserung (schrittweise, ohne neue Bibliothek):**
  1. `api.ts` hält das CSRF-Token selbst (`setCsrf`) und meldet 401 zentral per Event. Damit fallen `csrf`/`onError` als Props weg.
  2. `route.ts` mit `navigate(params)` und `useRoute()` (`useSyncExternalStore` auf `popstate` plus eigenes Event) ersetzt die synthetischen `popstate`-Events und die doppelte URL-Logik.
  3. Detailzustand und Aktionen als `useWishDetail(item)` bzw. eigene Seite `WishDetailPage` aus `Wishlist.tsx` herauslösen, sodass `GameDetail` ein Objekt statt 29 Props bekommt.
  4. Ein Hook `usePolled(path, { every, fastWhen })` statt zehn Kopien (CODE-08).

  Jeder Schritt einzeln und durch die vorhandenen E2E-Tests abgesichert.
- **Aufwand / Risiko / Ziel:** 12–20 h · mittel · 1.1 (Schritt 1 wäre auch schon für 1.0 günstig, 2–3 h).

### CODE-08 · P2 · Unnötige Netzwerk- und DB-Abfragen
- **Beschreibung und Nachweis:**
  1. Die Zähler in der Navigation laden ganze Listen, nur um `rows.length` zu bilden: `/library`, `/alerts`, `/cart` und gegebenenfalls `/wishlist` (`App.tsx:188-226`). Das passiert bei **jedem Seitenwechsel** und jeder Änderung von `wishlistCount`. `/cart` berechnet dabei Shop-Angebote (`cart.rs:47-48`), `/wishlist` alle Badges.
  2. `/status/fetch` wird parallel gepollt: Seitenleiste (`FetchStatus.tsx:44`) und KPI-Kachel (`Wishlist.tsx:179`) je alle 60 s, in den Einstellungen zusätzlich `settings/data.ts:22`. Den Klon hat jscpd bestätigt (`FetchStatus.tsx:40-54` ↔ `Wishlist.tsx:176-188`).
  3. `/wishlist/price-badges` folgt sofort auf `/wishlist`, das die Badges schon enthält. Wegen `[items, …]` in `Wishlist.tsx:155-166` wiederholt es sich nach jeder lokalen Änderung (Warenkorb, Pause).
  4. N+1-Abfragen: `offers::list` stellt je bestätigtem Link eine Abfrage mit bis zu 180 Zeilen (`offers.rs:370-376`). Ein Treffer im Katalog-Suchcache lädt jedes Spiel einzeln (`catalog/mod.rs:164-175`).
  5. Das 3-s-Polling aus CODE-01.
- **Auswirkung:** Unnötige lokale Last und Requests. Bei großen Wunschlisten wächst das linear (Messung: PERF).
- **Verbesserung:** `GET /api/v1/counts` (vier `COUNT(*)`) oder die Zähler in `/me`, neu laden bei `CART_CHANGED` und Seitenwechsel. Einen gemeinsamen `fetchStatus`-Store für Seitenleiste und Kachel. Den Badge-Effekt erst nach dem ersten Intervall starten und nicht an `items` hängen. Beobachtungen für alle Links eines Wunsches in einer Abfrage holen (`link_id IN (…)` mit `ROW_NUMBER() … <= 180`), den Suchcache per `json_each` lesen.
- **Aufwand / Risiko / Ziel:** 4–8 h · gering bis mittel · 1.0 (Punkte 1–3), 1.1 (Punkt 4).

### CODE-09 · P2 · Doku widerspricht dem Code
- **Nachweis (Doku ↔ Code):**
  - `docs/architecture.md:13` nennt ein „transaktionales 100er-Limit“, `docs/operations.md:86` „Bei mehr als 100 aktiven Wünschen …“. Seit 0.9.0 gibt es kein Limit mehr (Test `a_wishlist_with_100_items_can_preview_and_promote_editions_without_a_limit`).
  - `architecture.md:28` spricht von „letzten 60 passenden Beobachtungen“, der Code nutzt `LIMIT 180` (`offers.rs:372`).
  - `architecture.md:9`: „Geldwerte künftiger Angebote …, Anwendung auf echte Preise gehört P4“. Gebühren werden seit 0.7.3 angewandt (`offers.rs:187,223-225`).
  - `architecture.md:33-35` beschreibt eine „feste Wunschlistenspalte“ und vier Tabs. Tatsächlich ist die Detailseite eine eigene Seite mit sechs Tabs (`GameDetail.tsx:22`).
  - `operations.md:43`: Budget „dann an Preise aktiver Wünsche, die im Zielland gelten können“. Das widerspricht der Implementierung seit 0.6.5 („any region; the target country is not preferred“, `jobs.rs:9,18-19`) und dem Kernanliegen, alle Regionen gleich zu behandeln.
  - `.env.example:12-13` setzt `KEYHUNTER_SHOP_DAILY_JOBS=120` und nennt den Bereich „1–1000“. Der Code erlaubt 1–2000 (`jobs.rs:86-92`), Standard ist 500 (`compose.yaml:9`, Unraid-Vorlage). Wer `.env.example` kopiert, drosselt also unbemerkt auf 120.
  - `docs/dependencies.md:3,7` steht auf „Stand v0.2.0“ und nennt 296 Rust-Pakete. Gemessen sind heute 270 im normalen Abhängigkeitsbaum; die Zählweisen sind nicht direkt vergleichbar, der Stand ist aber in jedem Fall veraltet.
  - `operations.md:29` sagt „Der Test auf einer Unraid-Installation steht aus.“ Das ist vermutlich veraltet (nicht verifiziert).
  - `operations.md:68-108` enthält Upgrade-Kapitel für 0.3.0–0.6.1, für 0.7–0.9 dagegen nichts. Historische Hinweise gehören ins CHANGELOG oder in ein `UPGRADING.md`.
  - `0023_release_081.sql:4` kündigt „check“ an, ein `foreign_key_check` steht aber nur im Test (`lib.rs:772`).
- **Auswirkung:** Betreiber stellen falsche Werte ein, Leser verstehen die Priorisierung falsch.
- **Verbesserung:** Die Stellen korrigieren und die Upgrade-Historie auslagern. Als Regel für 1.0: Doku beschreibt den Ist-Zustand ohne Versionsgeschichte.
- **Aufwand / Risiko / Ziel:** 2–3 h · keins · 1.0.

### CODE-10 · P3 · Konfiguration – teils am `Config` vorbei
- **Beschreibung:** `Config::from_env` (`config.rs:16-41`) bricht bei ungültigen Werten ab. `KEYHUNTER_SHOP_DAILY_JOBS` liest dagegen `jobs.rs:87-93` bei **jedem** Aufruf aus der Umgebung (Aufrufer u. a. `offers.rs:243,257,431`, `price_badges.rs:264`). Ungültige Werte (z. B. 3000) fallen ohne Log still auf 500 zurück. `KEYHUNTER_NTFY_ENV_FILE` liest `lib.rs:236` direkt.
- **Auswirkung:** Fehlkonfigurationen bleiben unbemerkt, und die Regeln sind verstreut.
- **Verbesserung:** Beide Variablen in `Config` aufnehmen, einmal parsen, bei ungültigem Wert abbrechen oder klar warnen (Ersteres wäre ein Verhaltenswechsel, also im CHANGELOG nennen) und über `AppState` weitergeben.
- **Aufwand / Risiko / Ziel:** 1–2 h · gering · 1.1.

### CODE-11 · P3 · Magic Numbers und mehrfach definierte Konstanten
- **Nachweis:** `evidence/code/semantic-duplicates.txt` §2–5 und §9.
  - `const DAY` ist dreimal definiert (`jobs.rs:64`, `alerts.rs:18`, `price_badges.rs:61`).
  - **900 s steht für fünf Konzepte:** Anfragefenster `REQUEST_WINDOW` (`jobs.rs:71`, aber als Literal in `jobs.rs:199`, `offers.rs:243,257`, `price_badges.rs:260`), Sperre für manuelle Aktualisierung (`offers.rs:679,682`), Login-Drossel und `Retry-After` (`auth.rs:114-128`, `lib.rs:84` – der Header gilt pauschal für jedes 429), Rückfallwert bei Shop-Drosselung (`shops/http.rs:162`), Wiederholung der Editionsvorbereitung (`edition_tracking.rs:131`) und `MIN_INTERVAL` (`jobs.rs:433`).
  - 14 Tage stehen als `1209600` im SQL (`jobs.rs:195`).
  - Die Preisobergrenze steht als `10_000_000` in `alerts.rs:87`, `eneba.rs:125`, `driffle.rs:209`, obwohl es `pricing::MAX_CENTS`/`valid_cents` (`pricing.rs:19,102`) gibt. `history.rs:40` prüft nur `> 0`.
  - Plattform-IDs: `catalog::PLATFORMS` existiert (`catalog/mod.rs:15`), trotzdem stehen Literale in `catalog/mod.rs:288`, `eneba.rs:46`, `driffle.rs:59`, `offers.rs:91`.
  - `Retry-After` wird zweimal ausgewertet, mit unterschiedlicher Begrenzung (`shops/http.rs:149-163`: 60 s … 7 Tage; `catalog/provider.rs:185-201`: nach oben offen).
- **Auswirkung:** Änderungen müssen mehrere Stellen treffen. Sinngleiche Zahlen lassen sich nicht unterscheiden.
- **Verbesserung:** Ein Zeitmodul mit `DAY`/`WEEK`; je Konzept eine benannte Konstante, die ins SQL gebunden (`?`) oder per `format!` eingesetzt wird; überall `pricing::valid_cents`; ein Helfer `fn retry_after(&HeaderMap) -> Option<i64>`; Plattform-Konstanten statt Literalen.
- **Aufwand / Risiko / Ziel:** 3–4 h · gering · 1.1.

### CODE-12 · P3 · Modulgröße und Verantwortlichkeiten
- **Beschreibung:** `jobs.rs` (1 300 Zeilen Produktionscode) vereint Worker-Schleife, Claim-SQL, Abschluss, Preis-Trend/Score, Budget/Bedarf und drei HTTP-Handler (`status`, `runs`, `upcoming`). `notify.rs` (1 164) vereint Validierung, Geheimnis-Speicher, Versand über 7 Kanäle, Nachrichtenformat und Handler. `lib.rs` enthält 381 Zeilen Migrationstests. Shop-Wissen steht außerhalb von `shops/`: die Eneba-Suche direkt in `jobs.rs:522`, `'eneba'` als Literal in `jobs.rs:892`, Eneba-Query-Regeln im generischen `shops/http.rs:117-130` und die Heartbeat-Slots je Shop in `jobs.rs:114-122`.
- **Auswirkung:** Lange Lesewege; ein dritter Shop würde Änderungen an 6+ `match`-Stellen und in `jobs.rs` erfordern.
- **Verbesserung (nur verschieben, keine Logik ändern):** `jobs/{mod.rs (Worker, Claim), complete.rs, trend.rs, budget.rs, api.rs}` und `notify/{channel.rs, send.rs, message.rs, api.rs}`. Die Migrationstests in `src/migration_tests.rs` (`#[cfg(test)] mod`). `Shop::search_page`/`Shop::searches()` analog zu `product`/`discover`, Heartbeat über `shop as usize`. Kein Trait-Framework für Shops, solange es zwei gibt.
- **Aufwand / Risiko / Ziel:** 4–8 h · gering (Tests decken ab) · 1.1.

### CODE-13 · P3 · Testbarkeit und Teststruktur
- **Beschreibung und Nachweis:**
  1. `frontend/tsconfig.json` prüft nur `src`. Eine Typprüfung von `tests/` und `e2e/` (`evidence/code/tsc-tests.txt`) ergibt 53 Fehler: 41× fehlendes `@types/node`, 3× implizites `any`, **9× echte API-Drift** (`tests/wishlist-model.test.ts:20-62` ruft `rowFacts` mit 1 statt 2–3 Argumenten auf). `node --test` entfernt die Typen nur und prüft sie nicht.
  2. 19 von 27 E2E-Specs sind nach Release benannt (`release040.spec.ts` … `release091.spec.ts`). Eine Funktion lässt sich so schwer finden, der Setup-Code ist vielfach kopiert (jscpd 3,7 %), und es gibt 5 feste Wartezeiten (`waitForTimeout`, z. B. `catalog.spec.ts:63`).
  3. `tests/catalog_wishlist.rs` hat 3 067 Zeilen mit 24,9 % duplizierten Zeilen, vor allem Setup.
  4. `tests/api.rs:36` nutzt den Produktionspfad `create_app` und startet damit echte Hintergrund-Worker (`lib.rs:256-260`). Hermetisch ist das nur, weil kein Wunsch existiert. Shops lassen sich nicht injizieren (`Shop::product` → statische `SESSIONS`, `shops/http.rs:27`), daher ist die Kette Claim → Abruf → Abschluss nicht integrativ testbar. `run_background` ist an die Katalog-Injektion gekoppelt (`lib.rs:141-157`).
- **Verbesserung:** `tsconfig.test.json` plus `@types/node` als Dev-Abhängigkeit, Typprüfung in `check.sh` (1–2 h). E2E-Specs bei Gelegenheit nach Funktion umgruppieren, kein Big Bang; Wartezeiten durch `expect.poll`/Locator-Waits ersetzen. Test-Helfer extrahieren. `create_app_with(Options { catalog, background, shop_fetcher })` mit einem minimalen Fetcher-Trait nur für Tests (später, 3–4 h).
- **Aufwand / Risiko / Ziel:** 3–6 h · gering · 1.1 (Typprüfung schon für 1.0 sinnvoll).

### CODE-14 · P3 · Logging und Überwachung
- **Beschreibung:** Im ganzen Backend gibt es nur 13 `tracing`-Aufrufe. Abruf-, Zustell- und Alarmfehler landen nur im DB-Log (`eventlog::record`, 33 Aufrufe, 7 Tage Aufbewahrung). `docker logs` zeigt im Fehlerfall daher kaum etwas, und es gibt kein Request-Log. Die Editionsschleife verschluckt DB-Fehler (`edition_tracking.rs:144 if let Ok(Some(id))`). Nur die Shop-Worker haben einen Heartbeat für `/health/ready`. Die Alarm- und die Editionsschleife (`alerts.rs:414`, `edition_tracking.rs:139`) enden bei einem Panic still. Log-Bereiche werden als deutsche Anzeigenamen gespeichert (`eventlog.rs:54-66`), eine Umbenennung bricht also Filter auf alte Einträge.
- **Verbesserung:** In `eventlog::record` Warnungen und Fehler zusätzlich an `tracing` geben (eine Zeile). Den verschluckten Fehler loggen. Einen Heartbeat für beide Schleifen in `ready` aufnehmen. Den Bereich als Schlüssel speichern und erst bei der Anzeige übersetzen (nur, wenn ohnehin migriert wird).
- **Aufwand / Risiko / Ziel:** 2–3 h · gering · 1.1.

### CODE-15 · P3 · Migrationsmechanismus
- **Bewertung:** solide (siehe 3.3, Upgrade-Kette gemessen).
- **Restrisiken:**
  - Nichts verhindert, dass eine bereits ausgelieferte Migration geändert wird. sqlx verweigert dann wegen der Prüfsumme den Start aller bestehenden Installationen.
  - Die Release-Namen `0016_release_065` … `0026_release_090` mischen Themen. Bestehende Dateien bitte **nicht** umbenennen, neue Migrationen beschreibend benennen.
  - Der Kommentar in 0023 kündigt einen „check“ an, der nur im Test stattfindet.
  - Läuft eine Migration fehl, wiederholt der Neustart-Loop die Sicherung bei jedem Start. Das ist unkritisch, weil alle Kopien denselben Stand vor der Migration haben.
- **Verbesserung:** In CI `git diff --exit-code <letzter Tag> -- backend/migrations/` für alle bestehenden Dateien. Kommentar korrigieren.
- **Aufwand / Risiko / Ziel:** 1 h · keins · 1.0.

### CODE-16 · P3 · Abhängigkeiten und Versionsangaben
- **Beschreibung:** Alle 21 direkten Rust-Crates und alle npm-Pakete werden genutzt; es gibt keine überflüssige Bibliothek (`evidence/code/dependencies.txt`). `tower-http` kommt in 0.7 (direkt, nur `ServeDir`) und 0.6 (über reqwest) vor; `base64`, `hashbrown` und `syn` doppeln sich transitiv. Versionsnummern werden mehrfach gepflegt:
  - App-Version in `Cargo.toml:3`, `package.json:3` und `Dockerfile:29`; der Release-Workflow prüft nur `Cargo.toml` (`container.yml`).
  - Node `24.22.1` in `Dockerfile:2` und `checks.yml:25`.
  - Rust-Digest in `Dockerfile:9` und `deploy/Dockerfile.tools:1`.
  - Playwright `1.65.1` in `package.json` und `visual-check.sh:7`.

  Die Schriften werden über relative `node_modules`-Pfade eingebunden (`fonts.css:13-27`).
- **Verbesserung:** Eine kleine Prüfung in `check.sh`, ob die Versionen übereinstimmen. `tower-http` optional auf 0.6 festlegen, um die Doppelung zu beseitigen.
- **Aufwand / Risiko / Ziel:** 1 h · gering · 1.1.

### CODE-17 · P3 · Doppelte Hilfsfunktionen und Label-Tabellen im Frontend
- **Nachweis:** `semantic-duplicates.txt` §6–8, §12.
  - Die Texte für Fehlercodes stehen dreimal da (`InfosTab.tsx:14`, `Offers.tsx:17` identisch, `settings/format.ts:41` anders formuliert: „Netzwerkfehler“ statt „Verbindung fehlgeschlagen“).
  - `deliveryNames` gibt es zweimal mit unterschiedlicher Großschreibung (`AlarmTab.tsx:21`, `PriceAlerts.tsx:19`), `activationNames` zweimal mit unterschiedlichem Wortlaut (`InfosTab.tsx:13`, `LinkReview.tsx:8`).
  - Es gibt zwei Preisformatierer: `formatPrice` (`ui/Price.tsx:5`, normales Leerzeichen) und `money` (`price-format.ts:1`, Intl mit geschütztem Leerzeichen).
  - `initials`, `games` und `shopName` sind je zweimal implementiert.
  - Die localStorage-Hüllen stehen in 4 Dateien.
  - Die ISO-Länderliste gibt es im Backend (`settings.rs:11`) und im Frontend (`regions.ts:2`), obwohl `/settings` sie bereits liefert. `regions.ts` braucht die Liste allerdings synchron, schon beim Laden des Moduls.
- **Verbesserung:** `labels.ts` (eine Tabelle je Backend-Code), ein einziger Preisformatierer, `storage.ts`. Für die Länder eine gemeinsame Quelle: entweder `/settings.countries` oder eine Liste, die das Backend per Test gegen `settings.rs` prüft. Mit den visuellen Tests absichern, weil sich Texte und Leerzeichen ändern.
- **Aufwand / Risiko / Ziel:** 2–3 h · gering · 1.1.

### CODE-18 · P3 · Kommentar-Rauschen
- **Beschreibung:** 136 Versionsvermerke in 48 Frontend-Dateien und 58 in 18 Backend-Dateien („Popups … (0.9.1)“), dazu 14× „design v4“ und Audit-IDs. Die Kommentare erzählen Historie statt Verhalten. Ein verwaister Doc-Kommentar steht in `api.ts:168`.
- **Verbesserung:** Versionsvermerke entfernen, wo sie keine Kompatibilität erklären; die Historie steht in CHANGELOG und Git.
- **Aufwand / Risiko / Ziel:** 2–3 h · keins · 1.1.

---

## 5 Codebereinigung nach Vorgabe (SPEC 3, Punkte 1–8)

| # | Vorgabe | Ergebnis | Befunde |
|---|---|---|---|
| 1 | Tatsächlich ungenutzter Code | Klein, aber vorhanden: 1 wirkungslose Einstellung, 3 Endpunkte ohne Frontend-Aufrufer, 1 mitgeschlepptes Response-Feld, 5 tote Frontend-Symbole, 1 tote Prop. Rust: keine `dead_code`-Warnung. | CODE-05 |
| 2 | Mehrfach implementierte Funktionen | Wartet/läuft-Regel 6× (Scheduler + 5 Anzeige-Kopien), Retry-After 2×, Preisvalidierung 4×, Label-Tabellen und Formatierer im Frontend, Poll-Muster 10× | CODE-01, -11, -17, -07 |
| 3 | Redundante Datenverarbeitung | `history` neben `histories`; Badges doppelt geladen; Angebots-JSON je Beobachtung in Rust geparst, obwohl `valid_cents` vorberechnet ist (mit anderer Semantik, deshalb nicht einfach ersetzbar) | CODE-05, -08 |
| 4 | Veraltete Workarounds | `setMessage = notify`-Aliase, `onBack` „for compatibility“, Frontend-Pfade für „older server“, `ui/Toast.tsx` neben `Toaster` | CODE-05, -06 |
| 5 | Unnötige Bibliotheken | **Keine.** Nur transitive Doppelversionen | CODE-16 |
| 6 | Unnötige Netzwerk-/DB-Abfragen | Navigationszähler über volle Listen, doppeltes Polling von `/status/fetch`, N+1 in `offers::list` und im Suchcache, 3-s-Polling | CODE-08, -01 |
| 7 | Inkonsistente Fehlerbehandlung | Extraktor-Fehler im Klartext; verschluckter Fehler in der Editionsschleife; 401-Behandlung doppelt im Frontend | CODE-02, -14, -07 |
| 8 | Technische Schulden | Frontend-Dichte ohne Formatter/Lint, God Components, große Module, Testtypisierung, Doku-Drift | CODE-04, -07, -12, -13, -09 |

---

## 6 Bewusste Rückwärtskompatibilität vs. toter Code

| Stelle | Zweck | Urteil |
|---|---|---|
| `shops/mod.rs:188-229`, `lib.rs:187` – Fingerprint-Upgrade aus 0.5 bei jedem Start | Bestätigungen und Preisverlauf von Installationen vor 0.6 übernehmen | **Behalten** für 1.0, denn ein Sprung von 0.5 auf 1.0 ist möglich. Später einmalig per Marker ausführen (heute N Zeilen deserialisieren und 2N Updates in einer Transaktion je Start). |
| `notify.rs:376-395`, `lib.rs:234-237`, `compose.yaml:8,14`, Unraid-Feld – `ntfy.env` | Alter ntfy-Zugang vor 0.9.0 | **Behalten** für 1.x und in der Doku als veraltet markieren. Aus der Compose-Vorlage für neue Installationen entfernen. |
| `wishlist-sort.ts` (Test „0.6.1 modes still work“) | Gespeicherte Sortierung im Browser | **Behalten** (Nutzerdaten im Browser). |
| DB-Spalte `app_settings.wishlist_price_scope` | Schema | **Behalten** (keine Migration), aber API-Feld und Logik entfernen (CODE-05). |
| `OffersView.history` | Altes Frontend vor 0.4.0 | **Tot** (CODE-05). |
| `api.ts`-Felder „absent from older servers“, `WishlistRow.tsx:27` | Neues Frontend gegen altes Backend | **Gegenstandslos**, da beides im selben Image steckt (CODE-06). |
| `GameDetail.tsx:29-30 onBack` | „Kept for compatibility“ | **Tot**, interne Prop (CODE-05). |
| `KEYHUNTER_IGDB_ENV_FILE` (Doku `operations.md:35`) | Upgrade von 0.2.0 | Code bereits entfernt. Den Doku-Satz in die Upgrade-Historie verschieben (CODE-09). |

---

## 7 Refactoring-Fahrplan

| Phase | Inhalt | Aufwand |
|---|---|---|
| Vor 1.0 (P2) | 1. CODE-04 Formatter/Lint (eigener Commit, visuell abgesichert) → 2. CODE-01 eine Lauffähigkeitsregel plus Regressionstest → 3. CODE-02 Fehler-Extraktoren → 4. CODE-05 Altlasten entfernen → 5. CODE-08 Punkte 1–3 → 6. CODE-09 Doku. Günstige P3-Teile, falls Zeit bleibt: CODE-15 (CI-Schutz), Typprüfung aus CODE-13, Schritt 1 aus CODE-07. | 17–31 h (+ 4–6 h optional) |
| 1.1 | CODE-03, -06, -07, -10, -11, -12, -14, -16, -17, -18, Rest von -13 | 35–60 h |
| Später | Typisierte Response-Structs statt `json!` (heute 48× `json!` neben 34 `Serialize`-Structs) und daraus generierte TS-Typen. Erst, wenn weitere API-Nutzer dazukommen. | offen |

Kein Rewrite: Jede Maßnahme ist lokal, durch vorhandene Tests abgesichert und lässt das Datenmodell unverändert.

---

## 8 Ist die Codebasis für 1.0 ausreichend wartbar?

**Ja, unter der Bedingung, dass die P2-Punkte erledigt werden.** Belege dafür:
- lint-sauberes Rust-Backend mit etwa 1:1 Test zu Code;
- reine, getestete Modelle im Frontend;
- eine nachgewiesen funktionierende Upgrade-Kette mit automatischer Sicherung;
- keine überflüssigen Abhängigkeiten.

Belege dagegen:
- Regeln, die in SQL dupliziert sind und auseinanderlaufen, nachweislich schon einmal (CODE-01). Jedes weitere Scheduler-Feature würde das wiederholen;
- ein Frontend, das sich ohne Formatter und mit God Components nur mühsam ändern lässt.

Beides ist mit begrenztem Aufwand behebbar. Ein Neuschreiben einzelner Schichten ist nicht nötig.

---

## 9 Geprüfte Befehle und Grenzen

**Ausgeführt (alle Ergebnisse unter `evidence/code/`):**
- `wc`/`awk` über alle Quelldateien: Größen, Zeilenlängen, Produktions- und Testanteile → `sizes.txt`.
- Docker `keyhunter-build-tools:local`, eigenes Ziel `work/check/target-code`:
  - `cargo clippy --locked --all-targets -- -W clippy::pedantic -W dead_code` → Exit 0, 182 Warnungen, 0 dead_code (`clippy-pedantic.txt`);
  - `cargo fmt --check` → 0; `cargo clippy --all-targets --locked -- -D warnings` → 0;
  - `cargo test --locked` → 173 bestanden, 0 fehlgeschlagen (`cargo-test.txt`);
  - `cargo tree -d` und `-i` → `dependencies.txt`.
- `cd frontend && npm test` → 71/71 bestanden; `npx tsc --noEmit -p tsconfig.json` → 0 Fehler.
- `npx tsc` mit einer tsconfig im Scratch-Ordner für Tests und E2E → 53 Fehler (`tsc-tests.txt`).
- `npx --yes knip@5` (Konfiguration im Scratch-Ordner), manuell per grep verifiziert → `knip-unused.txt`.
- `npx --yes jscpd@4` für Frontend, Backend (mit `--max-lines 20000`, sonst überspringt jscpd Dateien über 1 000 Zeilen) und E2E → `jscpd.txt`.
- `npx vite build --outDir <scratch>`: Bundle 461 KB JS (140 KB gzip), Dev-Galerie `/_ui` nicht enthalten.
- Fixture-Server `catalog_fixture` auf eigenem Port 38786 mit eigenem Datenverzeichnis (danach gestoppt und gelöscht): Fehlerformen (`api-error-shapes.txt`) und Pause-Reproduktion über die API (`paused-wish-predicates.txt`).
- Python-SQLite (3.46.1):
  - Endschema aus allen Migrationen (`scripts/schema.py` → `schema-after-0027.sql`);
  - Reproduktion der Prädikate: Konstanten und Anzeige-SQL wörtlich extrahiert, die `format!`-Komposition von `claimable()` nachgebildet (`scripts/predicates.py`);
  - Migrationskette auf einer Scratch-Kopie von `work/phase_b_database/keyhunter.db` (nur Aggregate, Kopie gelöscht; `scripts/migtest.py`, `migration-upgrade-check.txt`).
- grep-Analysen zu Duplikaten, Konstanten, Routen und Logging → `semantic-duplicates.txt`.

**Grenzen / nicht verifiziert:**
- Testabdeckung in Prozent: **Nicht verifiziert**, weil kein Coverage-Werkzeug (llvm-cov/c8) im Build-Image ist.
- E2E- und visuelle Tests habe ich nicht ausgeführt (Bereich QA/RESP); bewertet ist nur ihre Struktur.
- Die Migrationsprüfung lief mit Python-sqlite statt sqlx und der gebündelten SQLite. `shops::upgrade_fingerprints` und die Buchführung in `_sqlx_migrations` sind dadurch nicht abgedeckt.
- jscpd findet nur exakte Klone. Die semantischen Duplikate (SQL-Regeln, Label-Tabellen) habe ich per grep und durch Lesen ermittelt.
- knip parst kein CSS. Die drei gemeldeten Font- und Flaggen-Abhängigkeiten sind deshalb falsch positiv.
- Laufzeit- und Lastwirkung der Abfragen in CODE-08 habe ich nicht gemessen, das liegt bei PERF. Die Mathematik in `jobs.rs` (Trend, Score) habe ich nicht bewertet, das liegt bei SCORE.
- `operations.md:29` („Unraid-Test steht aus“): Ob die Aussage veraltet ist, ist nicht verifiziert, weil ich keinen Zugriff auf eine Unraid-Instanz habe.
- Keine Anfragen an echte Händler, IGDB oder Benachrichtigungsdienste. Den Inhalt von `work/local/` habe ich nicht gelesen.
