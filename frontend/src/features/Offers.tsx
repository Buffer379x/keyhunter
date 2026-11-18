import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { api } from '../api';
import { Button, Icon, Notice } from '../components';
import { AlertEditor } from './PriceAlerts';
import PriceHistoryPlot from './PriceHistoryPlot';

export const shopNames: Record<string, string> = { eneba: 'Eneba', driffle: 'Driffle', igdb: 'IGDB' };
export const money = (cents: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
export const dateTime = (seconds: number) => new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(seconds * 1000);
const sourceErrors: Record<string, string> = { network: 'Verbindung fehlgeschlagen', rate_limited: 'Abruflimit erreicht', access_denied: 'Abruf abgelehnt', invalid_response: 'Antwort konnte nicht gelesen werden' };
const activations: Record<string, string> = { confirmed: 'Aktivierung bestätigt', blocked: 'Aktivierung im Zielland gesperrt', unknown: 'Aktivierung ungeklärt' };
const countryNames = [new Intl.DisplayNames(['de'], { type: 'region' }), new Intl.DisplayNames(['en'], { type: 'region' })];
function preferredRegion(region: string | null | undefined, country: string | undefined) {
  if (!region || !country) return false;
  const name = region.trim().toLocaleLowerCase('de');
  return [country, ...countryNames.map(names => names.of(country)), ...(country === 'US' ? ['USA', 'United States of America'] : country === 'GB' ? ['UK', 'Great Britain'] : country === 'TR' ? ['Türkiye'] : [])]
    .some(value => value?.toLocaleLowerCase('de') === name);
}

type Quote = { id: string; seller: string | null; base_cents: number; estimated_total_cents: number | null };
type Link = {
  id: number; source: string; url: string; review: string; can_confirm: boolean; eligible: boolean;
  queued: boolean; enabled: boolean; stale: boolean; observed_at: number | null;
  attempted_at: number | null; last_error: string | null; retry_at: number;
  product: { name: string; region: string | null; market: string | null; activation: string; availability: string } | null;
  quotes: Quote[];
};
type HistoryRow = { link_id: number; observed_at: number; base_cents: number | null; availability: string };
type View = {
  links: Link[]; history: HistoryRow[]; best_base: number | null; best_estimate: number | null;
  target_country: string; discovery_running: boolean;
  sources: { source: string; status: { enabled: boolean; state: string; last_error: string | null } }[];
  searches: { source: string; status: string; checked_at: number | null; last_error: string | null; result_count: number | null }[];
};

export default function Offers({ id, csrf, targetLabel, onError, tab, editionPanel, infoPanel }: {
  id: string; csrf: string; targetLabel: string; onError: (error: unknown) => void;
  tab: string; editionPanel: ReactNode; infoPanel: ReactNode;
}) {
  const path = `/wishlist/${encodeURIComponent(id)}/offers`;
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState('');
  const [onlyTarget, setOnlyTarget] = useState(false);
  const [basis, setBasis] = useState('base');
  const latest = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const generation = ++latest.current;
    let timer: number;
    async function load() {
      try {
        const data = await api<View>(path, 'GET', undefined, undefined, controller.signal);
        if (generation !== latest.current || controller.signal.aborted) return;
        setView(data);
        setError('');
        if (data.searches?.some(search => ['queued','searching'].includes(search.status)) || data.discovery_running || data.links.some(link => link.queued && link.review !== 'rejected')) {
          timer = window.setTimeout(() => void load(), 3000);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Angebote konnten nicht geladen werden.');
        onError(err);
      }
    }
    void load();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [path, reload, onError]);

  async function write(endpoint: string, method: string, body: unknown, success = '') {
    setBusy(true); setError(''); setMessage('');
    try {
      await api(path + endpoint, method, body, csrf);
      setMessage(success);
      setReload(n => n + 1);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Angebotsänderung fehlgeschlagen.');
      onError(err);
      return false;
    } finally { setBusy(false); }
  }
  async function add(event: FormEvent) {
    event.preventDefault();
    if (await write('', 'POST', { url }, 'Produktlink zur Prüfung vorgemerkt.')) setUrl('');
  }

  const visibleLinks = view?.links.filter(link => link.review !== 'rejected') ?? [];
  const rejected = view?.links.filter(link => link.review === 'rejected') ?? [];
  const history = (view?.history ?? []).filter(row => !filter || String(row.link_id) === filter);
  const searches = view?.searches ?? [];
  const searching = searches.some(search => ['queued', 'searching'].includes(search.status));
  const allQuotes = visibleLinks.flatMap(link => link.quotes.map(quote => ({ link, quote })))
    .sort((a,b) => Number(b.link.eligible) - Number(a.link.eligible) || a.quote.base_cents - b.quote.base_cents);
  const quotes = allQuotes.filter(({link}) => !onlyTarget || link.eligible)
    .sort((a,b) => Number(b.link.eligible)-Number(a.link.eligible) ||
      (basis === 'estimate' ? (a.quote.estimated_total_cents ?? Infinity)-(b.quote.estimated_total_cents ?? Infinity) : a.quote.base_cents-b.quote.base_cents));
  const regions = new Map<string, { cents: number | null; activation: string; preferred: boolean }>();
  for (const link of visibleLinks.filter(link => link.product)) {
    const region = link.product?.region ?? 'Region ungeklärt';
    const before = regions.get(region);
    const cents = link.quotes.length ? Math.min(...link.quotes.map(quote => quote.base_cents)) : null;
    if (!before || (cents !== null && (before.cents === null || cents < before.cents))) regions.set(region, { cents, activation: link.product?.activation ?? 'unknown', preferred: preferredRegion(region, view?.target_country) });
  }
  const statusNames: Record<string,string> = { queued: 'Suche eingeplant', searching: 'Angebote werden gesucht', complete: 'Suche abgeschlossen', no_match: 'Keine passenden Produkte gefunden', error: 'Suche fehlgeschlagen', disabled: 'Deaktiviert', paused: 'Abrufe pausiert' };
  const historyPanel = <section className="dashboard-card history-card" aria-labelledby="history-title">
    <div className="card-heading"><Icon name="chart" /><h3 id="history-title">Preisverlauf</h3><span>Grundpreise</span></div>
    <PriceHistoryPlot history={history} />
    {history.every(row => row.base_cents === null) ? <div className="card-empty"><Icon name="chart" size={30} /><p>Die erste passende Messung legt den Verlauf an.</p></div> : <><div className="history-caption"><strong>{money(Math.min(...history.flatMap(row => row.base_cents === null ? [] : [row.base_cents])))}</strong><span>Niedrigster gespeicherter Grundpreis</span></div><details open={tab === 'history'}><summary>Messungen anzeigen</summary><div className="field history-filter"><label htmlFor="price-link-filter">Produktseite</label><select id="price-link-filter" value={filter} onChange={event => setFilter(event.target.value)}><option value="">Alle bestätigten Produkte</option>{visibleLinks.filter(link => link.review === 'confirmed').map(link => <option key={link.id} value={link.id}>{shopNames[link.source]} · {link.product?.region ?? link.id}</option>)}</select></div><div className="price-table-wrap"><table className="price-table"><thead><tr><th>Beobachtet</th><th>Shop</th><th>Grundpreis</th></tr></thead><tbody>{history.map(row => <tr key={`${row.link_id}-${row.observed_at}`}><td>{dateTime(row.observed_at)}</td><td>{shopNames[view?.links.find(link => link.id === row.link_id)?.source ?? '']}</td><td>{row.base_cents === null ? row.availability === 'sold_out' ? 'Ausverkauft' : 'Unbekannt' : money(row.base_cents)}</td></tr>)}</tbody></table></div></details></>}
  </section>;
  return <div className={`detail-content tab-${tab}`}>
    {error && <Notice error>{error}<Button secondary onClick={() => setReload(n => n + 1)}>Erneut laden</Button></Notice>}
    {message && <Notice>{message}</Notice>}
    {tab === 'info' ? infoPanel : tab === 'alert' ? <AlertEditor id={id} csrf={csrf} targetLabel={targetLabel} onError={onError} /> : tab === 'history' ? historyPanel : <>
      <div className="detail-grid">
        {editionPanel}
        <section className="dashboard-card region-card">
          <div className="card-heading"><Icon name="globe" /><h3>Preise nach Aktivierungsregion</h3><span>{regions.size} Regionen</span></div>
          {regions.size > 0 && <div className="region-list" role="list" aria-label="Aktivierungsregionen" tabIndex={0}>{[...regions.entries()].sort((a,b) => Number(b[1].preferred) - Number(a[1].preferred) || (a[1].cents ?? Infinity) - (b[1].cents ?? Infinity)).map(([region, price]) => <div role="listitem" className={`region-row ${price.preferred ? 'preferred-region' : ''}`} key={region}><span className="region-symbol"><Icon name="globe" size={15} /></span><span>{region}{price.preferred && <small className="preference-badge">Deine Präferenz</small>}</span><strong>{price.cents === null ? 'Kein Preis' : money(price.cents)}</strong><span className={price.activation === 'confirmed' ? 'good-label' : 'muted-label'}>{price.activation === 'confirmed' ? `Für ${view?.target_country}` : price.activation === 'blocked' ? `Nicht für ${view?.target_country}` : 'Zu prüfen'}</span></div>)}</div>}
          {regions.size === 0 && <div className="card-empty"><Icon name="globe" size={30} /><p>{searching ? 'Regionen erscheinen, sobald die ersten Angebote gefunden wurden.' : 'Noch keine regionalen Preise verfügbar.'}</p></div>}
          <div className="card-footnote">Alle Regionen · Deine Präferenz: {targetLabel} · Zusatzkosten je Shop</div>
        </section>
        {tab !== 'editions' && <section className="dashboard-card offer-card" aria-labelledby="offers-title">
          <div className="card-heading"><Icon name="tag" /><h3 id="offers-title">Aktuelle Angebote</h3><span>{quotes.length} Angebote</span><button className="icon-action" aria-label="Preise prüfen" title="Angebote suchen und Preise prüfen" disabled={busy || searching} onClick={() => void write('/refresh','POST',undefined,'Angebotssuche angefragt.')}><Icon name="refresh" size={16} /></button></div>
          {view?.best_base !== null && view?.best_base !== undefined && <div className="comparison-summary"><span>Niedrigster passender Grundpreis <strong>{money(view.best_base)}</strong></span>{view.best_estimate !== null && <span>Gesamtpreis geschätzt <strong>{money(view.best_estimate)}</strong></span>}</div>}
          <div className="offer-filters"><label className="check-label"><input type="checkbox" checked={onlyTarget} onChange={event => setOnlyTarget(event.target.checked)} />Nur passende Angebote</label><label>Sortierung<select aria-label="Preisgrundlage für Sortierung" value={basis} onChange={event => setBasis(event.target.value)}><option value="base">Grundpreis</option><option value="estimate">Gesamtpreis geschätzt</option></select></label></div>
          {quotes.length > 0 ? <div className="offer-table"><div className="offer-table-head"><span>Händler / Verkäufer</span><span>Land / Region</span><span>Preis</span><span /></div>{quotes.map(({link,quote}, i) => <div className={`offer-table-row ${link.eligible && quote.base_cents === view?.best_base ? 'best' : ''} ${preferredRegion(link.product?.region, view?.target_country) ? 'preferred-region' : ''}`} key={`${link.id}-${quote.id}`}>
            <div className="seller-cell"><span className={`shop-logo ${link.source}`}>{shopNames[link.source]?.[0]}</span><div><strong>{shopNames[link.source]}</strong><small>{quote.seller ?? 'Verkäufer nicht angegeben'}</small></div></div>
            <div className="offer-region"><span>{link.product?.region ?? 'Unbekannt'}</span>{preferredRegion(link.product?.region, view?.target_country) && <span className="preference-badge">Deine Präferenz</span>}<small>{activations[link.product?.activation ?? 'unknown']}{!link.enabled ? ' · Deaktiviert' : link.last_error ? ' · Abruffehler' : link.stale ? ' · Veraltet' : link.review !== 'confirmed' ? ' · Zuordnung prüfen' : ''}</small></div>
            <div className="quote-price"><strong>{money(quote.base_cents)}</strong><small>{quote.estimated_total_cents === null ? 'Gebühren unbekannt' : `${money(quote.estimated_total_cents)} geschätzt`}</small></div>
            <a className="offer-open" title="Zum Angebot" aria-label={`Angebot bei ${shopNames[link.source]} öffnen ${i+1}`} href={link.url} target="_blank" rel="noopener noreferrer"><Icon name="external" size={16} /></a>
          </div>)}</div> : <div className="card-empty"><Icon name="search" size={30} /><p>{!view ? 'Angebote werden geladen …' : searching ? 'KeyHunter sucht passende Produkte für dieses Spiel.' : 'Für diese Auswahl liegen noch keine passenden Angebote vor.'}</p>{view && !searching && <Button secondary disabled={busy} onClick={() => void write('/refresh','POST',undefined)}>Angebote automatisch suchen</Button>}</div>}
          {searches.map(search => <div className="source-search-state" key={search.source}><span className={`status-dot ${['queued','searching'].includes(search.status) ? 'searching' : ''}`} /><strong>{shopNames[search.source]}</strong><span>{statusNames[search.status] ?? search.status}</span>{search.last_error && <span>{sourceErrors[search.last_error] ?? 'Quelle vorübergehend nicht erreichbar'}</span>}</div>)}
          {view?.sources?.filter(source => !source.status.enabled || source.status.last_error).map(source => <div className="source-search-state" key={source.source}><strong>{shopNames[source.source]}</strong><span>{!source.status.enabled ? 'Deaktiviert' : sourceErrors[source.status.last_error ?? ''] ?? 'Quelle pausiert'}</span></div>)}
          <details className="product-review"><summary>Produktzuordnungen prüfen ({visibleLinks.filter(link => link.review !== 'confirmed').length})</summary>
            {visibleLinks.map(link => <div className="review-row" key={link.id}><strong>{shopNames[link.source]} · {link.product?.name ?? 'Produktdaten ausstehend'}</strong><p>{link.review === 'confirmed' ? 'Zuordnung bestätigt' : link.can_confirm ? 'Zuordnung prüfen' : 'Produktart, Titel oder Plattform nicht bestätigt'}</p>{link.last_error && <p>{sourceErrors[link.last_error] ?? 'Abruf fehlgeschlagen'}</p>}<div className="offer-actions">{link.can_confirm && link.review !== 'confirmed' && <Button secondary disabled={busy} onClick={() => void write(`/${link.id}`,'PUT',{decision:'confirmed'})}>Zuordnung bestätigen</Button>}<Button secondary disabled={busy} onClick={() => void write(`/${link.id}`,'PUT',{decision:'rejected'})}>Verwerfen</Button><a href={link.url} target="_blank" rel="noopener noreferrer">Produktseite <Icon name="external" size={13} /></a></div></div>)}
            {rejected.map(link => <div className="review-row" key={link.id}><span>{link.product?.name ?? link.url}</span><Button secondary disabled={busy} onClick={() => void write(`/${link.id}`,'PUT',{decision:'pending'})}>Erneut prüfen</Button></div>)}
          </details>
          <details className="manual-link"><summary>Produktlink ergänzen</summary><p className="field-help">Als Ergänzung, wenn die automatische Suche einen Titel noch nicht abdeckt.</p><form className="offer-link-form" onSubmit={add}><div className="field"><label htmlFor="shop-product-url">Produktlink von Eneba oder Driffle</label><input id="shop-product-url" type="url" required maxLength={300} placeholder="https://…" value={url} onChange={event => setUrl(event.target.value)} /></div><Button secondary type="submit" disabled={busy}>Link prüfen</Button></form></details>
        </section>}
        {tab !== 'editions' && historyPanel}
      </div>
    </>}
  </div>;
}
