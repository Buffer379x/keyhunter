import { useEffect, useState } from 'react';
import { api } from '../api';
import type { FormEvent } from 'react';
import type { CatalogGame, WishlistItem } from '../api';
import { Button, ConfirmDialog, Help, Icon, IconButton, Inset, Label, Notice, Panel, PanelHead, Pill, Reg } from '../components';
import { itemName, kindName, platformName } from './catalog-ui';
import LinkReview from './LinkReview';
import type { Assigned, Link } from './offers-model';
import { everyText, trendText } from './offers-model';
import { countryData, regionCode } from './regions';
import { shopNames } from './shop-names';
import type { OffersState } from './useOffersView';

const activationNames: Record<string, string> = {
  confirmed: 'Aktivierung bestätigt',
  blocked: 'Aktivierung im Zielland gesperrt',
  unknown: 'Aktivierung ungeklärt',
};
const sourceErrors: Record<string, string> = {
  network: 'Verbindung fehlgeschlagen',
  rate_limited: 'Abruflimit erreicht',
  access_denied: 'Abruf abgelehnt',
  invalid_response: 'Antwort konnte nicht gelesen werden',
};
const needsReview = (link: Link) => link.review !== 'confirmed' || !!link.renamed;
/** Held by another game too (1.1.4, assignments from before the check): the owner removes one of them. */
const doubled = (link: Link) => (link.assigned_elsewhere?.length ?? 0) > 0;
const stateNames: Record<string, string> = { owned: 'Bibliothek', preview: 'Vorschau' };
/** „Forza Horizon 5“ (Xbox One, Bibliothek): the platform and the list only where they are not the usual wish. */
function assignedNames(list: Assigned[], platformId: number) {
  return list
    .map(entry => {
      const extra = [entry.platform_id !== platformId && platformName(entry.platform_id), stateNames[entry.state]].filter(Boolean).join(', ');
      return `„${entry.name ?? 'Unbekanntes Spiel'}“${extra ? ` (${extra})` : ''}`;
    })
    .join(', ');
}
/** The check before a link is added by hand (1.1.4). */
type Check = { valid: boolean; here: boolean; assigned: Assigned[] };
const longDate = (seconds: number) => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'short', year: 'numeric' }).format(seconds * 1000);

/** True for links the owner still has to look at (shown as the count on the Zuordnungen tab). */
export const reviewLinks = (links: Link[]) => links.filter(link => link.review !== 'rejected' && link.enabled && (needsReview(link) || doubled(link)));

/** Zuordnungen tab (until 1.0 "Infos"): facts about the game and the watch, the IGDB description, and the shop product mappings with their review. */
export default function InfosTab({ item, game, state }: { item: WishlistItem; game: CatalogGame | null; state: OffersState }) {
  const { view, busy, write, error } = state;
  const [url, setUrl] = useState('');
  const [check, setCheck] = useState<{ url: string; result: Check } | null>(null);
  // The warning comes before the add: a moment after typing or pasting, the address is checked against the list.
  useEffect(() => {
    const wanted = url.trim();
    if (!wanted) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<Check>(`/wishlist/${item.id}/offers/assigned?url=${encodeURIComponent(wanted)}`, 'GET', undefined, controller.signal)
        .then(result => setCheck({ url: wanted, result }))
        .catch(() => undefined);
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [url, item.id, view?.links.length]);
  const known = check && check.url === url.trim() ? check.result : null;
  const refused = !!known && (known.here || known.assigned.length > 0);
  const [reviewing, setReviewing] = useState<number | null>(null);
  const reviewLink = view?.links.find(link => link.id === reviewing) ?? null;
  /** A completely wrong mapping the owner wants gone, with its prices (0.7.3); "Verwerfen" only sets it aside. */
  const [deleting, setDeleting] = useState<Link | null>(null);
  async function remove() {
    if (deleting && (await write(`/${deleting.id}`, 'DELETE', undefined, 'Zuordnung gelöscht.'))) setDeleting(null);
  }
  const deleteButton = (link: Link) => (
    <IconButton
      className="match-delete"
      variant="danger"
      disabled={busy}
      label={`Zuordnung ${link.product?.name ?? shopNames[link.source] ?? link.source} löschen`}
      onClick={() => setDeleting(link)}
    >
      <Icon name="trash" />
    </IconButton>
  );
  async function confirm(link: Link) {
    if (await write(`/${link.id}`, 'PUT', { decision: 'confirmed', manual: !link.can_confirm }, 'Zuordnung bestätigt.')) setReviewing(null);
  }
  const links = view?.links.filter(link => link.review !== 'rejected' && link.enabled) ?? [];
  const rejected = view?.links.filter(link => link.review === 'rejected' && link.enabled) ?? [];
  const ordered = [...links].sort((a, b) => Number(needsReview(b)) - Number(needsReview(a)) || a.id - b.id);
  async function add(event: FormEvent) {
    event.preventDefault();
    if (refused) return;
    if (await write('', 'POST', { url }, 'Produktlink zur Prüfung vorgemerkt.')) setUrl('');
  }
  const released = game?.first_release_date ? new Date(game.first_release_date * 1000) : null;
  const platforms = game?.platforms.map(p => p.name).join(' · ') || platformName(item.platform_id);
  return (
    <div className="grid-2">
      <ConfirmDialog
        open={deleting !== null}
        title="Zuordnung löschen?"
        confirmLabel="Löschen bestätigen"
        danger
        busy={busy}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void remove()}
      >
        <p>
          „{deleting?.product?.name ?? deleting?.url}“ ({deleting ? (shopNames[deleting.source] ?? deleting.source) : ''}) wird mit allen gespeicherten Preisen
          dieser Zuordnung gelöscht. Die automatische Suche schlägt dieses Produkt für „{itemName(item)}“ nicht mehr vor. Fügst du den Link später selbst hinzu,
          wird er wieder beobachtet.
        </p>
        {deleting && error && <Notice error>{error}</Notice>}
      </ConfirmDialog>
      <LinkReview link={reviewLink} game={itemName(item)} busy={busy} error={error} onClose={() => setReviewing(null)} onConfirm={link => void confirm(link)} />
      <Panel aria-labelledby="infos-title">
        <PanelHead>
          <Label id="infos-title">Infos</Label>
        </PanelHead>
        <Inset>
          <ul className="facts info-facts">
            <li>
              <Icon name="info" />
              <span>Erscheinungsjahr</span>
              <span className="r mono" title={released ? new Intl.DateTimeFormat('de-DE', { dateStyle: 'long', timeZone: 'UTC' }).format(released) : undefined}>
                {released ? released.getUTCFullYear() : 'unbekannt'}
              </span>
            </li>
            <li>
              <Icon name="globe" />
              <span>Plattformen</span>
              <span className="r">{platforms}</span>
            </li>
            <li>
              <Icon name="store" />
              <span>Beobachtete Shop-Seiten</span>
              <span className="r mono">{view ? links.length : '…'}</span>
            </li>
            <li>
              <Icon name="heart" />
              <span>Auf der Wunschliste seit</span>
              <span className="r mono">{longDate(item.created_at)}</span>
            </li>
            {game && (
              <li>
                <Icon name="layers" />
                <span>Typ</span>
                <span className="r">{kindName(game)}</span>
              </li>
            )}
            {game?.aliases.length ? (
              <li>
                <Icon name="book" />
                <span>Auch bekannt als</span>
                <span className="r">{game.aliases.join(' · ')}</span>
              </li>
            ) : null}
            {game && (
              <li>
                <Icon name="search" />
                <span>Spieldaten</span>
                {game.slug ? (
                  <a className="r" href={`https://www.igdb.com/games/${game.slug}`} target="_blank" rel="noopener noreferrer">
                    IGDB · {game.igdb_id}
                    <Icon name="ext" />
                  </a>
                ) : (
                  <span className="r mono">IGDB · {game.igdb_id}</span>
                )}
              </li>
            )}
          </ul>
        </Inset>
        {game?.summary && (
          <Inset className="about-box">
            <p className="label">Beschreibung</p>
            <p className="about">{game.summary}</p>
          </Inset>
        )}
      </Panel>
      <Panel aria-labelledby="match-title">
        <PanelHead>
          <Label id="match-title">Produktzuordnungen</Label>
        </PanelHead>
        <Inset>
          <ul className="facts matches">
            {view && ordered.length === 0 && rejected.length === 0 && (
              <li>
                <Icon name="info" />
                <span>Noch keine Shop-Produkte zugeordnet. KeyHunter sucht automatisch, oder du ergänzt unten einen Produktlink.</span>
              </li>
            )}
            {ordered.map(link => {
              const review = needsReview(link);
              const twice = doubled(link);
              return (
                <li key={link.id} className={`match ${review || twice ? 'warn' : 'ok'}`}>
                  {twice ? (
                    <span className="double-mark" role="img" aria-label="Doppelt zugeordnet" title="Doppelt zugeordnet">
                      <Icon name="alert" />
                    </span>
                  ) : (
                    <Icon name={review ? 'alert' : 'check'} />
                  )}
                  <div className="match-body">
                    <b>
                      {shopNames[link.source] ?? link.source} · {link.product?.name ?? 'Produktdaten ausstehend'}
                    </b>
                    {twice && (
                      <span className="double-note">
                        Doppelt zugeordnet: dasselbe Produkt gehört auch zu {assignedNames(link.assigned_elsewhere!, item.platform_id)}. Lösche oder verwirf es
                        bei einem der Spiele.
                      </span>
                    )}
                    <span className="muted">
                      {link.product?.region && (
                        <>
                          <Reg code={regionCode(link.product.region)} />{' '}
                        </>
                      )}
                      {link.review === 'confirmed'
                        ? [link.product?.region && countryData(link.product.region).name, activationNames[link.product?.activation ?? 'unknown']]
                            .filter(Boolean)
                            .join(' · ')
                        : link.can_confirm
                          ? 'Titel, Edition und Plattform bitte bestätigen'
                          : link.product
                            ? 'Shop-Daten passen nicht automatisch zum Spiel'
                            : 'Produktdaten werden abgerufen'}
                    </span>
                    {link.review === 'confirmed' && link.check_every ? (
                      <span className="match-pace">
                        Abfrage {everyText(link.check_every)}
                        {link.product?.availability === 'sold_out' ? ' · ausverkauft, seltener geprüft' : trendText(link) ? ` · ${trendText(link)}` : ''}
                      </span>
                    ) : null}
                    {link.renamed && (
                      <span className="rename-note">
                        Shop-Titel geändert: „{link.renamed.from}“ → „{link.renamed.to}“.{link.eligible ? ' Der Preis zählt weiter.' : ''}
                      </span>
                    )}
                    {link.last_error && <span className="match-error">{sourceErrors[link.last_error] ?? 'Abruf fehlgeschlagen'}</span>}
                    <span className="match-actions">
                      {link.review === 'confirmed' && !link.renamed ? (
                        <Pill tone="ok" icon="check">
                          {link.manual_match ? 'Von dir bestätigt' : 'Zuordnung bestätigt'}
                        </Pill>
                      ) : link.renamed ? (
                        <Pill tone="warn" icon="alert">
                          Shop-Titel geändert
                        </Pill>
                      ) : link.can_confirm ? (
                        <Pill tone="warn" icon="alert">
                          Vorschlag prüfen
                        </Pill>
                      ) : link.product ? (
                        <Pill tone="warn" icon="alert">
                          Selbst prüfen
                        </Pill>
                      ) : (
                        <Pill tone="dim" icon="clock">
                          Daten ausstehend
                        </Pill>
                      )}
                      {/* Every open review goes through the Prüf-Popup: the full address first, then the confirmation. */}
                      {review && (
                        <Button size="sm" disabled={busy} onClick={() => setReviewing(link.id)}>
                          Prüfen
                          <Icon name="chev" />
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void write(`/${link.id}`, 'PUT', { decision: 'rejected' })}>
                        Verwerfen
                      </Button>
                      {!review && (
                        <a className="btn sm ghost" href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>
                          Produktseite
                          <Icon name="ext" />
                        </a>
                      )}
                    </span>
                  </div>
                  {deleteButton(link)}
                </li>
              );
            })}
            {rejected.map(link => (
              <li key={link.id} className="match">
                <Icon name="x" />
                <div className="match-body">
                  <b>{link.product?.name ?? 'Verworfenes Produkt'}</b>
                  <span className="match-actions">
                    <Pill tone="dim" icon="x">
                      Verworfen
                    </Pill>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void write(`/${link.id}`, 'PUT', { decision: 'pending' })}>
                      Erneut prüfen
                    </Button>
                  </span>
                </div>
                {deleteButton(link)}
              </li>
            ))}
          </ul>
          <form className="form-grid link-form" onSubmit={add}>
            <div className="form-row">
              <span className="with-help">
                <label htmlFor="shop-product-url">Produktlink von Eneba oder Driffle ergänzen</label>
                <Help label="Hilfe zum Produktlink">Falls die automatische Suche diese Edition noch nicht abdeckt.</Help>
              </span>
              <span className="link-input">
                <input
                  id="shop-product-url"
                  type="url"
                  required
                  maxLength={300}
                  placeholder="https://www.eneba.com/…"
                  value={url}
                  aria-describedby={refused ? 'shop-product-double' : undefined}
                  aria-invalid={refused || undefined}
                  onChange={e => setUrl(e.target.value)}
                />
                <Button type="submit" disabled={busy || refused}>
                  Link prüfen
                </Button>
              </span>
              {refused && known && (
                <div className="note warn" role="alert" id="shop-product-double">
                  <Icon name="alert" />
                  <span>
                    {known.here
                      ? `Dieses Produkt ist „${itemName(item)}“ schon zugeordnet.`
                      : `Dieses Produkt ist schon ${assignedNames(known.assigned, item.platform_id)} zugeordnet.`}{' '}
                    Doppelte Zuordnungen sind nicht möglich{known.here ? '.' : ': Lösche oder verwirf die Zuordnung dort zuerst.'}
                  </span>
                </div>
              )}
            </div>
          </form>
        </Inset>
      </Panel>
    </div>
  );
}
