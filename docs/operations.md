# Installation und Betrieb

## Unraid im LAN

1. Lade das [Unraid-Template](https://raw.githubusercontent.com/Buffer379x/keyhunter/main/deploy/unraid/keyhunter.xml) und lege es im Ordner `/boot/config/plugins/dockerMan/templates-user` ab. Wähle in der Docker-Ansicht **Add Container** und das KeyHunter-Template.
2. Das Feld **Repository** enthält `ghcr.io/buffer379x/keyhunter:latest`. Unraid lädt das Image beim Anwenden aus dem [GitHub-Package](https://github.com/users/Buffer379x/packages/container/package/keyhunter).
3. Wähle ein eigenes lokales Appdata-Verzeichnis für `/data`. Das aktuelle Unraid-Template bereitet diesen Ordner beim Start vor. Nutze für SQLite ein lokales Dateisystem. Benachrichtigungen richtest du in der App ein (siehe [notifications.md](notifications.md)); eine ältere ntfy-Datei kannst du weiter als `/config` schreibgeschützt einbinden.
4. Öffne die WebUI in Unraid. Bei eigener LAN-IP erreichst du sie direkt unter `http://<Container-IP>:3000`. Im Bridge-Modus verwendest du die IP des Unraid-Hosts und den veröffentlichten Port.
5. Verwende den Code aus der Datei `bootstrap-token` im gemounteten Datenverzeichnis, um deinen Eigentümerzugang einzurichten.

### Rechte am Datenordner

Das Unraid-Template ab 0.2.3 richtet nach dem Start die Rechte am eingebundenen `/data` und den bekannten Datenbank- und Zugangsdateien ein. Danach läuft der Webdienst als UID/GID `10001:10001` ohne Linux-Capabilities. Andere Dateien und der optionale `/config`-Mount behalten ihre Rechte. Für einen vorhandenen Unraid-Container muss das aktualisierte Template einmal angewendet werden. Ein reines Image-Update behält die bisherigen Startparameter. Verwende dabei dasselbe Datenvolume.

Bei Compose oder einem eigenen `docker run` läuft das Image standardmäßig direkt als Nicht-Root-Benutzer. Stelle für manuelle Bind-Mounts sicher, dass der konfigurierte Benutzer schreiben kann. Alternativ initialisiert Docker ein benanntes Volume mit dem passenden Eigentümer.

### Webadresse und HTTPS

`KEYHUNTER_ORIGIN` ist optional. Leer oder weggelassen funktioniert HTTP auf privaten IPv4- und IPv6-Adressen, auf Loopback und auf lokalen Hostnamen (ohne Punkt wie `tower` oder mit `.local`, `.lan`, `.home.arpa`, `.internal`). Verwende HTTP nur in einem vertrauenswürdigen LAN oder VPN. Passphrase, Sitzung und Zugangsdaten werden dabei ohne TLS übertragen.

Für HTTPS leite mit einem Reverse Proxy an Port 3000 weiter (Beispiele für Caddy, Nginx Proxy Manager und Traefik mit allen Variablen, HSTS und Fehlerbildern: [reverse-proxy.md](reverse-proxy.md)). Der Proxy muss den ursprünglichen Host einschließlich eines nicht standardmäßigen Ports weiterreichen. Falls der Proxy den Host umschreibt oder du genau eine Adresse erlauben möchtest, setze `KEYHUNTER_ORIGIN` auf die vollständige Browser-URL ohne Pfad. Wenn HTTP-Anmeldung und Änderungen gesperrt bleiben sollen, setze `KEYHUNTER_ALLOW_INSECURE_HTTP=false`.

### Anmeldeschutz und Passphrase

Nach fünf falschen Anmeldeversuchen innerhalb von 15 Minuten wartet die betroffene Adresse den Rest dieser 15 Minuten; andere Geräte melden sich weiter an. Über alle Adressen zusammen sind 100 Fehlversuche je 15 Minuten erlaubt, danach ist die Anmeldung für alle kurz gesperrt. Eine laufende Sitzung bleibt davon unberührt. Anfragen, deren Daten nicht innerhalb von 15 Sekunden vollständig ankommen, bricht der Server ab; keine Anfrage läuft länger als 60 Sekunden.

Hinter einem Reverse Proxy kommen alle Anfragen von der Adresse des Proxys und zählen damit als eine Quelle: Fünf Fehlversuche von irgendwoher sperren dann alle, die über den Proxy kommen. Setze deshalb `KEYHUNTER_TRUSTED_PROXY` auf die Adresse des Proxys, als IP oder Bereich (z. B. `172.18.0.0/16`, mehrere durch Komma getrennt). Nur für Anfragen von dort zählt die Adresse, die der Proxy in `X-Forwarded-For` einträgt; von rechts gelesen die erste, die nicht selbst zum Proxy gehört. Der Proxy muss den Header setzen bzw. ergänzen (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`). Trage dort nie Adressen ein, von denen auch andere Geräte direkt zugreifen.

Unter **Einstellungen → System** änderst du die Passphrase: aktuelle Passphrase und zweimal die neue mit 12 bis 128 Zeichen. Die Sitzung in diesem Browser bleibt, alle anderen enden. **Überall abmelden** beendet alle Sitzungen, auch die aktuelle, etwa nach dem Verlust eines Geräts.

### Passphrase vergessen

Ohne Passphrase setzt du den Eigentümerzugang über die Kommandozeile zurück. Das geht nur mit Zugriff auf den Docker-Host bzw. das Datenvolume, nie über die Weboberfläche oder die API. `keyhunter --reset-owner` entfernt den Eigentümer und beendet alle Sitzungen, schreibt einen neuen Einrichtungscode in `bootstrap-token` im Datenverzeichnis (bzw. in die Datei aus `KEYHUNTER_BOOTSTRAP_FILE`) und vermerkt das im Log. Wunschliste, Bibliothek, Preise, Zuordnungen, Alarme und Einstellungen bleiben erhalten. Danach öffnest du KeyHunter und richtest den Zugang mit dem neuen Code und einer neuen Passphrase wieder ein; ein Neustart ist nicht nötig, der alte Code gilt nicht mehr.

Der Befehl muss als Eigentümer des Datenordners laufen, wie der Dienst selbst, sonst bricht er ohne Änderung ab:

- **Unraid** (der Container startet als root und wechselt dann zu UID 10001): im Unraid-Terminal `docker exec --user 10001:10001 KeyHunter /app/keyhunter --reset-owner`. Den Containernamen zeigt der Docker-Tab.
- **Compose**: `docker compose exec keyhunter /app/keyhunter --reset-owner`.
- **Gestoppter Container**, als einmaliger Lauf mit demselben Datenvolume: `docker run --rm --user 10001:10001 -v /mnt/user/appdata/keyhunter:/data ghcr.io/buffer379x/keyhunter:latest --reset-owner` (Pfad und Benutzer an deine Installation anpassen, bei Compose z. B. `--user 1000:1000`). Danach den Container wieder starten.

Bei einem Upgrade auf 0.2.2 kannst du für den direkten Zugriff per LAN-IP eine alte `KEYHUNTER_ORIGIN` entfernen oder leeren. Falls `KEYHUNTER_ALLOW_INSECURE_HTTP` auf `false` steht, setze es auf `true` oder entferne es. Das Datenvolume bleibt erhalten.

Bei einem bereits eingerichteten Container kannst du das Feld **Repository** direkt auf `ghcr.io/buffer379x/keyhunter:latest` ändern. Behalte das Datenvolume und die lokale Konfiguration. Unraids Funktion **Check for Updates** erkennt neue Images unter diesem Tag. Für eine feste Version lässt sich `latest` durch eine Versionsnummer ersetzen.

Wenn der Status **not available** ist, prüfe zuerst das Feld **Repository**. Eine lokal importierte Referenz wie `keyhunter:0.2.2` hat keine GHCR-Herkunft für die Updateprüfung. Mit der GHCR-Referenz kannst du **Check for Updates** erneut ausführen. Falls die Anzeige ausbleibt, teste im Unraid-Terminal `docker pull ghcr.io/buffer379x/keyhunter:latest`. Nach erfolgreichem Pull kannst du im Docker-Tab unter **Advanced View → Force Update** den Container aus seinem bestehenden Template neu erstellen. Bei diesem Schritt bleiben die eingebundenen Daten erhalten.

Die Veröffentlichung wurde unter Linux/amd64 mit Docker geprüft. Das XML ist für die manuelle Installation vorbereitet. Der Test auf einer Unraid-Installation macht der Eigentümer vor dem Release mit [release-1.0-acceptance.md](release-1.0-acceptance.md).

## Zugangsdaten

Melde dich als Eigentümer an und öffne **Einstellungen → Spieleindex → IGDB-Zugang**. Gib Client-ID und Client Secret deiner Twitch-Anwendung ein. KeyHunter prüft das Paar bei Twitch und übernimmt es direkt. Um den Zugang zu ersetzen, gib beide Werte erneut ein.

Beim Upgrade von 0.2.0 verwende das bestehende Datenvolume und hinterlege den IGDB-Zugang einmal in der App. Die alte Variable `KEYHUNTER_IGDB_ENV_FILE` und deren separater IGDB-Dateimount können aus der Containerkonfiguration entfernt werden. Gespeicherte Wünsche, Zuordnungen und Preisalarme bleiben im Datenvolume erhalten.

Der Server speichert die IGDB-Werte in `igdb-credentials.json` mit Rechten 0600 im Datenvolume. Die Einstellungen zeigen den Konfigurationsstatus. Die gespeicherten Werte sind für den Besitzer der Datei lesbar. Schütze das Datenvolume und alle Sicherungen entsprechend.

Benachrichtigungskanäle (ntfy, Telegram, Discord, E-Mail, Gotify, Pushover, Webhook) richtest du unter **Einstellungen → Benachrichtigungen** ein; Anleitung und Nachrichtenformat stehen in [notifications.md](notifications.md). Tokens, Passwörter und geheime Adressen speichert der Server in `notification-secrets.json` mit Rechten 0600 im Datenvolume und gibt sie nie zurück. Die bisherige ntfy-Datei bleibt gültig, bis in der App eine Topic-URL gespeichert wird: [ntfy.env.example](../deploy/ntfy.env.example) als Vorlage, bei Unraid im Konfigurationsmount unter `/config/ntfy.env`, bei Compose auf dem Host unter `work/local/runtime/config/ntfy.env`, Rechte 0600 und passender Eigentümer. `NTFY_URL` ist die vollständige Topic-URL; ein separater Bearer-Token erfordert HTTPS. Starte nach Änderung der ntfy-Datei neu.

## Konfiguration

Alle Einstellungen des Dienstes außer den Zugangsdaten laufen über Umgebungsvariablen oder die App. Ohne Angabe gilt der Standard.

| Variable | Standard | Wirkung |
|---|---|---|
| `KEYHUNTER_BIND` | `127.0.0.1:3000` (im Image `0.0.0.0:3000`) | Adresse und Port des Dienstes |
| `KEYHUNTER_DATA_DIR` | `data` (im Image `/data`) | Datenverzeichnis mit Datenbank, `bootstrap-token` und Zugangsdateien |
| `KEYHUNTER_FRONTEND_DIR` | `../frontend/dist` (im Image `/app/frontend`) | gebaute Weboberfläche |
| `KEYHUNTER_ORIGIN` | leer | genau eine erlaubte Browser-Adresse, siehe „Webadresse und HTTPS“ |
| `KEYHUNTER_ALLOW_INSECURE_HTTP` | `true` | HTTP-Anmeldung und Änderungen auf privaten Adressen; `false` verlangt HTTPS |
| `KEYHUNTER_TRUSTED_PROXY` | leer | IP oder Bereich des Reverse Proxys (kommagetrennt); nur von dort zählt `X-Forwarded-For` für die Anmeldedrossel |
| `KEYHUNTER_BOOTSTRAP_FILE` | `<Datenverzeichnis>/bootstrap-token` | Ablage des Einrichtungscodes |
| `KEYHUNTER_SHOP_DAILY_JOBS` | 500 | Standard-Tagesbudget je Shop, ganze Zahl von 1 bis 2000; ungültige Werte gelten als nicht gesetzt |
| `KEYHUNTER_NTFY_ENV_FILE` | leer | Pfad der älteren ntfy-Datei (`/config/ntfy.env`), siehe Zugangsdaten |

Compose liest `KEYHUNTER_UID`, `KEYHUNTER_GID`, `KEYHUNTER_PORT` und `KEYHUNTER_IMAGE` aus `.env` (Vorlage: [.env.example](../.env.example)). Das Unraid-Template setzt die übrigen Variablen unter „Advanced“.

## Grenzen und Zeiten

| Was | Wert |
|---|---|
| Wunschliste | höchstens 100 aktive Wünsche |
| Tagesbudget je Shop | 20 bis 2000 Jobs pro UTC-Tag in der App, Standard 500 |
| Abstand zwischen zwei Abrufen eines Shops | Rest des UTC-Tages geteilt durch das verbleibende Budget, 20 s bis 1 h |
| Produktintervall je Shop | 15 Minuten bis 7 Tage, Standard 8 Stunden |
| Manuelle Prüfung | 15 Minuten Abstand zum letzten Abruf |
| Wiederholung nach vorübergehenden Fehlern | nach 2, 10 und 60 Minuten, danach im Intervall |
| Frische eines Preises | max(24 Stunden, 2 × effektives Intervall) |
| Nicht erreichbare Produktseite | nach 5 Fehlschlägen in Folge nur noch mit 4-fachem Intervall |
| Abrufhistorie / Log | 30 Tage / 7 Tage |
| Anfragen | Body höchstens 16 KiB, Daten innerhalb von 15 s, Antwort innerhalb von 60 s |
| Anmeldeversuche | 5 Fehlversuche je Adresse und 100 insgesamt in 15 Minuten |
| Sitzung | 12 Stunden |

Das Prüftempo (häufig, normal, selten) einer Preisbeobachtung und die Frischeregel sind in [data-sources.md](data-sources.md) beschrieben.

## API

Die Weboberfläche nutzt `/api/v1/*` mit Sitzungscookie und CSRF-Token. Jede Route außer Einrichtung und Anmeldung prüft zuerst die Sitzung und liest danach erst Pfad, Query und Body: Ohne Sitzung antwortet sie immer mit 401, auch bei ungültigem Body. Fehler haben immer die Form `{"error": "<deutsche Meldung>", "code": "<fester Code>"}`. Codes: `invalid_request` (400), `unauthenticated` (401), `forbidden` (403), `not_found` (404), `timeout` (408), `conflict` (409), `method_not_allowed` (405), `too_large` (413), `unsupported_media_type` (415), `unprocessable` (422), `rate_limited` (429, mit `Retry-After`), `unavailable` (502/503/504) und `internal`. `GET /api/v1/counts` liefert die Zahlen der Navigation: `{"wishlist", "cart", "library", "alerts"}` (aktive Alarme). `GET /api/v1/status/fetch` beschreibt den Abrufstatus, siehe „Jobs und Speicher“.

## Jobs und Speicher

Bekannte Produktseiten werden standardmäßig alle acht Stunden eingeplant; pro Shop ist das Intervall einstellbar. Die Discovery läuft frühestens täglich (bei längeren Produktintervallen entsprechend später) mit begrenzter Abdeckung. Jeder Shop hat ein Tagesbudget von standardmäßig 500 Jobs pro UTC-Tag. Unter **Einstellungen → Key-Shops** lässt es sich je Shop zwischen 20 und 2000 festlegen; ohne eigenen Wert gilt `KEYHUNTER_SHOP_DAILY_JOBS` (1–2000) und sonst 500. Eine Änderung wirkt ohne Neustart. Die Abrufe werden gleichmäßig über den Tag verteilt: Nach einem Abruf wartet der Shop den Rest des UTC-Tages geteilt durch das verbleibende Budget, mindestens 20 Sekunden und höchstens eine Stunde; der nächste erlaubte Zeitpunkt übersteht einen Neustart. Direkte Aktionen warten nicht, zählen aber zum Budget: angeforderte Aktualisierungen, die erste Suche eines neuen Wunsches mit ihren Folgeseiten und der erste Preisabruf der dabei gefundenen oder von Hand hinzugefügten Produkte. Das Budget geht zuerst an angeforderte Aktualisierungen und erste Suchen, dann an Preise aktiver Wünsche, die im Zielland gelten können; jeder vierte Abruf eines Tages geht an den am längsten wartenden übrigen Job (Wiederholungssuchen, andere Regionen, Editionsvorschauen, Discovery). Vorübergehende Fehler werden nach 2, 10 und 60 Minuten wiederholt, danach im normalen Intervall. Ist eine Produktseite fünfmal in Folge nicht gefunden oder nicht lesbar, wird sie bis zum nächsten erfolgreichen Abruf nur noch mit vierfachem Intervall geprüft; das Log meldet das einmal (seit 0.9.3). Manuelle Prüfungen halten 15 Minuten Abstand zum letzten Abruf und schließen zuvor fehlgeschlagene Links ein.

`GET /api/v1/status/fetch` (angemeldet) zeigt je Shop das Budget (verbraucht, Limit und dessen Herkunft, aktueller Abstand, nächster möglicher Abruf, Abrufe je UTC-Stunde des Tages und den geschätzten Tagesbedarf), fällige Jobs, Pausen und die letzten 25 Abrufe. Der Tagesbedarf zählt die regelmäßigen Abrufe des aktuellen Plans: Produkte im angepassten Intervall, wöchentliche Suchen, beobachtete Vorschauen und die Discovery. Liegt er über dem Budget, werden Preise seltener aktualisiert als eingestellt. Die Historie wird 30 Tage aufbewahrt. `/health/ready` meldet 503, wenn ein Abrufdienst länger als fünf Minuten nicht reagiert. Compose und Unraid begrenzen den App-Speicher auf 512 MiB.

Seit 0.8.3 nennt `GET /api/v1/status/fetch` unter `upcoming` außerdem die fünf Abfragen, die als Nächstes laufen, mit geschätzter Startzeit. `GET /api/v1/status/fetch/runs` liefert die aufgezeichneten Abrufe (30 Tage) seitenweise mit Spiel und Region; `tone` (ok, warn, error), `q` (Volltext), `page` und `per_page` (10–200) filtern und blättern.

### Log

**Einstellungen → Log** (API `GET /api/v1/log` mit `level`, `q`, `page`, `per_page`) protokolliert Anmeldungen, Änderungen an Wunschliste, Bibliothek, Warenkorb, Zuordnungen, Preisalarmen und Einstellungen, zugestellte und fehlgeschlagene Benachrichtigungen sowie Fehler beim Abruf (ohne „Nicht gefunden“). Jeder Eintrag hat eine Stufe (Info, Warnung, Fehler) und einen Bereich. Einträge bleiben 7 Tage; jeder neue Eintrag löscht ältere automatisch. Passphrase, Sitzungen, Tokens, Zugangsdaten und Adressen der Benachrichtigungskanäle werden nie geschrieben. Wiederholte Hintergrundfehler erscheinen höchstens einmal pro Stunde.

## Backup und Update

Es gibt drei Wege, geordnet nach Umfang:

1. **Wunschliste** (Export und Import): **Einstellungen → System → Sichern & Wiederherstellen**. Der Export schreibt Titel, Plattform und IGDB-ID als JSON-Datei. Der Import liest diese Datei, zeigt vorher, wie viele Spiele hinzukommen, schon auf der Liste oder in der Bibliothek sind oder dem Katalog unbekannt sind, und fügt erst nach deiner Bestätigung hinzu. Er geht pro Eintrag denselben Weg wie das Hinzufügen von Hand, löscht und überschreibt nichts, lässt Zuordnungen unberührt und ändert bei einem zweiten Import derselben Datei nichts. Preise, Zuordnungen, Alarme und Einstellungen sind nicht in der Datei. Der Import braucht für unbekannte Spiele den IGDB-Zugang.
2. **Automatische Sicherung vor Migrationen** (siehe unten): eine Kopie der Datenbank vor einem Update, das das Schema ändert.
3. **Kaltbackup** des ganzen Datenverzeichnisses: der vollständige Stand (Datenbank mit Preisen, Zuordnungen, Alarmen, Einstellungen, Zugangsdaten).

### Kaltbackup und Wiederherstellung

Ein Kaltbackup ist eine Kopie des Datenverzeichnisses bei gestopptem Container, also ohne halb geschriebene Datenbankdateien. Das Datenbackup enthält den IGDB-Zugang (`igdb-credentials.json`), die Zugangsdaten der Benachrichtigungskanäle (`notification-secrets.json`) und die Anmeldedaten (`keyhunter.db`). Bewahre es auf einem getrennten Datenträger auf und schütze es wie ein Passwort. Eine getrennte ntfy-Datei (`/config/ntfy.env`) sicherst du ebenfalls.

**Sichern** (Unraid, Datenordner zum Beispiel `/mnt/user/appdata/keyhunter`):

1. Docker-Tab: Container **KeyHunter** stoppen (Compose: `docker compose stop keyhunter`).
2. Das ganze Verzeichnis kopieren, mit Rechten und allen Dateien einschließlich `keyhunter.db-wal` und `keyhunter.db-shm`, falls vorhanden: `cp -a /mnt/user/appdata/keyhunter /mnt/user/backups/keyhunter-$(date +%F)`.
3. Container wieder starten.

**Wiederherstellen** (auf demselben oder einem neuen Rechner):

1. Container stoppen, falls er läuft.
2. Das Datenverzeichnis leeren oder wegsichern und die Kopie an dessen Stelle legen: `cp -a /mnt/user/backups/keyhunter-2026-11-23/. /mnt/user/appdata/keyhunter/`.
3. Container mit **demselben Datenvolume** und mindestens der Version starten, mit der das Backup entstand. Auf Unraid richtet das Template die Rechte beim Start ein; bei Compose oder `docker run` muss der konfigurierte Benutzer (UID 10001 im Image) schreiben dürfen.
4. Prüfen: `/health/ready` antwortet, die Anmeldung mit der **Passphrase von damals** funktioniert (kein neuer Einrichtungscode), Wunschliste, Preise und Einstellungen sind da.

Dieser Ablauf ist praktisch nachgewiesen: `sh deploy/backup-restore-check.sh` baut mit der echten App (Prüfserver mit synthetischem Katalog, ohne Netz) ein Datenverzeichnis mit Einrichtung, Wünschen, Preisen und Einstellungen, kopiert es bei gestopptem Server und startet eine frische Instanz auf der Kopie. Wunschliste, Preis-Badges und Einstellungen müssen Byte für Byte übereinstimmen, die richtige Passphrase meldet an, eine falsche nicht.

Für ein **Update** gilt dasselbe in Kurzform: Container stoppen, Kaltbackup anlegen, neues Image ziehen, starten. Für einen **Rollback** nimmst du das vorherige Image zusammen mit dem Stand vor dem Update: entweder dein Kaltbackup oder die Kopie unter `backups` (siehe „Sicherung vor Migrationen“). Ein altes Image mit einer bereits migrierten Datenbank startet nicht zuverlässig.

### Parserprüfung vor dem Release

Die Shop-Leser hängen an der Seitenstruktur der Shops (siehe [data-sources.md](data-sources.md)). Bevor du ein Release veröffentlichst oder installierst, kannst du **von Hand** prüfen, ob sie noch Produkte mit Preisen finden. Das Skript ruft je Shop genau eine Produktseite ab (und die `robots.txt` des Shops), mit demselben Client, derselben Kennung `Keyhunter` und denselben Regeln wie die App. Es läuft nie automatisch, nicht in Tests, nicht in CI und nicht in `deploy/check.sh`.

```sh
KEYHUNTER_CANARY_CONSENT=1 sh deploy/parser-canary.sh \
  "https://www.eneba.com/de/xbox-<Produkt>-key-<Region>" \
  "https://driffle.com/de/<Produkt>-xbox-live-digital-<…>-p<Nummer>"
```

Als Links nimmst du je einen Produktlink aus der App (Spieldetail → Angebote). `KEYHUNTER_IMAGE` wählt das Image (Voreinstellung: das Release-Image auf GHCR; lokal zum Beispiel `keyhunter:1.0.0`). Ohne `KEYHUNTER_CANARY_CONSENT=1` startet nichts. Vor dem ersten Abruf nennt die App, welche Adressen sie kontaktiert. Das Ergebnis je Shop: `ok` mit Produktname und Zahl der Preise, oder `failed`/„kein Preis“ mit dem Fehlercode, und der Exit-Code 1. Es speichert nichts und öffnet die Datenbank nicht (der Container läuft ohne Datenvolume). Einen Treffer „ausverkauft“ wertet es als nicht bestanden, weil kein Preis zu prüfen ist: nimm dann einen anderen Link.

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

## Upgrade auf 0.6.1

Datenvolume beibehalten; vor der Migration entsteht wie gewohnt eine Sicherung. Migration 0014 ergänzt ein Tagesbudget je Shop, den Zeitpunkt für die gleichmäßige Verteilung der Abrufe und eine Markierung für direkte Aktionen. Der Standard steigt von 120 auf 500 Jobs pro Shop und UTC-Tag; die Abrufe laufen nicht mehr am Stück bis zum Limit, sondern verteilt über den ganzen Tag.

**Unraid:** Die bisherige Vorlage schreibt `KEYHUNTER_SHOP_DAILY_JOBS=120` fest in den Container. Dieser Wert gilt nach dem Update weiter, bis du ihn änderst. Am einfachsten legst du das Budget in der App unter **Einstellungen → Key-Shops** fest: Der Wert dort hat Vorrang vor der Variablen und wirkt ohne Neustart. Alternativ setzt du die Variable im Container auf 500 oder leerst sie. Der Abrufstatus zeigt, woher das Limit stammt und wie viele Abrufe der aktuelle Plan pro Tag braucht.
