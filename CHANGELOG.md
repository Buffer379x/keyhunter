# Änderungen

## 1.1.2 – 2026-11-25

Ein Pfeil zeigt in der Wunschliste auf einen Blick, ob ein Preis zuletzt günstiger oder teurer geworden ist, und die Bibliothek nimmt Spiele auch dann manuell auf, wenn die Suche ähnliche Treffer findet. Keine Migration und keine Änderung an der Unraid-Vorlage, beim Update ist nichts zu tun.

### Neu
- **Preistrend in der Wunschliste:** Vor „Preis DE“ (dem Preis im Zielland) und „Preis INT“ steht ein kleiner Pfeil im farbigen Kreis. Er zeigt die letzte Änderung des Preises: grün nach oben, wenn er günstiger geworden ist, rot nach unten, wenn er teurer geworden ist, grau nach rechts, wenn er sich in den letzten 14 Tagen nicht geändert hat. Beim Zeigen auf den Pfeil stehen Betrag, vorheriger Preis und Zeitpunkt da, etwa „Günstiger geworden (vor 6 Std.): −2,00 €, vorher 36,99 €“. Mit „Mit Gebühren“ vergleicht der Pfeil die geschätzten Gesamtpreise. Ohne früheren Preis (erster Preis, wieder lieferbar) und bei einem nur zuletzt bekannten, veralteten Preis erscheint kein Pfeil. Auch auf dem Phone steht der Pfeil vor dem Preis.

### Geändert
- **Bibliothek: manuell hinzufügen trotz Treffern:** Nicht jedes Spiel steht in IGDB. Findet die Suche nur andere Spiele, ließ sich ein Spiel bisher nicht manuell in die Bibliothek aufnehmen, weil „Manuell hinzufügen“ nur ohne Treffer erschien. Jetzt steht unter den Treffern immer „Nicht dabei? Manuell hinzufügen“ mit der Wahl des Systems. Die Wunschliste bleibt bei Katalogspielen: Dort erscheint „Manuell vormerken“ weiterhin nur ohne Treffer.

## 1.1.1 – 2026-11-23

Bündel und erweiterte Fassungen lassen sich vormerken, ein halb so großes Image ohne Shell mit deutlich weniger bekannten Schwachstellen, und große Wunschlisten mit vielen Editionsvorschauen werden wieder schnell. Keine Migration und keine Änderung an der Unraid-Vorlage, beim Update ist nichts zu tun.

### Geändert
- **Bündel lassen sich vormerken.** Produkte, die IGDB als Bündel ohne Hauptspiel führt (etwa „Final Fantasy VII Remake Intergrade“), waren als „Bündel · Inhalte ungeklärt“ gesperrt. Sie werden jetzt wie ein Spiel unter ihrem eigenen Titel vorgemerkt und zugeordnet. Angebote für die enthaltenen Spiele landen nicht beim Bündel und umgekehrt.
- **Erweiterte Fassungen lassen sich vormerken.** Spiele, die IGDB als „Expanded Game“ führt (etwa „Death Stranding: Director's Cut“), erschienen als „Produkttyp ungeklärt“. Sie heißen jetzt „Erweiterte Fassung“ und werden ebenfalls unter ihrem eigenen Titel vorgemerkt. DLCs und Mods bleiben ausgeschlossen.
- **Schlankeres, sichereres Image:** Der Container baut jetzt auf einem Distroless-Image (Debian 13) auf. Es enthält nur KeyHunter, die Weboberfläche, die Systembibliothek und die Zertifikate, keine Shell und keine Paketverwaltung. Den Start unter Unraid (Rechte am Datenordner, Wechsel auf den Benutzer 10001 ohne Sonderrechte) erledigt KeyHunter selbst. Das Image ist mit 73 statt 157 MB (19 statt 40 MB beim Download) halb so groß. Der Sicherheitsscanner Trivy findet statt 262 nur noch 55 bekannte Schwachstellen, davon 2 statt 39 hohe und keine kritische mehr.
- **Einrichtungscode per Befehl:** Weil das Image kein `cat` mehr hat, zeigt jetzt `docker exec KeyHunter /app/keyhunter --setup-code` den Einrichtungscode; die Hilfe auf der Einrichtungsseite nennt diesen Befehl. Befehle mit `sh` im Container funktionieren nicht mehr. Dateien im Datenordner liest du auf dem Host (Unraid: `/mnt/user/appdata/keyhunter`).
- **Abgelaufene Sitzung:** Läuft die Anmeldung ab, erscheint die Anmeldeseite jetzt sofort, nicht erst bei der nächsten Aktion.

### Behoben
- **Langsamer Abruf bei vielen Editionsvorschauen:** Bei großen Wunschlisten mit vielen beobachteten Editionen brauchte die Auswahl des nächsten Abrufs bis zu 1,6 Sekunden, der Abrufstatus etwa 5 Sekunden und die Preis-Badges der Wunschliste mehrere Zehntelsekunden. Jetzt sind es wenige Millisekunden bzw. etwa 0,1 Sekunden, unabhängig von der Zahl der Vorschauen. Welche Abrufe in welcher Reihenfolge laufen, ändert sich nicht.

### Intern
- **Aufgeräumter Oberflächen-Code:** Sitzung, CSRF-Token und Abmeldung nach einem 401 liegen an einer Stelle, ebenso die Adresse (Seite, Spiel, Tab) und das regelmäßige Nachladen. Die Spielseite hat ihren eigenen Zustand statt 29 durchgereichter Werte. Neue Tests halten Anfragen und Takt, Zurück-Taste und Fokus sowie die Anmeldung nach abgelaufener Sitzung fest.

## 1.1.0 – 2026-11-23

Ein besseres Prüftempo, das jede Region gleich behandelt, eine gerechtere Verteilung bei knappem Budget, ein direkter Weg vom Warndreieck zu den Zuordnungen und eine einheitliche Schrift. Keine Migration, beim Update ist nichts zu tun.

### Geändert
- **Prüftempo nach Abstand zum günstigsten Preis:** Wie oft ein Angebot geprüft wird, richtet sich jetzt danach, wie weit sein Preis über dem günstigsten lieferbaren Angebot des Spiels in allen Regionen liegt. Der günstigste Preis wird doppelt so oft geprüft wie eingestellt, 10 % darüber etwa 1,6-mal so oft, gut 40 % darüber im eingestellten Intervall, das Doppelte und mehr halb so oft. Bisher zählte die Stellung zwischen günstigstem und teuerstem Angebot: Schon 1 Cent Unterschied konnte das Tempo halbieren, und ein einzelnes sehr teures Angebot verschob alle anderen. Ein einzelnes Angebot gilt jetzt als günstigstes, statt auf seinem alten Tempo stehen zu bleiben. Die Hilfe zum Prüftempo beschreibt die neue Regel.
- **Jede Region gleich behandelt:** Ob eine Region im Zielland gilt, spielt für das Prüftempo keine Rolle. Ein gleich teures Angebot aus einer anderen Region wird genauso oft geprüft wie ein im Zielland gültiges, ein günstigeres öfter.
- **Abrufbedarf:** In der Simulation braucht die neue Regel im Mittel rund 7 % weniger Abrufe am Tag (je nach Wunschliste 3 bis 11 % weniger) und erkennt etwas mehr Preisänderungen. Mehr Abrufe werden es bei Spielen, deren Regionen fast gleich viel kosten: Dort gelten alle als günstigste und werden bis zu doppelt so oft geprüft. Die Bedarfsanzeige im Abrufstatus zeigt nach etwa einem Tag den neuen Wert; liegt er über dem Tageslimit, helfen ein höheres Limit oder ein längeres Intervall. Gespeicherte Werte gleichen sich nach einigen Abrufen von selbst an.
- **Kein Aushungern bei knappem Budget:** Jeder vierte Abruf geht weiterhin an Wiederholungssuchen, ausverkaufte Angebote, Editionsvorschauen und die Discovery, jetzt aber reihum. Bisher konnten viele Editionsvorschauen die Discovery und die wöchentlichen Suchen wochenlang verdrängen. Jetzt läuft die Discovery bei Engpass mindestens alle zwei Tage, und auch die Suchen kommen wieder regelmäßig dran.
- **Warndreieck führt zu den Zuordnungen:** Ein Klick, Enter oder Tipp auf das gelbe Warndreieck hinter einem Titel öffnet das Spiel direkt im Tab „Zuordnungen“, in der Wunschliste und im Warenkorb. Ein Schritt zurück führt wieder in die Liste. Auf dem Phone ist das Dreieck gut zu treffen; ein Tipp auf die übrige Karte öffnet das Spiel wie bisher im Tab „Preis“.
- **Einheitliche Schrift:** Hervorhebungen sind überall gleich kräftig (bisher an einigen Stellen fetter), und alle Schriftgrößen folgen einer festen Skala. Dadurch werden einige Texte etwas größer, etwa die Kanalzeile unter „Letzte Zustellungen“, die Cent-Beträge der großen Preise und die Initialen auf dem großen Cover.

### Behoben
- **Preisalarme auf dem Phone:** In „Letzte Zustellungen“ lag der Titel einer Zustellung unter der Pille „Zugestellt“. Die Karte zeigt jetzt Titel und Preis, darunter die Zeit, dann den Status mit der Kanalzeile über die volle Breite.

### Intern
- **Aufgeräumter Server-Code:** Abrufdienst und Benachrichtigungen sind in kleinere Module aufgeteilt, Shop-Wissen liegt gesammelt bei den Shops. Anmeldung und CSRF-Prüfung sitzen an einer einzigen Stelle vor allen geschützten Routen; ein Test prüft jede Route, damit keine neue ungeschützt bleibt. Für Nutzer ändert sich nichts.

## 1.0.2 – 2026-11-23

Feinschliff nach dem Feedback zu 1.0.1 und alle offenen Updates der Abhängigkeiten. Keine Migration, beim Update ist nichts zu tun. Vorhandene Passphrasen gelten weiter.

### Geändert
- **Mehr Platz auf breiten Fenstern:** Der Inhalt steht jetzt direkt neben dem Menü, statt auf großen Bildschirmen mittig mit einer Lücke links. Er nutzt die Breite bis 1920 Pixel.
- **Bibliothek in einer Box:** Wie die Wunschliste steht die Bibliothek jetzt in einem Kasten. Sortierung, Ansicht, Suche, System und das Schloss sitzen in dessen Kopfzeile, die Spiele auf der Innenfläche.
- **Umschalter wie im Log:** In Tabellenspalten, Benachrichtigungen › Kanäle und Key-Shops sitzt der Umschalter jetzt in einer eigenen Zeile auf dem Kasten, nicht mehr auf der gleichfarbigen Innenfläche. Umschalter, die innerhalb einer Innenfläche bleiben (etwa „Detailseite öffnen über“), heben sich mit dem dunkleren Hintergrund ab.
- **25 Einträge pro Seite** sind jetzt Standard für Wunschliste, Log und Abrufe. Wer eine andere Seitengröße gewählt hat, behält sie.
- **Abhängigkeiten aktualisiert:** argon2 0.6 (Passphrasen-Hashing; bestehende Passphrasen bleiben gültig), sha2 0.11, getrandom 0.4, scraper 0.29, Node 26 im Build, knip 6, @types/node 26, außerdem die GitHub Actions checkout, setup-node und upload-artifact.

### Behoben
- **Log mit Jahr:** Die Zeit im Log zeigt jetzt das vollständige Datum mit Jahr (23.11.2026, 14:05:09). In 1.0.1 fehlte es dort noch.

## 1.0.1 – 2026-11-23

Kleine Verbesserungen nach dem Feedback zu 1.0: Prüftempo mit Score und Farbe, Symbole im Warenkorb, verständlicher Abrufstatus mit Jahr, einheitliche Umschalter und ein sauberes Favicon. Nur die Oberfläche ändert sich: keine Migration, beim Update ist nichts zu tun. Falls im Browser-Tab noch das alte Favicon erscheint, die Seite einmal mit Strg+F5 neu laden.

### Geändert
- **Prüftempo mit Score und Farbe:** In der Angebotstabelle (und auf den Karten) ist das Prüftempo jetzt ein farbiges Etikett: häufig grün, normal neutral, selten gelb. Ein Klick oder Tipp (am Rechner auch Überfahren) öffnet ein Popup mit dem Score von 0 bis 100, dem Tempo, dem Preistrend und dem geplanten Abfrageintervall. Die Hilfetexte erklären, was ein hoher und ein niedriger Score bedeutet.
- **Warenkorb:** Hinter dem Titel zeigt der Warenkorb jetzt wie die Wunschliste das Pausensymbol und das Warndreieck für ungeprüfte Zuordnungen. Beide Listen nutzen dieselbe Komponente.
- **Abrufstatus › Abrufe:** Die Spalte „Ziel“ heißt jetzt „Gefunden“, denn sie zeigt das Ergebnis der Abfrage: bei einer Produktseite „ab 12,99 €“ statt „1299 ct“ oder die Verfügbarkeit in Worten („ausverkauft“), bei einer Suche die Zahl der Treffer. Ältere Einträge werden beim Anzeigen umgewandelt.
- **Zeitangaben mit Jahr:** Im Abrufstatus, im Log und an den übrigen Stellen steht jetzt das Jahr (23.11.2026, 14:05).
- **Einheitlicher Umschalter:** Wo innerhalb eines Kastens umgeschaltet wird, gibt es jetzt denselben abgerundeten Umschalter wie beim Stufenfilter: Einstellungen › Tabellenspalten, Benachrichtigungen › Kanäle, Key-Shops und die Filter der Wunschliste (mit den Anzahlen). Key-Shops ist dabei wie Kanäle aufgebaut: ein Kasten „Key-Shops“ mit dem Umschalter oben (ausgeschaltete Shops mit „· aus“) und darunter dem Schalter „Aktiv“ und den Einstellungen des gewählten Shops.

### Behoben
- **Favicon:** Das Schlüsselloch war im 16- und 32-Pixel-Symbol zu einem Pilz geworden, und das Preisschild saß am rechten Rand. Beide Symbole folgen jetzt der Hauptzeichnung: Schild mittig, Spitze links, rundes Schlüsselloch mit schmalem Schaft.

## 1.0.0 – 2026-11-23

KeyHunter 1.0: Die Wunschliste lässt sich aus der Exportdatei wieder einlesen, Sichern und Wiederherstellen sind dokumentiert und praktisch geprüft, und alle Fehler aus dem Release-Audit sind behoben und durch Tests abgesichert. Beim Update ist nichts zu tun: keine Migration, die Daten bleiben unverändert; als Rückweg genügt ein Kaltbackup des Datenordners (siehe `docs/operations.md`). Wer direkt von 0.9.1 oder älter kommt, findet unten die wichtigsten Verhaltensänderungen seit 0.9.1 zusammengefasst; die Einzelheiten stehen bei 0.9.2 bis 0.9.4. Gegenüber dem Release-Kandidaten 1.0.0-rc.1 ändert sich nur die Versionsnummer.

### Neu
- **Sichern & Wiederherstellen** (Einstellungen › System): Die Wunschliste lässt sich aus der Exportdatei wieder einlesen. Vor dem Hinzufügen zeigt ein Dialog, wie viele Spiele neu sind, schon auf der Liste oder in der Bibliothek stehen, dem Katalog unbekannt oder ungültig sind. Der Import geht pro Eintrag denselben Weg wie das Vormerken von Hand, löscht und überschreibt nichts und lässt bestätigte Zuordnungen unberührt; ein zweiter Import derselben Datei ändert nichts. Importierte Spiele werden im normalen Abruftempo gesucht, damit ein großer Import nicht das Budget eines ganzen Tages verbraucht; **Jetzt prüfen** sucht ein einzelnes sofort, ein von Hand hinzugefügtes Spiel wird wie bisher sofort gesucht. Der Export zog dafür aus „Allgemein“ in dieses Panel. Das Fragezeichen erklärt die vollständige Sicherung (Datenverzeichnis, Sicherungen vor Migrationen, Kaltbackup).
- **Parserprüfung vor einem Update, nur von Hand:** `KEYHUNTER_CANARY_CONSENT=1 sh deploy/parser-canary.sh <Produktlink>...` ruft je Shop eine Produktseite (und die robots.txt) mit dem eigenen Client ab und meldet, ob KeyHunter dort noch Produkte mit Preisen findet. Das Skript nennt immer zuerst, welche Adressen ein Lauf kontaktieren würde; ohne Zustimmung endet es, ohne etwas abzurufen. Es läuft nie in Tests oder CI.
- **Healthcheck ohne curl:** Der Container prüft sich mit `keyhunter --health`. Das Image enthält kein curl mehr; wer curl im Container für eigene Skripte genutzt hat, braucht dafür jetzt einen eigenen Weg.

### Behoben
- **„Editionen werden vorbereitet …“ blieb hängen:** Wer ein Spiel verließ oder die Seite neu lud, während die Editionen vorbereitet wurden, sah den Hinweis bis zu drei Minuten lang. Die Vorbereitung läuft jetzt zu Ende, auch wenn der Browser die Anfrage abbricht.
- **Kein Spiel ohne Suche:** Wurde die Verbindung beim Hinzufügen genau im falschen Moment unterbrochen, konnte ein Spiel ohne Preissuche auf der Wunschliste stehen. Wunsch und Suche werden jetzt gemeinsam gespeichert.
- **„Bedarf pro Tag“ und „zu knapp“** berücksichtigen den Rückstau toter Produktseiten (ab fünf Fehlschlägen in Folge viermal seltener geprüft) genau wie der Abrufplan. Bisher wurde der Bedarf zu hoch geschätzt, sobald Produktseiten nicht mehr gefunden wurden.
- **Sicherheit:** Jede ändernde Anfrage ohne gültigen CSRF-Token oder mit fremdem Origin wird mit 403 abgewiesen, bevor ihr Inhalt gelesen wird. Bisher antworteten einzelne Routen bei kaputtem Inhalt zuerst mit 400. Die größere Datenmenge des Imports (128 KiB) nimmt der Server nur von angemeldeten Browsern an, alle anderen Anfragen bleiben bei 16 KiB.

### Schneller und ruhiger
- Die Wunschliste liest ihre Preisanzeigen beim Laden nur noch einmal statt zweimal. Danach aktualisiert sie sich wie bisher einmal pro Minute, bei einem selbst angestoßenen Abruf alle drei Sekunden; ein Wunsch, der nur in der Warteschlange steht, fragt nicht mehr im Drei-Sekunden-Takt.
- Die Filterleiste der Wunschliste behält beim Laden ihre Größe; die Tabelle springt nicht mehr nach unten, wenn pausierte Wünsche vorhanden sind. Einstellige Zähler belegen dafür die Breite von zwei Ziffern.
- Der Start prüft die Produkt-Fingerabdrücke mit einer festen Zahl an Datenbankabfragen, auch bei sehr vielen Zuordnungen.

### Dokumentation
- **Datenquellen** (`docs/data-sources.md`): je Quelle (Eneba, Driffle, IGDB, Microsoft-Katalog), was abgerufen wird, wie oft und wie gedrosselt (Budget, Abstand, Crawl-Delay, Retry-After, Pausen), Kennung, Umgang mit robots.txt und die Verantwortung des Betreibers für die Bedingungen der Seiten.
- **Reverse Proxy** (`docs/reverse-proxy.md`): Beispiele für Caddy, Nginx Proxy Manager und Traefik mit `KEYHUNTER_ORIGIN`, `KEYHUNTER_TRUSTED_PROXY`, HSTS, wann HTTP erlaubt und wann HTTPS nötig ist, und was bei falscher Adresse bricht.
- **Kaltbackup und Wiederherstellung** in `docs/operations.md`, praktisch nachgewiesen mit `sh deploy/backup-restore-check.sh`.
- **Abnahme auf Unraid** (`docs/release-1.0-acceptance.md`): am Release-Kandidaten in einem Testcontainer, Installation, Update, Neustart, Sicherung und Rückweg Schritt für Schritt zum Abhaken. Ein Update von 0.9.4 legt keine automatische Sicherung an (keine Datenbankänderung); das Kaltbackup ist der Rückweg.
- **Betrieb** (`docs/operations.md`): Import-Schnittstelle und ihre Grenzen; die veraltete Grenze von 100 Wünschen ist entfernt.

### Was sich seit 0.9.1 im Verhalten geändert hat
- **Anmeldung:** Fehlversuche bremsen nur noch die Adresse, von der sie kommen (5 je 15 Minuten, 100 insgesamt); ein Fremder kann den Eigentümer nicht mehr aussperren. Hinter einem Reverse Proxy zählt die echte Adresse nur mit `KEYHUNTER_TRUSTED_PROXY`. Die Passphrase lässt sich ändern, „Überall abmelden“ beendet alle Sitzungen, und `keyhunter --reset-owner` setzt einen vergessenen Zugang auf dem Host zurück (0.9.2, 0.9.3).
- **Frische:** Ein Preis bleibt so lange aktuell, wie das Abfrageintervall seines Produkts es vorsieht (doppeltes Intervall, mindestens 24 Stunden), überall gleich: Preis, Wunschliste, Verlauf, Warenkorb und Alarme (0.9.3).
- **Zuordnung:** Gleichnamige Spiele aus einem anderen Erscheinungsjahr werden nicht mehr automatisch zugeordnet; Konten und PC-Produkte zählen nie als Key-Preis. Bereits bestätigte Zuordnungen bleiben unverändert (0.9.3).
- **Veraltete Angebote** zeigen keine Ersparnis und keinen Warenkorb-Knopf; tote Produktseiten werden nach fünf Fehlschlägen seltener geprüft (0.9.3).
- **EU-Zielländer** bekommen Preis, Trend und Verlauf aus dem EU-Markt (0.9.3).
- **„Score“ heißt „Prüftempo“** und ist standardmäßig ausgeblendet (0.9.3).
- **Layout** für Phone, Tablet und Laptop, Touch-Ziele mindestens 44 px, einheitliche Zustände, Tab „Zuordnungen“ statt „Infos“ (alte Links gehen weiter), „Gekauft“ fragt nach (0.9.4).

### Entwicklung
- Neue Tests: Fehlerklassen der Shop-Abrufe gegen einen lokalen Testserver, CSRF- und Origin-Matrix über alle Routen, Update einer 0.9.1-Datenbank ohne Verlust, Abgleich der Server-Antworten mit den TypeScript-Typen (`frontend/tests/contract/`, Aktualisierung mit `KEYHUNTER_UPDATE_CONTRACT=1`), Abfragezahl unabhängig von der Listengröße, Abfragetakt, Alarm-Frische, Import, Kaltbackup. Browser-Tests laufen zusätzlich gegen das echte Backend mit gesäten Preisdaten (`frontend/e2e/priced/`, `KEYHUNTER_FIXTURE_PRICES=1`).
- Das Frontend verlässt sich auf die Felder, die der Server immer sendet; die Ersatzwerte für ältere Server sind entfernt.
- Basisimages im Dockerfile per Digest festgelegt, Dependabot für Cargo, npm, Docker und GitHub Actions.
- Release-Kandidaten (etwa `1.0.0-rc.1`) erscheinen als eigenes Image unter ihrer Versionsnummer und verschieben `latest` nie.
- Abnahme am Release-Kandidaten 1.0.0-rc.1 mit den Parametern des Unraid-Templates bestanden: Installation von 0.9.4, Update, Neustart, Anmeldung, Export und Import, Kaltbackup, `--reset-owner`, Rollback und Neuinstallation; die Parserprüfung fand bei Eneba und Driffle Produkte mit Preisen.

## 0.9.4 – 2026-11-23

Das neue Layout für Phone, Tablet und Laptop: Wunschliste und Angebote werden auf schmalen Bildschirmen zu Karten, nichts läuft mehr seitlich aus dem Bild, und auf Touch-Geräten sind alle Bedienelemente groß genug. Zustände sehen überall gleich aus, eine Checkliste führt durch den ersten Start, und die Hauptansichten sind ohne schwere Barrierefreiheitsfehler. Nur die Oberfläche ändert sich: keine Migration, beim Update ist nichts zu tun. Falls im Browser-Tab noch das alte Favicon erscheint, die Seite einmal mit Strg+F5 neu laden.

### Neu
- **Erste Schritte:** Unter der Wunschliste steht für eine neue Installation eine Checkliste: Zielland, Spieleindex (IGDB), Key-Shop, erstes Spiel und Benachrichtigungskanal. Jeder Schritt zeigt „Erledigt“ oder „Offen“, ein Klick führt direkt an die richtige Stelle. Das Fragezeichen erklärt, wofür jeder Schritt nötig ist, auch woher Client-ID und Secret für IGDB kommen. Die Liste verschwindet, sobald alles erledigt ist, und lässt sich mit dem X ausblenden (das merkt sich der Browser).
- **Einrichtung:** Die Einrichtungsseite sagt in einem Satz, was KeyHunter macht. Das Fragezeichen am Einrichtungscode nennt, wo die Datei `bootstrap-token` liegt (im Container `/data/bootstrap-token`, unter Unraid im Ordner „App data“) und wie man sie im Terminal anzeigt.
- **„Gekauft“ fragt nach:** Vor dem Verschieben in die Bibliothek erscheint eine kurze Rückfrage. Sie nennt, was endet (Preisabfragen, Preisalarm, Warenkorb-Eintrag).
- **Spiel hinzufügen auf dem Phone:** Oben rechts gibt es einen orangen **+**-Knopf.

### Layout
- **Wunschliste auf dem Phone:** Jeder Eintrag ist eine Karte. Der Titel steht mit Cover über die volle Breite, Warenkorb-, Pause- und Warnsymbol direkt daneben. Darunter stehen „Preis DE“ und „Preis INT“ mit Beschriftung, darunter die Status-Pillen. Ein Tipp irgendwo auf die Karte öffnet das Spiel. Am Desktop öffnet weiterhin nur der eingestellte Öffner (Details-Knopf, Titel oder Cover).
- **Wunschliste auf Tablet und Laptop:** Die Ansicht richtet sich nach der Breite der Liste, nicht nach der Fensterbreite. Bei 1024 px mit Seitenleiste lief die Tabelle bisher über und schnitt Status und Öffnen-Knopf ab. Jetzt gilt: ab 980 px Listenbreite die volle Tabelle, darunter eine Tabelle ohne „Ziel“ und „14 Tage“, unter 800 px Karten.
- **Angebote:** „Zum Shop“ und der Warenkorb-Knopf bleiben immer rechts im Bild, auch wenn die Tabelle seitlich scrollt. Unter 1240 px Tabellenbreite wird die Tabelle kompakter, dadurch passt sie bei 1366 × 768 vollständig. Unter 980 px werden die Angebote zu Karten, auf dem Phone zu schmalen Karten.
- **Tab-Leisten** (Spieldetails, Einstellungen, Key-Shops, Kanäle, Tabellenspalten): Der aktive Tab wird in der Leiste sichtbar gescrollt, auch wenn er über einen Link geöffnet wurde. Ein Pfeil am Rand zeigt weitere Tabs an und blättert bei Klick weiter.
- **Menüs** wie „Pausieren“ und „⋯“ bleiben auf dem Phone im Fenster.
- **Suchpopup auf dem Phone:** Der Kopf ist zweizeilig, oben „Suche · IGDB“ mit dem Schließen-Knopf, darunter die Plattformwahl. Es scrollt nicht mehr seitlich.
- **Detailseite auf dem Phone:** Die Seite lässt sich nicht mehr seitlich verschieben.
- **Touch:** Auf Touch-Geräten sind Knöpfe, Chips, Tabs, Felder und Menüpunkte mindestens 44 × 44 px groß. Mit Maus und Tastatur bleibt alles wie bisher.
- **Ruhigeres Laden:** Die Kennzahl-Kacheln der Wunschliste halten ihren Platz frei, solange die Liste lädt, die Liste springt beim Laden nicht mehr nach unten. Auch der Abrufstatus in der Seitenleiste hat vorab seinen Platz.

Voraussetzung für das neue Layout sind aktuelle Browser (Chrome/Edge ab 105, Safari ab 16, Firefox ab 110). Ältere Browser zeigen die Desktop-Tabellen mit seitlichem Scrollen.

### Geändert
- **Einheitliche Zustände:** Jeder Zustand sieht überall gleich aus. „Ziel erreicht“ ist immer grün mit Haken, auch im Preis-Tab. „Veraltet“ ist immer grau mit Uhr, auch in der Spalte „Gesehen“ der Angebote (bisher gelber Text). „Pausiert“ ist gelb mit Pause-Zeichen, auch in den Preisalarmen. Fehlt ein Preis, steht in der Tabelle „–“; den Grund nennt nur die Status-Spalte.
- **Tab „Zuordnungen“:** Der Tab „Infos“ im Spieldetail heißt jetzt „Zuordnungen“, denn dort werden die Shop-Zuordnungen geprüft. Die Zahl am Tab zeigt weiter, was offen ist. Alte Links mit `tab=infos` öffnen den neuen Tab.
- **Plattform immer sichtbar:** Die Wunschliste zeigt unter dem Titel Edition und Plattform, z. B. „Standard Edition · Xbox One“, statt des Erscheinungsjahrs. Das Jahr steht im Spieldetail. Der Kopf des Spieldetails nennt nur noch die Plattform des Wunsches, nicht alle Systeme des Spiels. Warenkorb und Preisalarme zeigen die Plattform ebenfalls. So lassen sich zwei Wünsche desselben Spiels für verschiedene Xbox-Systeme unterscheiden.
- **Abrufbudget zu knapp:** Braucht ein Shop mehr Abrufe am Tag, als sein Tageslimit erlaubt, wird die Kachel „Abrufe heute“ gelb. Unten steht „zu knapp: Driffle“ (bzw. der betroffene Shop) als Link zu Einstellungen › Key-Shops. Bisher wurde nur die Summe aller Shops verglichen, ein knapper Shop fiel so nicht auf.
- **Cover:** Alle Cover kommen aus einer Komponente. Spiele ohne Bild zeigen überall dieselben Initialen auf einem Farbverlauf, dessen Farbe vom Titel abhängt, jetzt auch in Wunschliste, Warenkorb, Spieldetail und Suchtreffern (bisher ein neutraler Verlauf bzw. das Schlüssel-Zeichen).
- **Texte:** „1 Spiel“ statt „1 Spiele“. Die günstigste Region weltweit heißt überall kurz **INT**, auch in der Diagrammlegende, im Tooltip, in den Editionen und im Preis-Tab („Günstigste Region · INT“). „Basisspiel“, „Edition“ usw. stehen in der Suche nicht mehr in Grün; Grün bedeutet nur noch „gültig“ oder „erreicht“.
- **Lesbarkeit:** Grauer Text hat mehr Kontrast. Tabellenköpfe, Zähler, Zeitstempel („Stand …“) und Hinweise sind heller. Das dunklere Grau bleibt nur für Dekoration und ausgeschaltete Elemente.
- **Favicon:** Im Browser-Tab ist wieder das KeyHunter-Zeichen zu sehen statt einer „1“. Dafür gibt es eine eigene, gröbere Zeichnung für 16 und 32 px. Browser speichern Favicons lange zwischen; erscheint noch das alte Zeichen, hilft Strg+F5 oder das Leeren des Browser-Caches.

### Barrierefreiheit
- **Fokus:** Textfelder und die Suche oben zeigen beim Tastaturfokus denselben orangen Ring wie alle anderen Bedienelemente.
- **Menü auf Tablet und Phone:** Das geöffnete Seitenmenü verhält sich wie ein Dialog. Mit der Tab-Taste bleibt man im Menü, die Seite dahinter ist gesperrt. Das erste Escape schließt das Menü, danach liegt der Fokus wieder auf dem Menü-Knopf.
- **Fragezeichen:** Die Hilfe öffnet nicht mehr schon beim Tabben auf das „?“, sondern bei Klick, Tipp, Enter oder Mausberührung. Screenreader lesen den Text weiterhin vor.
- **Suche oben:** Ein Tab-Stopp im leeren Suchfeld öffnet kein leeres Ergebnisfenster mehr. Es öffnet sich beim ersten Zeichen, bei Klick oder mit Strg+K.
- **Tabellen in Abrufstatus und Log** lassen sich mit der Tastatur erreichen und seitlich scrollen. Die Meldungen unten rechts sind als eigener Bereich „Meldungen“ ausgezeichnet.
- Die Hauptansichten (Wunschliste, alle Detail-Tabs, Warenkorb, Bibliothek, Preisalarme, alle Einstellungs-Tabs, Einrichtung und Anmeldung) haben bei 1366 und 375 px keine schweren Barrierefreiheitsfehler mehr, auch keine Kontrastfehler.

### Entwicklung
- `deploy/browser-check.sh` prüft zusätzlich mit axe auf Barrierefreiheit (keine schweren oder kritischen Fehler erlaubt) und danach die Layouts in WebKit, im Playwright-Image per Docker. `KEYHUNTER_SKIP_WEBKIT=1` überspringt den WebKit-Teil.
- Neue Regressionstests für Karten und Tab-Leisten bei 375 bis 1440 px, Touch-Ziele, das modale Menü, „Gekauft“, die ersten Schritte, `tab=infos` und das Budget je Shop. Die Visual-Baselines sind neu aufgenommen; die Versionsnummer ist darin maskiert.
- CI: Die Browser-Prüfung darf wegen des axe- und WebKit-Laufs 15 statt 5 Minuten laufen.

## 0.9.3 – 2026-11-22

Preise, Trends und Zuordnungen sind ehrlicher: Ein Preis bleibt so lange aktuell, wie sein Abfrageintervall es vorsieht, gleichnamige Spiele aus anderen Jahren werden nicht mehr automatisch zugeordnet, und veraltete Angebote zeigen keine Ersparnis mehr. Eine vergessene Passphrase lässt sich über die Kommandozeile zurücksetzen. Beim Start ergänzt die Datenbank zwei kleine Migrationen (mit Sicherung vorher); bestätigte Zuordnungen bleiben unverändert, sonst ist beim Update nichts zu tun.

### Neu
- **Passphrase vergessen:** `keyhunter --reset-owner` setzt den Eigentümerzugang zurück. Eigentümer und alle Sitzungen werden entfernt, ein neuer Einrichtungscode ersetzt den alten, das Log vermerkt den Schritt. Wunschliste, Bibliothek, Preise, Zuordnungen, Alarme und Einstellungen bleiben erhalten. Danach richtest du den Zugang im Browser neu ein, ohne Neustart. Das geht nur mit Zugriff auf den Docker-Host, nie über die Weboberfläche oder die API. Unraid: `docker exec --user 10001:10001 KeyHunter /app/keyhunter --reset-owner`. Läuft der Befehl als anderer Benutzer als der Dienst (z. B. root), bricht er ohne Änderung ab. Anleitung in docs/operations.md.

### Geändert
- **Ein Preis bleibt so lange aktuell, wie sein Intervall es vorsieht:** Bisher galt jeder Preis nach 24 Stunden als veraltet, egal welches Intervall eingestellt war. Mit 24, 48, 72 oder 168 Stunden Intervall, bei teuren oder ausverkauften Produkten (halbes Tempo) und bei Editionsvorschauen verschwanden Preise dadurch planmäßig zwischen zwei Abfragen: kein Zielland-Preis, keine günstigste Region, keine Alarme. Jetzt gilt ein Preis als aktuell, bis er doppelt so alt ist wie das effektive Intervall seines Produkts, mindestens aber 24 Stunden. Bei 72 Stunden Intervall bleibt ein Preis also 6 Tage aktuell, bei 8 Stunden wie bisher 24 Stunden. Die Regel gilt überall gleich: Preis, Wunschliste, Kennzahlen, Verlauf, Warenkorb und Preisalarme.
- **Gleichnamige Spiele aus einem anderen Jahr werden nicht mehr automatisch zugeordnet:** Ein Wunsch „Doom“ (1993) bekam bisher den Key von „DOOM“ (2016) automatisch zugeordnet. Kennt der Spielekatalog ein gleichnamiges Spiel auf derselben Plattform, das mehr als ein Jahr früher oder später erschienen ist, bleibt ein neu gefundenes Produkt jetzt „zu prüfen“. Ein Xbox-One-Key für einen Wunsch auf Xbox 360 oder der ersten Xbox kann immer auch ein neueres gleichnamiges Spiel sein (etwa „Star Wars Battlefront II“ von 2005 und 2017) und braucht deshalb deine Bestätigung. Der Prüfdialog sagt, warum. **Bereits bestätigte Zuordnungen bleiben unverändert.**
- **Konten und PC-Produkte zählen nie als Key-Preis:** Bisher ließ sich auch ein Konto-Angebot oder ein reines PC-Produkt von Hand bestätigen und zählte danach als günstigster Preis. Jetzt lässt sich nur ein Xbox-Aktivierungscode für die Plattform des Wunsches bestätigen (ein abwärtskompatibler Xbox-One-Key für Series X|S, Xbox 360 oder die erste Xbox weiterhin). Der Prüfdialog nennt den Grund. Solche Angebote, die du früher bestätigt hast, bleiben bestätigt, zählen aber nirgends mehr als Preis und tragen „kein Xbox-Key“.
- **Tote Produktseiten bremsen:** Ist eine Produktseite fünfmal in Folge nicht gefunden oder nicht lesbar, wird sie nur noch mit vierfachem Intervall geprüft, bis ein Abruf wieder gelingt. Das Log meldet das einmal. So verbraucht ein ausgelistetes Produkt kein volles Budget mehr.
- **Einheitliche Fehler:** Auch ungültige Anfragen, eine falsche Methode und zu lange laufende Anfragen antworten als deutsches JSON mit `code`. Außer Einrichtung und Anmeldung prüft jede API-Route zuerst die Sitzung; ohne Sitzung kommt immer „nicht angemeldet“, auch bei kaputter Anfrage.
- **Weniger Anfragen:** Die Zähler der Navigation kommen aus einer kleinen Abfrage statt aus allen Listen bei jedem Seitenwechsel. Seitenleiste, Kachel „Abrufe heute“ und Einstellungen teilen sich eine Abfrage des Abrufstatus. Verlauf, Katalogsuche und das Zuordnen gefundener Shop-Produkte brauchen unabhängig von der Größe der Wunschliste nur noch wenige Datenbankabfragen.

### Oberfläche
- **Keine Ersparnis ohne aktuellen Preis:** Veraltete Angebote, solche mit Abruffehler und solche mit unbekannter Verfügbarkeit zeigen in den Angeboten „–“ statt einer Differenz und keinen Warenkorb-Knopf; ihr Preis steht abgeschwächt als zuletzt bekannt da. In der Wunschliste ergibt ein nur zuletzt bekannter Preis keine Ersparnis mehr und zählt nicht unter „Weltweit günstiger“.
- **Ehrliche Texte:** Fehlt ein gültiger Preis, steht der wahre Grund (veraltet, Abruffehler, Verfügbarkeit unbekannt, kein Xbox-Key, kein aktueller Preis) statt „nicht in DE gültig“. Sind alle Abrufe eines Spiels fehlgeschlagen, heißt es „Abruf fehlgeschlagen“ statt „Noch keine Angebote“; hinter dem „?“ steht, wann der nächste Versuch kommt.
- **Warenkorb kennzeichnet unsichere Regionen:** INT-Angebote, die im Zielland nicht sicher aktivierbar sind, tragen eine Warnung („Aktivierung in DE ungeklärt“, „In DE nicht aktivierbar“, „Anderer Kaufkontext“) mit Erklärung hinter dem „?“. Die Summe bleibt, darunter steht „davon nicht sicher in DE aktivierbar“ mit dem Betrag. Günstigere Regionen bleiben gleichrangig sichtbar.
- **„Score“ heißt „Prüftempo“:** Die Spalte zeigt häufig, normal oder selten (ab 70 von 100 häufig, bis 30 selten) und ist standardmäßig ausgeblendet; unter Einstellungen › Allgemein › Tabellenspalten lässt sie sich einblenden. Wer schon Angebotsspalten ausgeblendet hatte, behält seine Wahl.
- **Aktive Zustände sichtbar:** Weil die Stylesheets jetzt in fester Reihenfolge laden, greifen zwei bisher überdeckte Regeln: Das Zahnrad unter dem Abrufstatus ist auf der Einstellungsseite hervorgehoben, und das geöffnete Schloss der Bibliothek ist orange markiert.
- **Prüfdialog:** nennt, warum ein Produkt nicht eindeutig passt (Titel, Plattform, Keytyp, Erscheinungsjahr), und sperrt die Bestätigung für Angebote, die kein Xbox-Key sind.

### Behoben
- **EU-Zielländer außer DE: Trend und Verlauf waren leer.** Seit 0.9.0 zählt für Österreich, Frankreich usw. der Preis aus dem EU-Markt, Sparkline, Zielland-Verlauf, „Tiefstwert 90 Tage“ und Preis-Visier blieben aber leer, weil sie nur Beobachtungen genau im Zielland suchten. Preis, Trend und Verlauf folgen jetzt derselben Marktregel.
- **Angebotszahl in Liste und Spielseite stimmt überein:** Die Wunschliste zählte auch ungültige Preise und ausgetauschte Produkte („10 Angebote“, im Tab „Angebote 6“). Beide zählen jetzt gültige Verkäuferpreise bestätigter Produkte aktiver Shops.

### Entfernt
- Die seit 0.6.1 wirkungslose Einstellung `wishlist_price_scope` (die Spalte bleibt in der Datenbank), der Endpunkt `GET /api/v1/catalog/games/{id}/editions` ohne Aufrufer, das Feld `history` in `/wishlist/{id}/offers` (ersetzt durch `histories`) und die Rückfallpfade des Frontends für ältere Server. Die seit 0.9.2 ungenutzte Tabelle `auth_throttle` bleibt im Schema.

### Entwicklung und Dokumentation
- Die Doku stimmt wieder mit dem Code überein: Umgebungsvariablen, Grenzen und Zeiten, Frischeregel, Prüftempo, API-Fehlerform, `/counts` und `--reset-owner`. `.env.example`, `compose.yaml` und das Unraid-Template nennen Standard 500 und Bereich 1–2000 für das Tagesbudget sowie `KEYHUNTER_TRUSTED_PROXY`. Ein Test gleicht die dokumentierten Zahlen mit dem Code ab.
- `backend/migrations/SHA256SUMS` hält die Prüfsummen der ausgelieferten Migrationen fest; die Prüfung schlägt fehl, wenn eine davon geändert wird.
- Stylesheets laden zentral in fester Reihenfolge; 55 ungenutzte Tokens, doppelte Regeln, tote Klassen und ungenutzter Code sind entfernt, `knip` läuft in der Prüfung mit. Außer den zwei aktiven Zuständen oben ändert sich dadurch nichts Sichtbares.
- Der Fairness-Test des Abrufplans prüft jetzt wirklich. Er hält den bekannten Stand fest: Unter knappem Budget bleiben 121 von 200 Editionsvorschauen zehn Tage ungemessen; die gerechtere Verteilung ist für 1.1 geplant.
- Neue Regressionstests: Routenmatrix über alle API-Routen, Zuordnung nach Erscheinungsjahr (Doom, Battlefront II), Zielland AT für Preis, Trend und Verlauf, unveränderte bestätigte Zuordnungen nach dem Update, `--reset-owner`, Kennzeichnungen in Angeboten und Warenkorb.

## 0.9.2 – 2026-11-22

Die Anmeldung lässt sich nicht mehr von außen sperren, die Passphrase ist in der App änderbar, und große Wunschlisten laufen deutlich schneller und laden seltener neu. Die Datenbank bleibt unverändert, beim Update ist nichts zu tun. Hinter einem Reverse Proxy kannst du optional `KEYHUNTER_TRUSTED_PROXY` setzen.

### Sicherheit

- **Anmeldung lässt sich nicht mehr von außen sperren:** Bisher galten fünf Fehlversuche je 15 Minuten für alle zusammen; wer die App erreichte, konnte so mit fünf Anfragen den Eigentümer aussperren. Jetzt zählt jede Adresse für sich: Nach fünf falschen Versuchen wartet nur diese Adresse, andere Geräte melden sich weiter mit der richtigen Passphrase an. Gegen verteiltes Raten gilt zusätzlich eine Obergrenze von 100 Fehlversuchen je 15 Minuten über alle Adressen. Eine richtige Anmeldung nimmt ihren Versuch zurück. Das Log meldet gesperrte Versuche wie bisher höchstens einmal je Viertelstunde.
- **Hinter einem Reverse Proxy:** Ohne weitere Angabe kommen dort alle Anfragen vom Proxy und zählen als eine Adresse (Verhalten wie bisher). Mit der neuen Variable `KEYHUNTER_TRUSTED_PROXY` (IP oder Bereich wie `172.18.0.0/16`, mehrere durch Komma getrennt, im Unraid-Template unter „Advanced“) zählt für Anfragen von dort die Adresse aus `X-Forwarded-For`, von rechts gelesen die erste, die nicht zum Proxy gehört. Eine vom Client vorangestellte Adresse hilft also nicht. Beschrieben in docs/operations.md.
- **Hängende Anfragen blockieren nichts mehr:** 16 Verbindungen, die nur den Anfang einer Anmeldung schickten und dann schwiegen, blockierten bisher jede weitere Anmeldung beliebig lange. Der Server liest jetzt jede Anfrage vollständig (höchstens 16 KB in 15 Sekunden), bevor sie einen der begrenzten Plätze belegt, und bricht zu langsame Anfragen mit „Die Anfrage kam nicht rechtzeitig vollständig an.“ ab. Keine Anfrage läuft länger als 60 Sekunden. Höchstens vier Passphrasen werden gleichzeitig geprüft.
- **Passphrase ändern:** Einstellungen › System hat das neue Feld „Passphrase ändern“: aktuelle Passphrase und zweimal die neue, wie bei der Einrichtung 12 bis 128 Zeichen. Die Sitzung in diesem Browser bleibt, alle anderen Geräte werden abgemeldet; das Popup nennt, wie viele Sitzungen endeten. Eine falsche aktuelle Passphrase zählt wie ein Fehlversuch bei der Anmeldung.
- **Überall abmelden:** Neben „Abmelden“ beendet „Überall abmelden“ nach einer Rückfrage alle Sitzungen auf allen Geräten, auch die aktuelle, etwa nach dem Verlust eines Geräts. Beides steht im Log, ohne Passphrase oder Sitzungsdaten.
- **Abhängigkeiten aktualisiert:** `url` 2.5.9 (RUSTSEC-2026-0592) und sqlx 0.9.1 mit `libsqlite3-sys` 0.40, also SQLite 3.54.1 (RUSTSEC-2026-0459). Beide Meldungen waren in KeyHunter nicht ausnutzbar. `cargo audit` meldet nichts mehr, die CI nimmt keine Meldung mehr aus.

### Schneller und sparsamer

- **Große Wunschlisten:** Mit dem gebündelten SQLite prüfte der Abrufdienst bei jedem Job erneut, ob es überhaupt einen aktiven Wunsch gibt. Die Zeit wuchs dadurch quadratisch mit der Wunschliste. Bei 500 Wünschen und 2 000 Produktlinks dauerte die Auswahl des nächsten Jobs 251 ms statt jetzt 4 ms, der Abrufstatus (`/status/fetch`) rund 120 ms statt jetzt etwa 15 ms. Ein Test mit 500 Wünschen prüft den Abfrageplan, damit ein künftiges SQLite-Update das nicht unbemerkt zurückbringt.
- **Kein Dauer-Neuladen mehr:** Wunschliste und Spielseite luden bei einem Rückstand an fälligen Abrufen, dem Normalzustand großer Listen, alle drei Sekunden alle Preise neu. Das waren bei 500 Wünschen rund 6 MB pro Minute und Tab. Schnell (alle 3 s) laden sie jetzt nur noch, solange ein Abruf läuft, den du selbst ausgelöst hast: „Jetzt prüfen“, die erste Suche eines neuen Wunsches oder der erste Preis eines neu hinzugefügten Produkts. Sonst laden sie einmal pro Minute.
- **Komprimierte Antworten:** API-Antworten und die Dateien der Oberfläche kommen mit gzip oder Brotli (Wunschliste etwa −88 %, Skript etwa −70 %).
- **Zwischenspeicher-Regeln:** Die Startseite fragt bei jedem Laden nach einer neuen Version, so bleibt nach einem Update keine leere Seite mehr stehen. Die Skripte, Schriften und Flaggen unter `/assets` mit Prüfsumme im Namen lädt der Browser nur einmal. Die App-Symbole bleiben eine Stunde im Zwischenspeicher, API-Antworten nie.

### Behoben

- **Pausiertes Spiel ohne „Wird gesucht …“:** Ein einzeln pausiertes Spiel zeigte nach Ablauf seines Intervalls dauerhaft „Wird gesucht …“ bzw. „Suche eingeplant“, obwohl es gar nicht abgefragt wurde, und seine Seite lud alle drei Sekunden neu. Badge, Angebote, Suchstatus und Abrufstatus folgen jetzt derselben Regel wie der Abrufdienst: wartend ist nur, was er wirklich als Nächstes abfragen würde. Eine laufende Shop-Discovery gilt für ein pausiertes Spiel nicht als Suche. In den Angeboten steht für die fällige Suche eines pausierten Spiels „Abrufe pausiert“.

### Entwicklung und Qualitätssicherung

- Das Frontend wird jetzt mit Prettier formatiert und mit ESLint (typescript-eslint, Regeln für React-Hooks) geprüft: `npm run format`, `npm run format:check` und `npm run lint`. Die einmalige Umformatierung ist ein eigener Commit ohne inhaltliche Änderung.
- Die Tests unter `frontend/tests` und `frontend/e2e` werden typgeprüft (`npm run typecheck:tests`, eigene `tsconfig.test.json`). Neun veraltete Aufrufe von `rowFacts` in den Tests sind korrigiert.
- `deploy/check.sh` und damit die CI führen Lint, Formatprüfung und die Typprüfung der Tests aus.
- Die CI prüft die Rust-Abhängigkeiten mit `cargo audit` (RustSec). Sie meldet nichts.
- Die visuelle Regressionsprüfung umfasst jetzt 52 Ansichten (vorher 24): zusätzlich 768 px, eine Wunschliste mit 32 Einträgen und sehr langen Titeln, die Angebote-Tabelle mit 11 Zeilen in gemischten Zuständen, der Warenkorb, Einstellungen › Log und Einstellungen › System, jeweils bei 1440, 1024, 768 und 390 px.
- Der Prüfbericht zu 0.9.1 und der Fahrplan bis 1.0 liegen unter docs/release-1.0-audit/.

## 0.9.1 – 2026-11-22

Meldungen erscheinen als Popup unten rechts, die Wunschliste blättert seitenweise, und der Warenkorb steht wieder nebeneinander. Die Datenbank bleibt unverändert, beim Update ist nichts zu tun.

### Sicherheit
- **Telegram-Token-Meldung geprüft:** GitHubs Secret-Scanning meldete seit 0.9.0 einen „Telegram Bot Token“ im Repository. Es war kein echter Token, sondern ein ausgedachter Testwert (Bot-ID 123456789, „fixtureTokenOnlyForTests“) in den Backend-Tests, der wie ein echter aussieht. Die Testwerte für Telegram, Pushover und Discord werden jetzt aus Teilen zusammengesetzt, damit kein Scanner sie mehr für echte Zugangsdaten hält.
- **Weitere Prüfung ohne Befund:**
  - gitleaks über die gesamte Git-Historie findet nichts.
  - Die API gibt keine Tokens, Passwörter oder geheimen Adressen heraus; Log und Fehlermeldungen enthalten sie nicht.
  - Die Secret-Dateien und Sicherungen im Datenverzeichnis sind nur für den Besitzer lesbar.
  - Im Docker-Image und in den GitHub-Workflows liegen keine Zugangsdaten.

### Oberfläche
- **Meldungen als Popup:** Rückmeldungen nach einer Aktion („… pausiert“, „Gespeichert“, „liegt im Warenkorb“, Fehler) erscheinen unten rechts statt oben in der Seite, so verschiebt sich das Layout nicht mehr. Erfolge schließen sich nach einigen Sekunden, Fehler bleiben länger. Jede Meldung lässt sich mit dem X schließen und bleibt offen, solange die Maus darauf liegt. Ladefehler mit „Erneut laden“ und Meldungen in Dialogen bleiben an ihrem Platz.
- **Wunschliste seitenweise:** Wie im Log wählst du 25, 50, 100 oder 200 Spiele pro Seite und blätterst unter der Tabelle.
- **Anzeige bleibt erhalten:** Wunschliste, Log und Abrufe merken sich Filter, Suchtext und Einträge pro Seite in diesem Browser, die geöffnete Seite für die Sitzung. Nach einem Seitenwechsel sieht die Liste wieder so aus wie vorher.
- **Erste und letzte Seite:** Die Knöpfe zeigen jetzt einen Pfeil gegen einen Strich (|‹ und ›|) statt zweier verrutschter Pfeile.
- **Warenkorb wieder nebeneinander:** Links die Spiele, rechts die Summe. DE/INT steht jetzt unter dem Shop, so passt die Tabelle samt Papierkorb neben die Summe. Auf schmaleren Bildschirmen steht die Summe weiter darunter.
- **Angebote in der Wunschliste:** Hinter dem Erscheinungsjahr steht, wie viele Angebote vorliegen, zum Beispiel „2021 (38 Angebote)“.
- **Warndreieck:** Hinter dem Titel steht neben Einkaufskorb und Pause ein gelbes Warndreieck, sobald unter Infos Zuordnungen auf eine Prüfung warten (ungeprüfte oder umbenannte Produkte) oder die Katalogzuordnung nicht mehr passt.
- **Suchfenster:** Beim ersten Öffnen setzte sich der Kopf sichtbar neu zusammen. Die Systeme der Plattform-Auswahl kommen erst nach dem Öffnen, verbreiterten die Auswahl und schoben das X in eine eigene Zeile. Die Auswahl hat jetzt eine feste Breite, der Kopf bleibt einzeilig.

## 0.9.0 – 2026-11-22

Preisalarme kommen jetzt auch über Telegram, Discord, E-Mail, Gotify, Pushover oder einen Webhook. Die Wunschliste hat keine Obergrenze mehr, einzelne Spiele lassen sich pausieren, und jedes EU-Zielland zählt wie Deutschland. Beim Start ergänzt die Datenbank die Pause je Spiel und die Benachrichtigungskanäle (mit Sicherung vorher). Eine vorhandene /config/ntfy.env funktioniert weiter, sonst ist beim Update nichts zu tun.

### Neu
- **Unbegrenzte Wunschliste:** Die Grenze von 100 Spielen entfällt; der Kopf der Wunschliste zählt nur noch die Spiele.
- **Spiel pausieren:** Auf der Seite eines Spiels pausiert „Pausieren“ seine automatischen Abfragen für 1, 2, 4 oder 8 Wochen oder bis du sie fortsetzt; danach laufen sie von selbst wieder an. Die globale Pause ist davon unabhängig: Pausierst du alle Abfragen und setzt sie fort, bleiben die einzeln pausierten Spiele pausiert. „Jetzt prüfen“ läuft trotzdem. In der Wunschliste steht hinter dem Titel ein gelbes Pause-Symbol (wie der Einkaufskorb), der Filter „Pausiert“ zeigt nur diese Spiele, und auf der Seite des Spiels nennt ein gelber Hinweis das Ende. Pausierte Spiele zählen nicht zum Tagesbedarf und stehen nicht unter „Nächste Abfragen“; das Log hält Pause und Fortsetzen fest.
- **Jedes EU-Zielland wie Deutschland:** Bisher zählte nur für Deutschland ein Angebot als gültiger Bestpreis, weil die Shops aus Deutschland abgefragt werden. Jetzt gilt der Euro-Preis der Shops für jedes EU-Land, die Aktivierung prüft KeyHunter weiter für das Zielland selbst. Mit Österreich als Zielland gelten also dieselben Regeln wie mit Deutschland, und alle Beschriftungen nennen AT statt DE. Außerhalb der EU werden Angebote weiter nur angezeigt.
- **Bibliothek filtern:** Ein Suchfeld oben filtert Kacheln und Liste, während du tippst, nach Titel und System, ohne auf Akzente zu achten („pokemon“ findet „Pokémon“).

### Benachrichtigungen
- **Neue Kanäle neben ntfy:** Telegram, Discord, E-Mail (SMTP mit STARTTLS oder TLS), Gotify, Pushover und ein allgemeiner Webhook (JSON). Die Auswahl folgt den Diensten, die Radarr, Sonarr und Seerr anbieten; welche Dienste es gibt, wie die Nachricht jeweils ankommt und warum andere fehlen, steht in docs/notifications.md. Mehrere Kanäle können gleichzeitig aktiv sein; ein Preisalarm geht an jeden.
- **Einrichtung in der App:** Einstellungen › Benachrichtigungen hat einen Tab je Kanal mit Schalter, „Speichern“, „Test senden“ (sofort, mit Erfolg oder Fehlergrund wie „HTTP 401“) und „Entfernen“; die Einrichtung steht hinter dem Fragezeichen. Tokens, Passwörter und geheime Adressen liegen geschützt im Datenverzeichnis und werden nie wieder angezeigt.
- **Verständliche Nachrichten:** zum Beispiel „Forza Horizon 5“ ist bei deinem Wunschpreis angekommen: 24,90 € bei Eneba (Global, gültig in Deutschland). Ziel: 25,00 €. Der Preis steht im Titel, ein Link führt zum Angebot; „Neuer Tiefstpreis“ hat einen eigenen Text.
- **Zustellung je Kanal:** Jeder Kanal wiederholt für sich; ein gestörter Kanal hält die anderen nicht auf und verdoppelt keine Nachricht. „Letzte Zustellungen“ unter Preisalarme und das Log zeigen den Stand je Kanal.
- Preisalarme und der Alarm eines Spiels nennen die aktiven Kanäle („Kanal: Telegram, E-Mail“) statt fest „ntfy“.
- Eine vorhandene /config/ntfy.env funktioniert weiter, bis in der App eine ntfy-Adresse gespeichert wird.

### Oberfläche
- **Bibliothek:** Unter jedem Titel steht auch in der Kachelansicht das System.
- **Warenkorb:** Spiele kommen nur noch über die Wunschliste hinein; Auswahlfeld und Knopf „In den Warenkorb“ auf der Warenkorbseite entfallen. Die Summe steht immer unter der Tabelle, so ist der Papierkorb jeder Zeile auch auf großen Bildschirmen ohne Scrollen sichtbar.
- **HTTPS-Hinweis:** Der Hinweis „Verbindung ohne HTTPS“ lässt sich wegklicken und bleibt dann in diesem Browser ausgeblendet.

## 0.8.3 – 2026-11-22

Die Einstellungen sind eine Seite mit Tabs, hinter einem Symbol unter dem Abrufstatus. Neu sind ein Log der letzten 7 Tage, ein durchsuchbarer Abrufstatus mit Spiel und den nächsten Abfragen, und alle Erklärungen stehen hinter einem einheitlichen Fragezeichen. Beim Start legt die Datenbank die Tabelle für das Log an (mit Sicherung vorher), sonst ist beim Update nichts zu tun.

### Neu
- **Log:** Unter Einstellungen → Log steht, was in KeyHunter passiert ist: Anmeldungen, Änderungen an Wunschliste, Bibliothek, Warenkorb und Einstellungen, bestätigte, verworfene oder gelöschte Zuordnungen, Preisalarme und Fehler beim Abruf. Jeder Eintrag hat eine Stufe (Info, Warnung, Fehler) und einen Bereich. Du filterst nach Stufe, suchst im Volltext (wie in der Spielesuche, während du tippst) und wählst 25, 50, 100 oder 200 Einträge pro Seite; die Wahl merkt sich der Browser. Einträge bleiben höchstens 7 Tage, danach löscht KeyHunter den ältesten automatisch. Passphrase, Zugangsdaten und Tokens stehen nie im Log.
- **Abrufstatus:** Die Liste „Abrufe“ zeigt jetzt zu jedem Abruf das Spiel (mit Region), lässt sich nach Ergebnis filtern (Erfolgreich, Warnung, Fehler), durchsuchen und seitenweise durchblättern, mit derselben Wahl der Einträge pro Seite. Aufgezeichnet bleiben wie bisher 30 Tage.
- **Nächste Abfragen:** Der Abrufstatus zeigt die fünf Abfragen, die KeyHunter als Nächstes ausführt, über alle Shops: wann (geschätzt aus Fälligkeit, Tagesbudget und Pausen), Shop, Art, Spiel und Ziel; manuell angeforderte sind markiert.

### Oberfläche
- **Einstellungen als Tabs:** Allgemein, Key-Shops, Spieleindex, Benachrichtigungen, Abrufstatus, Log und System sind Tabs einer Seite „Einstellungen“. Das Hauptmenü zeigt nur noch die Seiten; unter dem Abrufstatus stehen zwei Symbol-Knöpfe für Einstellungen und Abmelden. Die Adresse merkt sich den offenen Tab wie bisher.
- **Tabellenspalten in einer Box:** Die Spalten der Wunschliste und der Angebote stellst du in einer Box „Tabellenspalten“ mit je einem Tab ein.
- **Key-Shops als Tabs:** Jeder Shop hat einen eigenen Tab; ein ausgeschalteter Shop trägt „aus“ im Tab.
- **Hilfe hinter dem Fragezeichen:** Erklärungen stehen nicht mehr als Text in der Oberfläche, sondern hinter demselben Fragezeichen-Symbol. Das Popup öffnet beim Überfahren mit der Maus, mit der Tastatur und per Tippen, und bleibt im sichtbaren Bereich. Umgestellt sind die Einstellungen (Zielland, Spalten, Export, Intervall, Abrufe pro Tag, Gebühren, IGDB, Editionsinhalte, ntfy, Sicherheit, Backup), die Wunschliste, die Bibliothek, die Preisalarme, der Warenkorb, der Verlauf, der Preisalarm eines Spiels und der Produktlink unter Infos. Der Dialog „Wie werden Gebühren behandelt?“ ist jetzt die Hilfe neben „Geschätzte Gebühren“. Fehlermeldungen, Warnungen und Ladezustände bleiben sichtbar.
- **Warenkorb:** Die Summe steht in einer eigenen Box wie die Shops darüber, alle Beträge stehen untereinander am rechten Rand. „Gesamt ohne Gebühren“ entfällt, es war derselbe Betrag wie „Reine Key-Kosten“. Die Erklärung zu den Gebühren steht in der Hilfe neben „Gebühren (geschätzt)“.

## 0.8.2 – 2026-11-21

Die Angebote eines Spiels bekommen einen farbigen Score und wählbare Spalten, Xbox-360-Spiele finden ihre abwärtskompatiblen Keys. Beim Start ergänzt die Datenbank zwei Einstellungen, sonst ist beim Update nichts zu tun.

### Neu
- **Score bei den Angeboten:** Die neue Spalte „Score“ bewertet jedes bestätigte Angebot von 0 bis 100. Sie spiegelt das Abfrageintervall: Ein Angebot, das im Vergleich zu den anderen des Spiels dauerhaft am günstigsten ist, prüft KeyHunter doppelt so oft (100, grün); ohne Trend gilt das normale Intervall (50, gelb); dauerhaft das teuerste oder ausverkauft heißt halb so oft (0, rot). Editionsvorschauen werden halb so oft geprüft und liegen entsprechend tiefer. Dazwischen hat jeder Wert seine eigene Farbe; der Hinweistext nennt Trend und Intervall.
- **Spalten der Angebote:** Unter Einstellungen → Allgemein → „Angebote · Spalten“ legst du wie bei der Wunschliste Reihenfolge und Sichtbarkeit fest (ziehen, Pfeile, Schalter). Der Preis bleibt immer sichtbar, Warenkorb und „Zum Shop“ stehen immer am Ende.
- **Xbox 360:** Die Reader erkennen Keys, die ausdrücklich für die Xbox 360 gelten. Solche gibt es kaum noch: Eneba führt etwa „Fable Anniversary“ als Xbox-Live-Key für Xbox One und Series X (live geprüft). Deshalb nimmt ein Wunsch für Xbox 360 oder die erste Xbox auch Xbox-One-Keys desselben Spiels an, aber nie automatisch: Unter Infos bestätigst du die Zuordnung einmal selbst.

### Oberfläche
- **Wunschliste ohne „Liste exportieren“:** Der Export bleibt in den Einstellungen.

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
