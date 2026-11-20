import { useState } from 'react';
import type { FormEvent } from 'react';
import type { CatalogGame } from '../api';
import { Button, Icon, Panel, Pill } from '../components';
import { countryData } from './Country';
import { kindName } from './catalog-ui';
import type { Link } from './offers-model';
import { shopNames } from './shop-names';
import type { OffersState } from './useOffersView';

const activationNames: Record<string, string> = { confirmed: 'Aktivierung bestätigt', blocked: 'Aktivierung im Zielland gesperrt', unknown: 'Aktivierung ungeklärt' };
const sourceErrors: Record<string, string> = { network: 'Verbindung fehlgeschlagen', rate_limited: 'Abruflimit erreicht', access_denied: 'Abruf abgelehnt', invalid_response: 'Antwort konnte nicht gelesen werden' };
const needsReview = (link: Link) => link.review !== 'confirmed' || !!link.renamed;

/** True for links the owner still has to look at (shown as the count on the Infos tab). */
export const reviewLinks = (links: Link[]) => links.filter(link => link.review !== 'rejected' && link.enabled && needsReview(link));

export default function InfosTab({ game, state }: { game: CatalogGame | null; state: OffersState }) {
  const { view, busy, write } = state;
  const [url, setUrl] = useState('');
  const links = view?.links.filter(link => link.review !== 'rejected' && link.enabled) ?? [];
  const rejected = view?.links.filter(link => link.review === 'rejected' && link.enabled) ?? [];
  const ordered = [...links].sort((a, b) => Number(needsReview(b)) - Number(needsReview(a)) || a.id - b.id);
  async function add(event: FormEvent) { event.preventDefault(); if (await write('', 'POST', { url }, 'Produktlink zur Prüfung vorgemerkt.')) setUrl(''); }
  const released = game?.first_release_date ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'long', timeZone: 'UTC' }).format(game.first_release_date * 1000) : null;
  const facts: [string, string | null][] = game ? [
    ['Plattformen', game.platforms.map(p => p.name).join(', ') || null], ['Veröffentlicht', released], ['Typ', kindName(game)],
    ['Edition', game.edition_name], ['Auch bekannt als', game.aliases.join(' · ') || null], ['IGDB-ID', String(game.igdb_id)],
  ] : [];
  return <div className="infos-layout">
    <Panel padded className="about-card" aria-labelledby="about-title">
      <h3 id="about-title">Über das Spiel</h3>
      <p className="about-text">{game?.summary ?? 'Für diesen Titel liegt noch keine Beschreibung vor.'}</p>
      {game?.kind === 'edition' && <p className="field-help">Die Inhalte des konkreten Händlerangebots sind auf der Produktseite beschrieben.</p>}
      <dl className="facts">{facts.filter(([, value]) => value).map(([label, value]) => <div key={label}><dt className="label">{label}</dt><dd>{value}</dd></div>)}</dl>
      {game?.slug && <a className="source-link" href={`https://www.igdb.com/games/${game.slug}`} target="_blank" rel="noopener noreferrer">Spieldaten von IGDB <Icon name="ext" size={14} /></a>}
    </Panel>
    <Panel padded className="match-card" aria-labelledby="match-title">
      <h3 id="match-title">Produktzuordnungen</h3>
      {view && ordered.length === 0 && rejected.length === 0 && <p className="field-help">Noch keine Shop-Produkte zugeordnet. KeyHunter sucht automatisch, oder du ergänzt unten einen Produktlink.</p>}
      <ul className="match-list">{ordered.map(link => {
        const review = needsReview(link);
        const region = link.product?.region ? countryData(link.product.region).name : null;
        return <li key={link.id} className={`match ${review ? 'review' : ''}`}>
          <span className="match-state">{link.review === 'confirmed' && !link.renamed ? <Pill tone="ok" icon="check">Zuordnung bestätigt</Pill> : link.renamed ? <Pill tone="warn" icon="alert">Shop-Titel geändert</Pill> : link.can_confirm ? <Pill tone="warn" icon="alert">Vorschlag prüfen</Pill> : <Pill tone="default" icon="x">Nicht bestätigt</Pill>}</span>
          <strong>{shopNames[link.source] ?? link.source} · {link.product?.name ?? 'Produktdaten ausstehend'}</strong>
          <small>{link.review === 'confirmed' ? [region && `Region ${region}`, activationNames[link.product?.activation ?? 'unknown']].filter(Boolean).join(' · ') : link.can_confirm ? [region && `Region ${region}`, 'Titel, Edition und Plattform bitte bestätigen'].filter(Boolean).join(' · ') : 'Produktart, Titel oder Plattform nicht bestätigt'}</small>
          {link.renamed && <small className="rename-note">Shop-Titel geändert: „{link.renamed.from}“ → „{link.renamed.to}“.{link.eligible ? ' Der Preis zählt weiter.' : ''}</small>}
          {link.last_error && <small className="match-error">{sourceErrors[link.last_error] ?? 'Abruf fehlgeschlagen'}</small>}
          <span className="match-actions">
            {link.can_confirm && review && <Button size="sm" disabled={busy} onClick={() => void write(`/${link.id}`, 'PUT', { decision: 'confirmed' })}>{link.renamed && link.review === 'confirmed' ? 'Neuen Titel übernehmen' : 'Zuordnung bestätigen'}</Button>}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void write(`/${link.id}`, 'PUT', { decision: 'rejected' })}>Verwerfen</Button>
            <a className="match-link" href={link.url} target="_blank" rel="noopener noreferrer">Produktseite <Icon name="ext" size={13} /></a>
          </span>
        </li>;
      })}
      {rejected.map(link => <li key={link.id} className="match rejected"><span className="match-state"><Pill tone="default" icon="x">Verworfen</Pill></span><strong>{link.product?.name ?? 'Verworfenes Produkt'}</strong>
        <span className="match-actions"><Button size="sm" variant="ghost" disabled={busy} onClick={() => void write(`/${link.id}`, 'PUT', { decision: 'pending' })}>Erneut prüfen</Button></span></li>)}
      </ul>
      <form className="link-form" onSubmit={add}>
        <h4>Produktlink ergänzen</h4>
        <div className="form-row"><label htmlFor="shop-product-url">Produktlink von Eneba oder Driffle</label>
          <div className="link-input"><input id="shop-product-url" type="url" required maxLength={300} placeholder="https://www.eneba.com/…" value={url} onChange={e => setUrl(e.target.value)} /><Button type="submit" disabled={busy}>Link prüfen</Button></div>
          <span className="field-help">Falls die automatische Suche diese Edition noch nicht abdeckt.</span></div>
      </form>
    </Panel>
  </div>;
}
