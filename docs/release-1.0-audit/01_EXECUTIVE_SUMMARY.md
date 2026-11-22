# 01 · Executive Summary – Release-1.0-Audit KeyHunter 0.9.1

**Stand:** 22.11.2026, Commit `490a8fb` (Tag 0.9.1). **Art:** unabhängiger, rein analytischer Audit. Der Anwendungscode ist unverändert; alle Prüfungen liefen gegen isolierte Testinstanzen ohne Anfragen an echte Shops, IGDB oder Benachrichtigungsdienste.

## Entscheidung: CONDITIONAL GO

KeyHunter 0.9.1 ist **funktional vollständig und im Kern solide**. Belege:
- 339 automatisierte Tests grün und stabil: 173 Rust, 71 Frontend-Unit, 73 E2E, 22 Visual.
- Nirgends erscheint ein Fehlerpreis als gültiger Preis.
- Upgrade von 0.5.0 bis 0.9.1 und der Rückweg sind belegt.
- Der Container ist rootlos, sparsam (25–36 MiB im Leerlauf) und sauber gehärtet.
- Secrets sind sauber verwahrt.

In dieser Form würde ich ihn **nicht** als 1.0 veröffentlichen. Die nicht erfüllten Pflichtkriterien liegen in vier Gruppen:
1. **Bedienbarkeit auf Phone und Tablet.** Wunschlisten-Karten, Angebote-Tabelle und die Öffnen-Aktion auf Tablets sind kaputt; auch bei 1366×768 fehlen Aktionen.
2. **Login-Verfügbarkeit.** Jeder Client kann mit fünf Anfragen den Eigentümer für 15 Minuten aussperren; Requests haben keine Timeouts.
3. **Ehrliche Zustände und Zuordnungsgenauigkeit.**
   - Veraltete und fehlgeschlagene Preise wirken teils aktuell.
   - Gleichnamige Spiele verschiedener Jahre werden automatisch zugeordnet.
   - Eine Bestätigung von Hand lässt Konto-Angebote als Key-Preis zählen.
   - Das EU-Zielland aus 0.9.0 gilt nicht für Trend und Verlauf.
   - Pausierte Spiele zeigen dauerhaft „Wird gesucht“.
4. **Doku.** Sie widerspricht teilweise dem Verhalten, und die erlaubte Nutzung der Datenquellen ist nicht dokumentiert.

Alle Punkte sind mit begrenztem, gut abgrenzbarem Aufwand behebbar. Ein Rewrite ist **nicht** nötig. Geschätzt sind es 120–225 Entwicklerstunden bzw. 16–31 KI-Ausführungsstunden in sieben Phasen (08). Danach ist ein verantwortbares 1.0 erreichbar.

## Gesamtbewertung (0–10)

| Bereich | Note | Begründung (Kurzform, Details im jeweiligen Dokument) |
|---|---|---|
| Codequalität | 6 | Backend lint-sauber und gut getestet. Frontend ohne Formatter/Linter, Fachregeln mehrfach kopiert (eine Kopie verursacht CODE-01), toter Code. (02) |
| Architektur | 7 | Ein Monolith mit SQLite, persistenter Lease-Queue und Sicherung vor Migrationen passt zum Zweck. Zwei Module sind überladen, der Frontend-State ballt sich in zwei Komponenten. (02) |
| Funktionalität | 7 | Breiter, vollständiger Umfang, Persistenz, Upgrade und Restore belegt. Abzug für FUNC-02/03/04 und CODE-01. (03) |
| Zuverlässigkeit der Preisabfragen | 6 | Defensive Kette ohne Nullpreis, Leases, Budget, robots.txt. HTTP-Fehlerschicht ungetestet, Frische 24 h kollidiert mit Intervallen. Nur offline belegt. (03) |
| Datenqualität | 6 | Standard/Premium, DLC, Konto und PC werden automatisch korrekt getrennt. Identität nur über den Titel; Bestätigung von Hand ohne Keytyp-Prüfung. (03) |
| UI-Design | 7 | Eigenständiges, ruhiges Dunkel-Design mit klarer Preishierarchie. Abzug für das Favicon „1“, schwache Sekundärtexte, uneinheitliche Statusfarben. (04) |
| Designkonsistenz | 6 | Eine Token-Quelle, eine UI-Bibliothek. Aber 13 Schriftgrößen bei 8 Tokens, 10 Radien, 6 Icon-Button-Höhen, zwei Cover-Komponenten, vier Meldungsstile. (04) |
| UX / Benutzerfreundlichkeit | 6 | Der Kernablauf bis zum Alarm braucht nur 6 Aktionen, die Preisbegründung ist hervorragend. Erststart setzt Fachwissen voraus, Plattform mehrdeutig, Öffnen über kleines Icon. (05) |
| Responsive Design | 5 | Kein Dokument-Overflow in 240 Messungen, Desktop ab 1366 px sauber. Phone und Tablet mit drei P1-Fehlern in den Kernansichten. (05) |
| Accessibility | 5 | Tastaturbedienung, Landmarks, 200 % Zoom funktionieren. Kontrastfehler in 19 von 19 Ansichten, unsichtbarer Feldfokus, Drawer nicht modal, kleine Touch-Ziele. (05) |
| Performance | 6 | Leerlauf sehr sparsam. Bei 500 Wünschen gemessen: eine quadratische Statusabfrage, Dauer-Polling im 3-s-Takt, keine Kompression, CLS 0,42. (06) |
| Security | 7 | Argon2id, gehashte Tokens, Origin + CSRF + SameSite, strikte CSP, Secrets 0600, rootlos. Login-DoS, keine Timeouts, keine Passphrasen-Änderung. (06) |
| Testabdeckung und QA | 7 | 339 aussagekräftige Tests, Migrationen und Job-Engine auf DB-Ebene. Preis-UI nur gegen Mocks, HTTP-Schicht ungetestet, ein wirkungsloser Fairness-Test. (03, 11) |
| Docker-/Unraid-Integration | 7 | Rechteabgabe, Healthcheck, sauberes Stoppen, Sicherung vor Migration verifiziert. Schweres Basisimage, kein echter Unraid-Test, Template-Lücken. (06) |
| Wartbarkeit | 6 | Gutes Testnetz (etwa 1:1), aber sehr dichte Dateien, 194 Versionsvermerke, E2E nach Release statt nach Funktion sortiert. (02) |
| Scoring-Algorithmus | 6 | Korrekt, robust, kreuzvalidiert. Gegenüber festen Intervallen kaum Nutzen (−3 % Abfragen); bevorzugt den Weltpreis gegenüber dem alarmrelevanten Zielland-Preis. (11) |
| **Release-1.0-Reife** | **5** | Kern bereit. 16 von 33 Pflichtkriterien in 09 sind fehlgeschlagen, 6 Befunde P1. |

## Die zehn wichtigsten Probleme

| # | ID | Prio | Problem | Aufwand |
|---|---|---|---|---|
| 1 | RESP-02 | P1 | Angebote-Tabelle (1228 px) auf Phone und Tablet unbrauchbar; bei 1366×768 fehlen „Zum Shop“ und Warenkorb. Die Visual-Baseline hält den Fehler fest. | 4–8 h |
| 2 | RESP-01 | P1 | Wunschlisten-Karten auf Phones: Titel in etwa 75 px breiter Spalte, Überlappungen, Preise ohne Beschriftung | 3–5 h |
| 3 | SEC-01 | P1* | Globale Anmeldedrossel: Fünf Anfragen eines beliebigen Clients sperren den Eigentümer 15 min aus, auch mit richtiger Passphrase (*vom Lead angehoben) | 3–6 h |
| 4 | PERF-01 | P1 | `ANY_ACTIVE_WISH` wird mit SQLite ≥ 3.51 quadratisch: 257 ms je `/status/fetch`, 35 ms je Claim in der Schreibtransaktion bei 500 Wünschen | 1–3 h |
| 5 | RESP-03 | P1 | Tablet 721–900 px: Der einzige Öffnen-Knopf der Wunschliste liegt außerhalb des Bildschirms | 1–3 h |
| 6 | DS-01 | P1 | Favicon liest sich im Tab als „1“: Chrome nutzt die 32er-SVG, das Schlüsselloch wird bei 16 px zum Strich | 1–2 h |
| 7 | CODE-01 + PERF-02 | P2 | Die Regel „Job wartet“ ist sechsfach kopiert: Pausierte Spiele zeigen ewig „Wird gesucht“, bei Abrufrückstand pollt jede Liste alle 3 s 300 KB | 3–6 h |
| 8 | FUNC-01 + FUNC-04 | P2 | Zuordnung nur über den Titel (Doom 1993 ↔ 2016); die Bestätigung von Hand macht ein Konto-Angebot zum DE-Bestpreis | 5–10 h |
| 9 | FUNC-03 + RESP-11 + FUNC-05 | P2 | Ehrliche Zustände: Veraltete oder fehlgeschlagene Preise zeigen Ersparnis und Warenkorb-Knopf, ein Abruffehler wirkt wie „keine Angebote“, die 24-h-Frische kollidiert mit Intervallen bis 7 Tage | 6–13 h |
| 10 | FUNC-02 | P2 | EU-Zielland außer DE: Trend und Zielland-Verlauf bleiben leer. Der Fehler stammt aus 0.9.0 (die Marktregel wurde nur für den aktuellen Preis umgestellt). | 3–5 h |

Knapp dahinter: SEC-02 (keine Request-Timeouts), DS-02/DS-03 (Kontrast, Feldfokus), RESP-15/PROD-02 (Erststart), FUNC-08/09 (Doku, erlaubte Nutzung der Datenquellen).

## Fünf Maßnahmen mit dem besten Nutzen-Aufwand-Verhältnis

1. **PERF-01 skalar auswerten (1–3 h).** Faktor ≈ 100 schneller bei großen Listen; entlastet die Schreibtransaktion des Schedulers.
2. **DS-01 Favicon (1–2 h).** Den SVG-Link aus `index.html` entfernen und die optische 16-px-Variante B rendern. Sofort sichtbarer Qualitätsgewinn.
3. **CODE-01 + PERF-02, eine gemeinsame Pending-Regel (3–6 h).** Behebt einen sichtbaren Fehler und das Dauer-Polling zugleich: etwa 6 MB/min und 3,8 % CPU je offenem Tab.
4. **PERF-03 + PERF-04, Kompression und Cache-Header (2–3 h).** JSON −88 %, JS −70 %, kein leeres Bild nach einem Update.
5. **DS-02 + DS-03, Kontrast-Tokens und Fokusring (1,5–3 h).** Behebt den Großteil der 227 Kontrastverstöße je Desktop-Ansicht und den unsichtbaren Feldfokus.

Zusammen 9–17 h. Sie erfüllen fünf Pflichtkriterien (K21, K22, K35, K40, K41) teilweise oder ganz.

## Größte Risiken für Release 1.0

1. **Shop-Parser hängen an internen Seitenstrukturen** (Eneba Apollo-State, Driffle-Daten). Ein Umbau beim Shop macht alle Preise eines Shops ungültig. Heute gibt es dafür nur eine Fehlerflut im Log und keinen Selbsttest (FUNC-13, PROD-13).
2. **Budget statt Algorithmus begrenzt die Aktualität.** Mit dem Standardbudget von 500 Abrufen/Tag gelten bei 100 Spielen 23 %, bei 300 Spielen 75 % der Angebote als veraltet. Die unbegrenzte Wunschliste seit 0.9.0 macht das wahrscheinlicher (11 §E, PROD-14).
3. **Phase D ändert viele Visual-Baselines.** Ohne vorher erweiterte Baselines (Phase 0) und die freigegebene Vorschau drohen unbemerkte Regressionen.
4. **Strengere Zuordnung** (FUNC-01/04) kann bisher automatisch zugeordnete Angebote in „zu prüfen“ verschieben. Bestehende bestätigte Links müssen unangetastet bleiben.
5. **Öffentlicher Betrieb hinter einem Reverse Proxy** ohne SEC-01/02 und ohne Proxy-Doku (SEC-07) ist das größte Sicherheitsrisiko einer 1.0.

## Empfohlene Roadmap (Details in 08)

| Phase | Inhalt | Std. | Modell |
|---|---|---|---|
| 0 | Formatter/Linter, erweiterte Visual-Baselines, Typprüfung der Tests, cargo-audit in CI | 8–15 | Sonnet 5.5 medium |
| A | SEC-01/02/03/04, PERF-01/02/03/04, gemeinsame Pending-Regel | 14–30 | Opus 5.5 high |
| B | FUNC-01/02/03/04/05/11/13, RESP-11/14, SCORE-03/05 | 24–45 | Opus 5.5 high–xhigh, UI-Teile Sonnet 5.5 |
| C | Einheitliche Fehlerform, toter Code, Abfragen, CSS-Reihenfolge, Doku | 16–28 | Sonnet 5.5 medium, Opus für Fehlerform |
| D | RESP-01…15, DS-01…09, Erststart, nach freigegebener 1:1-Vorschau | 35–65 | Opus 5.5 high |
| E | Fixture-basierte E2E, HTTP-Fehlerklassen, axe, Route-Matrix | 10–18 | Sonnet 5.5 high |
| F | Datenquellen-Doku, Proxy-Beispiele, Import, Unraid-Abnahme, Release Notes | 14–26 | Sonnet 5.5 medium, Opus-Review |

Vorgeschlagener Release-Schnitt: 0.9.2 (Phasen 0 und A), 0.9.3 (B und C), 0.9.4 (D nach Freigabe der Vorschau), 1.0 (E und F).

## Entscheidungsvorlage

- **A. Technische Qualität:** Hoch im Backend (Tests, Migrationen, Härtung), mittel im Frontend (kein Lint, große Komponenten). Größte technische Schwäche: dieselbe Fachregel steht an mehreren Stellen und läuft auseinander (CODE-01), dazu eine quadratische Kernabfrage (PERF-01).
- **B. Design:** Am Desktop wirkt KeyHunter wie ein eigenständiges, professionelles Produkt. Auffällig: das Favicon, schwache Sekundärtexte, uneinheitliche Zustände und auf dem Phone ein klar unfertiges Layout.
- **C. UX:** Ein gewöhnlicher Nutzer scheitert eher am Erststart als an der Bedienung. Der Einrichtungscode liegt in einer Datei, der IGDB-Zugang braucht Twitch-Wissen, der Benachrichtigungskanal fehlt. Weitere Hürden: Plattform-Mehrdeutigkeit in der Liste, Öffnen eines Spiels nur über ein kleines Icon, ein fehlgeschlagener Abruf, der wie „keine Angebote“ aussieht, und die Nutzung auf dem Phone.
- **D. Codequalität:**
  - Vereinfachen: Pending-Regel, Fehlerform, Navigationszähler.
  - Entfernen: `wishlist_price_scope`, ungenutzter Editionen-Endpunkt, `history`-Feld, Pfade für „older server“, Alias-Tokens, tote CSS-Klassen.
  - Zusammenführen: Cover-Komponenten, Label-Tabellen, Preisformatierer.
- **E. Sicherheit:** Vor einer Veröffentlichung müssen behoben sein:
  - SEC-01 (Drossel je Quelle) und SEC-02 (Timeouts);
  - SEC-04 (Abhängigkeiten in CI prüfen; die zwei bekannten Advisories sind derzeit nicht ausnutzbar);
  - SEC-03 (Passphrase ändern) gehört zu einer 1.0.
- **F. Performance:** Nachweisbar: PERF-01 (quadratisch), PERF-02 (Polling), PERF-03/04 (Kompression, Caching), PERF-05 (CLS). Der Rest ist Feintuning.
- **G. Funktionen:** Wirklich fehlen nur eine geführte Wiederherstellung bzw. ein Import (PROD-01) und eine Erststart-Führung (PROD-02). Nicht nötig: weitere Shops ohne erlaubten Zugang, Mehrbenutzer, ML-Prognosen. Den „Score“ eher entfernen bzw. umbenennen als ausbauen.
- **H. Release 1.0:**
  - Zwingend: alle P1-Befunde und die Pflichtkriterien in 09.
  - Verschiebbar auf 1.1: Kandidat C des Scorings, CODE-07/12 (Umbau von State und Modulen), DS-12 bis DS-20, PERF-07 bis PERF-13, Inbox und relative Alarme.
- **I. Aufwand:** 120–225 Entwicklerstunden, ein Großteil davon Layout (Phase D). Mit KI-Unterstützung etwa 16–31 Ausführungsstunden plus Abnahmen durch den Eigentümer.
- **J. Empfehlung:** **CONDITIONAL GO.** Nicht als 1.0 im aktuellen Zustand veröffentlichen, weil
  - die Kernansichten auf Phone und Tablet nicht vollständig bedienbar sind,
  - der Login von außen blockierbar ist,
  - Preiszustände und Zuordnungen in bestätigten Fällen irreführen.

  Nach den Phasen 0–F, mindestens aber nach allen P1 und den Pflichtkriterien, ist ein 1.0 verantwortbar.

## Dokumente

| Datei | Inhalt |
|---|---|
| `02_CODE_ARCHITECTURE_AUDIT.md` | Code, Architektur, toter Code, Redundanzen (CODE-01…18) |
| `03_FUNCTIONAL_AUDIT.md` | Funktionsinventur, Testläufe, Datenfluss, Datenqualität, QA, Kriterien K01–K23 (FUNC-01…15) |
| `04_UI_UX_DESIGN_AUDIT.md` | Designsystem, Tokens, CSS-Duplikate, Favicon, Vorschlag Single Source of Truth (DS-01…20) |
| `05_RESPONSIVE_VISUAL_AUDIT.md` | Viewport-Matrix, Tastatur/Zoom/axe, UX-Journeys und 15 Antworten (RESP-01…21) |
| `06_SECURITY_PERFORMANCE_AUDIT.md` | Security, Performance-Messungen, Docker/Unraid, Scoring-Ressourcen (SEC-01…10, PERF-01…14) |
| `07_PRODUCT_FEATURE_REVIEW.md` | Feature-Bewertung, Benennung, neue Funktionen (PROD-01…14) |
| `08_RELEASE_1_0_ROADMAP.md` | Phasen 0, A–F mit Aufgaben, Aufwand, Risiken, Akzeptanz, Modellwahl |
| `09_RELEASE_READINESS_CHECKLIST.md` | 53 prüfbare Kriterien mit Status |
| `10_AUDIT_EVIDENCE.md` | Befehle, Läufe, Messwerte, Nachprüfungen des Leads, Grenzen |
| `11_SCORING_ALGORITHM_AUDIT.md` | Rekonstruktion, Simulation A/B/C, Randfälle, Vorschlag (SCORE-01…10) |
| `evidence/` | Screenshots, Messdaten, Skripte je Bereich |
| `work/release-1.0-design-preview/` (außerhalb des Repos) | 1:1-Vorschau der Layout- und Designänderungen aus Phase D |
