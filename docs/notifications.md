# Benachrichtigungen

Stand 0.9.0. KeyHunter meldet einen Preisalarm über jeden Kanal, den du unter **Einstellungen → Benachrichtigungen** eingeschaltet hast, zum Beispiel:

> **KeyHunter: Wunschpreis erreicht · 24,90 €**
> „Forza Horizon 5“ ist bei deinem Wunschpreis angekommen: 24,90 € bei Eneba (Global, gültig in Deutschland). Ziel: 25,00 €.
> [Zum Angebot bei Eneba](https://www.eneba.com/de/…)

Bei der Alarmart „Neuer Tiefstpreis“ lautet der Text: „Forza Horizon 5“ hat einen neuen Tiefstpreis: 23,00 € bei Eneba (Global, gültig in Deutschland). Bisher am günstigsten: 24,90 €. Mit der Preisgrundlage „Gesamtpreis geschätzt“ steht hinter dem Preis „(geschätzter Gesamtpreis)“. Eine Testnachricht heißt „KeyHunter: Testnachricht“ und sagt ausdrücklich, dass sie ein Test ist.

## Grundlage: was Radarr, Sonarr und Seerr anbieten

- **Radarr/Sonarr** (Settings → Connect, gleiches Framework): Apprise, Custom Script, Discord, E-Mail, Emby/Jellyfin, Gotify, Join, Kodi, Mailgun, Notifiarr, ntfy, Plex, Prowl, Pushbullet, Pushover, Pushsafer, SendGrid, Signal, Simplepush, Slack, Synology, Telegram, Trakt, Twitter, Webhook.
- **Overseerr/Jellyseerr, heute Seerr** (Settings → Notifications): E-Mail, Web Push, Discord, Webhook, Gotify, ntfy, Pushbullet, Pushover, Slack, Telegram; Overseerr zusätzlich LunaSea.

Allen gemeinsam sind E-Mail, Discord, Telegram, Pushover, Webhook und (in den neueren Versionen) Gotify und ntfy. Genau diese Kanäle baut KeyHunter ein. Quellen: [Buildarr-Referenz der Radarr-Connections](https://buildarr.github.io/plugins/radarr/configuration/settings/notifications), [Seerr-Dokumentation](https://docs.seerr.dev/using-seerr/notifications/), [Overseerr-Dokumentation](https://docs.overseerr.dev/using-overseerr/notifications), [ntfy-Dokumentation](https://docs.ntfy.sh/publish/).

## Kanäle einrichten

Jeder Kanal hat einen eigenen Reiter mit Schalter **Aktiv**, **Speichern**, **Test senden** (schickt sofort eine Testnachricht nur über diesen Kanal und zeigt Erfolg oder den Fehler, etwa „HTTP 401“) und **Entfernen**. Ein Kanal wird beim ersten Speichern eingeschaltet. Mehrere Kanäle können gleichzeitig aktiv sein; ein Alarm geht an jeden. Tokens, Passwörter und geheime Adressen liegen in `notification-secrets.json` (Rechte 0600) im Datenverzeichnis, wie der IGDB-Zugang. Die Oberfläche zeigt nur „gespeichert · zum Ändern neu eingeben“; ein leeres Feld behält den gespeicherten Wert. Über `http` gehen Zugangsdaten nur an Server im lokalen Netz (private IP, `localhost`, Namen ohne Punkt, `.lan`, `.local`, `.home.arpa`, `.internal`).

### ntfy

1. ntfy-App installieren (Android, iOS, Web) und ein schwer zu erratendes Topic abonnieren, z. B. `keyhunter-x7f3k9`.
2. In KeyHunter die volle **Topic-URL** eintragen, z. B. `https://ntfy.sh/keyhunter-x7f3k9`. Ein **Zugangstoken** nur bei geschützten Topics oder eigenem Server.

Ankunft: Push auf dem Handy, Titel mit Preis, Tipp öffnet das Angebot (`Click`-Header). Eine vorhandene `/config/ntfy.env` (`NTFY_URL`, optional `NTFY_TOKEN`) gilt weiter, solange in der Oberfläche keine Topic-URL gespeichert ist; der Reiter zeigt dann „aus /config/ntfy.env“, und der Schalter wirkt auch auf diesen Kanal.

### Telegram

1. In Telegram @BotFather öffnen, `/newbot` senden, Namen vergeben, den **Bot-Token** kopieren (`123456789:AAE…`).
2. Dem neuen Bot einmal schreiben (sonst darf er dir nicht antworten).
3. Die **Chat-ID** ermitteln, z. B. über @userinfobot; Gruppen haben eine negative ID (Bot in die Gruppe einladen), Kanäle `@kanalname`.

Ankunft: Chatnachricht vom Bot, Titel fett, Link „Zum Angebot bei Eneba“ (Bot API `sendMessage`, HTML-Modus, Text maskiert).

### Discord

1. Kanaleinstellungen → Integrationen → Webhooks → Neuer Webhook.
2. **Webhook-URL** kopieren (`https://discord.com/api/webhooks/…`) und eintragen. Sie enthält den Token und wird geheim gespeichert.

Ankunft: Karte (Embed) im Kanal, Titel mit Preis ist anklickbar; Erwähnungen sind abgeschaltet.

### E-Mail (SMTP)

1. Daten des Mail-Anbieters eintragen: **SMTP-Server**, **Port**, **Verschlüsselung** (STARTTLS, meist 587, oder TLS, meist 465), **Benutzername** und **Passwort** (bei Gmail, GMX, Web.de & Co. meist ein App-Passwort), **Absender** und **Empfänger** (bis zu fünf, mit Komma).
2. „Unverschlüsselt“ geht nur an einen Mailserver im lokalen Netz und ohne Passwort.

Ankunft: E-Mail mit dem Titel als Betreff, Text- und einfacher HTML-Teil mit Link. Zertifikate prüft KeyHunter gegen den Zertifikatsspeicher des Containers (Rustls, kein OpenSSL).

### Gotify

1. Im Gotify-Server unter **Apps** eine Anwendung anlegen und den **App-Token** kopieren.
2. **Server-Adresse** als Basis-URL eintragen, z. B. `https://gotify.example.org` oder `http://192.168.1.10:8080`.

Ankunft: Push in der Gotify-App (Markdown), Tipp öffnet das Angebot (`client::notification` → `click`).

### Pushover

1. Auf pushover.net anmelden, den **User Key** kopieren.
2. Unter „Create an Application/API Token“ eine Anwendung anlegen, den **API-Token** kopieren.

Ankunft: Push in der Pushover-App mit Link „Zum Angebot bei Eneba“. Pushover kostet nach 30 Tagen Test einmalig je Plattform.

### Webhook

Für Home Assistant, n8n, Node-RED oder eigene Skripte: **Webhook-URL** eintragen (geheim gespeichert, darf eine Query enthalten), optional einen **Bearer-Token** (geht als `Authorization: Bearer …` mit). KeyHunter sendet `POST` mit `Content-Type: application/json`, folgt keinen Weiterleitungen und wartet höchstens 10 Sekunden:

```json
{
  "event": "target_reached",
  "title": "KeyHunter: Wunschpreis erreicht · 24,90 €",
  "message": "„Forza Horizon 5“ ist bei deinem Wunschpreis angekommen: 24,90 € bei Eneba (Global, gültig in Deutschland). Ziel: 25,00 €.",
  "game": "Forza Horizon 5",
  "price_cents": 2490,
  "price": "24,90 €",
  "target_cents": 2500,
  "previous_low_cents": null,
  "estimate": false,
  "shop": "Eneba",
  "region": "Global",
  "country": "DE",
  "url": "https://www.eneba.com/de/…"
}
```

`event` ist `target_reached`, `new_low` (dann `previous_low_cents` statt `target_cents`) oder `test` (dann sind `game` und die Preisfelder `null`). Jede Antwort 2xx gilt als zugestellt.

## Zustellung

Ein Alarm ist eine Zeile der Outbox. Wird er fällig, prüft KeyHunter Preis und Vergleichsumfang erneut und legt je aktivem Kanal eine Zustellung an. Jede Zustellung hat eigene Versuche: nach einem Fehler erneut nach 2 und nach 4 Minuten, nach dem dritten Fehlversuch gilt sie als „fehlgeschlagen“. Ein fehlerhafter Kanal hält die anderen nicht auf und löst bei ihnen keine Doppelnachricht aus. Ist ein Kanal zugestellt, beginnt die 24-Stunden-Sperre des Spiels. **Preisalarme → Letzte Zustellungen** zeigt je Alarm den Stand pro Kanal, **Einstellungen → Log** jede Zustellung und jeden Fehler mit Kanal und Grund (ohne Adressen oder Tokens). „Testnachricht senden“ auf der Seite Preisalarme nimmt denselben Weg über alle aktiven Kanäle.

## Vergleich

| Kanal | Aufwand im Code | Einrichtung | Ankunft | Link |
|---|---|---|---|---|
| ntfy | HTTPS-POST, Text | Topic-URL, optional Token | Push (App) | Tipp öffnet Angebot |
| Telegram | HTTPS-POST, JSON | Bot-Token, Chat-ID | Chatnachricht | Link im Text |
| Discord | HTTPS-POST, JSON | Webhook-URL | Karte im Kanal | Titel anklickbar |
| E-Mail | SMTP (lettre, Rustls) | Server, Port, Login, Absender, Empfänger | E-Mail | Link im Text/HTML |
| Gotify | HTTPS-POST, JSON | Server-Adresse, App-Token | Push (App, selbst gehostet) | Tipp öffnet Angebot |
| Pushover | HTTPS-POST, Formular | User Key, API-Token | Push (App, kostenpflichtig) | Link unter der Nachricht |
| Webhook | HTTPS-POST, JSON | URL, optional Token | JSON an eigenen Dienst | Feld `url` |

## Nicht eingebaut

- **Slack, Microsoft Teams, Matrix, Mattermost**: technisch wie Discord, aber für eine Ein-Personen-Preisliste selten genutzt; über den Webhook (z. B. mit n8n) erreichbar. Teams stellt alte Connector-Webhooks zudem auf Workflows um.
- **Apprise, Notifiarr**: brauchen einen zusätzlichen Dienst; der Webhook deckt das ab.
- **Signal**: keine offizielle Bot-API, nur über einen selbst betriebenen signal-cli-Server.
- **WhatsApp, SMS**: nur über kostenpflichtige Business-APIs mit Anmeldung des Absenders.
- **Web Push** (Seerr): verlangt HTTPS, Service Worker und Schlüsselverwaltung im Browser und funktioniert auf iOS nur eingeschränkt; ntfy liefert denselben Nutzen einfacher.
- **Pushbullet, Join, Prowl, Simplepush, Pushsafer, Mailgun, SendGrid**: kleine oder auslaufende Dienste beziehungsweise Mail-APIs, die SMTP bereits abdeckt.
- Medienserver-Ziele der Arr-Apps (Plex, Emby, Kodi, Trakt) passen nicht zu Preisalarmen.
