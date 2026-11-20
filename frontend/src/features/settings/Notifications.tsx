import { useState } from 'react';
import { api } from '../../api';
import type { AlertOverview } from '../../api';
import { Button, Icon, Notice, Pill } from '../../components';
import { relativeTime } from '../../time';
import { SettingsPanel } from './parts';
import { deliveryNames, lastTest } from './format';

export default function Notifications({ overview, failed, csrf, reload, onError }: {
  overview: AlertOverview | null; failed: boolean; csrf: string; reload: () => void; onError: (error: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function test() {
    setBusy(true); setMessage(''); setError('');
    try { await api('/alerts/test', 'POST', undefined, csrf); setMessage('Testnachricht zur Zustellung vorgemerkt.'); reload(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Testnachricht konnte nicht vorgemerkt werden.'); onError(e); }
    finally { setBusy(false); }
  }
  const last = overview ? lastTest(overview.events) : null;
  const aside = overview
    ? <Pill tone={overview.configured ? 'ok' : 'dim'} icon={overview.configured ? 'check' : 'minus'}>{overview.configured ? 'Eingerichtet' : 'Nicht eingerichtet'}</Pill>
    : <span className="hint">{failed ? 'Status nicht lesbar' : 'Status wird geladen …'}</span>;
  return <SettingsPanel title="ntfy" titleId="ntfy-title" aside={aside}>
    <div className="form-grid">
      <p className="hint">
        {overview?.configured
          ? 'Der Kanal kommt aus /config/ntfy.env. Änderungen wirken nach einem Neustart des Containers.'
          : 'ntfy wird über die Datei /config/ntfy.env eingerichtet (NTFY_URL, optional NTFY_TOKEN). Danach den Container neu starten.'}
      </p>
      {error && <Notice error>{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      <div className="set-actions">
        <Button disabled={!overview?.configured} loading={busy} onClick={() => void test()}><Icon name="send" />Testnachricht senden</Button>
        {last && <span className="label">Letzter Test {relativeTime(last.sent_at ?? last.observed_at)} · {deliveryNames[last.state] ?? last.state}</span>}
      </div>
      <p className="hint">Höchstens eine Nachricht je Spiel und 24 Stunden. Der Preis wird vor dem Versand erneut geprüft. Alarmregeln legst du im Detail eines Spiels an, die Übersicht findest du unter Preisalarme.</p>
    </div>
  </SettingsPanel>;
}
