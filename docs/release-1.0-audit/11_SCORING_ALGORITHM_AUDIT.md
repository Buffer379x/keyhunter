# 11 – Audit des adaptiven Scoring- und Abfrage-Algorithmus (SCORE)

Stand: KeyHunter v0.9.1 (Branch `audit/release-1.0`, Commit 490a8fb). Prüfer: Scoring-Auditor (Präfix SCORE).
Ausschließlich analytisch: kein Anwendungscode, kein Intervall und keine Konfiguration wurden geändert.
Evidenz, Skripte und Rohdaten: `docs/release-1.0-audit/evidence/scoring/` (Befehle in `README.md` dort).

## Kurzfazit

- **Was es ist:** Der „Score“ ist kein eigenes Bewertungsmodell. Er ist exakt `100 · (1 − cheap_score)` und damit nur die
  Anzeige des Abfragetempos. Das Tempo kommt aus einem gleitenden Mittel (Gewicht 0,2) der Min-Max-Preisposition eines
  Angebots unter allen Regionen seines Spiels. Das Ergebnis ist ein Faktor 0,5–2 auf das Shop-Intervall. In die
  Reihenfolge der Abfragen gehen Score und Trend nicht ein, dort zählen nur Klasse und Fälligkeit.
- **Korrekt und robust im Kleinen:** Die Formeln sind begrenzt, monoton und deterministisch. Kein Angebot hungert
  dauerhaft aus: Ein Produkt wird spätestens nach 2 × Intervall geprüft, bei Budgetengpass der Reihe nach. Ein Neustart
  erzeugt keinen Burst. Das Python-Modell reproduziert den echten Rust-Code Job für Job (1021 von 1021 Jobs identisch).
- **Kein messbarer Gesamtnutzen gegenüber festen Intervallen.** Bei gleichem Budget erkennt B (aktuell) relevante
  Änderungen genauso oft wie A (fest): 83,9 % gegen 83,3 %. Bei gleicher Erkennungsrate spart B etwa 3 % der Abfragen.
  B verschiebt aber Aktualität vom günstigsten Preis weltweit (Bestpreis falsch −2,2 pp, in 5 von 5 Seeds besser) zum
  Nachteil des **besten im Zielland gültigen Preises**, auf dem die Preisalarme beruhen: dort +2,5 pp ohne Engpass und
  +4,7 pp mit Engpass, in 5 von 5 Seeds schlechter. Ursache: Die Zielland-Gültigkeit geht bewusst nicht in den Trend ein
  (SCORE-01).
- **Der Haupthebel ist das Budget, nicht der Algorithmus.** Mit dem Standardbudget von 500 Abfragen am Tag bindet das
  Budget ab etwa 50 Spielen (≈ 300 Angebote). Bei 100 Spielen ist knapp ein Viertel der Angebote älter als 24 h und zählt
  nicht mehr als aktueller Preis, bei 300 Spielen sind es drei Viertel; dort liegen alle Verfahren innerhalb von 2 pp.
- **Kandidat C** ändert nur das Positionssignal: logarithmischer Abstand zum günstigsten Preis weltweit und, bei
  gültigen Angeboten, zum günstigsten gültigen Preis. Bei gleichem Budget erkennt C +2,8 pp mehr (ohne Engpass) bzw.
  +1,0 pp mehr (mit Engpass). Der falsche Zielland-Bestpreis sinkt um 3,9 bzw. 6,8 pp, der Weltpreis bleibt etwa gleich
  (+0,7 bzw. +0,2 pp). Das gilt in 5 von 5 Seeds. Bei gleicher Erkennungsrate wie B braucht C etwa 20 % weniger Abfragen.
- **Empfehlung:** Für 1.0 ist keine Algorithmusänderung nötig, es gibt keinen Blocker. Vor 1.0 sollten die Doku
  korrigiert, der wirkungslose Fairness-Test repariert und der Score in der Oberfläche ehrlich beschriftet werden
  (SCORE-03, -05, -10). C, ein Backoff für tote Links und die Kopplung an die 24-h-Regel sind Kandidaten für 1.1.

## 1 Methode und Belastbarkeit

| Baustein | Was | Belastbarkeit |
|---|---|---|
| Code-Rekonstruktion | `backend/src/jobs.rs` vollständig, `offers.rs`, `pricing.rs`, `alerts.rs`, `shops/{mod,http}.rs`, Migrationen 0003/0011/0014/0016, Frontend-Anzeige, Doku/CHANGELOG | bestätigt (Datei:Zeile) |
| Python-Modell | `evidence/scoring/sim/khsim.py` bildet Claim, Klassen, Budget, Pacing, Bypass, Lease, Retry-Leiter, Jitter, Trend, Intervall und Score nach | **gegen den echten Rust-Code kreuzvalidiert**: 3 Szenarien, 1021 Jobs, Zeitpunkt, Art, Link, Ergebnis, `due`, `pace`, `relevance`, `cheap_score` identisch (`xval/`); 43 Selbstprüfungen gegen die Rust-Testwerte |
| Synthetische Verläufe | `sim/traces.py`, feste Seeds, 10 Verlaufstypen und Randfälle | Hauptbenchmark; Generator grob an der echten DB-Kopie kalibriert, eher ruhiger als die Stichprobe |
| Echte Daten | `work/phase_b_database/keyhunter.db` (Schema 0010), read-only kopiert, nur Aggregate | **für eine historische Wiedergabe ungeeignet**: 221 Beobachtungen, 115 Links, 35,3 h, Median 2 Beobachtungen je Link, vor Migration 0012/0016 (kein `cheap_score`/`pace`), Abstände 8–16 h vom alten Scheduler bestimmt, Zwischenänderungen unbekannt |
| SQL-Kosten | echte Claim-/Trend-/Demand-SQL aus `jobs.rs` auf SQLite 3.46.1 (Python) mit 100–30 000 Jobs | Näherung (nicht die von sqlx gebündelte SQLite) |

Kein Data Leakage: Der Scheduler im Modell sieht ausschließlich das Ergebnis eines Abrufs zum Abrufzeitpunkt
(`khsim.py` `execute()`); die Wahrheit (Verlauf) wird nur in `metrics.py` nach dem Lauf benutzt.

Echte Kennzahlen der DB-Kopie (`results/db_stats.json`): Änderungen des günstigsten Angebots je Link und Tag
\> 0 %: 0,93; > 2 %: 0,45; > 5 %: 0,28; > 10 %: 0,21; 20,8 % der Beobachtungen ausverkauft; 4 Regionen je Spiel im Median
(1–22); Preisverhältnis teuerstes/günstigstes Angebot je Spiel Median 1,7 (bis 9,7); 8 von 125 Links mit letztem Fehler
`rate_limited`. Der Generator liefert, im selben 12,5-h-Raster beobachtet: 0,74 / 0,25 / 0,20 / 0,15 und 20 % ausverkauft.

## 2 Rekonstruktion (A)

### 2.1 Begriffe und Datenfluss

| Größe | Speicherort | Bedeutung |
|---|---|---|
| Preistrend `cheap_score` ∈ [0,1] | `offer_link.cheap_score` (Migration 0016, Start 0,5) | gleitender Mittelwert der relativen Preisposition eines Produkts unter allen Regionen desselben Spiels |
| Tempo `pace` ∈ [0,5; 2] | `shop_job.pace` (Migration 0016, Start 1) | Faktor auf das Shop-Intervall |
| `relevance` ∈ {1,2} | `shop_job.relevance` (Migration 0011, Start 1) | 1 = lieferbar mit Preis, 2 = ausverkauft/ohne Preis (`jobs.rs:407-415`); steuert nur die Claim-Klasse 1 vs. 3 |
| Score 0–100 | nicht gespeichert, `offers.rs:180-186` | reine Anzeige des Intervallfaktors |
| `due` | `shop_job.due` | Fälligkeit; nach Erfolg Abschlusszeit + effektives Intervall |

Neu berechnet wird **nur nach einem erfolgreichen Produktabruf** (`jobs.rs:571-582`, `608-617`, `628-634`).
Nach einem Fehler bleiben `cheap_score`, `pace` und `relevance` unverändert (`COALESCE`, `jobs.rs:609`); für die
Wiederholungszeit wird aber mit Tempo 1,0 gerechnet (`jobs.rs:581`).

### 2.2 Berechnung

1. **Preisposition** (`jobs.rs:437-442`, `458-496`): eigener niedrigster gültiger Grundpreis `own` (1 ct … 100 000 €,
   `pricing.rs:100-115`, ohne Gebühren) und die Preise aller anderen *bestätigten*, lieferbaren Links desselben Wunsches
   aus **allen Regionen und beiden Shops**, deren letzte erfolgreiche Messung höchstens 7 Tage alt ist:
   `p = (own − min) / (max − min)`; ohne Vergleich (ein Preis oder alle gleich) `p = None`.
2. **Trend** (`jobs.rs:445-449`): `s' = clamp(s + 0,2·(p − s), 0, 1)`; bei `p = None` bleibt `s` unverändert.
   Halbwertszeit 3,1 Messungen; von 0,5 auf < 0,1 in 8 Messungen.
3. **Tempo** (`jobs.rs:452-454`): `pace = 2^(2s'−1)` (0 → 0,5; 0,5 → 1; 1 → 2).
   Ausverkauft, ohne Preis oder Verfügbarkeit unbekannt: `pace = 2`, `s` bleibt (`jobs.rs:472-476`).
4. **Intervall** (`jobs.rs:419-423`): `round(I · (2 bei Editionsvorschau) · clamp(pace, 0,5, 2))`, begrenzt auf
   `[min(900 s, I), 7 Tage]`. `I` = `source_settings.poll_interval_seconds` (900 s … 7 Tage, Standard 8 h, Migration 0008).
   Bei 8 h: günstigste Region 4 h, Mitte 8 h, teuerste und ausverkauft 16 h, Vorschau 8–32 h.
5. **Score** (`offers.rs:180-186`): `clamp(round(50·(1 − log2(pace·v))), 0, 100)` mit `v = 2` für Vorschauen.
   Eingesetzt ergibt sich exakt **Score = 100·(1 − cheap_score)** für lieferbare Wünsche, 0 für ausverkaufte,
   `max(0, 50 − 100·cheap_score)` für Vorschauen. Der Score ist damit eine Umskalierung des Trends; er steuert nichts.
6. **Nach Erfolg** (`jobs.rs:368-375`, `384-389`): Produkt `t + Intervall`; Suche `t + max(7 Tage, I)`;
   Discovery `t + max(1 Tag, I)` (Driffle: Wartezeit der Sitemap). `t` ist die Abschlusszeit, nicht die Fälligkeit:
   Wartezeiten addieren sich, es gibt keinen festen Takt.
7. **Nach Fehler** (`jobs.rs:390-403`, `67`, `583`): Netzwerk/429: 120 s, 600 s, 3600 s, danach das Intervall mit Tempo 1;
   404, Parse-Fehler, Zugriff verweigert: sofort das Intervall mit Tempo 1. Dazu `max(Quellpause, Wartezeit + Jitter)`,
   Jitter 0–30 s aus dem zufälligen Lease-Token, **nur bei Fehlern**. 429 pausiert den ganzen Shop für `Retry-After`
   (Standard 900 s, 60 s … 7 Tage, `shops/http.rs:146-164`), „Zugriff verweigert“ für 3600 s (`shops/mod.rs:260-265`).
   `failures` steigt bis 20, Erfolg setzt 0.

### 2.3 Scheduler: Priorität, Budget, Pacing

- **Claim-Klassen** (`jobs.rs:209-220`): 0 angeforderte Aktualisierung (15 min) und erste Suche eines Wunsches;
  4 alles einer Editionsvorschau; 5 Discovery; Produkt 1 (`relevance=1`) bzw. 3 (`relevance=2`); Suchfolgeseite 1;
  Wiederholungssuche 2.
- **Reihenfolge** (`jobs.rs:284-296`): `ORDER BY Rang, due, id`. Rang = Klasse; bei jedem vierten Job des UTC-Tages
  (`jobs_today % 4 = 3`) Rang 1 für alle Klassen ≥ 2 und Rang 2 für Klasse 1. Innerhalb eines Rangs gilt strikt
  „am längsten fällig zuerst“, Gleichstand nach `id`. **Score und Trend gehen in die Reihenfolge nicht ein**, nur über `due`.
- **Budget** (`jobs.rs:96-103`, `237`, `317-325`): `daily_jobs` (20–2000) oder `KEYHUNTER_SHOP_DAILY_JOBS` (1–2000) oder 500
  je Shop und UTC-Tag; jeder Claim zählt, auch fehlgeschlagene und abgebrochene.
- **Pacing** (`jobs.rs:105-110`, `326-331`): nach jedem nicht direkten Job `paced_until = t + clamp(Resttag / Restbudget, 20 s, 1 h)`,
  persistent in `shop_state`.
- **Direkte Nutzeraktion** (`jobs.rs:222-229`): Klasse 0 oder `initial=1` (erste Suche, erster Preis eines vom Nutzer
  angelegten Links) überspringt das Pacing, nie das Budget.
- **Lease** 180 s (`jobs.rs:303`), ein Job je Shop gleichzeitig (`jobs.rs:287`), Worker schläft 2 s nach einem Job und 3 s im
  Leerlauf (`jobs.rs:147-151`); pro Host mindestens `Crawl-delay`, mindestens 2 s, Abstand (`shops/http.rs:72-74`, `276-291`).
- **Bedarfsschätzung** `demand()` (`jobs.rs:909-936`) und **Vorschau** `upcoming()` (`jobs.rs:1205-1299`) benutzen dieselben Regeln;
  Wiederholungen nach Fehlern und Wartezeiten zählen sie nicht.

### 2.4 Behandlung der Sonderfälle laut Code

| Fall | Verhalten | Quelle |
|---|---|---|
| neues Angebot ohne Historie | `cheap_score` 0,5, Tempo 1, Klasse 1, `due` = Anlage; aus Nutzeraktion ohne Pacing | Migr. 0016, `jobs.rs:30-38`, `804-812` |
| wenige Datenpunkte | erste Messung verschiebt 0,5 um ein Fünftel; keine Unsicherheitsbehandlung | `jobs.rs:445-449` |
| nur ein Angebot / alle Preise gleich | Trend **friert ein** (bleibt auf dem letzten Wert, nicht auf 0,5) | `jobs.rs:439-449` |
| Fehlschlag | Trend/Tempo unverändert, Retry-Leiter, danach Intervall mit Tempo 1 (günstige Angebote dann seltener, teure häufiger als nach Plan) | `jobs.rs:390-403`, `581` |
| dauerhaft 404 / Parse | jedes Intervall erneut, Klasse bleibt 1 (`relevance` unverändert) – häufiger als ein ausverkauftes Angebot | `jobs.rs:397`, `609` |
| ausverkauft / kein Preis | Tempo 2 sofort, Klasse 3 (nur Restkapazität und jeder 4. Job) | `jobs.rs:216`, `472-476` |
| Händlerunterschiede | eigenes Budget, Intervall, Worker je Shop; Trend vergleicht über beide Shops hinweg, ohne Gebühren | `jobs.rs:478-481`, `pricing.rs:107-115` |
| Höhe/Häufigkeit von Preisänderungen | **gehen nicht ein**; nur die Position zwischen billigstem und teuerstem Angebot zählt | `jobs.rs:437-496` |
| Zielland | **geht nicht ein** (seit 0.6.5 bewusst) | `jobs.rs:19`, `456-457`, CHANGELOG 0.6.5 |

### 2.5 Magic Numbers

`TREND_WEIGHT 0.2`, `PACE_FASTEST 0.5`, `SOLD_OUT_PACE 2.0`, `MIN_INTERVAL 900`, `TREND_PRICE_AGE 7 d` (`jobs.rs:425-435`),
`RETRY_LADDER 120/600/3600`, `REQUEST_WINDOW 900`, `DEFAULT_DAILY_JOBS 500`, `PACE_MIN/MAX 20/3600` (`jobs.rs:64-83`),
Lease 180 s (`jobs.rs:303`), Jitter `% 31` (`jobs.rs:583`), „jeder 4.“ (`jobs.rs:290`), `FRESH 24 h` (`pricing.rs:18`),
Retry-After-Standard 900 s (`shops/http.rs:162`), Discovery-Kandidaten 40 000 (`jobs.rs:666`). Alle sind benannt und
dokumentiert; widersprüchlich ist nur das Zusammenspiel von `FRESH` (fest 24 h) mit Intervall × Tempo (bis 14 Tage), siehe SCORE-04.

### 2.6 Abgleich mit Doku und Absicht

| Aussage | Code | Status |
|---|---|---|
| CHANGELOG 0.6.5/0.8.2, `docs/data-sources.md:77-79`: Trend über alle Regionen, 0,5–2, Score 0/50/100, ausverkauft Tempo 2 | wie beschrieben | stimmt |
| `docs/data-sources.md:41`: „Varianten, die im Zielland nicht zählen können, werden dreimal seltener … abgefragt“ | seit 0.6.5 entfernt | **veraltet** |
| `docs/operations.md:43`: Budget „dann an Preise aktiver Wünsche, die im Zielland gelten können“; 4. Job u. a. für „andere Regionen“ | Klasse 1 = jedes lieferbare Produkt aller Regionen | **veraltet** |
| `docs/data-sources.md:65`, `docs/operations.md:84`: „Fehlerwiederholungen warten mindestens das konfigurierte Intervall“ | Netzwerk/429 nach 2/10/60 min (`jobs.rs:67`); `operations.md:43` beschreibt das richtig | **widersprüchlich** |
| `offers.rs:147`, `frontend/src/features/offers-model.ts:12`: Intervall aus „validity in the target country“ | Zielland spielt keine Rolle | **veralteter Kommentar** |
| `docs/data-sources.md:59`, `docs/operations.md:86`: 100 Wunschlistenplätze | seit 0.9.0 unbegrenzt | veraltet (nicht Scoring) |
| Modul-Doku `jobs.rs:15-16`: jeder 4. Job „so lower classes keep a share“ | stimmt formal; bei Engpass reicht der Anteil nicht (SCORE-05) | Absicht nur teilweise erreicht |

## 3 Mathematische und logische Bewertung (B)

| Frage | Befund | Beleg |
|---|---|---|
| Normalisierung korrekt? | Formal ja, [0,1], keine Division durch 0 (`max>min`), kein NaN. **Aber betragsblind:** 10,00 € gegen 10,01 € ergibt die Positionen 0 und 1, also nach Konvergenz Tempo 0,5 gegen 2 für 0,1 % Unterschied. | `jobs.rs:439-442`; E3 |
| Ausreißer / Dominanz | Das teuerste Angebot bestimmt die Skala aller anderen. Bei {10; 10,50; 11; 50 €} liegen die ersten drei bei 0–0,025, haben also alle Tempo ≈ 0,5. Ein zusätzliches, irrelevantes 60-€-Angebot senkt das Tempo des besten Zielland-Angebots (18 €) von 0,87 auf 0,62. | Rechenbeispiele unter der Tabelle |
| Gewichtung | Es gibt nur eine Variable (die Position); Höhe und Häufigkeit von Änderungen, Zielland, Alarme und Nutzerinteresse fehlen. 0,2 entspricht etwa 10 Messungen Gedächtnis; das ist plausibel, aber nicht begründet oder gemessen. | `jobs.rs:425-426` |
| Sprünge | Der Trend ist glatt (höchstens 20 % je Messung). Sprunghaft ist nur „ausverkauft“: Tempo sofort 2 und zurück auf das Trend-Tempo beim ersten lieferbaren Abruf. | `jobs.rs:472-476` |
| Festhängen bei 0/100 | Asymptotisch, nicht hart: Eine Messung bewegt den Trend um ein Fünftel. Echtes Festhängen gibt es ohne Vergleich: Bei einem einzelnen Angebot oder gleichen Preisen bleibt der letzte Wert für immer (z. B. Score 100, obwohl das Angebot nicht mehr das günstigste ist, sobald die anderen ausverkauft sind). | `jobs.rs:445-449` |
| Kurzfristige Schwankungen | Bei fast gleichen Preisen springen die Positionen zufällig zwischen 0 und 1. E3 (6 Angebote innerhalb 1 %) endet mit Scores 26–60 ohne Sachgrund. Die Gesamtzahl der Abfragen bleibt aber wie bei A (2,9–3,4 je Tag und Angebot). | E3 |
| Seltene große Änderungen | Werden **nicht** bevorzugt. Lange stabile teure Regionen laufen mit Tempo 2. Ein Sturz um 60 % wird ohne Engpass im Mittel nach 7,7 h erkannt (max. 15,0 h), mit A nach 3,6 h (max. 7,5 h). Mit Engpass sind es 20,7 h (max. 34 h) gegen 13,5 h (max. 24 h). Vernachlässigt bis zum Aushungern wird nichts (Lücke ≤ 16 h bzw. ≤ 37 h). | E2 |
| Teuer und stark schwankend | Am schlechtesten bedient. 6-h-Einbrüche unter alle anderen Preise sieht B in 7 von 18 Fällen, A und C in 14 von 18. | E5 |
| Häufige minimale Änderungen überbewertet? | Nein, Änderungshäufigkeit ist gar kein Eingang. Sie wird aber auch nicht unterbewertet. | Code |
| Absolute Höhe vs. relative Position | Nur relative Position unter den aktuellen Regionen; weder Tiefstpreis-Historie noch Marktpreis noch absoluter Betrag. Ein günstiges, stabiles Angebot bekommt das doppelte Tempo ohne einen einzigen Änderungstreffer (E4: 6 Abfragen am Tag, 0 Änderungen). | E4 |
| Benachteiligung wenig Historie | Nein: Start 0,5 heißt neutrales Intervall. Vom Nutzer angelegte Angebote erhalten ihren ersten Preis in ≤ 0,6 min; per Discovery gefundene kommen ohne Engpass in ≤ 7 min, mit Engpass erst nach 13–16 h dran (hinter dem Rückstand). | E1 |
| Zu selten nach langer Konstanz | Konstanz selbst verlängert nichts (kein Backoff), nur die Position. Obergrenze 2 × Intervall, unter Engpass zusätzlich die Warteschlange. | `jobs.rs:419-423` |
| Zielland | Der Trend ignoriert es; das beste gültige Angebot liegt bei typischer Preisstreuung in der Mitte (Position 0,2–0,6), also bei Tempo 0,7–1,2. Die günstigste nicht aktivierbare Region bekommt 0,5. | E2 „Mitte“, Benchmark (SCORE-01) |

Rechenbeispiele (Tempo nach Konvergenz): {10,00; 10,01 €} → 0,5 / 2,0. {10; 10,5; 11; 50 €} → 0,50 / 0,51 / 0,52 / 2,0.
{10; 12; 18; 24; 30 €} → 0,50 / 0,57 / 0,87 / 1,32 / 2,0; mit zusätzlich 60 € → 0,50 / 0,53 / 0,62 / 0,74 / 0,87 / 2,0.

## 4 Effizienz (C)

Kernzahlen aus dem Benchmark (Abschnitt 6), Mittel über 5 Seeds; gepaarte Differenzen je Seed in `results/summary.md`:

| Frage | Ergebnis |
|---|---|
| eingesparte Abfragen | B gegenüber festen 8 h: −3 % Produktabfragen (736 statt 759 am Tag, R1). Bei gleicher Erkennungsrate braucht A 761 am Tag, B 736: Ersparnis ≈ 3 %. |
| rechtzeitig erkannt | R1: A 83,3 % / B 83,9 % / C 86,7 % (gleiches Budget); R2: 61,1 / 61,4 / 62,3 % |
| Verzögerung | R1 Ø 3,8 / 3,8 / 3,2 h, p90 7,2 / 8,4 / 5,8 h; R2 Ø 10,4 / 10,5 / 10,0 h |
| attraktive Angebote (≥ 10 % billiger) verpasst | R1 15,9 / 18,8 / 15,3 %; R2 40,3 / 40,9 / 39,3 % |
| Priorisierung attraktiver Angebote | B: weltweit erkannt 87,2 % (Ø 3,0 h), Zielland 80,2 % (Ø 4,7 h); A: beide 84 % (3,8 h); C: beide 88,8 % (2,8 h) – R1, eigene Grundintervalle |
| Ertrag je Abfrage nach Score (R1, B) | erkannte relevante Änderungen je 100 Abfragen: Score 0–19: 6,6; 20–39: 6,7; 40–59: 6,0; 60–79: 3,9; 80–100: 6,8. 39 % der Abfragen gehen an Score 80–100, ohne höheren Ertrag. Mit Engpass (R2) steigt der Ertrag mit dem Score (9,3 → 21,9). |
| schwankende uninteressante Angebote | Kein Mehraufwand durch Schwankung (geht nicht ein); bei Fast-Gleichstand zufällige Verteilung (E3) |
| gemeinsame Aktualisierung eines Spiels | gibt es nicht; „Kontext-Refresh“ (nächstbeste Angebote vorziehen, wenn der Bestpreis steigt) gemessen: R1 +18 Abfragen am Tag bei gleicher Erkennung, R2 ohne Effekt → nicht empfohlen |
| Händlerlimits / Connector-Kosten | Tagesbudget je Shop und gleichmäßige Verteilung halten die Last klein (Spitze 21/h bei 500, 59–85/h bei 2000). Keine Anpassung nach 429 (SCORE-08). |
| Abfrage-Spitzen / Verteilung | Keine Spitzen: auch nach einem Neustart 24 statt 21 Jobs in der ersten Stunde (E10). Direkte Nutzeraktionen laufen gebündelt (8 Angebote in < 1 min, E1). |
| größere Wunschlisten (Budget 500) | 10 / 25 / 50 / 100 / 200 / 400 Spiele: B erkennt 83 / 83 / 73 / 57 / 42 / 30 %; nicht aktuelle Angebote 0 / 0 / 0,1 / 23 / 63 / 81 %; max. Alter 16 / 18 / 30 / 63 / 139 / 284 h. Die Erkennungsraten von A, B und C liegen ab 100 Spielen innerhalb von 1–2 pp. |
| Rechtfertigt ein hoher Score immer mehr Abfragen? | **Nein.** Ohne Engpass bringt die Score-Klasse 80–100 je Abfrage nicht mehr als 0–19. Ausgerechnet teure, schwankende Angebote, die attraktive Einbrüche liefern, bekommen das niedrigste Tempo (E5). Mit Engpass besteht ein Zusammenhang; dann wirkt das Tempo aber kaum, weil alle Abfragen der Reihe nach laufen. |

**Warum der adaptive Teil unter Engpass verpufft:** `due = Abschluss + Intervall` und `ORDER BY Klasse, due`
(`jobs.rs:292`). Sobald der Rückstand W größer ist als die Intervalle, wird jedes Angebot nach etwa `Intervall + W`
geprüft, das Verhältnis 4 h : 16 h schrumpft gegen 1 : 1. Die Alternative „Intervalle proportional strecken, wenn der
Bedarf das Budget übersteigt“ wurde gemessen. Sie ist **schlechter**: Sie nutzt nur 85 % des Budgets, und der
Zielland-Bestpreis ist in 42,9 % statt 33,1 % der Zeit falsch (R2). Sie wird verworfen.

## 5 Alternativen (D)

| Ansatz | Bewertung | gemessen |
|---|---|---|
| EWMA | bereits vorhanden (Gewicht 0,2); ausreichend | – |
| Positionssignal: log. Abstand zum Bestpreis statt Min-Max (C ohne Zielland) | schlicht, ausreißerfest, betragssensibel; R1: −7 % Abfragen bei +0,5 pp Erkennung; löst SCORE-01 allein nicht | ja |
| zusätzlich Abstand zum besten gültigen Zielland-Preis (C) | einzige Komponente mit großem, konsistentem Effekt (Zielland-Bestpreis −4 bis −7 pp) | ja |
| Bezugsverhältnis R = 4 statt 2 | mehr Abfragen (1004 statt 864 am Tag), kaum Gewinn → nein | ja |
| ausverkauft wie lieferbar (Tempo 1) | R1 +1 pp für +10 % Abfragen; R2 kein Gewinn → nein | ja |
| exponentielles Backoff | nur für dauerhaft tote Links sinnvoll (SCORE-06); bei Netzausfällen verlängert es die Erholung | ja (E7) |
| Mindestfrequenz / Höchstalter | faktisch vorhanden (2 × Intervall, max. 7 Tage); unter Engpass nicht durchsetzbar ohne mehr Budget | – |
| Budget-proportionale Streckung | schlechter (siehe oben) → nein | ja |
| Kontext-Refresh bei neuem Bestpreis | kein messbarer Gewinn → nein | ja |
| statistische Änderungswahrscheinlichkeit (Volatilität) | würde E5 helfen, aber häufige Minimaländerungen belohnen (SPEC-Warnung); ohne echte Langzeitdaten nicht kalibrierbar → nicht empfohlen | nein |
| Wunschlisten-/Alarm-Priorität | Alarme hängen am Zielland-Bestpreis; C deckt das ab, ohne neue Eingänge | indirekt |
| händlerabhängige Budgets | vorhanden (`daily_jobs` je Shop) | – |
| Jitter | nicht nötig: ein Worker je Shop und das Pacing serialisieren, Synchronisationseffekte gibt es nicht | E10/E12 |
| Exploration vs. Exploitation | durch die Obergrenze 2 × Intervall bereits erfüllt | – |
| ML | keine Daten (35 h echte Historie) → ausgeschlossen | – |

## 6 Simulation (E)

**Aufbau.** Ein Shop mit 2 s je Abruf und dem echten Worker-Takt. Gemessen werden 45 Tage, ausgewertet ab Tag 5, mit
5 Seeds. Jedes Spiel hat Suchjobs und eine Discovery, die das Budget mitbenutzen. Regime: R1 40 Spiele (Ø 252 Angebote)
mit Budget 2000, das nicht bindet; R2 80 Spiele (Ø 508) mit Budget 500; R3 300 Spiele (Ø 1905) mit 500; R3b 300 Spiele
mit 2000. Shop-Intervall 8 h. **Vergleichbares Budget:** Wo A oder C ohne Engpass mehr als 2 % von B abweichen, wird ihr
Grundintervall per Bisektion so gewählt, dass sie genauso viele Produktabfragen machen wie B („gleiches Budget“: A
8,23 h, C 9,38 h). Für die Ersparnisfrage wird zusätzlich auf die gleiche Erkennungsrate kalibriert (A 7,99 h, C 11,78 h).
Mit Engpass nutzen alle das volle Tagesbudget.

**Relevante Preisänderung** (`sim/metrics.py`, Kopf): Je Spiel zählen WELT, der günstigste lieferbare Preis aller
Regionen, und ZIEL, der günstigste lieferbare, im Zielland gültige Preis. Relevant ist eine Änderung, die WELT oder ZIEL um
≥ max(2 %, 20 ct) verschiebt oder einen der beiden entstehen bzw. verschwinden lässt. Attraktiv ist eine Senkung um
≥ 10 %. Erkannt ist sie, wenn der erste erfolgreiche Abruf danach den neuen Zustand noch zeigt; sonst ist sie verpasst.
„Bestpreis falsch“ bedeutet: Der angezeigte Wert nach den App-Regeln (`pricing.rs:120-160`: Abruf erfolgreich,
≤ 24 h alt, lieferbar, gültig) weicht um ≥ max(2 %, 20 ct) von der Wahrheit ab oder fehlt. Gemessen wird alle 10 min.

**Methodische Einschränkungen:** Die echte Historie ist vom alten Scheduler geprägt und zu kurz, deshalb gibt es keine
Wiedergabe. Der Generator liegt bei Änderungen > 2 % unter der echten Stichprobe, die Effekte sind daher eher
unterschätzt. „Verpasst“ ist streng: Bewegt sich ein Sonderpreis während des Angebots um > 2 %, zählt er als verpasst,
auch wenn ein Sonderpreis gesehen wurde. Das gilt für alle Verfahren gleich.

### 6.1 Ergebnisse (Mittel über 5 Seeds; vollständige Tabellen mit Min–Max: `evidence/scoring/results/summary.md`)

| Regime | Verfahren | Abfragen/Tag | erkannt | attraktiv verpasst | Verzög. Ø / p90 h | Abfr./Erkennung | Bestpreis welt falsch | Bestpreis Ziel falsch | > 24 h alt | max. Alter h |
|---|---|---|---|---|---|---|---|---|---|---|
| R1 | A fest 8 h | 759 | 84,0 % | 15,0 % | 3,8 / 7,1 | 14,4 | 12,4 % | 11,2 % | 0,0 % | 12 |
| R1 | A gleiches Budget (8,23 h) | 737 | 83,3 % | 15,9 % | 3,8 / 7,2 | 14,1 | 12,6 % | 11,4 % | 0,0 % | 13 |
| R1 | **B aktuell** | 736 | 83,9 % | 18,8 % | 3,8 / 8,4 | 14,0 | 10,4 % | 13,9 % | 0,0 % | 19 |
| R1 | C (8 h) | 864 | 88,8 % | 12,7 % | 2,8 / 5,0 | 15,5 | 9,6 % | 8,7 % | 0,0 % | 17 |
| R1 | **C gleiches Budget (9,38 h)** | 736 | 86,7 % | 15,3 % | 3,2 / 5,8 | 13,5 | 11,1 % | 10,0 % | 0,0 % | 20 |
| R1 | C gleiche Erkennung (11,78 h) | 585 | 83,7 % | 18,3 % | 4,1 / 7,5 | 11,1 | 13,6 % | 12,2 % | 0,3 % | 24 |
| R2 | A | 486 | 61,1 % | 40,3 % | 10,4 / 21,2 | 6,3 | 30,7 % | 28,4 % | 5,3 % | 49 |
| R2 | **B** | 487 | 61,4 % | 40,9 % | 10,5 / 20,9 | 6,3 | 28,5 % | 33,1 % | 9,4 % | 50 |
| R2 | **C** | 487 | 62,3 % | 39,3 % | 10,0 / 20,1 | 6,2 | 28,7 % | 26,3 % | 8,8 % | 55 |
| R3 | A / B / C | 453 / 469 / 469 | 33,9 / 34,5 / 34,5 % | 70,0 / 69,3 / 69,5 % | 36 / 36 / 35 | 2,9 / 3,0 / 3,0 | 80,9 / 79,0 / 79,2 % | 76,3 / 74,8 / 74,5 % | 76 / 75 / 75 % | 197 / 214 / 230 |
| R3b | A / B / C | 1953 / 1954 / 1954 | 63,5 / 63,4 / 64,6 % | 38,0 / 38,4 / 36,6 % | 10,0 / 9,9 / 9,5 | 6,7 / 6,7 / 6,6 | 27,0 / 25,5 / 25,7 % | 25,5 / 30,3 / 24,1 % | 1,5 / 6,3 / 5,5 % | 48 / 48 / 56 |

**Gepaarte Differenzen zu B** (gleiche Verläufe, gleiches Budget; „5/5“ = in allen Seeds dieselbe Richtung):
A − B: Zielland-Bestpreis falsch −2,5 pp (R1), −4,7 (R2), −4,9 (R3b), jeweils 5/5. Welt-Bestpreis falsch +2,2 / +2,2 / +1,4 pp,
B jeweils 5/5 besser. Attraktiv verpasst −2,9 pp (R1, 5/5).
C − B: erkannt +2,8 / +1,0 / +1,2 pp (5/5); attraktiv verpasst −3,5 / −1,6 / −1,8 pp; Zielland falsch −3,9 / −6,8 / −6,2 pp
(5/5); Welt falsch +0,7 / +0,2 / +0,2 pp (≈ neutral); Verzögerung −0,5 h (5/5). In R3 (75 % der Angebote > 24 h alt) liegen
alle Unterschiede unter 0,5 pp.

**Sonderangebote nach Dauer (R1, Anteil verpasst, A / B / C gleiches Budget):** 6 h: 29 / 35 / 15 %; 12 h: 6 / 14 / 6 %;
24 h: 8 / 8 / 5 %; 48 h: 7 / 9 / 7 %. Mit Engpass (R2) werden 6-h-Angebote von allen zu 74–78 % verpasst.

**Scheduler-CPU/RAM.** Die echte Claim-SQL (`sim/claim_bench.py`, SQLite 3.46.1) braucht 0,02 ms bei 100 Jobs, 0,75 ms bei
3000 Jobs und 7,6 ms bei 30 000 Jobs, wenn 30 % davon fällig sind. Die Leerlaufprüfung alle 3 s kostet unabhängig von der
Größe 0,008 ms, das sind < 0,001 % CPU. `demand()` (nur Statusseite) braucht 2,7 ms bei 3000 und 34 ms bei 30 000 Jobs.
Der Plan nutzt `shop_job_schedule (due<?)`; `NOT EXISTS running` ist ein korrelierter Scan, bei diesen Größen unkritisch.
RAM: Der Scheduler hält außer dem laufenden Job nichts im Speicher; die Vorschau lädt ≤ 200 Kandidaten je Shop
(`jobs.rs:1184`, `1218-1238`). Den RAM des Rust-Prozesses habe ich nicht gemessen.

## 7 Randfälle (F)

| Fall | Ergebnis (B, Vergleich A/C wo aussagekräftig) | Bewertung |
|---|---|---|
| neues Spiel ohne Historie (E1) | Nutzeraktion: erster Preis aller 8 Angebote nach ≤ 0,6 min (Bypass), unabhängig vom Engpass; per Discovery gefunden: ≤ 7 min ohne, 13–16 h mit Engpass; 10. Messung nach Ø 89 h (A 72 h) | gut; Discovery-Funde warten hinter dem Rückstand |
| monatelang konstant, dann Sturz −60 % (E2, 10 Phasen) | teuerste Region: Ø 7,7 h (A 3,6 h), max. 15 h; unter Engpass Ø 20,7 h (A 13,5 h), max. 34 h. Beste Zielland-Region: Ø 2,3 h (A 3,6 h, C 1,9 h) | nie dauerhaft vernachlässigt, aber teure Regionen doppelt so träge |
| plötzliches starkes Gefälle | wie E2 und Benchmark (attraktiv verpasst R1 18,8 %) | s. o. |
| häufige minimale Änderungen (E3) | gleiche Gesamtlast wie A; Scores zufällig 26–60; keine relevanten Ereignisse. C prüft hier alle doppelt (6/Tag): Preis der Ausrichtung auf Bestpreisnähe | B neutral, C verschwenderisch in diesem Spezialfall |
| sehr günstig und stabil (E4) | 6 Abfragen am Tag, 0 Änderungen; teurere schwankende Regionen 1,5–2,3/Tag | Verschwendung bei B (und C) |
| teuer und stark schwankend (E5) | Einbrüche unter alle anderen gesehen: B 7/18, A 14/18, C 14/18 | Schwäche von B |
| zeitlich begrenztes Angebot | 6-h-Angebote: B verpasst 35 % (A 29 %, C 15 %) | s. 6.1 |
| tagelange Fehlschläge (E7) | 3 Tage Shop-Ausfall: volles Budget (499/Tag) für Fehlschläge, keine Shop-Pause bei Netzfehlern; 95 % wieder frisch nach 24 h. 15 % tote Links (404): 19,6 % aller Abfragen gehen an tote Links; mit Backoff 6,9 %, Erkennung +2,9 pp, Zielland falsch −4,2 pp | SCORE-06, SCORE-07 |
| striktes Rate Limit (E8, Shop erlaubt 10/h) | Budget 500: 77 × 429 am Tag, 235 Abfragen, Erkennung 36 %; Budget 200: 0 × 429, Erkennung 42 % | Scheduler passt sich nicht an (SCORE-08) |
| tausende Angebote (E9, 3912 Angebote) | Budget 2000: 51 % der Angebote > 24 h, max. Alter 107 h; Budget 500: 88 %, max. 468 h; Simulations-CPU < 1 s; Algorithmusunterschiede < 2 pp | Budgetfrage, keine Algorithmusfrage |
| Neustart während eines Jobs (E10) | abgebrochener Job zählt zum Budget, Lease 180 s, Wiederholung 4,5 min nach Neustart; kein Burst (24 statt 21 Jobs/h) | robust |
| Systemzeit-Änderung (E11) | +6 h: +9 % Abfragen an dem Tag, sonst nichts. −6 h: −28 % Abfragen in 24 h, 4 % Angebote ungültig, Zielland falsch 13 → 21 %. −25 h: **24 h lang keine einzige Abfrage**, 41 % der Angebote nicht aktuell, Zielland falsch 56 % (A, B, C gleich) | SCORE-09 |
| gleicher Score / Gleichstand (E12) | Score geht in die Reihenfolge nicht ein; Gleichstand bei `due` strikt nach `id`; gleicher Seed → identisches Log (Hash `8cc2f0b58a0c6fc6`) | deterministisch; Jitter nur bei Fehlern (Zufall aus Token) |
| unterschiedlich schnelle Händler (E13) | Eneba 2 s / 500, Driffle 10 s / 150: 1,93 bzw. 0,65 Abfragen je Angebot und Tag; Trend vergleicht über Shops ohne Gebühren | unabhängig, nachvollziehbar |
| Datenlücken / fehlerhafte Historie (E14) | ein 4-h-Ausreißer (1 ct bzw. ×50) verschiebt die Abfragen der übrigen Angebote um ≤ 7 %; EWMA dämpft. Ein 1-ct-Preis würde aber als Bestpreis zählen (1 ct ist ein „gültiger“ Betrag, `pricing.rs:100-105`) – Preisvalidierung, nicht Scoring | Scoring robust |

**Deterministisch, nachvollziehbar, robust?** Bei gleichem Datenbankstand und gleicher Uhr deterministisch, mit Ausnahme
des Fehler-Jitters. Nachvollziehbar im Code, für Nutzer nur teilweise (Abschnitt 9). Robust gegen Neustart, Gleichstand
und Ausreißer, nicht robust gegen Rücksprünge der Uhr, dauerhaft tote Links und strikte Rate Limits.

## 8 Vorschlag (G)

### 8.1 Erhalten oder ändern?

**Erhalten:** Klassen, Budget, Pacing, Bypass, Lease, Retry-Leiter, EWMA, Tempobereich 0,5–2, Intervallgrenzen und die
Trennung von Intervall (`due`) und Priorität (Klasse). Diese Teile sind schlicht, gut getestet und messbar robust.
**Ändern (1.1):** nur das Positionssignal (C), dazu zwei kleine Fehlerpfad-Regeln (SCORE-06, -04). Kein Rewrite.

### 8.2 Kandidat C – Mathematik

Für ein lieferbares Angebot mit Grundpreis `own` und den Vergleichspreisen wie heute (`jobs.rs:477-494`):

```
pos_welt = clamp(log2(own / min_alle) / log2(R), 0, 1)
pos_ziel = clamp(log2(own / min_gültige) / log2(R), 0, 1)   nur wenn das Angebot im Zielland gültig ist (sonst 1)
p        = min(pos_welt, pos_ziel)                           R = 2: das Doppelte des Bestpreises gilt als irrelevant
s'       = s + 0,2 · (p − s)       pace = 2^(2s'−1)           unverändert
```

Wirkung: Bestpreis 0 → Tempo 0,5; +10 % → 0,61; +25 % → 0,78; +41 % → 1,0; ≥ +100 % → 2. Ein einzelnes Angebot gilt als
Bestpreis (Tempo 0,5) statt einzufrieren. Ausreißer nach oben verändern nichts mehr. „Gültig“ ist die Zielland-Prüfung
von `pricing::evaluate` ohne Aktualitäts- und Fehlergründe; die Daten liegen in `latest` bereits vor. Ausverkauft
behält Tempo 2 und Klasse 3. Nicht gültige günstigere Regionen werden nicht herabgestuft (Kernanwendungsfall): Ihr
`pos_welt` ist unverändert 0.

### 8.3 Parameter, Konfiguration, Händler, neue Angebote, Fehler

- Keine neuen Einstellungen. R = 2 und das Gewicht 0,2 bleiben Konstanten. R = 4 wurde gemessen und ist schlechter.
- Händlergrenzen unverändert (Budget/Pacing je Shop); eine hohe Priorität kann nie mehr Anfragen erzeugen als das Budget.
- Neue Angebote: wie heute (0,5, direkter erster Abruf bei Nutzeraktion).
- Fehler (SCORE-06): bei `not_found`/`invalid_response` Wartezeit `Intervall · 2^min(Fehler, 3)` (höchstens 8×, ≤ 7 Tage),
  Netzfehler unverändert (Backoff würde die Erholung nach Ausfällen verlängern; E7 zeigt keinen Nutzen).
- 24-h-Regel (SCORE-04): effektives Intervall lieferbarer Produkte höchstens 20 h, solange das Shop-Intervall ≤ 20 h ist.
  Alternativ ein Hinweis in den Einstellungen bei Intervall > 12 h.

### 8.4 Migration und Risiken

- Kein Schema-Update nötig. `cheap_score` behält Typ und Bereich, nur die Bedeutung ändert sich. Alte Werte gleichen sich
  nach etwa 8 Messungen an (≈ 1–3 Tage). Optional kann eine Migration den Wert auf 0,5 zurücksetzen; nötig ist das nicht.
- **Hauptrisiko: mehr Abfragen bei gleichem Intervall.** Mehr Angebote gelten als nahe am Bestpreis, der Tagesbedarf
  steigt um ≈ 17 % (R1: 864 statt 736). Wer knapp unter dem Tageslimit liegt, gerät in den Engpass; die vorhandene
  Bedarfsanzeige (`format.ts:103-118`) zeigt das an. Das muss in die Release-Notiz. Ein bedarfsneutraler Betrieb bräuchte
  ein Intervall von ≈ 9,4 h; Nutzereinstellungen sollen dafür nicht still geändert werden.
- Verhaltensrisiko: Fast gleich teure Angebote werden alle doppelt so oft geprüft (E3). Gesamtbilanz trotzdem positiv
  (Benchmark).
- Score-Anzeige: Die Bedeutung wird „Nähe zum relevanten Bestpreis“; Tooltip und Doku sind anzupassen (SCORE-03).

### 8.5 Test- und Validierungskonzept

1. Unit-Tests der Positionsfunktion: Beispiele aus 8.2; Monotonie im Abstand; Ausreißer-Invarianz (ein zusätzliches teures
   Angebot ändert die Position der anderen nicht); bestes gültiges Angebot → 0; einzelnes Angebot → 0.
2. `cheap_regions_are_checked_more_often_…` (`jobs.rs:2491`) anpassen: Das gültige 2,50-€-Angebot (dort `rows[4]`) muss als
   bester Zielland-Preis Tempo < 0,6 bekommen; das Sold-out- und das teuerste Verhalten bleiben gleich.
3. `demand_estimate_matches_an_unlimited_simulation` bleibt grün (gleiche Preise → alle Bestpreis → Tempo 0,5: Erwartung neu
   berechnen).
4. Fairness-Test reparieren (SCORE-05) und als Regressionsschutz behalten.
5. Offline-Benchmark als Abnahme: `python3 run_scenarios.py bench` mit dem Modell der neuen Regel; Kriterien bei gleichem
   Budget gegenüber B: Zielland falsch ≤ −2 pp, Welt falsch ≤ +1 pp, erkannt ≥ 0 pp in allen Seeds von R1/R2. Vorher
   Kreuzvalidierung des Modells gegen den neuen Rust-Code (`xval/run_xval.sh`) wiederholen.

### 8.6 Aufwand und Empfehlung

| Paket | Aufwand | Risiko | Ziel |
|---|---|---|---|
| Doku/Kommentare korrigieren (SCORE-10) | 1–2 h | keins | 1.0 |
| Fairness-Test reparieren, Erwartung festlegen (SCORE-05, Testteil) | 1–2 h | keins | 1.0 |
| Score-Spalte ehrlich beschriften oder standardmäßig ausblenden (SCORE-03) | 1–3 h | gering | 1.0 |
| Kandidat C inkl. Tests, Doku, Release-Notiz (SCORE-01/-02) | 6–10 h | mittel (Tagesbedarf +≈ 17 %) | 1.1 |
| Backoff tote Links (SCORE-06) | 1–3 h | gering | 1.1 |
| 24-h-Kopplung (SCORE-04) | 2–4 h | gering | 1.1 |
| Rate-Limit-Anpassung, Shop-Pause bei Netzausfall, Uhr-Rücksprung (SCORE-07/-08/-09) | je 2–4 h | gering–mittel | später |

**Empfehlung: kein Algorithmuswechsel für 1.0.** B ist funktionsfähig, begrenzt, deterministisch und nicht
gefährlich. Sein Nachteil gegenüber festen Intervallen betrifft den Zielland-Preis (2,5–4,9 pp) und ist kein Blocker.
C ist messbar besser und mit vertretbarem Aufwand umsetzbar. Wegen der Bedarfssteigerung gehört C in ein eigenes
Release mit Hinweis (1.1), nicht in die Stabilisierung vor 1.0.

## 9 Transparenz (H)

Vorhanden: Score-Spalte mit Farbe und Tooltip („Score X von 100 · meist günstig · Abfrage alle 4 h“,
`frontend/src/features/Offers.tsx:30-36`, `77-88`). Unter Infos → Produktzuordnungen „Abfrage alle … · meist günstig/teuer“
(`InfosTab.tsx:78`). Im Abrufstatus je Shop Budget, Bedarf (`demand_per_day`), Abstand, nächster Abruf, Abrufe je Stunde,
die nächsten 5 Jobs und 30 Tage Abrufhistorie (`jobs.rs:938-1108`, `format.ts:103-118`).

Lücken:
1. „Score“ klingt nach Angebotsqualität. Grün ist auch eine im Zielland **nicht aktivierbare** Region; das beste gültige
   Angebot ist oft gelb; ausverkauft ist rot. Die Spalte ist standardmäßig sichtbar (`offers-columns.ts:5`).
2. `check_every` ist das **geplante** Intervall. Unter Budgetengpass liegt das tatsächliche bei Intervall + Rückstand
   (R2: max. Alter 50 h bei „alle 4 h“). Je Angebot sieht man weder die nächste geplante Prüfung noch den Grund.
3. Wiederholungen nach Fehlern zählen nicht zum Bedarf (`jobs.rs:902-908`); dauerhaft fehlschlagende Links sind nicht
   als solche erkennbar.

Vorschlag ohne neue Komplexität für Endanwender: Spalte in „Prüftakt“ umbenennen und „alle 4 h“ statt einer Zahl zeigen,
oder standardmäßig ausblenden. Unter Infos „zuletzt erfolgreich · nächste Prüfung ca.“ aus `observed_at`/`due` anzeigen.
Liegt der Bedarf über dem Limit, im Abrufstatus das tatsächliche mittlere Intervall nennen, etwa „Preise werden im
Schnitt alle 26 h statt 8 h geprüft“. Eingesparte Abfragen oder Erfolgsquoten je Angebot braucht ein Endanwender nicht;
die Abrufhistorie deckt den Admin-Bedarf.

## 10 Bewertung (I)

| Kategorie | Note | Begründung |
|---|---|---|
| Mathematische Korrektheit | 6 | Formeln korrekt, begrenzt, monoton und kreuzvalidiert; Min-Max-Normierung betragsblind und ausreißerabhängig, Einfrieren ohne Vergleich |
| Logische Nachvollziehbarkeit | 7 | kleine, gut kommentierte Funktionen; Score = 100·(1−Trend) ist redundant, das Ignorieren des Zielland-Preises ist für Alarme kontraintuitiv, die Doku ist teils veraltet |
| Effizienz | 5 | spart gegenüber festen 8 h nur ≈ 3 % bei gleicher Erkennung; C zeigt ≈ 20 % Potenzial |
| Erkennung relevanter Änderungen | 5 | insgesamt wie feste Intervalle (83,9 gegen 83,3 %); Welt besser, Zielland schlechter; teure, schwankende Angebote schlecht (7/18) |
| Fairness gegenüber selten aktualisierten Angeboten | 6 | Produkte nie ausgehungert (≤ 2 × Intervall bzw. der Reihe nach); Klassen 2–5 unter Engpass aber faktisch ausgehungert (121/200 Vorschauen in 10 Tagen nie geprüft, Discovery 1× statt 10×), der zugehörige Test prüft nichts |
| Robustheit | 6 | Neustart, Gleichstand und Ausreißer robust; Uhr-Rücksprung, tote Links, strikte Rate Limits und Netzausfälle nicht |
| Skalierbarkeit | 6 | Scheduler-Kosten vernachlässigbar (7,6 ms bei 30 000 Jobs); die Qualität skaliert nur mit dem Budget, der Standard 500 bindet ab ≈ 50 Spielen |
| Wartbarkeit | 7 | konstante SQL-Bausteine, gute Unit-Tests; `upcoming()` dupliziert die Claim-Logik in Rust, ein Test ist wirkungslos |
| Gesamteignung für 1.0 | 6 | einsatzfähig und ungefährlich, aber ohne messbaren Nutzen gegenüber dem einfacheren Verfahren und mit Nachteil beim Zielland-Preis |

**Die sieben Fragen**

1. **Bereits sinnvoll und ausreichend?** Ausreichend für 1.0: Es gibt keinen Fehler mit Datenverlust, keine unkontrollierten
   Anfragen und kein Aushungern von Produkten. Sinnvoll nur eingeschränkt: Die Adaptivität bringt netto keinen Vorteil
   gegenüber festen Intervallen. Sie verlagert Aktualität vom Zielland- zum Weltpreis.
2. **Konkrete Schwächen:** Das Zielland wird ignoriert (SCORE-01). Die Min-Max-Normierung ist betragsblind und
   ausreißerabhängig, ohne Vergleich friert der Trend ein (SCORE-02). Teure, schwankende Angebote sind am trägsten (E5).
   Der Score ist irreführend beschriftet (SCORE-03). Die 24-h-Regel ist nicht gekoppelt (SCORE-04). Die Klassen 2–5
   hungern unter Engpass aus, der Test dazu ist wirkungslos (SCORE-05). Tote Links laufen ewig (SCORE-06). Es gibt keine
   Shop-Pause bei Netzausfall (SCORE-07) und keine Anpassung an 429 (SCORE-08). Ein Uhr-Rücksprung stoppt alles (SCORE-09).
3. **Einfacher oder nachweislich besser?** Einfacher und insgesamt gleich gut sind feste Intervalle (A): Der
   Zielland-Preis wird besser, der Weltpreis schlechter. Nachweislich besser ist C: gleiche Struktur, anderes
   Positionssignal. C ist bei gleichem Budget in allen Seeds und Regimen mit Spielraum besser oder gleich, beim
   Welt-Bestpreis ±1 pp.
4. **Praktischer Mehrwert:** Heute gering. Der spürbare Hebel ist das Verhältnis von Budget zu Wunschliste. Mit C
   gewinnt man messbar beim alarmrelevanten Preis: 3,9–6,8 pp weniger Zeit mit falschem Zielland-Bestpreis.
5. **Wie viele Abfragen zusätzlich einsparbar?** B gegenüber fest: ≈ 3 %. C gegenüber B: ≈ 20 % bei gleicher
   Erkennungsrate (585 statt 736 am Tag, 5/5 Seeds 19–24 %), dabei Welt-Bestpreis +3,2 pp schlechter und Zielland
   −1,7 pp besser. Tote Links mit Backoff: in E7 sinkt ihr Anteil von 19,6 % auf 6,9 % der Abfragen. Unter Engpass ist
   nichts einsparbar, es fehlt Budget.
6. **Einfluss auf Aktualität:** B gegenüber A: Welt-Bestpreis −2,2 pp falsch, Zielland +2,5 pp (R1) bzw. +4,7 pp (R2),
   maximales Datenalter 19 statt 12 h (R1), Angebote > 24 h 9,4 statt 5,3 % (R2). Ab Intervall 16 h sind bei B 8 %, bei
   24 h 23 % der Angebote durch Tempo 2 dauerhaft über der 24-h-Grenze (A: 0 %).
7. **Vor 1.0 notwendig oder später?** Vor 1.0 nur Doku, Testreparatur und Score-Beschriftung (zusammen 3–7 h).
   Algorithmusänderung C in 1.1, die übrigen Robustheitspunkte später.

## 11 Befunde

### SCORE-01 – Trend ignoriert das Zielland; der alarmrelevante Preis wird schlechter aktuell gehalten als mit festen Intervallen
- **Kategorie:** Algorithmus / Datenqualität · **Priorität:** P2 · **Ziel:** 1.1
- **Beschreibung:** Das Tempo hängt nur von der Position unter allen Regionen ab. Das beste im Zielland gültige Angebot,
  auf dem Wunschlistenpreis und Preisalarme beruhen (`alerts.rs:304-316`, `Scope::target`), liegt meist in der Mitte und
  wird seltener geprüft als die günstigste nicht aktivierbare Region.
- **Nachweis:** `jobs.rs:19`, `456-496`; gepaarter Benchmark A − B, Zielland-Bestpreis falsch −2,5 / −4,7 / −4,9 pp
  (R1/R2/R3b, je 5/5 Seeds). Erkennung Zielland R1: B 80,2 %, A 84,1 %. `python3 run_scenarios.py bench`.
- **Dateien:** `backend/src/jobs.rs` (`price_trend`, `price_position`), Tests `jobs.rs:2491-2577`.
- **Ursache:** Designentscheidung 0.6.5 („Das Zielland entscheidet nur noch, welcher Preis als Bestpreis zählt“).
- **Auswirkung:** Alarme kommen später oder gar nicht, wenn das Sonderangebot vor dem nächsten Abruf endet.
- **Verbesserung:** Kandidat C (8.2). Günstigere Regionen werden nicht herabgestuft.
- **Aufwand:** 6–10 h · **Änderungsrisiko:** mittel (Tagesbedarf +≈ 17 % bei gleichem Intervall).

### SCORE-02 – Min-Max-Normierung betragsblind und ausreißerabhängig; Einfrieren ohne Vergleich
- **Kategorie:** Mathematik · **Priorität:** P3 · **Ziel:** 1.1 (mit SCORE-01)
- **Beschreibung:** 0,1 % Preisunterschied ergibt die Extrempositionen 0 und 1, ein irrelevantes teures Angebot verschiebt
  alle anderen, bei einem Angebot oder gleichen Preisen bleibt der alte Trend für immer stehen. Teure, schwankende Angebote
  bekommen das niedrigste Tempo, obwohl sie attraktive Einbrüche liefern.
- **Nachweis:** `jobs.rs:439-449`; Rechenbeispiele in Abschnitt 3; E3 (Scores 26–60 ohne Sachgrund), E5 (B 7/18, A 14/18).
- **Dateien:** `backend/src/jobs.rs:437-454`. **Ursache:** Normierung auf die Spannweite statt auf den Abstand zum Bestpreis.
- **Auswirkung:** zufällige oder sachfremde Verteilung der Abfragen; geringe Effizienz (≈ 3 % Ersparnis).
- **Verbesserung:** logarithmischer Abstand zum Bestpreis (Teil von C); allein gemessen −7 % Abfragen bei +0,5 pp Erkennung.
- **Aufwand:** in SCORE-01 enthalten · **Änderungsrisiko:** gering.

### SCORE-03 – „Score“ ist nur die Anzeige des Abfragetempos und wird als Qualitätsurteil missverständlich dargestellt
- **Kategorie:** Transparenz / UX · **Priorität:** P2 · **Ziel:** 1.0
- **Beschreibung:** Score = 100·(1−`cheap_score`), farbig von Rot bis Grün und standardmäßig sichtbar. Grün erhält auch eine
  im Zielland nicht aktivierbare Region, Rot jedes ausverkaufte Angebot. Ein höherer Score bringt ohne Engpass keinen
  höheren Ertrag je Abfrage (R1: 6,8 gegen 6,6 Treffer je 100 Abfragen). `check_every` zeigt das geplante, nicht das
  tatsächliche Intervall.
- **Nachweis:** `offers.rs:175-186`, `Offers.tsx:30-36`, `77-88`, `offers-columns.ts:5`; Ertragstabelle Abschnitt 4.
- **Dateien:** `backend/src/offers.rs`, `frontend/src/features/{Offers.tsx,offers-columns.ts,offers-model.ts,InfosTab.tsx}`, `docs/data-sources.md`. **Ursache:** Der Score wurde in 0.8.2 als Spiegel des Intervallfaktors eingeführt, aber wie eine Bewertung gestaltet.
- **Auswirkung:** Nutzer lesen „grün = gutes Angebot“; unter Engpass suggeriert „alle 4 h“ eine nicht vorhandene Aktualität.
- **Verbesserung:** Spalte „Prüftakt“ mit „alle 4 h“ statt einer Zahl oder standardmäßig ausblenden; Tooltip mit „geplant“
  und Hinweis bei Bedarf > Limit; Doku `docs/data-sources.md:77-79` anpassen.
- **Aufwand:** 1–3 h · **Änderungsrisiko:** gering.

### SCORE-04 – Feste 24-h-Aktualitätsregel nicht mit Intervall × Tempo gekoppelt
- **Kategorie:** Konfiguration / Datenqualität · **Priorität:** P2 · **Ziel:** 1.1 (Hinweis in den Einstellungen ggf. 1.0)
- **Beschreibung:** Einstellbar sind bis zu 7 Tage Intervall; Tempo 2 verdoppelt das. Ab 12 h Shop-Intervall überschreiten
  teure und ausverkaufte Angebote planmäßig 24 h und zählen dann nicht mehr als aktueller Preis (`pricing.rs:18`, `144-149`).
- **Dateien:** `backend/src/jobs.rs:419-423`, `backend/src/pricing.rs:18`, Einstellungen Key-Shops. **Ursache:** zwei unabhängige Konstanten.
- **Nachweis:** `python3 interval_fresh.py`: Intervall 16 h: B 8,2 % der Angebote nicht aktuell (A 0 %); 24 h: B 23,4 %
  (A 0 %), Zielland-Bestpreis falsch 39,5 % (A 27,3 %).
- **Auswirkung:** Preise verschwinden als „veraltet“, Alarme bleiben aus, obwohl planmäßig geprüft wird.
- **Verbesserung:** lieferbare Produkte höchstens 20 h (bei Shop-Intervall ≤ 20 h) oder Hinweis in den Einstellungen ab 12 h.
- **Aufwand:** 2–4 h · **Änderungsrisiko:** gering.

### SCORE-05 – Klassen 2–5 hungern unter Engpass aus; der zugehörige Test kann nicht fehlschlagen
- **Kategorie:** Fairness / Test · **Priorität:** P2 · **Ziel:** 1.0 (Test), 1.1 (Scheduling)
- **Beschreibung:** Jeder vierte Job geht nach `due` an Suchen, Vorschauen und Discovery. Unter Engpass bekommt dadurch jeder
  dieser Jobs nur alle (Anzahl / Viertel-Budget) Tage einen Platz. Der Test `budget_keeps_every_region_of_active_wishes_fresh_alike`
  prüft „previews keep a share“ und „other regions are not starved“ mit `stale_count(ids, 0)`, also
  `COALESCE(observed_at,0) < 0`. Das ist nie wahr, beide Assertions sind wirkungslos.
- **Nachweis:** `jobs.rs:1964-1971`, `2018-2026`. **Echter Rust-Code** im selben Szenario (`xval/audit_xval.rs`,
  `results/budget_counts.json`): 121 von 200 Vorschau-Links nach 10 Tagen nie gemessen; Discovery 1× in 10 Tagen; die
  Original-Bedingung zählt 0. Das Modell liefert dieselben 121.
- **Dateien:** `backend/src/jobs.rs:284-296` (Rangfolge), `1964-2026` (Test). **Ursache:** gemeinsame FIFO-Reihe nach `due` für Jobs mit sehr verschiedenen Takten; Tippfehler in der Testbedingung (`since = 0`).
- **Auswirkung:** Die Absicht der Modul-Doku (`jobs.rs:15-16`) wird unter Engpass verfehlt: Neue Shop-Kandidaten werden
  spät gefunden, Editionsvorschauen bleiben leer. Der Test täuscht Sicherheit vor.
- **Verbesserung:** Test auf `observed_at IS NULL` umstellen und die Erwartung bewusst festlegen. Für 1.1 den 4. Platz nach
  Überfälligkeit relativ zum eigenen Takt vergeben (`(t−due)/Periode`) oder der Discovery einen festen Tagesplatz geben.
- **Aufwand:** Test 1–2 h; Scheduling 3–5 h · **Änderungsrisiko:** gering.

### SCORE-06 – Dauerhaft fehlschlagende Links (404/Parse) werden für immer im Intervall und in Klasse 1 geprüft
- **Kategorie:** Effizienz · **Priorität:** P3 · **Ziel:** 1.1
- **Beschreibung:** Nicht-transiente Fehler warten das Intervall mit Tempo 1 (`jobs.rs:397`, `581`). `relevance` bleibt 1
  (`jobs.rs:609`). Ein toter Link wird so doppelt so oft geprüft wie ein ausverkauftes Angebot.
- **Nachweis:** E7 mit 15 % toten Links: 19,6 % aller Abfragen; mit Verdopplung bis 8× nur 6,9 %, Erkennung +2,9 pp,
  Zielland falsch −4,2 pp. Wie häufig tote Links real vorkommen, ist **nicht verifiziert** (die DB-Kopie enthält keine).
- **Dateien:** `backend/src/jobs.rs:377-405`, `581`, `609`. **Ursache:** Fehlerpfad nutzt Tempo 1 und lässt `relevance` unverändert. **Auswirkung:** Budget fließt in tote Links statt in lebende Angebote.
- **Verbesserung:** `Intervall · 2^min(Fehler, 3)` für `not_found`/`invalid_response`.
- **Aufwand:** 1–3 h · **Änderungsrisiko:** gering (Erholung nach behobenem Parser bis 8 × Intervall: Hinweis im Log).

### SCORE-07 – Keine Shop-Pause bei anhaltenden Netzfehlern
- **Kategorie:** Robustheit / Effizienz · **Priorität:** P3 · **Ziel:** später
- **Beschreibung:** `Network` setzt keine Quellpause (`shops/mod.rs:260-265`). Bei einem Ausfall läuft das volle Tagesbudget in
  Fehlschläge (E7: 499 am Tag über 3 Tage); nur der Job selbst steigt die Leiter hinauf.
- **Dateien:** `backend/src/shops/mod.rs:260-265`, `backend/src/jobs.rs:681-688`. **Ursache:** Quellpause nur für 429 und 401/403.
- **Auswirkung:** gering für fremde Server (Ausfall); verbraucht Budget und füllt Log und Historie.
- **Verbesserung:** nach z. B. 10 Netzfehlern in Folge den Shop 15 min pausieren.
- **Aufwand:** 2–3 h · **Änderungsrisiko:** gering.

### SCORE-08 – Budget und Pacing passen sich nicht an Rate Limits an
- **Kategorie:** Robustheit / Händlerlimits · **Priorität:** P3 · **Ziel:** später
- **Beschreibung:** Jede 429-Antwort kostet Budget und pausiert den Shop für `Retry-After` (Standard 15 min). Das Pacing
  bleibt danach gleich. Reale 429 gab es: 8 von 125 Links in der DB-Kopie mit `rate_limited`.
- **Nachweis:** E8 (Shop erlaubt 10/h): Budget 500 → 77 × 429 am Tag, Erkennung 36 %; Budget 200 → 0 × 429, Erkennung 42 %.
- **Dateien:** `backend/src/jobs.rs:105-110`, `326-331`, `shops/http.rs:146-164`. **Ursache:** Pacing kennt nur das Tagesbudget, kein Stundenlimit des Shops. **Auswirkung:** weniger erfolgreiche Abfragen als mit niedrigerem Budget; mehr 429 beim Händler.
- **Verbesserung:** nach 429 das effektive Tagesbudget für den Rest des Tages senken (z. B. halbieren) oder im Abrufstatus
  „Limit senken“ empfehlen.
- **Aufwand:** 2–4 h · **Änderungsrisiko:** gering–mittel.

### SCORE-09 – Rücksprung der Systemuhr stoppt alle Abfragen und entwertet alle Preise
- **Kategorie:** Robustheit · **Priorität:** P3 · **Ziel:** später
- **Beschreibung:** `due`, `paced_until`, `retry_at` und `observed_at` sind absolute Zeiten. Springt die Uhr zurück, liegen sie
  in der Zukunft; `observed_at <= now` (`pricing.rs:146-147`) macht alle Beobachtungen ungültig.
- **Nachweis:** E11: −25 h → 24 h ohne Abfrage, 41 % der Angebote nicht aktuell, Zielland falsch 56 %; −6 h → −28 % Abfragen.
- **Dateien:** `backend/src/jobs.rs:236-239`, `backend/src/pricing.rs:144-149`. **Auswirkung:** bis zu |Δ| ohne Abfragen und ohne gültige Preise.
- **Verbesserung:** beim Claim Zeiten über `now + max. Wartezeit` auf `now` begrenzen; in `pricing` Zukunftswerte bis zu
  einer Toleranz als `now` werten.
- **Aufwand:** 2–4 h · **Änderungsrisiko:** gering. Selten (Container nutzen die Host-Uhr), deshalb P3.

### SCORE-10 – Veraltete und widersprüchliche Doku zum Abfrageplan
- **Kategorie:** Doku · **Priorität:** P3 · **Ziel:** 1.0
- **Beschreibung/Nachweis:** `docs/data-sources.md:41` („dreimal seltener“, seit 0.6.5 falsch); `docs/operations.md:43`
  (Budget „an Preise …, die im Zielland gelten können“, 4. Job „andere Regionen“); `docs/data-sources.md:65` und
  `docs/operations.md:84` („mindestens das konfigurierte Intervall“ widerspricht `jobs.rs:67` und `operations.md:43`);
  Kommentare `offers.rs:147`, `frontend/src/features/offers-model.ts:12` („validity in the target country“).
- **Dateien:** `docs/data-sources.md`, `docs/operations.md`, `backend/src/offers.rs`, `frontend/src/features/offers-model.ts`. **Ursache:** Änderungen von 0.6.5 und 0.9.0 nicht nachgezogen. **Auswirkung:** falsches Bild vom Abfrageplan.
- **Verbesserung:** Texte an den Code angleichen; Score-Absatz `data-sources.md:77-79` mit SCORE-03 anpassen.
- **Aufwand:** 1–2 h · **Änderungsrisiko:** keins.

## Geprüfte Befehle und Grenzen

Ausgeführt (alle aus `docs/release-1.0-audit/evidence/scoring/`, Ergebnisse in `results/`):

| Befehl | Ergebnis |
|---|---|
| `python3 sim/selfcheck.py` | 42 von 42 Prüfungen gegen die Rust-Testerwartungen bestanden (plus Hinweiszeile zum wirkungslosen Assert) |
| `sh xval/run_xval.sh <scratch>` (Docker `keyhunter-build-tools:local`, Target `work/check/target-score`, Scratch-Kopie von `backend/`) | Kompilierung 49 s; 3 Szenarien mit 232 / 435 / 354 Jobs: Modell und echter Code **identisch** in Zeit, Art, Link, Ergebnis, `due`, `pace`, `relevance`, `cheap_score`; Budget-Test-Szenario: 121/200 Vorschauen nie gemessen, Original-Bedingung zählt 0 |
| `python3 xval/xval.py compare xval/results` | wiederholt den Vergleich ohne Docker: IDENTICAL ×3 |
| `python3 sim/run_scenarios.py all --out results` | 351 s auf 8 Kernen: Benchmark R1–R3b × 5 Seeds inkl. Kalibrierung, Sweep 10–400 Spiele × 3 Seeds, Randfälle E1–E14 |
| `python3 sim/run_scenarios.py edge --only E2_…,E5_…` | Neuberechnung mit 10 Phasen bzw. 18 Einbrüchen (statt Einzelereignis) |
| `python3 sim/interval_fresh.py` | Intervall 8/12/16/24 h × A/B/C |
| `python3 sim/claim_bench.py` | SQL-Kosten 100–30 000 Jobs, Query-Plan |
| `python3 sim/db_stats.py <projektordner>/work/phase_b_database/keyhunter.db <scratch>` (Kopie, read-only) | aggregierte Kennzahlen der Kopie (Schema 10, 221 Beobachtungen) |
| `python3 sim/make_tables.py results` | `results/summary.md` |

Nicht geprüft bzw. Grenzen:
- **Historische Wiedergabe mit echten Daten: nicht möglich.** 35 h und 221 Beobachtungen vor Migration 0012, die
  Abstände hat der alte Scheduler bestimmt, Zwischenänderungen sind unbekannt. Alle Effizienzaussagen beruhen auf
  synthetischen Verläufen. Die Generatorparameter sind dokumentiert und nur grob kalibriert.
- Keine Anfragen an echte Shops; echte Rate-Limit-Grenzen von Eneba/Driffle sind **nicht verifiziert** (E8 nimmt 10/h an).
- Nicht modelliert: angeforderte Aktualisierungen, mehrseitige Suchen, Editionsvorschauen im Benchmark (nur in Selbstprüfung
  und Kreuzvalidierung), Driffle-Sitemap-Takt, variable Antwortzeiten.
- SQL-Laufzeiten mit Pythons SQLite 3.46.1, nicht mit der von sqlx gebündelten Version; RAM des Rust-Prozesses nicht gemessen.
- Kandidat C ist nur im Modell umgesetzt, nicht im Rust-Code; seine Zahlen sind Simulationsergebnisse.
- Die Ratings beruhen auf Code, Kreuzvalidierung und Simulation, nicht auf Produktionsbeobachtung.
