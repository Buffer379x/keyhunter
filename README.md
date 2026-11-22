# KeyHunter

Selbst gehostete Xbox-Wunschliste für Docker und Unraid. KeyHunter sucht über IGDB nach Xbox-Spielen und vergleicht bestätigte Angebote von Eneba und Driffle in EUR. Die WebUI ist ohne voreingestellte Adresse per LAN-IP erreichbar. Den IGDB-Zugang hinterlegst du unter Einstellungen → Spieleindex. Key-Shops mit Abfrageintervall und optionalen Gebühren verwaltest du auf einer eigenen Einstellungsseite.

## Installation auf Unraid

1. Lade das [Unraid-Template](https://raw.githubusercontent.com/Buffer379x/keyhunter/main/deploy/unraid/keyhunter.xml) und importiere es in Unraid.
2. Starte den Container mit `ghcr.io/buffer379x/keyhunter:latest`. Unraid lädt das Image direkt aus der GitHub Container Registry.
3. Wähle das Datenverzeichnis und öffne die WebUI über die LAN-IP. Das aktuelle Template bereitet die Ordnerrechte beim Start vor. HTTPS über einen Reverse Proxy ist optional. [Unraid und Betrieb](docs/operations.md)

Das [GitHub-Package](https://github.com/users/Buffer379x/packages/container/package/keyhunter) liefert auch feste Versions-Tags wie `0.9.2` und `0.9.3`. Die [Releases](https://github.com/Buffer379x/keyhunter/releases) enthalten zusätzlich Archive für die Offline-Installation.

## Lokal mit Compose

```bash
test -f .env || cp .env.example .env
mkdir -p work/local/runtime/data work/local/runtime/config
docker compose up -d
```

Setze in `.env` die lokale UID und GID für die Datenverzeichnisse. Öffne `http://localhost:3000` und verwende den Einrichtungscode aus `work/local/runtime/data/bootstrap-token`. Trage deine **Client-ID** und dein **Client Secret** nach der Anmeldung unter **Einstellungen → Spieleindex** ein. Das Speichern prüft den Zugang bei Twitch.

## Angebote und Alarme

Wähle bei der Einrichtung dein Zielland und speichere dein Spiel mit der gewünschten Edition und Xbox-Plattform. KeyHunter sucht automatisch nach Eneba-Produkten und gibt eindeutige Treffer frei. Wunschliste und Spieldetail zeigen immer den besten in deinem Zielland gültigen Preis neben der günstigsten Region weltweit, damit du siehst, ob sich ein Key aus einem anderen Land lohnt. Im Spieldetail findest du Angebote, Preisverlauf, Editionsvergleich, Preisalarm und offene Zuordnungen in eigenen Tabs. Die App zeigt beobachtete Grundpreise und optionale Schätzpreise getrennt. Nur aktuelle Angebote mit bestätigter Aktivierung und passendem Kaufkontext zählen zum Vergleich. Die Preisalarme verwenden dieselben Regeln. [Datenquellen](docs/data-sources.md)

## Entwicklung

Für einen lokalen Docker-Build verwende `docker build -t keyhunter:local .` und starte ihn mit `KEYHUNTER_IMAGE=keyhunter:local docker compose up -d --pull never`.

```bash
sh deploy/check.sh
cd frontend && npx playwright install chromium && cd ..
sh deploy/browser-check.sh
```

GitHub Actions führt die Prüfungen mit synthetischen Daten aus. [Architektur](docs/architecture.md) · [Abhängigkeiten](docs/dependencies.md)

Änderungen je Version: [CHANGELOG](CHANGELOG.md).
