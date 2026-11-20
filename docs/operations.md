# Installation und Betrieb

## Unraid im LAN

1. Lade das [Unraid-Template](https://raw.githubusercontent.com/Buffer379x/keyhunter/main/deploy/unraid/keyhunter.xml) und lege es im Ordner `/boot/config/plugins/dockerMan/templates-user` ab. Wähle in der Docker-Ansicht **Add Container** und das KeyHunter-Template.
2. Das Feld **Repository** enthält `ghcr.io/buffer379x/keyhunter:latest`. Unraid lädt das Image beim Anwenden aus dem [GitHub-Package](https://github.com/users/Buffer379x/packages/container/package/keyhunter).
3. Wähle ein eigenes lokales Appdata-Verzeichnis für `/data`. Das aktuelle Unraid-Template bereitet diesen Ordner beim Start vor. Nutze für SQLite ein lokales Dateisystem. Optional bindest du ein Verzeichnis für die ntfy-Datei als `/config` schreibgeschützt ein.
4. Öffne die WebUI in Unraid. Bei eigener LAN-IP erreichst du sie direkt unter `http://<Container-IP>:3000`. Im Bridge-Modus verwendest du die IP des Unraid-Hosts und den veröffentlichten Port.
5. Verwende den Code aus der Datei `bootstrap-token` im gemounteten Datenverzeichnis, um deinen Eigentümerzugang einzurichten.

### Rechte am Datenordner

Das Unraid-Template ab 0.2.3 richtet nach dem Start die Rechte am eingebundenen `/data` und den bekannten Datenbank- und Zugangsdateien ein. Danach läuft der Webdienst als UID/GID `10001:10001` ohne Linux-Capabilities. Andere Dateien und der optionale `/config`-Mount behalten ihre Rechte. Für einen vorhandenen Unraid-Container muss das aktualisierte Template einmal angewendet werden. Ein reines Image-Update behält die bisherigen Startparameter. Verwende dabei dasselbe Datenvolume.

Bei Compose oder einem eigenen `docker run` läuft das Image standardmäßig direkt als Nicht-Root-Benutzer. Stelle für manuelle Bind-Mounts sicher, dass der konfigurierte Benutzer schreiben kann. Alternativ initialisiert Docker ein benanntes Volume mit dem passenden Eigentümer.

### Webadresse und HTTPS

`KEYHUNTER_ORIGIN` ist optional. Leer oder weggelassen funktioniert HTTP auf privaten IPv4- und IPv6-Adressen, auf Loopback und auf lokalen Hostnamen (ohne Punkt wie `tower` oder mit `.local`, `.lan`, `.home.arpa`, `.internal`). Verwende HTTP nur in einem vertrauenswürdigen LAN oder VPN. Passphrase, Sitzung und Zugangsdaten werden dabei ohne TLS übertragen.

Für HTTPS leite mit einem Reverse Proxy an Port 3000 weiter. Der Proxy muss den ursprünglichen Host einschließlich eines nicht standardmäßigen Ports weiterreichen. Falls der Proxy den Host umschreibt oder du genau eine Adresse erlauben möchtest, setze `KEYHUNTER_ORIGIN` auf die vollständige Browser-URL ohne Pfad. Wenn HTTP-Anmeldung und Änderungen gesperrt bleiben sollen, setze `KEYHUNTER_ALLOW_INSECURE_HTTP=false`.

Bei einem Upgrade auf 0.2.2 kannst du für den direkten Zugriff per LAN-IP eine alte `KEYHUNTER_ORIGIN` entfernen oder leeren. Falls `KEYHUNTER_ALLOW_INSECURE_HTTP` auf `false` steht, setze es auf `true` oder entferne es. Das Datenvolume bleibt erhalten.

Bei einem bereits eingerichteten Container kannst du das Feld **Repository** direkt auf `ghcr.io/buffer379x/keyhunter:latest` ändern. Behalte das Datenvolume und die lokale Konfiguration. Unraids Funktion **Check for Updates** erkennt neue Images unter diesem Tag. Für eine feste Version lässt sich `latest` durch eine Versionsnummer ersetzen.

Wenn der Status **not available** ist, prüfe zuerst das Feld **Repository**. Eine lokal importierte Referenz wie `keyhunter:0.2.2` hat keine GHCR-Herkunft für die Updateprüfung. Mit der GHCR-Referenz kannst du **Check for Updates** erneut ausführen. Falls die Anzeige ausbleibt, teste im Unraid-Terminal `docker pull ghcr.io/buffer379x/keyhunter:latest`. Nach erfolgreichem Pull kannst du im Docker-Tab unter **Advanced View → Force Update** den Container aus seinem bestehenden Template neu erstellen. Bei diesem Schritt bleiben die eingebundenen Daten erhalten.

Die Veröffentlichung wurde unter Linux/amd64 mit Docker geprüft. Das XML ist für die manuelle Installation vorbereitet. Der Test auf einer Unraid-Installation steht aus.

## Zugangsdaten

Melde dich als Eigentümer an und öffne **Einstellungen → Spieleindex → IGDB-Zugang**. Gib Client-ID und Client Secret deiner Twitch-Anwendung ein. KeyHunter prüft das Paar bei Twitch und übernimmt es direkt. Um den Zugang zu ersetzen, gib beide Werte erneut ein.

Beim Upgrade von 0.2.0 verwende das bestehende Datenvolume und hinterlege den IGDB-Zugang einmal in der App. Die alte Variable `KEYHUNTER_IGDB_ENV_FILE` und deren separater IGDB-Dateimount können aus der Containerkonfiguration entfernt werden. Gespeicherte Wünsche, Zuordnungen und Preisalarme bleiben im Datenvolume erhalten.

Der Server speichert die IGDB-Werte in `igdb-credentials.json` mit Rechten 0600 im Datenvolume. Die Einstellungen zeigen den Konfigurationsstatus. Die gespeicherten Werte sind für den Besitzer der Datei lesbar. Schütze das Datenvolume und alle Sicherungen entsprechend.

Für ntfy verwende optional die [ntfy.env.example](../deploy/ntfy.env.example) als Vorlage. Bei Unraid liegt die Datei im Konfigurationsmount unter `/config/ntfy.env`, bei Compose auf dem Host unter `work/local/runtime/config/ntfy.env`. Verwende Rechte 0600 und den passenden Eigentümer. `NTFY_URL` ist die vollständige Topic-URL. Ein separater Bearer-Token erfordert HTTPS. Starte nach Änderung der ntfy-Datei neu.

## Jobs und Speicher

Bekannte Produktseiten werden standardmäßig alle acht Stunden eingeplant; pro Shop ist das Intervall einstellbar. Die Discovery läuft frühestens täglich (bei längeren Produktintervallen entsprechend später) mit begrenzter Abdeckung. Der Standard deckelt jeden Shop auf 120 Jobs pro UTC-Tag. Der Betreiber kann `KEYHUNTER_SHOP_DAILY_JOBS` anpassen. Das Budget geht zuerst an angeforderte Aktualisierungen und erste Suchen, dann an Preise aktiver Wünsche, die im Zielland gelten können; jeder vierte Abruf eines Tages geht an den am längsten wartenden übrigen Job (Wiederholungssuchen, andere Regionen, Editionsvorschauen, Discovery). Vorübergehende Fehler werden nach 2, 10 und 60 Minuten wiederholt, danach im normalen Intervall. Manuelle Prüfungen halten 15 Minuten Abstand zum letzten Abruf und schließen zuvor fehlgeschlagene Links ein.

`GET /api/v1/status/fetch` (angemeldet) zeigt je Shop Budget, fällige Jobs, Pausen und die letzten 25 Abrufe; die Historie wird 30 Tage aufbewahrt. `/health/ready` meldet 503, wenn ein Abrufdienst länger als fünf Minuten nicht reagiert. Compose und Unraid begrenzen den App-Speicher auf 512 MiB.

## Backup und Update

Stoppe den Container vor dem Kopieren des vollständigen Datenverzeichnisses, einschließlich vorhandener SQLite-WAL- und SHM-Dateien. Bewahre Backups auf einem getrennten Datenträger auf. Das Datenbackup enthält den IGDB-Zugang. Sichere die getrennte ntfy-Datei ebenfalls geschützt. Starte nach einem Update mit einer konsistenten Kopie der Daten. Für einen Rollback verwende das vorherige Image zusammen mit dem Stand vor der Migration. Wiederherstellung auf eine frische Instanz lässt sich über `/health/ready`, die Anmeldung und die vorhandenen Wunschlisten, Zuordnungen und Regeln prüfen.


## Offline-Installation

Die GitHub-Releases enthalten zugehörige Image-Archive mit Prüfsumme. Importiere das gewünschte Archiv mit `docker load -i DATEI.tar.gz` und verwende die darin enthaltene lokale Image-Referenz, zum Beispiel `keyhunter:0.2.3`. Für reguläre Updates über GitHub verwende die GHCR-Referenz im Template.


## GitHub-Veröffentlichung

Verwende als GitHub-Release-Titel die Versionsnummer, zum Beispiel `0.2.2`. Die Veröffentlichungs-Action veröffentlicht den numerischen Tag und `latest` als Image-Index für `linux/amd64`. So kann auch Unraids Updateprüfung vor 7.4.0 den Image-Digest abrufen. Das Package benötigt die Sichtbarkeit **Public** für Abrufe ohne Anmeldung und unter **Manage Actions access** Schreibzugriff für das zugehörige Repository.


## Upgrade auf 0.3.0

Behalte das bestehende Datenvolume. Nach dem Update werden für gespeicherte Wünsche automatisch Suchjobs angelegt. Neue Produkte werden mit Titel, Edition und Plattform abgeglichen und eindeutige Katalogzuordnungen automatisch freigegeben. Die Wunschliste enthält weiterhin die bisherigen Spiele und Einstellungen. Falls ein gespeichertes Cover noch kein Hero-Bild hat, lädt eine erneute Katalogsuche die aktuellen IGDB-Metadaten.

## Upgrade auf 0.3.1

Behalte das Datenvolume und aktualisiere `ghcr.io/buffer379x/keyhunter:latest`. Die Migration stößt für bestehende Wünsche die Suche nach weiteren regionalen Varianten an. Die Abrufe erfolgen schrittweise innerhalb des eingestellten Tagesbudgets. Deine Länderpräferenz hebt passende Landesvarianten hervor; alle gefundenen Regionen bleiben sichtbar. Suche direkt im Eingabefeld der Kopfzeile, auch von Einstellungen und Preisalarmen aus. `Ctrl K` bzw. `Cmd K` fokussiert dieses Feld. Das Plus in der Wunschliste öffnet weiterhin den separaten Hinzufügen-Dialog.

## Upgrade auf 0.4.0

Datenvolume beibehalten und `ghcr.io/buffer379x/keyhunter:latest` aktualisieren. Die Migration ergänzt Dienstintervalle, die Quellenregistrierung, einen Cache für offizielle Editionsinhalte und getrennte Vorschau-Markierungen. Vorhandene Wünsche, Preise, Regeln und Zugangsdaten bleiben erhalten. Produktintervalle starten mit dem bisherigen Wert von 8 Stunden; sie lassen sich unter **Einstellungen → Key-Shops** ändern. IGDB befindet sich unter **Einstellungen → Spieleindex**.

Die Wunschliste lässt sich nach Hinzufügedatum, passendem Grundpreis und Alphabet sortieren; die Auswahl wird im Browser gespeichert. Unbekannte Preise stehen am Ende. Ein Klick auf eine andere Edition verändert keinen Wunschlisteneintrag. Die gespeicherte Edition bleibt gekennzeichnet und über „Zur gemerkten Edition“ erreichbar. Preisangebote werden über die Länderzeilen geöffnet; der Verlauf hat einen eigenen Schalter für Zielland bzw. alle Länder.

## Upgrade auf 0.4.1

Datenvolume beibehalten und `latest` aktualisieren. Die Migration ergänzt die Bibliothekszugehörigkeit und die Preisbasis für Wunschlisten-Badges. Bereits konfigurierte Intervalle werden erhalten, nicht auf acht Stunden zurückgesetzt. Unverändertes Speichern der Einstellungen ändert keine geplanten Abrufzeiten. Nach Shopfehlern wartet ein automatischer Wiederholungsversuch mindestens das konfigurierte Intervall und gegebenenfalls eine längere Shop-Pause.

Das Intervall gilt pro Produktseite, nicht als gleichzeitiger Komplett-Sync: erste Messungen, neu entdeckte Ländervarianten und Suchseiten können nacheinander erscheinen. Manuelles Aktualisieren bleibt mit 15 Minuten Abstand möglich. Die häufigeren Aktualisierungen der Oberfläche lesen ausschließlich lokale Daten. Bibliothekseinträge werden nicht weiter abgefragt; laufende Produktaufträge werden beim Kauf verworfen und offene Preisalarme abgebrochen. Beim Zurückverschieben bleiben Alarme deaktiviert, bis du sie bewusst wieder aktivierst. Bei mehr als 100 aktiven Wünschen ist zunächst Platz zu schaffen.

Erneutes bestätigtes Vormerken genau derselben vorhandenen Edition verschiebt sie zurück in die Wunschliste. Bei einer anderen Edition bleibt das ursprüngliche Spiel in der Bibliothek. Die Zuordnung verwendet die bei IGDB belegte Editionsfamilie; Fortsetzungen und Remaster werden nicht allein anhand ähnlicher Namen zusammengefasst.

## Upgrade auf 0.4.2

Datenvolume beibehalten und `latest` aktualisieren. Die additive Migration ergänzt Zuordnungen zwischen gemerkten Spielen und vorbereiteten Editionen sowie den Planungsstand der Editionssuche. Wünsche, Bibliothek, Preisbeobachtungen und Einstellungen bleiben bestehen. API-Zugangsdaten werden weiterhin ausschließlich im Datenvolume gespeichert.

Die Bibliothek zeigt das System unter dem Titel. Der Systemfilter enthält nur vorhandene Systeme; Filter und Sortierung bleiben im Browser erhalten. „Hinzugefügt am“ bezieht sich auf den gespeicherten Zeitpunkt der Übernahme in die Bibliothek, unabhängig vom früheren Wunschlistendatum.

## Sicherung vor Migrationen

Bevor ein Update das Datenbankschema ändert, legt KeyHunter automatisch eine Kopie unter `<Datenverzeichnis>/backups/keyhunter-schema-<alte Version>-<Zeit>.db` an; die drei neuesten bleiben erhalten. Rückweg: Container stoppen, die Kopie als `keyhunter.db` zurückkopieren (vorhandene `keyhunter.db-wal` und `-shm` vorher entfernen) und das vorherige Image starten.

## Upgrade auf 0.6.0

Datenvolume beibehalten. Migration 0011 ergänzt Abrufpriorität, Relevanz und eine Abrufhistorie. Beim Start werden Produktbestätigungen und Preisverlauf auf einen titelunabhängigen Fingerabdruck übertragen; umbenannte Shopprodukte bleiben dadurch bestätigt. Preisalarme beginnen ihre Auswertung einmalig neu, weil der Bereich eines Alarms nicht mehr von einzelnen Link-IDs abhängt: Liegt der Preis bereits unter einem Zielpreis, kann eine Benachrichtigung einmal erneut kommen (mit der üblichen Sperrzeit). Eneba-Aktivierungen stammen aus der strukturierten Länderliste; Angebote anderer Länder als Deutschland bleiben sichtbar, zählen aber weiterhin nicht als gültiger Bestpreis. Neue Installationen fragen das Zielland bei der Einrichtung ab. Migration 0012 überführt Wunschliste, Editionsvorschauen und Bibliothek in eine Zustandsspalte, 0013 merkt sich den Shop-Titel bestätigter Produkte. Editionsvorschauen, die 14 Tage nicht angesehen wurden, ruhen bis zum nächsten Öffnen.
