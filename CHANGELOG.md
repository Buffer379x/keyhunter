# Änderungen

## 0.6.5 – 2026-11-21

Die Spalten der Wunschliste lassen sich in den Einstellungen anordnen, und die Bibliothek sortiert standardmäßig von A bis Z. Die Datenbank bekommt beim Start automatisch eine neue Spalte, sonst ist nichts zu tun.

### Neu
- **Spaltenreihenfolge der Wunschliste:** Unter Einstellungen → Allgemein → „Wunschliste · Spalten“ lässt sich jede Spalte mit den Pfeilen nach oben oder unten verschieben, zum Beispiel der Details-Knopf vor das Cover. Die Reihenfolge wird sofort gespeichert und gilt auf allen Geräten; „Standard wiederherstellen“ setzt sie zurück. Auf dem Smartphone bleibt die Kartenansicht gleich.

### Oberfläche
- **Bibliothek:** Standard ist jetzt „A–Z“; der Schalter steht deshalb an erster Stelle, „Zuletzt gekauft“ an zweiter.

## 0.6.4 – 2026-11-21

Automatisch gefundene Shop-Links lassen sich nach einem Blick auf die Produktseite selbst bestätigen; dazu kleinere Aufräumarbeiten in Preisvergleich, Wunschliste und Bibliothek. Die Datenbank bekommt beim Start automatisch eine neue Spalte, sonst ist nichts zu tun.

### Neu
- **Zuordnungen selbst bestätigen:** Passt ein automatisch gefundenes Produkt laut Shop-Daten nicht genau zum Spiel (anderer Titel, Edition oder Plattform), steht es unter Infos → Produktzuordnungen mit „Selbst prüfen“. „Prüfen“ öffnet ein Fenster mit Shop-Titel, Region, Aktivierung, Preis und der vollständigen Adresse der Produktseite, bevor man sie öffnet. Mit „Zuordnung bestätigen“ zählt der Preis dieses Produkts; die Zuordnung ist dann als „Von dir bestätigt“ markiert. Stellt der Shop später ein anderes Produkt hinter den Link, fragt KeyHunter erneut.

### Oberfläche
- **Preisvergleich:** Bester Preis, Differenz und günstigste Region stehen auf einer Linie.
- **Wunschliste:** Ist das Zielland selbst am günstigsten, zeigt die Spalte „Günstigste Region“ Flagge und Preis wie bei jedem anderen Spiel, leicht grün hinterlegt, statt „DE ist weltweit am günstigsten“.
- **Bibliothek:** Unter dem Cover steht nur noch der Titel; Edition (steht schon im Titel) und Kaufdatum entfallen.

## 0.6.3 – 2026-11-20

Länderflaggen sind zurück, die Wunschliste öffnet Spiele über einen Details-Knopf, und Spiele lassen sich über ihre IGDB-ID finden. Keine Datenbankänderung.

### Oberfläche
- **Flaggen statt Kürzel:** Regionen erscheinen wieder als Länderflagge (Europa mit EU-Flagge); Global, Nordamerika, Rest der Welt und Lateinamerika als Globus. Das Zielland hat einen orangen Rand, der Name steht im Tooltip und für Screenreader.
- **Details-Knopf in der Wunschliste:** Ein Spiel öffnet sich über das Details-Symbol am Ende der Zeile (auf dem Smartphone rechts in der Karte). Ein Klick irgendwo in der Zeile öffnet nichts mehr, damit man Werte markieren und kopieren kann.

### Neu
- **Suche per IGDB-ID:** Im Dialog „Spiel hinzufügen“ findet `119171`, `#119171` oder `igdb:119171` genau dieses Spiel, wenn es für die gewählte Plattform erscheint. Es steht dann an erster Stelle; die normale Titelsuche läuft trotzdem mit, damit auch Spiele mit Zahlen im Namen („1942“) gefunden werden.

## 0.6.2 – 2026-11-20

Kleine Bedienverbesserungen an Wunschliste und Bibliothek. Keine Datenbankänderung.

### Oberfläche
- **Wunschliste sortiert über die Spaltenköpfe:** Spiel, Preis im Zielland, günstigste Region, Ersparnis, Ziel und Status. Erster Klick sortiert in der naheliegenden Richtung (Ersparnis: größte zuerst), der zweite dreht um, der dritte kehrt zu „zuletzt hinzugefügt“ zurück. Das Auswahlfeld „Sortieren“ entfällt; auf dem Smartphone stehen die Spaltenköpfe als Sortierleiste über den Karten. Die gewählte Sortierung bleibt erhalten, auch die aus 0.6.1.
- **Bibliothek:** kleinere Cover und ein einheitlicher Textblock (zwei Zeilen Titel, eine Zeile Edition und Kaufdatum), damit das Raster nicht verspringt. „Zurück in die Wunschliste“ und „Entfernen“ (roter Papierkorb) sitzen als Symbole oben rechts auf dem Cover und erscheinen erst, wenn das Schloss oben auf der Seite geöffnet ist.

## 0.6.1 – 2026-11-20

Neue, kompaktere Oberfläche (Entwurf v4) und Abrufe, die gleichmäßig über den ganzen Tag laufen statt am Stück bis zum Tageslimit; das Budget ist in der App einstellbar ([Upgrade-Hinweise](docs/operations.md#upgrade-auf-061)).

### Oberfläche
- **Kompakter und ruhiger:** Grundschrift 13 px, Schaltflächen 32 px, Überschriften in normaler Stärke, Preise und Kennzahlen in JetBrains Mono, warmes Anthrazit statt Blauschwarz.
- **Navigation:** Seitenleiste mit den Gruppen Übersicht und Einstellungen (alle sechs Bereiche direkt erreichbar), Abrufstatus-Karte und Zielland-Auswahl; Kopfzeile mit Pfad, Suche (`Ctrl K`), Preisalarme und „Spiel hinzufügen“. Unter 900 px öffnet ☰ die Navigation.
- **Wunschliste als Tabelle:** vier Kennzahlen (Wünsche, Ziel erreicht, weltweit günstiger, Abrufe heute), Filter, Sortierung nach Ersparnis oder Abstand zum Ziel, je Spiel Preis im Zielland mit Shop und Region, günstigste Region weltweit mit Ersparnis und 14-Tage-Verlauf. Auf dem Smartphone werden die Zeilen zu Karten.
- **Spiel als eigene Seite:** Preisvergleich Zielland ↔ weltweit mit Einschätzung, ob sich der Umweg lohnt; Preis-Visier; Angebotstabelle nach Preis; Verlauf als Raster-Diagramm mit beiden Reihen, Ziellinie, Tooltip und 30/90/180 Tagen; Editionen mit Preis im Zielland und weltweit.
- **Immer beide Preise:** Die Wunschliste zeigt immer den Preis im Zielland und daneben die günstigste Region weltweit. Die Einstellung „Preis in der Wunschliste: Alle Regionen“ entfällt, weil sie den Vergleich verdeckt hat.
- **Einstellungen, Bibliothek, Preisalarme, Einrichtung und Anmeldung** im selben Stil; Preisalarme als Tabelle nach Abstand zum Ziel. Regionen erscheinen als Kürzel statt Flaggen.

### Neu
- **Tagesbudget je Shop** unter **Einstellungen → Key-Shops** (20–2000 Abrufe pro UTC-Tag). Der Wert hat Vorrang vor `KEYHUNTER_SHOP_DAILY_JOBS` und wirkt ohne Neustart.
- **Abrufstatus** zeigt je Shop, woher das Limit stammt, den geschätzten Tagesbedarf des aktuellen Plans, den aktuellen Abstand zwischen Abrufen, den nächsten möglichen Abruf und die Abrufe je Stunde.
- **Wunschlisten-Badges** enthalten den Verlauf der letzten 14 Tage: je Tag der beste im Zielland gültige Preis.

### Verbessert
- **Gleichmäßige Abrufe:** Das verbleibende Budget wird über den Rest des UTC-Tages verteilt (20 Sekunden bis 1 Stunde Abstand); der nächste Zeitpunkt übersteht Neustarts. Angeforderte Aktualisierungen, die erste Suche eines neuen Wunsches samt Folgeseiten und die ersten Preise der dabei gefundenen Produkte starten weiterhin sofort und zählen zum Budget.
- **Standardbudget 500** statt 120 Jobs pro Shop und Tag, damit auch größere Wunschlisten im eingestellten Intervall aktuell bleiben.

### Hinweise zum Update
- **Unraid:** Die bisherige Vorlage setzt `KEYHUNTER_SHOP_DAILY_JOBS=120` fest im Container. Lege das Budget unter **Einstellungen → Key-Shops** fest (oder setze die Variable auf 500), sonst bleibt es bei 120.

## 0.6.0 – 2026-11-20

Größtes Update seit dem ersten Release: neue Oberfläche, verlässliche Preisregeln und ein Abrufbudget, das bei den wichtigen Preisen ankommt. Datenvolume beibehalten; vor der Migration legt die App automatisch eine Sicherung an ([Upgrade-Hinweise](docs/operations.md#upgrade-auf-060)).

### Neu
- **Oberfläche nach neuem Design:** Seitenleiste mit Abrufstatus, Spieldetail mit Tabs Preis · Angebote · Verlauf · Editionen · Alarm · Infos, große Preisanzeige, eigene Ansichten für Tablet und Smartphone, neues Logo und App-Icon.
- **Immer der Vergleich:** Wunschliste und Spieldetail zeigen den besten in deinem Zielland gültigen Preis neben der günstigsten Region weltweit, mit Differenz in Euro und Prozent. Angebote sind nur nach Preis sortiert; jede Zeile sagt, ob sie für dein Land zählt oder warum nicht.
- **Preisverlauf** mit beiden Reihen (Zielland und alle Länder), Zeitraum 30 T / 90 T / 1 J, Alarmziel und Kennzahlen; **Preis-Visier** mit Tiefstwert, Ziel und 30-Tage-Schnitt.
- **Einstellungen** in sechs Bereichen mit automatischem Speichern, Hinweis bei Verbindung ohne HTTPS und neuer Seite **Abrufstatus** (Warteschlange, Budget, Pausen, letzte Abrufe). `GET /api/v1/status/fetch` liefert dieselben Daten.
- **Einrichtung** fragt das Zielland ab; Preisalarme funktionieren sofort.
- **Lokale Hostnamen** wie `http://tower:3000` oder `*.local` funktionieren ohne `KEYHUNTER_ORIGIN`.
- **Automatische Sicherung** der Datenbank vor jeder Schemaänderung unter `<Daten>/backups/` (die drei neuesten bleiben).
- Hinweis, wenn ein Shop ein bestätigtes Produkt umbenennt, mit „Neuen Titel übernehmen“.

### Verbessert
- **Abrufe:** Angeforderte Aktualisierungen und erste Suchen neuer Wünsche kommen zuerst, danach Preise, die im Zielland zählen können. Varianten, die dort nicht zählen, und Editionsvorschauen werden seltener abgefragt; Vorschauen ruhen nach 14 Tagen ohne Ansicht. Vorübergehende Fehler werden nach 2, 10 und 60 Minuten wiederholt. Titelsuchen laufen wöchentlich mit höchstens fünf Seiten.
- **Shop-Verbindungen** werden 24 Stunden wiederverwendet, robots.txt wird zwischengespeichert; Anfragen an einen Shop laufen nacheinander.
- **Wunschliste und Badges** laden mit wenigen gebündelten Abfragen (100 Wünsche unter 40 ms) und pausieren in Hintergrund-Tabs.
- Fehlerantworten der API tragen einen festen `code`; Datenbankfehler werden mit Ursache protokolliert.

### Behoben
- Angebote, Badges und Alarme bewerten Preise mit **einer** Regel; ein veralteter oder abweichender Preis gilt nicht mehr als aktueller Bestpreis.
- Eneba-Aktivierung kommt aus den strukturierten Länderdaten statt aus einem deutschen Satz auf der Seite; ändert Eneba seine Seite, erscheint ein Quellfehler statt still fehlender Preise.
- Umbenannte Shopprodukte verlieren ihre Bestätigung nicht mehr.
- Eneba behält die 20 günstigsten statt der ersten 20 Angebote; Driffle akzeptiert weitere Formate für Freigabe und Preis.
- Ein fehlendes robots.txt (404) sperrt den Shop nicht mehr.
- Entfernen eines Bibliothekseintrags löscht ihn (vorher ohne Wirkung).
- Neue Wünsche konnten bei ausgeschöpftem Budget tagelang ungesucht bleiben.

### Hinweise zum Update
- Preisalarme beginnen ihre Auswertung einmalig neu; liegt ein Preis schon unter dem Ziel, kann eine Benachrichtigung einmal erneut kommen.
- Der Navigationspunkt heißt jetzt „Alarme“; die Region-Übersicht ist durch eine Angebotstabelle ersetzt.

Frühere Versionen: [Releases](https://github.com/Buffer379x/keyhunter/releases).
