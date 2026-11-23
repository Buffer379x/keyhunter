# Reverse Proxy und HTTPS

Im Heimnetz läuft KeyHunter ohne Proxy über `http://<IP>:3000` (siehe [operations.md](operations.md)). Für den Zugriff von außen oder mit HTTPS im LAN setzt du einen Reverse Proxy davor. Der Proxy beendet TLS und leitet an `http://<KeyHunter>:3000` weiter. Die Beispiele unten verwenden `keyhunter.example.org` als Adresse.

## Was KeyHunter vom Proxy erwartet

Alle Angaben sind am Code geprüft (`config.rs`, `auth.rs`, `throttle.rs`).

| Thema | Verhalten |
|---|---|
| `KEYHUNTER_ORIGIN` | Die vollständige Adresse, unter der du KeyHunter im Browser öffnest: Schema, Host und bei nicht standardmäßigem Port der Port, **ohne Pfad**, ohne Zugangsdaten (`https://keyhunter.example.org`). Ein Schrägstrich am Ende wird entfernt. Ein ungültiger Wert verhindert den Start. Ist die Variable gesetzt, gilt genau diese eine Adresse; ist sie leer, vergleicht KeyHunter den `Origin` des Browsers mit dem `Host` der Anfrage, dann muss der Proxy den ursprünglichen `Host` unverändert weiterreichen. Mit gesetzter Variable ist der `Host` egal. |
| HTTPS | Ob Anmeldung und Änderungen über HTTP gehen, hängt von zwei Variablen ab (`auth.rs`, `checked_transport`): Mit `KEYHUNTER_ALLOW_INSECURE_HTTP=false` nie, dann ist auch eine `http://`-Adresse in `KEYHUNTER_ORIGIN` ein Startfehler. Mit dem Standard `true` und **leerer** `KEYHUNTER_ORIGIN` nur auf Heimnetz-Adressen: private IPv4 (`10.x`, `172.16–31.x`, `192.168.x`), IPv6 ULA (`fc…` und `fd…`), Loopback und lokale Namen (ohne Punkt wie `tower`, oder auf `.local`, `.lan`, `.home.arpa`, `.internal`); für jede andere Adresse, auch `100.x` von Tailscale, ist HTTPS nötig. Mit dem Standard `true` und **gesetzter** `KEYHUNTER_ORIGIN` gilt genau diese Adresse mit ihrem Schema, eine `http://`-Adresse also auch dann, wenn sie kein Heimnetz-Name ist. Das Sitzungscookie bekommt `Secure`, sobald der Browser über HTTPS kommt. Ein Pfad-Präfix (`/keyhunter`) wird nicht unterstützt: KeyHunter braucht eine eigene Adresse oder Subdomain. |
| `KEYHUNTER_TRUSTED_PROXY` | IP-Adresse oder CIDR-Bereich des Proxys, **so wie KeyHunter ihn sieht** (die Adresse der TCP-Verbindung), mehrere durch Komma getrennt (`172.18.0.0/16`). Ohne diese Angabe kommt jede Anfrage vom Proxy, und die Anmeldedrossel (5 Fehlversuche je Adresse in 15 Minuten) sperrt bei fünf Fehlversuchen von irgendwem alle. Nur Anfragen von einer vertrauten Adresse werden ausgewertet. |
| `X-Forwarded-For` | Für Anfragen von einer vertrauten Adresse liest KeyHunter den Header **von rechts**: die erste Adresse, die nicht selbst zum vertrauten Bereich gehört, zählt als Client. Weiter links stehende Einträge schreibt der Client und sie werden nicht beachtet. Ist ein Eintrag keine IP-Adresse, zählt der Proxy. Der Proxy muss den Header setzen oder ergänzen; die drei Beispiele tun das von sich aus. Trage nie Adressen ein, von denen auch andere Geräte direkt zugreifen. |
| HSTS | KeyHunter sendet **kein** `Strict-Transport-Security`. Setze es am Proxy (siehe unten). |
| Zeitlimits | Eine Anfrage endet nach 60 Sekunden, die Daten müssen innerhalb von 15 Sekunden vollständig ankommen. Stelle den Proxy auf mindestens 60 Sekunden Lese-Zeitlimit. Der Anfragekörper ist höchstens 16 KiB groß (der Import der Wunschliste 128 KiB, aber nur mit Sitzungscookie). WebSockets werden nicht benutzt. |

### Welche Adresse ist der Proxy?

Die Adresse, mit der der Proxy KeyHunter erreicht. Läuft der Proxy als Container im selben Docker-Netzwerk, ist es dessen Adresse oder besser das ganze Netz: `docker network inspect <Netzwerk>` zeigt das Subnetz (zum Beispiel `172.18.0.0/16`). Läuft der Proxy außerhalb von Docker und erreicht den veröffentlichten Port, sieht KeyHunter meist die Gateway-Adresse des Docker-Netzes (zum Beispiel `172.17.0.1`). Prüfe das, bevor du dich darauf verlässt: Nach dem Setzen der Variable dürfen fünf Fehlversuche von deinem Handy dein Notebook nicht aussperren.

### Was bricht, wenn die Adresse nicht passt

Die Seite lädt, aber **Einrichtung, Anmeldung und jede Änderung** antworten mit 403 und der Meldung „Anfrage abgewiesen: Die Adresse im Browser passt nicht zur App. Öffne KeyHunter über die IP-Adresse oder setze KEYHUNTER_ORIGIN auf die genutzte Adresse.“ (`code: forbidden`). Typische Ursachen:

- `KEYHUNTER_ORIGIN` nennt eine andere Adresse als die im Browser (Schema `http` statt `https`, ein anderer Host, ein fehlender Port).
- `KEYHUNTER_ORIGIN` ist leer, und der Proxy schreibt den `Host` um (zum Beispiel auf den Containernamen).
- Du erreichst KeyHunter über mehrere Adressen (Domain und IP); mit gesetzter Variable gilt nur eine.
- HTTP über eine Domain bei leerer `KEYHUNTER_ORIGIN`: dann sind nur Heimnetz-Adressen erlaubt, sonst ist HTTPS nötig.
- `KEYHUNTER_ALLOW_INSECURE_HTTP=false` und Zugriff über HTTP.

Nach einer Änderung an den Variablen startest du den Container neu.

## HSTS

HSTS sagt dem Browser, die Domain nur noch über HTTPS aufzurufen. Aktiviere es erst, wenn HTTPS auf der Domain dauerhaft funktioniert, und beginne mit einer kurzen Dauer (zum Beispiel `max-age=300`), bevor du auf ein Jahr (`31536000`) gehst. Lass `includeSubDomains` und `preload` weg, solange du nicht sicher bist, dass alle Subdomains HTTPS haben. Ein Zurück ist erst nach Ablauf der Dauer möglich.

## Caddy

Caddy reicht den `Host` unverändert weiter, setzt `X-Forwarded-For` selbst und holt Zertifikate automatisch.

```
keyhunter.example.org {
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy keyhunter:3000
}
```

KeyHunter (Compose, im selben Netzwerk wie Caddy, ohne veröffentlichten Port):

```yaml
services:
  keyhunter:
    environment:
      KEYHUNTER_ORIGIN: "https://keyhunter.example.org"
      KEYHUNTER_TRUSTED_PROXY: "172.18.0.0/16"   # das Docker-Netz von Caddy
    networks: [proxy]
networks:
  proxy:
    external: true
```

## Nginx Proxy Manager

Beim **Proxy Host**: Domain `keyhunter.example.org`, Scheme `http`, Forward-Hostname die IP des Unraid-Hosts oder der Containername (im selben Docker-Netz), Port `3000`. WebSockets brauchst du nicht. Reiter **SSL**: Zertifikat anfordern, **Force SSL** und **HTTP/2** an, **HSTS Enabled** erst nach einem Test mit HTTPS. NPM reicht den `Host` unverändert weiter und ergänzt `X-Forwarded-For`. Im Reiter **Advanced** brauchst du nichts, höchstens `proxy_read_timeout 60s;`, falls dein Standard kürzer ist.

Im KeyHunter-Container (Unraid: Container bearbeiten, Variable hinzufügen):

| Variable | Wert |
|---|---|
| `KEYHUNTER_ORIGIN` | `https://keyhunter.example.org` |
| `KEYHUNTER_TRUSTED_PROXY` | das Docker-Netz bzw. die Adresse von NPM, wie KeyHunter sie sieht (siehe oben) |

## Traefik

Traefik reicht den `Host` unverändert weiter und ergänzt `X-Forwarded-For`. Labels am KeyHunter-Container (Einstiegspunkt `websecure` und Zertifikatsauflöser `letsencrypt` heißen bei dir vielleicht anders):

```yaml
services:
  keyhunter:
    environment:
      KEYHUNTER_ORIGIN: "https://keyhunter.example.org"
      KEYHUNTER_TRUSTED_PROXY: "172.18.0.0/16"   # das Docker-Netz von Traefik
    networks: [proxy]
    labels:
      - traefik.enable=true
      - traefik.http.routers.keyhunter.rule=Host(`keyhunter.example.org`)
      - traefik.http.routers.keyhunter.entrypoints=websecure
      - traefik.http.routers.keyhunter.tls.certresolver=letsencrypt
      - traefik.http.routers.keyhunter.middlewares=keyhunter-hsts
      - traefik.http.middlewares.keyhunter-hsts.headers.stsSeconds=31536000
      - traefik.http.services.keyhunter.loadbalancer.server.port=3000
networks:
  proxy:
    external: true
```

## Prüfen

1. `curl -sI https://keyhunter.example.org/health/live` antwortet `200`; mit HSTS enthält die Antwort `strict-transport-security`.
2. Öffne `https://keyhunter.example.org` und melde dich an. Eine 403 mit „Anfrage abgewiesen“ heißt: Adresse und `KEYHUNTER_ORIGIN` prüfen.
3. Gib auf dem Handy fünfmal eine falsche Passphrase ein und melde dich danach am Notebook an: Das muss gehen. Wenn nicht, passt `KEYHUNTER_TRUSTED_PROXY` nicht zur Adresse des Proxys.
