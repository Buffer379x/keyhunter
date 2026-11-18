# Datenquellen und Preisqualität

## IGDB

Die offizielle [IGDB-API](https://api-docs.igdb.com/) ist als Metadatenquelle integriert. Serverauthentifizierung verwendet Twitch-Client-Credentials; IDs, Titel, Editionen, Plattformen, Erstveröffentlichung, Alternativtitel und Cover, Screenshots und Artwork werden begrenzt abgefragt. Verwandte Editionen lassen sich im Spieldetail auswählen. Tatsächlich geprüft: Forza Horizon 5 (141503), Deluxe (171269), Premium (171270), Xbox-Plattformen und Editionselternbezug. Ein Katalogbezug ist kein Nachweis für ein aktivierbares Händlerprodukt.

Der Eigentümer hinterlegt Client-ID und Client Secret unter **Einstellungen → IGDB-Zugang**. Die App prüft beide Werte bei Twitch und übernimmt sie ohne Neustart. Die Einstellungs-API liefert nur den Zugangsstatus zurück. Das Datenvolume enthält die geschützte Secret-Datei und sollte wie ein Zugangsdaten-Backup behandelt werden. Ohne hinterlegten Zugang bleiben die gespeicherte Wunschliste und vorhandene Metadaten verfügbar.

API-Endpunkte sind feste HTTPS-Ziele, Suchzeichen werden als Stringliteral kodiert. Token bleibt im Serverspeicher; nach 401 wird höchstens einmal erneuert. Sequenzielle Requests mit mindestens 350 ms Startabstand, 10 Sekunden Requesttimeout, 2 MiB Antwortlimit und Retry-After-Pause. Deaktivierte Quelle, fehlender Zugang, Timeout/Limit und ungültige Antworten sind keine leeren erfolgreichen Suchen. Frische Suchdaten werden eine Stunde, Detaildaten 24 Stunden verwendet; Herkunft und Zwischenspeicherstatus bleiben erkennbar.

Forza-Deluxe/Premium sind tatsächlich IGDB-Bundleeinträge mit version_parent und eigenem Editionsnamen. Sie bleiben getrennte wählbare Editionen; ein Bundle ohne belegten Editionsbezug bleibt ungeklärt. DLC, Mods und unbekannte Produkttypen sind nicht als bestätigtes Basisspiel auswählbar. Remakes/Remaster/Nachfolger werden nicht per Namensähnlichkeit verschmolzen. Bei geänderter Katalogplattform/-art wird die betroffene gespeicherte Auswahl als „Zu prüfen“ markiert.

Cover kommen nur aus validierten Bild-Identifiern auf `images.igdb.com`, ohne Referrer, sonst neutraler Fallback. Datenquelle und Link zu IGDB sind sichtbar. Provider-/Bild-/Cachebedingungen beachten; keine freie Weiterlizenzierung behaupten. Bei Ausfall bleiben gespeicherte Metadaten/Wünsche erhalten; neue manuelle Titel sind ausdrücklich ungeprüft.

## Shops

| Quelle | Discovery | Angebotsdaten | Aktivierung und Kaufkontext |
|---|---|---|---|
| Eneba | Gezielte Suche beim Hinzufügen eines Wunsches, ergänzter lokaler Sitemap-Index | Apollo-Produkt-ID, verknüpfte Auction-IDs, EUR-Cent und Bestand. Verkäufer in den beobachteten öffentlichen Feldern unbekannt | DE, wenn die Produktseite Deutschland ausdrücklich bestätigt und Land und Produktfelder dazu passen. Sperrländer aus der Quelle |
| Driffle | Öffentliche Xbox-Kategorieseite | Produkt-SKU, verifizierte Übereinstimmung zwischen strukturiertem Einzelpreis, Verkäufer und Angebots-ID. Abo- und Listenpreise bleiben außen vor | Strukturierte Liste `worksIn.allowedCountries`; tatsächlich empfangener Kaufkontext aus `countryData` |

Der Live-Vergleich mit Forza Horizon 5 verwendet beide deutschen Produktseiten. Die Sprache allein reicht als Kaufkontext nicht aus. Der Vergleich verlangt passende, vom Shop bestätigte Aktivierung **und** den beobachteten Kaufkontext im Zielland. Außerhalb des belegten Länderumfangs zeigt die App beobachtete Preise mit Einschränkungen. Global und Europa sind Produktlabels.

Links müssen auf bekannte HTTPS-Produktrouten führen. DNS-Adressen werden geprüft und für die jeweilige Verbindung festgelegt. Weiterleitungen werden abgelehnt. robots.txt wird vor dem Abruf gelesen, Sitemap-Deklarationen werden abgewiesen und Antworten sind größenbegrenzt. 429/503 berücksichtigen Retry-After. Ein 403 pausiert den Shop. Die Erkennung umfasst nur die gelesene Stichprobe. Fehlende Treffer lassen sich mit einem Produktlink ergänzen.

Bei exakter Übereinstimmung des Katalogtitels, der Edition, des Keytyps und der gewählten Xbox-Plattform bestätigt KeyHunter die Zuordnung automatisch. Weitere Kandidaten und manuelle Einträge behalten Prüfbedarf. Bestätigen setzt die passende Xbox-Plattform, den Keytyp und den passenden Titel einschließlich Edition voraus. Die Zuordnung bindet sich an die Produktidentität. Produkte mit Konflikten bleiben außerhalb von Vergleich und Alarmen. Die App prüft die belegten Felder des konkreten Produkts; garantierte Einlösbarkeit oder vollständige Händlerabdeckung lassen sich daraus nicht ableiten.

## Gebühren und Verfügbarkeit

Die Schätzung ist je Shop standardmäßig ausgeschaltet. Der vorbereitete Wert beträgt 2,00 % und lässt sich in Schritten von 0,01 % einstellen. Die im Projekt genannten 1–3 % sind eine Orientierung. Die beobachteten Shopseiten liefern die EUR-Grundpreise. Gebühren bzw. der endgültige Kaufpreis sind unbekannt. Die Ansicht führt den niedrigsten passenden Grundpreis und den niedrigsten passenden Schätzpreis getrennt. Die zweite Reihe berücksichtigt Quellen mit aktivierter Schätzung.

2.392 Cent mit 200 Basispunkten ergeben gerundet 48 Cent Aufschlag und 2.440 Cent geschätzten Gesamtpreis. Halbe Cent werden aufgerundet. Ausverkaufte Produkte und Anfragen ohne verfügbaren EUR-Preis erzeugen keinen Nullpreis. Bei Fehlern bleibt der letzte Wert erhalten und ist vom aktuellen Vergleich ausgeschlossen. Nach 24 Stunden ohne Beobachtung gilt er als veraltet.


## Automatische Eneba-Suche

Das Speichern eines Wunsches erzeugt sofort einen persistenten Suchjob. Ab 0.3.1 liest der Worker die öffentliche Eneba-Katalogsuche für den Titel mit den Filtern Xbox und Spiel, ohne Länderfilter. Er verarbeitet alle Ergebnisseiten nacheinander. Jede Seite und jedes gefundene regionale Produkt erhalten getrennte, budgetierte Abrufe; der Seitenfortschritt bleibt bei Neustarts erhalten. Bekannte Links aus dem lokalen Index ergänzen die Suche. Die vorherigen Grenzen von zwei Produkten bzw. sechs Index-Kandidaten pro Shop entfallen. Auch bestehende Wünsche werden beim Upgrade erneut durchsucht. 404 wird als fehlender Kandidat behandelt, andere Fehler und Quellenlimits bleiben sichtbar. Die Quelle kann pausiert oder in den Einstellungen deaktiviert werden.

Der Suchlauf speichert tatsächlich empfangene Produkte und deren Preise. Alle gefundenen Länder- und Regionsvarianten bleiben standardmäßig sichtbar. Die Präferenz hebt die entsprechende Landesvariante hervor; eine unbekannte oder gesperrte Aktivierung wird dadurch nicht als gültig bestätigt. Der optionale Filter „Nur passende Angebote“ lässt sich ausdrücklich einschalten. Preise ohne Bestand bleiben in der Regionsübersicht als „Kein Preis“ sichtbar. Titel-/Editions-/Plattformkonflikte verhindern eine automatische Freigabe. Mit veränderter Produktidentität werden alte Freigaben erneut prüfpflichtig. Ein manueller Produktlink ergänzt die automatische Suche bei Abdeckungslücken. Shopseitige Suchabdeckung und Abruflimits begrenzen weiterhin die verfügbaren Daten.

Suchstatus, Angebotspreise, Aktivierungsregionen und Aktualität werden am jeweiligen Wunsch angezeigt. Neue Suche und manuelle Preisaktualisierung respektieren einen 15-Minuten-Abstand. Bekannte Links bleiben im achtstündigen Rhythmus, die Titelsuche wird täglich eingeplant.
