# 09 · Release-1.0-Checkliste

Abhakbare, objektiv prüfbare Kriterien. Status zum Stand **0.9.1 (Commit 490a8fb)**: ✅ bestanden · ❌ fehlgeschlagen · ⬜ nicht getestet · – nicht anwendbar. Grundlage sind die Kriterien K01–K23 aus `03_FUNCTIONAL_AUDIT.md` §10, ergänzt um die Bereiche Security, Responsive, Accessibility, Performance, Design, Scoring und Betrieb. Die Spalte „Beleg“ verweist auf das Dokument, das den Status trägt.

**Freigaberegel für 1.0:** Alle Kriterien mit **Pflicht** müssen ✅ sein, und es darf kein offener Befund P0/P1 übrig sein. „Soll“-Kriterien dürfen mit dokumentierter Begründung auf 1.1 verschoben werden.

## A. Funktion und Fehlerbehandlung

| # | Pflicht | Kriterium | Status | Beleg |
|---|---|---|---|---|
| K01 | Pflicht | Backend-, Frontend-Unit-, E2E- und Visual-Suiten grün auf dem Release-Commit | ✅ 173 / 71 / 73 / 22 | 03 §3 |
| K02 | Pflicht | E2E zweimal ohne Retries ohne Fehlschlag | ✅ | 03 §3 |
| K03 | Pflicht | Kernpfad Suche → Vormerken → Angebot → Alarm → Kauf → Bibliothek fehlerfrei | ✅ (Fixture) | 03 §5 |
| K04 | Pflicht | Kein Null-, Negativ- oder Fehlerpreis in Badge, Preis, Angeboten, Warenkorb, Alarm | ✅ (14 Fälle) | 03 §4 |
| K05 | Pflicht | Veraltete, fehlerhafte, geschätzte und unbekannte Angaben in jeder Preisansicht eindeutig gekennzeichnet, nicht als Ersparnis oder Aktion angeboten | ❌ FUNC-03, FUNC-12, RESP-11 | 03, 05 |
| K06 | Pflicht | Katalog- oder Shop-Ausfall erscheint nie als leeres Ergebnis | ✅ | 03 §5 |
| K07 | Soll | HTTP-Fehlerklassen (429, 503, 403, Retry-After) per Test abgesichert | ⬜ FUNC-07 | 03 |
| K24 | Pflicht | Ein pausierter Wunsch zeigt keinen Such- oder Wartezustand und löst kein Dauer-Polling aus | ❌ CODE-01 | 02 |
| K25 | Soll | Dauerhaft tote Links (404, Parserfehler) werden gedrosselt und gemeldet | ❌ FUNC-13, SCORE-06 | 03, 11 |
| K18 | Soll | Parser gegen aktuelles Live-Markup geprüft (Kanarienlauf vor dem Release, von Hand oder automatisiert) | ⬜ | 03, 07 PROD-13 |

## B. Datenqualität und Datenkonsistenz

| # | Pflicht | Kriterium | Status | Beleg |
|---|---|---|---|---|
| K08 | Pflicht | Automatische Zuordnung nur bei eindeutiger Identität (Titel **und** Erscheinungsjahr bzw. Katalog-ID), keine bekannte Fehlzuordnungsklasse | ❌ FUNC-01 | 03 |
| K09 | Pflicht | Nicht-Key-Produkte (Konto, PC-only) können auch nach Bestätigung von Hand nicht als Key-Preis zählen | ❌ FUNC-04 | 03 |
| K10 | Pflicht | Preis, Trend und Verlauf folgen derselben Zielland-Regel (EU-Markt seit 0.9.0) | ❌ FUNC-02 | 03 |
| K11 | Pflicht | Persistenz aller Nutzerdaten über einen Neustart | ✅ | 03 |
| K12 | Pflicht | Höchstens ein aktiver Job je Shop, Wiederaufnahme nach Neustart ohne Burst | ✅ (Unit/DB, Simulation) | 03, 11 §7 |
| K26 | Soll | Frischegrenze und Abfrageintervall passen zusammen: Kein Angebot wird planmäßig „veraltet“ | ❌ FUNC-05, SCORE-04 | 03, 11 |
| K27 | Soll | Angebotszahl in Liste und Detail stimmen überein | ❌ FUNC-11 | 03 |

## C. Security

| # | Pflicht | Kriterium | Status | Beleg |
|---|---|---|---|---|
| K19 | Pflicht | Keine offenen SEC-Befunde P0/P1 | ❌ SEC-01 (Lead-Einstufung P1) | 06 §3.3 |
| K28 | Pflicht | Origin-/CSRF-Prüfung auf allen schreibenden Routen | ✅ (13 Fälle) | 06 §3.2 |
| K29 | Pflicht | Kein Client kann ohne Anmeldung den Login des Eigentümers sperren (Drossel je Quelle, Request-Timeouts) | ❌ SEC-01, SEC-02 | 06 |
| K30 | Pflicht | Keine bekannte ausnutzbare Schwachstelle in Abhängigkeiten; Rust-Abhängigkeiten werden in CI geprüft | ❌ SEC-04 (2 Advisories, derzeit nicht ausnutzbar; CI ohne cargo-audit) | 06 |
| K31 | Pflicht | Secrets nie in API, Log, Fehlermeldungen, Repo; Dateien 0600 | ✅ (gitleaks, Proben, 0.9.1-Prüfung) | 06, 10 |
| K32 | Soll | Passphrase änderbar, „überall abmelden“ möglich | ❌ SEC-03 | 06 |
| K33 | Soll | Betrieb hinter Reverse Proxy dokumentiert (Beispielkonfiguration, HSTS) | ❌ SEC-07 | 06 |
| K34 | – | XSS über gespeicherte Titel, Pfad-Traversal, SQL-Injection | ✅ (Proben ohne Befund) | 06 |

## D. Performance

| # | Pflicht | Kriterium | Status | Beleg |
|---|---|---|---|---|
| K22 | Pflicht | `/status/fetch` < 50 ms CPU und Claim < 5 ms bei 500 Wünschen | ❌ PERF-01 (257 ms / 35 ms) | 06 §4.2 |
| K35 | Pflicht | Kein Dauer-Polling unter 10 s im Normalbetrieb (auch bei Abrufrückstand) | ❌ PERF-02, CODE-01 | 06, 02 |
| K36 | Soll | Antworten komprimiert, statische Dateien mit Cache-Regeln (`index.html` no-cache, Assets immutable) | ❌ PERF-03, PERF-04 | 06 |
| K37 | Soll | CLS der Wunschliste < 0,1 | ❌ PERF-05 (0,42) | 06 |
| K38 | – | Leerlauf < 50 MiB RAM, < 1 % CPU | ✅ (25–36 MiB, 0,2 %) | 06 |

## E. Responsive, Design, Accessibility

| # | Pflicht | Kriterium | Status | Beleg |
|---|---|---|---|---|
| K20 | Pflicht | Kernansichten 375–2560 px ohne horizontalen Overflow des Dokuments | ✅ (240 Messungen) | 05 |
| K39 | Pflicht | Wunschliste und Angebote auf 375, 430, 768 und 1366 px vollständig bedienbar: alle Aktionen sichtbar, Titel lesbar, Preise beschriftet | ❌ RESP-01, RESP-02, RESP-03 | 05 |
| K40 | Pflicht | Favicon im Browser-Tab als KeyHunter-Zeichen erkennbar (nicht als „1“) | ❌ DS-01 | 04 |
| K21 | Pflicht | axe-Scan der Kernansichten ohne `critical` und ohne `serious` Kontrastverstöße | ❌ (keine critical; 227 Kontrast-Knoten bei 1366 px, DS-02) | 05, 04 |
| K41 | Pflicht | Fokus in allen Eingabefeldern sichtbar; Drawer mit Fokuseinschluss | ❌ DS-03, RESP-08 | 04, 05 |
| K42 | Soll | Touch-Ziele ≥ 44 px auf Touch-Geräten | ❌ RESP-09 | 05 |
| K43 | Soll | Statusfarben und -texte einheitlich (Ziel erreicht, veraltet, fehlend) | ❌ DS-04, RESP-18 | 04, 05 |
| K44 | Soll | Visual-Regression deckt 768 px und Listen mit langen Titeln ab | ❌ DS-08 | 04 |

## F. Scoring und Abfrageplanung

| # | Pflicht | Kriterium | Status | Beleg |
|---|---|---|---|---|
| K45 | Pflicht | Kein Angebot hungert dauerhaft aus (Produkte spätestens nach 2 × Intervall) | ✅ (Simulation, kreuzvalidiert mit dem Rust-Code) | 11 §7 |
| K46 | Pflicht | Hohe Priorität führt nie zu mehr Anfragen als das Tagesbudget | ✅ | 11 §2.3 |
| K47 | Soll | Angezeigter „Score“ ist korrekt beschriftet (Prüftempo, kein Qualitätsurteil) | ❌ SCORE-03 | 11 |
| K48 | Soll | Fairness-Test für Klassen 2–5 kann fehlschlagen und ist grün | ❌ SCORE-05 | 11 |

## G. Deployment, Update, Backup, Doku

| # | Pflicht | Kriterium | Status | Beleg |
|---|---|---|---|---|
| K23 | Pflicht | CI (`checks.yml` inkl. fmt, clippy, npm audit) grün auf dem Release-Commit | ✅ 0.9.1: PR #17 und `container.yml` grün | 10 |
| K13 | Pflicht | Upgrade vom ältesten unterstützten Stand (0.5.0) ohne Datenverlust, mit automatischer Sicherung | ✅ | 03 |
| K14 | Pflicht | Rückweg mit Vor-Migrations-Sicherung und Vorgänger-Image | ✅ | 03 |
| K15 | Soll | Dokumentiertes Kaltbackup praktisch wiederhergestellt | ⬜ | 03 |
| K49 | Pflicht | Container läuft ohne Root (Rechteabgabe), Healthcheck grün, SIGTERM sauber | ✅ | 06 §5 |
| K50 | Pflicht | Abnahmetest auf echtem Unraid (Template-Installation, Update, Neustart) | ⬜ PERF-14 | 06 |
| K16 | Pflicht | Betriebs- und Datenquellen-Doku entspricht dem Verhalten | ❌ FUNC-08, CODE-09, SCORE-10 | 02, 03, 11 |
| K17 | Pflicht | Erlaubte Nutzung je Datenquelle dokumentiert (Eneba, Driffle, IGDB, Microsoft-Katalog) | ❌ FUNC-09 | 03 |
| K51 | Soll | Import der Wunschliste bzw. geführte Wiederherstellung | ❌ PROD-01 | 07 |
| K52 | Soll | Erststart erklärt Einrichtungscode, IGDB-Zugang und Benachrichtigungskanal | ❌ RESP-15, PROD-02 | 05, 07 |
| K53 | Soll | Frontend mit Formatter und Linter in CI | ❌ CODE-04 | 02 |

## Zusammenfassung

| Status | Anzahl | davon Pflicht |
|---|---|---|
| ✅ bestanden | 18 | 16 |
| ❌ fehlgeschlagen | 31 | 16 |
| ⬜ nicht getestet | 4 | 1 (K50) |
| Summe | 53 | 33 (dazu 2 Kriterien ohne Einstufung: K34, K38) |

**Lesart:** Die Kernfunktion besteht ihre Pflichtkriterien: Tests, kein Fehlerpreis, Persistenz, Upgrade und Rückweg, Container-Härtung, keine Secret-Lecks. Die nicht erfüllten Pflichtkriterien liegen in vier Gruppen: Bedienbarkeit auf Phone und Tablet, Login-Verfügbarkeit, ehrliche Zustände und Zuordnungsgenauigkeit, Doku. Alle sind mit begrenztem Aufwand behebbar (siehe 08).

## Geprüfte Befehle und Grenzen

Die Status stammen aus den Belegen der Dokumente 02–07 und 11. Der Lead hat zusätzlich nachgeprüft: die Ursache des Favicons (eigene Darstellung, `evidence/lead/`), SEC-01 im Code, PERF-01 im Code, CODE-01 anhand der Pausen-Screenshots aus 0.9.0, FUNC-02 im Code (`price_badges.rs:189-192` vergleicht `market` mit dem Zielland), SCORE-05 im Code (`jobs.rs:2019-2025` vergleicht mit Zeitpunkt 0), RESP-01 und RESP-02 auf den Screenshots sowie K23 anhand der GitHub-Läufe von 0.9.1. Alles Weitere ist in `10_AUDIT_EVIDENCE.md` gesammelt.
