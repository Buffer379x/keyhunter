# Änderungen

## 0.8.1 – 2026-11-21

Der Warenkorb rechnet jetzt pro Spiel mit Shop und Region nach Wahl, Angebote lassen sich einzeln hineinlegen, und Spiele für Xbox 360 und die erste Xbox lassen sich erfassen. Beim Start baut die Datenbank die Wunschlisten-Tabelle mit vorheriger Sicherung um; alle Einträge, Preise und Alarme bleiben erhalten.

### Neu
- **Günstigste Variante:** „In den Warenkorb“ auf der Seite eines Spiels nimmt automatisch das günstigste Angebot, egal welcher Shop und welche Region.
- **Angebot in den Warenkorb:** Im Tab „Angebote“ hat jedes Angebot einen Warenkorb-Knopf. Er legt das Spiel mit diesem Shop in den Warenkorb, mit dem Preis im Zielland, wenn das Angebot dort aktivierbar ist, sonst mit der günstigsten Region; liegt das Spiel schon darin, wechselt es auf dieses Angebot.
- **Shop und DE/INT pro Spiel:** Im Warenkorb hat jedes Spiel eine Shop-Auswahl („Günstigster“ oder ein fester Shop, mit Preis) und einen eigenen Schalter DE/INT. Der Schalter gilt für den Shop, den das Spiel gerade zeigt; nach einem Shop-Wechsel für den neuen Shop. Der globale Schalter oben entfällt.
- **Mehrkosten:** Sobald ein Spiel nicht mit seiner günstigsten Variante zählt, zeigt der Warenkorb, wie viel du mehr zahlst als bei der günstigsten Zusammensetzung, mit Gebühren und nur für die Keys.
- **„Alle“ beim Hinzufügen:** Der Hinzufügen-Dialog (Wunschliste und Bibliothek) sucht standardmäßig in allen Xbox-Systemen und zeigt jeden Treffer mit seinem System, ein Spiel für mehrere Systeme einmal je System. Die Systemauswahl daneben bietet „Alle“ und die Systeme, für die schon ein Spiel in der Liste steht; ein System verschwindet mit dem letzten Spiel dafür. Ein Titel ohne Katalogtreffer bekommt sein System in einer eigenen Auswahl.
- **Xbox 360 und Xbox:** Spiele für Xbox 360 und die erste Xbox lassen sich auf die Wunschliste und in die Bibliothek legen. Die Shop-Reader erkennen bisher nur Keys für Xbox Series X|S und Xbox One; für ältere Systeme gefundene Produkte musst du unter Infos selbst bestätigen.

### Oberfläche
- **Bibliothek als Liste:** Ohne „gekauft am“, nur Titel und System.

## 0.8.0 – 2026-11-21

Neu ist ein Warenkorb: Mehrere Wünsche zusammen ergeben einen Gesamtpreis mit und ohne Gebühren, aufgeteilt nach Shops. Beim Start legt die Datenbank automatisch eine neue Tabelle an, sonst ist beim Update nichts zu tun.

### Neu
- **Warenkorb:** Ein neuer Punkt „Warenkorb“ in der Seitenleiste (mit Anzahl). Auf der Seite eines Spiels legt „In den Warenkorb“ es hinein, ein zweiter Klick auf „Im Warenkorb“ nimmt es wieder heraus; im Warenkorb selbst wählst du weitere Wünsche aus einer Liste oder entfernst sie mit dem Papierkorb. Jeder Wunsch liegt höchstens einmal darin.
- **Gesamtbetrag:** Der Warenkorb zeigt je Spiel Shop, Key-Preis, geschätzte Gebühren und Gesamtpreis, dazu je Shop die Summe aus Keys und Gebühren sowie die reinen Key-Kosten, die Gebühren und den Gesamtbetrag mit und ohne Gebühren. Umschaltbar zwischen dem günstigsten im Zielland aktivierbaren Angebot (Preis DE) und dem günstigsten aller Regionen (Preis INT). Für Shops ohne eingestellte Gebührenschätzung zählt nur der Key-Preis, und der Warenkorb sagt das; Spiele ohne aktuellen Preis werden genannt, aber nicht eingerechnet.
- **Live-Preise:** Die Beträge kommen aus denselben gespeicherten Shop-Abfragen wie die Wunschliste und werden jede Minute neu gelesen, solange die Seite offen ist.
- **Gekauft oder gelöscht:** Markierst du ein Spiel als gekauft (auch über „Als gekauft verschieben“ in der Bibliothek) oder löschst es von der Wunschliste, verschwindet es auch aus dem Warenkorb.
- **Korb in der Wunschliste:** Liegt ein Wunsch im Warenkorb, steht hinter seinem Namen ein kleiner Einkaufskorb.

## 0.7.4 – 2026-11-21

Die Wunschliste filtert auch nach Shops, und Key-Shops zeigt jeden eingebauten Shop direkt mit seinem Schalter. Beim Start stellt die Datenbank die Shop-Liste automatisch um, sonst ist beim Update nichts zu tun.

### Neu
- **Nach Shop filtern:** Das Filterfeld der Wunschliste („Spiel oder Shop filtern …“) nimmt neben Titeln auch Shop-Namen an, ab drei Buchstaben („Ene“, „Driffle“). Dann bleiben die Spiele stehen, bei denen dieser Shop den günstigsten Preis DE oder INT hat; ein Hinweis über der Tabelle sagt das. Der Filter folgt dem Umschalter „Ohne/Mit Gebühren“.

### Geändert
- **Key-Shops ohne „Weiteren Shop hinzufügen“:** Jeder Shop braucht einen eigenen, geprüften Reader, eine Shop-URL allein reicht nie. Deshalb stehen alle eingebauten Shops (Eneba, Driffle) immer in der Liste, und der Schalter „Aktiv“ ist die einzige Steuerung; „Entfernen“ entfällt. Ein Shop, den du vorher nicht hinzugefügt oder entfernt hattest, erscheint ausgeschaltet. Einen Produktlink kannst du nur für einen eingeschalteten Shop ergänzen.

### Nicht enthalten
- **Gamivo:** Gamivo sperrt über Cloudflare alle Seiten außer robots.txt für automatische Abrufe (HTTP 403). KeyHunter umgeht keinen Bot-Schutz, deshalb gibt es keinen Gamivo-Reader.

## 0.7.3 – 2026-11-21

Falsche Produktzuordnungen lassen sich löschen, und die Wunschliste zeigt Preise wahlweise mit geschätzten Gebühren. Beim Start legt die Datenbank automatisch eine neue Tabelle an, sonst ist beim Update nichts zu tun.

### Neu
- **Zuordnung löschen:** Unter Infos → Produktzuordnungen hat jede Zuordnung, ob aktiv oder verworfen, oben rechts einen Löschen-Knopf. Nach einer Rückfrage verschwindet sie samt ihren gespeicherten Preisen. Die automatische Suche schlägt dieses Produkt für das Spiel nicht mehr vor. Fügst du den Link später selbst hinzu, wird er wieder beobachtet. „Verwerfen“ legt eine Zuordnung wie bisher nur beiseite.
- **Preise ohne oder mit Gebühren:** In der Leiste über der Wunschliste schaltet „Ohne Gebühren / Mit Gebühren“ alle Preise der Tabelle um, also Preis DE, Preis INT, Ersparnis, Sortierung, Filter und den 14-Tage-Verlauf. Mit Gebühren zählt der geschätzte Gesamtpreis mit den Gebühren aus Einstellungen → Key-Shops; Shops ohne eingestellte Gebühren zählen dann nicht mit, weil ihr Gesamtpreis unbekannt ist. Ohne Gebühren steht der geschätzte Gesamtpreis im Hinweistext des Preises, mit Gebühren der Grundpreis. „Ziel erreicht“ vergleicht jeweils Alarme mit derselben Preisgrundlage. Die Wahl bleibt im Browser gespeichert.

## 0.7.2 – 2026-11-21

Driffle findet jetzt deine Spiele, die Bibliothek nimmt Spiele direkt auf und hat eine Listenansicht. Beim Start passt die Datenbank den Driffle-Index automatisch an, sonst ist beim Update nichts zu tun.

### Behoben
- **Driffle lieferte keine Angebote:** Driffle las bisher nur eine einzige Übersichtsseite mit rund 28 Spielen, und die Region blieb im Titel stehen („forza horizon 5 eu“), sodass praktisch kein Wunsch einen Driffle-Treffer bekam. Jetzt liest KeyHunter Driffles Produkt-Sitemaps (16 Dateien, laut robots.txt freigegeben): nach dem Update einmal alle direkt nacheinander, danach eine Datei alle 4,5 Stunden, also alle drei Tage den ganzen Katalog. Regionen im Titel zählen beim Abgleich mit, Zusatzinhalte, Währungen und Konten bleiben außen vor. Ein neu hinzugefügtes Spiel bekommt seine Driffle-Treffer spätestens nach drei Tagen.
- Driffle führt ein Spiel oft in mehreren Regionen (Europa, Global, Argentinien, USA …); jede Region wird ein eigener Link mit eigenen Abfragen. Reicht das Tageslimit für Driffle unter Key-Shops nicht, prüft KeyHunter die Regionen entsprechend seltener.

### Neu
- **Direkt zur Bibliothek hinzufügen:** In der Bibliothek öffnet „Spiel hinzufügen“ einen eigenen Dialog; das gewählte Spiel landet sofort als gekauft in der Bibliothek, ohne Umweg über die Wunschliste und ohne Preisabfragen. Ohne Katalogtreffer lässt sich ein Titel auch manuell hinzufügen. Steht das Spiel schon auf der Wunschliste, fragt KeyHunter nach und verschiebt es dann wie „Gekauft“ samt Preisverlauf. Auf dem Handy sitzt der Knopf als „+“ im Kopf der Bibliothek.
- **Kacheln oder Liste:** Zwei Symbole im Kopf der Bibliothek schalten zwischen den Cover-Kacheln und einer Liste mit kleinem Cover, System und Kaufdatum um. Die Wahl bleibt im Browser gespeichert.

## 0.7.1 – 2026-11-21

Mehr Einstellungen für die Wunschliste, Play/Pause direkt am Abrufstatus und ein ruhigerer Schriftzug im Logo. Die Datenbank bekommt beim Start automatisch zwei neue Spalten, sonst ist beim Update nichts zu tun.

### Neu
- **Spalten ein- und ausblenden:** In „Wunschliste · Spalten“ hat jede Spalte einen Schalter. Die Spalte, die das Spiel öffnet, bleibt immer sichtbar.
- **Was die Detailseite öffnet:** Unter „Detailseite öffnen über“ wählst du Button, Titel oder Cover; nur dieses eine Element öffnet das Spiel.
- **Play/Pause am Abrufstatus:** Die automatischen Abfragen pausierst und setzt du jetzt mit dem Knopf in der Abrufstatus-Karte der Seitenleiste fort; die Karte zeigt, seit wann pausiert ist. Das Feld dafür in den Einstellungen entfällt.

### Oberfläche
- **Preis INT:** Die Spalte „Günstigste Region“ heißt jetzt „Preis INT“, passend zu „Preis DE“ (bzw. dem Kürzel deines Ziellands).
- **Anbieter unter den Preisen:** Unter „Preis DE“ steht nur noch der Anbieter (die Region ergibt sich aus der Spalte), unter „Preis INT“ jetzt ebenfalls der Anbieter.
- **Logo:** Der Schriftzug ist kleiner (zwischen der Größe vor 0.7.0 und der von 0.7.0), mittig zur Kachel und füllt den Kasten bis zum rechten Rand; die Kachel steht unverändert.

## 0.7.0 – 2026-11-21

Neues Logo und neue Icons, Abfragen lassen sich pausieren, und die Spalten der Wunschliste lassen sich per Drag & Drop anordnen. Die Datenbank bekommt beim Start automatisch eine neue Spalte, sonst ist beim Update nichts zu tun.

### Neu
- **Abfragen pausieren:** Unter Einstellungen → Abrufstatus hält „Abfragen pausieren“ alle automatischen Abfragen an, bis du „Abfragen fortsetzen“ drückst; seit wann pausiert ist, steht dort, in der Abrufstatus-Karte der Seitenleiste und in der Kachel „Abrufe heute“. „Jetzt aktualisieren“ in einem Spiel und die erste Suche nach einem neu hinzugefügten Spiel laufen weiter. Nach dem Fortsetzen holt KeyHunter die fälligen Abfragen gleichmäßig über das Tageslimit verteilt nach.
- **Spalten per Drag & Drop:** In „Wunschliste · Spalten“ lässt sich jede Zeile am Griff an ihren neuen Platz ziehen (Maus oder Touch, Escape bricht ab); die Pfeile bleiben für die Tastatur. Wie alle Einstellungen gilt die neue Reihenfolge nach „Speichern“.

### Oberfläche
- **Neues Logo:** Preisschild mit Schlüsselloch auf oranger Kachel, daneben der Schriftzug KEYHUNTER in der Mono-Schrift der App. Favicon, App-Icon und Unraid-Icon zeigen dieselbe Kachel und bleiben auf hellen wie dunklen Hintergründen sichtbar; die Farben des Web-App-Manifests passen jetzt zur App.
- **Infos-Tab:** Lange Angaben wie viele Plattformen oder alternative Titel brechen innerhalb der Tabelle um, statt über den Rand zu laufen. Die Spielbeschreibung steht in einer eigenen Box.

## 0.6.5 – 2026-11-21

Einstellungen werden erst mit „Speichern“ übernommen, alle Regionen werden gleich behandelt und günstige öfter abgefragt als teure, und die Spalten der Wunschliste lassen sich anordnen. Die Datenbank bekommt beim Start automatisch neue Spalten, sonst ist nichts zu tun.

### Neu
- **Speichern statt automatisch:** Änderungen in den Einstellungen bleiben ein Entwurf, bis du oben „Speichern“ drückst; „Verwerfen“ kehrt zum gespeicherten Stand zurück. Solange etwas offen ist, bleibt die Kopfzeile beim Scrollen sichtbar. Wer die Einstellungen mit offenen Änderungen verlässt, wird gefragt: speichern, verwerfen oder zurück.
- **Zielland nur noch in den Einstellungen:** Die Auswahl in der Seitenleiste entfällt; das Zielland wird unter Einstellungen → Allgemein gewählt und gilt erst nach „Speichern“.
- **Alle Regionen gleich, Abfragen nach Preistrend:** Bisher wurden Angebote, die im Zielland nicht aktivierbar sind, nur alle 3 × Intervall abgefragt und bei knappem Tagesbudget hintangestellt. Jetzt zählt die Region nicht mehr: Jede Messung bestimmt, wo eine Produktseite preislich im Vergleich zu allen Regionen desselben Spiels liegt (günstigste bis teuerste), ein gleitender Durchschnitt über etwa die letzten zehn Messungen ergibt den Trend. Die über längere Zeit günstigste Region wird bis zu doppelt so oft abgefragt, die teuerste nur noch halb so oft, alles dazwischen stufenlos. Ausverkaufte Produkte werden halb so oft geprüft und bei knappem Budget hintangestellt, bis sie wieder lieferbar sind. Bei gleichen Preisen oder ohne Vergleich bleibt das eingestellte Intervall. Das Zielland entscheidet nur noch, welcher Preis als Bestpreis zählt. **Hinweis:** Weil alle Regionen jetzt im eingestellten Intervall laufen, steigt der Tagesbedarf deutlich; die Kachel „Abrufe heute“ und die Seite Abrufstatus zeigen, ob das Tageslimit reicht.
- **Trend sichtbar:** Der Preis-Tab nennt die Region, die meist am günstigsten ist; unter Infos → Produktzuordnungen steht bei jedem Produkt, wie oft es abgefragt wird und ob es meist günstig oder meist teuer ist.
- **Spaltenreihenfolge der Wunschliste:** Unter Einstellungen → Allgemein → „Wunschliste · Spalten“ lässt sich jede Spalte mit den Pfeilen nach oben oder unten verschieben, zum Beispiel der Details-Knopf vor das Cover. Die Reihenfolge gilt auf allen Geräten; „Standard wiederherstellen“ setzt sie zurück. Auf dem Smartphone bleibt die Kartenansicht gleich.

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
