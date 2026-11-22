import IgdbAccess from '../IgdbAccess';
import type { Settings } from '../../api';
import { Help } from '../../components';
import { SettingsPanel } from './parts';
import type { SettingsDraft } from './draft';

export default function Index({
  settings,
  edit,
  igdbState,
  igdbConfigured,
  csrf,
  onChanged,
  onError,
}: {
  settings: Settings;
  edit: SettingsDraft['edit'];
  igdbState: string | undefined;
  igdbConfigured: boolean | undefined;
  csrf: string;
  onChanged: () => void;
  onError: (error: unknown) => void;
}) {
  const igdb = settings.sources.find(s => s.id === 'igdb');
  return (
    <>
      <IgdbAccess
        state={igdbState}
        configured={igdbConfigured}
        enabled={igdb?.enabled ?? true}
        onEnabledChange={enabled => edit(current => ({ ...current, sources: current.sources.map(s => (s.id === 'igdb' ? { ...s, enabled } : s)) }))}
        csrf={csrf}
        onChanged={onChanged}
        onError={onError}
      />
      <SettingsPanel
        title="Editionsinhalte von Microsoft / Xbox"
        titleId="edition-contents-title"
        aside={
          <Help label="Hilfe zu den Editionsinhalten">
            Offizielle Bundle-Inhalte ergänzen den Spieleindex für die Vergleichstabelle. Die Zuordnung erfolgt über die bei IGDB belegte Xbox-Store-Version.
            Zugangsdaten sind dafür nicht nötig.
          </Help>
        }
      >
        <div className="form-grid">
          <p className="hint">Wird beim Editionsvergleich geladen · mit Quellenangabe</p>
        </div>
      </SettingsPanel>
    </>
  );
}
