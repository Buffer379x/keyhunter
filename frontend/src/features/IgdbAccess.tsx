import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, HttpError } from '../api';
import { Button, Chip, ConfirmDialog, Notice, Switch } from '../components';
import type { ChipKind } from '../ui';
import { SectionCard } from './settings/parts';

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

const chips: Record<string, { kind: ChipKind; text: string; icon?: string }> = {
  ready: { kind: 'best', text: 'Verbunden' },
  configured: { kind: 'valid', text: 'Zugang hinterlegt' },
  not_configured: { kind: 'neutral', text: 'Nicht eingerichtet', icon: 'minus' },
  disabled: { kind: 'neutral', text: 'Deaktiviert', icon: 'minus' },
  rate_limited: { kind: 'warn', text: 'Abruflimit erreicht' },
  invalid_credentials: { kind: 'danger', text: 'Zugang ungültig' },
  unavailable: { kind: 'warn', text: 'Nicht erreichbar' },
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
  const chip = state === undefined ? null : chips[enabled ? state : 'disabled'] ?? { kind: 'neutral' as const, text: state, icon: 'minus' };

  return <SectionCard title="IGDB-Zugang" titleId="igdb-access-title" sub="Spielesuche, Editionen, Cover und Artwork. IGDB ist unabhängig von den Key-Shops."
    aside={chip ? <Chip kind={chip.kind} icon={chip.icon}>{chip.text}</Chip> : <span className="set-muted">Status wird geladen …</span>}>
    {error && <Notice error>{error}</Notice>}
    {message && <Notice>{message}</Notice>}
    <form className="set-igdb-form" method="post" onSubmit={save} autoComplete="off">
      <div className="set-two">
        <div className="field"><label htmlFor="igdb-client-id">Client-ID</label>
          <input id="igdb-client-id" name="client_id" required maxLength={512} spellCheck={false} autoCapitalize="none" disabled={busy}
            placeholder={configured ? 'gespeichert · zum Ändern neu eingeben' : ''} /></div>
        <div className="field"><label htmlFor="igdb-client-secret">Client Secret</label>
          <input id="igdb-client-secret" name="client_secret" type="password" required maxLength={512} autoComplete="off" disabled={busy}
            placeholder={configured ? 'gespeichert · zum Ändern neu eingeben' : ''} /></div>
      </div>
      <div className="set-actions">
        <Button type="submit" disabled={busy || confirmRemoval}>{busy && !confirmRemoval ? 'Wird geprüft …' : 'Prüfen und speichern'}</Button>
        {configured && !confirmRemoval && <Button type="button" variant="danger" disabled={busy} onClick={() => setConfirmRemoval(true)}>Zugang entfernen</Button>}
        <Switch checked={enabled} onChange={onEnabledChange}>Spieleindex aktiv</Switch>
      </div>
    </form>
    <p className="set-hint">Hinterlege die Client-ID und das Client Secret deiner Twitch-Anwendung. Die Werte liegen geschützt im Datenverzeichnis und werden nie angezeigt. Backups des Datenverzeichnisses enthalten sie.</p>
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
  </SectionCard>;
}
