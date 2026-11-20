import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, HttpError } from '../api';
import { Button, ConfirmDialog, Notice, Pill, Switch } from '../components';
import type { IconName, PillTone } from '../ui';
import { SettingsPanel } from './settings/parts';

interface Props {
  /** State from /sources/status: not_configured, configured, ready, rate_limited, invalid_credentials, unavailable, disabled. */
  state: string | undefined;
  configured: boolean | undefined;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  csrf: string;
  onChanged: () => void;
  onError: (error: unknown) => void;
}

const chips: Record<string, { tone: PillTone; text: string; icon: IconName }> = {
  ready: { tone: 'ok', text: 'Verbunden', icon: 'check' },
  configured: { tone: 'ok', text: 'Zugang hinterlegt', icon: 'check' },
  not_configured: { tone: 'dim', text: 'Nicht eingerichtet', icon: 'minus' },
  disabled: { tone: 'dim', text: 'Deaktiviert', icon: 'minus' },
  rate_limited: { tone: 'warn', text: 'Abruflimit erreicht', icon: 'alert' },
  invalid_credentials: { tone: 'danger', text: 'Zugang ungültig', icon: 'alert' },
  unavailable: { tone: 'warn', text: 'Nicht erreichbar', icon: 'alert' },
};

export default function IgdbAccess({ state, configured, enabled, onEnabledChange, csrf, onChanged, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirmRemoval, setConfirmRemoval] = useState(false);

  async function change(method: 'PUT' | 'DELETE', form?: HTMLFormElement) {
    setBusy(true);
    setError('');
    setMessage('');
    const fields = form ? new FormData(form) : null;
    const body = fields ? {
      client_id: String(fields.get('client_id') ?? '').trim(),
      client_secret: String(fields.get('client_secret') ?? '').trim(),
    } : undefined;
    try {
      await api('/settings/igdb', method, body, csrf);
      setMessage(method === 'PUT' ? 'IGDB-Zugang gespeichert und geprüft.' : 'IGDB-Zugang entfernt.');
      setConfirmRemoval(false);
      onChanged();
    } catch (exception) {
      if (exception instanceof HttpError && exception.status === 401) onError(exception);
      else setError(exception instanceof Error ? exception.message : 'IGDB-Zugang konnte nicht geändert werden.');
    } finally {
      form?.reset();
      setBusy(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void change('PUT', event.currentTarget);
  }
  const chip = state === undefined ? null : chips[enabled ? state : 'disabled'] ?? { tone: 'default' as const, text: state, icon: 'minus' as const };

  return <SettingsPanel title="IGDB-Zugang" titleId="igdb-access-title"
    aside={chip ? <Pill tone={chip.tone} icon={chip.icon}>{chip.text}</Pill> : <span className="hint">Status wird geladen …</span>}>
    <form className="form-grid" method="post" onSubmit={save} autoComplete="off">
      <p className="hint">Spielesuche, Editionen, Cover und Artwork. IGDB ist unabhängig von den Key-Shops.</p>
      {error && <Notice error>{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      <div className="set-two">
        <div className="form-row"><label htmlFor="igdb-client-id">Client-ID</label>
          <input id="igdb-client-id" name="client_id" required maxLength={512} spellCheck={false} autoCapitalize="none" disabled={busy}
            placeholder={configured ? 'gespeichert · zum Ändern neu eingeben' : ''} /></div>
        <div className="form-row"><label htmlFor="igdb-client-secret">Client Secret</label>
          <input id="igdb-client-secret" name="client_secret" type="password" required maxLength={512} autoComplete="off" disabled={busy}
            placeholder={configured ? 'gespeichert · zum Ändern neu eingeben' : ''} /></div>
      </div>
      <div className="set-actions">
        <Button type="submit" disabled={busy || confirmRemoval}>{busy && !confirmRemoval ? 'Wird geprüft …' : 'Prüfen und speichern'}</Button>
        {configured && !confirmRemoval && <Button type="button" variant="danger" disabled={busy} onClick={() => setConfirmRemoval(true)}>Zugang entfernen</Button>}
      </div>
      <Switch checked={enabled} onChange={onEnabledChange}>Spieleindex aktiv</Switch>
      <p className="hint">Hinterlege die Client-ID und das Client Secret deiner Twitch-Anwendung. Die Werte liegen geschützt im Datenverzeichnis und werden nie angezeigt. Backups des Datenverzeichnisses enthalten sie.</p>
    </form>
    <ConfirmDialog
      open={confirmRemoval}
      title="IGDB-Zugang entfernen?"
      cancelLabel="Zugang behalten"
      confirmLabel="Entfernen bestätigen" danger
      busy={busy}
      onCancel={() => setConfirmRemoval(false)}
      onConfirm={() => void change('DELETE')}
    >
      <p>Für neue Katalogabfragen sind anschließend wieder Zugangsdaten nötig.</p>
      {error && <Notice error>{error}</Notice>}
    </ConfirmDialog>
  </SettingsPanel>;
}
