# Installation und Betrieb

## Unraid und HTTPS

1. Lade `keyhunter-0.2.0-amd64.tar.gz`, die Prüfsumme und `keyhunter-unraid.xml` aus dem [Release](https://github.com/Buffer379x/keyhunter/releases/tag/v0.2.0).
2. Lade das Archiv auf dem Zielhost mit `docker load -i keyhunter-0.2.0-amd64.tar.gz`. Das Image heißt im Template `keyhunter:0.2.0`.
3. Lege die XML-Datei im Ordner `/boot/config/plugins/dockerMan/templates-user` ab. Wähle in der Docker-Ansicht **Add Container** und das KEYHUNTER-Template.
4. Wähle ein lokales Appdata-Verzeichnis für `/data` mit Schreibzugriff für UID/GID `10001:10001`. Nutze für SQLite ein lokales Dateisystem. Optional bindest du ein Verzeichnis für Secret-Dateien als `/config` schreibgeschützt ein.
5. Richte einen HTTPS-Reverse-Proxy (etwa Nginx Proxy Manager) für den internen App-Port 3000 ein. Setze `KEYHUNTER_ORIGIN` exakt auf die HTTPS-Adresse ohne Pfad oder abschließenden Schrägstrich und verwende dieselbe Adresse für die WebUI. Beschränke den Zugriff auf LAN oder VPN.
6. Starte den Container. Verwende den Code aus dem gemounteten Datenverzeichnis `bootstrap-token`, um deinen Eigentümerzugang einzurichten. In der App lässt sich anschließend ein Zielland für Angebote wählen.

Die Veröffentlichung wurde unter Linux/amd64 mit Docker geprüft. Das XML ist für die manuelle Installation vorbereitet. Der Test auf einer Unraid-Installation steht aus.

## Zugangsdaten

Die App liest optionale Dateien beim Start. Verwende Rechte 0600 und den passenden Eigentümer. Starte nach einer Änderung neu.

| Funktion | Datei im Unraid-Konfigurationsmount | Vorlage |
|---|---|---|
| IGDB-Suche | `/config/igdb.env` | [igdb.env.example](../deploy/igdb.env.example) |
| Preisalarme | `/config/ntfy.env` | [ntfy.env.example](../deploy/ntfy.env.example) |

Bei Compose lautet der IGDB-Pfad auf dem Host `work/local/igdb.env`, der ntfy-Pfad `work/local/runtime/config/ntfy.env`. `NTFY_URL` ist die vollständige Topic-URL. Ein optionaler Bearer-Token erfordert HTTPS. Abonniere das Topic und verwende in **Preisalarme** die Testnachricht, um den Kanal zu prüfen.

## Jobs und Speicher

Bekannte Produkte werden ungefähr alle acht Stunden eingeplant. Die Discovery läuft täglich mit begrenzter Abdeckung. Der Standard deckelt jeden Shop auf 120 Jobs pro UTC-Tag. Der Betreiber kann `KEYHUNTER_SHOP_DAILY_JOBS` anpassen. Manuelle Prüfungen halten 15 Minuten Abstand zum letzten Abruf. Compose und Unraid begrenzen den App-Speicher auf 512 MiB.

## Backup und Update

Stoppe den Container vor dem Kopieren des vollständigen Datenverzeichnisses, einschließlich vorhandener SQLite-WAL- und SHM-Dateien. Bewahre Backups auf einem getrennten Datenträger auf. Sichere Provider-Dateien getrennt und schütze sie mindestens wie die Originale. Starte nach einem Update mit einer konsistenten Kopie der Daten. Für einen Rollback verwende das vorherige Image zusammen mit dem Stand vor der Migration. Wiederherstellung auf eine frische Instanz lässt sich über `/health/ready`, die Anmeldung und die vorhandenen Wunschlisten, Zuordnungen und Regeln prüfen.
