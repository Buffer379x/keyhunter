# Datenquellen und Preisqualität

## IGDB

Die offizielle [IGDB-API](https://api-docs.igdb.com/) ist als Metadatenquelle integriert. Serverauthentifizierung verwendet Twitch-Client-Credentials; IDs, Titel, Editionen, Plattformen, Erstveröffentlichung, Alternativtitel und Cover-Identifier werden begrenzt abgefragt. Tatsächlich geprüft: Forza Horizon 5 (141503), Deluxe (171269), Premium (171270), Xbox-Plattformen und Editionselternbezug. Ein Katalogbezug ist kein Nachweis für ein aktivierbares Händlerprodukt.

Bearbeitbare Eingabe: `work/local/igdb.env`, Schlüssel `IGDB_CLIENT_ID` und `IGDB_CLIENT_SECRET`, Rechte 0600. Compose mountet sie unter `/run/secrets/igdb_env` und setzt `KEYHUNTER_IGDB_ENV_FILE`. Unraid kann eine geschützte `/config/igdb.env` verwenden. Container-UID und Leserechte müssen passen. Datei beim Start gelesen; fehlende, leere oder zu offene Dateien deaktivieren Live-Suche, nicht App und gespeicherte Wünsche. Nach Änderung neu starten. Keine Werte in Browser, Image, Cache oder Logs.

API-Endpunkte sind feste HTTPS-Ziele, Suchzeichen werden als Stringliteral kodiert. Token bleibt im Serverspeicher; nach 401 wird höchstens einmal erneuert. Sequenzielle Requests mit mindestens 350 ms Startabstand, 10 Sekunden Requesttimeout, 2 MiB Antwortlimit und Retry-After-Pause. Deaktivierte Quelle, fehlender Zugang, Timeout/Limit und ungültige Antworten sind keine leeren erfolgreichen Suchen. Frische Suchdaten werden eine Stunde, Detaildaten 24 Stunden verwendet; Herkunft und Zwischenspeicherstatus bleiben erkennbar.

Forza-Deluxe/Premium sind tatsächlich IGDB-Bundleeinträge mit version_parent und eigenem Editionsnamen. Sie bleiben getrennte wählbare Editionen; ein Bundle ohne belegten Editionsbezug bleibt ungeklärt. DLC, Mods und unbekannte Produkttypen sind nicht als bestätigtes Basisspiel auswählbar. Remakes/Remaster/Nachfolger werden nicht per Namensähnlichkeit verschmolzen. Bei geänderter Katalogplattform/-art wird die betroffene gespeicherte Auswahl als „Zu prüfen“ markiert.

Cover kommen nur aus validierten Bild-Identifiern auf `images.igdb.com`, ohne Referrer, sonst neutraler Fallback. Datenquelle und Link zu IGDB sind sichtbar. Provider-/Bild-/Cachebedingungen beachten; keine freie Weiterlizenzierung behaupten. Bei Ausfall bleiben gespeicherte Metadaten/Wünsche erhalten; neue manuelle Titel sind ausdrücklich ungeprüft.

## Shops

| Quelle | Discovery | Angebotsdaten | Aktivierung und Kaufkontext |
|---|---|---|---|
| Eneba | Ein begrenzter Präfix eines veröffentlichten Produkt-Sitemap-Teils pro Tag, rotierend | Apollo-Produkt-ID, verknüpfte Auction-IDs, EUR-Cent und Bestand. Verkäufer in den beobachteten öffentlichen Feldern unbekannt | DE, wenn die Produktseite Deutschland ausdrücklich bestätigt und Land und Produktfelder dazu passen. Sperrländer aus der Quelle |
| Driffle | Öffentliche Xbox-Kategorieseite | Produkt-SKU, verifizierte Übereinstimmung zwischen strukturiertem Einzelpreis, Verkäufer und Angebots-ID. Abo- und Listenpreise bleiben außen vor | Strukturierte Liste `worksIn.allowedCountries`; tatsächlich empfangener Kaufkontext aus `countryData` |

Der Live-Vergleich mit Forza Horizon 5 verwendet beide deutschen Produktseiten. Die Sprache allein reicht als Kaufkontext nicht aus. Der Vergleich verlangt passende, vom Shop bestätigte Aktivierung **und** den beobachteten Kaufkontext im Zielland. Außerhalb des belegten Länderumfangs zeigt die App beobachtete Preise mit Einschränkungen. Global und Europa sind Produktlabels.

Links müssen auf bekannte HTTPS-Produktrouten führen. DNS-Adressen werden geprüft und für die jeweilige Verbindung festgelegt. Weiterleitungen werden abgelehnt. robots.txt wird vor dem Abruf gelesen, Sitemap-Deklarationen werden abgewiesen und Antworten sind größenbegrenzt. 429/503 berücksichtigen Retry-After. Ein 403 pausiert den Shop. Die Erkennung umfasst nur die gelesene Stichprobe. Fehlende Treffer lassen sich mit einem Produktlink ergänzen.

Eine neue Zuordnung startet als Vorschlag. Bestätigen setzt die passende Xbox-Plattform, den Keytyp und den passenden Titel einschließlich Edition voraus. Die Zuordnung bindet sich an die Produktidentität. Produkte mit Konflikten bleiben außerhalb von Vergleich und Alarmen. Die App prüft die belegten Felder des konkreten Produkts; garantierte Einlösbarkeit oder vollständige Händlerabdeckung lassen sich daraus nicht ableiten.

## Gebühren und Verfügbarkeit

Die Schätzung ist je Shop standardmäßig ausgeschaltet. Der vorbereitete Wert beträgt 2,00 % und lässt sich in Schritten von 0,01 % einstellen. Die im Projekt genannten 1–3 % sind eine Orientierung. Die beobachteten Shopseiten liefern die EUR-Grundpreise. Gebühren bzw. der endgültige Kaufpreis sind unbekannt. Die Ansicht führt den niedrigsten passenden Grundpreis und den niedrigsten passenden Schätzpreis getrennt. Die zweite Reihe berücksichtigt Quellen mit aktivierter Schätzung.

2.392 Cent mit 200 Basispunkten ergeben gerundet 48 Cent Aufschlag und 2.440 Cent geschätzten Gesamtpreis. Halbe Cent werden aufgerundet. Ausverkaufte Produkte und Anfragen ohne verfügbaren EUR-Preis erzeugen keinen Nullpreis. Bei Fehlern bleibt der letzte Wert erhalten und ist vom aktuellen Vergleich ausgeschlossen. Nach 24 Stunden ohne Beobachtung gilt er als veraltet.
