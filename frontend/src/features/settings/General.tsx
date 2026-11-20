import { useState } from 'react';
import { api } from '../../api';
import type { Settings, WishlistItem } from '../../api';
import { Button, Icon, Notice, Seg } from '../../components';
import { downloadJson, wishlistExport } from '../wishlist-export';
import { SettingsPanel } from './parts';
import type { Autosave } from './autosave';

type Scope = Settings['wishlist_price_scope'];

export default function General({ settings, countries, edit, onError }: {
  settings: Settings; countries: { code: string; name: string }[]; edit: Autosave['edit']; onError: (error: unknown) => void;
}) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const confirmed = settings.confirmed_activation_countries ?? ['DE'];
  const nameOf = (code: string) => countries.find(c => c.code === code)?.name ?? code;
  const target = settings.target_country;
  const unconfirmed = target !== null && !confirmed.includes(target);
  const targetName = target ? nameOf(target) : 'Zielland';

  async function exportList() {
    setExporting(true); setExportError('');
    try {
      const rows = await api<WishlistItem[]>('/wishlist');
      downloadJson('keyhunter-wunschliste.json', wishlistExport(rows));
    } catch (e) { setExportError(e instanceof Error ? e.message : 'Die Wunschliste konnte nicht exportiert werden.'); onError(e); }
    finally { setExporting(false); }
  }
  const scope = settings.wishlist_price_scope;
  const scopeHint: Record<Scope, string> = {
    preferred: `Tiefster gültiger Grundpreis in ${targetName}. Empfohlen.`,
    all: `Günstigster Preis weltweit, auch wenn er in ${target ? targetName : 'deinem Zielland'} nicht aktivierbar ist.`,
  };
  return <>
    <SettingsPanel title="Region und Anzeige" titleId="general-region-title">
      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="target-country">Zielland</label>
          <select id="target-country" className="set-w-260" value={target ?? ''} onChange={event => edit(current => ({ ...current, target_country: event.target.value || null }))}>
            <option value="">Bitte wählen</option>
            {countries.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </div>
        {unconfirmed
          ? <div className="note warn" role="note" data-testid="activation-note"><Icon name="alert" /><span>Die Shops bestätigen die Aktivierung derzeit nur für Deutschland. Für {nameOf(target)} werden Angebote angezeigt, zählen aber nicht als gültiger Bestpreis.</span></div>
          : <p className="hint">Der beste Preis gilt für dieses Land. Günstigere Regionen weltweit werden immer zum Vergleich angezeigt. Die Shops bestätigen die Aktivierung derzeit für {confirmed.map(nameOf).join(', ')}; Preise werden in Euro verglichen.</p>}
        <div className="form-row">
          <span id="price-scope-label">Preis in der Wunschliste</span>
          <Seg label="Preis in der Wunschliste" value={scope} onChange={value => edit(current => ({ ...current, wishlist_price_scope: value }))}
            options={[{ value: 'preferred', label: `Nur in ${targetName} aktivierbar` }, { value: 'all', label: 'Alle Regionen' }]} />
          <span className="hint">{scopeHint[scope]} Angezeigt wird immer der Grundpreis ohne geschätzte Gebühren.</span>
        </div>
      </div>
    </SettingsPanel>

    <SettingsPanel title="Export" titleId="general-export-title">
      <div className="form-grid">
        <div className="set-row">
          <div><h3 className="set-row-title">Wunschliste exportieren</h3><p className="hint">Titel, Plattform, IGDB-ID, Art und Prüfstatus als JSON</p></div>
          <Button loading={exporting} onClick={() => void exportList()}><Icon name="download" />Exportieren</Button>
        </div>
        {exportError && <Notice error>{exportError}</Notice>}
      </div>
    </SettingsPanel>
  </>;
}
