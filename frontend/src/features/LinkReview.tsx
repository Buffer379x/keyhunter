import { useEffect, useId, useRef } from 'react';
import { Button, Icon, Notice, Reg } from '../components';
import type { Link } from './offers-model';
import { mismatchText } from './offers-model';
import { money } from './price-format';
import { countryData, regionCode } from './regions';
import { shopNames } from './shop-names';

const activationNames: Record<string, string> = { confirmed: 'bestätigt', blocked: 'im Zielland gesperrt', unknown: 'ungeklärt' };
const availabilityNames: Record<string, string> = { in_stock: 'lieferbar', sold_out: 'ausverkauft', unknown: 'unbekannt' };

/** Host and path of a shop link, so the owner sees where the button leads before opening it. */
export function linkParts(url: string): { host: string; path: string } {
  try {
    const parsed = new URL(url);
    return { host: parsed.host.replace(/^www\./, ''), path: `${parsed.pathname}${parsed.search}` };
  } catch {
    return { host: '', path: url };
  }
}

/**
 * Prüf-Popup of one shop product: what the shop says (title, region, activation, price) next to the wished game, the full
 * address of the product page with a button that opens it in a new tab, and the confirmation. Products whose shop data does
 * not match the game automatically (`can_confirm` false) can be confirmed here by hand; the backend keeps that for exactly this
 * product and asks again when the shop puts another product behind the link.
 */
export default function LinkReview({
  link,
  game,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  link: Link | null;
  game: string;
  busy: boolean;
  /** Error of the last write, shown inside the popup (the page behind it is covered). */ error: string;
  onClose: () => void;
  onConfirm: (link: Link) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const open = link !== null;
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open) dialog.current?.close();
  }, [open]);
  const product = link?.product ?? null;
  const shop = link ? (shopNames[link.source] ?? link.source) : '';
  const parts = link ? linkParts(link.url) : { host: '', path: '' };
  const cheapest = link?.quotes.length ? Math.min(...link.quotes.map(quote => quote.base_cents)) : null;
  const renamed = !!link?.renamed && link.review === 'confirmed';
  const mismatch = link?.mismatch ?? [];
  /** Not an Xbox key for this system (an account, a PC-only product): never confirmable, never a key price (FUNC-04). */
  const blocked = !!product && link?.manual_allowed === false;
  return (
    <dialog
      ref={dialog}
      className="link-review"
      aria-labelledby={titleId}
      onKeyDown={event => {
        if (event.key === 'Escape') event.stopPropagation();
      }}
      onCancel={event => {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onClose();
      }}
    >
      {link && (
        <>
          <h2 id={titleId}>Zuordnung prüfen</h2>
          <dl className="review-facts">
            <div>
              <dt>Spiel auf deiner Liste</dt>
              <dd>{game}</dd>
            </div>
            <div>
              <dt>Titel bei {shop}</dt>
              <dd>{product?.name ?? 'Produktdaten werden noch abgerufen'}</dd>
            </div>
            {product && (
              <>
                <div>
                  <dt>Region</dt>
                  <dd className="review-region">
                    {product.region ? (
                      <>
                        <Reg code={regionCode(product.region)} decorative />
                        {countryData(product.region).name}
                      </>
                    ) : (
                      'unbekannt'
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Aktivierung</dt>
                  <dd>{activationNames[product.activation] ?? product.activation}</dd>
                </div>
                <div>
                  <dt>Preis</dt>
                  <dd className="mono">
                    {cheapest !== null ? money(cheapest) : '–'} · {availabilityNames[product.availability] ?? product.availability}
                  </dd>
                </div>
              </>
            )}
          </dl>
          <div className="review-link">
            <span className="label">Produktseite</span>
            <p className="review-url" title={link.url}>
              <b>{parts.host}</b>
              {parts.path}
            </p>
            <a className="btn" href={link.url} target="_blank" rel="noopener noreferrer">
              Produktseite öffnen
              <Icon name="ext" />
            </a>
          </div>
          {blocked && (
            <div className="note warn" role="note">
              <Icon name="alert" />
              <span>
                {mismatch.includes('key_type')
                  ? 'Laut Shop ist das kein Aktivierungscode, sondern etwa ein Konto oder ein Geschenk.'
                  : `Laut Shop gilt der Key nicht für die Xbox-Plattform von „${game}“, etwa nur für PC.`}{' '}
                Solche Angebote zählen nie als Key-Preis, deshalb lässt sich die Zuordnung nicht bestätigen. Verwirf oder lösche sie.
              </span>
            </div>
          )}
          {product && !blocked && !link.can_confirm && (
            <div className="note warn" role="note">
              <Icon name="alert" />
              <span>
                {mismatchText(mismatch, game)} Prüfe die Produktseite: Mit deiner Bestätigung zählt der Preis dieses Produkts. Stellt der Shop ein anderes
                Produkt hinter den Link, fragt KeyHunter erneut.
              </span>
            </div>
          )}
          {renamed && (
            <p>
              Der Shop hat den Titel geändert: „{link.renamed!.from}“ → „{link.renamed!.to}“.
            </p>
          )}
          {!product && <p>Sobald {shop} die Produktdaten geliefert hat, kannst du die Zuordnung bestätigen.</p>}
          {error && <Notice error>{error}</Notice>}
          <div className="dialog-actions">
            <Button disabled={busy} onClick={onClose}>
              Abbrechen
            </Button>
            <Button variant="primary" disabled={busy || !product || blocked} onClick={() => onConfirm(link)}>
              {busy ? 'Wird gespeichert …' : renamed ? 'Neuen Titel übernehmen' : 'Zuordnung bestätigen'}
            </Button>
          </div>
        </>
      )}
    </dialog>
  );
}
