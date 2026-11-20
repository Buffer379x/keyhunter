import { RowCard } from './parts';
import IgdbAccess from '../IgdbAccess';
import type { Settings } from '../../api';
import type { Autosave } from './autosave';

export default function Index({ settings, edit, igdbState, igdbConfigured, csrf, onChanged, onError }: {
  settings: Settings; edit: Autosave['edit']; igdbState: string | undefined; igdbConfigured: boolean | undefined;
  csrf: string; onChanged: () => void; onError: (error: unknown) => void;
}) {
  const igdb = settings.sources.find(s => s.id === 'igdb');
  return <>
    <IgdbAccess state={igdbState} configured={igdbConfigured} enabled={igdb?.enabled ?? true}
      onEnabledChange={enabled => edit(current => ({ ...current, sources: current.sources.map(s => s.id === 'igdb' ? { ...s, enabled } : s) }))}
      csrf={csrf} onChanged={onChanged} onError={onError} />
    <RowCard title="Editionsinhalte von Microsoft / Xbox" headingId="edition-contents-title"
      sub="Offizielle Bundle-Inhalte ergänzen den Spieleindex für die Vergleichstabelle. Die Zuordnung erfolgt über die bei IGDB belegte Xbox-Store-Version. Zugangsdaten sind dafür nicht nötig." >
      <span className="set-muted set-aside">Wird beim Editionsvergleich geladen · mit Quellenangabe</span>
    </RowCard>
  </>;
}
