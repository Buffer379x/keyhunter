import { useEffect, useRef, useState } from 'react';
import type { CatalogGame, PriceBadgeData, WishlistItem } from '../api';
import { Button, Icon, Notice, TabPanel, Tabs } from '../components';
import { editionName } from './EditionComparison';
import EditionComparison from './EditionComparison';
import GameCover from './GameCover';
import HistoryTab from './HistoryTab';
import InfosTab, { reviewLinks } from './InfosTab';
import OffersTab from './Offers';
import { offerRows, summarize } from './offers-model';
import type { Basis } from './offers-model';
import { AlertEditor, ruleTarget, useAlertRule } from './PriceAlerts';
import type { AlertState, Rule } from './PriceAlerts';
import PriceBadge from './PriceBadge';
import PriceTab from './PriceTab';
import Popover from './Popover';
import { money } from './price-format';
import { itemName, kindName, platformName } from './catalog-ui';
import { useOffersView } from './useOffersView';

export const tabIds = ['preis', 'angebote', 'verlauf', 'editionen', 'alarm', 'infos'] as const;
export type TabId = typeof tabIds[number];
export const isTab = (value: string | null | undefined): value is TabId => !!value && (tabIds as readonly string[]).includes(value);

type Props = {
  item: WishlistItem; viewed: WishlistItem; preview: boolean; variants: CatalogGame[]; editionItems: WishlistItem[]; editionError: string;
  badges: Record<string, PriceBadgeData>; csrf: string; targetCountry: string | null; targetLabel: string; tab: TabId;
  purchasing: boolean; onTab: (tab: TabId) => void; onBack: () => void; onPurchase: () => void; onRemove: () => void;
  onView: (game: CatalogGame) => void; onClearPreview: () => void; onBadge: (id: string, badge: PriceBadgeData) => void;
  onSettings: () => void; onError: (error: unknown) => void; onRule: (id: string, rule: Rule | null) => void;
};

function useWidth(ref: { current: HTMLElement | null }) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export default function GameDetail(props: Props) {
  const { item, viewed, preview, variants, editionItems, editionError, badges, csrf, targetCountry, targetLabel, tab, purchasing, onTab, onBack, onPurchase, onRemove, onView, onClearPreview, onBadge, onSettings, onError } = props;
  const alert = useAlertRule(item.id, csrf, onError);
  const { onRule } = props;
  useEffect(() => { if (alert.ready) onRule(item.id, alert.rule); }, [alert.ready, alert.rule, item.id, onRule]);
  const game = viewed.game;
  const artwork = game?.artwork_url ?? null;
  const [artworkFailed, setArtworkFailed] = useState(false);
  useEffect(() => setArtworkFailed(false), [artwork]);
  const target = preview ? null : ruleTarget(alert.rule);
  const platforms = game ? [...game.platforms].sort((a, b) => Number(b.id === item.platform_id) - Number(a.id === item.platform_id)).map(p => p.name) : [];
  const meta = [...(platforms.length ? platforms.slice(0, 3) : [platformName(item.platform_id)]), game?.first_release_date ? String(new Date(game.first_release_date * 1000).getUTCFullYear()) : null].filter(Boolean).join(' · ');
  const savedName = item.game ? editionName(item.game) : itemName(item);
  const viewedName = game ? editionName(game) : itemName(viewed);
  const badgeOfItem = (it: WishlistItem | undefined) => it ? badges[it.id] ?? it.price_badge : undefined;
  const itemOf = (g: CatalogGame) => g.igdb_id === item.game?.igdb_id ? item : editionItems.find(it => it.game?.igdb_id === g.igdb_id);

  return <section className="game-detail" aria-labelledby="game-title">
    <header className={`gd-hero ${artwork && !artworkFailed ? 'has-art' : ''}`}>
      <div className="gd-art" aria-hidden="true">{artwork && !artworkFailed && <img src={artwork} alt="" referrerPolicy="no-referrer" onError={() => setArtworkFailed(true)} />}</div>
      {artwork && !artworkFailed && <span className="gd-credit ui-mono">Artwork · IGDB</span>}
      <Button variant="secondary" className="gd-back" aria-label="Zur Wunschliste" onClick={onBack}><Icon name="arrow" size={18} /><span>Wunschliste</span></Button>
      <div className="gd-bar">
        <GameCover className="gd-cover" src={game?.cover_url} title={itemName(viewed)} />
        <div className="gd-title">
          <span className="ui-mono soft gd-meta">{meta}</span>
          <h2 id="game-title">{itemName(viewed)}</h2>
          <div className="gd-sub">
            {item.game ? <EditionPicker variants={variants} item={item} viewed={viewed} preview={preview} editionError={editionError} badgeOf={g => badgeOfItem(itemOf(g))} canView={g => g.igdb_id === item.game?.igdb_id || !!itemOf(g)} onView={onView} />
              : <span className="gd-edition static">Manuell · ungeprüft</span>}
            <span className="gd-kind">{game ? kindName(game) : ''}</span>
          </div>
        </div>
        {!preview && <div className="gd-actions">
          <button type="button" className="gd-action alarm" onClick={() => onTab('alarm')}><Icon name="bell" size={17} /><span className="gd-action-label">{target !== null ? `Ziel ${money(target)}` : 'Preisalarm'}</span></button>
          <button type="button" className="gd-action buy" disabled={purchasing} onClick={onPurchase}>{purchasing ? 'Wird verschoben …' : 'Gekauft'}</button>
          <Popover menu align="end" triggerLabel="Weitere Aktionen" triggerClassName="gd-action more" trigger={<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>}>
            {close => <>
              <button type="button" role="menuitem" className="menu-compact" disabled={purchasing} onClick={() => { close(); onPurchase(); }}><Icon name="library" size={16} />Gekauft</button>
              <button type="button" role="menuitem" className="danger" onClick={() => { close(); onRemove(); }}><Icon name="heart" size={16} />Von Wunschliste entfernen</button>
            </>}
          </Popover>
        </div>}
      </div>
    </header>
    {preview && <div className="gd-preview" role="status"><span>Vorschau: <strong>{viewedName}</strong> · gemerkt ist {savedName}</span><Button size="sm" variant="secondary" onClick={onClearPreview}>Zur gemerkten Edition</Button></div>}
    {!targetCountry && <div className="country-callout"><span>Wähle dein Zielland für den Preisvergleich.</span><Button secondary onClick={onSettings}>Zielland wählen</Button></div>}
    {item.verification !== 'catalog' && <Notice>{item.verification === 'needs_review' ? 'Die Katalogdaten bestätigen diese Auswahl nicht mehr. Bitte prüfe Plattform und Produkttyp.' : 'Manueller Titel · Zuordnungen werden vor dem Preisvergleich geprüft.'}</Notice>}
    <DetailBody key={viewed.id} {...props} alert={alert} rule={preview ? null : alert.rule} savedName={savedName} />
  </section>;
}

function EditionPicker({ variants, item, viewed, preview, editionError, badgeOf, canView, onView }: { variants: CatalogGame[]; item: WishlistItem; viewed: WishlistItem; preview: boolean; editionError: string; badgeOf: (game: CatalogGame) => PriceBadgeData | undefined; canView: (game: CatalogGame) => boolean; onView: (game: CatalogGame) => void }) {
  const current = viewed.game ?? item.game!;
  return <Popover triggerClassName="gd-edition" triggerLabel={undefined} trigger={<><span>{editionName(current)}</span><span className="gd-edition-state">· {preview ? 'Vorschau' : 'gemerkt'}</span><Icon name="arrow" size={14} /></>} panelClassName="edition-panel">
    {close => <>
      <p className="edition-panel-title ui-mono">Edition ansehen · {variants.length} {variants.length === 1 ? 'Edition' : 'Editionen'}</p>
      {editionError && <p className="field-help">{editionError}</p>}
      <ul className="edition-list">{variants.map(game => <li key={game.igdb_id}>
        <button type="button" className={`edition-row ${current.igdb_id === game.igdb_id ? 'selected' : ''}`} aria-label={`${editionName(game)} ansehen`} disabled={!canView(game)} onClick={() => { close(); onView(game); }}>
          <GameCover small src={game.cover_url} title={editionName(game)} />
          <span className="edition-row-name"><strong>{editionName(game)}</strong><small>{game.version_parent ? 'Eigenständige Edition' : 'Hauptspiel'}</small></span>
          {item.game?.igdb_id === game.igdb_id && <span className="selection-badge">Gemerkt</span>}
          {preview && current.igdb_id === game.igdb_id && item.game?.igdb_id !== game.igdb_id && <span className="selection-badge preview">Vorschau</span>}
          <PriceBadge badge={badgeOf(game)} />
        </button></li>)}</ul>
    </>}
  </Popover>;
}

function DetailBody(props: Props & { alert: AlertState; rule: Rule | null; savedName: string }) {
  const { item, viewed, variants, csrf, targetCountry, targetLabel, tab, onTab, onBadge, onError, onSettings, onView, alert, rule, savedName, badges, editionItems } = props;
  const state = useOffersView(viewed.id, csrf, onError, onBadge);
  const { view } = state;
  const [basis, setBasis] = useState<Basis>('base');
  const body = useRef<HTMLDivElement>(null);
  const width = useWidth(body);
  const code = (targetCountry ?? view?.target_country ?? '').toUpperCase();
  const rows = offerRows(view, basis);
  const summary = summarize(view, rows, basis, code);
  const searching = !!view?.searches.some(s => ['queued', 'searching'].includes(s.status)) || !!view?.discovery_running;
  const reviews = view ? reviewLinks(view.links).length : 0;
  const viewedName = viewed.game ? editionName(viewed.game) : itemName(viewed);
  const history = view?.histories?.preferred ?? view?.history ?? [];
  const items = [
    { id: 'preis', label: 'Preis' }, { id: 'angebote', label: 'Angebote', count: view ? summary.pricedCount : null }, { id: 'verlauf', label: 'Verlauf' },
    { id: 'editionen', label: 'Editionen', count: variants.length > 1 ? variants.length : null }, { id: 'alarm', label: 'Alarm' }, { id: 'infos', label: 'Infos', count: reviews > 0 ? reviews : null },
  ];
  const badgeOf = (game: CatalogGame) => { const it = game.igdb_id === item.game?.igdb_id ? item : editionItems.find(e => e.game?.igdb_id === game.igdb_id); return it ? badges[it.id] ?? it.price_badge : undefined; };
  return <div className="gd-body" ref={body}>
    <div className="gd-tabs"><Tabs id="gd" label="Spieldetails" items={items} value={tab} onChange={id => onTab(id as TabId)} /></div>
    <div className="gd-content">
      {state.error && <Notice error>{state.error}<Button secondary onClick={state.refetch}>Erneut laden</Button></Notice>}{state.message && <Notice>{state.message}</Notice>}
      <TabPanel id="gd" tab="preis" value={tab}>
        {!view && !state.error ? <p role="status">Preisdaten werden geladen …</p> : <PriceTab view={view} rows={rows} summary={summary} basis={basis} onBasis={setBasis} targetCode={code} targetLabel={targetLabel} rule={rule} searching={searching} history={history} onTab={id => onTab(id as TabId)} />}
      </TabPanel>
      <TabPanel id="gd" tab="angebote" value={tab}>
        <OffersTab state={state} rows={rows} summary={summary} basis={basis} onBasis={setBasis} targetCode={code} targetLabel={targetLabel} editionName={viewedName} wide={width >= 640} searching={searching} reviewCount={reviews} onTab={id => onTab(id as TabId)} />
      </TabPanel>
      <TabPanel id="gd" tab="verlauf" value={tab}>
        {view ? <HistoryTab view={view} targetCode={code} targetLabel={targetLabel} target={ruleTarget(rule)} /> : !state.error && <p role="status">Preisdaten werden geladen …</p>}
      </TabPanel>
      <TabPanel id="gd" tab="editionen" value={tab}>
        {item.game ? <EditionComparison gameId={item.game.igdb_id} platformId={item.platform_id} games={variants} savedId={item.game.igdb_id} viewedId={viewed.game?.igdb_id} marketLabel={code || 'Zielland'}
          badgeOf={badgeOf} canView={g => g.igdb_id === item.game?.igdb_id || editionItems.some(e => e.game?.igdb_id === g.igdb_id)} onView={onView} />
          : <Notice>Für diesen manuellen Titel liegen keine bestätigten Editionen vor.</Notice>}
      </TabPanel>
      <TabPanel id="gd" tab="alarm" value={tab}>
        <AlertEditor id={item.id} alert={alert} editionName={savedName} targetLabel={targetLabel} onSettings={onSettings} onError={onError} />
      </TabPanel>
      <TabPanel id="gd" tab="infos" value={tab}>
        <InfosTab game={viewed.game} state={state} />
      </TabPanel>
    </div>
  </div>;
}
