# Installation und Betrieb

## Unraid im LAN

1. Lade das [Unraid-Template](https://raw.githubusercontent.com/Buffer379x/keyhunter/main/deploy/unraid/keyhunter.xml) und lege es im Ordner `/boot/config/plugins/dockerMan/templates-user` ab. Wähle in der Docker-Ansicht **Add Container** und das KEYHUNTER-Template.
2. Das Feld **Repository** enthält `ghcr.io/buffer379x/keyhunter:latest`. Unraid lädt das Image beim Anwenden aus dem [GitHub-Package](https://github.com/users/Buffer379x/packages/container/package/keyhunter).
3. Wähle ein lokales Appdata-Verzeichnis für `/data` mit Schreibzugriff für UID/GID `10001:10001`. Nutze für SQLite ein lokales Dateisystem. Optional bindest du ein Verzeichnis für die ntfy-Datei als `/config` schreibgeschützt ein.
4. Öffne die WebUI in Unraid. Bei eigener LAN-IP erreichst du sie direkt unter `http://<Container-IP>:3000`. Im Bridge-Modus verwendest du die IP des Unraid-Hosts und den veröffentlichten Port.
5. Verwende den Code aus der Datei `bootstrap-token` im gemounteten Datenverzeichnis, um deinen Eigentümerzugang einzurichten.

### Webadresse und HTTPS

`KEYHUNTER_ORIGIN` ist optional. Leer oder weggelassen funktioniert HTTP auf privaten IPv4- und IPv6-Adressen sowie auf Loopback. Verwende HTTP nur in einem vertrauenswürdigen LAN oder VPN. Passphrase, Sitzung und Zugangsdaten werden dabei ohne TLS übertragen.

Für HTTPS leite mit einem Reverse Proxy an Port 3000 weiter. Der Proxy muss den ursprünglichen Host einschließlich eines nicht standardmäßigen Ports weiterreichen. Falls der Proxy den Host umschreibt oder du genau eine Adresse erlauben möchtest, setze `KEYHUNTER_ORIGIN` auf die vollständige Browser-URL ohne Pfad. Wenn HTTP-Anmeldung und Änderungen gesperrt bleiben sollen, setze `KEYHUNTER_ALLOW_INSECURE_HTTP=false`.

Bei einem Upgrade auf 0.2.2 kannst du für den direkten Zugriff per LAN-IP eine alte `KEYHUNTER_ORIGIN` entfernen oder leeren. Falls `KEYHUNTER_ALLOW_INSECURE_HTTP` auf `false` steht, setze es auf `true` oder entferne es. Das Datenvolume bleibt erhalten.

Bei einem bereits eingerichteten Container kannst du das Feld **Repository** direkt auf `ghcr.io/buffer379x/keyhunter:latest` ändern. Behalte das Datenvolume und die lokale Konfiguration. Unraids Funktion **Check for Updates** erkennt neue Images unter diesem Tag. Für eine feste Version lässt sich `latest` durch eine Versionsnummer ersetzen.

Die Veröffentlichung wurde unter Linux/amd64 mit Docker geprüft. Das XML ist für die manuelle Installation vorbereitet. Der Test auf einer Unraid-Installation steht aus.

## Zugangsdaten

Melde dich als Eigentümer an und öffne **Einstellungen → IGDB-Zugang**. Gib Client-ID und Client Secret deiner Twitch-Anwendung ein. KEYHUNTER prüft das Paar bei Twitch und übernimmt es direkt. Um den Zugang zu ersetzen, gib beide Werte erneut ein.

Beim Upgrade von 0.2.0 verwende das bestehende Datenvolume und hinterlege den IGDB-Zugang einmal in der App. Die alte Variable `KEYHUNTER_IGDB_ENV_FILE` und deren separater IGDB-Dateimount können aus der Containerkonfiguration entfernt werden. Gespeicherte Wünsche, Zuordnungen und Preisalarme bleiben im Datenvolume erhalten.

Der Server speichert die IGDB-Werte in `igdb-credentials.json` mit Rechten 0600 im Datenvolume. Die Einstellungen zeigen den Konfigurationsstatus. Die gespeicherten Werte sind für den Besitzer der Datei lesbar. Schütze das Datenvolume und alle Sicherungen entsprechend.

Für ntfy verwende optional die [ntfy.env.example](../deploy/ntfy.env.example) als Vorlage. Bei Unraid liegt die Datei im Konfigurationsmount unter `/config/ntfy.env`, bei Compose auf dem Host unter `work/local/runtime/config/ntfy.env`. Verwende Rechte 0600 und den passenden Eigentümer. `NTFY_URL` ist die vollständige Topic-URL. Ein separater Bearer-Token erfordert HTTPS. Starte nach Änderung der ntfy-Datei neu.

## Jobs und Speicher

Bekannte Produkte werden ungefähr alle acht Stunden eingeplant. Die Discovery läuft täglich mit begrenzter Abdeckung. Der Standard deckelt jeden Shop auf 120 Jobs pro UTC-Tag. Der Betreiber kann `KEYHUNTER_SHOP_DAILY_JOBS` anpassen. Manuelle Prüfungen halten 15 Minuten Abstand zum letzten Abruf. Compose und Unraid begrenzen den App-Speicher auf 512 MiB.

## Backup und Update

Stoppe den Container vor dem Kopieren des vollständigen Datenverzeichnisses, einschließlich vorhandener SQLite-WAL- und SHM-Dateien. Bewahre Backups auf einem getrennten Datenträger auf. Das Datenbackup enthält den IGDB-Zugang. Sichere die getrennte ntfy-Datei ebenfalls geschützt. Starte nach einem Update mit einer konsistenten Kopie der Daten. Für einen Rollback verwende das vorherige Image zusammen mit dem Stand vor der Migration. Wiederherstellung auf eine frische Instanz lässt sich über `/health/ready`, die Anmeldung und die vorhandenen Wunschlisten, Zuordnungen und Regeln prüfen.


## Offline-Installation

Die GitHub-Releases enthalten zugehörige Image-Archive mit Prüfsumme. Importiere das gewünschte Archiv mit `docker load -i DATEI.tar.gz` und verwende die darin enthaltene lokale Image-Referenz, zum Beispiel `keyhunter:0.2.2`. Für reguläre Updates über GitHub verwende die GHCR-Referenz im Template.


## GitHub-Veröffentlichung

Verwende als GitHub-Release-Titel die Versionsnummer, zum Beispiel `0.2.2`. Die Veröffentlichungs-Action erstellt den numerischen OCI-Tag und aktualisiert `latest` für den aktuellen stabilen Release. Das Package benötigt die Sichtbarkeit **Public** für Abrufe ohne Anmeldung und unter **Manage Actions access** Schreibzugriff für das zugehörige Repository.
