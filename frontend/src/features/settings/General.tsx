import { useState } from 'react';
import { api } from '../../api';
import type { Settings, WishlistItem } from '../../api';
import { Button, Icon, Notice } from '../../components';
import { downloadJson, wishlistExport } from '../wishlist-export';
import { RowCard, SectionCard } from './parts';
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
  const scopes: { value: Scope; title: string; text: string }[] = [
    { value: 'preferred', title: `Nur in ${targetName} aktivierbar`, text: `Tiefster gültiger Grundpreis im Zielland. Empfohlen.` },
    { value: 'all', title: 'Alle Regionen', text: `Günstigster Preis weltweit, auch wenn er in ${target ? targetName : 'deinem Zielland'} nicht aktivierbar ist.` },
  ];
  return <>
    <SectionCard title="Zielland" sub="Ein Angebot zählt nur, wenn der Shop die Aktivierung in diesem Land bestätigt.">
      <div className="form-row set-narrow">
        <label htmlFor="target-country">Zielland</label>
        <select id="target-country" value={target ?? ''} onChange={event => edit(current => ({ ...current, target_country: event.target.value || null }))}>
          <option value="">Bitte wählen</option>
          {countries.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
        </select>
      </div>
      {unconfirmed
        ? <p className="set-note" role="note" data-testid="activation-note">Die Shops bestätigen die Aktivierung derzeit nur für Deutschland. Für {nameOf(target)} werden Angebote angezeigt, zählen aber nicht als gültiger Bestpreis.</p>
        : <p className="set-hint">Die Shops bestätigen die Aktivierung derzeit für {confirmed.map(nameOf).join(', ')}. Für andere Länder erscheint ein Hinweis. Preise werden in Euro verglichen.</p>}
    </SectionCard>

    <SectionCard title="Preis in der Wunschliste" sub="Welcher Preis hinter jedem Spiel der Wunschliste steht.">
      <div role="radiogroup" aria-label="Preis in der Wunschliste" className="set-choices">
        {scopes.map(scope => <label key={scope.value} className={`set-choice${settings.wishlist_price_scope === scope.value ? ' on' : ''}`}>
          <input type="radio" name="wishlist-price-scope" className="sr-only" value={scope.value} checked={settings.wishlist_price_scope === scope.value}
            onChange={() => edit(current => ({ ...current, wishlist_price_scope: scope.value }))} />
          <span className="set-choice-title"><span className="set-radio" aria-hidden="true" />{scope.title}</span>
          <span className="set-choice-text">{scope.text}</span>
        </label>)}
      </div>
      <p className="set-hint">Angezeigt wird immer der Grundpreis ohne geschätzte Gebühren.</p>
    </SectionCard>

    <RowCard title="Wunschliste exportieren" sub="Titel, Plattform, IGDB-ID, Art und Prüfstatus als JSON">
      <Button loading={exporting} onClick={() => void exportList()}><Icon name="download" size={16} />Exportieren</Button>
    </RowCard>
    {exportError && <Notice error>{exportError}</Notice>}
  </>;
}
