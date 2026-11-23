import { useState } from 'react';
import { Help, Icon, IconButton, Inset, Label, Panel, PanelHead, StatePill } from '../components';
import { openSection } from './settings/sections';
import type { Section } from './settings/sections';

const DISMISSED = 'keyhunter.firstSteps.dismissed';
const dismissed = () => {
  try {
    return localStorage.getItem(DISMISSED) === '1';
  } catch {
    return false;
  }
};

/** What the checklist knows about the instance; undefined while a source is still loading. */
interface SetupState {
  /** Name of the target country, or null without one. */
  country: string | null;
  /** IGDB state from /sources/status ("ready", "configured", "not_configured", …). */
  index: string | undefined;
  /** At least one key shop is switched on. */
  shops: boolean | undefined;
  /** Games on the wishlist. */
  games: number;
  /** At least one notification channel is active (GET /alerts, `configured`). */
  channel: boolean | undefined;
}

type Step = { id: string; label: string; done: boolean; detail?: string; go: () => void };

/**
 * Erste Schritte (1.0, PROD-02 / RESP-15): what a new instance still needs, each step with its state and a way there.
 * Shown on the wishlist until every step is done or the owner hides it (this browser remembers that). It renders only
 * when every state is known and sits below the list, so it never pushes the list down while the page loads (PERF-05).
 */
export default function FirstSteps({ state, onAdd }: { state: SetupState; onAdd: () => void }) {
  const [hidden, setHidden] = useState(dismissed);
  if (hidden || state.index === undefined || state.shops === undefined || state.channel === undefined) return null;
  const go = (section: Section) => () => openSection(section);
  const steps: Step[] = [
    { id: 'country', label: 'Zielland wählen', done: !!state.country, detail: state.country ?? undefined, go: go('general') },
    { id: 'index', label: 'Spieleindex (IGDB) einrichten', done: ['ready', 'configured'].includes(state.index), go: go('index') },
    { id: 'shops', label: 'Key-Shop einschalten', done: state.shops, go: go('shops') },
    {
      id: 'game',
      label: 'Erstes Spiel vormerken',
      done: state.games > 0,
      detail: state.games > 0 ? `${state.games.toLocaleString('de-DE')} ${state.games === 1 ? 'Spiel' : 'Spiele'}` : undefined,
      go: onAdd,
    },
    { id: 'channel', label: 'Benachrichtigungskanal einrichten', done: state.channel, go: go('notifications') },
  ];
  const done = steps.filter(step => step.done).length;
  if (done === steps.length) return null;
  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(DISMISSED, '1');
    } catch {
      /* Hidden for this visit. */
    }
  };
  return (
    <Panel className="first-steps" aria-labelledby="first-steps-title">
      <PanelHead>
        <Label as="h2" tone="soft" id="first-steps-title">
          Erste Schritte
        </Label>
        <span className="mono muted">
          {done} von {steps.length}
        </span>
        <Help label="Hilfe zu den ersten Schritten">
          <span>Was KeyHunter zum Arbeiten braucht. Die Liste verschwindet, sobald alles erledigt ist.</span>
          <span>Zielland: Für dieses Land zählt der beste aktivierbare Preis; daneben steht immer die günstigste Region weltweit.</span>
          <span>
            Spieleindex: Client-ID und Client Secret einer eigenen Twitch-Anwendung (dev.twitch.tv/console/apps). Ohne sie gibt es keine Spielesuche, keine
            Editionen und keine Cover.
          </span>
          <span>Key-Shops: Mindestens ein Shop muss eingeschaltet sein, sonst sucht KeyHunter keine Angebote.</span>
          <span>Benachrichtigung: Ohne aktiven Kanal kommt kein Preisalarm an.</span>
        </Help>
        <span className="spacer" />
        <IconButton variant="ghost" label="Erste Schritte ausblenden" onClick={hide}>
          <Icon name="x" />
        </IconButton>
      </PanelHead>
      <Inset as="ol" className="first-steps-list">
        {steps.map(step => (
          <li key={step.id} className={step.done ? 'done' : undefined}>
            <button type="button" className="text-button" onClick={step.go}>
              {step.label}
            </button>
            {step.detail && <span className="muted">{step.detail}</span>}
            <span className="spacer" />
            {step.done ? <StatePill state="valid">Erledigt</StatePill> : <StatePill state="missing">Offen</StatePill>}
          </li>
        ))}
      </Inset>
    </Panel>
  );
}
