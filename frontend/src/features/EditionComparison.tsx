import { useEffect, useState } from 'react';
import { api } from '../api';
import type { CatalogGame, PriceBadgeData } from '../api';
import { Card, EmptyState, Icon, MonoLabel, Notice, Price } from '../components';
import { dateTime, money } from './price-format';

type Content = { igdb_id: number; status: string; source_url: string | null; observed_at: number; items: { id: string; name: string }[]; description: string | null };
export const editionName = (game: CatalogGame) => game.edition_name ?? (game.kind === 'base_game' ? 'Standard Edition' : game.name);

type Props = {
  gameId: number; platformId: number; games: CatalogGame[]; savedId: number; viewedId: number | undefined; marketLabel: string;
  badgeOf: (game: CatalogGame) => PriceBadgeData | undefined; canView: (game: CatalogGame) => boolean; onView: (game: CatalogGame) => void;
};

/** Editionen: contents from the Microsoft Store, the best price per edition and the preview action. */
export default function EditionComparison({ gameId, platformId, games, savedId, viewedId, marketLabel, badgeOf, canView, onView }: Props) {
  const [data, setData] = useState<Content[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError('');
    void api<{ editions: Content[] }>(`/catalog/games/${gameId}/edition-comparison?platform=${platformId}`, 'GET', undefined, undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) setData(result.editions); })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Editionsinhalte konnten nicht geladen werden.'); });
    return () => controller.abort();
  }, [gameId, platformId]);
  const features = new Map<string, string>();
  for (const entry of data ?? []) for (const item of entry.items) features.set(item.id, item.name);
  const entryOf = (game: CatalogGame) => data?.find(entry => entry.igdb_id === game.igdb_id);
  const priceOf = (game: CatalogGame) => { const badge = badgeOf(game); return badge?.state === 'price' && badge.cents ? badge : undefined; };

  // "Premium enthält 4 Inhalte mehr als Standard für 6,37 € Aufpreis": the richest verified edition against the saved one.
  const saved = games.find(game => game.igdb_id === savedId);
  const count = (game: CatalogGame) => { const entry = entryOf(game); return entry?.status === 'verified' ? entry.items.length : null; };
  const richest = games.filter(game => game.igdb_id !== savedId && count(game) !== null).sort((a, b) => count(b)! - count(a)!)[0];
  const more = saved && richest && count(saved) !== null ? count(richest)! - count(saved)! : 0;
  const extra = saved && richest && priceOf(saved) && priceOf(richest) ? priceOf(richest)!.cents! - priceOf(saved)!.cents! : null;
  const sentence = saved && richest && more > 0 ? <>{editionName(richest)} enthält {more} {more === 1 ? 'Inhalt' : 'Inhalte'} mehr als {editionName(saved)}{extra !== null && extra >= 0 ? <> für <strong>{money(extra)} Aufpreis</strong></> : null}.</> : null;

  return <Card className="edition-card" aria-labelledby="editions-title">
    <div className="edition-head"><h3 id="editions-title">{games.length} {games.length === 1 ? 'Edition' : 'Editionen'}</h3>{sentence && <p className="edition-sentence">{sentence}</p>}
      <MonoLabel>Inhalte: Microsoft Store · Markt {marketLabel}</MonoLabel></div>
    {error && <Notice error>{error}</Notice>}{!data && !error && <p role="status">Editionsinhalte werden geladen …</p>}
    {games.length === 0 && <EmptyState icon="layers" title="Keine Editionen bekannt" headingLevel={3} />}
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Editionsvergleich">
      <table className="edition-matrix" aria-label="Editionsinhalte">
        <thead><tr><th scope="col" className="mono-col">Inhalt</th>{games.map(game => {
          const badge = priceOf(game); const entry = count(game);
          return <th scope="col" key={game.igdb_id} className={game.igdb_id === savedId ? 'saved' : ''}>
            <span className="edition-col"><strong>{editionName(game)}</strong>
              {badge ? <Price cents={badge.cents} size="sm" tone={badge.stale ? 'stale' : 'default'} /> : <span className="edition-noprice">{badgeOf(game)?.state === 'review' ? 'Zuordnung prüfen' : badgeOf(game) ? 'kein Preis' : 'wird geladen …'}</span>}
              <MonoLabel tone={game.igdb_id === savedId ? 'accent' : 'muted'}>{game.igdb_id === savedId ? 'Gemerkt' : viewedId === game.igdb_id ? 'Vorschau' : entry !== null ? `${entry} Inhalte` : 'Inhalte offen'}</MonoLabel></span>
          </th>;
        })}</tr></thead>
        <tbody>
          {[...features].map(([id, name]) => <tr key={id}><th scope="row">{name}</th>{games.map(game => {
            const entry = entryOf(game); const known = entry?.status === 'verified'; const included = entry?.items.some(item => item.id === id);
            return <td key={game.igdb_id} className={`${known && included ? 'included' : ''} ${game.igdb_id === savedId ? 'saved' : ''}`}><span role="img" aria-label={known ? included ? 'Enthalten' : 'Nicht in der belegten Inhaltsliste' : 'Nicht belegt'}>{known ? included ? '✓' : '—' : '?'}</span></td>;
          })}</tr>)}
          {features.size === 0 && <tr><th scope="row">Strukturierte Inhaltsliste</th>{games.map(game => <td key={game.igdb_id} className={game.igdb_id === savedId ? 'saved' : ''}>{data ? 'Nicht belegt' : '…'}</td>)}</tr>}
          <tr><th scope="row">Beschreibung</th>{games.map(game => <td key={game.igdb_id} className={`desc ${game.igdb_id === savedId ? 'saved' : ''}`}><details><summary>Anzeigen</summary><p>{entryOf(game)?.description ?? game.summary ?? 'Keine Beschreibung verfügbar.'}</p></details></td>)}</tr>
          <tr><th scope="row">Quelle &amp; Stand</th>{games.map(game => { const entry = entryOf(game); return <td key={game.igdb_id} className={`desc ${game.igdb_id === savedId ? 'saved' : ''}`}>{entry?.source_url ? <a className="source-link" href={entry.source_url} target="_blank" rel="noopener noreferrer">Microsoft / Xbox <Icon name="external" size={13} /></a> : <span>Keine bestätigte Store-Zuordnung</span>}{entry && <small>{dateTime(entry.observed_at)}</small>}</td>; })}</tr>
          <tr className="action-row"><td />{games.map(game => <td key={game.igdb_id} className={game.igdb_id === savedId ? 'saved' : ''}>
            {game.igdb_id === savedId ? <button type="button" className="button secondary sm" disabled>Gemerkt</button>
              : <button type="button" className="button secondary sm" aria-label={`${editionName(game)} ansehen`} aria-pressed={viewedId === game.igdb_id} disabled={!canView(game)} onClick={() => onView(game)}>{viewedId === game.igdb_id ? 'Vorschau aktiv' : 'Ansehen'}</button>}
          </td>)}</tr>
        </tbody>
      </table>
    </div>
    <p className="card-footnote">✓ In der offiziellen Bundle-Liste enthalten · — dort nicht enthalten · ? nicht belegt. Preise wie in der Wunschliste, je Edition. Händlerpakete können vom offiziellen Inhalt abweichen.</p>
  </Card>;
}
