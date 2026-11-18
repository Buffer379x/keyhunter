# Architektur

Ein Rust/Axum-Prozess liefert REST und gebaute React-/TypeScript-Dateien unter derselben Origin. SQLite liegt auf einem lokalen Datenvolume; SQLx führt eingebettete nummerierte Migrationen vor dem Listenerstart aus. WAL, Fremdschlüssel, fünf Sekunden Busy-Timeout, vier Verbindungen und kurze Schreibtransaktionen sind aktiviert. `/health/live` und `/health/ready` liefern keine Secrets.

Die App speichert einen Eigentümer, widerrufbare Sitzungen, globale Anmeldeversuchszähler, allgemeine Einstellungen und Dienstkonfiguration. Passphrasen werden mit Argon2id und zufälligem Salt gehasht. Sitzungscookies enthalten zufällige Tokens; in SQLite liegen ausschließlich deren SHA-256-Hashes. CSRF-Token werden nach erfolgreicher Anmeldung ausgegeben und bei Änderungen gemeinsam mit der Browser-Origin geprüft. Eine explizite Origin hat Vorrang. Im automatischen Modus muss die Origin zum empfangenen Host einschließlich Port passen. Vorhandene Fetch-Metadata muss Same-Origin melden. Cookies sind HttpOnly/SameSite=Strict. Aus einer geprüften HTTPS-Origin ausgegebene Cookies sind zusätzlich Secure. Forwarded-Header werden für diese Prüfung nicht ausgewertet.

Ein zufälliger Einrichtungscode wird lokal in einer geschützten Datei erzeugt. Eigentümereinrichtung ist durch den Singleton-Datensatz atomar auf eine Person begrenzt. Je fünf Versuche innerhalb von 15 Minuten werden Setup/Login begrenzt; erfolgreiche Anmeldung setzt den Zähler zurück. Höchstens vier Passwortberechnungen laufen gleichzeitig. Sitzungen laufen nach zwölf Stunden ab und bleiben bis dahin über Neustarts erhalten; Logout löscht die konkrete Sitzung serverseitig.

Geldwerte künftiger Angebote werden als ganzzahlige Minor Units mit ISO-Währung gespeichert. Prozentaufschläge liegen in Basispunkten, nicht in binären Floats. Die App speichert diese Einstellung; die Berechnung und Anwendung auf echte Preise gehört P4. Ein ausgeschalteter Aufschlag bedeutet bei unbekannten tatsächlichen Gebühren nicht 0 Euro Gebühren.

Der Katalog verwendet den offiziellen IGDB-Adapter mit optionaler Secretdatei, festen HTTPS-Endpunkten, Tokenablauf/-Erneuerung, Größen-/Timeoutlimits, sequenzieller Rate und Retry-After-Pause. Die austauschbare Providergrenze ermöglicht kontrollierte HTTP-/DB-Tests ohne Händlerlast. Tokens liegen nur im Serverspeicher.

SQLite speichert normalisierte Katalogdaten, bis 400 Suchcaches (eine Stunde Frische) und interne Spiel-/Wunschlisten-IDs unabhängig von IGDB-IDs. Detailfrische 24 Stunden; unreferenzierte Metadaten älter als sieben Tage werden bei Suchaktivität bereinigt. Wishlist UNIQUE(game,platform) und transaktionales 100er-Limit verhindern Duplikate/Überlauf. Manuelle Titel bleiben ohne erfundene Quell-ID ungeprüft. Geänderte Quellplattform/Produkttyp setzen gespeicherte Auswahlen auf „Zu prüfen“.

Abbrechbare debouncte Katalogsuche und eigener Listenfilter sind getrennt. Auswahl/Filter sind interne Queryparameter; mobil wechseln Liste/Detail. Ein Bild wird nur aus validiertem IGDB-Identifier auf dem festen CDN geladen; Ausfälle haben einen Fallback. Gespeicherte Wünsche bleiben bei Providerstörung verfügbar. Quellenfehler werden nicht als leere erfolgreiche Suche gecacht.

Die IGDB-Edition und -Plattform dienen dem Katalogbezug. Shopadapter belegen die konkrete Produktidentität, Aktivierbarkeit und den beobachteten Preis separat.

Die rootlose amd64-Runtime enthält Binary, Webassets, CA-Zertifikate und Healthcheck-Curl. Node/Rust-Compiler, `work/`, Importgespräche und Secrets gelangen nicht ins Runtime-Image. Docker-Buildkontext ist auf benötigte Quellen beschränkt. Es gibt keinen Queue-Dienst, externen Datenbankserver oder dauerhaften Browser-Worker.


## Shops, Jobs und Alarme

Die beiden Shopadapter normalisieren je Produkt die stabile Identität, Plattform, Titel, Region und die belegten verfügbaren EUR-Angebote. Ein neu gespeicherter Wunsch erhält einen gezielten Eneba-Suchjob. Der lokale Index aus öffentlichen Kategorien und Sitemap-Stichproben ergänzt die Suche. Eindeutige Titel-, Editions- und Plattformübereinstimmungen werden automatisch bestätigt. Manuelle Links kommen über dieselbe Abrufwarteschlange. Bestätigung speichert einen versionierten Fingerabdruck aus Produktidentität und Matchingfeldern.

Jeder Shop hat einen Worker. SQLite hält Fälligkeit, Lease, Budget, Quellpause und den letzten Fehler. Der Worker arbeitet mit einer kurzen Schreibtransaktion vor und nach dem Netzwerkabruf. Ein beendeter Job speichert aktuelle Daten und eine unveränderliche Beobachtung. Dieselbe Transaktion schreibt gegebenenfalls Regelzustand und Alarmereignis. Fehler behalten die bisherige Beobachtung und ändern den Status des Abrufs. Preisbeobachtungen eines Links werden beim erfolgreichen Abruf auf ein Jahr begrenzt. Die Oberfläche zeigt je Link die letzten 60 passenden Beobachtungen.

Preisregeln verwenden die Eignungsprüfung der Angebotsseite. Ein Zielpreis löst beim ersten erreichenden Messwert oder beim erneuten Unterschreiten aus. Ein Tiefstpreis benötigt eine frühere Beobachtung im gleichen Vergleichsumfang. Die Outbox prüft den Umfang und Preis erneut vor dem Versand. ntfy ist optional. Eine offene Zustellung wird erneut versucht, bis zu drei Versuche. Ein Timeout nach Annahme durch ntfy kann bei einem Retry zu einer doppelten externen Zustellung führen.


## Dashboard

Die Oberfläche besteht auf dem Desktop aus Navigation, einer festen Wunschlistenspalte und dem Spieldetail. Das Detail verbindet IGDB-Cover und Hero-Bild mit Tabs für Angebote, Editionen, Verlauf und Informationen. Das Angebotsraster zeigt Editionen, beobachtete Regionen, Händlerangebote und die tatsächlichen Messungen. Mobil öffnen Liste und Detail getrennte Ansichten. Die globale Katalogsuche ist über die Kopfzeile und Ctrl/Cmd-K erreichbar. Der Listenfilter arbeitet nur auf den gespeicherten Spielen.
