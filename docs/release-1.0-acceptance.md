# Abnahme von KeyHunter 1.0 auf Unraid

Diese Checkliste macht der Eigentümer auf der echten Unraid-Installation, bevor 1.0 veröffentlicht wird (Kriterium K50; K15 und K51 gehören dazu). Sie ist so aufgebaut, dass **deine Produktivdaten nie das Experiment sind**: Die Abnahme läuft am **Release-Kandidaten** in einem Testcontainer mit eigenem Datenordner. Den echten Container aktualisierst du erst, wenn danach das endgültige `1.0.0` erschienen ist (Schritt 13).

Platzhalter: `<NEU>` ist der Release-Kandidat `1.0.0-rc.1` (Image `ghcr.io/buffer379x/keyhunter:1.0.0-rc.1`; ein Pre-release, `latest` bleibt dabei auf `<ALT>`), `<ALT>` die bisherige Version `0.9.4` und zugleich das Ziel eines Rollbacks. Pfade gehen von Unraid-Standard aus: Produktiv `/mnt/user/appdata/keyhunter`, Test `/mnt/user/appdata/keyhunter-test`. Alle Befehle laufen im Unraid-Terminal. Hake jeden Schritt ab; bei einer Abweichung notiere den Schritt und die Meldung (siehe „Rückmeldung an den Lead“ am Ende).

Dein Produktiv-Container heißt `KeyHunter`, so legt ihn das Template an. Docker unterscheidet Groß- und Kleinschreibung: `docker stop keyhunter` findet ihn nicht. Hast du ihn anders genannt, steht der Name im Docker-Tab unter **Name**; setze ihn dann in den Befehlen ein. Der Testcontainer heißt `keyhunter-test`.

## 0. Vorbereitung

- [ ] **Version notieren.** Docker-Tab → KeyHunter öffnen → **Einstellungen → System → Version**. Erwartet: `<ALT>` (oder eine andere 0.9.x). Notiere außerdem die Zahlen der Seitenleiste (Wunschliste, Warenkorb, Bibliothek, Preisalarme).
- [ ] **Kaltbackup der Produktivdaten** (Rückweg für alles Weitere):
  ```sh
  docker stop KeyHunter
  cp -a /mnt/user/appdata/keyhunter /mnt/user/appdata/keyhunter-backup-vor-1.0
  docker start KeyHunter
  ```
  Erwartet: kein Fehler; `ls /mnt/user/appdata/keyhunter-backup-vor-1.0` zeigt `keyhunter.db`, `bootstrap-token` und, falls vorhanden, `igdb-credentials.json`, `notification-secrets.json`, `backups`.
- [ ] **Template aktuell.** Lade das Template neu, falls du es länger nicht erneuert hast: `curl -fsSL -o /boot/config/plugins/dockerMan/templates-user/keyhunter.xml https://raw.githubusercontent.com/Buffer379x/keyhunter/main/deploy/unraid/keyhunter.xml`. Erwartet: Die Datei ist ersetzt, im Docker-Tab unter **Add Container** steht **KeyHunter** in der Vorlagenliste. Dein bestehender Container `KeyHunter` ändert sich dadurch **nicht**: Seine Einstellungen stehen in `my-KeyHunter.xml` im selben Ordner, und die bleibt unberührt. Die neue Vorlage nutzt nur Schritt 1 für den Testcontainer.

## 1. Template-Installation (Testcontainer mit der alten Version)

- [ ] Docker-Tab → **Add Container** → Vorlage **KeyHunter**. Setze **Name** `keyhunter-test`, **Repository** `ghcr.io/buffer379x/keyhunter:<ALT>`, **Web port** `3001`, **App data** `/mnt/user/appdata/keyhunter-test`. Alles andere bleibt. **Apply**. Erwartet: Das Image wird geladen, der Container startet ohne Fehlermeldung.
- [ ] Nach etwa 30 Sekunden: `docker ps --filter name=keyhunter-test --format '{{.Status}}'`. Erwartet: `Up … (healthy)`.
- [ ] `ls -ln /mnt/user/appdata/keyhunter-test`. Erwartet: `keyhunter.db` und `bootstrap-token` gehören UID `10001`.
- [ ] WebUI öffnen: `http://<Unraid-IP>:3001`. Erwartet: Einrichtungsmaske. Der Code steht in `/mnt/user/appdata/keyhunter-test/bootstrap-token`.
- [ ] Einrichten (Code, Passphrase mit 12 bis 128 Zeichen, Zielland). Erwartet: Du bist angemeldet, die Wunschliste ist leer, das Panel **Erste Schritte** erscheint.
- [ ] Zwei Spiele vormerken (Suchfeld oder **Spiel hinzufügen**; braucht den IGDB-Zugang unter **Einstellungen → Spieleindex**, oder gib einen manuellen Titel ein). Erwartet: Beide stehen in der Wunschliste, die Seitenleiste zeigt `2`.

## 2. Update `<ALT>` → `<NEU>` mit Sicherung (am Testcontainer)

- [ ] Kaltbackup des Testcontainers:
  ```sh
  docker stop keyhunter-test
  cp -a /mnt/user/appdata/keyhunter-test /mnt/user/appdata/keyhunter-test-backup
  ```
- [ ] Docker-Tab → `keyhunter-test` → **Edit** → **Repository** `ghcr.io/buffer379x/keyhunter:<NEU>` → **Apply**. Erwartet: Das neue Image wird geladen, der Container startet (er war gestoppt, starte ihn bei Bedarf).
- [ ] `docker logs keyhunter-test 2>&1 | tail -20`. Erwartet: eine Zeile „KeyHunter ready“, kein `ERROR`.
- [ ] `ls /mnt/user/appdata/keyhunter-test/backups`. Erwartet: **keine neue Datei**. 1.0 ändert das Datenbankschema nicht (keine Migration), deshalb legt dieses Update keine automatische Sicherung an; beim frisch installierten Testcontainer fehlt der Ordner ganz (`No such file or directory`). Automatische Sicherungen heißen `keyhunter-schema-<Schema>-<Zeit>.db` (z. B. `keyhunter-schema-0025-…`) und entstehen nur bei Updates mit Migration. Der Rückweg ist hier das Kaltbackup aus dem ersten Punkt.
- [ ] `docker ps --filter name=keyhunter-test --format '{{.Status}}'`. Erwartet: `(healthy)`.
- [ ] WebUI öffnen, anmelden. **Einstellungen → System → Version** zeigt `<NEU>`; beide Spiele sind noch da (Seitenleiste `2`).

## 3. Neustart

- [ ] `docker restart keyhunter-test`. Erwartet: nach etwa 30 Sekunden wieder `(healthy)`; die Seite lädt.
- [ ] Du bleibst angemeldet (Sitzungen gelten 12 Stunden), sonst melde dich mit deiner Passphrase an. Erwartet: Wunschliste unverändert.

## 4. Anmeldung und erste Schritte

- [ ] Abmelden (Seitenleiste unten), wieder anmelden. Erwartet: Anmeldung klappt.
- [ ] Mit einer **falschen** Passphrase anmelden. Erwartet: die Meldung „Anmeldung fehlgeschlagen.“, kein Absturz. (Nicht öfter als vier Mal wiederholen: Nach fünf Fehlversuchen sperrt die Anmeldung für 15 Minuten.)
- [ ] **Einstellungen → Allgemein**: Zielland setzen oder prüfen. Erwartet: gespeichert, Anzeige übernimmt es.
- [ ] **Erste Schritte** abarbeiten, soweit zutreffend (IGDB-Zugang, Key-Shop einschalten, Spiel, Kanal). Erwartet: Jeder erledigte Schritt bekommt ein Häkchen; sind alle erledigt, verschwindet das Panel.

## 5. Preisabfrage

Dieser Schritt ruft die Shops einmalig ab (wie im Normalbetrieb).

- [ ] **Einstellungen → Key-Shops**: Eneba ist **Aktiv**. Öffne ein vorgemerktes Spiel und wähle im Menü **Jetzt prüfen**. Erwartet: Die Meldung „Angebotssuche angefragt.“ erscheint unten rechts.
- [ ] **Einstellungen → Abrufstatus**. Erwartet: Der Zähler „Abrufe heute“ steigt, in der Liste der letzten Abrufe erscheint ein Eintrag; nach einigen Minuten zeigt das Spiel Angebote (Tab **Angebote**) oder den Status „Kein Angebot“.
- [ ] **Einstellungen → Log**. Erwartet: Keine Fehlerzeilen für Shop-Abrufe außer „nicht gefunden“-Fällen.

## 6. Benachrichtigung

- [ ] **Einstellungen → Benachrichtigungen**: Kanal einrichten (z. B. ntfy), **Speichern**, dann **Test senden**. Erwartet: Unten rechts „Testnachricht über … gesendet.“, und die Nachricht kommt auf dem Gerät an. (Anleitung: [notifications.md](notifications.md).)

## 7. Wunschliste sichern und wiederherstellen (K51)

- [ ] **Einstellungen → System → Sichern & Wiederherstellen → Exportieren**. Erwartet: Die Datei `keyhunter-wunschliste.json` wird heruntergeladen.
- [ ] **Datei wählen …** mit derselben Datei. Erwartet: Ein Dialog „Wunschliste importieren“ zeigt `0 werden hinzugefügt`, `2 sind schon auf der Liste`; die Schaltfläche **Hinzufügen** ist ausgegraut. **Abbrechen**. Erwartet: nichts geändert.
- [ ] Datei mit einem anderen Inhalt wählen (z. B. eine beliebige `.txt`, umbenannt nach `.json`). Erwartet: Im Dialog steht eine Fehlermeldung, nichts wird gesendet.

## 8. Kaltbackup und Wiederherstellung (K15)

- [ ] Notiere die Spiele der Wunschliste. Dann:
  ```sh
  docker stop keyhunter-test
  cp -a /mnt/user/appdata/keyhunter-test /mnt/user/appdata/keyhunter-test-kalt
  ```
- [ ] Zerstöre den Stand: `docker start keyhunter-test`, in der App ein Spiel löschen, `docker stop keyhunter-test`.
- [ ] Spiele den Kaltbackup zurück:
  ```sh
  rm -rf /mnt/user/appdata/keyhunter-test/*
  cp -a /mnt/user/appdata/keyhunter-test-kalt/. /mnt/user/appdata/keyhunter-test/
  docker start keyhunter-test
  ```
- [ ] Erwartet: `(healthy)`; die Anmeldung mit der **alten Passphrase** klappt (kein neuer Einrichtungscode); das gelöschte Spiel ist wieder da, Einstellungen und Kanal ebenso.

## 9. `--reset-owner`

- [ ] `docker exec --user 10001:10001 keyhunter-test /app/keyhunter --reset-owner`. Erwartet: „owner removed, … session(s) ended. Open KeyHunter and set it up again with the new code in …“.
- [ ] WebUI neu laden. Erwartet: die Einrichtungsmaske. Den neuen Code liefert `cat /mnt/user/appdata/keyhunter-test/bootstrap-token`; richte mit neuer Passphrase ein. Erwartet: Wunschliste, Einstellungen und Kanal sind unverändert.

## 10. Parser-Kanarienlauf (nur mit deiner Zustimmung)

Der Lauf ruft je Shop genau eine Produktseite und die `robots.txt` ab. Lies zuerst [operations.md](operations.md), „Parserprüfung vor dem Release“.

- [ ] Ohne Zustimmung: `sh deploy/parser-canary.sh "<Eneba-Produktlink>"` aus dem Repository (oder die Datei kopiert), danach `echo $?`. Erwartet: Das Skript nennt das Image und die Adressen, die ein Lauf kontaktieren würde (`https://www.eneba.com/robots.txt and <Link>`), dann `Refused: nothing was contacted. …`; Exit-Code 2, kein Abruf.
- [ ] Mit Zustimmung und je einem Produktlink aus der App:
  ```sh
  KEYHUNTER_CANARY_CONSENT=1 KEYHUNTER_IMAGE=ghcr.io/buffer379x/keyhunter:<NEU> sh deploy/parser-canary.sh \
    "<Eneba-Produktlink>" "<Driffle-Produktlink>"
  ```
  Erwartet: Zuerst die Liste der Adressen (vom Skript, dann noch einmal von der App), dann je Shop `ok: "<Produkt>", <n> offer(s), from <Cent> cents`, Exit-Code 0. Bei `failed (…)` oder `but no price found` ist ein Leser gebrochen: Release anhalten. Bei `is sold out` einen anderen Link nehmen.

## 11. Rollback auf `<ALT>` (am Testcontainer)

- [ ] `docker stop keyhunter-test`. Ersetze den Datenordner durch den Stand vor dem Update:
  ```sh
  rm -rf /mnt/user/appdata/keyhunter-test/*
  cp -a /mnt/user/appdata/keyhunter-test-backup/. /mnt/user/appdata/keyhunter-test/
  ```
- [ ] Docker-Tab → `keyhunter-test` → **Edit** → **Repository** `ghcr.io/buffer379x/keyhunter:<ALT>` → **Apply**. Erwartet: `(healthy)`, die Anmeldung klappt, **System → Version** zeigt `<ALT>`, beide Spiele sind da.
- [ ] Eine automatische Sicherung als zweiten Rückweg gibt es bei diesem Update nicht (keine Migration, siehe Schritt 2). Erwartet: nichts zu tun; das Kaltbackup genügt.

## 12. Frische Installation von `<NEU>` und Import

- [ ] Testcontainer entfernen: Docker-Tab → `keyhunter-test` → **Remove** (mit Image), dann `rm -rf /mnt/user/appdata/keyhunter-test`.
- [ ] Wie in Schritt 1 neu installieren, aber mit **Repository** `ghcr.io/buffer379x/keyhunter:<NEU>`. Erwartet: `(healthy)`, Einrichtung klappt.
- [ ] **System → Sichern & Wiederherstellen → Datei wählen …** mit der Datei aus Schritt 7. Erwartet: Der Dialog zeigt `2 werden hinzugefügt` (mit IGDB-Zugang), **2 hinzufügen** übernimmt sie, unten rechts erscheint „2 Spiele hinzugefügt“.
- [ ] Dieselbe Datei erneut wählen. Erwartet: `0 werden hinzugefügt`, `2 sind schon auf der Liste`.
- [ ] Testcontainer und `keyhunter-test*` löschen, wenn du fertig bist.

## 13. Update des Produktiv-Containers (erst nach dem endgültigen 1.0.0)

Diesen Schritt machst du erst, wenn du die Schritte 0 bis 12 an den Lead zurückgemeldet hast und daraufhin `1.0.0` als vollständiges Release erschienen ist. Dann zeigt `latest` auf `1.0.0`. Den Release-Kandidaten setzt du im Produktiv-Container nie ein.

- [ ] `docker stop KeyHunter` und Kaltbackup `cp -a /mnt/user/appdata/keyhunter /mnt/user/appdata/keyhunter-backup-vor-1.0-b` (der Stand von Schritt 0 gilt nur, wenn sich seither nichts geändert hat).
- [ ] Docker-Tab → `KeyHunter` → **Edit** → **Repository** `ghcr.io/buffer379x/keyhunter:latest` (oder fest `ghcr.io/buffer379x/keyhunter:1.0.0`) → **Apply**. Stand das Feld schon auf `latest`, genügt **Force Update** (Advanced View).
- [ ] Erwartet wie in Schritt 2: `(healthy)`; `ls /mnt/user/appdata/keyhunter/backups` zeigt **keine neue** Sicherung (vorhandene `keyhunter-schema-…`-Dateien früherer Updates bleiben); **System → Version** zeigt `1.0.0`; die Zahlen der Seitenleiste entsprechen denen aus Schritt 0; du kannst dich mit deiner Passphrase anmelden; ein Preis lässt sich aktualisieren.
- [ ] Beobachte einen Tag lang **Einstellungen → Log** und **Abrufstatus**. Erwartet: keine neuen Fehlerserien, das Tagesbudget bleibt im Rahmen.
- [ ] Rückweg, falls etwas nicht stimmt: `docker stop KeyHunter`, Datenordner durch `keyhunter-backup-vor-1.0-b` ersetzen (wie in Schritt 11), **Repository** `ghcr.io/buffer379x/keyhunter:<ALT>` → **Apply**.

## Ergebnis

Alle Punkte abgehakt: 1.0 ist installier-, aktualisier- und wiederherstellbar (K50, K15, K51). Bei einer Abweichung hält der Eigentümer die Veröffentlichung an. Die Sicherungen `keyhunter-backup-vor-1.0*` löschst du erst, wenn 1.0 mehrere Tage stabil läuft.

## Rückmeldung an den Lead

Nach Schritt 12 (am Release-Kandidaten) schickst du dem Lead genau eines von beiden:

- **Bestanden:** „Abnahme `1.0.0-rc.1` bestanden, Schritte 0 bis 12 abgehakt.“ Dazu die Unraid-Version und, falls du ihn gemacht hast, das Ergebnis des Kanarienlaufs (Schritt 10: je Shop die `ok`-Zeile).
- **Abweichung:** „Schritt <Nummer>, Punkt <Text des Punkts>: erwartet <…>, tatsächlich <…>.“ Dazu die genaue Meldung (Text oder Bildschirmfoto) und die letzten Logzeilen: `docker logs keyhunter-test 2>&1 | tail -50`. Notiere auch, ob du danach weitergemacht hast.

Der Lead veröffentlicht `1.0.0` erst nach „Bestanden“. Nach Schritt 13 meldest du kurz: „Produktiv auf 1.0.0, Version und Zahlen stimmen, ein Tag ohne Fehlerserien“ oder die Abweichung wie oben (mit `docker logs KeyHunter 2>&1 | tail -50`).
