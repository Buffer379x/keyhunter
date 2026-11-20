import { useState } from 'react';
import type { FormEvent } from 'react';
import type { CatalogGame, WishlistItem } from '../api';
import { Button, Icon, Inset, Label, Panel, PanelHead, Pill, Reg } from '../components';
import { kindName, platformName } from './catalog-ui';
import type { Link } from './offers-model';
import { countryData, regionCode } from './regions';
import { shopNames } from './shop-names';
import type { OffersState } from './useOffersView';

const activationNames: Record<string, string> = { confirmed: 'Aktivierung bestätigt', blocked: 'Aktivierung im Zielland gesperrt', unknown: 'Aktivierung ungeklärt' };
const sourceErrors: Record<string, string> = { network: 'Verbindung fehlgeschlagen', rate_limited: 'Abruflimit erreicht', access_denied: 'Abruf abgelehnt', invalid_response: 'Antwort konnte nicht gelesen werden' };
const needsReview = (link: Link) => link.review !== 'confirmed' || !!link.renamed;
const longDate = (seconds: number) => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short', year: 'numeric' }).format(seconds * 1000);

/** True for links the owner still has to look at (shown as the count on the Infos tab). */
export const reviewLinks = (links: Link[]) => links.filter(link => link.review !== 'rejected' && link.enabled && needsReview(link));

/** Infos: facts about the game and the watch, the IGDB description, and the shop product mappings with their review. */
export default function InfosTab({ item, game, state }: { item: WishlistItem; game: CatalogGame | null; state: OffersState }) {
  const { view, busy, write } = state;
  const [url, setUrl] = useState('');
  const links = view?.links.filter(link => link.review !== 'rejected' && link.enabled) ?? [];
  const rejected = view?.links.filter(link => link.review === 'rejected' && link.enabled) ?? [];
  const ordered = [...links].sort((a, b) => Number(needsReview(b)) - Number(needsReview(a)) || a.id - b.id);
  async function add(event: FormEvent) { event.preventDefault(); if (await write('', 'POST', { url }, 'Produktlink zur Prüfung vorgemerkt.')) setUrl(''); }
  const released = game?.first_release_date ? new Date(game.first_release_date * 1000) : null;
  const platforms = game?.platforms.map(p => p.name).join(' · ') || platformName(item.platform_id);
  return <div className="grid-2">
    <Panel aria-labelledby="infos-title">
      <PanelHead><Label id="infos-title">Infos</Label></PanelHead>
      <Inset><ul className="facts">
        <li><Icon name="info" /><span>Erscheinungsjahr</span><span className="r mono" title={released ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'long', timeZone: 'UTC' }).format(released) : undefined}>{released ? released.getUTCFullYear() : 'unbekannt'}</span></li>
        <li><Icon name="globe" /><span>Plattformen</span><span className="r">{platforms}</span></li>
        <li><Icon name="store" /><span>Beobachtete Shop-Seiten</span><span className="r mono">{view ? links.length : '…'}</span></li>
        <li><Icon name="heart" /><span>Auf der Wunschliste seit</span><span className="r mono">{longDate(item.created_at)}</span></li>
        {game && <li><Icon name="layers" /><span>Typ</span><span className="r">{kindName(game)}</span></li>}
        {game?.aliases.length ? <li><Icon name="book" /><span>Auch bekannt als</span><span className="r">{game.aliases.join(' · ')}</span></li> : null}
        {game && <li><Icon name="search" /><span>Spieldaten</span>{game.slug ? <a className="r" href={`https://www.igdb.com/games/${game.slug}`} target="_blank" rel="noopener noreferrer">IGDB · {game.igdb_id}<Icon name="ext" /></a> : <span className="r mono">IGDB · {game.igdb_id}</span>}</li>}
      </ul></Inset>
      {game?.summary && <p className="about">{game.summary}</p>}
    </Panel>
    <Panel aria-labelledby="match-title">
      <PanelHead><Label id="match-title">Produktzuordnungen</Label></PanelHead>
      <Inset>
        <ul className="facts matches">
          {view && ordered.length === 0 && rejected.length === 0 && <li><Icon name="info" /><span>Noch keine Shop-Produkte zugeordnet. KeyHunter sucht automatisch, oder du ergänzt unten einen Produktlink.</span></li>}
          {ordered.map(link => {
            const review = needsReview(link);
            return <li key={link.id} className={`match ${review ? 'warn' : 'ok'}`}>
              <Icon name={review ? 'alert' : 'check'} />
              <div className="match-body">
                <b>{shopNames[link.source] ?? link.source} · {link.product?.name ?? 'Produktdaten ausstehend'}</b>
                <span className="muted">{link.product?.region && <><Reg code={regionCode(link.product.region)} /> </>}{link.review === 'confirmed'
                  ? [link.product?.region && countryData(link.product.region).name, activationNames[link.product?.activation ?? 'unknown']].filter(Boolean).join(' · ')
                  : link.can_confirm ? 'Titel, Edition und Plattform bitte bestätigen' : 'Produktart, Titel oder Plattform nicht bestätigt'}</span>
                {link.renamed && <span className="rename-note">Shop-Titel geändert: „{link.renamed.from}“ → „{link.renamed.to}“.{link.eligible ? ' Der Preis zählt weiter.' : ''}</span>}
                {link.last_error && <span className="match-error">{sourceErrors[link.last_error] ?? 'Abruf fehlgeschlagen'}</span>}
                <span className="match-actions">
                  {link.review === 'confirmed' && !link.renamed ? <Pill tone="ok" icon="check">Zuordnung bestätigt</Pill> : link.renamed ? <Pill tone="warn" icon="alert">Shop-Titel geändert</Pill> : link.can_confirm ? <Pill tone="warn" icon="alert">Vorschlag prüfen</Pill> : <Pill tone="dim" icon="x">Nicht bestätigt</Pill>}
                  {link.can_confirm && review && <Button size="sm" disabled={busy} onClick={() => void write(`/${link.id}`, 'PUT', { decision: 'confirmed' })}>{link.renamed && link.review === 'confirmed' ? 'Neuen Titel übernehmen' : 'Zuordnung bestätigen'}</Button>}
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void write(`/${link.id}`, 'PUT', { decision: 'rejected' })}>Verwerfen</Button>
                  <a className="btn sm ghost" href={link.url} target="_blank" rel="noopener noreferrer">Produktseite<Icon name="ext" /></a>
                </span>
              </div>
            </li>;
          })}
          {rejected.map(link => <li key={link.id} className="match"><Icon name="x" /><div className="match-body"><b>{link.product?.name ?? 'Verworfenes Produkt'}</b>
            <span className="match-actions"><Pill tone="dim" icon="x">Verworfen</Pill><Button size="sm" variant="ghost" disabled={busy} onClick={() => void write(`/${link.id}`, 'PUT', { decision: 'pending' })}>Erneut prüfen</Button></span></div></li>)}
        </ul>
        <form className="form-grid link-form" onSubmit={add}>
          <div className="form-row"><label htmlFor="shop-product-url">Produktlink von Eneba oder Driffle ergänzen</label>
            <span className="link-input"><input id="shop-product-url" type="url" required maxLength={300} placeholder="https://www.eneba.com/…" value={url} onChange={e => setUrl(e.target.value)} /><Button type="submit" disabled={busy}>Link prüfen</Button></span>
            <span className="hint">Falls die automatische Suche diese Edition noch nicht abdeckt.</span></div>
        </form>
      </Inset>
    </Panel>
  </div>;
}
