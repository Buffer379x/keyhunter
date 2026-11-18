import { useState } from 'react';
import type { FormEvent } from 'react';
import { api, HttpError } from '../api';
import { Button, Notice } from '../components';

interface Props {
  configured: boolean | undefined;
  csrf: string;
  onChanged: () => void;
  onError: (error: unknown) => void;
}

export default function IgdbAccess({ configured, csrf, onChanged, onError }: Props) {
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

  return <section className="settings-card" aria-labelledby="igdb-access-title">
    <div className="section-number">03</div>
    <div className="section-content">
      <h2 id="igdb-access-title">IGDB-Zugang</h2>
      <p>Hinterlege die Client-ID und das Client Secret deiner Twitch-Anwendung für die IGDB-Suche.</p>
      <p className="source-state">{configured === undefined ? 'Zugangsstatus wird geladen …' : configured ? 'Zugangsdaten hinterlegt. Zum Ersetzen beide Werte neu eingeben.' : 'Noch keine Zugangsdaten hinterlegt.'}</p>
      {error && <Notice error>{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      <form className="igdb-access-form" method="post" onSubmit={save} autoComplete="off">
        <div className="field-grid">
          <div className="field"><label htmlFor="igdb-client-id">Client-ID</label><input id="igdb-client-id" name="client_id" required maxLength={512} spellCheck={false} autoCapitalize="none" disabled={busy} /></div>
          <div className="field"><label htmlFor="igdb-client-secret">Client Secret</label><input id="igdb-client-secret" name="client_secret" type="password" required maxLength={512} autoComplete="off" disabled={busy} /></div>
        </div>
        <div className="offer-actions">
          <Button type="submit" disabled={busy || confirmRemoval}>{busy && !confirmRemoval ? 'Wird geprüft …' : 'IGDB-Zugang speichern'}</Button>
          {configured && !confirmRemoval && <Button type="button" secondary disabled={busy} onClick={() => setConfirmRemoval(true)}>IGDB-Zugang entfernen</Button>}
        </div>
      </form>
      {confirmRemoval && <div>
        <p>Den gespeicherten Zugang entfernen? Deine Wunschliste bleibt verfügbar.</p>
        <div className="offer-actions">
          <Button secondary disabled={busy} onClick={() => setConfirmRemoval(false)}>Zugang behalten</Button>
          <Button disabled={busy} onClick={() => void change('DELETE')}>Entfernen bestätigen</Button>
        </div>
      </div>}
    </div>
  </section>;
}
