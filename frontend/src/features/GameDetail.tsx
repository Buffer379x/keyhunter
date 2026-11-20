import { useEffect, useState } from 'react';
import type { CatalogGame, PriceBadgeData, WishlistItem } from '../api';
import { Button, Icon, Notice, Panel, Pill, TabPanel, Tabs } from '../components';
import AlarmTab from './AlarmTab';
import EditionComparison, { editionName } from './EditionComparison';
import GameCover from './GameCover';
import HistoryTab from './HistoryTab';
import InfosTab, { reviewLinks } from './InfosTab';
import OffersTab from './Offers';
import { offerRows, summarize } from './offers-model';
import type { Basis, OffersView, Summary } from './offers-model';
import { ruleTarget, targetReached, useAlertRule } from './PriceAlerts';
import type { AlertState, Rule } from './PriceAlerts';
import PriceTab from './PriceTab';
import Popover from './Popover';
import { money } from './price-format';
import { itemName, platformName } from './catalog-ui';
import { useOffersView } from './useOffersView';

export const tabIds = ['preis', 'angebote', 'verlauf', 'editionen', 'alarm', 'infos'] as const;
export type TabId = typeof tabIds[number];
export const isTab = (value: string | null | undefined): value is TabId => !!value && (tabIds as readonly string[]).includes(value);

type Props = {
  item: WishlistItem; viewed: WishlistItem; preview: boolean; variants: CatalogGame[]; editionItems: WishlistItem[]; editionError: string;
  badges: Record<string, PriceBadgeData>; csrf: string; targetCountry: string | null; targetLabel: string; tab: TabId;
  /** Kept for compatibility: the way back is the breadcrumb of the top bar (design v4 has no back button in the detail). */
  onBack?: () => void;
  purchasing: boolean; onTab: (tab: TabId) => void; onPurchase: () => void; onRemove: () => void;
  onView: (game: CatalogGame) => void; onClearPreview: () => void; onBadge: (id: string, badge: PriceBadgeData) => void;
  onSettings: () => void; onError: (error: unknown) => void; onRule: (id: string, rule: Rule | null) => void;
};

/** Game detail (design v4): head panel with cover, edition and actions, then the tabs Preis · Angebote · Verlauf · Editionen · Alarm · Infos. */
export default function GameDetail(props: Props) {
  const { item, viewed, preview, csrf, onError, onRule } = props;
  const alert = useAlertRule(item.id, csrf, onError);
  useEffect(() => { if (alert.ready) onRule(item.id, alert.rule); }, [alert.ready, alert.rule, item.id, onRule]);
  // Keyed by the viewed edition: its offers, basis and chart state start fresh when the edition changes.
  return <Detail key={viewed.id} {...props} alert={alert} rule={preview ? null : alert.rule} />;
}

const year = (game: CatalogGame | null) => game?.first_release_date ? String(new Date(game.first_release_date * 1000).getUTCFullYear()) : null;

function StatusPill({ view, summary, rule, searching, code }: { view: OffersView | null; summary: Summary; rule: Rule | null; searching: boolean; code: string }) {
  if (!view) return null;
  const target = ruleTarget(rule);
  const cents = rule?.basis === 'estimate' ? view.best_estimate : view.best_base;
  if (summary.targetCents === null) {
    if (searching && summary.pricedCount === 0) return <Pill tone="dim" icon="refresh">Wird gesucht …</Pill>;
    return <Pill tone="dim">{summary.pricedCount === 0 ? 'Kein Angebot' : `Nichts in ${code} gültig`}</Pill>;
  }
  if (targetReached(rule, cents)) return <Pill tone="ok" icon="check">Ziel erreicht</Pill>;
  if (target !== null && rule?.enabled && cents !== null) return <Pill>{money(cents - target)} über Ziel</Pill>;
  return null;
}

function Detail(props: Props & { alert: AlertState; rule: Rule | null }) {
  const { item, viewed, preview, variants, editionItems, editionError, badges, csrf, targetCountry, targetLabel, tab, purchasing, onTab, onPurchase, onRemove, onView, onClearPreview, onBadge, onSettings, onError, alert, rule } = props;
  const state = useOffersView(viewed.id, csrf, onError, onBadge);
  const { view } = state;
  const [basis, setBasis] = useState<Basis>('base');
  const code = (targetCountry ?? view?.target_country ?? '').toUpperCase();
  const rows = offerRows(view, basis);
  const summary = summarize(view, rows, basis, code);
  const searching = !!view?.searches.some(s => ['queued', 'searching'].includes(s.status)) || !!view?.discovery_running;
  const reviews = view ? reviewLinks(view.links).length : 0;
  const hasEstimates = !!view?.links.some(link => link.quotes.some(quote => quote.estimated_total_cents !== null));
  const game = viewed.game;
  const savedName = item.game ? editionName(item.game) : itemName(item);
  const viewedName = game ? editionName(game) : itemName(viewed);
  const target = ruleTarget(rule);
  const platforms = game ? [...game.platforms].sort((a, b) => Number(b.id === item.platform_id) - Number(a.id === item.platform_id)).map(p => p.name) : [platformName(item.platform_id)];
  const meta = [...platforms.slice(0, 3), year(game)].filter(Boolean).join(' · ');
  const itemOf = (g: CatalogGame) => g.igdb_id === item.game?.igdb_id ? item : editionItems.find(it => it.game?.igdb_id === g.igdb_id);
  const badgeOf = (g: CatalogGame) => { const it = itemOf(g); return it ? badges[it.id] ?? it.price_badge : undefined; };
  const canView = (g: CatalogGame) => !!itemOf(g);
  const items = [
    { id: 'preis', label: 'Preis' }, { id: 'angebote', label: 'Angebote', count: view ? summary.pricedCount : null }, { id: 'verlauf', label: 'Verlauf' },
    { id: 'editionen', label: 'Editionen', count: item.game ? variants.length : null }, { id: 'alarm', label: 'Alarm' }, { id: 'infos', label: 'Infos', count: reviews > 0 ? reviews : null },
  ];
  const go = (id: string) => onTab(id as TabId);
  const loading = !view && !state.error ? <p role="status" className="muted">Preisdaten werden geladen …</p> : null;

  return <section className="page game-detail" aria-labelledby="game-title">
    <Panel><div className="game-head">
      <GameCover small className="game-cover" src={game?.cover_url} title={itemName(viewed)} />
      <div className="game-meta">
        <span className="label">{meta}</span>
        <h1 id="game-title">{itemName(viewed)}</h1>
        <div className="row">
          {item.game ? <select className="edition-select" aria-label="Edition" value={game?.igdb_id ?? item.game.igdb_id} onChange={event => { const next = variants.find(g => g.igdb_id === Number(event.target.value)); if (next) onView(next); }}>
            {variants.map(g => <option key={g.igdb_id} value={g.igdb_id} disabled={!canView(g)}>{editionName(g)}{g.igdb_id === item.game?.igdb_id ? ' · gemerkt' : g.igdb_id === game?.igdb_id ? ' · Vorschau' : ''}</option>)}
          </select> : <Pill tone="warn" icon="alert">Manuell · ungeprüft</Pill>}
          <StatusPill view={view} summary={summary} rule={rule} searching={searching} code={code || 'Zielland'} />
        </div>
        {editionError && <span className="hint">{editionError}</span>}
      </div>
      {!preview && <div className="game-actions">
        <Button onClick={() => go('alarm')}><Icon name="target" />{target !== null ? `Ziel ${money(target)}` : rule?.mode === 'low' ? 'Tiefstpreis-Alarm' : 'Ziel setzen'}</Button>
        <Button loading={purchasing} onClick={onPurchase}>{!purchasing && <Icon name="bag" />}Gekauft</Button>
        <Popover menu align="end" triggerLabel="Weitere Aktionen" triggerClassName="icon-btn" trigger={<Icon name="more" />}>
          {close => <>
            <button type="button" role="menuitem" disabled={state.busy || searching} onClick={() => { close(); void state.write('/refresh', 'POST', undefined, 'Angebotssuche angefragt.'); }}><Icon name="refresh" />Jetzt prüfen</button>
            <button type="button" role="menuitem" className="danger" onClick={() => { close(); onRemove(); }}><Icon name="x" />Von Wunschliste entfernen</button>
          </>}
        </Popover>
      </div>}
    </div></Panel>
    {preview && <div className="note" role="status"><Icon name="info" /><span>Vorschau: <b>{viewedName}</b> · gemerkt ist {savedName}. Andere Editionen belegen keinen Platz.</span><Button size="sm" onClick={onClearPreview}>Zur gemerkten Edition</Button></div>}
    {!targetCountry && <div className="note"><Icon name="globe" /><span>Wähle dein Zielland für den Preisvergleich.</span><Button size="sm" onClick={onSettings}>Zielland wählen</Button></div>}
    {item.verification !== 'catalog' && <Notice>{item.verification === 'needs_review' ? 'Die Katalogdaten bestätigen diese Auswahl nicht mehr. Bitte prüfe Plattform und Produkttyp.' : 'Manueller Titel · Zuordnungen werden vor dem Preisvergleich geprüft.'}</Notice>}
    <Tabs id="gd" label="Spieldetails" items={items} value={tab} onChange={go} />
    {state.error && <Notice error>{state.error}<Button size="sm" onClick={state.refetch}>Erneut laden</Button></Notice>}
    {state.message && <Notice>{state.message}</Notice>}
    <TabPanel id="gd" tab="preis" value={tab}>
      {loading ?? <PriceTab view={view} rows={rows} summary={summary} basis={basis} onBasis={setBasis} hasEstimates={hasEstimates} code={code || 'Zielland'} land={targetLabel} rule={rule} searching={searching} onTab={go} />}
    </TabPanel>
    <TabPanel id="gd" tab="angebote" value={tab}>
      {loading ?? <OffersTab state={state} rows={rows} summary={summary} basis={basis} onBasis={setBasis} hasEstimates={hasEstimates} code={code || 'Zielland'} searching={searching} reviewCount={reviews} onTab={go} />}
    </TabPanel>
    <TabPanel id="gd" tab="verlauf" value={tab}>
      {view ? <HistoryTab view={view} summary={summary} code={code || 'Zielland'} land={targetLabel} target={rule?.basis === 'base' ? target : null} /> : loading}
    </TabPanel>
    <TabPanel id="gd" tab="editionen" value={tab}>
      {item.game ? <EditionComparison gameId={item.game.igdb_id} platformId={item.platform_id} games={variants} savedId={item.game.igdb_id} viewedId={game?.igdb_id} code={code || 'Zielland'}
        badgeOf={badgeOf} canView={canView} onView={onView} />
        : <Notice>Für diesen manuellen Titel liegen keine bestätigten Editionen vor.</Notice>}
    </TabPanel>
    <TabPanel id="gd" tab="alarm" value={tab}>
      <AlarmTab id={item.id} alert={alert} editionName={savedName} code={code || 'Zielland'} hasEstimates={hasEstimates} onSettings={onSettings} onError={onError} />
    </TabPanel>
    <TabPanel id="gd" tab="infos" value={tab}>
      <InfosTab item={item} game={game} state={state} />
    </TabPanel>
  </section>;
}
