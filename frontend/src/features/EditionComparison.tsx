import { useEffect, useState } from 'react';
import { api } from '../api';
import type { CatalogGame, PriceBadgeData } from '../api';
import { Button, Icon, Inset, Label, Notice, Panel, PanelHead, Pill, Price } from '../components';
import { dateTime, money } from './price-format';

type Content = {
  igdb_id: number;
  status: string;
  source_url: string | null;
  observed_at: number;
  items: { id: string; name: string }[];
  description: string | null;
  /** "xbox": the store product was found on the Xbox store itself, not through the IGDB link (1.1.4). */
  via?: 'xbox';
};
export const editionName = (game: CatalogGame) => game.edition_name ?? (game.kind === 'base_game' ? 'Standard Edition' : game.name);

type Props = {
  gameId: number;
  platformId: number;
  games: CatalogGame[];
  savedId: number;
  viewedId: number | undefined;
  code: string;
  badgeOf: (game: CatalogGame) => PriceBadgeData | undefined;
  canView: (game: CatalogGame) => boolean;
  onView: (game: CatalogGame) => void;
};

/**
 * Editionen: one row per edition with its best price in the target country and worldwide (the saved price badges), the saved
 * one marked, the others opened as a preview. Below, the official contents per edition from the Microsoft Store.
 */
export default function EditionComparison({ gameId, platformId, games, savedId, viewedId, code, badgeOf, canView, onView }: Props) {
  const [data, setData] = useState<Content[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    void api<{ editions: Content[] }>(`/catalog/games/${gameId}/edition-comparison?platform=${platformId}`, 'GET', undefined, controller.signal)
      .then(result => {
        if (!controller.signal.aborted) setData(result.editions);
      })
      .catch(e => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Editionsinhalte konnten nicht geladen werden.');
      });
    return () => controller.abort();
  }, [gameId, platformId]);
  const features = new Map<string, string>();
  for (const entry of data ?? []) for (const item of entry.items) features.set(item.id, item.name);
  const entryOf = (game: CatalogGame) => data?.find(entry => entry.igdb_id === game.igdb_id);
  const priceOf = (game: CatalogGame) => {
    const badge = badgeOf(game);
    return badge?.state === 'price' && badge.cents ? badge.cents : null;
  };
  const missing = (game: CatalogGame) => {
    const badge = badgeOf(game);
    return badge?.state === 'review'
      ? 'Zuordnung prüfen'
      : badge?.pending || badge?.state === 'unknown'
        ? 'wird gesucht …'
        : badge
          ? 'kein Preis'
          : 'wird geladen …';
  };

  // "Premium enthält 1 Inhalt mehr als Standard für 6,37 € Aufpreis": the richest verified edition against the saved one.
  const saved = games.find(game => game.igdb_id === savedId);
  const count = (game: CatalogGame) => {
    const entry = entryOf(game);
    return entry?.status === 'verified' ? entry.items.length : null;
  };
  const richest = games.filter(game => game.igdb_id !== savedId && count(game) !== null).sort((a, b) => count(b)! - count(a)!)[0];
  const more = saved && richest && count(saved) !== null ? count(richest)! - count(saved)! : 0;
  const extra = saved && richest && priceOf(saved) !== null && priceOf(richest) !== null ? priceOf(richest)! - priceOf(saved)! : null;

  return (
    <div className="stack">
      <Panel aria-labelledby="editions-title">
        <PanelHead>
          <Label id="editions-title">Editionen</Label>
          <span className="spacer" />
          <span className="muted head-note">Andere Editionen werden als Vorschau beobachtet und belegen keinen Platz.</span>
        </PanelHead>
        <Inset className="ed-list">
          {games.map(game => {
            const isSaved = game.igdb_id === savedId,
              isViewed = game.igdb_id === viewedId,
              world = badgeOf(game)?.world;
            return (
              <div className="ed-row" key={game.igdb_id}>
                <div>
                  <b>{editionName(game)}</b>
                  <div className="muted sub">
                    {isSaved ? 'gemerkt' : isViewed ? 'Vorschau · wird angezeigt' : canView(game) ? 'Vorschau' : 'Vorschau wird vorbereitet …'}
                  </div>
                </div>
                <span className="ed-price hide-sm">
                  {priceOf(game) !== null ? <Price cents={priceOf(game)} /> : <span className="price-missing">{missing(game)}</span>}
                  <span className="label">{code}</span>
                </span>
                <span className="ed-price hide-sm">
                  {world ? <Price cents={world.cents} tone="world" /> : <span className="price-missing">–</span>}
                  <span className="label">INT</span>
                </span>
                {isSaved ? (
                  <Pill tone="hot" icon="heart">
                    gemerkt
                  </Pill>
                ) : (
                  <Button size="sm" aria-label={`${editionName(game)} ansehen`} aria-pressed={isViewed} disabled={!canView(game)} onClick={() => onView(game)}>
                    {isViewed ? 'Vorschau aktiv' : 'Ansehen'}
                  </Button>
                )}
              </div>
            );
          })}
        </Inset>
      </Panel>
      {games.length > 1 && (
        <Panel aria-labelledby="contents-title">
          <PanelHead>
            <Label id="contents-title">Inhalte · Microsoft Store</Label>
            <span className="spacer" />
            {saved && richest && more > 0 && (
              <span className="muted head-note">
                {editionName(richest)} enthält {more} {more === 1 ? 'Inhalt' : 'Inhalte'} mehr als {editionName(saved)}
                {extra !== null && extra >= 0 ? (
                  <>
                    {' '}
                    für <b>{money(extra)} Aufpreis</b>
                  </>
                ) : null}
                .
              </span>
            )}
          </PanelHead>
          <Inset className="table-wrap" tabIndex={0} role="region" aria-label="Editionsvergleich">
            {error ? (
              <Notice error>{error}</Notice>
            ) : !data ? (
              <p role="status" className="muted pad">
                Editionsinhalte werden geladen …
              </p>
            ) : (
              <table className="contents" aria-label="Editionsinhalte">
                <thead>
                  <tr>
                    <th scope="col">Inhalt</th>
                    {games.map(game => (
                      <th scope="col" key={game.igdb_id} className={game.igdb_id === savedId ? 'saved' : undefined}>
                        {editionName(game)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...features].map(([id, name]) => (
                    <tr key={id}>
                      <th scope="row">{name}</th>
                      {games.map(game => {
                        const entry = entryOf(game),
                          known = entry?.status === 'verified',
                          included = entry?.items.some(item => item.id === id);
                        return (
                          <td key={game.igdb_id} className={known && included ? 'yes' : undefined}>
                            <span role="img" aria-label={known ? (included ? 'Enthalten' : 'Nicht in der belegten Inhaltsliste') : 'Nicht belegt'}>
                              {known ? included ? <Icon name="check" /> : '—' : '?'}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {features.size === 0 && (
                    <tr>
                      <th scope="row">Strukturierte Inhaltsliste</th>
                      {games.map(game => (
                        <td key={game.igdb_id}>Nicht belegt</td>
                      ))}
                    </tr>
                  )}
                  <tr>
                    <th scope="row">Beschreibung</th>
                    {games.map(game => (
                      <td key={game.igdb_id} className="small">
                        <details>
                          <summary>Anzeigen</summary>
                          <p>{entryOf(game)?.description ?? game.summary ?? 'Keine Beschreibung verfügbar.'}</p>
                        </details>
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <th scope="row">Quelle &amp; Stand</th>
                    {games.map(game => {
                      const entry = entryOf(game);
                      return (
                        <td key={game.igdb_id} className="small">
                          {entry?.source_url ? (
                            <a href={entry.source_url} target="_blank" rel="noopener noreferrer">
                              Microsoft / Xbox
                            </a>
                          ) : (
                            'Keine Store-Zuordnung'
                          )}
                          {entry?.via === 'xbox' && <span className="muted"> · über den Xbox Store gefunden</span>}
                          {entry && <span className="muted"> · {dateTime(entry.observed_at)}</span>}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            )}
          </Inset>
          <p className="panel-foot">
            <span>✓ in der offiziellen Bundle-Liste · — dort nicht enthalten · ? nicht belegt. Händlerpakete können abweichen.</span>
          </p>
        </Panel>
      )}
    </div>
  );
}
