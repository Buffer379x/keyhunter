import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, CART_CHANGED, HttpError } from '../api';
import type { WishlistItem } from '../api';
import { Button, EmptyState, Icon, IconButton, Inset, Label, Notice, PageHeading, Panel, PanelHead, Price, Reg, Seg, formatPrice } from '../components';
import { whenVisible } from '../poll';
import { itemName } from './catalog-ui';
import GameCover from './GameCover';
import { cartSums, entryShop } from './cart-model';
import type { CartEntry, CartLine, CartScope } from './cart-model';
import { shopNames } from './shop-names';
import { regCode } from './WishlistRow';
import '../styles/cart.css';

/** Prices follow the saved shop checks: the cart reads them again this often while the tab is visible. */
const REFRESH_MS = 60_000;
const games = (n: number) => `${n} ${n === 1 ? 'Spiel' : 'Spiele'}`;
const shopName = (id: string | null) => id ? shopNames[id] ?? id : 'Shop unbekannt';
const time = (ms: number) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

interface Props {
  csrf: string;
  /** Target country code ("DE"), or "" without one. */
  targetCountry: string;
  onOpen: (item: WishlistItem) => void;
  onOpenWishlist: () => void;
  onError: (error: unknown) => void;
}

/**
 * Warenkorb (0.8.0): wishes the owner plans to buy together, with the total without and with the estimated fees, split by
 * shop. Each wish is in it once; "Gekauft" or deleting the wish takes it out.
 */
export default function Cart({ csrf, targetCountry, onOpen, onOpenWishlist, onError }: Props) {
  const [entries, setEntries] = useState<CartEntry[] | null>(null);
  const [wishes, setWishes] = useState<WishlistItem[]>([]);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState('');
  const [reload, setReload] = useState(0);
  const code = targetCountry.toUpperCase();

  useEffect(() => {
    const controller = new AbortController();
    let cancel = () => {};
    async function load() {
      try {
        const [cart, list] = await Promise.all([
          api<CartEntry[]>('/cart', 'GET', undefined, undefined, controller.signal),
          api<WishlistItem[]>('/wishlist', 'GET', undefined, undefined, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setEntries(cart); setWishes(list); setLoadedAt(Date.now()); setLoadError('');
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof HttpError && e.status === 401) { onError(e); return; }
        setLoadError(e instanceof Error ? e.message : 'Warenkorb konnte nicht geladen werden.');
      }
      cancel = whenVisible(() => void load(), REFRESH_MS);
    }
    void load();
    return () => { controller.abort(); cancel(); };
  }, [reload, onError]);

  const change = useCallback(async (method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) => {
    setBusy(true); setError('');
    try {
      await api(path, method, body, csrf);
      window.dispatchEvent(new Event(CART_CHANGED));
      setReload(n => n + 1);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Warenkorb konnte nicht geändert werden.');
      if (e instanceof HttpError && e.status === 401) onError(e);
      return false;
    } finally { setBusy(false); }
  }, [csrf, onError]);
  async function add(event: FormEvent) {
    event.preventDefault();
    if (pick && await change('POST', '/cart', { wish_id: pick })) setPick('');
  }

  const sums = entries ? cartSums(entries) : null;
  const homeLabel = `Preis ${code || 'Zielland'}`;
  /** An entry's shop and scope (0.8.1). DE/INT keeps the shop it shows, so a cheapest-shop entry then keeps that shop. */
  const choose = (line: CartLine, next: { source?: string | null; scope?: CartScope }) => {
    const source = next.source !== undefined ? next.source : line.item.source ?? entryShop(line.item);
    // "Günstigster Shop" is the cheapest variant of any region, like the button on the game page.
    const scope = next.source === null ? 'world' : next.scope ?? line.item.scope;
    void change('PUT', `/cart/${encodeURIComponent(line.item.id)}`, { source, scope });
  };
  const addable = wishes.filter(wish => !wish.in_cart && !entries?.some(entry => entry.id === wish.id)).sort((a, b) => itemName(a).localeCompare(itemName(b), 'de'));
  const sub = !entries ? 'Wird geladen …' : entries.length === 0 ? 'Leer · lege Spiele aus der Wunschliste hinein'
    : `${games(entries.length)} · Preise aus den letzten Shop-Abfragen${loadedAt ? `, Stand ${time(loadedAt)}` : ''}`;
  // Only while a wish is left to add; with none on the wishlist the empty state links to it.
  const picker = addable.length > 0 && <form className="cart-add" onSubmit={add}>
    <select aria-label="Spiel aus der Wunschliste wählen" value={pick} onChange={event => setPick(event.target.value)} disabled={busy}>
      <option value="">Spiel aus der Wunschliste …</option>
      {addable.map(wish => <option key={wish.id} value={wish.id}>{itemName(wish)}</option>)}
    </select>
    <Button type="submit" disabled={busy || !pick}><Icon name="cart" />In den Warenkorb</Button>
  </form>;

  return <section className="page cart-page" aria-labelledby="cart-title">
    <PageHeading id="cart-title" title="Warenkorb" sub={sub} />
    {loadError && <Notice error>{loadError}<Button size="sm" onClick={() => setReload(n => n + 1)}>Erneut laden</Button></Notice>}
    {error && <Notice error>{error}</Notice>}
    {entries?.length === 0 && <Panel><EmptyState icon="cart" title="Der Warenkorb ist leer"
      action={<div className="cart-empty-actions">{picker}<Button variant="ghost" onClick={onOpenWishlist}>Zur Wunschliste</Button></div>}>
      Lege Spiele aus der Wunschliste hinein, dann siehst du den Gesamtpreis mit und ohne Gebühren, nach Shops aufgeteilt.</EmptyState></Panel>}
    {sums && entries && entries.length > 0 && <div className="cart-grid">
      <Panel aria-labelledby="cart-items-title">
        <PanelHead><Label id="cart-items-title">Im Warenkorb</Label><span className="spacer" />{picker}</PanelHead>
        <Inset className="table-wrap">
          <table className="cart-table" aria-label="Spiele im Warenkorb">
            <thead><tr><th>Spiel</th><th>Shop</th><th>Preis</th><th className="r">Key-Preis</th><th className="r">Gebühren</th><th className="r">Gesamt</th><th><span className="sr-only">Entfernen</span></th></tr></thead>
            <tbody>{sums.lines.map(line => {
              const name = itemName(line.item);
              const reg = regCode(line.region);
              const shops = Object.keys(line.item.offers ?? {}).sort((a, b) => shopName(a).localeCompare(shopName(b), 'de'));
              const shopPrice = (id: string) => { const offer = line.item.offers[id]?.[line.item.scope]; return offer ? ` · ${formatPrice(offer.cents)}` : ''; };
              return <tr key={line.item.id} className={line.item.source !== null || line.item.scope !== 'world' ? 'chosen' : undefined}>
                <td className="c-game"><div className="game-cell"><GameCover small src={line.item.game?.cover_url} title={name} />
                  <button type="button" className="title-open" title="Details öffnen" onClick={() => onOpen(line.item)}><b>{name}</b></button></div></td>
                <td className="c-shop"><select aria-label={`Shop für ${name}`} value={line.item.source ?? ''} disabled={busy}
                    onChange={event => choose(line, { source: event.target.value || null })}>
                    <option value="">Günstigster{line.item.source === null && line.source ? ` (${shopName(line.source)})` : ''}</option>
                    {shops.map(id => <option key={id} value={id}>{shopName(id)}{shopPrice(id)}</option>)}
                  </select>
                  {line.base !== null && reg && <span className="cart-region"><Reg code={reg.code} title={reg.name} />{reg.name}</span>}</td>
                <td className="c-scope"><Seg label={`Preisgrundlage für ${name}`} value={line.item.scope} onChange={scope => choose(line, { scope })}
                  options={[{ value: 'home', label: code || 'DE', disabled: busy }, { value: 'world', label: 'INT', disabled: busy }]} /></td>
                <td className="c-key r">{line.base !== null ? <><Price cents={line.base} tone={line.stale ? 'stale' : 'default'} />{line.stale && <div className="wl-sub">zuletzt bekannt</div>}</>
                  : <span className="wl-note faint">{line.item.scope === 'home' ? `Kein ${homeLabel}` : 'Kein Angebot'}{line.item.source ? ` bei ${shopName(line.item.source)}` : ''}</span>}</td>
                <td className="c-fee r">{line.base === null ? <span className="faint">–</span> : line.fee !== null ? <span className="mono">+{formatPrice(line.fee)}</span>
                  : <span className="wl-note faint" title={`Für ${shopName(line.source)} ist keine Gebührenschätzung eingestellt`}>unbekannt</span>}</td>
                <td className="c-total r">{line.base !== null ? <Price cents={line.base + (line.fee ?? 0)} /> : <span className="faint">–</span>}</td>
                <td className="c-remove r"><IconButton variant="danger" label={`${name} aus dem Warenkorb nehmen`} disabled={busy} onClick={() => void change('DELETE', `/cart/${encodeURIComponent(line.item.id)}`)}><Icon name="trash" /></IconButton></td>
              </tr>;
            })}</tbody>
          </table>
        </Inset>
      </Panel>
      <Panel aria-labelledby="cart-sum-title" className="cart-sum">
        <PanelHead><Label id="cart-sum-title">Gesamt</Label></PanelHead>
        <Inset>
          <ul className="cart-shops" aria-label="Nach Shops">
            {sums.shops.map(shop => <li key={shop.source}>
              <div className="cart-shop-head"><b>{shopName(shop.source)}</b><span className="faint">{games(shop.count)}</span><Price cents={shop.total} /></div>
              <dl className="cart-split">
                <dt>Keys</dt><dd className="mono">{formatPrice(shop.keys)}</dd>
                <dt>Gebühren</dt><dd className="mono">{shop.fees !== null ? `+${formatPrice(shop.fees)}` : 'unbekannt'}</dd>
              </dl>
            </li>)}
          </ul>
          <dl className="cart-totals">
            <dt>Reine Key-Kosten</dt><dd><Price cents={sums.keys} /></dd>
            <dt>Gebühren (geschätzt)</dt><dd className="mono">+{formatPrice(sums.fees)}</dd>
            <dt className="cart-grand">Gesamt mit Gebühren</dt><dd className="cart-grand"><Price cents={sums.total} /></dd>
            <dt>Gesamt ohne Gebühren</dt><dd><Price cents={sums.keys} /></dd>
          </dl>
          {sums.extra && <dl className="cart-extra" aria-label="Mehrkosten">
            <dt>Mehrkosten gegenüber der günstigsten Zusammensetzung</dt>
            <dd><span className="mono">{sums.extra.total >= 0 ? '+' : '−'}{formatPrice(Math.abs(sums.extra.total))}</span> mit Gebühren · <span className="mono">{sums.extra.keys >= 0 ? '+' : '−'}{formatPrice(Math.abs(sums.extra.keys))}</span> Keys</dd>
          </dl>}
          {sums.unknownFees.length > 0 && <p className="hint">Für {sums.unknownFees.map(shopName).join(', ')} ist keine Gebührenschätzung eingestellt (Einstellungen › Key-Shops); dort zählt nur der Key-Preis.</p>}
          {sums.missing.length > 0 && <p className="hint">Nicht eingerechnet, ohne Preis für den gewählten Shop: {sums.missing.map(itemName).join(', ')}.</p>}
          <p className="hint">„Günstigster“ nimmt je Spiel das günstigste Angebot nach Key-Preis, egal welcher Shop und welche Region. {code || 'DE'} zählt nur im Zielland aktivierbare Keys des gewählten Shops, INT die günstigste Region dieses Shops. Die Gebühren sind Schätzungen aus den Einstellungen.</p>
        </Inset>
      </Panel>
    </div>}
  </section>;
}
