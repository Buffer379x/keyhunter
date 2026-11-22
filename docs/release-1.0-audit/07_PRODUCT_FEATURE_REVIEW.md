# 07 · Produkt- und Feature-Review (KeyHunter 0.9.1)

Rolle: Product Manager. Grundlage sind die Funktionsinventur in `03_FUNCTIONAL_AUDIT.md` §2 (21 Funktionsbereiche, 43 API-Routen), die UX-Journeys in `05_RESPONSIVE_VISUAL_AUDIT.md` und die Erfahrungen aus den Releases 0.6–0.9.1. Befunde in diesem Dokument haben das Präfix **PROD**.

## 1. Kurzfazit

KeyHunter löst seine Kernaufgabe vollständig: Es merkt sich Xbox-Spiele, sucht passende Keys bei zwei Shops, vergleicht den besten im Zielland aktivierbaren Preis mit der günstigsten Region weltweit und meldet einen Wunschpreis über sieben Kanäle. Für ein Ein-Personen-Werkzeug ist der Umfang **eher zu groß als zu klein**. In den letzten zehn Releases kam pro Release mindestens ein neuer Bereich hinzu: Warenkorb, Log, Pausen, Kanäle, Spalten-Einstellungen. Die Produktfrage für 1.0 lautet daher nicht „was fehlt“, sondern „was ist fertig, stimmig und belastbar“.

**Fehlende Funktionen, die 1.0 wirklich braucht:**
- **Wiederherstellung neben dem Export (PROD-01).** Den Export gibt es, einen Import nicht; außerdem gibt es keine geführte Datensicherung.
- **Erststart-Führung (PROD-02).** Ohne IGDB-Zugang funktioniert die Suche nicht. Ohne Kanal kommt kein Alarm an. Driffle ist bei Neuinstallation aus.

Alles andere ist Ausbau für 1.1 ff.

## 2. Bewertung des bestehenden Funktionsumfangs

| Bereich | Urteil | Begründung |
|---|---|---|
| Wunschliste mit Zielland- und Weltpreis | **Kern, stark** | Klare Leitidee: das günstigste gültige Angebot gegen das günstigste überhaupt. Durch Spalten-, Chip-, Shop- und Gebührenfilter inzwischen sehr dicht, siehe UX in 05. |
| Spieldetail (Preis, Angebote, Verlauf, Editionen, Alarm, Infos) | **Kern, stark, aber schwer** | Sechs Tabs. „Infos“ mischt Fakten mit der wichtigsten Pflegeaufgabe, dem Prüfen von Zuordnungen. Das Warndreieck aus 0.9.1 zeigt auf diesen Tab, der Name verrät das nicht. |
| Zuordnungen prüfen | **Kern, unterschätzt** | Hier entscheidet sich die Datenqualität (FUNC-01, FUNC-04). Der Ablauf ist funktional, wirkt aber wie eine Nebenfunktion. |
| Preisalarme und Kanäle | **Kern, vollständig** | Sieben Kanäle sind mehr als genug. Für 1.0 nichts ergänzen, nur stabilisieren. |
| Warenkorb | **Nützliches Extra** | Klarer Zweck (Gesamtpreis über mehrere Käufe), seit 0.9.1 wieder gut lesbar. Nicht weiter ausbauen. |
| Bibliothek | **Sinnvoll** | Beendet Abfragen für gekaufte Spiele und hält den Verlauf. |
| Pause je Spiel, globale Pause | **Sinnvoll, fehlerhaft** | CODE-01: ein pausierter Wunsch zeigt dauerhaft „Wird gesucht …“ und erzeugt Polling alle 3 s. Vor 1.0 beheben. |
| Abrufstatus und Log | **Admin-Werkzeug am richtigen Ort** | Seit 0.8.3 Tabs in den Einstellungen. Für Endanwender ausreichend versteckt, für den Betreiber wertvoll. |
| Score-Spalte bei Angeboten | **Irreführend benannt** | SCORE-03: der Wert ist das Abfragetempo, kein Qualitätsurteil. Grün erscheint auch bei nicht aktivierbaren Regionen. Für 1.0 umbenennen oder entfernen. |
| Spaltenkonfiguration (zwei Tabellen) | **Grenzwertig** | Großer Pflegeaufwand für wenig Alltagsnutzen. Behalten, nicht ausbauen. |
| Editionsvergleich (Microsoft-Katalog) | **Nett, riskante Quelle** | Undokumentierte Schnittstelle (FUNC-09). Bei Ausfall bleibt der Rest nutzbar. Das ist richtig so, die Nutzung muss aber dokumentiert sein. |
| Export der Wunschliste | **Halb fertig** | JSON-Export ohne Import und ohne Test (03 §2 Nr. 18). |

## 3. Benennung, Workflows und Einstellungen

- **PROD-03 Benennung „Infos“:** Der Tab enthält die Zuordnungsprüfung. Vorschlag: „Zuordnungen“ oder „Infos & Zuordnungen“, mit Zähler wie heute. Das Warndreieck in der Liste sollte direkt dorthin führen.
- **PROD-04 Benennung „Score“:** Er misst das Abfragetempo. Vorschlag: Spalte „Prüftempo“ mit Werten wie „häufig/normal/selten“, oder ganz entfernen; siehe 11 §SCORE-03.
- **PROD-05 Einstellungen:** Sieben Tabs mischen Konfiguration (Allgemein, Key-Shops, Spieleindex, Benachrichtigungen, System) mit Betriebsansichten (Abrufstatus, Log). Zwei Speichermuster existieren nebeneinander, Entwurf mit „Speichern“ und sofort wirksam (DS-14). Für 1.0 genügt eine einheitliche Kennzeichnung: Jeder Tab sagt, ob er sofort speichert. Eine Umstrukturierung ist nicht nötig.
- **PROD-06 Gekauft-Fluss:** „Gekauft“ verschiebt in die Bibliothek und beendet die Alarme. Der Rückweg („Zurück in die Wunschliste“) liegt hinter einem Schloss-Symbol. Das ist bewusst so, aber nicht selbsterklärend; siehe 05.
- **Konsistenz der Zielland-Logik:** Seit 0.9.0 gilt der EU-Markt beim aktuellen Preis, aber nicht bei Trend und Verlauf (FUNC-02). Ein Produktversprechen, das nur zur Hälfte stimmt: vor 1.0 schließen.

## 4. Fehlende Funktionen mit echtem Mehrwert

Geprüft wurde jeweils, ob die Funktion schon existiert. Bewertung: Nutzen hoch/mittel/gering, Aufwand in Stunden, Wartung, Ressourcen, externe Abhängigkeit, Zielrelease.

| ID | Vorschlag | Existiert? | Nutzen | Aufwand | Wartung | Ressourcen | Extern | Ziel |
|---|---|---|---|---|---|---|---|---|
| PROD-01 | **Import der Wunschliste** (JSON aus dem eigenen Export, mit Vorschau und Dublettenprüfung) und eine Seite „Sichern & Wiederherstellen“ in System (Anleitung plus Download der letzten automatischen Sicherung) | Export ja, Import nein; Sicherung nur vor Migrationen | hoch (Umzug, Neuinstallation, Vertrauen) | 6–10 h | gering | keine | keine | **1.0** |
| PROD-02 | **Erststart-Checkliste** auf der leeren Wunschliste: Zielland ✓, IGDB-Zugang, Shops aktiv, Benachrichtigungskanal, mit Direktlinks | nein (nur Hinweise verteilt) | hoch (erste 10 Minuten) | 3–5 h | gering | keine | keine | **1.0** |
| PROD-07 | **Alarm „unter X % des 90-Tage-Durchschnitts“** als dritte Alarmart neben Zielpreis und neuem Tiefstpreis | nein | mittel | 4–6 h | gering | keine | keine | 1.1 |
| PROD-08 | **Zuordnungs-Inbox:** eine Ansicht aller Spiele mit ungeprüften Zuordnungen, nacheinander abarbeitbar | nur pro Spiel unter „Infos“ plus Warndreieck (0.9.1) | mittel bis hoch (Datenqualität) | 6–10 h | gering | keine | keine | 1.1 |
| PROD-09 | **Shop-Präferenz/-Ausschluss je Spiel** (z. B. „nur Eneba“) | global nur Shop an/aus | gering | 4–6 h | mittel | keine | keine | später |
| PROD-10 | **Weitere Shops** (Gamivo, Kinguin, CDKeys …) | Gamivo geprüft und an Cloudflare gescheitert (0.7.4) | mittel | je 10–20 h | **hoch** (Parser brechen) | mehr Abrufe | **hoch** (AGB, Schutzmaßnahmen) | später, nur bei erlaubtem Zugang |
| PROD-11 | **Mehrbenutzer** | nein, bewusst Eigentümer-Modell | gering für Zielgruppe | > 40 h | hoch | – | – | nicht empfohlen |
| PROD-12 | **Preis-Tiefststand-Zeitraum** in der Liste („Tiefstwert seit 90 Tagen“) | Verlauf und KPI im Detail vorhanden | gering bis mittel | 2–3 h | gering | eine Abfrage mehr | keine | 1.1 |
| PROD-13 | **Kanarienvogel-Check der Shop-Parser** (täglicher Selbsttest: liefert eine bekannte Produktseite noch die erwartete Struktur? Befund im Log und als Kanalnachricht) | nein, Parserbrüche zeigen sich nur als Fehlerflut (FUNC-13) | hoch für Betrieb | 4–6 h | gering | 1 Abruf/Tag/Shop | gering | 1.0–1.1 |

**Bewusst nicht empfohlen:** Machine-Learning-Preisprognosen, Browser-Erweiterung, Account-/Cloud-Sync und PWA-Offline-Modus. Kein Nutzen für einen selbst gehosteten Ein-Personen-Dienst, der Aufwand ist unverhältnismäßig.

## 5. Langfristige Nutzbarkeit

- **Wachstum:** Seit 0.9.0 ist die Wunschliste unbegrenzt. Die Simulation (11 §E) zeigt: Beim Standardbudget von 500 Abrufen am Tag sind ab etwa 50 Spielen viele Preise älter als 24 h. Bei 100 Spielen sind es 23 %, bei 300 Spielen 75 %. Das wird für Vielnutzer zum spürbaren Produktproblem. Für 1.0 reicht es, das Budget-Signal sichtbar zu machen; der Abrufstatus zeigt es bereits, die Wunschliste nicht. **PROD-14:** In den KPI der Wunschliste deutlicher zeigen, wenn das Budget nicht reicht, mit Link zu Key-Shops.
- **Datenpflege:** Die Zuordnungsprüfung ist der einzige wiederkehrende Pflegeaufwand. Eine Inbox (PROD-08) würde ihn bündeln.
- **Betrieb:** Log, Abrufstatus und Sicherung vor Migrationen sind vorhanden. Es fehlt eine Wiederherstellung über die Oberfläche (PROD-01) und eine Warnung, wenn ein Shop-Parser bricht (PROD-13).

## 6. Befundliste PROD

| ID | Prio | Beschreibung | Aufwand | Ziel |
|---|---|---|---|---|
| PROD-01 | P2 | Import und geführte Wiederherstellung fehlen | 6–10 h | 1.0 |
| PROD-02 | P2 | Keine Erststart-Führung (IGDB, Shops, Kanal) | 3–5 h | 1.0 |
| PROD-03 | P2 | Tab „Infos“ verbirgt die Zuordnungsprüfung | 1 h | 1.0 |
| PROD-04 | P2 | „Score“ irreführend benannt (deckungsgleich mit SCORE-03) | in SCORE-03 | 1.0 |
| PROD-05 | P3 | Einstellungen mischen Konfiguration und Betrieb, zwei Speichermuster | 2–4 h | 1.1 |
| PROD-06 | P3 | Rückweg aus der Bibliothek schwer auffindbar | 1–2 h | 1.1 |
| PROD-07 | P3 | Alarm relativ zum Durchschnitt | 4–6 h | 1.1 |
| PROD-08 | P3 | Zuordnungs-Inbox | 6–10 h | 1.1 |
| PROD-12 | P3 | Tiefstwert-Zeitraum in der Liste | 2–3 h | 1.1 |
| PROD-13 | P2 | Parser-Selbsttest mit Meldung | 4–6 h | 1.0/1.1 |
| PROD-14 | P2 | Budget-Engpass in der Wunschliste sichtbar machen | 1–2 h | 1.0 |

PROD-01 ist P2, nicht P1. Eine Wiederherstellung über das Zurückkopieren des Datenordners bzw. einer automatischen Sicherung funktioniert nachweislich: Wiederherstellung einer 0.5.0-Sicherung, siehe `03_FUNCTIONAL_AUDIT.md` §3. Es fehlt nur der bequeme, geführte Weg in der Oberfläche.

## Geprüfte Befehle und Grenzen

- Keine eigenen Laufzeittests in diesem Dokument. Die Bewertung stützt sich auf die Laufzeitbelege von 03, 05 und 11 und auf die Release-Historie (`CHANGELOG.md` 0.6–0.9.1).
- Nicht verifiziert: tatsächliche Nutzungsgewohnheiten (es gibt keine Telemetrie) und die Zahl der Spiele in echten Installationen.
