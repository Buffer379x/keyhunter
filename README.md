# KeyHunter

Selbst gehostete Xbox-Wunschliste für Docker und Unraid. KeyHunter sucht über IGDB nach Xbox-Spielen und vergleicht bestätigte Angebote von Eneba und Driffle in EUR. Die WebUI ist ohne voreingestellte Adresse per LAN-IP erreichbar. Den IGDB-Zugang hinterlegst du unter Einstellungen → Spieleindex. Key-Shops mit Abfrageintervall und optionalen Gebühren verwaltest du auf einer eigenen Einstellungsseite.

## Installation auf Unraid

1. Lade das [Unraid-Template](https://raw.githubusercontent.com/Buffer379x/keyhunter/main/deploy/unraid/keyhunter.xml) und importiere es in Unraid.
2. Starte den Container mit `ghcr.io/buffer379x/keyhunter:latest`. Unraid lädt das Image direkt aus der GitHub Container Registry.
3. Wähle das Datenverzeichnis und öffne die WebUI über die LAN-IP. Das aktuelle Template bereitet die Ordnerrechte beim Start vor. HTTPS über einen Reverse Proxy ist optional. [Unraid und Betrieb](docs/operations.md)

Das [GitHub-Package](https://github.com/users/Buffer379x/packages/container/package/keyhunter) liefert auch feste Versions-Tags wie `0.4.2` und `0.5.0`. Die [Releases](https://github.com/Buffer379x/keyhunter/releases) enthalten zusätzlich Archive für die Offline-Installation.

## Lokal mit Compose

```bash
test -f .env || cp .env.example .env
mkdir -p work/local/runtime/data work/local/runtime/config
docker compose up -d
```

Setze in `.env` die lokale UID und GID für die Datenverzeichnisse. Öffne `http://localhost:3000` und verwende den Einrichtungscode aus `work/local/runtime/data/bootstrap-token`. Trage deine **Client-ID** und dein **Client Secret** nach der Anmeldung unter **Einstellungen → IGDB-Zugang** ein. Das Speichern prüft den Zugang bei Twitch.

## Angebote und Alarme

Wähle ein Zielland und speichere dein Spiel mit der gewünschten Edition und Xbox-Plattform. KeyHunter sucht automatisch nach Eneba-Produkten und gibt eindeutige Treffer frei. Im Spieldetail kannst du weitere Editionen auswählen, Regionen vergleichen und offene Zuordnungen prüfen. Die App zeigt beobachtete Grundpreise und optionale Schätzpreise getrennt. Nur aktuelle Angebote mit bestätigter Aktivierung und passendem Kaufkontext zählen zum Vergleich. Die Preisalarme verwenden dieselben Regeln. [Datenquellen](docs/data-sources.md)

## Entwicklung

Für einen lokalen Docker-Build verwende `docker build -t keyhunter:local .` und starte ihn mit `KEYHUNTER_IMAGE=keyhunter:local docker compose up -d --pull never`.

```bash
sh deploy/check.sh
cd frontend && npx playwright install chromium && cd ..
sh deploy/browser-check.sh
```

GitHub Actions führt die Prüfungen mit synthetischen Daten aus. [Architektur](docs/architecture.md) · [Abhängigkeiten](docs/dependencies.md)

Ab **0.4.0** ist das Wechseln einer Edition eine Vorschau: Deine gemerkte Version bleibt bestehen. Offizielle Xbox-Bundle-Inhalte bilden eine separate Vergleichstabelle. Die Preisübersicht gruppiert Angebote nach Land mit Flagge und Abfragestand; alle Händlerangebote öffnest du über die jeweilige Länderzeile. Der verbundene Preisverlauf lässt sich zwischen Zielland und allen Ländern umschalten. Die Wunschliste ist nach Datum, Preis und Alphabet sortierbar.

Ab **0.4.1** besitzt jeder Wunsch einen dauerhaften Preis-Badge, bei fehlendem gültigem Preis mit „Unbekannt“. Unter **Einstellungen → Allgemein** wählst du den tiefsten Grundpreis für dein aktivierbares Zielland oder über alle Regionen. „Als gekauft markieren“ verschiebt die gemerkte Edition in die **Bibliothek** mit Cover und Titel. Rückverschieben und erneutes Hinzufügen bereits vorhandener Spiele bzw. anderer Editionen verlangen eine Bestätigung. Preisbeobachtungen bleiben beim Verschieben erhalten; Preisalarme werden beim Kauf deaktiviert.

Ab **0.4.2** verwendet das Preis-Badge bereits gespeicherte Messungen beim Laden. Ältere Preise bleiben mit Abfragestand erkennbar; „Unbekannt“ bedeutet ausschließlich, dass noch keine Preisabfrage vorliegt. Vorbereitete Editionen erhalten eigene Preis-Tags und Abfragen, ohne die gemerkte Edition zu ändern. Die Länderübersicht sortiert nach Preis und hebt das Zielland optisch hervor. In der Bibliothek stehen Systemfilter und Sortierung nach Übernahmezeitpunkt oder Alphabet bereit.

Ab **0.5.0** verwendet KeyHunter einheitliche Navigation, Karten und Dialoge. Unter 960 CSS-Pixeln öffnet sich ein Spiel in einer eigenen Detailansicht. Größere Ansichten zeigen Liste und Detail nebeneinander.
