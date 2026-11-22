# 04 – UI-Design und Designsystem (Release-1.0-Audit, KeyHunter 0.9.1)

Rolle: Senior UI/UX Designer, Designsystem (Kürzel `ds`, Befundpräfix DS). Stand: Branch `audit/release-1.0` = Tag 0.9.1 (Commit 490a8fb).
Geprüft wurden Code (`frontend/src/styles/*.css`, `frontend/src/ui/*`, `frontend/src/features/**`, `frontend/public/*`, `deploy/unraid/`)
und die laufende Oberfläche (Fixture-Server auf Port 38782 mit realistischen Mock-Daten, Chromium 1440 × 900 und 1920 × 1080).
Responsive-Viewports und Endanwender-Journeys sind Gegenstand von `05_RESPONSIVE_VISUAL_AUDIT.md`.

## 0. Kurzfazit

- **Gesamteindruck:** Die Oberfläche wirkt bereits wie ein eigenständiges Produkt: ein Layout-Gerüst, eine Farbquelle, eine Komponentenbibliothek,
  klare Preis-Hierarchie. Die Inkonsistenzen aus der schrittweisen KI-Entwicklung liegen **im Detail und unter der Haube**, nicht im Gesamtlayout.
- **Die „1“ im Tab ist das Favicon selbst** (bestätigt): Chrome wählt `favicon.svg` (Masterzeichnung im 32er-Raster) auch für 16 px. Dort wird das orange
  Schlüsselloch zu einem senkrechten Strich in einem dunklen, abgerundeten Kasten – das liest sich wie ein Zähler-Badge „1“. Die vorhandene optische
  16-px-Variante erreicht Chrome nie und ist selbst ebenfalls zu dünn. Fix: SVG-Link entfernen, 16-px-Zeichnung neu (Variante B empfohlen), ICO neu bauen.
- **Kontrast-Tokens:** `--faint` (2,1–2,8 : 1) färbt 272 Textvorkommen in 18 Ansichten, darunter alle Tabellenköpfe; `--muted` liegt auf den Innenflächen bei 3,9–4,3 : 1.
- **Zustände sind nicht einheitlich:** „Ziel erreicht“ erscheint grün (3 Stellen) und orange (Preis-Tab), „Veraltet“ als graue Pille, als gelber Text oder nur grau.
- **Designsystem:** `tokens.css` ist faktisch die einzige Farbquelle (5 Farbliterale außerhalb, 1 Farbformel in TSX), aber 70 Alt-Aliase (58 ungenutzt), 64 Klassen
  in mehreren Dateien, mehrere doppelte bzw. sich selbst überschreibende Regeln und eine umgekehrte CSS-Ladereihenfolge der Feature-Dateien.
- **Keine großen Design-/Layoutänderungen nötig.** Deshalb wurde **kein vollständiger Preview-Build** erstellt (Begründung Abschnitt 8); die sichtbaren
  Änderungen sind als Vorher/Nachher-Belege vorhanden (Favicon-Vergleich, Kontrast-Tokens 1 : 1 im laufenden System).

| Kategorie | Bewertung | Begründung |
|---|---|---|
| UI-Design | **7/10** | Ruhiges, markantes Dunkel-Design mit klarer Preis-Hierarchie und konsistentem Gerüst; Abzüge für Tab-Icon „1“, zu schwache Sekundärtexte, uneinheitliche Statusfarben und viel Leerfläche in den Einstellungen. |
| Designkonsistenz | **6/10** | Eine Token-Quelle und eine UI-Bibliothek werden breit genutzt (55 `Button`, 41 `Pill`, nur 5 Farbliterale außerhalb `tokens.css`, 1 Farbformel in TSX), aber 13 gerenderte Schriftgrößen bei 8 Tokens, 10 Radien, 6 Icon-Button-Höhen, zwei Cover-Komponenten, vier Meldungsstile und abweichende Zustandsdarstellung. |

Hinweis zum Auftrag: Die freigegebene Wortmarke ist laut `docs/modernization/branding/v3/ENTSCHEIDUNG.md` **JetBrains Mono 600** (als Pfade in
`frontend/src/brand.tsx`), nicht Archivo; Archivo war die Wortmarke vor 0.7.0. Am Zeichen und an der Wortmarke wird nichts umgestaltet.

## 1. Methode und Datengrundlage

1. **Statische Inventur** aller 15 Stylesheets mit PostCSS (`evidence/design/scripts/inventory.mjs`): 805 Regeln, 2 425 Deklarationen, 369 Klassen.
   Ergebnis: `evidence/design/inventory/inventory.md` und `inventory.json`.
2. **Computed-Style-Zensus** der gerenderten Oberfläche (18 Ansichten, nur sichtbare Elemente, Farben auf Tokens zurückgeführt):
   `evidence/design/inventory/census.md` / `census.json`. Er zeigt, was wirklich beim Nutzer ankommt, unabhängig davon, woher die Regel stammt.
3. **Screenshots** mit Mock-Daten nach dem Muster von `frontend/e2e/visual/core-views.spec.ts`, erweitert um zehn Wünsche in allen Preiszuständen
   (Preis, Ziel erreicht, Zielland = günstigste Region, veraltet, wird gesucht, kein Angebot, Zuordnung prüfen, pausiert, Abruf fehlgeschlagen, im Warenkorb),
   Warenkorb, Bibliothek, Alarme, Log und Abrufstatus. Cover sind synthetische Platzhalter (kein Internet). 27 Ansichten bei 1440, 10 bei 1920:
   `evidence/design/screens/`.
4. **Tastaturfokus-Probe** (je 26 Tab-Stopps auf Wunschliste und Detail), **Kontrastberechnung** aller Text-/Flächen-Tokenpaare (WCAG-Formel).
5. **Favicon-Auswahltest** mit echtem Chromium (voller Browser, neuer Headless-Modus) gegen einen protokollierenden Server, **Favicon-Vergleichsblatt**
   in echter Tab-Größe auf hellen/dunklen Tableisten: `evidence/design/favicon/`.
6. **Visuelle Regression** des Repos im gepinnten Image `mcr.microsoft.com/playwright:v1.65.1-noble`: **22/22 bestanden**.

## 2. Designsystem-Inventur (gemessen)

### 2.1 Token-Quelle
`frontend/src/styles/tokens.css` enthält 118 Custom Properties: 48 Tokens des Prototyps design v4 (die 38 Prototyp-Werte sind **identisch** mit
`docs/modernization/design-v4/preview.html`, geprüft per Skript) und 70 „Legacy aliases“ (`frontend/src/styles/tokens.css:83`).
Von den Aliasen werden **58 nirgends** referenziert; die übrigen 12 nutzt ausschließlich der Cover-Block `frontend/src/styles/detail.css:8-12`.
Zusätzlich ungenutzt: `--bp-sm/md/lg` (dokumentarisch, in Media Queries technisch nicht verwendbar; `frontend/tests/breakpoints.test.ts` hält sie synchron – sinnvoll).

### 2.2 Farben
- Farbliterale außerhalb `tokens.css`: **5** – `catalog.css:9` (`rgb(255 255 255 / .85)` = Wert von `--cover-text`), `library.css:20` (Schatten),
  `offers.css:22-23` (Score-Verlauf per `color-mix` aus Tokens, vertretbar), `settings.css:30` (`color-mix(... var(--warn) 35% ...)`, ein fehlendes `--warn-line`).
- In TSX: **eine** Farbformel am System vorbei: `frontend/src/features/catalog-ui.tsx:34` (Cover-Verlauf `hsl(...)` inline).
- Gerendert (Zensus): 12 Textfarben, alle Tokens; Text-Hauptlast `--text` 431, `--muted` 366, **`--faint` 272**, `--text-2` 175.
- Kontrast (WCAG, Text auf Fläche):

| Token | ground | shell | panel | panel-2 | panel-3 |
|---|---|---|---|---|---|
| `--text` | 15,2 | 14,5 | 13,7 | 12,7 | 11,6 |
| `--text-2` | 9,3 | 8,8 | 8,3 | 7,7 | 7,1 |
| `--muted` | 5,1 | 4,9 | 4,6 | **4,3** | **3,9** |
| `--faint` | **2,8** | **2,7** | **2,5** | **2,3** | **2,1** |
| `--accent` | 7,0 | 6,7 | 6,3 | 5,9 | 5,3 |

### 2.3 Typografie
- Familien: Inter (variabel) und JetBrains Mono 400/500 (selbst gehostet). Keine dritte Schrift, keine Icon-Fonts.
- Tokens: 8 Größen (11/12/13/14/16/20/24/34 px). Gerendert: **13 Größen** – zusätzlich 10 px (×18: `.kbd`, Diagrammachsen, `.reg`), 22 px (Spieltitel
  im Detail, `detail.css:42`, aus dem Prototyp übernommen), 10,83 px (Browser-Standard von `<small>` in den Zustellzeilen der Alarme), 11,96 px (`code`), 18,7 px (Cent-Teil von `.big-price`).
- Gewichte gerendert: Inter 400/500/600 und **Inter 700** (×2, Standard-`<b>` der Shop-Köpfe im Warenkorb) sowie **JetBrains Mono 600** (Gesamtsumme
  Warenkorb, `cart.css:45`; ebenso `offers.css:24` beim Score). Für Mono ist nur 400/500 geladen → **synthetischer Fettdruck**.
- 26 Kombinationen Schriftgröße/Zeilenhöhe; Großbuchstaben-Mono-Labels (11 px, 0,88 px Laufweite) ×216 – das prägende Stilmittel von v4.

### 2.4 Abstände
388 Abstandsdeklarationen (padding/margin/gap) sind literal, 1 nutzt ein Token. Häufigkeit: 8 px ×73, 10 px ×62, 12 px ×57, 6 px ×43, 16 px ×39, 14 px ×33,
4 px ×30 sowie Ausreißer 5/7/9/13/18/22 px. Die Werte stammen überwiegend 1 : 1 aus dem Prototyp; die vorhandenen Abstands-Tokens (`--space-*`) sind Alt-Aliase und ungenutzt.

### 2.5 Radien, Schatten, Rahmen
- Radien gerendert: **10 Werte** (8 px ×322, 1 px, 999 px ×97, 12 px ×87, 4 px ×55, 50 %, 6 px, 3 px, 5 px ×17, 2 px). Literal im CSS: 41 von 83 Deklarationen,
  darunter 5 px ×7 (Cover), 4 px ×5, 10 px (`library.css:49`) und die falschen Fallbacks `var(--r-md, 10px)` (`library.css:32`, Token ist 8 px) und `var(--t-lg, 18px)` (`cart.css:46`, Token ist 16 px).
- Schatten: zwei Tokens (`--shadow-pop`, `--shadow-tip`) plus ein Literal (`library.css:20`). Sauber.
- Rahmen: 1 px `--line` dominiert (×824). Konsequent.

### 2.6 Steuerelemente und Icons
- Button-Höhen gerendert: `.btn` 32, `.btn.sm` 28, Tabs 38, Navigation 34, Seg 26/24, Chip 28, Hilfe 22/20.
- **Icon-Buttons in 6 Höhen** (24, 26, 28, 30, 32, 34 px) durch 12 lokale Überschreibungen (`shell.css:43,49,118`, `wishlist.css:50`, `offers.css:17`, `cart.css:27`,
  `detail.css:213`, `settings.css:83,120`, `ui.css:220,228`, `library.css:20`).
- Selects: 28/30/32 px. Textfelder: 32 px (als `.field`).
- Icons: **eine** eigene Linien-Icon-Bibliothek (`frontend/src/ui/Icon.tsx`, 24er-Raster, Strich 1,7) plus Flaggen (`flag-icons`). Keine zweite Icon-Bibliothek.
  Gerenderte Größen: 12, 13, 14, 15, 16 px (178× 15 px, 172× 16 px). Textglyphen als Icon: „✓ — ?“ in der Legende `EditionComparison.tsx:76`, während die Tabelle darüber SVG-Haken zeigt.

### 2.7 Breakpoints
CSS: 720 px ×11, 1180 px ×3, 900 px ×2 (= Prototyp, synchron mit `frontend/src/breakpoints.ts`), dazu Ausreißer **560 px** (`catalog.css:38`),
**520 px** (`detail.css:209`), **359 px** (`library.css:56`) und ein Container-Query 1120 px (`cart.css:7`). TS nutzt nur `mediaQuery.drawer` (900 px).

### 2.8 `!important` und Inline-Styles
- `!important`: 4, alle im `prefers-reduced-motion`-Block (`base.css:51`) – korrekt eingesetzt.
- `style=` in TSX: 14 Stellen, davon 12 datengetriebene Geometrie (Diagramm-Tooltip, Preis-Visier, Budgetbalken, Sparkline, Help-Popup) – sachgerecht.
  Am System vorbei: der Cover-Farbverlauf (`catalog-ui.tsx:34`). `Field` reicht `style` durch (`ui/Form.tsx:11`), genutzt nur in der Dev-Galerie.

### 2.9 Komponenten und Varianten

| Baustein | Implementierung | Nutzung / Auffälligkeit |
|---|---|---|
| Button | `ui/Button.tsx` (`default/primary/ghost/danger`, `md/sm`) | 55× Komponente; **5 rohe `<a className="btn">`** (`LinkReview.tsx:57`, `InfosTab.tsx:86`, `Offers.tsx:94`, `PriceTab.tsx:108-109`) und Popover-Trigger mit Klassenstring |
| IconButton | `ui/Button.tsx` | 25×; Größe nur per lokalem CSS (6 Höhen, 12 Überschreibungen) |
| Text-Link-Button | `.text-button` (`app.css:9`) | 3×, neben `ghost`-Buttons für ähnliche leise Aktionen |
| Chip / Seg / Tabs | `ui/Chip.tsx`, `ui/Tabs.tsx` | konsistent; Bibliothek-Ansichtsumschalter baut `.seg` von Hand (`Library.tsx:114`) |
| Pill | `ui/Chip.tsx` (6 Töne) | 41×; Tonwahl je Feature eigenständig (siehe DS-04) |
| Tabelle | eine Basis (`ui.css` `table/th/td`) | 10 Tabellen (+1 in der Dev-Galerie), einheitlich; Karten-Umbau < 720 px dreimal separat (Wunschliste, Warenkorb, Alarme) |
| Dialog | natives `<dialog>` (`app.css:14`) | 4 Dialoge, **zwei Anatomien** (DS-17) |
| Meldungen | `Notice` (`components.tsx:11`), rohes `.note` (7 Stellen in 5 Dateien), `.cart-extra`, Toaster (`ui/Toaster.tsx`), alter `Toast` (`ui/Toast.tsx`, nur Dev-Galerie) | vier sichtbare Stile (DS-12) |
| Cover | `features/GameCover.tsx` (`.gcover`) **und** `features/catalog-ui.tsx` `Cover` (`.game-cover`) | zwei Komponenten, drei Fallbacks, 6 Größen in 6 Dateien (DS-09) |
| Formular | `Field`, `FormRow` (1×), `Switch`; 19× rohes `className="form-row"` | `FormRow` kaum genutzt |

## 3. CSS-Duplikate, Konflikte und tote Regeln

Belegt durch `inventory.md` (Abschnitte „duplicate selectors“, „conflicting declarations“, „classes styled in several files“, „never referenced“):

- **Identisch doppelt:** `.grid-2`/`.stack` (`shell.css:91-92` und `detail.css:49-50`, samt identischer 1180-px-Regel `shell.css:128`/`detail.css:181`);
  `.save`, `.save.big`, `.save.none` (`detail.css:90-93`, `wishlist.css:40-42`, Variante `alerts.css:13-15`); `.world-cell` (`offers.css:2`, `wishlist.css:37`);
  `.form-row > label` (`app.css:2`, `ui.css:80`); `.search-hint` (`catalog.css:23`, `shell.css:122`); `.search-platform` auf zwei Zeilen (`shell.css:119-120`).
- **Sich selbst überschreibend:** `.dialog-actions` (`app.css:21` setzt `space-between`/12 px, `app.css:24` überschreibt mit `flex-end`/8 px);
  `.cart-page .cart-totals` (`cart.css:36` margin 6 px, `cart.css:40` margin 0); `select` (`base.css:10` `color: inherit`, `base.css:26` `color: var(--text)`).
- **64 Klassen** werden in zwei bis sechs Dateien gestylt (z. B. `.notice` in 6, `.icon-btn` in 5, `.form-row` in 5, `.game-cover` in 4).
- **Ladereihenfolge invertiert:** `library.css`, `cart.css` und `settings.css` werden in Feature-Modulen importiert und landen im Bundle **vor**
  `tokens.css`/`ui.css` (Byte-Offsets im ausgelieferten CSS: `.library-page` 0, `.cart-page` 3 541, `.settings-page` 7 633, `:root` 13 825, `.btn{` 19 736).
  `settings.css:4` dokumentiert den Workaround („bundled before ui.css, so plain class selectors would lose“): alles wird unter `.settings-page` verschachtelt.
- **Nie referenziert (9):** `.field-label`, `.field-help`, `.card-footnote`, `.source-link`, `.status-dot` (`app.css:2-11`), `.chart-hint` (`detail.css:136`),
  `.alert-form` (`pages.css:2-3`), `.set-add` (`settings.css:47-48`), `.col-order-hint` (`settings.css:77`). `.lv-error` ist dynamisch genutzt (`Log.tsx:31`) – kein Befund.
- **Nur Dev:** alte `Toast`-Komponente samt `.toast` (`ui.css:163`) und `.gallery` (`ui.css:171`) werden in Produktion mitgeliefert.

## 4. Visuelle Qualität (Real-UI-Review)

Grundlage: `evidence/design/screens/*-1440.png` und `*-1920.png`.

**Stärken.** Klare Rahmenstruktur (Seitenleiste 236 px, Kopfzeile 56 px, Inhalt max. 1320 px), eine Panel-Sprache (Panel → Kopf mit Mono-Label → Innenfläche),
Preise durchgehend in Mono mit Tabellenziffern, Flaggen statt Codes, Orange ausschließlich für „du/dein Ziel“. Tabellen, Pillen, Chips und Tabs sehen in allen
Ansichten gleich aus. Popups unten rechts (`21-toasts`), Hilfe-Popups (`22-help-tooltip`), Menüs (`23-more-menu`) und der Bestätigungsdialog (`24-confirm-dialog`)
sind formal stimmig. Der Gesamteindruck ist professionell; es gibt keine Bereiche, die „aus einer anderen App“ stammen.

**Schwächen (nach Wirkung sortiert).**
1. *Sekundärtext zu schwach.* Tabellenköpfe, Gruppentitel der Navigation, Zähler und Einheiten in `--faint` sind auf 1440 px kaum lesbar (`01-wishlist`, `03-detail-angebote`). Vorher/Nachher: `evidence/design/fixes/contrast-*-before.png` / `-after.png`.
2. *Zustände mehrdeutig.* „Ziel erreicht“ steht im Kopf des Detail-Tabs grün, im Preisvergleich darunter orange mit Zielscheibe (`02-detail-preis`). „Veraltet“ ist in der
   Wunschliste eine graue Pille, in den Angeboten gelber Text („veraltet · vor 6 T“), im Preisvergleich nur graue Zahl. In einer Wunschlistenzeile steht für „kein Preis“
   gleichzeitig „–“ (Preis DE) und „Noch nicht abgefragt“ (Preis INT); die Angebote schreiben „noch nicht abgefragt“ klein.
3. *Fokus in Eingabefeldern kaum sichtbar.* Suche, Listenfilter, Plattformwahl: `outline: none`, Fokus nur über Rahmen `--line` → `--line-2` (`ui.css:74`, `shell.css:100`).
   Alle übrigen protokollierten Steuerelemente (Buttons, Selects, Chips, Tabs, Sortierköpfe, Navigation) zeigen den orangen 2-px-Ring; ohne Ring: Listenfilter, Kopfsuche, Plattformwahl der Suche.
4. *Cover ohne Bild sehen dreimal anders aus:* Wunschliste Titeltext auf Orange-Radialverlauf, Warenkorb Initialen „FH“ in Mono, Bibliothek Initialen auf Farbverlauf
   je Titel, Suche/Dialog Schlüssel-Symbol (`08-cart`, `09-library-grid`, `19-add-dialog`).
5. *Einstellungen:* Formulare sind 420–560 px breit (`settings.css:78,115`, `ui.css:78`) in vollbreiten Panels – auf 1440/1920 px bleibt die rechte Hälfte leer
   (`12-settings-general-1920`). Zwischen den Tabs springt der Seitenkopf um 2 px, weil „Speichern“ je nach Tab im Kopf steht oder fehlt (Benachrichtigungen
   speichert je Kanal, Spieleindex hat zusätzlich „Prüfen und speichern“). Untertabs sitzen dreimal anders (außerhalb des Panels bei Key-Shops, im Panelkopf bei Kanälen, in der Innenfläche bei Tabellenspalten).
6. *Mono/Sans gemischt:* Infos-Fakten zeigen Werte teils in Mono („2021“, „02. Nov. 2026“), teils in Sans („Basisspiel“); relative Zeiten in Alarmen Mono („vor 1 Std.“), in Angeboten Sans („vor 2 Std.“);
   der Mehrkosten-Kasten im Warenkorb setzt Beträge mitten im Satz in Mono.
7. *Kleinigkeiten:* Grün für die Produktart „Basisspiel“/„Premium Edition“ in den Suchergebnissen (Grün bedeutet sonst „gültig/erreicht“); Entfernen mit „×“ im Detailmenü, sonst Papierkorb;
   fünf gleichgewichtete Aktionsknöpfe im Detailkopf ohne Primäraktion (subjektiv); bei 1920 px steht die Brotkrume am Rand der Kopfzeile, die Überschrift 162 px weiter rechts
   (`01-wishlist-1920`); Kennzahl „1 Spiele“ (Textfehler, an 05 weitergegeben).

## 5. „1“ im Browser-Tab – Ursache und Fix

**Ergebnis: Die „1“ ist das Favicon, nicht Titel und nicht Badge.**
- Titel: statisch `<title>KeyHunter</title>` (`frontend/index.html:15`); kein `document.title`, keine Badging-API, kein Service Worker im Code (grep über `frontend/src`, `backend/src`).
- Alle Icon-Dateien werden mit korrektem Typ ausgeliefert (Fixture: `image/svg+xml`, `image/png`, `image/x-icon`, `application/manifest+json`) und liegen im Image `keyhunter:0.9.1` unter `/app/frontend/`.
- **Welche Datei der Browser nimmt** (`evidence/design/scripts/favicon-configs.mjs`, Chromium voller Browser, neuer Headless-Modus, protokollierender Server):

| `<link rel=icon>`-Satz | DPR 1 | DPR 2 |
|---|---|---|
| heute (ICO 16/32, SVG `sizes="any"`, PNG 16, PNG 32) | `favicon.svg` | `favicon.svg` |
| SVG ohne `sizes="any"` | `favicon.svg` | `favicon.svg` |
| **ohne SVG-Link** | **`favicon.ico`** (Frame je DPR) | **`favicon.ico`** |
| nur PNG 16/32 | `favicon-32.png` | `favicon-32.png` |

- **Ursache:** Chrome nimmt immer die SVG-Masterzeichnung (32er-Raster) und rastert sie im 1x-Tab auf 16 px. Das Schlüsselloch (Kopf 3,3 px, Fuß ≈ 2 px) wird zu einem
  2 px breiten hellen Strich mit leichtem Kopf; die Tag-Kanten liegen auf halben Pixeln (rechte Kante bei 13,5 px) und verschwimmen. Dunkler abgerundeter Kasten + heller
  senkrechter Strich = die Gestalt eines Benachrichtigungszählers „1“ (`evidence/design/favicon/favicon-compare.png`, Zeile 1, 8-fach-Raster).
  Auf HiDPI-Tabs (32 px) ist das Zeichen eindeutig – deshalb tritt der Effekt nur auf 1x-Monitoren auf.
- **Zweite Ursache:** Die optische 16-px-Variante `frontend/public/favicon-16.svg` ist nirgends verlinkt; sie erreicht nur `favicon-16.png` und das ICO, die Chrome wegen des SVG-Links
  ignoriert. Sie wäre auch kein Fix: ihr Schlüsselloch rastert zu einem „†“ (Zeile 2).
- **Varianten** (Zeichen bleibt: orange Kachel, dunkles Preisschild, Schlüsselloch; nur optische Kleinvarianten), Dateien `evidence/design/favicon/variants/`:
  - **A „Kopf betont“** (`a-16.svg`/`a-32.svg`): Schild auf ganzen Pixeln (y 3–13), Kopf 5 px rund, Fuß 4 px.
  - **B „Loch und Keil“** (`b-16.svg`/`b-32.svg`, **Empfehlung**): Schild minimal breiter, Loch als 6-px-Scheibe mit kurzem Keil; liest sich in allen drei Tableisten als Loch, nicht als Strich.
  - **C „Gehängt“** (35° gedreht): eindeutig Preisschild, aber bei 16 px unruhige Kanten; nur als Alternative.
  Vergleich in echter Größe auf Chrome hell/dunkel und Firefox dunkel, 8-fach-Raster und 32 px: `favicon-compare.png` (1x) und `favicon-compare-2x.png`.
- **Fix (≈ 1–2 h):** (1) Zeile `<link rel="icon" href="/favicon.svg" … sizes="any">` in `frontend/index.html:10` entfernen (getestet: Chrome nimmt dann das ICO und je DPR den passenden Frame);
  (2) `frontend/public/favicon-16.svg` durch Variante B ersetzen, `npm run brand:icons` (`frontend/scripts/render-brand-icons.mjs`) baut PNG 16 und ICO neu;
  (3) 32-px-Frame bleibt die Masterzeichnung (oder `b-32.svg`, wenn der Owner Einheitlichkeit 16/32 bevorzugt); (4) Pixel der 16-px-Zeichnung abschließend von Hand prüfen.
  Alternative ohne HTML-Änderung: `favicon.svg` selbst durch die 16-px-Zeichnung ersetzen (dann auch auf HiDPI die vereinfachte Form).
- **Icon-Set:** Browser (ICO 16/32, SVG, PNG 16/32) vollständig; Apple-Touch 180 px vollflächig (iOS rundet) korrekt; Manifest mit 192/512, aber ohne `purpose: "maskable"`
  (Android legt das Icon sonst verkleinert auf eine Fläche) und ohne `id`. Unraid-Template verweist auf `keyhunter-appicon-512.png` über `raw.githubusercontent.com/.../main/...`
  (`deploy/unraid/keyhunter.xml:14`) – funktioniert, ist aber nicht versioniert. Darstellung bei 48/32/24 px auf hellem und dunklem Unraid-Theme einwandfrei (`appicon-unraid.png`).

## 6. Befunde

Format je Befund: Kategorie · Priorität · Ziel. Aufwand in Stunden. „Visuell“ = sichtbare Änderung, „0-Diff“ = ohne sichtbare Änderung (durch `deploy/visual-check.sh` prüfbar).

**DS-01 – Favicon liest sich bei 16 px als „1“** · Designsystem/Branding · **P1** · 1.0
- Nachweis: Abschnitt 5; `evidence/design/favicon/favicon-compare.png`; Auswahltest `favicon-configs.mjs`.
- Dateien: `frontend/index.html:9-12`, `frontend/public/favicon-16.svg`, `favicon-16.png`, `favicon.ico`, `frontend/scripts/render-brand-icons.mjs`.
- Ursache: SVG-Link mit `sizes="any"` überstimmt die optische 16-px-Variante; diese ist zudem zu fein. Auswirkung: Markenzeichen wirkt in jedem Tab wie ein Fehler/Badge.
- Verbesserung: SVG-Link entfernen, Variante B als 16-px-Zeichnung, ICO neu erzeugen. Aufwand 1–2 h. Risiko gering (nur Assets/HTML-Kopf).

**DS-02 – Text-Tokens `--faint`/`--muted` zu kontrastarm** · Designsystem/Farbe · **P2** · 1.0 (visuell)
- Nachweis: Tabelle 2.2; Zensus (18 Ansichten): 272 Textvorkommen in `--faint`, 366 in `--muted`; `fixes/contrast-*-before/after.png`.
- Dateien: `frontend/src/styles/tokens.css:22-23`; Verwendung u. a. `ui.css` (`th`), `shell.css` (`.nav-group > .label`, `.count`).
- Ursache: Prototyp-Werte auf Ästhetik abgestimmt; `--faint` wird für Text genutzt, obwohl es nur für Deko/Disabled taugt.
- Auswirkung: Tabellenköpfe und Einheiten schwer lesbar (WCAG 1.4.3 nicht erfüllt; Überschneidung mit Accessibility).
- Verbesserung: `--muted: #99938c` (≥ 4,57 : 1 auf allen Flächen), `--faint: #7d7770` (3,1–4,1 : 1, nur Deko/Disabled/große Schrift); Regel „Text nie in `--faint`“.
  Vorher/Nachher ist 1 : 1 dieser Token-Tausch im laufenden System. Aufwand 1–2 h inkl. Baseline-Update. Risiko gering, Hierarchie bleibt erhalten (Belege).

**DS-03 – Fokus in Feldern fast unsichtbar** · Designsystem/Zustände · **P2** · 1.0 (visuell)
- Nachweis: Fokus-Probe (ohne Ring: Listenfilter, Kopfsuche, Plattformwahl der Suche); `ui.css:74,76`, `shell.css:100,102` (`outline: none`, Rahmen `--line`→`--line-2`, Kontrast der beiden Linienfarben 1,18 : 1).
- Ursache: Feldrahmen-Optik des Prototyps übernommen, Fokuszustand nicht ergänzt. Auswirkung: Tastaturnutzer verlieren die Position; uneinheitlich zu allen anderen Controls.
- Verbesserung: `.field:has(:focus-visible), .search-box:has(:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }` (gleich dem globalen Ring). Aufwand 0,5–1 h. Risiko gering.

**DS-04 – Zustände uneinheitlich dargestellt** · Designsystem/Status · **P2** · 1.0 (visuell)
- Nachweis: „Ziel erreicht“ `PriceTab.tsx:81` (`hot`/`target`) gegenüber `GameDetail.tsx:62`, `WishlistRow.tsx:70`, `PriceAlerts.tsx:69` (`ok`/`check`); die Dev-Galerie zeigt die orange Version (`ui/Gallery.tsx:20`).
  „Veraltet“: `WishlistRow.tsx:76`/`PriceTab.tsx:82` (Pille `dim`/`clock`) gegenüber `Offers.tsx:42` + `offers.css:6` (gelber Text). Fehlender Preis: „–“, „Noch nicht abgefragt“ (`WishlistRow.tsx:53`), „noch nicht abgefragt“ (`Offers.tsx:40`).
- Ursache: Tonwahl je Feature, keine zentrale Zuordnung Zustand → Ton/Icon/Text. Auswirkung: Farbe verliert Bedeutung; Nutzer müssen Zustände je Ansicht neu lernen.
- Verbesserung: eine Zuordnung (z. B. in `features/price-badges.ts`): erreicht = `ok`/`check`; veraltet = `dim`/`clock` überall (auch Spalte „Gesehen“); pausiert = `warn`/`pause`;
  prüfen = `warn`/`alert`; Fehler = `danger`/`alert`; wird gesucht = `dim`/`refresh`; fehlender Wert in Tabellen immer „–“ mit Text nur in der Statusspalte. Aufwand 2–4 h. Risiko gering (Texte/Klassen; E2E-Selektoren prüfen).

**DS-05 – 70 Alt-Token-Aliase, 58 ungenutzt** · Designsystem/Tokens · **P2** · 1.0 (0-Diff)
- Nachweis: `inventory.md` „tokens“; `tokens.css:83-153`; einzige Nutzer `detail.css:8-12`.
- Ursache: Übergangsschicht aus der Migration auf v4, nie abgebaut. Auswirkung: zwei Namenssysteme, Verwechslungsgefahr, falsche Vorlagen für neuen Code.
- Verbesserung: `.gcover`-Block auf v4-Tokens umstellen, Alias-Block löschen. Aufwand 1 h. Risiko sehr gering.

**DS-06 – CSS-Ladereihenfolge der Feature-Dateien invertiert** · Designsystem/Architektur · **P2** · 1.0 (0-Diff, per Visual-Check bestätigen)
- Nachweis: Abschnitt 3 (Byte-Offsets); Importe `features/Cart.tsx:13`, `features/Library.tsx:8`, `features/SettingsPage.tsx:15`; Workaround `settings.css:4`.
- Ursache: `main.tsx` importiert `App` vor den Stylesheets; Vite ordnet CSS nach Modulgraph. Auswirkung: Spezifitäts-Workarounds, Regeln gewinnen zufällig.
- Verbesserung: alle Stylesheets zentral in `main.tsx` vor `App` importieren (tokens → fonts → base → app/ui → shell → Features). Aufwand 0,5–1 h. Risiko gering, mit Visual-Check absichern.

**DS-07 – Doppelte und widersprüchliche Regeln, falsche Fallbacks** · Designsystem/CSS · **P2** · 1.0 (0-Diff)
- Nachweis: Abschnitt 3; `inventory.md` (29 doppelte Selektoren, 7 Konflikte, 19 identische Wiederholungen).
- Ursache: Releases ergänzten Regeln in der jeweils bearbeiteten Datei. Auswirkung: Änderungen wirken nur teilweise; Pflegeaufwand.
- Verbesserung: je Regel genau ein Ort (Layout-Helfer in `shell.css`, `.save`/`.world-cell` in `ui.css`), Selbstüberschreibungen zusammenziehen, Fallbacks entfernen. Aufwand 2–3 h. Risiko gering.

**DS-08 – Visual-Regression deckt zu wenig ab, um aufzuräumen** · QA/Design · **P2** · 1.0 (vor DS-05/06/07)
- Nachweis: `frontend/e2e/visual/core-views.spec.ts` – 22 Aufnahmen (7 Ansichten × 3 Viewports), **22/22 bestanden**; nicht abgedeckt: Warenkorb, Alarme, Editionen, Alarm-Tab, Infos, 5 von 7 Einstellungstabs, Dialoge, Popups, Suche.
- Verbesserung: um diese Ansichten erweitern (Mock-Muster aus `evidence/design/scripts/mocks.ts.txt` übernehmbar). Aufwand 2–3 h. Risiko keins.

**DS-09 – Zwei Cover-Komponenten, drei Fallbacks, Farbformel in TSX** · Designsystem/Komponenten · **P2** · 1.0 (visuell, nur Spiele ohne Cover)
- Nachweis: `features/GameCover.tsx:9-10` (`.gcover`) und `features/catalog-ui.tsx:28-37` (`.game-cover`, `hsl()`-Verlauf inline); Größen 30×40 (`cart.css:14`), 34×44 (`wishlist.css:32`, `alerts.css:8`, `catalog.css:18`), 36 (`library.css:36`), 48×64 (`catalog.css:2`), 72×96 (`detail.css:39`); Screens `08-cart`, `09-library-grid`, `19-add-dialog`.
- Verbesserung: eine `Cover`-Komponente in `src/ui` mit `size` (`xs` 30×40, `sm` 34×44, `md` 48×64, `lg` 72×96, `fluid`) und einem Fallback (Initialen auf Verlauf; Farbformel in CSS über `--hue`). Aufwand 2–3 h. Risiko gering.

**DS-10 – Typo-Skala verlassen, synthetischer Fettdruck** · Designsystem/Typografie · P3 · 1.0 (minimal visuell)
- Nachweis: Abschnitt 2.3; Probe: Inter 700 in Warenkorb-Shopköpfen, JetBrains Mono 600 in `cart.css:45`, `offers.css:24`; `<small>` 10,83 px in Alarmen.
- Verbesserung: Tokens `--t-micro: 10px` und `--t-display: 22px` (Prototypwerte, keine Optikänderung); `b, strong { font-weight: 600 }` in `base.css`; Mono maximal 500; `small { font-size: var(--t-xs) }`. Aufwand 1–2 h. Risiko gering.

**DS-11 – Tote Klassen und Dev-Code im Produktions-CSS** · Designsystem/CSS · P3 · 1.0 (0-Diff)
- Nachweis: Abschnitt 3 (9 Klassen, `.toast`, `.gallery`, `ui/Toast.tsx`). Verbesserung: löschen; Galerie-CSS in die Galerie verlegen. Aufwand 0,5 h. Risiko sehr gering.

**DS-12 – Hinweis- und Meldungsstile zersplittert** · Designsystem/Komponenten · P3 · 1.1
- Nachweis: `Notice` (`components.tsx:11`, `app.css:4-6`), rohes `.note` an 7 Stellen in 5 Dateien (`ui.css:155`, `settings.css:30-32`), `.cart-extra` mit Volllinie Orange (`cart.css:24`), `.hint.bad`, `.fetch-error`, `.set-save-error`, Toaster.
- Verbesserung: Komponente `Note` mit `tone` (`info`/`warn`/`danger`) und optionalem Schließen; `Notice` und `.cart-extra` darin aufgehen lassen; Token `--warn-line`/`--danger-line` statt `color-mix`. Aufwand 2–3 h. Risiko gering.

**DS-13 – Größen-Wildwuchs: Icon-Buttons, Icons, Radien, Breakpoints** · Designsystem/Maße · P3 · 1.1
- Nachweis: 6 Icon-Button-Höhen, 5 Icon-Größen, 10 Radien, 3 Ausreißer-Breakpoints (Abschnitte 2.5–2.7).
- Verbesserung: `IconButton size="sm"` (28) / `md` (32), Icons 12/14/16, Radien `--r-xs` 4 und `--r-pill` 999 zusätzlich, 5 px → `--r-sm`; 560/520 → 720, 359 belassen und kommentieren. Aufwand 2–3 h. Risiko gering (pixelkleine Änderungen).

**DS-14 – Einstellungen: Speichermodell und Untertabs uneinheitlich** · UI/Layout · P3 · 1.1
- Nachweis: `12-…`, `14-…`, `15-settings-notifications-1440.png` (Kopf springt 2 px, zwei Speichermuster, drei Untertab-Positionen).
- Verbesserung: Kopfzeile reserviert die Höhe immer; Untertabs immer direkt unter dem Panelkopf; Speichermodell je Tab im Kopf ankündigen (UX-Detail in 05). Aufwand 2–4 h. Risiko mittel (E2E-Selektoren).

**DS-15 – Flächennutzung auf breiten Bildschirmen** · UI/Layout · P3 · 1.1
- Nachweis: `12-settings-general-1920.png`, `01-wishlist-1920.png` (Brotkrume x 256, Überschrift x 418).
- Verbesserung: Einstellungs-Panels auf ≈ 880 px begrenzen oder Formularzeilen zweispaltig; Kopfzeilen-Inhalt an der Seitenbreite ausrichten. Aufwand 2–3 h. Risiko gering.

**DS-16 – Mono und Sans ohne feste Regel gemischt** · Designsystem/Typografie · P3 · 1.1
- Nachweis: Abschnitt 4, Punkt 6 (`07-detail-infos`, `11-alerts`, `03-detail-angebote`, `08-cart`).
- Verbesserung: Regel „Mono nur für Beträge, Zähler, Codes, absolute Zeitstempel in Tabellen; relative Zeiten und Sätze in Sans“. Aufwand 1–2 h. Risiko gering.

**DS-17 – Zwei Dialog-Anatomien** · Designsystem/Komponenten · P3 · 1.1
- Nachweis: `24-confirm-dialog` (panel-2, 18 px Innenabstand, Titel 16 px, ohne Schließen) gegenüber `19-add-dialog` (panel, Kopfzeile 48 px mit Schließen, Titel 14 px); `app.css:14-25`, `catalog.css:30-32`, `detail.css:195-206`.
- Verbesserung: `Dialog`-Komponente (Titel, optional Schließen, Inhalt, Aktionen) für Confirm, Hinzufügen, Link-Prüfung, Ungespeichert. Aufwand 2–3 h. Risiko gering.

**DS-18 – Icon-Semantik uneinheitlich** · Designsystem/Icons · P3 · 1.1
- Nachweis: Entfernen mit `x` (`GameDetail.tsx:129`) gegenüber `trash` (`Library.tsx:139`, `Cart.tsx:123`, `InfosTab.tsx:33`); Legende „✓ — ?“ als Text (`EditionComparison.tsx:76`) neben SVG-Haken.
- Verbesserung: `trash` = löschen/entfernen, `x` = schließen/verwerfen; Legende mit `Icon`. Aufwand 0,5 h. Risiko keins.

**DS-19 – Grün für eine Produktart** · Designsystem/Farbe · P3 · 1.0
- Nachweis: `.kind-badge { color: var(--ok) }` (`catalog.css:11`), `19-add-dialog`, `20-search-popup`. Verbesserung: `--text-2`; Grün bleibt „gültig/erreicht“. Aufwand 0,25 h. Risiko keins.

**DS-20 – PWA/Unraid-Icon-Set unvollständig** · Branding/Deployment · P3 · 1.1
- Nachweis: `frontend/public/manifest.webmanifest` (kein `maskable`, kein `id`); `deploy/unraid/keyhunter.xml:14` (Icon über `main`-Branch).
- Verbesserung: `keyhunter-appicon-maskable-512.png` (Zeichen in 80-%-Schutzzone, vollflächig Orange) mit `"purpose": "maskable"`; Icon-URL auf Tag oder bewusst `main` dokumentieren. Aufwand 1 h. Risiko keins.

## 7. Vorschlag: einheitliches KeyHunter-Designsystem (Single Source of Truth)

Leitlinie: **zwei Ebenen, keine dritte.** Ebene 1 = Werte in `tokens.css` (Farben, Schrift, Form, Ebenen). Ebene 2 = Komponenten in `src/ui` mit genau einer
CSS-Regelgruppe in `ui.css`. Keine semantische Zwischenschicht, keine Aliase, keine Spacing-Skala um jeden Preis.

### 7.1 Tokens (`tokens.css`)
| Gruppe | Behalten | Ändern | Neu | Löschen |
|---|---|---|---|---|
| Flächen/Linien | 8 | – | – | – |
| Text | `--text`, `--text-2` | `--muted` → `#99938c`, `--faint` → `#7d7770` (nur Nicht-Text) | – | – |
| Akzent/Status | 13 | – | `--ok-line`, `--warn-line`, `--danger-line` (je `/ .35`) | – |
| Schrift | 8 Größen, 2 Familien | – | `--t-micro: 10px`, `--t-display: 22px` | – |
| Form | `--r-sm/md/lg`, `--h-btn` | – | `--r-xs: 4px`, `--r-pill: 999px`, `--h-btn-sm: 28px` | – |
| Schatten | 2 | – | `--shadow-raise` (Bibliotheks-Werkzeuge) | – |
| Ebenen | 5 | – | – | – |
| Breakpoints | `--bp-*` + `breakpoints.ts` + Test | – | – | – |
| Alt-Aliase | – | – | – | **alle 70** (nach DS-05) |

Abstände bleiben bewusst Literale aus dem Prototyp (388 Stellen; eine Umstellung brächte Optikänderungen ohne Nutzen). Regel stattdessen: neue Abstände nur aus {4, 6, 8, 10, 12, 14, 16, 20, 24}.

### 7.2 Komponenten (`src/ui`)
| Komponente | Varianten | ersetzt |
|---|---|---|
| `Button` + `as="a"` | default/primary/ghost/danger × md/sm | 5 rohe Link-Buttons, Popover-Trigger-Strings |
| `IconButton` | `size` md 32 / sm 28; ghost/primary/danger | 12 lokale Größen-Überschreibungen |
| `Pill` + Zustandszuordnung | 6 Töne, eine Funktion Zustand → Ton/Icon/Text | Tonwahl in 5 Features (DS-04) |
| `Note` | info/warn/danger, schließbar | `Notice`, rohes `.note` ×7, `.cart-extra` |
| `Dialog` | mit/ohne Schließen, Aktionenleiste | 4 Dialog-Varianten |
| `Cover` | xs/sm/md/lg/fluid, ein Fallback | `GameCover` + `catalog-ui` `Cover` |
| `Field` | Fokusring wie alle Controls | DS-03 |
| Tabelle | Basis bleibt; Karten-Umbau < 720 px als dokumentiertes Muster | – (kein Umbau nötig) |

### 7.3 Zusammenführen und Löschen (Dateien)
- `app.css` (Dialog, Notice, Skip-Link, Formularzeile) in `ui.css` aufgehen lassen; `pages.css` → `auth.css` (nur Anmeldung, `.alert-form` löschen).
- `.grid-2`, `.stack` nur in `shell.css`; `.save`, `.world-cell`, `.form-row > label`, `.search-hint` nur in `ui.css`; Selbstüberschreibungen in `app.css:21-24`, `cart.css:36-40`, `shell.css:119-120` zusammenziehen.
- Löschen: Alias-Block `tokens.css:83-153`, 9 tote Klassen, `ui/Toast.tsx` + `.toast`, Fallbacks `library.css:32`, `cart.css:46`.
- Importe: alle Stylesheets nur in `main.tsx`, vor `App`; CSS-Importe aus `Cart.tsx`, `Library.tsx`, `SettingsPage.tsx` entfernen.

### 7.4 Leitplanken (einfach, ohne neue Abhängigkeiten)
Ein Node-Test nach dem Vorbild von `tests/breakpoints.test.ts`, der per Regex fehlschlägt bei: Farbliteralen außerhalb `tokens.css`, `var(--x, fallback)`,
unbekannten Tokens, `!important` außerhalb des Reduced-Motion-Blocks, CSS-Importen außerhalb `main.tsx`. Logik liegt in `evidence/design/scripts/inventory.mjs`.

### 7.5 Reihenfolge, Nutzen, Aufwand
1. **Sicherheitsnetz** DS-08 (2–3 h).
2. **0-Diff-Bereinigung** DS-05, DS-06, DS-07, DS-11 (4–6 h): Visual-Check muss unverändert grün sein.
3. **Sichtbare Korrekturen für 1.0** DS-01, DS-02, DS-03, DS-04, DS-09, DS-10, DS-19 (8–14 h): Baselines neu, Owner-Abnahme anhand der Screenshots.
4. **1.1:** DS-12 bis DS-18, DS-20 (12–20 h).

Nutzen: jede Farbe, Größe und Zustandsdarstellung hat genau einen Ort; neue Ansichten entstehen aus Komponenten statt aus lokalem CSS. Das CSS schrumpft um geschätzt 5–6 KB von 63 KB (≈ 8 %) –
für die Ladezeit unerheblich, der Gewinn ist Wartbarkeit und Konsistenz. Betroffene Dateien: alle 15 Stylesheets, `src/ui/*`, `components.tsx`, `GameCover.tsx`, `catalog-ui.tsx`,
`PriceTab.tsx`, `Offers.tsx`, `WishlistRow.tsx`, `Cart.tsx`, `Library.tsx`, `SettingsPage.tsx`, `index.html`, `public/*`.

## 8. Vorschau (Preview)

**Es wurde kein Preview unter `work/release-1.0-design-preview/` gebaut.** Begründung: Der Vorschlag enthält **keine großen Design- oder Layoutänderungen**. Das Gerüst,
die Panel-Sprache, Farben und Schriften bleiben; die Hälfte der Arbeit ist 0-Diff-Bereinigung, die übrigen sichtbaren Punkte sind Detailkorrekturen. Ein vollständiger
Preview-Build hätte für den Owner kaum mehr gezeigt als die vorhandenen Belege:
- Favicon: `evidence/design/favicon/favicon-compare.png` und `-2x.png` (heutiger Stand, A, B, C in echter Tab-Größe).
- Kontrast-Tokens (sichtbarste globale Änderung): `evidence/design/fixes/contrast-{wishlist,detail-preis,settings-status}-{before,after}.png` – im laufenden System per CSSOM
  mit genau den vorgeschlagenen Token-Werten erzeugt, also 1 : 1 das spätere Ergebnis.
Sollte der Owner DS-14/DS-15 (Einstellungs-Layout) in 1.0 ziehen, ist dafür ein Preview sinnvoll.

## 9. UX aus Sicht eines Endanwenders

„siehe 05_RESPONSIVE_VISUAL_AUDIT.md, Abschnitt UX“

## 10. Geprüfte Befehle und Grenzen

**Ausgeführt (alle Skripte in `evidence/design/scripts/`):**
- `node inventory.mjs frontend evidence/design/inventory` – 15 Stylesheets, 805 Regeln, 2 425 Deklarationen, 369 Klassen, 118 Tokens.
- Fixture `catalog_fixture` auf 127.0.0.1:38782 mit `KEYHUNTER_FIXTURE_PRICES=1`, eigene Datenverzeichnisse (danach gelöscht).
- Playwright (Projekt `e2e`, eigene Wegwerf-Specs in `frontend/e2e/tmp-audit-ds/`, nach dem Audit gelöscht; Kopien als `.txt` in `scripts/`):
  `shots.spec.ts` (37 Screenshots: 27 bei 1440, 10 bei 1920, alle Läufe grün), `census.spec.ts` (18 Ansichten), `probe.spec.ts` (Schriftausreißer),
  `focus.spec.ts` (2 × 26 Tab-Stopps), `fixes.spec.ts` (6 Vorher/Nachher-Ausschnitte).
- `node favicon-pick.mjs` / `favicon-configs.mjs` (Chromium voll, DPR 1 und 2, 4 Link-Sätze; Ergebnis Tabelle Abschnitt 5), `node favicon-compare.mjs` (3 PNG).
- Visual-Regression wie `deploy/visual-check.sh`, aber mit eigenem Port und Ausgabeordner: `docker run … mcr.microsoft.com/playwright:v1.65.1-noble npx playwright test --project=visual --output=<scratch>` – **22 passed**.
- `docker run --rm --entrypoint /bin/sh keyhunter:0.9.1 -c 'find / -name "favicon*" …'` – alle Icons unter `/app/frontend/`.
- Kontrastwerte per WCAG-Formel (Python) für 10 Text-Tokens × 5 Flächen.

**Grenzen / nicht verifiziert:**
- Favicon-Auswahl nur für Chromium belegt. Firefox ist nicht installiert, WebKit startete in dieser Umgebung nicht – Verhalten von Firefox/Safari **nicht verifiziert**
  (bekannt: Safari nutzt kein SVG-Favicon, daher dort ohnehin PNG/ICO). Die Tableisten sind nachgebildet; ein echter Browser-Tab mit Fensterrahmen ließ sich headless nicht aufnehmen.
- Cover sind synthetische Platzhalter; echte IGDB-Cover und echte Shopdaten wurden nicht abgerufen (Audit-Regel).
- Die Einrichtungsseite wurde nicht neu aufgenommen (vorhandene Baseline `setup-*.png` im Repo); Viewports unter 1440 px liegen bei 05.
- Die Suche nach ungenutzten Klassen ist eine Wortsuche in TS/TSX; dynamisch gebildete Klassennamen wurden stichprobenartig geprüft (`lv-*`).
- Zensus nur bei 1440 × 900; Hover-Zustände wurden in Screenshots (Menü, Hilfe) und im CSS geprüft, nicht systematisch gemessen.

## Nachtrag des Leads: 1:1-Vorschau

Für dieses Kapitel war keine Vorschau nötig, die Änderungen hier sind überwiegend klein. Zusammen mit den Layoutbefunden aus 05 (RESP-01 bis RESP-09, RESP-12, RESP-16, RESP-18) und DS-01/02/03 ergeben sich aber große sichtbare Änderungen. Dafür gibt es jetzt eine **1:1-Vorschau** außerhalb des Repos:

- **Ort:** `/home/sysadmin16/projects/keyhunter/work/release-1.0-design-preview/`. Darin: `README.md` mit Startanleitung und offenen Fragen, `CHANGES.diff`, 36 Vorher/Nachher-Screenshots, Messwerte.
- **Messwerte vorher → nachher:**
  - Angebote-Tabelle bei 375 / 768 / 1366 px ohne inneren Überlauf; Aktionen sichtbar 0/22 → 22/22.
  - Öffnen-Knöpfe der Wunschliste bei 768 px 0/13 → 13/13.
  - Phone-Karten: Titelbreite 0 → 193 px, Überlappungen 2 → 0.
  - Touch-Ziele unter 44 px bei 375 px: 36 → 2.
- **Tests:** Frontend-Unit 71/71. E2E 73/73 mit drei beabsichtigten Testanpassungen (im Diff). Visual 19/22, die drei Abweichungen sind beabsichtigt.
- **Beabsichtigte Abweichungen von diesem Dokument:** DS-04 und DS-19 sind nicht in der Vorschau enthalten (offene Frage im README). Die Spaltenumschaltung von Wunschliste und Angeboten folgt der eigenen Breite der Liste (Container Query) statt dem Viewport, weil die Seitenleiste die Liste bei 1024 px schmaler macht als bei 768 px.
