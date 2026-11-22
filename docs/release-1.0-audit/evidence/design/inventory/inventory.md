# Design inventory (generated) 2026-11-22T16:34:56.098Z

## CSS files
- src/styles/alerts.css: 2811 B, 32 rules, 56 declarations
- src/styles/app.css: 2312 B, 21 rules, 75 declarations
- src/styles/base.css: 2909 B, 33 rules, 77 declarations
- src/styles/cart.css: 5241 B, 52 rules, 128 declarations
- src/styles/catalog.css: 3246 B, 34 rules, 98 declarations
- src/styles/detail.css: 15360 B, 167 rules, 465 declarations
- src/styles/fonts.css: 1180 B, 0 rules, 0 declarations
- src/styles/library.css: 4719 B, 43 rules, 113 declarations
- src/styles/offers.css: 2170 B, 18 rules, 55 declarations
- src/styles/pages.css: 1245 B, 14 rules, 32 declarations
- src/styles/settings.css: 8549 B, 81 rules, 201 declarations
- src/styles/shell.css: 9613 B, 93 rules, 313 declarations
- src/styles/tokens.css: 4641 B, 1 rules, 119 declarations
- src/styles/ui.css: 15458 B, 153 rules, 533 declarations
- src/styles/wishlist.css: 6459 B, 63 rules, 160 declarations

Totals: 805 rules, 2425 declarations, 369 distinct classes

## Colour literals outside tokens.css: 5
- src/styles/catalog.css:9 `.cover-initials` color: rgb(255 255 255 / .85)
- src/styles/library.css:20 `.library-page .lib-tools .icon-btn` box-shadow: 0 1px 3px rgb(0 0 0 / .35)
- src/styles/offers.css:22 `table.offers .score.lo` --score-color: color-mix(in oklab, var(--warn) calc(var(--score) * 2%), var(--danger))
- src/styles/offers.css:23 `table.offers .score.hi` --score-color: color-mix(in oklab, var(--ok) calc((var(--score) - 50) * 2%), var(--warn))
- src/styles/settings.css:30 `.note.warn` border-color: color-mix(in srgb, var(--warn) 35%, transparent)

## Colour literals in TS/TSX: 0

## font-size {"token":122,"literal":6}
- var(--t-xs): 58
- var(--t-label): 10
- var(--t-xs) (font): 8
- var(--t-sm): 8
- var(--t-md): 5
- 10px (font): 5
- var(--t-label) (font): 4
- var(--t-lg): 3
- var(--t-sm) (font): 3
- var(--t-title): 3
- var(--t-md) (font): 3
- 11px (font): 2
- 22px: 2
- var(--text-sm): 2
- var(--t-price) (font): 2
- var(--t-lg) (font): 2
- .92em: 1
- var(--t-lg, 18px): 1
- 18px (font): 1
- inherit: 1
- var(--t-kpi): 1
- var(--t-kpi) (font): 1
- .55em: 1
- 20px: 1

## font-weight {"token":32,"literal":27}
- 500: 24
- 500 (font): 17
- 400 (font): 10
- 600 (font): 4
- 600: 3
- var(--weight-semibold): 1

## line-height
- 1 (font): 10
- 1.2 (font): 5
- 1.5 (font): 4
- 1.3 (font): 2
- 1.4: 1
- 1.2: 1
- 1.5: 1
- 1.3: 1
- 1.45: 1
- 1.4 (font): 1

## font-family
- var(--f-mono) (font): 22
- var(--f-sans) (font): 9
- var(--f-mono): 3
- var(--font-mono): 1

## border-radius {"token":42,"literal":41}
- var(--r-md): 18
- var(--r-sm): 13
- 5px: 7
- 50%: 7
- var(--r-lg): 7
- 999px: 6
- 4px: 5
- 2px: 4
- 0: 3
- 3px: 3
- 8px: 2
- 1px: 2
- var(--radius-md): 1
- var(--radius-sm): 1
- var(--r-md, 10px): 1
- 10px: 1
- inherit: 1
- var(--r-lg) var(--r-lg) var(--r-md) var(--r-md): 1

## box-shadow
- src/styles/app.css:15 dialog → var(--shadow-pop)
- src/styles/cart.css:14 .cart-page .cart-table .gcover → none
- src/styles/detail.css:8 .gcover → inset 0 0 0 1px var(--color-border-strong)
- src/styles/detail.css:18 .popover-panel → var(--shadow-pop)
- src/styles/detail.css:103 .gauge-mark.now i → 0 0 0 3px var(--panel)
- src/styles/detail.css:126 .tip → var(--shadow-tip)
- src/styles/library.css:20 .library-page .lib-tools .icon-btn → 0 1px 3px rgb(0 0 0 / .35)
- src/styles/library.css:43 .library-page .lib.rows .lib-tools .icon-btn → none
- src/styles/settings.css:26 .settings-page.unsaved > .page-head → 0 1px 0 var(--line)
- src/styles/settings.css:92 .settings-page .col-order li.held → inset 2px 0 0 var(--accent)
- src/styles/shell.css:111 .search-pop → var(--shadow-pop)
- src/styles/ui.css:64 .reg.flag.home, .reg.area.home → 0 0 0 1px var(--accent)
- src/styles/ui.css:70 .seg button[aria-checked='true'], .seg button[aria-pressed='true'] → inset 0 0 0 1px var(--line-2)
- src/styles/ui.css:165 .toast → var(--shadow-tip)
- src/styles/ui.css:194 .help-pop → var(--shadow-tip)
- src/styles/ui.css:211 .toast-pop → var(--shadow-pop)
- src/styles/wishlist.css:32 table.wl .gcover → none

## spacing values (padding/margin/gap) {"token":1,"literal":388}
0×121, 8px×73, 10px×62, 12px×57, 6px×43, 16px×39, 14px×33, 4px×30, 2px×26, 0px))×10, 18px×5, 1px×5, 5px×4, -1px×3, -6px×3, -4px×3, 7px×2, 9px×2, 22px×2, 40px×2, 3px×2, 13px×1, -22px×1, 24px×1, 32px×1, 20px×1, -3px×1

## heights (literal px / --h-btn)
28px×13, 16px×9, 15px×8, 14px×7, 12px×7, 6px×6, var(--h-btn)×6, 22px×5, 44px×3, 30px×3, 34px×3, 1px×2, 40px×2, 24px×2, 13px×2, 2px×2, 32px×2, 18px×2, 26px×2, 64px×1, 96px×1, 7px×1, 11px×1, 48px×1, 33px×1, 56px×1, 38px×1, 4px×1, 20px×1

## @media / @container
- @media (max-width: 720px): 11
- @media (max-width: 1180px): 3
- @media (prefers-reduced-motion: reduce): 2
- @media (max-width: 900px): 2
- @container (min-width: 1120px): 1
- @media (max-width: 560px): 1
- @media (max-width: 520px): 1
- @media (max-width: 359px): 1
- @media (pointer: coarse): 1

## !important: 4
- src/styles/base.css:51 *, *::before, *::after { transition: none !important }
- src/styles/base.css:51 *, *::before, *::after { animation-duration: .01ms !important }
- src/styles/base.css:51 *, *::before, *::after { animation-iteration-count: 1 !important }
- src/styles/base.css:51 *, *::before, *::after { scroll-behavior: auto !important }

## inline style= in TSX: 11
- src/features/PriceMatrix.tsx:89 left: tip.left, top: tip.top
- src/features/PriceTab.tsx:133 left: pos(stats90.low.cents)
- src/features/PriceTab.tsx:134 left: pos(stats90.average)
- src/features/PriceTab.tsx:135 left: pos(chartTarget)
- src/features/PriceTab.tsx:136 left: pos(now90)
- src/features/settings/FetchPanel.tsx:36 width: pct(budget.share)
- src/features/settings/FetchPanel.tsx:37 left: pct(budget.demandShare)
- src/ui/Form.tsx:11 style
- src/ui/Gallery.tsx:27 width: 200
- src/ui/Gallery.tsx:30 maxWidth: 180
- src/ui/Help.tsx:53 at ? { left: at.left, top: at.top

## duplicate selectors (same selector + media in several rules): 29
- `@media (max-width: 720px)|.alerts-page :is(.alarm-table` src/styles/alerts.css:20, src/styles/alerts.css:20, src/styles/alerts.css:21, src/styles/alerts.css:22, src/styles/alerts.css:23
- `|.form-row > label` src/styles/app.css:2, src/styles/ui.css:80
- `|.dialog-heading` src/styles/app.css:21, src/styles/app.css:22
- `|.dialog-actions` src/styles/app.css:21, src/styles/app.css:24
- `|body` src/styles/base.css:3, src/styles/base.css:4
- `|button` src/styles/base.css:10, src/styles/base.css:11
- `|select` src/styles/base.css:10, src/styles/base.css:26
- `|h1` src/styles/base.css:14, src/styles/base.css:15, src/styles/base.css:16
- `|h2` src/styles/base.css:14, src/styles/base.css:15, src/styles/base.css:17
- `|h3` src/styles/base.css:14, src/styles/base.css:15, src/styles/base.css:18
- `|p` src/styles/base.css:14, src/styles/base.css:19
- `|.cart-page .cart-totals` src/styles/cart.css:36, src/styles/cart.css:40
- `|.cart-page .cart-split dd` src/styles/cart.css:37, src/styles/cart.css:38, src/styles/cart.css:42
- `|.cart-page .cart-totals dd` src/styles/cart.css:38, src/styles/cart.css:41
- `|.grid-2` src/styles/detail.css:49, src/styles/shell.css:91
- `|.stack` src/styles/detail.css:50, src/styles/shell.css:92
- `|.compare-mid` src/styles/detail.css:62, src/styles/detail.css:65
- `|.save` src/styles/detail.css:90, src/styles/wishlist.css:40
- `|.save.big` src/styles/detail.css:91, src/styles/wishlist.css:41
- `|.save.none` src/styles/detail.css:92, src/styles/wishlist.css:42
- `@media (max-width: 1180px)|.grid-2` src/styles/detail.css:181, src/styles/shell.css:128
- `@media (max-width: 720px)|.compare-mid` src/styles/detail.css:185, src/styles/detail.css:186, src/styles/detail.css:187
- `@media (max-width: 720px)|.delta-amount` src/styles/detail.css:188, src/styles/detail.css:189
- `|.library-page .lib.rows .lib-item .game-cover` src/styles/library.css:36, src/styles/library.css:38
- `|.world-cell` src/styles/offers.css:2, src/styles/wishlist.css:37
- `|.search-platform` src/styles/shell.css:119, src/styles/shell.css:120
- `@media (max-width: 720px)|table.wl thead` src/styles/wishlist.css:59, src/styles/wishlist.css:60
- `|.game-cell .title-open` src/styles/wishlist.css:82, src/styles/wishlist.css:84
- `|.game-cell .cover-open` src/styles/wishlist.css:82, src/styles/wishlist.css:83

## conflicting declarations (same selector+prop, different value): 7
- `@media (max-width: 720px)|.alerts-page :is(.alarm-table|display` src/styles/alerts.css:20=block | src/styles/alerts.css:20=block | src/styles/alerts.css:21=grid
- `@media (max-width: 720px)|.alerts-page :is(.alarm-table|padding` src/styles/alerts.css:21=12px | src/styles/alerts.css:23=0
- `@media (max-width: 720px)|.alerts-page :is(.alarm-table|border-bottom` src/styles/alerts.css:21=1px solid var(--line) | src/styles/alerts.css:22=0
- `|.dialog-actions|justify-content` src/styles/app.css:21=space-between | src/styles/app.css:24=flex-end
- `|.dialog-actions|gap` src/styles/app.css:21=12px | src/styles/app.css:24=8px
- `|select|color` src/styles/base.css:10=inherit | src/styles/base.css:28=var(--text)
- `|.cart-page .cart-totals|margin` src/styles/cart.css:36=6px 0 0 | src/styles/cart.css:40=0

## identical repeated declarations: 19
- `|.form-row > label|font-size` src/styles/app.css:2, src/styles/ui.css:80
- `|.form-row > label|color` src/styles/app.css:2, src/styles/ui.css:80
- `|.cart-page .cart-split dd|margin` src/styles/cart.css:37, src/styles/cart.css:38
- `|.grid-2|display` src/styles/detail.css:49, src/styles/shell.css:91
- `|.grid-2|grid-template-columns` src/styles/detail.css:49, src/styles/shell.css:91
- `|.grid-2|gap` src/styles/detail.css:49, src/styles/shell.css:91
- `|.grid-2|align-items` src/styles/detail.css:49, src/styles/shell.css:91
- `|.stack|display` src/styles/detail.css:50, src/styles/shell.css:92
- `|.stack|gap` src/styles/detail.css:50, src/styles/shell.css:92
- `|.stack|min-width` src/styles/detail.css:50, src/styles/shell.css:92
- `|.save|font` src/styles/detail.css:90, src/styles/wishlist.css:40
- `|.save|white-space` src/styles/detail.css:90, src/styles/wishlist.css:40
- `|.save.big|color` src/styles/detail.css:91, src/styles/wishlist.css:41
- `|.save.none|color` src/styles/detail.css:92, src/styles/wishlist.css:42
- `@media (max-width: 1180px)|.grid-2|grid-template-columns` src/styles/detail.css:181, src/styles/shell.css:128
- `|.world-cell|display` src/styles/offers.css:2, src/styles/wishlist.css:37
- `|.world-cell|align-items` src/styles/offers.css:2, src/styles/wishlist.css:37
- `|.world-cell|gap` src/styles/offers.css:2, src/styles/wishlist.css:37
- `|.world-cell|white-space` src/styles/offers.css:2, src/styles/wishlist.css:37

## classes styled in several files: 64
- .head-actions: src/styles/alerts.css, src/styles/library.css, src/styles/shell.css
- .game-cell: src/styles/alerts.css, src/styles/cart.css, src/styles/wishlist.css
- .game-cover: src/styles/alerts.css, src/styles/catalog.css, src/styles/detail.css, src/styles/library.css
- .cover-fallback: src/styles/alerts.css, src/styles/catalog.css, src/styles/library.css
- .key-mark: src/styles/alerts.css, src/styles/catalog.css, src/styles/library.css, src/styles/shell.css
- .save: src/styles/alerts.css, src/styles/detail.css, src/styles/wishlist.css
- .reached: src/styles/alerts.css, src/styles/detail.css
- .none: src/styles/alerts.css, src/styles/detail.css, src/styles/wishlist.css
- .mono: src/styles/alerts.css, src/styles/base.css, src/styles/cart.css, src/styles/offers.css, src/styles/shell.css, src/styles/ui.css
- .c-game: src/styles/alerts.css, src/styles/cart.css, src/styles/wishlist.css
- .c-status: src/styles/alerts.css, src/styles/wishlist.css
- .c-target: src/styles/alerts.css, src/styles/wishlist.css
- .text-button: src/styles/alerts.css, src/styles/app.css, src/styles/detail.css, src/styles/settings.css
- .form-row: src/styles/app.css, src/styles/detail.css, src/styles/pages.css, src/styles/settings.css, src/styles/ui.css
- .notice: src/styles/app.css, src/styles/catalog.css, src/styles/detail.css, src/styles/library.css, src/styles/pages.css, src/styles/shell.css
- .error: src/styles/app.css, src/styles/settings.css, src/styles/ui.css
- .btn: src/styles/app.css, src/styles/catalog.css, src/styles/pages.css, src/styles/ui.css
- .dialog-heading: src/styles/app.css, src/styles/catalog.css
- .dialog-actions: src/styles/app.css, src/styles/detail.css
- .num: src/styles/base.css, src/styles/detail.css
- .label: src/styles/base.css, src/styles/detail.css, src/styles/settings.css, src/styles/shell.css, src/styles/ui.css
- .faint: src/styles/base.css, src/styles/cart.css
- .hint: src/styles/base.css, src/styles/cart.css, src/styles/settings.css, src/styles/ui.css
- .gcover: src/styles/cart.css, src/styles/detail.css, src/styles/wishlist.css
- .gcover-title: src/styles/cart.css, src/styles/detail.css, src/styles/wishlist.css
- .seg: src/styles/cart.css, src/styles/detail.css, src/styles/ui.css
- .icon-btn: src/styles/cart.css, src/styles/library.css, src/styles/settings.css, src/styles/shell.css, src/styles/ui.css
- .inset: src/styles/cart.css, src/styles/ui.css
- .with-help: src/styles/cart.css, src/styles/ui.css
- .key-mark-fill: src/styles/catalog.css, src/styles/shell.css
- .search-hint: src/styles/catalog.css, src/styles/shell.css
- .field: src/styles/catalog.css, src/styles/settings.css, src/styles/ui.css
- .small: src/styles/detail.css, src/styles/shell.css
- .danger: src/styles/detail.css, src/styles/library.css, src/styles/ui.css
- .note: src/styles/detail.css, src/styles/settings.css, src/styles/ui.css
- .row: src/styles/detail.css, src/styles/ui.css
- .grid-2: src/styles/detail.css, src/styles/shell.css
- .stack: src/styles/detail.css, src/styles/shell.css
- .panel-head: src/styles/detail.css, src/styles/settings.css, src/styles/ui.css
- .count: src/styles/detail.css, src/styles/shell.css
- .pad: src/styles/detail.css, src/styles/ui.css
- .big-price: src/styles/detail.css, src/styles/ui.css
- .stale: src/styles/detail.css, src/styles/offers.css, src/styles/ui.css
- .form-grid: src/styles/detail.css, src/styles/settings.css, src/styles/ui.css
- .ok: src/styles/detail.css, src/styles/ui.css
- .warn: src/styles/detail.css, src/styles/settings.css, src/styles/ui.css, src/styles/wishlist.css
- .r: src/styles/detail.css, src/styles/ui.css, src/styles/wishlist.css
- .big: src/styles/detail.css, src/styles/wishlist.css
- .line: src/styles/detail.css, src/styles/library.css
- .spacer: src/styles/detail.css, src/styles/ui.css
- .world: src/styles/detail.css, src/styles/ui.css
- .on: src/styles/detail.css, src/styles/ui.css, src/styles/wishlist.css
- .kpi: src/styles/detail.css, src/styles/ui.css
- .kpi-val: src/styles/detail.css, src/styles/ui.css
- .switch: src/styles/detail.css, src/styles/settings.css, src/styles/ui.css
- .pill: src/styles/detail.css, src/styles/ui.css
- .world-cell: src/styles/offers.css, src/styles/wishlist.css
- .table-wrap: src/styles/offers.css, src/styles/ui.css
- .brand: src/styles/pages.css, src/styles/shell.css
- .dot: src/styles/settings.css, src/styles/ui.css
- .spinner: src/styles/settings.css, src/styles/ui.css
- .page-head: src/styles/settings.css, src/styles/shell.css
- .bar: src/styles/settings.css, src/styles/ui.css
- .kpi-foot: src/styles/ui.css, src/styles/wishlist.css

## classes never referenced in TS/TSX: 10
- .field-label: src/styles/app.css:2
- .field-help: src/styles/app.css:3
- .card-footnote: src/styles/app.css:7
- .source-link: src/styles/app.css:8
- .status-dot: src/styles/app.css:10, src/styles/app.css:11
- .chart-hint: src/styles/detail.css:136
- .alert-form: src/styles/pages.css:2, src/styles/pages.css:3
- .set-add: src/styles/settings.css:47, src/styles/settings.css:48
- .col-order-hint: src/styles/settings.css:77
- .lv-error: src/styles/settings.css:106

## tokens: 118 (48 v4, 70 legacy aliases)
unused (no reference outside tokens.css): --bp-sm, --bp-md, --bp-lg, --color-bg, --color-surface, --color-overlay, --color-border, --color-track, --color-track-fill, --color-text, --color-text-disabled, --color-accent, --color-accent-text, --color-on-accent, --color-accent-ring, --color-best, --color-best-text, --color-best-bg, --color-best-ring, --color-glass, --color-backdrop, --color-warn, --color-warn-bg, --color-danger, --color-danger-text, --color-danger-bg, --color-neutral-bg, --color-neutral-ring, --color-dot-muted, --text-xs, --text-md, --text-lg, --text-xl, --text-2xl, --tracking-title, --tracking-mono, --weight-regular, --weight-medium, --weight-bold, --space-1, --space-3, --space-4, --space-5, --space-6, --space-page, --space-panel, --radius-lg, --radius-control, --radius-card, --radius-sheet, --radius-pill, --shadow-overlay, --motion-fast, --ease, --control-h, --control-h-sm, --control-h-touch, --focus-ring
legacy aliases still used:
- --color-raised: src/styles/detail.css×1
- --color-overlay-hover: src/styles/detail.css×1
- --color-border-strong: src/styles/detail.css×1
- --color-text-soft: src/styles/detail.css×1
- --color-text-muted: src/styles/detail.css×1
- --color-accent-bg: src/styles/detail.css×1
- --font-mono: src/styles/detail.css×1
- --text-sm: src/styles/detail.css×2
- --weight-semibold: src/styles/detail.css×1
- --space-2: src/styles/detail.css×1
- --radius-sm: src/styles/detail.css×1
- --radius-md: src/styles/detail.css×1
referenced but undefined: 

## icons
size props: 14px×9, 15px×5, 12px×2, 20px×1 | default 16: 82
CSS svg sizes: 15px×16, 14px×10, 16px×8, 12px×6, 13px×4, 100%×1, auto×1
raw <svg> in TSX:
- src/brand.tsx <svg className={small ? 'key-mark small' : 'key-mark'} viewBox="0 0 32 32" aria-hidden="true">
- src/brand.tsx <svg className="brand" viewBox="0 0 191 32" role="img" aria-label={label}>
- src/features/PriceMatrix.tsx <svg viewBox={`0 0 ${width} ${H + 26}`} role="img" tabIndex={0} aria-label={label} onKeyDown={keys} 
- src/ui/Icon.tsx <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="curren
text glyphs used as icons:
- src/features/EditionComparison.tsx:76 ✓ — <p className="panel-foot"><span>✓ in der offiziellen Bundle-Liste · — dort nicht enthalten · ? nicht belegt. H
- src/features/InfosTab.tsx:79 → — {link.renamed && <span className="rename-note">Shop-Titel geändert: „{link.renamed.from}“ → „{link.renamed.to}
- src/features/LinkReview.tsx:62 → — {renamed && <p>Der Shop hat den Titel geändert: „{link.renamed!.from}“ → „{link.renamed!.to}“.</p>}
- src/features/wishlist-model.ts:38 → — /** Daily target-country best price, oldest → newest (the badge trend), null when the badge has none. */
- src/features/wishlist-model.ts:144 → — /** First two words of a title for the KPI foot ("Indiana Jones und der Große Kreis" → "Indiana Jones"). */

## component usage
- Button component (<Button): 55
- IconButton component (<IconButton): 25
- raw <button className="btn: 1 (src/ui/Help.tsx:46)
- raw <button className="icon-btn: 0 ()
- raw <a className="btn: 5 (src/features/InfosTab.tsx:86, src/features/LinkReview.tsx:57, src/features/Offers.tsx:94, src/features/PriceTab.tsx:108, src/features/PriceTab.tsx:109)
- .text-button usages: 3 (src/features/Offers.tsx:104, src/features/PriceAlerts.tsx:25, src/features/settings/FetchPanel.tsx:60)
- Button variant="primary": 12
- Button variant="ghost": 18
- Button variant="danger": 6
- size="sm": 19
- Chip component: 2
- Pill component: 41
- raw className="pill: 1 (src/features/GameDetail.tsx:107)
- Seg component: 10
- Tabs component: 7
- Field component: 8
- FormRow component: 1
- raw className="form-row": 19 
- Switch component: 8
- <dialog: 4 (src/components.tsx:18, src/features/CatalogSearch.tsx:143, src/features/LinkReview.tsx:40, src/features/settings/UnsavedDialog.tsx:16)
- <table: 11 (src/features/Cart.tsx:99, src/features/EditionComparison.tsx:62, src/features/Offers.tsx:70, src/features/PriceAlerts.tsx:128, src/features/PriceAlerts.tsx:150, src/features/PriceMatrix.tsx:95, src/features/Wishlist.tsx:440, src/features/settings/FetchPanel.tsx:87, src/features/settings/FetchPanel.tsx:112, src/features/settings/Log.tsx:27, src/ui/Gallery.tsx:34)
- Panel component: 28
- raw className="panel: 4 (src/features/AuthScreen.tsx:17, src/features/EditionComparison.tsx:76, src/features/Offers.tsx:101, src/features/SettingsPage.tsx:73)
- Toast (old, bottom centre): 3 (src/ui/Gallery.tsx:38, src/ui/Toaster.tsx:37, src/ui/Toaster.tsx:38)
- notify() popups: 12
- .notice usages: 3 (src/components.tsx:12, src/features/SettingsPage.tsx:18, src/notify.ts:3)
- .note usages: 16 
- EmptyState component: 8
- raw className="empty: 5 (src/features/Library.tsx:128, src/features/Library.tsx:130, src/features/Wishlist.tsx:435, src/features/Wishlist.tsx:438, src/ui/Layout.tsx:60)
- Help component: 23
- Popover component: 2
- .gcover (GameCover old): 2 (src/features/GameCover.tsx:9, src/features/GameCover.tsx:10)
- .game-cover: 2 (src/features/GameDetail.tsx:98, src/features/catalog-ui.tsx:32)
- select elements: 12
- input elements: 18
