# Abhängigkeitsprüfung

Stand v0.2.0. Rust 1.100.0, Axum 0.8.9, SQLx 0.9.0, Argon2 0.5.3, Reqwest 0.13.5/Rustls; Node 24.22.1, React 19.3.1, Vite 8.3.8, TypeScript 7.0.2. Cargo-/npm-Lockfiles gehören zum Build. Rust-Basisimage ist auf Digest festgelegt; OS-Paketaktualisierungen sind keine Zusage byteidentischer Container.

## Bekannte Befunde

- `npm audit`: fünf High-Meldungen gehen auf denselben [picomatch-ReDoS-Hinweis](https://github.com/advisories/GHSA-fc5q-39xc-vjpf) und die transitiven Buildwerkzeuge Vite, Plugin, fdir/tinyglobby zurück. Die Registry bietet derzeit 4.0.7, aber keine korrigierte 4.0.8. Kein blindes `audit fix --force` mit Toolchain-Downgrade. Die Anwendung nimmt keine externen Globmuster an und das Runtime-Image enthält weder Node noch diese Pakete. Build-/Entwicklungswerkzeuge ausschließlich mit vertrauenswürdigen Projektdateien verwenden; nach Veröffentlichung eines Fixes gezielt aktualisieren.
- OSV-Abfrage für 296 Rust-Pakete: ein Befund [RUSTSEC-2026-0459](https://rustsec.org/advisories/RUSTSEC-2026-0459.html) für `libsqlite3-sys` 0.37.0. Betroffen ist das Öffnen eines von weniger vertrauenswürdigen Personen manipulierten DB-/WAL-Dateipaars. Die App erstellt eine eigene lokale, eigentümergeschützte DB und bietet keinen Datenbankupload/-import an. Nur eigene vertrauenswürdige Backups wiederherstellen. SQLx 0.9 bindet diese Native-Abhängigkeit; korrigierte `libsqlite3-sys`-Versionen sind noch nicht ohne Treiberanpassung austauschbar. Bei kompatiblem SQLx-Update erneut prüfen. Das ist kein Nullbefund und keine Zusage, beliebige fremde SQLite-Dateien sicher zu öffnen.

Die verwendete gebündelte SQLite-Version wird im Integrationstest gegen mindestens 3.51.3 (WAL-Reset-Fix) geprüft; das ersetzt nicht den oben dokumentierten neueren Advisory-Befund.
