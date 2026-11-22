import { useState } from 'react';
import {
  BigPrice,
  Button,
  Chip,
  EmptyState,
  Field,
  FormRow,
  Icon,
  IconButton,
  Inset,
  Kpi,
  Label,
  Panel,
  PanelHead,
  Pill,
  Price,
  Reg,
  Seg,
  Switch,
  TabPanel,
  Tabs,
  Toast,
} from './index';
import { Brand } from '../brand';

// Dev-only component sheet at /_ui (not part of the production build). Shows every primitive and state.
export default function Gallery() {
  const [tab, setTab] = useState('preis');
  const [range, setRange] = useState('90');
  const [filter, setFilter] = useState('alle');
  const [on, setOn] = useState(true);
  const [toast, setToast] = useState('');
  const items = [
    { id: 'preis', label: 'Preis' },
    { id: 'angebote', label: 'Angebote', count: 12 },
    { id: 'verlauf', label: 'Verlauf' },
    { id: 'alarm', label: 'Alarm', disabled: true },
  ];
  return (
    <main className="gallery">
      <Brand />
      <h1>UI-Komponenten</h1>
      <section>
        <Label>Aktionen</Label>
        <div className="row">
          <Button variant="primary">
            <Icon name="plus" />
            Spiel hinzufügen
          </Button>
          <Button>
            <Icon name="download" />
            Liste exportieren
          </Button>
          <Button variant="ghost">Alle 9 Angebote</Button>
          <Button variant="danger">Entfernen</Button>
          <Button size="sm">
            Zum Shop
            <Icon name="ext" />
          </Button>
          <Button disabled>Deaktiviert</Button>
          <Button loading>Lädt …</Button>
          <IconButton label="Preisalarme">
            <Icon name="bell" />
          </IconButton>
          <IconButton label="Weitere Aktionen">
            <Icon name="more" />
          </IconButton>
        </div>
      </section>
      <section>
        <Label>Filter und Status</Label>
        <div className="chips">
          {['alle', 'ziel', 'welt'].map((id, n) => (
            <Chip key={id} pressed={filter === id} count={12 - n * 4} onClick={() => setFilter(id)}>
              {id === 'alle' ? 'Alle' : id === 'ziel' ? 'Ziel erreicht' : 'Weltweit günstiger'}
            </Chip>
          ))}
        </div>
        <div className="row">
          <Pill tone="ok" icon="check">
            in DE aktivierbar
          </Pill>
          <Pill tone="warn" icon="alert">
            Aktivierung ungeklärt
          </Pill>
          <Pill tone="hot" icon="target">
            Ziel erreicht
          </Pill>
          <Pill tone="dim" icon="refresh">
            Wird gesucht …
          </Pill>
          <Pill tone="danger" icon="alert">
            Abruffehler
          </Pill>
          <Pill>2,40 € über Ziel</Pill>
          <Reg code="IN" />
          <Reg code="DE" home />
        </div>
      </section>
      <section>
        <Label>Preise</Label>
        <div className="row">
          <BigPrice cents={2890} />
          <BigPrice cents={1290} world />
          <Price cents={2890} />
          <Price cents={1290} tone="world" />
          <Price cents={1290} tone="hot" />
          <Price cents={2700} struck />
          <Price cents={null} missing="wird gesucht …" />
        </div>
      </section>
      <section>
        <Label>Tabs und Segmente</Label>
        <Tabs items={items} value={tab} onChange={setTab} label="Spieldetails" id="demo" />
        <TabPanel id="demo" tab="preis" value={tab}>
          <p>Inhalt Preis</p>
        </TabPanel>
        <TabPanel id="demo" tab="angebote" value={tab}>
          <p>Inhalt Angebote</p>
        </TabPanel>
        <TabPanel id="demo" tab="verlauf" value={tab}>
          <p>Inhalt Verlauf</p>
        </TabPanel>
        <Seg
          label="Zeitraum"
          value={range}
          onChange={setRange}
          options={[
            { value: '30', label: '30 T' },
            { value: '90', label: '90 T' },
            { value: '180', label: '180 T' },
          ]}
        />
      </section>
      <section>
        <Label>Formular</Label>
        <div className="row">
          <Field icon="search" style={{ width: 200 }}>
            <input type="search" placeholder="Liste filtern …" aria-label="Liste filtern" />
          </Field>
          <Field>
            <span className="muted">Sortieren</span>
            <select aria-label="Sortieren">
              <option>Zuletzt hinzugefügt</option>
            </select>
          </Field>
          <Switch checked={on} onChange={setOn}>
            Nur in DE aktivierbar
          </Switch>
          <Switch checked={false} disabled onChange={() => {}}>
            Deaktiviert
          </Switch>
        </div>
        <div className="form-grid">
          <FormRow label="Zielpreis" hint="Ein Alarm wird höchstens einmal pro Tag gesendet.">
            <Field style={{ maxWidth: 180 }}>
              <input inputMode="decimal" defaultValue="29,00" aria-label="Zielpreis" />
              <span className="muted">€</span>
            </Field>
          </FormRow>
        </div>
      </section>
      <section>
        <Label>Panel, KPI, Tabelle</Label>
        <div className="kpis">
          <Kpi
            label="Wünsche"
            value="12"
            unit="Spiele"
            ticks={[4, 5, 5, 7, 8, 8, 9, 11, 12]}
            foot={
              <>
                <span>10 mit Preis</span>
                <span>2 offen</span>
              </>
            }
          />
          <Kpi
            label="Abrufe heute"
            value="412"
            unit="/ 500"
            foot={
              <>
                <span>Bedarf ≈ 470 pro Tag</span>
                <span className="good">reicht</span>
              </>
            }
          />
        </div>
        <Panel>
          <PanelHead>
            <Label>Angebote · nach Preis</Label>
            <span className="spacer" />
            <Button size="sm" variant="ghost">
              Alle
            </Button>
          </PanelHead>
          <Inset className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Shop</th>
                  <th>Region</th>
                  <th className="r">Preis</th>
                </tr>
              </thead>
              <tbody>
                <tr className="click">
                  <td>Eneba</td>
                  <td>
                    <Reg code="IN" />
                  </td>
                  <td className="r">
                    <Price cents={1290} tone="hot" />
                  </td>
                </tr>
                <tr>
                  <td>Driffle</td>
                  <td>
                    <Reg code="EU" />
                  </td>
                  <td className="r">
                    <Price cents={3280} />
                  </td>
                </tr>
              </tbody>
            </table>
          </Inset>
        </Panel>
      </section>
      <section>
        <Label>Leerer Zustand und Toast</Label>
        <Panel>
          <EmptyState
            icon="heart"
            title="Noch keine Spiele"
            action={
              <Button variant="primary" onClick={() => setToast('Zielland: Österreich')}>
                Toast zeigen
              </Button>
            }
          >
            Suche ein Spiel und merke es vor.
          </EmptyState>
        </Panel>
        <Toast message={toast} onDone={() => setToast('')} />
      </section>
    </main>
  );
}
