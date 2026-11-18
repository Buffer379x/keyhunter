# Installation und Betrieb

## Unraid und HTTPS

1. Lade `keyhunter-0.2.1-amd64.tar.gz`, die Prüfsumme und `keyhunter-unraid.xml` aus dem [Release](https://github.com/Buffer379x/keyhunter/releases/tag/v0.2.1).
2. Lade das Archiv auf dem Zielhost mit `docker load -i keyhunter-0.2.1-amd64.tar.gz`. Das Image heißt im Template `keyhunter:0.2.1`.
3. Lege die XML-Datei im Ordner `/boot/config/plugins/dockerMan/templates-user` ab. Wähle in der Docker-Ansicht **Add Container** und das KEYHUNTER-Template.
4. Wähle ein lokales Appdata-Verzeichnis für `/data` mit Schreibzugriff für UID/GID `10001:10001`. Nutze für SQLite ein lokales Dateisystem. Optional bindest du ein Verzeichnis für Secret-Dateien als `/config` schreibgeschützt ein.
5. Richte einen HTTPS-Reverse-Proxy (etwa Nginx Proxy Manager) für den internen App-Port 3000 ein. Setze `KEYHUNTER_ORIGIN` exakt auf die HTTPS-Adresse ohne Pfad oder abschließenden Schrägstrich und verwende dieselbe Adresse für die WebUI. Beschränke den Zugriff auf LAN oder VPN.
6. Starte den Container. Verwende den Code aus dem gemounteten Datenverzeichnis `bootstrap-token`, um deinen Eigentümerzugang einzurichten. In der App lässt sich anschließend ein Zielland für Angebote wählen.

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
