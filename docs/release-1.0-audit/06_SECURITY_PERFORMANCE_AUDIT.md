# 06 – Security-, Performance- und Docker/Unraid-Audit (KeyHunter 0.9.1)

Prüfrolle: Application Security Engineer und Performance Engineer (Kürzel `sec`, Präfixe SEC/PERF). Stand: Commit 490a8fb (Tag 0.9.1), Branch `audit/release-1.0`, 2026-11-22.
Umfang: SPEC Abschnitt 9 (Security nach OWASP ASVS/Top 10) und 10 (Performance, Effizienz, Docker/Unraid). Der Scoring-Algorithmus (10A) steht in Dokument 11; hier nur Ressourcenverbrauch und Parallelität des Schedulers.

Kennzeichnung: **Bestätigt** = gemessen oder reproduziert; **Begründetes Risiko** = aus Code abgeleitet, nicht reproduziert; **Vorschlag** = subjektive Verbesserung. Rohdaten und Skripte: `docs/release-1.0-audit/evidence/security-performance/` (im Folgenden `ev/`).

## 1. Ergebnis in Kürze

| Bereich | Bewertung | Begründung |
|---|---|---|
| Security | **7/10** | Solide Grundlagen (Argon2id, gehashte Sitzungstokens, Origin + CSRF-Token + SameSite=Strict, strikte CSP, SSRF-gehärteter Shop-Client, Secrets write-only und 0600, rootloser Container ohne Capabilities). Abzüge: Verfügbarkeit der Anmeldung ist ohne Anmeldung angreifbar (SEC-01, SEC-02), keine Passphrasen-Rotation (SEC-03), Rust-Advisories ohne CI-Prüfung (SEC-04). |
| Performance | **6/10** | Leerlauf und kleine Listen sehr sparsam (25–36 MiB RAM, 0,2 % eines Kerns). Bei 500 Wünschen/2000 Links gemessen: quadratisch wachsende Statusabfrage (257 ms CPU je `/status/fetch`, PERF-01), 3-s-Polling von 300-KB-Badges bei normalem Abrufrückstand (PERF-02), keine Kompression und kein Asset-Caching (PERF-03/04), CLS 0,42 (PERF-05). |
| Docker-/Unraid-Integration | **7/10** | Multi-Stage, rootlos, `cap-drop`/read-only im Template, Rechteabgabe per `setpriv` verifiziert, Healthcheck, sauberer SIGTERM (≈0,4 s), automatische Sicherung vor Migration verifiziert. Abzüge: schweres Basisimage mit curl-Kette (SEC-05), keine Selbstheilung (PERF-13), ANSI-Logs, Template-/Doku-Lücken, kein Test auf echter Unraid-Installation (laut `docs/operations.md:29` offen). |

Die drei wichtigsten Erkenntnisse:
1. **PERF-01:** Das gebündelte SQLite 3.51.3 (libsqlite3-sys 0.37, unverändert seit mindestens 0.7.4; seit 0.9.0 ist die Wunschliste unbegrenzt) plant die harmlose Bedingung `EXISTS(SELECT 1 FROM wishlist_item w WHERE w.state='wished')` (`backend/src/jobs.rs:196`) pro Zeile. Bei 500 Wünschen kostet die Vorschau der nächsten Abrufe 204 ms statt ~2 ms, bei 250 Wünschen 51 ms – quadratisches Wachstum. Ein skalarer Ersatz misst 2,3 ms. Aufwand 1–3 h.
2. **SEC-01/SEC-02:** Ein beliebiger Client im Netz kann den Eigentümer aussperren – mit fünf falschen Passphrasen pro 15 Minuten (globale Drossel) oder mit 16 schweigenden Verbindungen an `POST /api/v1/session` (kein Body-/Idle-Timeout, 120 s Stille reproduziert).
3. **PERF-02–04:** Eine geöffnete Wunschliste mit 500 Wünschen lädt bei Abrufrückstand alle 3 s 301 KB unkomprimiert nach (15 Abrufe in 45 s, 4,2 MB). Kompression spart 88 %, schnelles Polling nur bei echten Nutzeraktionen den Rest.

## 2. Befundübersicht

| ID | Prio | Kurztitel | Aufwand | Ziel |
|---|---|---|---|---|
| PERF-01 | P1 | `ANY_ACTIVE_WISH` wird mit SQLite 3.51 quadratisch (Status 257 ms CPU, Claim 35 ms bei 500 Wünschen) | 1–3 h | 1.0 |
| SEC-01 | P2 | Globale Anmeldedrossel erlaubt Aussperren des Eigentümers | 3–6 h | 1.0 |
| SEC-02 | P2 | Keine Request-/Body-Timeouts: 16 hängende Requests blockieren den Login unbegrenzt | 1–3 h | 1.0 |
| SEC-03 | P2 | Keine Passphrasen-Änderung, kein „überall abmelden“, kein Wiederherstellungsweg | 4–8 h | 1.0 |
| SEC-04 | P2 | Zwei RustSec-Advisories (url, libsqlite3-sys); CI prüft Rust-Abhängigkeiten nicht | 1–3 h | 1.0 |
| PERF-02 | P2 | Preis-Badges werden bei Rückstand dauerhaft alle 3 s komplett geladen | 2–4 h | 1.0 |
| PERF-03 | P2 | Keine HTTP-Kompression (JSON −88 %, JS −70 % möglich) | 1–2 h | 1.0 |
| PERF-04 | P2 | Statische Dateien ohne `Cache-Control`; veraltete `index.html` nach Update möglich | 1 h | 1.0 |
| PERF-05 | P2 | Layout-Verschiebung beim Laden der Wunschliste (CLS 0,42) | 1–2 h | 1.0 |
| SEC-05 | P3 | Basisimage: 430 OS-Funde (1 CRITICAL, 104 HIGH, keiner behebbar), 45 % aus der Healthcheck-curl-Kette; 162 MB | 2–4 h | 1.1 |
| SEC-06 | P3 | Framework-Fehler als englischer Klartext mit Serde-Details, Body-Parsing vor Anmeldung | 1–2 h | 1.1 |
| SEC-07 | P3 | Reverse-Proxy-Betrieb: kein HSTS, keine Beispielkonfiguration | 1–2 h | 1.0 |
| SEC-08 | P3 | Benachrichtigungskanäle: bewusstes LAN-SSRF mit Reflexion von bis zu 200 Zeichen | 1 h | später |
| SEC-09 | P3 | Einrichtungscode bleibt nach der Einrichtung liegen | 0,5 h | 1.1 |
| SEC-10 | P3 | Supply Chain: Basisimages node/debian ohne Digest, kein Dependabot, kein SBOM/Signatur | 2–4 h | 1.1 |
| PERF-06 | P3 | Doppelte Requests und doppelte Badge-Berechnung beim ersten Laden | 2–4 h | 1.1 |
| PERF-07 | P3 | Abrufhistorie zählt auch ohne Filter über die volle Join-Kette (bis 126 ms) | 1 h | 1.1 |
| PERF-08 | P3 | Startarbeit wächst mit den Daten (0.6.0-Fingerabdruck-Upgrade bei jedem Start, N+1 in `attach`) | 1–3 h | 1.1 |
| PERF-09 | P3 | Eine Beobachtung je erfolgreichem Abruf, auch ohne Änderung (≈150 MB/Jahr bei vollem Budget) | 3–6 h | später |
| PERF-10 | P3 | Listen-Cover in `t_cover_big` (264×374) für ~36×48 px | 1–2 h | 1.1 |
| PERF-11 | P3 | Ein JS-Chunk 461 KB (140 KB gzip); Code-Splitting optional | 2–4 h | später |
| PERF-12 | P3 | Container-Log mit ANSI-Farbcodes und fast ohne Betriebsmeldungen | 0,5–1 h | 1.1 |
| PERF-13 | P3 | Healthcheck deckt nur Shop-Worker ab; keine Selbstheilung bei `unhealthy` | 2–3 h | 1.1 |
| PERF-14 | P3 | Unraid-Template und Betriebsdoku: Lücken und veraltete Angaben | 1–2 h | 1.0 |

Kein P0. Ein P1 (PERF-01), weil der Fehler mit der seit 0.9.0 unbegrenzten Wunschliste quadratisch wächst, der Scheduler die Abfrage innerhalb der Schreibtransaktion ausführt und die Korrektur klein und risikoarm ist.

## 3. Security

### 3.1 Bedrohungsmodell

Einzelnutzer-App, Standardbetrieb im LAN über HTTP (`KEYHUNTER_ALLOW_INSECURE_HTTP` ist ohne Angabe `true`, `backend/src/config.rs:33-37`), optional HTTPS über Reverse Proxy und damit aus dem Internet erreichbar. Unauthentifiziert erreichbar sind nur `/health/*`, `GET/POST /api/v1/setup`, `POST /api/v1/session` und die statischen Dateien. Relevante Angreifer: Geräte im LAN, bei Proxy-Betrieb das Internet, Webseiten im Browser des Eigentümers (CSRF, DNS-Rebinding).

### 3.2 Was trägt (bestätigt)

- **Passphrase:** Argon2id mit Standardparametern der `argon2`-Crate 0.5 (m=19 MiB, t=2, p=1), Salt aus 32 Zufallsbytes, höchstens vier parallele Berechnungen (`backend/src/auth.rs:224-241`, `lib.rs:249`). Länge 12–128 Zeichen.
- **Sitzungen:** 256-Bit-Token, in SQLite nur als SHA-256 (`auth.rs:142-143`), 12 h absolute Laufzeit, Logout löscht serverseitig, neues Token bei jeder Anmeldung (keine Session Fixation). Cookie `HttpOnly; SameSite=Strict; Max-Age=43200`, `Secure` sobald die geprüfte Origin HTTPS ist – reproduziert mit `Host`/`Origin` `https://kh.example.org` (`ev/auth_throttle_dos_release.txt`).
- **Einrichtung:** 256-Bit-Code in einer 0600-Datei, konstanter Vergleich, atomarer Singleton-Owner (`ON CONFLICT DO NOTHING`), danach 409.
- **CSRF/Origin:** Jede schreibende Route verlangt Sitzung, `X-CSRF-Token` (konstanter Vergleich) und eine einzelne `Origin`, die zum empfangenen `Host` passt; `Sec-Fetch-Site` muss, falls vorhanden, `same-origin` sein; Forwarded-Header werden ignoriert. Matrix aus 13 Fällen in `ev/security_probes_fixture.txt`: alle Abweichungen 403, HTTP nur für private IPs, Loopback und lokale Namen (`tower`, `.lan` …), öffentliche Namen/IPs über HTTP 403. DNS-Rebinding scheitert, weil der Angreifernamen weder lokal ist noch das Cookie erhält.
- **Autorisierung:** Alle 48 API-Handler in `lib.rs:261-326` geprüft: lesende rufen `auth::authenticate`, schreibende zusätzlich `auth::require_csrf` (bei `test_channel` über `notify.rs:1121-1123`). Ausnahmen nur Setup, Login, Health. Einzelnutzer, daher keine Objekt-Autorisierung nötig.
- **CORS:** keine CORS-Schicht; Preflight 405, keine `Access-Control-*`-Header.
- **Header** (alle Antworten, `lib.rs:362-384`): CSP `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://images.igdb.com; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Permissions-Policy`; API und Health zusätzlich `Cache-Control: no-store`. Im Browser keine CSP-Verletzung und keine Konsolenfehler (`ev/browser_console_requests_release.json`).
- **XSS:** kein `dangerouslySetInnerHTML`/`innerHTML` im Frontend, externe Links mit `rel="noopener noreferrer"`, Link-Ziele stammen aus validierten Shop-URLs. Ein gespeicherter Titel `<img src=x onerror=…><script>…</script>` erscheint als Text, kein `<img src="x">`, kein Dialog (`ev/xss_manual_title_rendered_as_text.png`). Benachrichtigungen escapen HTML (Telegram, E-Mail) bzw. Markdown (Discord, Gotify), Discord ohne Mentions (`notify.rs:636-660`, `797-812`).
- **SQL:** Alle Werte gebunden. Die `format!`/`AssertSqlSafe`-Stellen (`jobs.rs`, `eventlog.rs:118`, `224-234`) setzen nur Konstanten zusammen; LIKE-Muster werden escaped (`eventlog.rs:169-182`). Probe `'%20OR%201=1--` → 404.
- **SSRF Shop-Client** (`backend/src/shops/http.rs:55-113`, `195-226`): nur HTTPS auf festen Hosts ohne Port/Zugangsdaten, DNS-Auflösung einmal und gepinnt, alle Adressen müssen öffentlich sein, keine Redirects, Größenlimit, robots.txt und Crawl-Delay, Abfrage-Parameter nur für die Eneba-Suche. Manuelle Produktlinks nur nach Shop-Muster (`shops/mod.rs:47-75`). IGDB/Twitch feste HTTPS-Endpunkte ohne Redirects (`catalog/provider.rs:143-156`), Cover-IDs validiert.
- **Path Traversal:** `ServeDir` lehnt alle acht Traversal-Varianten ab (404, kein Inhalt), Datendateien haben feste Namen, Sicherungsnamen sind generiert.
- **Secrets:** IGDB-Zugang und Kanal-Secrets atomar als 0600-Datei (`lib.rs:117-139`), beim Lesen werden Dateien mit Gruppen-/Weltrechten oder Symlinks ignoriert (`notify.rs:397-409`). Die API meldet nur `true/false` je Secret; der Test-Token stand weder in `keyhunter.db` noch im WAL; Fehlertexte werden um Secrets bereinigt (`notify.rs:786-795`). Tracing-Ausgaben enthalten keine Secrets (alle 13 `tracing::*`-Aufrufe geprüft); das Event-Log nennt Kanäle ohne URL/Token.
- **Container:** Image-Standard UID 10001; Compose und Template mit `cap-drop ALL`, `no-new-privileges`, read-only und tmpfs. Im Unraid-Modus läuft PID 1 nach `setpriv` als 10001 mit allen Capability-Sets 0 und `NoNewPrivs: 1` (`ev/docker_runtime_measurements.txt`).
- **CI:** Actions per Commit-SHA gepinnt, `permissions: contents: read` bzw. zusätzlich `packages: write` nur im Publish-Workflow, `persist-credentials: false`, Unraid-Template wird vor dem Push gegen das Image geprüft (`.github/workflows/container.yml:68-72`).

### 3.3 Befunde Security

#### SEC-01 · P2 · Globale Anmeldedrossel erlaubt Aussperren des Eigentümers
- **Kategorie:** Authentifizierung / Verfügbarkeit (ASVS V2.2.1). **Status:** Bestätigt.
- **Beschreibung:** `auth_throttle` ist eine einzige Zeile für alle Clients: fünf Versuche je 15 Minuten, gezählt vor der Prüfung der Passphrase (`backend/src/auth.rs:113-132`, `276-277`). Danach erhält auch die richtige Passphrase 429.
- **Nachweis:** `ev/auth_throttle_dos_release.txt`: Versuche 1–5 → 401, 6–7 → 429, korrekte Passphrase → 429 mit `Retry-After: 900`, ebenso mit anderem `X-Forwarded-For`; bestehende Sitzung bleibt gültig.
- **Ursache:** Schutz gegen verteiltes Raten ohne Quellbezug.
- **Auswirkung:** Wer `POST /api/v1/session` erreicht (LAN, bei Proxy-Betrieb das Internet), sperrt mit fünf Requests pro Viertelstunde den Eigentümer dauerhaft aus; laufende Sitzungen enden spätestens nach 12 h. Brute Force bleibt dagegen gut begrenzt (≤480 Versuche/Tag).
- **Verbesserung:** Zweistufig: Zähler je Peer-Adresse (5/15 min, im Speicher, `ConnectInfo`) plus globale Obergrenze deutlich höher (z. B. 100/15 min). Hinter einem Proxy alle Requests von derselben Adresse: optional `KEYHUNTER_TRUSTED_PROXY` für `X-Forwarded-For` dokumentieren, sonst gilt die Proxy-Adresse als eine Quelle (Verhalten wie heute).
- **Aufwand:** 3–6 h. **Risiko:** niedrig–mittel (Testfälle für Proxy-Betrieb nötig). **Ziel:** 1.0.
- **Einstufung des Leads für die Roadmap:** **P1**. Der Lead hat den Befund im Code nachgeprüft (`auth.rs:114`: eine Zeile `id = 1` für alle Clients). Eine 1.0 soll laut Betriebsdoku hinter einem Reverse Proxy mit HTTPS laufen, also unter Umständen aus dem Internet erreichbar sein. Dort ist eine Aussperrung mit fünf Requests nicht vertretbar. Im reinen Heimnetz bleibt es P2.

#### SEC-02 · P2 · Keine Request-/Body-Timeouts: hängende Requests blockieren den Login
- **Kategorie:** API-Missbrauch / Verfügbarkeit. **Status:** Bestätigt.
- **Beschreibung:** `ConcurrencyLimitLayer::new(16)` (`backend/src/lib.rs:342`) wirkt je Route (nicht global) und wartet statt abzuweisen; `axum::serve` läuft ohne Timeouts (`backend/src/main.rs:17-19`). Der JSON-Extractor hält den Slot, bis der Body vollständig ist.
- **Nachweis:** `ev/auth_throttle_dos_release.txt` und `ev/scripts/slowbody*.py`: 16 Verbindungen senden Header und `{` eines 15-KB-Bodys an `POST /api/v1/session` und schweigen. Ein 17. Login läuft nach 12 s bzw. nach 120 s Stille in den Timeout, der Server schließt keine der 16 Verbindungen. Andere Routen (`/health/*`, `/api/v1/setup`, `/`) antworten weiter – der Healthcheck bleibt grün.
- **Auswirkung:** Ein nicht angemeldeter Client blockiert Anmeldung (oder jede andere POST/PUT-Route) beliebig lange. Ein Reverse Proxy mit Request-Buffering (nginx-Standard) dämpft das; direkter LAN-Zugriff nicht.
- **Verbesserung:** `tower_http::timeout::RequestBodyTimeoutLayer` (z. B. 10 s) und `TimeoutLayer` (z. B. 60 s, länger als IGDB-Timeout 10 s × Retry) vor die Router-Schichten; optional `load_shed` mit 503 statt Warten.
- **Aufwand:** 1–3 h. **Risiko:** niedrig. **Ziel:** 1.0.

#### SEC-03 · P2 · Keine Passphrasen-Änderung, kein „überall abmelden“, kein Wiederherstellungsweg
- **Kategorie:** Authentifizierung / Sitzungsverwaltung (ASVS V2.1.5, V3.3.3). **Status:** Bestätigt (Routen und Doku).
- **Beschreibung/Nachweis:** Die API kennt nur `setup`, `session` (POST/DELETE) und `me` (`lib.rs:262-264`); weder Oberfläche noch `docs/` beschreiben eine vergessene Passphrase.
- **Auswirkung:** Eine bekannt gewordene Passphrase lässt sich nicht ändern, Sitzungen eines verlorenen Geräts nicht beenden (bis 12 h). Bei vergessener Passphrase bleibt nur ein manueller Eingriff in die Datenbank, für den das Image kein Werkzeug enthält.
- **Verbesserung:** (a) `PUT /api/v1/session/passphrase` mit alter und neuer Passphrase, löscht alle anderen Sitzungen; (b) Knopf „Alle anderen Sitzungen beenden“ unter Einstellungen › System; (c) Wiederherstellung per Startoption (z. B. `--reset-owner` im Entrypoint: löscht `owner` und damit per Cascade alle Sitzungen, erzeugt einen neuen Einrichtungscode, Daten bleiben) und in `docs/operations.md` beschreiben.
- **Aufwand:** 4–8 h. **Risiko:** niedrig. **Ziel:** 1.0.

#### SEC-04 · P2 · Bekannte Rust-Advisories, CI prüft Rust-Abhängigkeiten nicht
- **Kategorie:** Dependency-Schwachstellen / Supply Chain. **Status:** Bestätigt (zwei Scanner).
- **Nachweis:** `ev/osv_scanner_lockfiles.txt` und `ev/cargo_audit.txt` (cargo-audit 0.23.0, 1560 Advisories): `url` 2.5.8 – RUSTSEC-2026-0592 (Stack-Overflow in `Url::origin()` bei verschachtelten `blob:`-URLs, behoben in 2.5.9); `libsqlite3-sys` 0.37.0 – RUSTSEC-2026-0459/CVE-2026-119375 (CVSS 6.8, uninitialisierter Page-Cache bei präparierten DB+WAL-Dateien, behoben ab 0.39.0/SQLite 3.54). `npm audit` (prod und alle) 0 Funde. `.github/workflows/checks.yml:30-31` prüft nur npm.
- **Erreichbarkeit:** `url`: KeyHunter ruft `origin()` nur für bereits als http/https erkannte URLs auf (`config.rs:61` prüft das Schema vorher, `auth.rs:61`). Probe mit 50 KB verschachteltem `blob:`-Origin → 403, Container läuft weiter. SQLite-CVE: lokaler Vektor, setzt Schreibzugriff auf das Datenverzeichnis voraus. Beide derzeit nicht ausnutzbar.
- **Verbesserung:** `cargo update -p url`; `libsqlite3-sys` mit dem nächsten sqlx-Release anheben (ob sqlx 0.9.x bereits 0.39 erlaubt, nicht geprüft – kein Internetzugriff auf crates.io-Metadaten). CI: Schritt `cargo audit` (oder osv-scanner) in `checks.yml`, Dependabot für cargo, npm, github-actions und docker.
- **Aufwand:** 1–3 h (+ sqlx-Update unbekannt). **Risiko:** niedrig. **Ziel:** 1.0.

#### SEC-05 · P3 · Schweres Basisimage mit CVE-Ballast aus dem Healthcheck-curl
- **Kategorie:** Container / Angriffsfläche (auch Image-Größe). **Status:** Bestätigt.
- **Nachweis:** `ev/trivy_image_keyhunter_0.9.1_summary.txt`: Debian 12.15, 106 Pakete, 430 Funde (1 CRITICAL `zlib1g` CVE-2023-45853 in minizip, 104 HIGH), für keinen ein Fix verfügbar. 193 Funde (67 HIGH) stammen aus der curl-/Kerberos-/LDAP-/OpenSSL-Kette, die nur für den Healthcheck installiert wird (`Dockerfile:15`, `deploy/docker-entrypoint.sh:14-20`). Größe 162 MB (Layer: 85 MB Debian, 15 MB apt, 16,6 MB Binary, 3,5 MB Frontend), 41,7 MB komprimiert.
- **Auswirkung:** Kein von KeyHunter genutzter Pfad (Binary nutzt rustls und gebündeltes SQLite), aber Scanner auf Unraid/NAS melden das Image rot; unnötige Angriffsfläche.
- **Verbesserung:** Healthcheck ins Binary (`keyhunter --healthcheck`: HTTP-GET auf `127.0.0.1:3000/health/ready`), curl entfernen; Basis auf `debian:trixie-slim` heben (`util-linux` für `setpriv`/`mountpoint` bleibt nötig, distroless erst wenn der Entrypoint in Rust liegt).
- **Aufwand:** 2–4 h. **Risiko:** mittel (Healthcheck- und Unraid-Init-Pfad neu testen; `deploy/check-unraid-data.py` deckt das ab). **Ziel:** 1.1.

#### SEC-06 · P3 · Uneinheitliche Fehlerantworten vor der Anmeldung
- **Kategorie:** Fehlerbehandlung. **Status:** Bestätigt.
- **Nachweis:** `ev/security_probes_fixture.txt`: ohne Sitzung `POST /api/v1/wishlist` mit falschem Body → 422 „Failed to deserialize the JSON body … missing field `platform_id`“; 413/415/400 ebenfalls englischer Klartext statt `{"error","code"}`. Ursache: `Json<T>`-Extractor läuft vor `auth::authenticate` (z. B. `wishlist.rs` `add`).
- **Auswirkung:** Gering (Schema ist öffentlich), aber Frontend und Skripte bekommen zwei Fehlerformate; Body wird vor der Anmeldung geparst (16 KB Limit begrenzt die Kosten).
- **Verbesserung:** Rejections zentral in `ApiError` übersetzen, wie es `notify::put_channel` bereits tut (`notify.rs:1067-1072`).
- **Aufwand:** 1–2 h. **Risiko:** niedrig. **Ziel:** 1.1.

#### SEC-07 · P3 · Reverse-Proxy-Betrieb ohne HSTS und ohne Beispielkonfiguration
- **Kategorie:** Unsichere HTTP-Konfiguration / Doku. **Status:** Bestätigt (Header, Doku).
- **Beschreibung:** Kein `Strict-Transport-Security` (`lib.rs:362-384`); `docs/operations.md:21` erklärt die Host-Erhaltung in zwei Sätzen ohne Beispiel. Positiv: ein Proxy, der `Host` umschreibt, führt zu einer klaren 403-Meldung mit Hinweis auf `KEYHUNTER_ORIGIN`.
- **Verbesserung:** Beispiele für Nginx Proxy Manager, Caddy und Traefik (Host erhalten, HSTS, Request-Buffering) in die Doku; optional HSTS senden, wenn `KEYHUNTER_ORIGIN` eine HTTPS-Origin ist. Vorschlag: Cookie-Name `__Host-keyhunter_session` bei HTTPS.
- **Aufwand:** 1–2 h. **Risiko:** niedrig. **Ziel:** 1.0 (Doku).

#### SEC-08 · P3 · Benachrichtigungskanäle als bewusstes LAN-SSRF mit Antwort-Reflexion
- **Kategorie:** SSRF. **Status:** Bestätigt (lokaler Mock, `ev/notification_ssrf_webhook_fixture.txt`).
- **Beschreibung:** Der Eigentümer kann ntfy-, Gotify- und Webhook-Ziele im LAN und auf Loopback setzen (gewollt für selbst gehostete Dienste); Secrets gehen über HTTP nur an lokale Ziele, Link-Local (169.254.0.0/16) wird abgelehnt. Bei Fehlern übernimmt `notify.rs:716-728` bis zu 200 Zeichen aus `description`/`message`/`errorDescription`/`error` der Zielantwort in API-Antwort und Event-Log.
- **Auswirkung:** Nur für den angemeldeten Eigentümer; erlaubt Port-Scan und begrenztes Auslesen von JSON-Fehlertexten interner Dienste. Im Container ist Loopback der Container selbst.
- **Verbesserung:** Doku-Hinweis; Reflexion auf bekannte Anbieter (Telegram, Discord, Pushover, ntfy.sh) beschränken, sonst nur Statuscode. Loopback ohne Nutzen im Container – ablehnen.
- **Aufwand:** 1 h. **Risiko:** niedrig. **Ziel:** später.

#### SEC-09 · P3 · Einrichtungscode bleibt nach der Einrichtung liegen
- **Kategorie:** Secret Management. **Status:** Bestätigt (`ls` nach Setup; `lib.rs:210-233`).
- **Auswirkung:** Gering: der Code wirkt nur, solange kein Owner existiert. Wird der Owner manuell gelöscht (Wiederherstellung), gilt der alte Code weiter.
- **Verbesserung:** Datei nach erfolgreicher Einrichtung löschen; bei leerem Owner wird ohnehin eine neue erzeugt. Zusammen mit SEC-03 (c) umsetzen.
- **Aufwand:** 0,5 h. **Risiko:** niedrig. **Ziel:** 1.1.

#### SEC-10 · P3 · Supply-Chain-Härtung unvollständig
- **Kategorie:** Supply Chain. **Status:** Bestätigt.
- **Beschreibung:** `node:24.22.1-bookworm-slim` und `debian:bookworm-slim` ohne Digest (`Dockerfile:2`, `:14`; Rust ist gepinnt), kein Dependabot/Renovate (`.github/` enthält nur Workflows), kein SBOM, keine Provenance oder Signatur beim Push (`container.yml:68-73`), Binary ohne `cargo auditable` (Trivy sieht keine Rust-Pakete). Lokales `keyhunter:0.9.1` (715fe9f67a2a) und GHCR-`0.9.1` (42f20690292b) haben verschiedene Image-IDs – Builds sind nicht reproduzierbar.
- **Verbesserung:** Digests pinnen und per Dependabot aktualisieren; `docker buildx build --sbom=true --provenance=mode=max`; `cargo auditable build`.
- **Aufwand:** 2–4 h. **Risiko:** niedrig. **Ziel:** 1.1.

Akzeptierte Designentscheidung (kein Befund): HTTP-Anmeldung im LAN ist Standard und dokumentiert (`docs/operations.md:19`); die Oberfläche zeigt einen HTTPS-Hinweis (`frontend/src/features/SettingsPage.tsx:19-20`, `:55`).

## 4. Performance

### 4.1 Messaufbau

- **Daten:** 500 Wünsche über die API angelegt (`ev/scripts/seed_wishes.py`, Median 4,0 ms je POST), danach bei gestopptem Server synthetisch je Wunsch 4 Links (Eneba EU/Global/Türkei, Driffle EU) mit 60 Beobachtungen im 8-h-Takt, 30 000 Job-Läufe, 1 500 Log-Einträge (`ev/scripts/seed_offers.py`): 2 000 Links, 120 000 Beobachtungen, DB 51,7 MB.
- **Instanzen:** Fixture (Debug-Build, keine Hintergrundjobs) auf 38784; Produktions-Image `keyhunter:0.9.1` auf 38794 mit einer Kopie derselben Daten, DNS im Container auf 127.0.0.1 und alle Shop-/IGDB-Hosts per `--add-host` auf 127.0.0.1 – nachweislich keine externe Anfrage (Eneba-Worker meldete `access_denied` und pausierte).
- **Störgröße:** Auf dem Host liefen parallel Browser-Tests anderer Prüfer (Load ≈ 3,9 auf 8 Kernen). Latenzen schwanken deshalb; die CPU-Zeit je Request (cgroup `cpu.stat`, `ev/scripts/cpu_per_request.py`) ist die belastbarere Größe.

### 4.2 Endpunkte (Release-Image, 500 Wünsche, 2 000 Links)

| Endpunkt | CPU je Request (Mittel aus 20) | Median-Latenz | Antwort | SQL im Einzelaufruf (sqlx-Log) |
|---|---|---|---|---|
| `GET /api/v1/status/fetch` | **256,6 ms** | 254,9 ms | 7,0 KB | 204,5 ms in einer Abfrage (PERF-01) |
| `GET /api/v1/wishlist` | 124,4 ms | 99,9 ms | 441,8 KB | 65,4 ms (8 Statements, inkl. Badges) |
| `GET /api/v1/wishlist/price-badges` | 114,7 ms | 80,4 ms | 301,5 KB | 37,2 ms (Trend aus Cache) |
| `GET /api/v1/status/fetch/runs?per_page=50` | 89,8 ms | 92,9 ms | 10,1 KB | 126,3 ms im COUNT (PERF-07) |
| `… /runs?q=Perf%20Halo` (LIKE) | 107,3 ms | 94,2 ms | 10,0 KB | – |
| `GET /api/v1/wishlist/{id}/offers` (9 Angebote) | 9,8 ms | 7,5 ms | 31,1 KB | – |
| `GET /api/v1/cart` | 4,0 ms | 4,8 ms | 2 B | – |
| `GET /api/v1/log?per_page=50` | 2,4 ms | 1,1 ms | 6,0 KB | – |

Quellen: `ev/cpu_per_request_release.json`, `ev/timing_release_500_wishes_2000_links.json`, `ev/sqlx_statement_breakdown_release.txt`; Debug-Vergleich ohne Angebote in `ev/timing_fixture_debug_500_wishes_no_offers.json` (`/wishlist` 66 ms, `/status/fetch` 61 ms) und mit Angeboten in `ev/timing_fixture_debug_500_wishes_2000_links.json` (`/wishlist` 281 ms, `/status/fetch` 378 ms).
Last: 256 × `/wishlist` mit 64 parallelen Clients in 7,4 s (≈35 req/s), p95 1,9 s, Speicher-Peak 116 MB (`ev/docker_runtime_measurements.txt`).

### 4.3 Abfragepläne und Indizes

`ev/query_plans_sqlite_3.46.1.txt` (python3) und `ev/query_plans_sqlite_3.53.4.txt` (node:sqlite), gleiche Datenbank:
- **Wunschliste (0.9.1, `offer_count`/`review_count` je Zeile, `wishlist.rs:38`):** zwei korrelierte Unterabfragen, beide über `offer_link_wish`; 4,8–5,9 ms für 500 Zeilen. Kein Handlungsbedarf.
- **Badges:** `links_of_items` 8 ms (Index `offer_link_wish`, `shop_job.link_id`), Trend-Stichproben bei Cache-Miss 20–23 ms ausschließlich über den Covering-Index `price_history`; der `TrendCache` (`price_badges.rs:128-173`) vermeidet die Abfrage bei Folgeaufrufen. Gut gelöst.
- **Scheduler-Poll (`claimable`, alle 3 s je Shop):** < 0,1 ms über `shop_job_schedule`.
- **Abrufhistorie mit LIKE:** Seite 2 ms über `job_run_recent`; der COUNT scannt alle 30 000 Läufe mit vier Joins (27–35 ms standalone, 126 ms im Container) → PERF-07.
- **Vorschau `upcoming` und Claim:** Unter SQLite 3.46 2,1 ms bzw. 0,4 ms, unter 3.53 248 ms bzw. 34,6 ms; der Plan enthält zusätzlich `SEARCH w EXISTS USING COVERING INDEX wishlist_item_state` → PERF-01.
- **Indizes:** Alle heißen Pfade haben passende Indizes; fehlende oder überflüssige Indizes wurden nicht gefunden. N+1 nur beim Start (PERF-08).

### 4.4 Scheduler (Ressourcen, Parallelität)

- Ein Worker je Shop (`jobs.rs:139-168`): nach einem Job 2 s, sonst 3 s Pause, bei DB-Fehler 10 s. Alarm-Outbox alle 3 s (`alerts.rs:412-421`), Editionsvorbereitung alle 10 s (`edition_tracking.rs:137-160`).
- Parallelität: höchstens ein laufender Request je Shop-Host – Session-Mutex und Crawl-Delay (`shops/http.rs:29-80`); manuelle Aktualisierungen laufen über dieselbe Warteschlange (`offers.rs` `refresh` setzt nur `requested_at`). Keine unbegrenzte Parallelität.
- Leerlauf-CPU 0,24 % (leer) bzw. 0,225 % (500 Wünsche) eines Kerns inklusive Healthcheck alle 30 s; RAM 25,5 bzw. 36,2 MiB, 13 Threads.
- Bei 500 Wünschen meldet `/status/fetch` einen Tagesbedarf von 4 572 Abrufen bei einem Budget von 500 – der Rückstand ist dann Dauerzustand (relevant für PERF-02; Bewertung des Budgets in Dokument 11).

### 4.5 Frontend

- **Bundle** (`ev/frontend_bundle_sizes.txt`): ein JS-Chunk 461 KB (140 KB gzip; react-dom ≈ 59 % des Quelltexts), CSS 63 KB (12,9 KB gzip), drei woff2-Schriften 91 KB, 271 Flaggen-SVGs als einzelne Dateien (nur benutzte werden geladen).
- **Erstes Laden, 500 Wünsche, Release** (`ev/browser_first_load_release_500_wishes.json`): 23 Requests (1 JS, 1 CSS, 3 Fonts, 2 Flaggen, 15 API), FCP 96 ms, LCP 280 ms (200 pro Seite: 488 ms), DOMContentLoaded 75 ms, „Liste bereit inkl. networkidle“ 1,1 s, JS-Heap 10–14 MB, DOM 2 850 Knoten bei 50 Zeilen bzw. 10 458 bei 200 (≈52 Knoten je Zeile), **CLS 0,42**.
- **Netzwerk im Betrieb:** 45 s geöffnete Wunschliste mit ausstehenden Abrufen (Fixture): 15 × `price-badges`, 4,2 MB. Ohne ausstehende Abrufe (Release, Shop pausiert): 2 × `price-badges` + 2 × `status/fetch` in 60 s, 617 KB. Abrufstatus-Seite: `status/fetch` und `runs` alle 30 s.
- **Cover:** `loading="lazy"`, `decoding="async"`, `referrerPolicy="no-referrer"`, feste Boxgröße per CSS (kein CLS durch Bilder). Größenwahl siehe PERF-10 (ohne IGDB-Zugriff nicht gemessen).

### 4.6 Notwendig vs. Feintuning

- **Notwendig vor 1.0:** PERF-01 (quadratisch, Schreibsperre), PERF-02 (Dauerlast je offenem Tab), PERF-03/04 (einfache Server-Schichten, hoher Nutzen; PERF-04 verhindert leere Seiten nach Updates), PERF-05 (CLS „schlecht“ nach Web Vitals).
- **Feintuning:** PERF-06 bis PERF-11. Die SQL-Basis (Indizes, Trend-Cache, gebündelte Badge-Abfragen) ist gut; ein Umbau ist nicht angezeigt.

### 4.7 Befunde Performance

#### PERF-01 · P1 · `ANY_ACTIVE_WISH` wird mit SQLite 3.51 quadratisch
- **Kategorie:** Datenbank / Skalierung. **Status:** Bestätigt.
- **Beschreibung:** `queued()` (`backend/src/jobs.rs:202-206`) enthält die unkorrelierte Bedingung `ANY_ACTIVE_WISH` (`jobs.rs:196`). SQLite 3.46 wertet sie einmal aus; das gebündelte SQLite 3.51.3 (libsqlite3-sys 0.37) – ebenso 3.53 – macht daraus einen EXISTS-Join je Zeile von `shop_job ⨝ offer_link ⨝ wishlist_item`.
- **Nachweis:** `ev/query_any_active_wish_regression.txt`: Vorschau-Abfrage (`jobs.rs:1218-1231`) 248 ms bei 500 Wünschen, 51 ms bei 250 (Faktor 4,9 bei doppelter Menge), mit skalarem Ersatz 2,3 ms; Claim-Auswahl (`jobs.rs:284-306`) 34,6 ms statt 0,4 ms. Im Produktions-Binary 204,5 ms für diese eine Abfrage (sqlx-Log), `/status/fetch` 256,6 ms CPU.
- **Auswirkung:** `/status/fetch` wird von Seitenleiste und Wunschlisten-Kachel je 60 s und auf der Abrufstatus-Seite alle 30 s abgefragt. Bei 1 000 Wünschen ≈ 1 s je Aufruf (quadratisch extrapoliert, nicht gemessen). Der Claim läuft in der Schreibtransaktion (`jobs.rs:282-310`) und blockiert andere Schreiber entsprechend länger.
- **Verbesserung:** `ANY_ACTIVE_WISH` als skalaren Ausdruck formulieren, z. B. `(SELECT 1 FROM wishlist_item WHERE state='wished' LIMIT 1) IS NOT NULL`, oder einmal in Rust prüfen und die Bedingung weglassen. Regressionstest mit ≥500 synthetischen Wünschen, der die Laufzeit oder per `EXPLAIN QUERY PLAN` das Fehlen von `SEARCH w EXISTS` prüft – SQLite-Updates ändern Pläne unbemerkt.
- **Aufwand:** 1–3 h. **Risiko:** niedrig (gleiche Semantik). **Ziel:** 1.0.

#### PERF-02 · P2 · Preis-Badges bei Abrufrückstand dauerhaft im 3-s-Takt
- **Kategorie:** Frontend-Polling / Netzwerk. **Status:** Bestätigt (Fixture), Dauerzustand begründet.
- **Beschreibung:** Die Wunschliste lädt alle Badges alle 3 s, solange irgendein Badge `pending` ist (`frontend/src/features/Wishlist.tsx:158-165`). `pending` ist wahr, sobald ein Job des Wunschs fällig oder geleast ist und das Tagesbudget nicht erschöpft ist (`backend/src/price_badges.rs:258-262`); Pacing wird nicht berücksichtigt.
- **Nachweis:** `ev/browser_cls_polling_fixture_500_wishes.json`: 15 Abrufe in 45 s, 4,2 MB. Je Abruf 301,5 KB und 114,7 ms CPU (Release). Rückstand entsteht ab ≈170 Produktlinks je Shop bei 8-h-Intervall und 500 Jobs/Tag; im Testdatensatz 4 572 Bedarf zu 500 Budget.
- **Auswirkung:** Je sichtbarem Tab ≈ 20 Abrufe/min → ≈ 2,3 s CPU/min (≈ 3,8 % eines Kerns) und ≈ 6 MB/min (≈ 360 MB/h) unkomprimiert, dauerhaft.
- **Verbesserung:** Schnelles Polling nur für direkte Nutzeraktionen (`requested_at` im 15-min-Fenster, `initial=1`, aktiver Lease); sonst 60 s. Optional nur geänderte Badges liefern (`?since=`).
- **Aufwand:** 2–4 h. **Risiko:** niedrig. **Ziel:** 1.0.

#### PERF-03 · P2 · Keine HTTP-Kompression
- **Kategorie:** Netzwerk. **Status:** Bestätigt.
- **Nachweis:** Kein `Content-Encoding` trotz `Accept-Encoding: gzip, br` (`ev/security_probes_fixture.txt`); gzip spart bei `/wishlist` 88 % (441,8 → 53,7 KB), bei Badges 87 %, beim JS 70 % (`ev/frontend_bundle_sizes.txt`). `tower-http` ist nur mit Feature `fs` eingebunden (`backend/Cargo.toml`).
- **Verbesserung:** `tower_http::compression::CompressionLayer` (gzip/br) mit Mindestgröße; für Assets alternativ vorkomprimierte Dateien und `ServeDir::precompressed_gzip()`.
- **Aufwand:** 1–2 h. **Risiko:** niedrig. **Ziel:** 1.0.

#### PERF-04 · P2 · Statische Dateien ohne `Cache-Control`
- **Kategorie:** Caching / Update-Verhalten. **Status:** Header bestätigt; leere Seite nach Update begründetes Risiko (nicht reproduziert).
- **Beschreibung:** `ServeDir` liefert nur `ETag`/`Last-Modified` (`backend/src/lib.rs:337-340`). Browser dürfen `index.html` heuristisch bis zu 10 % ihres Alters ohne Rückfrage verwenden. Nach einem Image-Update verweist eine so gecachte `index.html` auf nicht mehr vorhandene `/assets/index-<hash>.js`; der Server antwortet 404 mit `text/html`, das `nosniff` als Skript blockiert → leere Seite bis zum Neuladen. Hash-Assets werden umgekehrt bei jedem Laden revalidiert.
- **Verbesserung:** `Cache-Control: no-cache` für `index.html`, SPA-Fallback und Manifest; `public, max-age=31536000, immutable` für `/assets/*`.
- **Aufwand:** 1 h. **Risiko:** niedrig. **Ziel:** 1.0.

#### PERF-05 · P2 · Layout-Verschiebung beim Laden der Wunschliste (CLS 0,42)
- **Kategorie:** Frontend-Rendering. **Status:** Bestätigt.
- **Nachweis:** `ev/browser_first_load_release_500_wishes.json` (CLS 0,4194, Shifts bei 266/395 ms); Quellen laut `ev/browser_cls_polling_fixture_500_wishes.json`: `section.panel` springt von y=146 auf y=270, weil die KPI-Kacheln erst mit `ready && items.length > 0` erscheinen (`frontend/src/features/Wishlist.tsx:412`); kleiner Shift des Abrufstatus in der Seitenleiste (`div.side-foot`).
- **Verbesserung:** Kachelzeile mit fester Höhe als Platzhalter rendern, solange `!ready`; Höhe der Abrufstatus-Karte reservieren.
- **Aufwand:** 1–2 h. **Risiko:** niedrig. **Ziel:** 1.0. (Überschneidung mit dem UI-/Responsive-Audit möglich.)

#### PERF-06 · P3 · Doppelte Requests und doppelte Badge-Berechnung beim ersten Laden
- **Kategorie:** Unnötige Netzwerk-/DB-Abfragen. **Status:** Bestätigt.
- **Nachweis:** `ev/browser_console_requests_release.json`: `status/fetch` 2×, `alerts` 3×, `library` 2×, `cart` 2×. `/wishlist` liefert bereits Badges (`backend/src/wishlist.rs:91`, `110-118`), direkt danach lädt das Frontend `/wishlist/price-badges` (`Wishlist.tsx:158-165`) – 124 + 115 ms CPU und 742 KB für dieselbe Information. Zwei unabhängige `status/fetch`-Poller (`frontend/src/FetchStatus.tsx:47`, `Wishlist.tsx:181`).
- **Verbesserung:** Ersten Badge-Abruf überspringen (oder Badges aus `/wishlist` entfernen); einen gemeinsamen Fetch-Status-Store für Seitenleiste und Kachel.
- **Aufwand:** 2–4 h. **Risiko:** niedrig. **Ziel:** 1.1.

#### PERF-07 · P3 · Abrufhistorie: COUNT über die volle Join-Kette
- **Kategorie:** Datenbank. **Status:** Bestätigt.
- **Nachweis:** `jobs.rs:1160-1166` zählt mit `RUNS` (vier LEFT JOINs) auch ohne Suchtext; 126,3 ms im Container, 27–35 ms standalone bei 30 000 Läufen.
- **Verbesserung:** Ohne `q` nur über `job_run` (mit Tonfilter) zählen; Joins nur für die angezeigte Seite.
- **Aufwand:** 1 h. **Risiko:** niedrig. **Ziel:** 1.1.

#### PERF-08 · P3 · Startarbeit wächst mit den Daten
- **Kategorie:** Altlast / N+1. **Status:** Bestätigt.
- **Nachweis:** `ev/sqlx_statement_breakdown_release.txt`: bei jedem Start 2 × 2 000 Updates aus dem 0.6.0-Fingerabdruck-Upgrade (`shops/mod.rs:203-229`, aufgerufen in `lib.rs:187-189`) und je Wunsch 2–3 Einzelabfragen in `attach` (`jobs.rs:841-850`); zusammen ≈ 85 ms SQL. Start bis `ready`: 544 ms leer, 825 ms mit Testdaten.
- **Verbesserung:** Upgrade nur für Zeilen mit Alt-Fingerabdruck (oder nach 1.0 per Migration abschließen und entfernen); `attach` als Mengenabfrage.
- **Aufwand:** 1–3 h. **Risiko:** niedrig. **Ziel:** 1.1.

#### PERF-09 · P3 · Eine Beobachtung je erfolgreichem Abruf, auch ohne Änderung
- **Kategorie:** Speicher / Datenwachstum. **Status:** Begründetes Risiko (Hochrechnung).
- **Nachweis:** `jobs.rs:636-645` schreibt jeden erfolgreichen Abruf, Aufbewahrung 365 Tage. Testdaten: 120 000 Beobachtungen + 30 000 Läufe = 51,7 MB (≈0,4 KB je Beobachtung) → bei vollem Budget (2 × 500 Abrufe/Tag) ≈ 150 MB/Jahr.
- **Verbesserung:** Unveränderte Messungen nur als „zuletzt gesehen“ fortschreiben. Achtung: Verlauf und Scoring nutzen die Beobachtungen – mit Dokument 11 abstimmen.
- **Aufwand:** 3–6 h. **Risiko:** mittel. **Ziel:** später.

#### PERF-10 · P3 · Listen-Cover in voller Covergröße
- **Kategorie:** Bilder. **Status:** Begründetes Risiko (ohne IGDB-Zugriff nicht gemessen).
- **Beschreibung:** Gespeichert und überall genutzt wird `t_cover_big` (264×374, `backend/src/catalog/provider.rs:511`), auch für die ~36×48-px-Miniaturen in Wunschliste und Warenkorb (`WishlistRow.tsx:126`, `Cart.tsx:107`).
- **Verbesserung:** Image-ID speichern bzw. URL umschreiben: `t_cover_small` (90×128) für Listen, `t_cover_big` im Detail.
- **Aufwand:** 1–2 h. **Risiko:** niedrig. **Ziel:** 1.1.

#### PERF-11 · P3 · Ein JS-Chunk mit 461 KB
- **Kategorie:** Bundle. **Status:** Bestätigt; Feintuning.
- **Beschreibung:** Kein Code-Splitting; Einstellungen, Editionsvergleich und Detail werden beim ersten Laden mitgeladen. Für eine LAN-App mit FCP 96 ms unkritisch.
- **Verbesserung:** `React.lazy` für Einstellungen und Detail, erst nach PERF-03/04.
- **Aufwand:** 2–4 h. **Risiko:** niedrig. **Ziel:** später.

## 5. Docker-/Unraid-Integration

| Kriterium | Ergebnis | Beleg |
|---|---|---|
| Multi-Stage-Build | Ja: Node-Build, Rust-Build (gepinnt per Digest), schlanke Runtime; Buildkontext per `.dockerignore` auf Quellen beschränkt, Secrets ausgeschlossen | `Dockerfile`, `.dockerignore` |
| Image-Größe | 162 MB, 41,7 MB komprimiert; App-Anteil 20 MB | SEC-05 |
| Benutzer/Rechte | Image 10001; Compose 1000:1000; Unraid root → `setpriv` 10001 ohne Capabilities, `NoNewPrivs` | `ev/docker_runtime_measurements.txt` |
| Persistenz | `VOLUME /data`; SQLite WAL, Dateien 0600, Sicherungen 0700/0600; `/data` im Unraid-Modus 0755 | ebd. |
| Healthcheck | 30 s, `/health/ready` prüft DB und Shop-Worker-Heartbeat (5 min); im Unraid-Modus ohne Root | `lib.rs:347-358` |
| Neustart/Stopp | SIGTERM als PID 1, Stopp 0,3–0,4 s, Exit 0; Neustart bis `ready` 0,5 s; Leases (180 s) überstehen Neustarts | ebd., `jobs.rs:303` |
| Ressourcen | 512 MiB Limit in Compose/Template; Leerlauf 25–36 MiB, Peak unter Last 116 MB | ebd. |
| Logging | Sehr knapp (2 Zeilen je Start), ANSI-Farbcodes → PERF-12 | ebd. |
| Upgrade | 0.8.3 → 0.9.1 verifiziert: Sicherung `backups/keyhunter-schema-0025-*.db` vor Migration 25→27, ready nach 670 ms; Downgrade bricht klar ab („migration 26 … missing“) | ebd. |
| Konfiguration | Wenige, validierte Variablen; Secrets in der App statt Template | `config.rs`, Template |
| Backup/Restore | Doku: Container stoppen und Ordner kopieren, Rückweg über Sicherungskopie (`docs/operations.md:53-55`, `:96-98`); keine Online-Sicherung | PERF-14 |

#### PERF-12 · P3 · Container-Log mit ANSI-Farbcodes und fast ohne Betriebsmeldungen
- **Kategorie:** Logging. **Status:** Bestätigt.
- **Beschreibung:** `tracing_subscriber::fmt()` (`backend/src/main.rs:6-11`) schreibt Farbcodes auch ohne TTY (`ESC[2m…` in `docker logs`). Abruffehler und Benachrichtigungsfehler landen nur im Event-Log der DB, nicht auf stdout.
- **Verbesserung:** `.with_ansi(std::io::stdout().is_terminal())`; Warnungen des Event-Logs zusätzlich gedrosselt als `tracing::warn!` ausgeben.
- **Aufwand:** 0,5–1 h. **Risiko:** niedrig. **Ziel:** 1.1.

#### PERF-13 · P3 · Healthcheck deckt nur die Shop-Worker ab; keine Selbstheilung
- **Kategorie:** Zuverlässigkeit Betrieb. **Status:** Begründetes Risiko.
- **Beschreibung:** Nur die Shop-Worker melden einen Heartbeat (`jobs.rs:111-133`). Die Schleifen für Alarm-Outbox und Editionen (`alerts.rs:412-421`, `edition_tracking.rs:137-160`) haben keinen; endet eine durch Panic, bleibt das unbemerkt. Docker und Unraid starten `unhealthy` Container nicht neu.
- **Verbesserung:** Heartbeat für alle Hintergrundschleifen in `/health/ready`; bei dauerhaftem Stillstand Prozess beenden, damit `restart: unless-stopped`/Unraid-Autostart greift; in der Doku erwähnen.
- **Aufwand:** 2–3 h. **Risiko:** niedrig. **Ziel:** 1.1.

#### PERF-14 · P3 · Unraid-Template und Betriebsdoku: Lücken und veraltete Angaben
- **Kategorie:** Deployment / Doku. **Status:** Bestätigt.
- **Beschreibung:** `deploy/unraid/keyhunter.xml:8` `<Support/>` leer, `:11` Kategorie „GameServers“ passt nicht; `.env.example:12-13` nennt 1–1000 und 120 Jobs (Code: 1–2000, Standard 500, `jobs.rs:86-92`); `docs/architecture.md:13` nennt noch ein „100er-Limit“ der Wunschliste (seit 0.9.0 unbegrenzt); `compose.yaml` ist auf `work/local` zugeschnitten, ein Compose-Beispiel für Anwender fehlt; der Test auf echter Unraid-Hardware steht laut `docs/operations.md:29` aus; Backup-Doku nennt das übliche Unraid-Werkzeug (Appdata-Backup) nicht.
- **Verbesserung:** Template-Felder ergänzen, Kategorie „Tools:“ o. ä., Werte angleichen, Anwender-Compose unter `deploy/`, Unraid-Abnahmetest vor 1.0 durchführen und dokumentieren.
- **Aufwand:** 1–2 h (+ Unraid-Test). **Risiko:** niedrig. **Ziel:** 1.0.

## 6. Scoring-Algorithmus (aus 11_SCORING_ALGORITHM_AUDIT.md)

Zusammenfassung des Leads aus Dokument 11; Details, Simulation und Reproduktion stehen dort.

- **Ressourcen:** Die Score- und Trendberechnung ist vernachlässigbar. Die Scheduler-Abfrage braucht im Python-SQLite 7,6 ms bei 30 000 Jobs (11 §4). Teuer wird es durch PERF-01 (`ANY_ACTIVE_WISH` mit SQLite ≥ 3.51): 35 ms je Claim in der Schreibtransaktion und 257 ms je `/status/fetch` bei 500 Wünschen. Das ist ein Abfrageproblem, kein Problem des Algorithmus.
- **Parallelität:** Je Shop arbeitet ein Worker, der immer genau einen Job holt. Die Abstände ergeben sich aus dem Tagesbudget: (Rest des UTC-Tages) / (Restbudget), mindestens 20 s, höchstens 1 h. Es gibt keine Abfrage-Spitzen. Ein Neustart erzeugt keinen Burst (11 §7).
- **Händlerlast:** Score und Trend ändern nur das Intervall (Faktor 0,5–2), nicht die Reihenfolge und nicht das Budget. Eine hohe Priorität kann deshalb nie mehr Anfragen auslösen als das Tagesbudget erlaubt. Rate Limits (429) passen das Budget nicht an (SCORE-08), Netzausfälle verbrauchen das volle Budget (SCORE-07). Beides ist P3.
- **Nutzen:** Gegenüber festen Intervallen spart der heutige Algorithmus bei gleicher Erkennung nur etwa 3 % der Abfragen. Er verschiebt Aktualität vom Weltpreis zulasten des alarmrelevanten Zielland-Preises (SCORE-01). Der Haupthebel ist das Tagesbudget: Ab etwa 50 Spielen beim Standard von 500 Abrufen/Tag gelten viele Preise als veraltet.
- **Empfehlung für 1.0:** Keine Algorithmusänderung. Vor 1.0 SCORE-03 (Score ehrlich beschriften), SCORE-05 (Fairness-Test reparieren) und SCORE-10 (Doku) erledigen. Kandidat C (etwa 20 % weniger Abfragen bei gleicher Erkennung) erst in 1.1.

## 7. Geprüfte Befehle und Grenzen

**Ausgeführt (alle gegen eigene Instanzen, ohne Repo-Änderung):**
- Fixture `work/check/target/debug/examples/catalog_fixture` auf 127.0.0.1:38784 (Datenordner `work/check/browser.sec*`), Einrichtung über den Code aus dem Datenordner.
- Produktions-Image `keyhunter:0.9.1` als `kh-audit-sec` (38794), `kh-audit-sec-unraid` (38795, Template-Parameter), `kh-audit-sec-upg` (38796, Upgrade von `keyhunter:0.8.3`); alle mit `--dns 127.0.0.1` und `--add-host` für Shop-/IGDB-/Twitch-/Microsoft-Hosts → 127.0.0.1. Container und Volumes danach entfernt.
- curl-Proben: Header, Origin/CSRF-Matrix (13 Fälle), CORS, Pfad-Traversal (8), Eingaben (11), Drossel (7 Versuche), Cookie-Flags, `blob:`-Origin 50 KB → `ev/security_probes_fixture.txt`, `ev/auth_throttle_dos_release.txt`.
- Python-Socket-Proben für Request-Stau (16 Verbindungen, bis 120 s) → `ev/scripts/slowbody*.py`.
- Webhook-Kanal gegen lokalen Mock 127.0.0.1:38799 → `ev/notification_ssrf_webhook_fixture.txt`; Kanal danach gelöscht.
- Seeding 500 Wünsche per API, synthetische Angebote per SQLite nur in der eigenen, gestoppten Fixture-DB.
- Endpunkt-Zeiten (10–20 Wiederholungen) Debug und Release, CPU je Request über cgroup, sqlx-Statement-Log (`RUST_LOG=sqlx=debug`), Lasttest 256 Requests.
- `EXPLAIN QUERY PLAN` und Laufzeiten von 16 Abfragen mit SQLite 3.46.1 (python3) und 3.53.4 (node:sqlite) auf einer Kopie; Skalierung 250 vs. 500 Wünsche.
- `docker stats`, cgroup `cpu.stat`/`memory.peak`, `docker history`/`inspect`, Start-/Stopp-/Neustartzeiten, `/proc/1/status` im Unraid-Modus, Upgrade 0.8.3 → 0.9.1, Downgrade-Versuch.
- `npm audit --omit=dev` und `npm audit` (0/0), `osv-scanner v2.2.4 scan source` auf Kopien von `Cargo.lock` und `package-lock.json` (2 Funde), `cargo-audit 0.23.0` im Build-Tools-Image mit eigenem Target `work/check/target-sec` (2 Funde), Trivy (lokales Image) auf `docker save keyhunter:0.9.1` (430 OS-Funde).
- `npx vite build --outDir <scratch>` (identische Hashes), Sourcemap-Auswertung.
- Playwright (Chromium) mit eigenen Wegwerf-Specs in `frontend/e2e/tmp-audit-sec/` (danach gelöscht; Kopien in `ev/scripts/playwright-*.spec.ts`): Erstladen 50/200 pro Seite, CLS-Quellen, Polling 45/60 s, XSS-Darstellung, Konsole/Requests je Ansicht – 5 Tests, alle bestanden.

**Nicht prüfbar / nicht geprüft:**
- Echte Shop-, IGDB-, Twitch- und Benachrichtigungsdienste (Regel); Cover-Größen und reale Abrufdauern daher nicht gemessen (PERF-10 begründet).
- Verhalten auf echter Unraid-Hardware (Template nur mit identischen Docker-Parametern simuliert).
- Leere Seite nach Update (PERF-04) nicht reproduziert, nur aus Header-Verhalten abgeleitet.
- Ob ein sqlx-Release mit `libsqlite3-sys` ≥ 0.39 existiert, nicht geprüft.
- Latenzen unter Host-Last anderer Prüfer gemessen (Load ≈ 3,9); CPU-Zeiten je Request sind belastbarer als Millisekunden-Latenzen.
- Hochrechnungen für 1 000 Wünsche (PERF-01) und Jahreswachstum (PERF-09) sind extrapoliert, nicht gemessen.
- Kein Penetrationstest der Abhängigkeiten selbst; kein TLS-Test (TLS liegt beim Reverse Proxy).
