// Design-system inventory of the KeyHunter frontend (read-only). Usage: node inventory.mjs <frontend-dir> <out-dir>
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const [frontend, out] = process.argv.slice(2);
const require = createRequire(join(frontend, 'package.json'));
const postcss = require('postcss');
mkdirSync(out, { recursive: true });

const walk = dir => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const src = join(frontend, 'src');
const cssFiles = walk(join(src, 'styles')).filter(f => f.endsWith('.css'));
const tsFiles = walk(src).filter(f => /\.(tsx?|mjs)$/.test(f));
const rel = f => relative(frontend, f);
const tsText = Object.fromEntries(tsFiles.map(f => [f, readFileSync(f, 'utf8')]));
const allTs = Object.values(tsText).join('\n');

// ---------- CSS walk ----------
const decls = []; // {file, line, selector, media, prop, value}
const rules = []; // {file, line, selector, media}
const atMedia = []; // {file, line, params, name}
const roots = {};
for (const file of cssFiles) {
  const root = postcss.parse(readFileSync(file, 'utf8'), { from: file });
  roots[file] = root;
  root.walkAtRules(at => { if (at.name === 'media' || at.name === 'container') atMedia.push({ file: rel(file), line: at.source.start.line, name: at.name, params: at.params }); });
  root.walkRules(rule => {
    if (rule.parent?.type === 'atrule' && rule.parent.name === 'keyframes') return;
    const media = rule.parent?.type === 'atrule' ? `@${rule.parent.name} ${rule.parent.params}` : '';
    rules.push({ file: rel(file), line: rule.source.start.line, selector: rule.selector.replace(/\s+/g, ' '), media });
    rule.walkDecls(d => decls.push({ file: rel(file), line: d.source.start.line, selector: rule.selector.replace(/\s+/g, ' '), media, prop: d.prop, value: d.value, important: d.important }));
  });
}
const tokensFile = cssFiles.find(f => basename(f) === 'tokens.css');
const nonToken = decls.filter(d => d.file !== rel(tokensFile));

// ---------- 1. colour literals outside tokens.css ----------
const colorRe = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|color-mix)\([^)]*\)?/g;
const namedColors = /\b(white|black|red|green|blue|orange|yellow|gray|grey)\b/;
const colorLits = [];
for (const d of nonToken) {
  const m = d.value.match(colorRe);
  if (m) colorLits.push({ ...d, literals: m });
  else if (namedColors.test(d.value) && !d.prop.startsWith('--')) colorLits.push({ ...d, literals: [d.value.match(namedColors)[0]] });
}
const tsColor = [];
for (const [f, t] of Object.entries(tsText)) t.split('\n').forEach((l, i) => {
  const m = l.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-fA-F])|\brgba?\([^)]*\)/g);
  if (m && !/^\s*(\/\/|\*)/.test(l)) tsColor.push({ file: rel(f), line: i + 1, literals: m, text: l.trim().slice(0, 140) });
});

// ---------- 2. typography / shape / spacing values ----------
const count = (arr, key) => { const c = {}; for (const x of arr) { const k = key(x); c[k] = (c[k] || 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1]); };
const fontSize = [];
const fontWeight = [];
const lineHeight = [];
const fontFamily = [];
for (const d of nonToken) {
  if (d.prop === 'font-size') fontSize.push({ ...d, v: d.value });
  if (d.prop === 'font-weight') fontWeight.push({ ...d, v: d.value });
  if (d.prop === 'line-height') lineHeight.push({ ...d, v: d.value });
  if (d.prop === 'font-family') fontFamily.push({ ...d, v: d.value });
  if (d.prop === 'font') {
    // font: [weight] size[/lh] family
    const m = d.value.match(/^(?:(\d{3}|normal|bold)\s+)?(\S+?)(?:\/(\S+))?\s+(.+)$/);
    if (m) {
      if (m[1]) fontWeight.push({ ...d, v: m[1] + ' (font)' });
      fontSize.push({ ...d, v: m[2] + ' (font)' });
      if (m[3]) lineHeight.push({ ...d, v: m[3] + ' (font)' });
      fontFamily.push({ ...d, v: m[4] + ' (font)' });
    }
  }
}
const radius = nonToken.filter(d => /radius/.test(d.prop)).map(d => ({ ...d, v: d.value }));
const shadow = nonToken.filter(d => d.prop === 'box-shadow').map(d => ({ ...d, v: d.value }));
const borders = nonToken.filter(d => /^border(-(top|bottom|left|right|inline|block)(-start|-end)?)?$/.test(d.prop) || /^border(-\w+)?-color$/.test(d.prop)).map(d => ({ ...d, v: d.value }));
const spacingProps = /^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|inline|block)(-start|-end)?)?$/;
const spacing = nonToken.filter(d => spacingProps.test(d.prop));
const spacingValues = [];
for (const d of spacing) for (const v of d.value.split(/\s+/)) if (/^-?\d/.test(v)) spacingValues.push({ ...d, v });
const sizeProps = /^(width|height|min-width|min-height|max-width|max-height)$/;
const sizes = nonToken.filter(d => sizeProps.test(d.prop) && /px/.test(d.value)).map(d => ({ ...d, v: `${d.prop}: ${d.value}` }));
const controlHeights = nonToken.filter(d => d.prop === 'height' && /^\d+px$|var\(--h-btn\)/.test(d.value)).map(d => ({ ...d, v: d.value }));

// literal vs token usage per property family
const usage = (list) => { let tok = 0, lit = 0; for (const d of list) { if (/var\(--/.test(d.value)) tok++; else lit++; } return { token: tok, literal: lit }; };

// ---------- 3. breakpoints ----------
const bpCss = count(atMedia, a => `@${a.name} ${a.params}`);

// ---------- 4. !important ----------
const important = decls.filter(d => d.important);

// ---------- 5. inline style= in TSX ----------
const inlineStyle = [];
for (const [f, t] of Object.entries(tsText)) t.split('\n').forEach((l, i) => {
  const re = /style=\{\{([^}]*)\}\}|style=\{(?!\{)([^}]*)\}/g; let m;
  while ((m = re.exec(l))) inlineStyle.push({ file: rel(f), line: i + 1, style: (m[1] ?? m[2]).trim().slice(0, 120) });
});

// ---------- 6. selectors / classes ----------
const classOf = sel => [...sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(m => m[1]);
const classDefs = {}; // class -> Set(files)
for (const r of rules) for (const c of new Set(classOf(r.selector))) (classDefs[c] ??= new Set()).add(r.file);
// exact duplicate selectors (same selector text, same media) across or within files
const selKey = r => `${r.media}|${r.selector}`;
const bySel = {};
for (const r of rules) for (const s of r.selector.split(/,\s*/)) (bySel[`${r.media}|${s.trim()}`] ??= []).push(`${r.file}:${r.line}`);
const dupSelectors = Object.entries(bySel).filter(([, at]) => at.length > 1).map(([k, at]) => ({ selector: k, at }));
// conflicting duplicates: same selector+prop with a different value
const bySelProp = {};
for (const d of decls) for (const s of d.selector.split(/,\s*/)) (bySelProp[`${d.media}|${s.trim()}|${d.prop}`] ??= []).push({ at: `${d.file}:${d.line}`, value: d.value });
const conflicts = Object.entries(bySelProp).filter(([, v]) => v.length > 1).map(([k, v]) => ({ key: k, defs: v, differs: new Set(v.map(x => x.value)).size > 1 }));
// classes defined (as the subject or anywhere) in more than one file
const multiFile = Object.entries(classDefs).filter(([, s]) => s.size > 1).map(([c, s]) => ({ class: c, files: [...s] }));
// unused classes: class token never appears in any TS/TSX source as a word
const wordIn = (w) => new RegExp(`(^|[^\\w-])${w.replace(/[-]/g, '\\-')}([^\\w-]|$)`).test(allTs);
const unused = Object.keys(classDefs).filter(c => !wordIn(c)).map(c => ({ class: c, files: [...classDefs[c]], at: rules.filter(r => classOf(r.selector).includes(c)).map(r => `${r.file}:${r.line}`) }));

// ---------- 7. tokens ----------
const tokenDefs = [];
roots[tokensFile].walkDecls(d => { if (d.prop.startsWith('--')) tokenDefs.push({ name: d.prop, value: d.value, line: d.source.start.line }); });
const allCss = cssFiles.map(f => readFileSync(f, 'utf8')).join('\n');
const refs = (name) => {
  const re = new RegExp(`var\\(${name.replace(/[-]/g, '\\-')}[,)\\s]`, 'g');
  const inCss = cssFiles.map(f => ({ f: rel(f), n: (readFileSync(f, 'utf8').match(re) || []).length })).filter(x => x.n);
  const inTs = (allTs.match(re) || []).length;
  return { inCss, inTs };
};
const tokens = tokenDefs.map(t => { const r = refs(t.name); const total = r.inCss.reduce((a, x) => a + x.n, 0) + r.inTs; return { ...t, refs: total, where: r.inCss.map(x => `${x.f}×${x.n}`).concat(r.inTs ? [`ts×${r.inTs}`] : []) }; });
// legacy alias usage outside tokens.css
const legacy = tokens.filter(t => t.line > 75);
const legacyUsedOutside = legacy.map(t => ({ ...t, outside: t.where.filter(w => !w.startsWith('src/styles/tokens.css')) })).filter(t => t.outside.length);
const v4 = tokens.filter(t => t.line <= 75);
const unusedTokens = tokens.filter(t => t.where.filter(w => !w.startsWith('src/styles/tokens.css')).length === 0);
const missingTokens = [...new Set([...allCss.matchAll(/var\((--[\w-]+)/g)].map(m => m[1]))].filter(n => !tokenDefs.find(t => t.name === n) && !/--score/.test(n));

// ---------- 8. icon sizes ----------
const iconSizeTs = [];
for (const [f, t] of Object.entries(tsText)) for (const m of t.matchAll(/<Icon [^>]*?size=\{(\d+)\}/g)) iconSizeTs.push({ file: rel(f), v: m[1] });
const iconDefaultTs = [];
for (const [f, t] of Object.entries(tsText)) for (const m of t.matchAll(/<Icon (?![^>]*size=)[^>]*>/g)) iconDefaultTs.push({ file: rel(f) });
const iconSizeCss = nonToken.filter(d => /svg/.test(d.selector) && (d.prop === 'width' || d.prop === 'height')).map(d => ({ ...d, v: d.value }));
const otherSvg = [];
for (const [f, t] of Object.entries(tsText)) for (const m of t.matchAll(/<svg\b[^>]*>/g)) otherSvg.push({ file: rel(f), tag: m[0].slice(0, 100) });
const emojiOrGlyph = [];
for (const [f, t] of Object.entries(tsText)) t.split('\n').forEach((l, i) => { const m = l.match(/[←-⇿⌀-⏿☀-➿⬀-⯿\u{1F300}-\u{1FAFF}✓✗×▲▼◀▶↑↓→←]/gu); if (m && !/^\s*(\/\/|\*)/.test(l)) emojiOrGlyph.push({ file: rel(f), line: i + 1, glyphs: [...new Set(m)].join(' '), text: l.trim().slice(0, 110) }); });

// ---------- 9. component variants ----------
const grepTs = (re) => { const hits = []; for (const [f, t] of Object.entries(tsText)) t.split('\n').forEach((l, i) => { if (re.test(l)) hits.push(`${rel(f)}:${i + 1}`); }); return hits; };
const variants = {
  'Button component (<Button)': grepTs(/<Button\b/).length,
  'IconButton component (<IconButton)': grepTs(/<IconButton\b/).length,
  'raw <button className="btn': grepTs(/<button[^>]*className=["{`][^"}`]*\bbtn\b/),
  'raw <button className="icon-btn': grepTs(/<button[^>]*className=["{`][^"}`]*\bicon-btn\b/),
  'raw <a className="btn': grepTs(/<a\b[^>]*className=["{`][^"}`]*\bbtn\b/),
  '.text-button usages': grepTs(/text-button/),
  'Button variant="primary"': grepTs(/variant="primary"/).length,
  'Button variant="ghost"': grepTs(/variant="ghost"/).length,
  'Button variant="danger"': grepTs(/variant="danger"/).length,
  'size="sm"': grepTs(/size="sm"/).length,
  'Chip component': grepTs(/<Chip\b/).length,
  'Pill component': grepTs(/<Pill\b/).length,
  'raw className="pill': grepTs(/className=["{`][^"}`]*\bpill\b/),
  'Seg component': grepTs(/<Seg\b/).length,
  'Tabs component': grepTs(/<Tabs\b/).length,
  'Field component': grepTs(/<Field\b/).length,
  'FormRow component': grepTs(/<FormRow\b/).length,
  'raw className="form-row"': grepTs(/className=["{`][^"}`]*\bform-row\b/),
  'Switch component': grepTs(/<Switch\b/).length,
  '<dialog': grepTs(/<dialog\b/),
  '<table': grepTs(/<table\b/),
  'Panel component': grepTs(/<Panel\b/).length,
  'raw className="panel': grepTs(/className=["{`][^"}`]*\bpanel\b/),
  'Toast (old, bottom centre)': grepTs(/<Toast\b/),
  'notify() popups': grepTs(/\bnotify(Error|Info|Success)?\(/).length,
  '.notice usages': grepTs(/\bnotice\b/),
  '.note usages': grepTs(/className=["{`][^"}`]*\bnote\b/),
  'EmptyState component': grepTs(/<EmptyState\b/).length,
  'raw className="empty': grepTs(/className=["{`][^"}`]*\bempty\b/),
  'Help component': grepTs(/<Help\b/).length,
  'Popover component': grepTs(/<Popover\b/).length,
  '.gcover (GameCover old)': grepTs(/gcover/),
  '.game-cover': grepTs(/game-cover/),
  'select elements': grepTs(/<select\b/).length,
  'input elements': grepTs(/<input\b/).length,
};

// ---------- write ----------
const result = {
  files: cssFiles.map(f => ({ file: rel(f), bytes: statSync(f).size, rules: rules.filter(r => r.file === rel(f)).length, decls: decls.filter(d => d.file === rel(f)).length })),
  totals: { rules: rules.length, decls: decls.length, classes: Object.keys(classDefs).length },
  colorLiteralsOutsideTokens: colorLits.map(d => ({ at: `${d.file}:${d.line}`, selector: d.selector, prop: d.prop, value: d.value })),
  colorLiteralsInTs: tsColor,
  fontSize: { usage: usage(fontSize), values: count(fontSize, d => d.v) },
  fontWeight: { usage: usage(fontWeight), values: count(fontWeight, d => d.v) },
  lineHeight: { values: count(lineHeight, d => d.v) },
  fontFamily: { values: count(fontFamily, d => d.v) },
  radius: { usage: usage(radius), values: count(radius, d => d.v), literal: radius.filter(d => !/var\(--/.test(d.value)).map(d => `${d.file}:${d.line} ${d.selector} → ${d.value}`) },
  shadow: { values: count(shadow, d => d.v), at: shadow.map(d => `${d.file}:${d.line} ${d.selector} → ${d.value}`) },
  borders: { usage: usage(borders), values: count(borders, d => d.v) },
  spacing: { declarations: spacing.length, usage: usage(spacing), values: count(spacingValues, d => d.v) },
  controlHeights: count(controlHeights, d => d.v),
  sizes: count(sizes, d => d.v).slice(0, 60),
  breakpointsCss: bpCss,
  breakpointsCssAt: atMedia.map(a => `${a.file}:${a.line} @${a.name} ${a.params}`),
  important: important.map(d => `${d.file}:${d.line} ${d.selector} { ${d.prop}: ${d.value} !important }`),
  inlineStyle,
  duplicateSelectors: dupSelectors,
  conflictingDeclarations: conflicts.filter(c => c.differs),
  repeatedIdenticalDeclarations: conflicts.filter(c => !c.differs),
  classesInSeveralFiles: multiFile,
  unusedClasses: unused,
  tokens: { total: tokenDefs.length, v4: v4.length, legacy: legacy.length, unused: unusedTokens.map(t => t.name), legacyStillUsed: legacyUsedOutside.map(t => ({ name: t.name, where: t.outside })), undefinedButReferenced: missingTokens, all: tokens.map(t => ({ name: t.name, value: t.value, refs: t.where })) },
  icons: { sizeProps: count(iconSizeTs, d => d.v), defaultSize16: iconDefaultTs.length, cssSvgSizes: count(iconSizeCss, d => d.v), cssSvgAt: iconSizeCss.map(d => `${d.file}:${d.line} ${d.selector} ${d.prop}:${d.value}`), rawSvg: otherSvg, glyphs: emojiOrGlyph },
  variants,
};
writeFileSync(join(out, 'inventory.json'), JSON.stringify(result, null, 2));
// short human summary
const lines = [];
const p = (...a) => lines.push(a.join(' '));
p('# Design inventory (generated)', new Date().toISOString());
p('\n## CSS files'); for (const f of result.files) p(`- ${f.file}: ${f.bytes} B, ${f.rules} rules, ${f.decls} declarations`);
p(`\nTotals: ${result.totals.rules} rules, ${result.totals.decls} declarations, ${result.totals.classes} distinct classes`);
p(`\n## Colour literals outside tokens.css: ${colorLits.length}`); for (const c of result.colorLiteralsOutsideTokens) p(`- ${c.at} \`${c.selector}\` ${c.prop}: ${c.value}`);
p(`\n## Colour literals in TS/TSX: ${tsColor.length}`); for (const c of tsColor) p(`- ${c.file}:${c.line} ${c.literals.join(' ')}`);
p('\n## font-size', JSON.stringify(result.fontSize.usage)); for (const [v, n] of result.fontSize.values) p(`- ${v}: ${n}`);
p('\n## font-weight', JSON.stringify(result.fontWeight.usage)); for (const [v, n] of result.fontWeight.values) p(`- ${v}: ${n}`);
p('\n## line-height'); for (const [v, n] of result.lineHeight.values) p(`- ${v}: ${n}`);
p('\n## font-family'); for (const [v, n] of result.fontFamily.values) p(`- ${v}: ${n}`);
p('\n## border-radius', JSON.stringify(result.radius.usage)); for (const [v, n] of result.radius.values) p(`- ${v}: ${n}`);
p('\n## box-shadow'); for (const a of result.shadow.at) p(`- ${a}`);
p('\n## spacing values (padding/margin/gap)', JSON.stringify(result.spacing.usage)); p(result.spacing.values.map(([v, n]) => `${v}×${n}`).join(', '));
p('\n## heights (literal px / --h-btn)'); p(result.controlHeights.map(([v, n]) => `${v}×${n}`).join(', '));
p('\n## @media / @container'); for (const [v, n] of result.breakpointsCss) p(`- ${v}: ${n}`);
p(`\n## !important: ${important.length}`); for (const i of result.important) p(`- ${i}`);
p(`\n## inline style= in TSX: ${inlineStyle.length}`); for (const s of inlineStyle) p(`- ${s.file}:${s.line} ${s.style}`);
p(`\n## duplicate selectors (same selector + media in several rules): ${dupSelectors.length}`); for (const d of dupSelectors) p(`- \`${d.selector}\` ${d.at.join(', ')}`);
p(`\n## conflicting declarations (same selector+prop, different value): ${result.conflictingDeclarations.length}`); for (const c of result.conflictingDeclarations) p(`- \`${c.key}\` ${c.defs.map(d => `${d.at}=${d.value}`).join(' | ')}`);
p(`\n## identical repeated declarations: ${result.repeatedIdenticalDeclarations.length}`); for (const c of result.repeatedIdenticalDeclarations) p(`- \`${c.key}\` ${c.defs.map(d => d.at).join(', ')}`);
p(`\n## classes styled in several files: ${multiFile.length}`); for (const m of multiFile) p(`- .${m.class}: ${m.files.join(', ')}`);
p(`\n## classes never referenced in TS/TSX: ${unused.length}`); for (const u of unused) p(`- .${u.class}: ${u.at.join(', ')}`);
p(`\n## tokens: ${tokenDefs.length} (${v4.length} v4, ${legacy.length} legacy aliases)`); p(`unused (no reference outside tokens.css): ${result.tokens.unused.join(', ')}`);
p('legacy aliases still used:'); for (const l of result.tokens.legacyStillUsed) p(`- ${l.name}: ${l.where.join(', ')}`);
p(`referenced but undefined: ${missingTokens.join(', ')}`);
p('\n## icons'); p('size props:', result.icons.sizeProps.map(([v, n]) => `${v}px×${n}`).join(', '), `| default 16: ${result.icons.defaultSize16}`);
p('CSS svg sizes:', result.icons.cssSvgSizes.map(([v, n]) => `${v}×${n}`).join(', '));
p('raw <svg> in TSX:'); for (const s of result.icons.rawSvg) p(`- ${s.file} ${s.tag}`);
p('text glyphs used as icons:'); for (const g of result.icons.glyphs) p(`- ${g.file}:${g.line} ${g.glyphs} — ${g.text}`);
p('\n## component usage'); for (const [k, v] of Object.entries(variants)) p(`- ${k}: ${Array.isArray(v) ? `${v.length} ${v.length <= 12 ? '(' + v.join(', ') + ')' : ''}` : v}`);
writeFileSync(join(out, 'inventory.md'), lines.join('\n') + '\n');
console.log(lines.slice(0, 400).join('\n'));
