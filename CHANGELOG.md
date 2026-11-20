# Änderungen

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
