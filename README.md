# KEYHUNTER Global

Selbst gehostete Xbox-Wunschliste für Docker und Unraid. KEYHUNTER sucht über IGDB nach Xbox-Spielen und vergleicht bestätigte Angebote von Eneba und Driffle in EUR. In Version 0.2.1 hinterlegst du den IGDB-Zugang direkt in der App.

## Installation auf Unraid

1. Lade das Image-Archiv und das Unraid-Template aus dem [Release v0.2.1](https://github.com/Buffer379x/keyhunter/releases/tag/v0.2.1).
2. Prüfe optional den SHA-256-Wert mit `sha256sum -c keyhunter-0.2.1-amd64.tar.gz.sha256` und importiere das Archiv auf dem Unraid-Host:

   ```bash
   docker load -i keyhunter-0.2.1-amd64.tar.gz
   ```

3. Importiere das Template und richte das Datenverzeichnis, die HTTPS-Adresse und bei Bedarf IGDB und ntfy ein. Die Anleitung enthält die Zuordnung der Mounts und die Schritte für die erste Anmeldung. [Unraid und Betrieb](docs/operations.md)

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
