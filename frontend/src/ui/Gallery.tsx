import { useState } from 'react';
import { Button, Card, Chip, EmptyState, Icon, IconButton, MonoLabel, Price, SegmentedControl, StatusChip, Switch, TabPanel, Tabs, TargetLock } from './index';
import type { ChipKind } from './index';
import { Brand } from '../brand';

// Dev-only component sheet at /_ui (not part of the production build). Shows every primitive and state.
const kinds: ChipKind[] = ['best', 'valid', 'target', 'warn', 'stale', 'neutral', 'danger'];
const labels: Record<ChipKind, string> = { best: 'Bestpreis', valid: 'In DE aktivierbar', target: 'Ziel erreicht', warn: 'Zuordnung prüfen', stale: 'Veraltet · vor 2 T', neutral: 'Nicht in DE', danger: 'Abruf fehlgeschlagen' };

export default function Gallery() {
  const [tab, setTab] = useState('preis');
  const [segment, setSegment] = useState('base');
  const [on, setOn] = useState(true);
  const items = [{ id: 'preis', label: 'Preis' }, { id: 'angebote', label: 'Angebote', count: 12 }, { id: 'verlauf', label: 'Verlauf' }, { id: 'alarm', label: 'Alarm', disabled: true }];
  return <main className="gallery">
    <Brand /><h1>UI-Komponenten</h1>
    <section><MonoLabel>Aktionen</MonoLabel>
      <div className="row"><Button>Zum Angebot</Button><Button variant="secondary">Alarm setzen</Button><Button variant="ghost">Abbrechen</Button><Button variant="danger">Entfernen</Button><Button size="sm">Klein</Button><Button disabled>Deaktiviert</Button><Button loading>Lädt …</Button><IconButton label="Suche schließen"><Icon name="close" /></IconButton><IconButton label="Hinzufügen" variant="primary"><Icon name="plus" /></IconButton></div></section>
    <section><MonoLabel>Status</MonoLabel><div className="row">{kinds.map(kind => <StatusChip key={kind} kind={kind}>{labels[kind]}</StatusChip>)}<Chip kind="neutral" icon="clock">Eigener Text</Chip></div></section>
    <section><MonoLabel>Preis</MonoLabel>
      <div className="row"><Price cents={2392} size="xl" /><Price cents={2392} size="md" /><Price cents={4180} size="sm" /><Price cents={123456} size="md" tone="stale" /><Price cents={2500} size="md" tone="target" /><Price cents={2700} size="sm" struck /><Price cents={null} /><Price cents={undefined} missing="wird gesucht …" /></div></section>
    <section><MonoLabel>Tabs</MonoLabel><Tabs items={items} value={tab} onChange={setTab} label="Spieldetails" id="demo" />
      <TabPanel id="demo" tab="preis" value={tab}><p>Inhalt Preis</p></TabPanel><TabPanel id="demo" tab="angebote" value={tab}><p>Inhalt Angebote</p></TabPanel><TabPanel id="demo" tab="verlauf" value={tab}><p>Inhalt Verlauf</p></TabPanel>
      <Tabs items={items} value={tab} onChange={setTab} label="Spieldetails kompakt" variant="segment" id="demo2" />
      <SegmentedControl label="Preisgrundlage" value={segment} onChange={setSegment} options={[{ value: 'base', label: 'Grundpreis' }, { value: 'fees', label: 'mit Gebühren' }]} /></section>
    <section><MonoLabel>Schalter</MonoLabel><div className="row"><Switch checked={on} onChange={setOn}>Nur in DE aktivierbar</Switch><Switch checked={false} onChange={() => {}}>Aus</Switch><Switch checked disabled onChange={() => {}}>Deaktiviert</Switch></div></section>
    <section><MonoLabel>Karten und Zielerfassung</MonoLabel>
      <div className="row"><Card><MonoLabel>Bester gültiger Preis · DE</MonoLabel><br /><Price cents={2392} size="md" /></Card><Card selected>Ausgewählt</Card><Card as="button" interactive>Interaktiv</Card><Card lock>Mit Zielerfassung</Card><TargetLock><span className="demo-cover" /></TargetLock></div></section>
    <section><MonoLabel>Leerer Zustand</MonoLabel><EmptyState icon="heart" title="Noch keine Spiele" action={<Button>Spiel hinzufügen</Button>}>Suche ein Spiel und merke es vor.</EmptyState></section>
  </main>;
}
