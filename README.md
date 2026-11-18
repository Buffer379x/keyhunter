# KEYHUNTER Global

Selbst gehostete Xbox-Wunschliste für Docker und Unraid. KEYHUNTER sucht über IGDB nach Xbox-Spielen und vergleicht bestätigte Angebote von Eneba und Driffle in EUR. In Version 0.2.1 hinterlegst du den IGDB-Zugang direkt in der App.

## Installation auf Unraid

1. Lade das [Unraid-Template](https://github.com/Buffer379x/keyhunter/releases/latest/download/keyhunter-unraid.xml) und importiere es in Unraid.
2. Starte den Container mit `ghcr.io/buffer379x/keyhunter:latest`. Unraid lädt das Image direkt aus der GitHub Container Registry.
3. Richte das Datenverzeichnis und die HTTPS-Adresse ein. [Unraid und Betrieb](docs/operations.md)

Das [GitHub-Package](https://github.com/users/Buffer379x/packages/container/package/keyhunter) liefert auch feste Versions-Tags wie `0.2.0` und `0.2.1`. Die [Releases](https://github.com/Buffer379x/keyhunter/releases) enthalten zusätzlich Archive für die Offline-Installation.

## Lokal mit Compose

```bash
test -f .env || cp .env.example .env
mkdir -p work/local/runtime/data work/local/runtime/config
docker compose up -d --build
```

Setze in `.env` die lokale UID und GID für die Datenverzeichnisse. Öffne `http://localhost:3000` und verwende den Einrichtungscode aus `work/local/runtime/data/bootstrap-token`. Trage deine **Client-ID** und dein **Client Secret** nach der Anmeldung unter **Einstellungen → IGDB-Zugang** ein. Das Speichern prüft den Zugang bei Twitch.

## Angebote und Alarme

Wähle ein Zielland und speichere dein Spiel mit der gewünschten Edition und Xbox-Plattform. Bestätige passende Produktzuordnungen im Spieldetail. Die App zeigt beobachtete Grundpreise und optionale Schätzpreise getrennt. Nur aktuelle Angebote mit bestätigter Aktivierung und passendem Kaufkontext zählen zum Vergleich. Die Preisalarme verwenden dieselben Regeln. [Datenquellen](docs/data-sources.md)

## Entwicklung

```bash
sh deploy/check.sh
cd frontend && npx playwright install chromium && cd ..
sh deploy/browser-check.sh
```

GitHub Actions führt die Prüfungen mit synthetischen Daten aus. [Architektur](docs/architecture.md) · [Abhängigkeiten](docs/dependencies.md)
