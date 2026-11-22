import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Brand, Button, Notice } from '../components';
import { countryCodes } from './regions';

type Screen = 'loading' | 'setup' | 'login' | 'offline';

/**
 * Everything before the app shell: loading, first setup, sign-in and "Verbindung unterbrochen".
 * A centred 400 px panel in the prototype's language: the logo in the panel head, the form in the inset.
 */
export default function AuthScreen({
  screen,
  busy,
  error,
  onRetry,
  onSubmit,
}: {
  screen: Screen;
  busy: boolean;
  error: string;
  onRetry: () => void;
  onSubmit: (password: string, token?: string, targetCountry?: string) => Promise<void>;
}) {
  return (
    <main className="auth-layout">
      <div className="auth-card panel">
        <div className="auth-brand">
          <Brand />
        </div>
        <div className="inset auth-body">
          {screen === 'loading' ? (
            <p role="status" className="hint">
              KeyHunter wird geladen …
            </p>
          ) : screen === 'offline' ? (
            <>
              <div className="auth-title">
                <h1>Verbindung unterbrochen</h1>
                <p className="hint">KeyHunter ist gerade nicht erreichbar.</p>
              </div>
              <Notice error>{error}</Notice>
              <Button variant="primary" onClick={onRetry}>
                Erneut versuchen
              </Button>
            </>
          ) : (
            <AuthForm setup={screen === 'setup'} busy={busy} error={error} onSubmit={onSubmit} />
          )}
        </div>
      </div>
    </main>
  );
}

function AuthForm({
  setup,
  busy,
  error,
  onSubmit,
}: {
  setup: boolean;
  busy: boolean;
  error: string;
  onSubmit: (password: string, token?: string, targetCountry?: string) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [token, setToken] = useState('');
  const [country, setCountry] = useState(() => {
    const region = (navigator.language.split('-')[1] ?? '').toUpperCase();
    return countryCodes.includes(region) ? region : 'DE';
  });
  const countryOptions = useMemo(() => {
    const names = new Intl.DisplayNames(['de'], { type: 'region' });
    return countryCodes.map(code => ({ code, name: names.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }, []);
  const [localError, setLocalError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setLocalError('');
    const length = Array.from(password).length;
    if (length > 128 || (setup && length < 12)) {
      setLocalError(setup ? 'Die Passphrase muss 12 bis 128 Zeichen haben.' : 'Die Passphrase darf höchstens 128 Zeichen haben.');
      return;
    }
    if (setup && password !== confirm) {
      setLocalError('Die Passphrasen stimmen nicht überein.');
      return;
    }
    await onSubmit(password, setup ? token : undefined, setup ? country : undefined);
  }
  return (
    <>
      <div className="auth-title">
        <h1>{setup ? 'KeyHunter einrichten' : 'Anmelden'}</h1>
        <p className="hint">{setup ? 'Lege die Passphrase für deinen privaten Bereich fest.' : 'Melde dich mit deiner Passphrase an.'}</p>
      </div>
      <form onSubmit={submit}>
        {(localError || error) && <Notice error>{localError || error}</Notice>}
        {setup && (
          <div className="form-row">
            <label htmlFor="setup-token">Einrichtungscode</label>
            <input id="setup-token" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required spellCheck={false} />
            <span className="hint">
              Aus der lokalen Datei <code>bootstrap-token</code> im Datenverzeichnis.
            </span>
          </div>
        )}
        <div className="form-row">
          <label htmlFor="password">Passphrase</label>
          <input
            id="password"
            type="password"
            autoComplete={setup ? 'new-password' : 'current-password'}
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
          {setup && <span className="hint">12 bis 128 Zeichen, gerne mehrere Wörter.</span>}
        </div>
        {setup && (
          <div className="form-row">
            <label htmlFor="password-confirm">Passphrase wiederholen</label>
            <input id="password-confirm" type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} required />
          </div>
        )}
        {setup && (
          <div className="form-row">
            <label htmlFor="setup-country">Zielland</label>
            <select id="setup-country" value={country} onChange={e => setCountry(e.target.value)}>
              {countryOptions.map(c => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </select>
            <span className="hint">Für dieses Land werden Angebote als aktivierbar bewertet. Später in den Einstellungen änderbar.</span>
          </div>
        )}
        <Button variant="primary" type="submit" loading={busy}>
          {busy ? 'Bitte warten …' : setup ? 'Privaten Bereich einrichten' : 'Anmelden'}
        </Button>
      </form>
    </>
  );
}
