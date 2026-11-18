import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import { Button, Notice } from '../components';
import { AlertEditor } from './PriceAlerts';
import PriceHistoryPlot from './PriceHistoryPlot';

export const shopNames: Record<string, string> = { eneba: 'Eneba', driffle: 'Driffle', igdb: 'IGDB' };
export const money = (cents: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
export const dateTime = (seconds: number) => new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(seconds * 1000);
const sourceErrors: Record<string, string> = { network: 'Verbindung fehlgeschlagen', rate_limited: 'Abruflimit erreicht', access_denied: 'Abruf abgelehnt', invalid_response: 'Antwort konnte nicht gelesen werden' };
const activations: Record<string, string> = { confirmed: 'Aktivierung bestätigt', blocked: 'Aktivierung im Zielland gesperrt', unknown: 'Aktivierung ungeklärt' };

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
};

export default function Offers({ id, csrf, targetLabel, onError }: {
  id: string; csrf: string; targetLabel: string; onError: (error: unknown) => void;
}) {
  const path = `/wishlist/${encodeURIComponent(id)}/offers`;
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [filter, setFilter] = useState('');
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
        if (data.discovery_running || data.links.some(link => link.queued && link.review !== 'rejected')) {
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
  return <>
    <section className="offer-section" aria-labelledby="offers-title">
      <div className="panel-heading"><h3 id="offers-title">Angebote</h3>
        <Button secondary disabled={busy || !visibleLinks.length} onClick={() => void write('/refresh', 'POST', undefined, 'Aktualisierung angefragt. Kürzlich geprüfte Links behalten ihren Abrufrhythmus.')}>Preise prüfen</Button>
      </div>
      {error && <Notice error>{error} <Button secondary onClick={() => setReload(n => n + 1)}>Neu laden</Button></Notice>}
      {message && <Notice>{message}</Notice>}
      {view ? <>
        <p className="field-help">Vergleich für {view.target_country ? targetLabel : 'ein gewähltes Zielland'} aus bestätigten, aktuellen Zuordnungen.</p>
        {(view.best_base !== null || view.best_estimate !== null) && <dl className="best-prices">
          {view.best_base !== null && <div><dt>Niedrigster Grundpreis</dt><dd>{money(view.best_base)}</dd></div>}
          {view.best_estimate !== null && <div><dt>Niedrigster geschätzter Gesamtpreis</dt><dd>{money(view.best_estimate)}</dd></div>}
        </dl>}
        {view.discovery_running && <p role="status">Die Shops werden nach passenden Produktseiten durchsucht.</p>}
        {visibleLinks.length === 0 && <p>Für diesen Wunsch sind noch keine Produktlinks gespeichert.</p>}
        <ul className="shop-offers">{visibleLinks.map(link => <li key={link.id}>
          <div className="shop-offer-heading">
            <div><span className="eyebrow">{shopNames[link.source]}</span><h4>{link.product?.name ?? 'Produktseite'}</h4></div>
            <a className="source-link" href={link.url} target="_blank" rel="noopener noreferrer">Zur Produktseite ↗</a>
          </div>
          <p className="metadata-note">
            {link.product && [link.product.region ?? 'Region unbekannt', activations[link.product.activation],
              link.product.market ? `Kaufkontext ${link.product.market}` : 'Kaufkontext offen'].join(' · ')}
          </p>
          <p className="metadata-note">
            {link.review === 'confirmed' ? 'Zuordnung bestätigt' : link.can_confirm ? 'Zuordnung prüfen' : link.product ? 'Titel, Edition oder Xbox-Keytyp nicht bestätigt' : 'Produktdaten ausstehend'}
            {link.observed_at !== null && ` · Zuletzt beobachtet ${dateTime(link.observed_at)}`}
            {link.stale && ' · Veraltet'}{!link.enabled && ' · Quelle deaktiviert'}
          </p>
          {link.queued && <p role="status">Abruf eingeplant.</p>}
          {link.retry_at * 1000 > Date.now() && <p className="metadata-note">Quelle pausiert bis {dateTime(link.retry_at)}.</p>}
          {link.last_error && <p className="metadata-note">Letzter Versuch {link.attempted_at && dateTime(link.attempted_at)} · {sourceErrors[link.last_error]}</p>}
          {link.product?.availability === 'sold_out' && <p>Ausverkauft.</p>}
          {link.product?.availability === 'unknown' && <p>Kein verfügbarer EUR-Preis belegt.</p>}
          {link.quotes.length > 0 && <ul className="shop-quotes">{[...link.quotes].sort((a, b) => a.base_cents - b.base_cents).map(quote => <li key={quote.id}>
            <span>{quote.seller ?? 'Verkäufer unbekannt'}</span>
            <span><strong>{money(quote.base_cents)}</strong> Grundpreis</span>
            <span>{quote.estimated_total_cents === null ? 'Gebühren unbekannt' : `${money(quote.estimated_total_cents)} geschätzt`}</span>
          </li>)}</ul>}
          <div className="offer-actions">
            {link.can_confirm && link.review !== 'confirmed' && <Button disabled={busy} onClick={() => void write(`/${link.id}`, 'PUT', { decision: 'confirmed' }, 'Zuordnung bestätigt.')}>Zuordnung bestätigen</Button>}
            <Button secondary disabled={busy} onClick={() => void write(`/${link.id}`, 'PUT', { decision: 'rejected' }, 'Zuordnung verworfen.')}>Verwerfen</Button>
          </div>
        </li>)}</ul>
        {rejected.length > 0 && <details><summary>Verworfene Zuordnungen ({rejected.length})</summary><ul className="rejected-links">{rejected.map(link => <li key={link.id}>
          <a href={link.url} target="_blank" rel="noopener noreferrer">{link.product?.name ?? shopNames[link.source]}</a>
          <Button secondary disabled={busy} onClick={() => void write(`/${link.id}`, 'PUT', { decision: 'pending' })}>Erneut prüfen</Button>
        </li>)}</ul></details>}
      </> : !error && <p role="status">Angebote werden geladen …</p>}
      <form className="offer-link-form" onSubmit={add}>
        <div className="field"><label htmlFor="shop-product-url">Produktlink von Eneba oder Driffle</label><input id="shop-product-url" type="url" required maxLength={300} placeholder="https://…" value={url} onChange={e => setUrl(e.target.value)} /></div>
        <Button secondary type="submit" disabled={busy}>Link prüfen</Button>
      </form>
    </section>
    <section className="offer-section" aria-labelledby="history-title">
      <h3 id="history-title">Preisverlauf</h3>
      <p className="field-help">Letzte 60 Beobachtungen je Produktseite im gewählten Kaufkontext. Jeder Punkt ist eine Messung.</p>
      {!!view?.history.length && <div className="field history-filter"><label htmlFor="price-link-filter">Produktseite</label><select id="price-link-filter" value={filter} onChange={e => setFilter(e.target.value)}>
        <option value="">Alle bestätigten Produktseiten</option>
        {visibleLinks.filter(link => link.review === 'confirmed').map(link => <option key={link.id} value={link.id}>{shopNames[link.source]} · {link.product?.region ?? link.id}</option>)}
      </select></div>}
      <PriceHistoryPlot history={history} />
      {history.length === 0 ? <p>Für diese Auswahl liegen noch keine Preisbeobachtungen vor.</p> : <div className="price-table-wrap"><table className="price-table">
        <thead><tr><th scope="col">Beobachtet</th><th scope="col">Shop</th><th scope="col">Grundpreis</th></tr></thead>
        <tbody>{history.map(row => {
          const link = view?.links.find(link => link.id === row.link_id);
          return <tr key={`${row.link_id}-${row.observed_at}`}><td>{dateTime(row.observed_at)}</td>
            <td>{shopNames[link?.source ?? '']} {link?.product?.region && `· ${link.product.region}`}</td>
            <td>{row.base_cents !== null ? money(row.base_cents) : row.availability === 'sold_out' ? 'Ausverkauft' : 'Unbekannt'}</td></tr>;
        })}</tbody>
      </table></div>}
    </section>
    <AlertEditor id={id} csrf={csrf} targetLabel={targetLabel} onError={onError} />
  </>;
}
