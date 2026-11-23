import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Settings } from '../../api';
import { Help, Icon, Seg, TabPanel } from '../../components';
import { SettingsPanel } from './parts';
import type { SettingsDraft } from './draft';
import WishlistColumns from './WishlistColumns';
import OffersColumns from './OffersColumns';

/** The column settings of both tables in one panel (0.8.3), one tab each. */
function TableColumns({ settings, edit }: { settings: Settings; edit: SettingsDraft['edit'] }) {
  const [table, setTable] = useState<'wishlist' | 'offers'>('wishlist');
  const tabs: { id: 'wishlist' | 'offers'; label: string; body: ReactNode }[] = [
    { id: 'wishlist', label: 'Wunschliste', body: <WishlistColumns settings={settings} edit={edit} /> },
    { id: 'offers', label: 'Angebote', body: <OffersColumns settings={settings} edit={edit} /> },
  ];
  return (
    <SettingsPanel title="Tabellenspalten" titleId="general-columns-title" insetClassName="col-panel">
      <Seg tabs="columns" label="Tabelle" className="box-seg" value={table} onChange={setTable} options={tabs.map(({ id, label }) => ({ value: id, label }))} />
      {tabs.map(tab => (
        <TabPanel key={tab.id} id="columns" tab={tab.id} value={table}>
          {tab.body}
        </TabPanel>
      ))}
    </SettingsPanel>
  );
}

export default function General({
  settings,
  countries,
  edit,
}: {
  settings: Settings;
  countries: { code: string; name: string }[];
  edit: SettingsDraft['edit'];
}) {
  const confirmed = settings.confirmed_activation_countries ?? [];
  const nameOf = (code: string) => countries.find(c => c.code === code)?.name ?? code;
  const target = settings.target_country;
  const unconfirmed = target !== null && !confirmed.includes(target);

  return (
    <>
      <SettingsPanel title="Region und Anzeige" titleId="general-region-title">
        <div className="form-grid">
          <div className="form-row">
            <span className="with-help">
              <label htmlFor="target-country">Zielland</label>
              <Help label="Hilfe zum Zielland">
                <span>Der beste Preis gilt für dieses Land. Die Wunschliste zeigt immer diesen Preis und daneben die günstigste Region weltweit.</span>
                <span>
                  Abgefragt werden alle Regionen gleich, das Zielland wird nicht bevorzugt. Ob ein Key im Zielland aktivierbar ist, prüft KeyHunter für jedes
                  Land einzeln anhand der Länderliste des Shops.
                </span>
                <span>
                  Die Shops werden aus der EU abgefragt; ihr Euro-Preis gilt in allen EU-Ländern gleich. Für Länder außerhalb der EU zählt kein Angebot als
                  gültiger Bestpreis.
                </span>
              </Help>
            </span>
            <select
              id="target-country"
              className="set-w-260"
              value={target ?? ''}
              onChange={event => edit(current => ({ ...current, target_country: event.target.value || null }))}
            >
              <option value="">Bitte wählen</option>
              {countries.map(c => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          {unconfirmed && (
            <div className="note warn" role="note" data-testid="activation-note">
              <Icon name="alert" />
              <span>
                Die Shop-Preise gelten für Käufe aus der EU. Für {nameOf(target)} werden Angebote angezeigt, zählen aber nicht als gültiger Bestpreis.
              </span>
            </div>
          )}
        </div>
      </SettingsPanel>

      <TableColumns settings={settings} edit={edit} />
    </>
  );
}
