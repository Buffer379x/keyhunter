# 05 – Responsive Design, visuelle Browser-Prüfung und Endanwender-UX (Release-1.0-Audit, KeyHunter 0.9.1)

Prüfer: Responsive/UX-Audit (`RESP`), Port 38783. Stand: Branch `audit/release-1.0` = Tag 0.9.1 (490a8fb). Rein analytisch, nichts am Anwendungscode geändert.
Belege: `docs/release-1.0-audit/evidence/responsive/` (Kontaktbögen `sheet-*.png`, Einzelbelege `r01…r21`, Messwerte `messwerte.csv`, `axe-verstoesse.csv`, `kontrast-paare.csv`).

## 0. Kurzfazit

- **Desktop ab 1366 px ist solide.** In keiner der 240 Messungen läuft das Dokument horizontal über. Navigation, Dialoge, Menüs, Hilfe-Popups und Toasts sitzen korrekt. Die Preis-Erklärung („Warum dieser Preis zählt“, „Indien spart 16,00 € … Aktivierung ungeklärt“) ist für den Kernanwendungsfall gut.
- **Smartphones (375/430 px) und Tablet hochkant (768 px) haben in den Kernansichten bestätigte Layoutfehler.** Die Wunschlisten-Karten quetschen den Titel auf ≈ 75 px (RESP-01). Die Angebote-Tabelle zeigt nur Shop und eine halbe Region; Preis, Gültigkeit und „Zum Shop“ liegen außerhalb, ohne Scroll-Hinweis. Auch bei 1366×768 sind „Zum Shop“ und Warenkorb abgeschnitten (RESP-02). Auf 768 px liegt der einzige Öffnen-Knopf der Wunschliste außerhalb des Bildschirms (RESP-03). WebKit zeigt dieselben Fehler (`r21-webkit-375.png`).
- **Weitere Phone-Defekte:**
  - Die Detailseite lässt sich seitlich verschieben, weil die Diagrammtabelle für Screenreader eine `.sr-only`-Tabelle mit Breite ist (RESP-04).
  - Tab-Leisten verstecken Tabs ohne Hinweis; der aktive Tab bleibt unsichtbar (RESP-05).
  - Das Pausieren-Menü ist links abgeschnitten (RESP-06).
  - Der Kopf des Suchpopups ist zerdrückt (RESP-07).
- **Accessibility:**
  - Gut: Skip-Link, Dialoge mit Escape und Fokus-Rückgabe, Menüs und Tabs mit Pfeiltasten, Live-Regionen, Datentabelle hinter dem Diagramm, Reflow bei 200 %.
  - Schwach: axe meldet Kontrastfehler in **19 von 19** Desktop-Ansichten (227 Knoten). Der Drawer ist für die Tastatur nicht modal (RESP-08). Der Fokus in Textfeldern ist praktisch unsichtbar (bestätigt DS-03). Touch-Ziele sind meist 24–38 px (RESP-09).
- **UX:**
  - Die Journey des Eigentümers ist am Desktop effizient: **6 Aktionen** bis zum gespeicherten Alarm, 11 mit erstem Benachrichtigungskanal.
  - Plattform und Edition sind nicht überall erkennbar; „Forza Horizon 5“ für Series X|S und für Xbox One sind in Liste, Warenkorb und Alarmen gleich (RESP-10).
  - Ein fehlgeschlagener Abruf erscheint im Detail wie „noch keine Angebote“ (RESP-11).
  - „Gekauft“ wirkt sofort und ohne Rückgängig (RESP-13).
  - Die Ersteinrichtung setzt Datei- und Twitch-Wissen voraus (RESP-15).

| Bereich | Bewertung | Begründung (Kurz) |
|---|---|---|
| Responsive Design | **5/10** | Kein Dokument-Overflow und gute Desktop-Layouts. Auf Phone und Tablet sind aber drei Kernansichten (Liste, Angebote, Tablet-Liste) nur eingeschränkt nutzbar (RESP-01…07). |
| Accessibility | **5/10** | Die Grundlagen stimmen (Landmarks, Skip-Link, Dialoge, Tabs). Dagegen stehen flächige AA-Kontrastfehler, unsichtbarer Feldfokus, ein nicht modaler Drawer und kleine Touch-Ziele. |
| UX / Benutzerfreundlichkeit | **6/10** | Der Kernablauf ist kurz und gut erklärt. Abzüge gibt es für die Phone-Nutzung, die Kommunikation fehlgeschlagener Abrufe, die Plattform-Mehrdeutigkeit, versteckte Funktionen und Hürden beim Erststart. |

## 1. Methode und Datengrundlage

**Instanz und Daten**
- **Instanz:** `catalog_fixture` (Debug-Build aus `work/check/target`) mit `frontend/dist` (0.9.1), `127.0.0.1:38783`.
- **Erster Durchlauf:** frisches Datenverzeichnis, Einrichtung über die echte Oberfläche.
- **Journeys:** zweite frische Instanz (Abschnitt 6).
- **Seed über die echte API:**
  - 20 Wünsche:
    - Forza Horizon 5 für Series X|S und für Xbox One;
    - die Premium Edition;
    - zwei sehr lange Titel (Xbox 360 und Xbox One), einer davon pausiert;
    - Starfield;
    - Halo MCC;
    - Lies of P;
    - 12 weitere manuelle Titel.
  - 3 Alarmregeln, 4 Warenkorb-Einträge, 4 Bibliothekseinträge (Series X|S, One, 360, Original-Xbox).
- **Gemockt per `page.route`** (die Fixture hat keine Shoppreise): Angebote mit 8 Links. Darunter sind Indien (Aktivierung ungeklärt), Argentinien (gesperrt), Global/DE (gültig), Europa (ausverkauft), Türkei (veraltet, 9 Tage), Abruffehler und eine Zuordnung zur Prüfung. Dazu kommen 120 Tage Verlauf mit Lücken, Preisbadges (Preis, veraltet, kein Angebot, Fehler, Prüfung, sucht), Abrufstatus, Läufe, Log, Alarmübersicht und Warenkorb-Angebote.
- **Mock-Werte:** nur die echten Shops Eneba und Driffle. Suchstatus-Werte wie im Backend (`offers.rs:433`: `error`, `searching` …).

**Prüfungen**
- **Viewports:** 375×812, 430×932, 768×1024 (alle drei mit `hasTouch`; 375/430 zusätzlich `isMobile`), 1366×768, 1920×1080, 2560×1440. Alles in Chromium (Playwright 1.65.1); Smoke-Test in WebKit (Playwright-Image `v1.65.1-noble`).
- **Messung je Ansicht:**
  - Dokument-Overflow (`scrollWidth > innerWidth`);
  - horizontaler Overflow von `#main-content`;
  - innere horizontale Scrollbereiche;
  - Elemente außerhalb des Viewports;
  - Touch-Ziele < 24 px und < 44 px;
  - Ellipsen;
  - Textüberlappungen (heuristisch, visuell gegengeprüft).
- **Umfang:** 32 Ansichten und Zustände × 6 Viewports (185 Messungen), 14 Fehler-, Lade- und Leerzustände × 2 Viewports, Zoom 200 %/400 %, Journeys, 3 WebKit-Messungen: 240 Messungen, über 300 Screenshots, alle Kernansichten selbst angesehen.
- **Tastatur:** Tab-Folgen (60 Stopps Liste, 45 Detail), Escape-Verhalten aller Overlays, Drawer-Fokus.
- **axe-core 4.10.3:** per `npm pack` in einen Scratch-Ordner geladen und mit `addScriptTag({ path })` injiziert, `bypassCSP`. Regeln: WCAG 2.0/2.1/2.2 A+AA und Best Practice. 19 Ansichten × 2 Viewports.
- **Journeys:** Klicks und Eingaben gezählt, auf frischer Instanz, Desktop und Phone.

## 2. Viewport-Matrix

`ok` = visuell und gemessen ohne Befund. Eine ID bedeutet bestätigtes Problem. `–` = Ansicht in diesem Viewport nicht vorhanden.

| Ansicht | 375 | 430 | 768 | 1366 | 1920 | 2560 |
|---|---|---|---|---|---|---|
| Einrichtung / Anmeldung / Offline | ok | ok | ok | ok | ok | ok |
| Wunschliste (Zeilen/Karten) | RESP-01, -17 | RESP-01 | **RESP-03** | ok | ok | ok (DS-15) |
| Wunschliste leer / Filter ohne Treffer | ok | ok | ok | ok | ok | ok |
| Detail · Preis | RESP-04, -05 | RESP-05 | ok | ok | ok | ok |
| Detail · Angebote | **RESP-02**, -05 | **RESP-02**, -05 | RESP-02 | **RESP-02** | ok | ok |
| Detail · Verlauf (Diagramm) | RESP-04, -05, -21 | RESP-05 | ok | ok | ok | ok |
| Detail · Editionen | RESP-05 | RESP-05 | ok | ok | ok | ok |
| Detail · Alarm | RESP-05 | RESP-05 | ok | ok | ok | ok |
| Detail · Infos | RESP-05 | RESP-05 | ok | ok | ok | ok |
| Detail langer Titel / pausiert / sucht | RESP-04 | RESP-04 | ok | ok | ok | ok |
| Pausieren-Menü | **RESP-06** | **RESP-06** | ok | ok | ok | ok |
| ⋯-Menü, Bestätigungsdialog, Toast | ok | ok | ok | ok | ok | ok |
| Warenkorb | ok | ok | ok | ok | ok | ok |
| Bibliothek | ok | ok | ok | ok | ok | ok |
| Preisalarme | ok | ok | ok | ok | ok | ok |
| Einstellungen (7 Tabs) | RESP-05 | RESP-05 | RESP-05 („System“ unsichtbar) | ok | ok | ok |
| Einstellungen · Abrufstatus / Log | RESP-05, -20 | RESP-05, -20 | ok | ok | ok | ok |
| Dialog „Spiel hinzufügen“ | – (kein Button, RESP-16) | – | ok | ok | ok | ok |
| Suchpopup in der Top-Bar | **RESP-07** | **RESP-07** | ok | ok | ok | ok |
| Drawer-Navigation | RESP-08 | RESP-08 | RESP-08 | – | – | – |
| Hilfe-Popups | ok | ok | ok | ok | ok | ok |

Kontaktbögen je Ansicht über alle 6 Viewports: `sheet-wishlist.png`, `sheet-detail-preis.png`, `sheet-detail-angebote.png`, `sheet-cart.png`, `sheet-library.png`, `sheet-alerts.png`, `sheet-settings-status.png`, `sheet-search-popup.png`, `sheet-pause-menu.png`.

## 3. Messergebnisse (Auszug; vollständig in `messwerte.csv`)

| Messung | Ergebnis |
|---|---|
| Dokument-Overflow (`documentElement.scrollWidth > innerWidth`) | **0 von 240** Messungen (inkl. Zustände, Zoom, Journeys, WebKit) |
| `#main-content` horizontal verschiebbar | 17 Fälle, alle Detailseiten auf 375 px (403–437/375), manuelle Titel auch auf 430 px (437/430), WebKit 391/375 → RESP-04 |
| Angebotstabelle `table.offers` | 1228 px breit; sichtbar 319 px (375), 374 (430), 712 (768), **1074 (1366)** → RESP-02 |
| Wunschliste-Tabelle 768 px | 977 px Inhalt in 712 px; Öffnen-Knopf bei x = 974–984 → RESP-03 |
| Tab-Leisten | Detail 465/335 (375), 465/390 (430); Einstellungen 808/335 (375), 808/712 (768) → RESP-05 |
| Suchpopup ≤ 720 px | innerer Scroll 717/657 (Zoom 200 %), 354/294 (Zoom 400 %) → RESP-07 |
| Touch-Ziele < 24 px (375) | Sortierknöpfe der Kartenansicht 37–69 × **17 px** (axe `target-size`). Hilfe-„?“ 20–22 px. Switch 30×18. „Anzeigen“-Summary 18 px hoch. „1 Zuordnung prüfen“ 18 px. Zeilen-Titel 20 px hoch |
| Touch-Ziele < 44 px (375) | Fast alle Bedienelemente: Menü 32×32, Detailaktionen 32 hoch, Tabs 38, Chips 28, DE/INT-Segment 24, Details-Knopf 28×28 → RESP-09 |

## 4. Befunde

Kennzeichnung: **[B]** bestätigt (reproduziert/gemessen), **[R]** begründetes Risiko, **[S]** subjektiver Vorschlag.

### RESP-01 – Wunschlisten-Karten auf Smartphones zerquetscht [B]
- **Kategorie:** Responsive. **Priorität:** P1.
- **Beschreibung:** Bis 720 px werden Zeilen zu Karten. Die zweite Grid-Spalte nimmt die Status-Pillen auf („Wird gesucht …“ + „Ungeprüft“) und wird dadurch ≈ 220 px breit. Für den Titel bleiben ≈ 75 px:
  - jedes Wort steht in einer eigenen Zeile;
  - „Manuell · Xbox Series X|S (0 Angebote)“ belegt 6 Zeilen;
  - eine Karte ist 250–420 px hoch;
  - beim pausierten Eintrag überlappen „Noch nicht abgefragt“ (Spalte INT) und die gleichlautende Pille.

  Preise stehen ohne Beschriftung in der Karte. Welcher Betrag „Preis DE“ und welcher „Preis INT“ ist, steht nur in der Sortierleiste darüber.
- **Nachweis:** `r01-wishlist-375-karten.png`, `sheet-wishlist.png` (375/430), WebKit `r21-webkit-375.png`.
- **Dateien:** `frontend/src/styles/wishlist.css:55-79` (v. a. `:66` `grid-template-columns: minmax(0,1fr) auto auto; grid-template-areas: "g p d" "w s d"`), `features/WishlistRow.tsx`.
- **Ursache:** Status (`s`) und Preis DE (`p`) teilen sich die `auto`-Spalte; die Pillen bestimmen deren Breite.
- **Auswirkung:** Die Hauptansicht ist auf dem Phone kaum lesbar. 20 Einträge ergeben ≈ 5000 px Scrollhöhe.
- **Verbesserung:** Kartenraster umbauen:
  - Zeile 1: Titel über volle Breite + Details-Knopf;
  - Zeile 2: „DE 28,90 €“ | „INT 12,90 € 🇮🇳“ mit Kurzlabel;
  - Zeile 3: Status-Pillen mit Umbruch.

  Doppelte Aussagen (Pille + INT-Text „Noch nicht abgefragt“) auf der Karte nur einmal zeigen. Visual-Baseline `wishlist-390` mit mehreren und langen Einträgen ergänzen.
- **Aufwand:** 3–5 h. **Risiko:** gering bis mittel (nur CSS + Labels; Baselines neu). **Ziel:** 1.0.

### RESP-02 – Angebote-Tabelle auf Phone und Tablet unbrauchbar, bei 1366×768 abgeschnitten [B]
- **Kategorie:** Responsive. **Priorität:** P1.
- **Beschreibung:** `table.offers` hat 8 Spalten mit `white-space: nowrap` und ist 1228 px breit. Sichtbar sind:
  - auf 375 px nur Shop und eine halbe Region; Preis, Gültigkeit, Abstand, Score, Gesehen, Warenkorb und „Zum Shop“ erst nach seitlichem Wischen, ohne Scroll-Hinweis;
  - auf 768 px fehlen die Aktionen;
  - auf **1366×768** (häufigste Laptop-Auflösung) sind Warenkorb-Knopf und „Zum Shop“ abgeschnitten.

  Die committete Visual-Baseline `e2e/visual/core-views.spec.ts-snapshots/angebote-390-visual-linux.png` zeigt genau diesen Zustand und macht ihn damit zum Sollbild.
- **Nachweis:** `r03-angebote-375-tabelle.png`, `r04-angebote-1366-spalten-abgeschnitten.png`, `sheet-detail-angebote.png`, `messwerte.csv` (`detail-angebote`).
- **Dateien:** `features/Offers.tsx:60-97`, `styles/offers.css:3`, `features/offers-columns.ts:5`.
- **Ursache:** Es gibt keine responsive Variante, und alle Zellen sind `nowrap`. Die Score-Spalte (intern) verbraucht zusätzlich Breite.
- **Auswirkung:** Der Kernvergleich (welche Region, welcher Preis, gültig in DE?) ist auf dem Phone praktisch nicht ablesbar. Am Laptop fehlen die Kaufaktionen.
- **Verbesserung:**
  - ≤ 720 px gestapelte Zeilen: Shop · Region-Flagge / Preis + Δ / Gültigkeits-Pille / Aktionen.
  - ≤ 1440 px „Score“ und „Gesehen“ in eine Sekundärzeile legen oder Score standardmäßig ausblenden (RESP-19).
  - Aktionen-Spalte rechts fixieren (`position: sticky`).
  - Baseline `angebote-390` neu abnehmen.
- **Aufwand:** 4–8 h. **Risiko:** mittel (Spalten-Konfiguration aus 0.8.2 muss weiter wirken). **Ziel:** 1.0.

### RESP-03 – Tablet hochkant (721–900 px): Öffnen-Knopf der Wunschliste außerhalb des Bildschirms [B]
- **Kategorie:** Responsive. **Priorität:** P1.
- **Beschreibung:** Zwischen 721 und 900 px bleibt die Wunschliste eine Tabelle mit 977 px Inhalt in einem 712 px breiten Container. Status, „14 Tage“ und der Details-Knopf liegen rechts außerhalb. Der Details-Knopf ist in der Standardeinstellung der **einzige** Weg in die Detailseite. Es gibt keinen Scroll-Hinweis.
- **Nachweis:** `r02-wishlist-768-tabelle-abgeschnitten.png`. Messung: `button.row-open` bei x = 974–984 bei 768 px Viewport.
- **Dateien:** `styles/wishlist.css:55` (Karten erst ab ≤ 720), `styles/offers.css:27` (`.game-cell { min-width: 220px }`), `features/wishlist-columns.ts:41` (Standard-Öffner `button`).
- **Auswirkung:** Auf einem iPad hochkant lässt sich ohne Wischen kein Spiel öffnen.
- **Verbesserung:** Kartenlayout bis zum Drawer-Breakpoint (900 px) gelten lassen, oder zwischen 721 und 1100 px „Ersparnis“ und „14 Tage“ ausblenden. Zusätzlich RESP-12 (Titel öffnet).
- **Aufwand:** 1–3 h. **Risiko:** gering. **Ziel:** 1.0.

### RESP-04 – Detailseite auf Smartphones seitlich verschiebbar [B]
- **Kategorie:** Responsive/Bug. **Priorität:** P2.
- **Beschreibung:** Die Datentabelle hinter dem Preisdiagramm trägt `.sr-only`. Bei `<table>` greifen `width: 1px` und `overflow: hidden` nicht (Tabellen nehmen ihre Inhaltsbreite). Die Tabelle ist 364–398 px breit, deshalb wird `#main-content` 403–437 px breit. Auf 375 px (manuelle Titel auch 430 px) lässt sich die ganze Detailseite bis zu 62 px seitlich verschieben, der Inhalt wird links abgeschnitten.
- **Nachweis:** `r05-detail-375-seitlich-verschiebbar.png` (nach `scrollTo({left})`). Messung: `table.sr-only` 39..437, w = 398; WebKit 391/375.
- **Dateien:** `features/PriceMatrix.tsx:95`, `styles/base.css:49`.
- **Auswirkung:** Die Seite „wackelt“ beim Wischen. Wirkt unfertig und lässt Inhalte schief stehen.
- **Verbesserung:** Die Tabelle in ein `<div className="sr-only">` legen (das Div clippt) oder `.sr-only` um `display:block` für Tabellen ergänzen. Optional `.content { overflow-x: clip }` als Sicherheitsnetz.
- **Aufwand:** 0,5–1 h. **Risiko:** gering. **Ziel:** 1.0.

### RESP-05 – Tab-Leisten verstecken Tabs ohne Hinweis; aktiver Tab bleibt unsichtbar [B]
- **Kategorie:** Responsive/UX. **Priorität:** P2.
- **Beschreibung:** `.tabs` scrollt horizontal mit unsichtbarer Scrollleiste. Unsichtbar bleiben:
  - auf 375 px die Detail-Tabs „Alarm“ und „Infos“;
  - in den Einstellungen „Benachrichtigungen“, „Abrufstatus“, „Log“ und „System“;
  - auf 768 px „System“.

  Wird ein Tab per Knopf oder URL aktiviert (z. B. „Ziel setzen“ → Alarm), scrollt die Leiste nicht mit. Gemessen: Tab „Alarm“ x = 352–412, Leiste endet bei 355.
- **Nachweis:** `r08-alarm-tab-375-unsichtbar.png`, `r09-einstellungen-375-tabs.png`.
- **Dateien:** `styles/ui.css:91-92` (`scrollbar-width: none`), `ui/Tabs.tsx` (kein `scrollIntoView` im gesamten Frontend).
- **Auswirkung:** Phone-Nutzer finden Benachrichtigungen und Abrufstatus nicht und wissen nicht, wo sie sind.
- **Verbesserung:** Ausgewählten Tab mit `scrollIntoView({ inline: 'nearest', block: 'nearest' })` sichtbar machen. Rechts einen Verlaufsrand bzw. Chevron zeigen, solange `scrollWidth > clientWidth`. Für die 7 Einstellungs-Tabs ≤ 720 px ein `<select>` verwenden.
- **Aufwand:** 1–3 h. **Risiko:** gering. **Ziel:** 1.0.

### RESP-06 – Pausieren-Menü auf Smartphones links abgeschnitten [B]
- **Kategorie:** Responsive/Bug. **Priorität:** P2.
- **Beschreibung:** Auf 375 und 430 px bricht „Pausieren“ in die zweite Aktionszeile nach links um. Das Menü ist `align="end"` (rechtsbündig zum Knopf) und ragt links aus dem Bildschirm. Sichtbar sind nur „…ne“, „…hen“, „… fortsetze“.
- **Nachweis:** `r06-pausemenue-375-abgeschnitten.png`, `sheet-pause-menu.png` (ab 768 ok).
- **Dateien:** `features/GameDetail.tsx:117`, `features/Popover.tsx` (keine Viewport-Begrenzung), `styles/detail.css:16-21`.
- **Verbesserung:** Popover wie `ui/Help.tsx` an den Viewport klemmen (Position messen, Kante 8 px) oder ≤ 720 px als Bottom-Sheet zeigen.
- **Aufwand:** 1–2 h. **Risiko:** gering. **Ziel:** 1.0.

### RESP-07 – Kopf des Suchpopups ≤ 720 px zerdrückt [B]
- **Kategorie:** Responsive/Bug. **Priorität:** P2.
- **Beschreibung:** Auf 375/430 px wird „Suche · IGDB“ zu „s“. Das Schließen-X steht links vor der Plattformauswahl, und das Popup scrollt horizontal (717/657 px bei Zoom 200 %).
- **Nachweis:** `r07-suchpopup-375-kopf.png`, `sheet-search-popup.png`.
- **Dateien:** `styles/shell.css:116` (`.search-pop-head { flex-wrap: nowrap }`) widerspricht `styles/shell.css:147` (`.search-platform { flex: 1 0 100% }`).
- **Verbesserung:** Bis 720 px `flex-wrap: wrap`, das X bleibt rechts oben.
- **Aufwand:** 0,5 h. **Risiko:** gering. **Ziel:** 1.0.

### RESP-08 – Drawer-Navigation für die Tastatur nicht modal [B]
- **Kategorie:** Accessibility. **Priorität:** P2.
- **Beschreibung:** Bis 900 px ist die Seitenleiste ein Drawer mit Scrim. Öffnen und Escape funktionieren, und der Fokus geht zurück auf „Menü öffnen“. Es fehlt aber eine Fokusfalle, und `.main` ist nicht `inert`. Nach 7 Tab-Stopps wandert der Fokus hinter den Scrim:
  - Menü-Knopf;
  - Suchfeld (öffnet das Suchpopup hinter dem Drawer);
  - Plattform;
  - „Spiel hinzufügen“;
  - „Hilfe zur Wunschliste“.

  Das Hilfe-Popup der verdeckten Seite legt sich über den Drawer. Das erste Escape schließt nur dieses Popup, erst das zweite den Drawer.
- **Nachweis:** `r14-drawer-768-fokus-entweicht.png`. `keyboard-drawer.json`: `drawerOpenAfterEsc1: 1`, `mainInert: inert=false`.
- **Dateien:** `App.tsx:178-184`, `styles/shell.css:131-141`, `ui/Help.tsx:47-50` (öffnet bei Fokus, `stopPropagation` auf Escape).
- **Verbesserung:** Bei `navOpen` `inert` auf `.main` setzen. Die Seitenleiste im Drawer-Modus `role="dialog" aria-modal="true"` geben.
- **Aufwand:** 1–2 h. **Risiko:** gering. **Ziel:** 1.0.

### RESP-09 – Touch-Ziele für Phones zu klein; keine Anpassung für grobe Zeiger [B]
- **Kategorie:** Accessibility/Responsive. **Priorität:** P2.
- **Beschreibung:** WCAG 2.5.8 (24 px) verfehlen:
  - die Sortierknöpfe der Kartenansicht (17 px hoch, axe `target-size` serious);
  - der Switch (30×18);
  - „Anzeigen“ in den Editionen (18 px);
  - „1 Zuordnung prüfen“ (18 px);
  - die Hilfe-„?“ (20–22 px, durch Abstand formal noch zulässig).

  Die 44-px-Empfehlung für Touch verfehlen fast alle Elemente: Menü 32×32, Detailaktionen 32, Tabs 38, Chips 28, DE/INT 24, Details-Knopf 28×28. Es gibt nur `@media (pointer: coarse) { .kbd { display: none } }`.
- **Nachweis:** `messwerte.csv` (Spalten `ziele_unter_24px`, `ziele_unter_44px`), `axe-verstoesse.csv` (`target-size`).
- **Dateien:** `styles/shell.css:152`, `styles/ui.css` (Button-, Chip-, Seg- und Tab-Größen), `styles/wishlist.css:61-62`.
- **Verbesserung:** Einen Block `@media (pointer: coarse)` anlegen: `min-height: 40–44px` für `.btn`, `.icon-btn`, `.chip`, `.seg button`, `.tabs button` und Sortierknöpfe; Hilfe-„?“ mit unsichtbarer Trefferfläche (`::after`, 32 px).
- **Aufwand:** 2–3 h. **Risiko:** gering bis mittel (Zeilenhöhen ändern sich; nur Touch-Geräte). **Ziel:** 1.0.

### RESP-10 – Plattform eines Wunsches nicht erkennbar [B]
- **Kategorie:** UX. **Priorität:** P2.
- **Beschreibung:** Bei Katalogspielen zeigt die Liste „Standard Edition · 2021“; die Plattform erscheint nur ohne Jahr. Der Detailkopf listet *alle* Plattformen des Spiels („XBOX SERIES X|S · XBOX ONE · 2021“), sortiert mit der eigenen zuerst, ohne Kennzeichnung. Infos zeigt ebenfalls alle. Warenkorb und Preisalarme zeigen nur den Titel. Die beiden Wünsche „Forza Horizon 5“ (Series X|S) und „Forza Horizon 5“ (Xbox One) sind in Liste, Warenkorb und Alarmen nicht zu unterscheiden.
- **Nachweis:** `sheet-wishlist.png` (1366: zwei identische Zeilen), `sheet-cart.png`, `sheet-alerts.png`.
- **Dateien:** `features/WishlistRow.tsx:29-35`, `features/GameDetail.tsx:84-85`, `features/Cart.tsx`, `features/PriceAlerts.tsx`.
- **Auswirkung:** Gerade die 0.8.1-Funktion (Xbox One/360) wird mehrdeutig. Risiko, den falschen Key zu kaufen.
- **Verbesserung:** Die Plattform des Wunsches immer zeigen, z. B. „Standard Edition · Xbox One · 2021“, im Detail „für Xbox One“ als Pille. In Warenkorb und Alarmen als Untertitel.
- **Aufwand:** 1–2 h. **Risiko:** gering. **Ziel:** 1.0.

### RESP-11 – Fehlgeschlagener Abruf erscheint im Detail wie „keine Angebote“ [B]
- **Kategorie:** UX/Fehlerzustand. **Priorität:** P2.
- **Beschreibung:** Ausgangslage: Alle Suchen eines Wunsches stehen auf `error` (Eneba „Verbindung fehlgeschlagen“, Driffle „Abruflimit erreicht“). Die Liste zeigt korrekt „Abruf fehlgeschlagen“. Im Detail dagegen:
  - Kopf-Pille: „Kein Angebot“;
  - Tab „Preis“: „Noch keine Angebote / kein aktuelles Angebot / Sobald Angebote gefunden sind …“;
  - Tab „Angebote“: „Noch keine regionalen Preise – Für diese Edition wurden noch keine Angebote gefunden.“

  Den Fehler nennt nur eine klein und kontrastarm gesetzte Fußzeile im Angebote-Tab. Einen nächsten Versuchszeitpunkt nennt das Detail nicht.

  Positiv: Ein Fehler wird nie als 0 € dargestellt.
- **Nachweis:** `r10-abruf-fehlgeschlagen-angebote.png`, `r11-abruf-fehlgeschlagen-preis.png`.
- **Dateien:** `features/GameDetail.tsx:60` (StatusPill), `features/PriceTab.tsx:78,101,106,150`, `features/Offers.tsx:66-68`.
- **Abgrenzung:** FUNC-03 behandelt veraltete und fehlerhafte *Zeilen* in der Tabelle. Dieser Befund betrifft den Zustand ohne Zeilen.
- **Verbesserung:** Wenn `searches` nur `error`/`paused` enthält, einen eigenen Zustand zeigen: Pille „Abruf fehlgeschlagen“ und Text „Eneba nicht erreichbar · neuer Versuch ca. 14:40“ (aus `retry_at`/`paused_until`). Der Leerzustand nennt dann den Grund statt „keine gefunden“.
- **Aufwand:** 2–3 h. **Risiko:** gering. **Ziel:** 1.0.

### RESP-12 – Spiel öffnen nur über ein 28-px-Icon am Zeilenende [B]
- **Kategorie:** UX. **Priorität:** P2.
- **Beschreibung:** Standard-Öffner ist `button`. Titel, Cover und Zeile sind nicht klickbar; geöffnet wird über ein unbeschriftetes Dokument-Icon ganz rechts (28×28). In den Preisalarmen ist dagegen die ganze Zeile klickbar (`PriceAlerts.tsx:134`), also inkonsistent. Die Alternative „Titel“/„Cover“ steckt in Einstellungen › Allgemein › Tabellenspalten.
- **Nachweis:** `sheet-wishlist.png`, `keyboard.json` (erster „Details zu …“ erst beim 31. Tab-Stopp).
- **Dateien:** `features/wishlist-columns.ts:41`, `features/WishlistRow.tsx:154`.
- **Verbesserung:** Standard auf „Titel“ (Titel als Link, Icon bleibt) oder die ganze Zeile klickbar machen. Gespeicherte Einstellungen bleiben unberührt.
- **Aufwand:** 0,5–1 h. **Risiko:** gering. **Ziel:** 1.0.

### RESP-13 – „Gekauft“ ohne Rückfrage und ohne Rückgängig [B]
- **Kategorie:** UX. **Priorität:** P2.
- **Beschreibung:** Ein Klick verschiebt den Wunsch in die Bibliothek; der Alarm endet und der Warenkorb-Eintrag verschwindet. Es gibt nur einen Toast ohne „Rückgängig“. Zurück geht es in 4 Schritten: Bibliothek → Schloss „Bearbeiten entsperren“ → Undo-Icon → bestätigen. Der Knopf steht direkt neben „Pausieren“.
- **Nachweis:** Journey J5 (`journeys-desktop.json`). Code: `features/GameDetail.tsx:125`, `features/Wishlist.tsx:328`, `features/Library.tsx:118-138`.
- **Verbesserung:** Toast mit Aktion „Rückgängig“ (POST `/library/{id}/restore` mit `confirm: true` existiert bereits) oder ein kurzer Bestätigungsdialog.
- **Aufwand:** 1–2 h. **Risiko:** gering. **Ziel:** 1.0.

### RESP-14 – Warenkorb kennzeichnet das Regionsrisiko nicht [B]
- **Kategorie:** UX/Datenpräsentation. **Priorität:** P2.
- **Beschreibung:** „In den Warenkorb“ aus dem Kopf übernimmt „Günstigster“ + INT. In der Journey war das Indien mit „Aktivierung in DE ungeklärt“. Die Warenkorbzeile zeigt nur Flagge und „Indien“, keinen Gültigkeitshinweis. Die Summe mischt in DE gültige und ungeklärte Keys. Ein Link zum Shop fehlt im Warenkorb.
- **Nachweis:** `r15-warenkorb-int-ohne-warnung.png`. Code: `features/Cart.tsx:108-125`, `features/cart-model.ts`.
- **Auswirkung:** Gegen den Kernanwendungsfall (günstigste Region *mit* Zielland vergleichen) wird hier verglichen, ohne das Risiko zu zeigen.
- **Verbesserung:** Bei INT-Zeilen die Gültigkeits-Pille wie im Angebote-Tab zeigen und in der Summe „davon in DE ungeklärt: x €“ ausweisen. Günstigere Regionen bleiben dabei gleichrangig sichtbar, nur annotiert. Optional „Zum Shop“.
- **Aufwand:** 2–3 h. **Risiko:** gering. **Ziel:** 1.0 (Hinweis) / 1.1 (Shop-Link).

### RESP-15 – Erststart setzt Datei- und Twitch-Wissen voraus [B/R]
- **Kategorie:** UX/Onboarding. **Priorität:** P2.
- **Beschreibung:**
  - [B] Die Einrichtungsseite erklärt nicht, wofür KeyHunter da ist.
  - [B] Der Einrichtungscode steht nur in der Datei `bootstrap-token` im Datenverzeichnis und wird bewusst nie geloggt (`backend/src/lib.rs:210-229`). Der Hinweis nennt weder Pfad noch Befehl, etwa `/mnt/user/appdata/keyhunter/bootstrap-token`.
  - [B] Nach der Einrichtung fehlt jeder Hinweis, dass IGDB-Zugang (Client-ID/Secret einer Twitch-Anwendung) und ein Benachrichtigungskanal nötig sind. Der Zugang steckt in Einstellungen › Spieleindex, mit einem Hilfetext ohne Link.
  - [R] Wie die Suche ohne IGDB-Zugang aussieht, ist mit der Fixture **nicht verifizierbar**: Die Fixture-Suche antwortet auch ohne Zugangsdaten (`journey-02`).
- **Dateien:** `features/AuthScreen.tsx:56-66`, `features/IgdbAccess.tsx:67-70`, `features/Wishlist.tsx` (EmptyState).
- **Verbesserung:**
  - Einzeiler auf der Einrichtungsseite („Vergleicht Xbox-Key-Preise aller Regionen mit deinem Land und meldet Zielpreise“).
  - Hinweis mit Unraid-Pfad bzw. `docker exec`-Befehl.
  - Nach der Einrichtung eine 3-Punkte-Checkliste im Leerzustand: Zielland ✓ · Spieleindex einrichten · Benachrichtigung einrichten.
- **Aufwand:** 3–5 h. **Risiko:** gering. **Ziel:** 1.0.

### RESP-16 – Kein „Spiel hinzufügen“ auf Smartphones, sobald die Liste Einträge hat [B]
- **Kategorie:** UX/Responsive. **Priorität:** P3.
- **Beschreibung:** „Spiel hinzufügen“ und die Preisalarm-Glocke tragen `hide-sm`. Auf dem Phone bleibt nur das Suchfeld „Spiele suchen …“. Das funktioniert, inklusive manuellem Vormerken, ist aber als Hinzufügen-Weg nicht beschriftet.
- **Dateien:** `App.tsx:271-272`, `styles/shell.css:150`.
- **Verbesserung:** Ein „+“-Icon-Knopf in der Phone-Top-Bar, oder Platzhalter „Spiel suchen & hinzufügen …“.
- **Aufwand:** 0,5–1 h. **Risiko:** gering. **Ziel:** 1.0.

### RESP-17 – Erste Spielzeile auf 375 px erst bei ≈ 690 von 812 px [B/S]
- **Kategorie:** UX/Informationsdichte. **Priorität:** P3.
- **Beschreibung:** Vor der Liste stehen 4 KPI-Kacheln (2×2), 2 Zeilen Filter-Chips, Gebühren-Umschalter, Filterfeld, „Pro Seite“ und die Sortierleiste. Im Leerzustand stehen dieselben Steuerelemente ohne Funktion über dem Hinweis.
- **Nachweis:** `sheet-wishlist.png` (375).
- **Verbesserung [S]:**
  - Bis 720 px die KPIs als eine Zeile zusammenfassen (horizontal scrollbar oder einklappbar).
  - „Pro Seite“ in den Pager verlegen.
  - Im Leerzustand Chips und Filter ausblenden.
- **Aufwand:** 2–3 h. **Risiko:** gering. **Ziel:** 1.1.

### RESP-18 – Texte und Begriffe uneinheitlich [B]
- **Kategorie:** UX/Text. **Priorität:** P3.
- **Beschreibung:**
  - „Ziel erreicht 1 Spiele“: Einheit immer Plural (`Wishlist.tsx:413-415`).
  - „Preis INT“ / „Weltweit“ / „WELT“ / „Günstigste Region · weltweit“ für dasselbe.
  - „Pausiert“ sowohl für einen ausgeschalteten Alarm als auch für einen pausierten Wunsch.
  - „3 Angebote in DE nicht aktivierbar“ zählt auch „Aktivierung ungeklärt“ mit (`Offers.tsx:99`).
  - Suche „2 Treffer“ bei 4 Zeilen (eine je System).
  - Tab „Angebote 6“ gegenüber Tabellenkopf „9 von 9“ (vgl. FUNC-11).
  - Rückfrage „Bereits in der Bibliothek“ nennt weder Edition noch Plattform des vorhandenen Spiels (`r20-dialog-bereits-in-bibliothek.png`).
  - Fehlerzustand der Liste: Untertitel „0 Spiele“ statt „nicht geladen“, dieselbe Meldung dreifach (Banner, Leerzustand, Toast); `Wishlist.tsx:401,411`, `r12-wishlist-fehler-375.png`.
- **Verbesserung:** Ein Glossar: „DE-Preis“ / „Bester Preis weltweit (INT)“ / „ungeklärt“ ≠ „nicht aktivierbar“, Singular/Plural. Den Dialog mit „Standard Edition · Xbox Series X|S“ ergänzen.
- **Aufwand:** 1–2 h. **Risiko:** gering. **Ziel:** 1.0.

### RESP-19 – Interne Score-Spalte standardmäßig in der Angebotstabelle [S]
- **Kategorie:** UX. **Priorität:** P3.
- **Beschreibung:** „Score 0–100“ (Scheduler-Kennzahl) ist Standardspalte. Die Erklärung steht nur im `title`-Attribut des Kopfes, was auf Touch nicht erreichbar ist. Die Spalte kostet ≈ 80–90 px (RESP-02).
- **Dateien:** `features/offers-columns.ts:5,12`.
- **Verbesserung:** Standardmäßig ausblenden; im Tab Infos oder im Abrufstatus zeigen.
- **Aufwand:** 0,5 h. **Risiko:** gering. **Ziel:** 1.0.

### RESP-20 – Kleinere A11y-Mängel [B]
- **Kategorie:** Accessibility. **Priorität:** P3.
- **Beschreibung:**
  - (a) Der Toaster ist ein `div` mit `aria-label` ohne Rolle. axe meldet `aria-prohibited-attr` (serious) und `region` in 17–18 Ansichten (`ui/Toaster.tsx:36`).
  - (b) Die Tabellen in Abrufstatus und Log sind scrollbar, aber nicht fokussierbar (axe `scrollable-region-focusable`, 375 px; `settings/FetchPanel.tsx:84,112`, `settings/Log.tsx:24`). Die Angebotstabelle macht es mit `tabIndex=0` richtig.
  - (c) Hilfe-„?“ öffnet bei Tastaturfokus und schluckt das erste Escape (`ui/Help.tsx:47-50`).
  - (d) Ein Tab-Stopp ins Top-Suchfeld öffnet das leere Suchpopup und fügt zwei Tab-Stopps ein.
- **Verbesserung:**
  - (a) `role="region"` behalten oder `aria-label` streichen.
  - (b) `tabIndex={0} role="region" aria-label`.
  - (c) Bei Fokus nur über `aria-describedby` vorlesen, Popup erst bei Klick oder Hover.
  - (d) Popup erst ab 1 Zeichen.
- **Aufwand:** 1–2 h. **Risiko:** gering. **Ziel:** 1.0.

### RESP-21 – Preisdiagramm auf Smartphones klein [S]
- **Kategorie:** Visuell. **Priorität:** P3.
- **Beschreibung:** Auf 375 px ist das Punkt-Matrix-Diagramm ≈ 130 px hoch, und die Achsenbeschriftungen stoßen fast aneinander („11 Sept.29 Sept.“). Lesbar, aber gedrängt. Desktop ist gut lesbar.
- **Nachweis:** `r17-verlauf-375.png`.
- **Verbesserung:** Auf dem Phone 180–200 px Höhe, jede zweite Achsenbeschriftung, Tooltip bei Tipp (vorhanden).
- **Aufwand:** 1 h. **Risiko:** gering. **Ziel:** 1.1.

**Querverweise auf andere Dokumente (keine neue ID):**
- **DS-02** (Kontrast `--muted`/`--faint`): Von axe bestätigt (Abschnitt 5.3). Besonders betroffen ist der **Preis-Zeitstempel „Stand … “ mit 2,52 : 1**, relevant für UX-Frage 7.
- **DS-03** (Feldfokus): Gemessen, `r13-fokus-eingabefeld.png` (fokussiert/unfokussiert praktisch identisch).
- **DS-15** (breite Bildschirme): Bestätigt. Bei 2560 px steht ein ≈ 500 px leerer Streifen neben der Seitenleiste, die Top-Bar-Aktionen kleben am rechten Rand.
- **FUNC-03 / FUNC-11:** siehe dort.

## 5. Tastatur, Zoom, axe

### 5.1 Tastatur (1366 px, Chromium)

| Prüfung | Ergebnis |
|---|---|
| Skip-Link | Erster Tab-Stopp „Zum Inhalt“, sichtbar (`r18-skiplink.png`). Enter setzt den Fokus auf `main#main-content`, der nächste Tab geht in den Inhalt. **ok** |
| Tab-Reihenfolge Liste | Skip-Link → Logo → 4 Navigationspunkte → Abrufstatus (Pause, Karte) → Einstellungen → Abmelden → Top-Bar (Suche, Plattform, Schließen, Glocke, Hinzufügen) → Hilfe → 5 Chips → Gebühren → Filter → Pro Seite → 6 Sortierköpfe → erste Zeile beim **31. Stopp**. Logisch, aber lang. Es gibt keinen Sprung „zur Liste“. |
| Tab-Reihenfolge Detail | Top-Bar → Edition → Ziel → Warenkorb → Pausieren → Gekauft → ⋯ → **nur der aktive Tab** (Roving-Tabindex, Pfeiltasten, Home/End **ok**) → Tabpanel (fokussierbar) → Inhalt |
| Fokusring | Buttons, Links, Tabs, Selects: 2 px Orange **ok**. Textfelder (Top-Suche, Listenfilter, Zielpreis): kein Ring, nur Rahmen #322f2d → #3d3a37 (DS-03, `r13`) |
| Escape | „Spiel hinzufügen“-Dialog schließt, Fokus zurück auf den Auslöser **ok**. Suchpopup schließt, Fokus im Feld **ok**. ⋯-Menü und Pausieren-Menü schließen, Fokus auf den Auslöser **ok**. Bestätigungsdialog („Behalten“ vorfokussiert) **ok**. Hilfe-Popup **ok**. Drawer: siehe RESP-08 |
| Menüs | Öffnen setzt den Fokus auf den ersten Menüpunkt, Pfeiltasten wandern **ok** |
| Dialog-Fokus | Natives `showModal`: Fokus bleibt im Dialog (Zyklus über Browser-Chrome) **ok** |
| Tastenkürzel | Strg+K fokussiert die Suche; Pfeil ↓ springt in die Treffer **ok** |
| Drawer (768 px) | Kein Fokus-Einschluss, Hintergrund nicht `inert` → RESP-08 |

### 5.2 Zoom 200 % / 400 %

Simuliert als CSS-Viewport 683×384 (200 % von 1366×768) und 320×256 (400 % von 1280×1024).
- **Reflow:** kein Dokument-Overflow. Bei 200 % greift das Drawer-Layout; Liste, Detail und Einstellungen laufen einspaltig.
- **Bei 400 %:**
  - Der Detailkopf füllt den ganzen Bildschirm.
  - Die Liste ist nutzbar (`r19-zoom400-wishlist.png`).
  - Datentabellen scrollen horizontal (nach WCAG 1.4.10 für Datentabellen zulässig).
  - Das Suchpopup scrollt horizontal (RESP-07).
  - Detailseiten sind seitlich verschiebbar (RESP-04).
- **Ergebnis:** bestanden mit den Einschränkungen RESP-04/07. Die feste Top-Bar (55 px) nimmt bei 384 px Höhe 14 % ein; vertretbar.

### 5.3 axe-core 4.10.3 (WCAG 2.0/2.1/2.2 A+AA + Best Practice)

| Regel | Auswirkung | 1366 px (19 Ansichten) | 375 px (19 Ansichten) | Kern |
|---|---|---|---|---|
| `color-contrast` | serious | **19/19 Ansichten, 227 Knoten** | 17/19, 102 Knoten | siehe Kontrastpaare unten (DS-02) |
| `aria-prohibited-attr` | serious | 17 Ansichten | 18 Ansichten | `.toaster` mit `aria-label` ohne Rolle (RESP-20a) |
| `region` | moderate (Best Practice) | 17 | 18 | Toaster außerhalb der Landmarks (RESP-20a) |
| `target-size` | serious (2.2 AA) | – | 2 Ansichten, 4 Knoten | Sortierknöpfe 44×16,8 px (RESP-09) |
| `scrollable-region-focusable` | serious | – | 2 Ansichten, 3 Knoten | Abrufstatus- und Log-Tabellen (RESP-20b) |

Keine Ansicht ist ohne Verstoß. Keine `critical`-Verstöße.

Kontrastpaare (1366 px, `kontrast-paare.csv`):

| Paar | Kontrast | Knoten (6 Ansichten) |
|---|---|---|
| `#8d8780` (`--muted`) auf `#272524` (`--panel-2`), 11–12 px | **4,29 : 1** | 71 |
| `#625d58` (`--faint`) auf `#272524` (Zähler, Einheiten) | 2,34 : 1 | 38 |
| `#625d58` auf `#1b1a19` (Nav-Gruppentitel) | 2,66 : 1 | 9 |
| `#625d58` auf `#211f1e` (**„Stand 22. Nov · 15:43“**, „9 von 9“) | 2,52 : 1 | 2 |

Nicht-Text-Kontrast (manuell gemessen): Der Rahmen des Selects in Einstellungen › Allgemein steht mit 1,15 : 1 vor seiner Fläche. Die Feldgrenzen auf der Einrichtungsseite sind kaum sichtbar (`setup__375`). Weil Beschriftung und Chevron das Feld erkennbar machen, ist das [R], kein harter Verstoß gegen 1.4.11.

Weitere positive Punkte:
- `lang="de"`, eindeutige Landmarks (Seitenleiste, Hauptnavigation, Pfad, `main`).
- `aria-sort` an den Sortierköpfen.
- Live-Regionen für Toasts (polite und alert getrennt).
- `prefers-reduced-motion` wird respektiert (`styles/base.css:51`).
- Datentabelle als Alternative zum Diagramm.

## 6. UX aus Sicht eines Endanwenders

### 6.1 Journeys (frische Instanz, gezählt)

Gezählt sind Aktionen (Klick, Auswahl, Texteingabe als eine Aktion); Lesen ist nicht gezählt. Preisdaten gemockt, Abläufe echt.

| Journey | Aktionen | Verwirrend oder unnötig |
|---|---|---|
| **J0 Ersteinrichtung** | 5 (Code, Passphrase ×2, Zielland, Absenden) | Code nur aus einer Datei im Datenverzeichnis, ohne Pfad (RESP-15). Keine Produkterklärung. Zielland wird aus der Browsersprache vorbelegt (bei `en-US` → „Vereinigte Staaten“). Danach kein Hinweis auf IGDB und Benachrichtigungen. |
| **J1 Eigentümer (Desktop):** „günstigste, in DE aktivierbare Xbox-Version finden + Alarm unter Wunschgrenze“ | **6** minimal: Spiel hinzufügen → „forza“ → Vormerken (Series X\|S) → Ziel setzen → 25 → Speichern. **8** mit Prüfung (Tab Angebote, Schalter „Nur in DE aktivierbar“). **11** mit erstem Kanal (Kanal einrichten → Topic-URL → Speichern; aktiviert sich selbst) | Gut: Das Detail öffnet sich nach dem Vormerken automatisch auf „Preis“: DE-Bestpreis neben günstigster Region, Ersparnis, Aktivierungsstatus, Begründung. Der Alarm zählt nur in DE aktivierbare Keys. „Kanal einrichten“ führt direkt zum Ziel. Schwach: Die Treffer zeigen je System eine eigene Zeile; die Edition ist ein grünes Etikett, das wie ein Status wirkt. Plattform danach nicht mehr sichtbar (RESP-10). `r16` |
| **J1 Eigentümer (Phone 375 px)** | 8 (+1 Rückfrage) | Kein Hinzufügen-Knopf (RESP-16). Rückfrage „Bereits in der Bibliothek“ für eine *andere* Edition und Plattform, ohne Angabe, was vorhanden ist (RESP-18). Angebote nicht ablesbar (RESP-02). Aktiver Tab „Alarm“ unsichtbar (RESP-05). Pausieren-Menü abgeschnitten (RESP-06). |
| **J2 Editionen verstehen** | 2 (Details öffnen, Tab Editionen) | Gut: Edition-Select mit „· gemerkt“/„· Vorschau“, Inhaltsvergleich (Grundspiel/Zusatzpaket) mit Aufpreis. Begriff „WELT“ statt „INT“ (RESP-18). |
| **J3 Warenkorb** | 2 (+1 DE umschalten) | Standard „Günstigster + INT“ ohne Gültigkeitshinweis (RESP-14). Kein Shop-Link. |
| **J4 Pausieren / Fortsetzen** | 3 / 1 | Gut erklärt (Toast mit Datum, Pille im Kopf, Chip „Pausiert“ in der Liste). Phone: Menü abgeschnitten (RESP-06). |
| **J5 Gekauft → Bibliothek** | 1 (+4 für Rückgängig) | Keine Rückfrage, kein Undo (RESP-13). Wiederherstellen versteckt hinter dem Schloss. |
| **J6 Fehlgeschlagene Abrufe verstehen** | 1–2 (Abrufstatus-Karte → Einstellungen › Abrufstatus; Log) | Liste: Pille „Abruf fehlgeschlagen“. Detail: wirkt wie „noch nichts gefunden“ (RESP-11). Der Abrufstatus erklärt ausführlich (Pause bis Uhrzeit, Limit, Bedarf), ist aber technisch („Umgebungsvariable“, „Abrufe pro Tag (höchstens)“). |

### 6.2 Die 15 Fragen

1. **Verstehe ich in Sekunden, wofür KeyHunter ist?** Teilweise. Die Einrichtungsseite sagt nur „Lege die Passphrase für deinen privaten Bereich fest“ [B]. Erst der leere Wunschlisten-Hinweis („… dann beobachtet KeyHunter den Preis“) und die Spalten „Preis DE / Preis INT“ erklären es. Einzeiler fehlt (RESP-15).
2. **Kann ich intuitiv mein erstes Spiel hinzufügen?**
   - Desktop: ja. Zwei sichtbare Einstiege, „Spiel hinzufügen“ und „Im Katalog suchen“; 3 Aktionen bis gemerkt [B].
   - Phone mit gefüllter Liste: nur über das Suchfeld (RESP-16).
   - Mit echter Installation erst nach IGDB-Zugang; dieser Fall ist nicht verifizierbar (RESP-15).
3. **Erkenne ich sofort die gewählte Edition?** Die Edition ja: Select „Standard Edition · gemerkt“, Unterzeile „Standard Edition · 2021“. Die **Plattform nein**: Liste, Warenkorb und Alarme lassen sie bei Katalogspielen weg, der Detailkopf listet alle (RESP-10) [B].
4. **Verstehe ich, warum ein Angebot günstiger ist?** Ja, das ist die Stärke des Produkts. „Indien spart 16,00 € (55 %). Ob der Key in Deutschland funktioniert, ist ungeklärt …“ und die Liste „Warum dieser Preis zählt“ [B]. Abzug: Die Gebührenschätzung ist ein zusätzlicher Umschalter, der leicht übersehen wird.
5. **Kann ich Aktivierungsregionen klar unterscheiden?** Überwiegend ja. Flagge, Regionsname und Pille „in DE aktivierbar“ / „Aktivierung in DE ungeklärt“ / „in DE nicht aktivierbar“ [B]. Abzug: Die Sammelzeile nennt ungeklärte Angebote „nicht aktivierbar“ (RESP-18). „Global“, „Europa“ und „EU“ erscheinen nebeneinander ohne Erklärung, ob sie gleichwertig sind [S].
6. **Sind Risiken regional beschränkter Angebote verständlich?** Im Detail ja (ein Satz und die Pillen). Im Warenkorb und in der Liste („Preis INT“ mit Flagge) nein, dort fehlt jeder Risikohinweis (RESP-14) [B].
7. **Erkenne ich, wie aktuell Preise sind?** Teilweise.
   - Gut sichtbar: Angebote-Tab („vor 2 Std.“, gelb „veraltet · vor 9 T“) und Listen-Pille „Veraltet · vor 4 T“.
   - Kaum lesbar: der zentrale „Stand 22. Nov · 15:43“ im Preisvergleich, 2,52 : 1 (DS-02) [B].
8. **Weiß ich, was bei fehlgeschlagenen Abfragen passiert?** Nein. Im Detail sieht ein Fehler wie „noch keine Angebote gefunden“ aus; nur die Fußzeile nennt den Grund, nicht den nächsten Versuch (RESP-11) [B]. Der Abrufstatus erklärt Pausen und Limits gut, ist aber nur über die Sidebar-Karte bzw. Einstellungen erreichbar.
9. **Finde ich die wichtigsten Aktionen ohne Anleitung?** Ziel setzen, In den Warenkorb, Pausieren und Gekauft stehen sichtbar im Kopf [B]. „Jetzt prüfen“ und „Entfernen“ stecken im ⋯-Menü (für Entfernen ok). Das Öffnen eines Spiels aus der Liste ist das größte Hindernis (RESP-12).
10. **Gibt es unnötige Klicks oder komplizierte Abläufe?** Kernablauf: nein (6 Aktionen). Unnötig sind:
    - Rückgängig nach „Gekauft“ (4 Schritte, RESP-13);
    - Wiederherstellen und Entfernen in der Bibliothek erst nach „Bearbeiten entsperren“;
    - auf dem Phone seitliches Wischen in der Angebotstabelle (RESP-02);
    - der Tastaturweg zur ersten Zeile (31 Stopps).
11. **Ist die Informationsdichte angemessen?**
    - Desktop: hoch, aber gut gegliedert (KPI, Filter, Tabelle).
    - Phone: zu hoch vor dem eigentlichen Inhalt (RESP-17) und in den Karten (RESP-01).
    - Score-Spalte und Abrufstatus-Details sind für Endnutzer Ballast (RESP-19) [S].
12. **Sind Fehler-, Lade- und Leerzustände verständlich?** Überwiegend ja: Leerzustände mit Erklärung und Aktion (Warenkorb, Bibliothek, Alarme), Offline-Seite mit „Erneut versuchen“, Netzwerkfehler als Toast [B]. Ausnahmen:
    - Liste nicht ladbar → „0 Spiele“ plus dreifache Meldung (Banner, Leerzustand, Toast) [B, RESP-18];
    - fehlgeschlagener Abruf im Detail (RESP-11).
13. **Ohne technisches Vorwissen nutzbar?** Im Alltag weitgehend. **Einrichtung nicht:**
    - Einrichtungscode aus einer Datei;
    - Twitch-Client-ID/Secret;
    - HTTPS-Warnung mit „Reverse Proxy“ oben in den Einstellungen (wegklickbar, bei LAN-Zugriff per HTTP der Normalfall);
    - „Abrufe pro Tag (höchstens)“ und „Umgebungsvariable“ im Abrufstatus (RESP-15) [B].
14. **Vorhandene, aber schlecht auffindbare Features:**
    - Titel oder Cover als Öffner (Einstellungen);
    - Spaltenkonfiguration;
    - Shopname im Listenfilter (nur im Hilfetext);
    - Strg+K;
    - „Jetzt prüfen“ (⋯);
    - Wiederherstellen aus der Bibliothek (Schloss);
    - Gebührenansicht;
    - Export (Einstellungen › Allgemein);
    - auf dem Phone alle Tabs rechts außerhalb der Leiste (RESP-05).
15. **Wo würde ein normaler Benutzer abbrechen?**
    - (a) Bei der Einrichtung am Einrichtungscode oder IGDB-Zugang.
    - (b) Auf dem Phone an der unlesbaren Wunschliste und der Angebotstabelle.
    - (c) Auf dem Tablet, weil kein Spiel zu öffnen ist (RESP-03).
    - (d) Wenn ein Spiel dauerhaft „keine Angebote“ zeigt, obwohl die Abfrage fehlschlägt (RESP-11); er hält das Spiel für nicht verfügbar.

### 6.3 Abgeleitete UX-Verbesserungen (nach Nutzen/Aufwand)

1. Phone-Layout von Liste und Angeboten (RESP-01, -02, -03): größter Nutzen, 8–16 h.
2. Fehlerzustand im Detail ehrlich anzeigen (RESP-11), 2–3 h.
3. Plattform überall zeigen (RESP-10), 1–2 h.
4. Titel öffnet das Spiel (RESP-12), < 1 h.
5. „Rückgängig“ nach „Gekauft“ (RESP-13), 1–2 h.
6. Risiko-Annotation im Warenkorb, ohne günstigere Regionen abzuwerten (RESP-14), 2–3 h.
7. Erststart-Checkliste und Code-Pfad (RESP-15), 3–5 h.
8. Begriffe vereinheitlichen (RESP-18), Score ausblenden (RESP-19), 2 h.

Es braucht dafür keine neuen Abhängigkeiten und keinen Rewrite. Alles ist CSS oder kleine Komponentenänderung in bestehenden Dateien.

## 7. Bewertungen

| Bereich | Note | Begründung |
|---|---|---|
| Responsive Design | 5/10 | 0 Dokument-Overflows in 240 Messungen; Desktop 1366–2560 sauber. Bestätigte Fehler in Kernansichten auf Phone und Tablet (RESP-01…07). Eine committete Baseline sichert sogar den fehlerhaften Phone-Zustand ab. |
| Accessibility | 5/10 | Grundlagen gut (Skip-Link, Landmarks, Dialog- und Menü-Tastatur, Tabs, Live-Regionen, Diagramm-Tabelle, Reflow 200 %). Dagegen: axe-Kontrastfehler in allen Ansichten, Feldfokus unsichtbar, Drawer nicht modal, Touch-Ziele klein. Nicht verifiziert: Screenreader und Forced Colors. |
| UX / Benutzerfreundlichkeit | 6/10 | Kernablauf kurz (6 Aktionen) und inhaltlich hervorragend erklärt. Abzüge: Phone-Nutzung, fehlgeschlagene Abrufe, Plattform-Mehrdeutigkeit, Erststart, versteckte Funktionen. |

## 8. Geprüfte Befehle und Grenzen

**Ausgeführt**
- **Server:**
  - `KEYHUNTER_BIND=127.0.0.1:38783 KEYHUNTER_DATA_DIR=<mktemp work/check/browser.*> KEYHUNTER_FRONTEND_DIR=frontend/dist work/check/target/debug/examples/catalog_fixture`
  - zweimal: Seed-Instanz, danach eine frische Instanz für die Journeys.
- **Temporäre Specs:** `frontend/e2e/tmp-audit-resp/` (lib, setup, seed, matrix, states, keyboard/zoom, axe, contrast, probe, journeys, webkit); nach dem Audit gelöscht.
- **Lauf:** `cd frontend && KEYHUNTER_E2E_BASE_URL=http://127.0.0.1:38783 KEYHUNTER_TEST_DATA_DIR=… npx playwright test --project=e2e e2e/tmp-audit-resp/<spec>`.
  - Ergebnisse: setup 1/1, seed 1/1, matrix 6/6 (3 Läufe à ≈ 3,4 min), states 11/11, keyboard 4/4, axe 2/2, contrast 1/1, probe 1/1, journeys 2/2.
  - Fehlgeschlagene Zwischenläufe (Locator-Mehrdeutigkeit, Mock-Reihenfolge, Rückfrage-Dialog) wurden korrigiert und wiederholt.
- **WebKit:** `docker run --rm --network host … mcr.microsoft.com/playwright:v1.65.1-noble npx playwright test … 09-webkit.spec.ts` → 1/1. Auf dem Host fehlen WebKit-Bibliotheken.
- **axe-core:** `npm pack axe-core@4.10.3` im Scratch-Ordner, Injektion per `addScriptTag({ path })` mit `bypassCSP` (die App-CSP `script-src 'self'` blockiert Inline-Skripte).
- **Hilfsskripte (Scratch):** Kontaktbögen und Ausschnitte über Playwright-Rendering; Python nur zur Auswertung der JSON-Messdaten.
- **Konsole:** In allen Matrix-Läufen keine JS-Ausnahmen. Nur erwartete 401 (vor der Anmeldung) und 503 (Testsuche „ausfall“).

**Grenzen / nicht verifiziert**
- Shoppreise, Angebote, Verlauf, Abrufstatus und Log waren gemockt. Layout und Texte entsprechen dem echten Frontend; ob das Backend in der Realität genau diese Zustände liefert, ist nicht Teil dieses Dokuments (siehe 03).
- **Suche ohne IGDB-Zugang:** nicht verifiziert. Die Fixture antwortet trotz gelöschter Zugangsdaten.
- **Echte Geräte** (iOS Safari, Android Chrome), Firefox, Screenreader (NVDA/VoiceOver), Forced Colors/Hochkontrast: nicht geprüft. Touch nur per `hasTouch`/`isMobile` emuliert. Zoom per CSS-Viewport simuliert, nicht per Browser-Zoom.
- **Kein Light-Theme:** Die App ist bewusst dunkel (`color-scheme: dark`); `prefers-color-scheme: light` wird nicht bedient.
- **Benachrichtigungen:** „Test senden“ wurde absichtlich nicht ausgelöst (keine Benachrichtigungsdienste). Der ntfy-Kanal zeigte auf `127.0.0.1:9`.
- **Heuristik:** Überlappungen und Touch-Ziele sind automatische Messungen. Gemeldet ist nur, was visuell bestätigt wurde. Die Zählung enthält auch Elemente hinter Dialogen.
