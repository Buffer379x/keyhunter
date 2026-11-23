import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { api, sessionEnded } from '../../api';
import { notify } from '../../notify';
import { usePolled } from '../../usePolled';
import type { ChannelView } from '../../api';
import { Button, ConfirmDialog, Help, Icon, Notice, Pill, Seg, Switch, TabPanel } from '../../components';
import { SettingsPanel } from './parts';
import { channelBody, channelDirty, channelFields, channelHelp, channelStored, channelValues, SECRET_SAVED } from './channels';

function status(view: ChannelView) {
  if (view.active)
    return (
      <Pill tone="ok" icon="check">
        Aktiv
      </Pill>
    );
  if (view.configured)
    return (
      <Pill tone="dim" icon="minus">
        Aus
      </Pill>
    );
  return (
    <Pill tone="dim" icon="minus">
      Nicht eingerichtet
    </Pill>
  );
}

/** Form of one channel: its fields, the switch (saves at once), "Speichern", "Test senden" (saves first when changed) and "Entfernen". */
function ChannelForm({ view, onChange }: { view: ChannelView; onChange: (next: ChannelView) => void }) {
  const [values, setValues] = useState(() => channelValues(view));
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'remove'>('');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const fields = channelFields[view.kind];
  const dirty = channelDirty(view, values);
  const path = `/alerts/channels/${view.kind}`;

  async function run(kind: 'save' | 'test' | 'remove', action: () => Promise<string>) {
    setBusy(kind);
    setError('');
    // Results are popups (0.9.1); only the remove dialog keeps its error inside, above the popups' layer.
    try {
      notify(await action());
    } catch (exception) {
      const text = exception instanceof Error ? exception.message : 'Die Anfrage konnte nicht abgeschlossen werden.';
      if (sessionEnded(exception)) return;
      if (kind === 'remove') setError(text);
      else notify(text, 'error');
    } finally {
      setBusy('');
    }
  }
  function show(next: ChannelView) {
    setValues(channelValues(next));
    onChange(next);
    return next;
  }
  const store = async (enabled: boolean) => show(await api<ChannelView>(path, 'PUT', channelBody(view, values, enabled)));
  function save(event: FormEvent) {
    event.preventDefault();
    void run('save', async () => {
      const next = await store(view.enabled);
      return next.active ? `${view.name} ist gespeichert und aktiv.` : `${view.name} ist gespeichert.`;
    });
  }
  const toggle = (enabled: boolean) =>
    void run('save', async () => {
      await store(enabled);
      return enabled ? `${view.name} ist eingeschaltet.` : `${view.name} ist ausgeschaltet.`;
    });
  const test = () =>
    void run('test', async () => {
      if (dirty) await store(view.enabled);
      await api(`${path}/test`, 'POST');
      return `Testnachricht über ${view.name} gesendet.`;
    });
  const remove = () =>
    void run('remove', async () => {
      await api(path, 'DELETE');
      setConfirm(false);
      const data = await api<{ channels: ChannelView[] }>('/alerts/channels');
      const next = data.channels.find(c => c.kind === view.kind);
      if (next) show(next);
      return `${view.name} ist entfernt.`;
    });

  return (
    <>
      <form className="form-grid" method="post" onSubmit={save} autoComplete="off">
        <div className="set-actions">
          <Switch checked={view.enabled && view.configured} disabled={busy !== '' || !view.configured} onChange={toggle}>
            <span className="sr-only">{view.name} </span>Aktiv
          </Switch>
          {status(view)}
          {view.from_file && <Pill icon="lock">aus /config/ntfy.env</Pill>}
          <Help label={`Hilfe zu ${view.name}`}>
            {channelHelp[view.kind].map(text => (
              <span key={text}>{text}</span>
            ))}
            <span>Tokens, Passwörter und geheime Adressen liegen geschützt im Datenverzeichnis und werden nie wieder angezeigt.</span>
          </Help>
        </div>
        {fields.map(field => {
          const id = `${view.kind}-${field.key}`;
          const saved = field.secret && view.secrets[field.key];
          const fromFile = view.from_file && field.key === 'url';
          const common = {
            id,
            name: field.key,
            value: values[field.key] ?? '',
            disabled: busy !== '',
            onChange: (event: { target: { value: string } }) => setValues(current => ({ ...current, [field.key]: event.target.value })),
          };
          return (
            <div className="form-row" key={field.key}>
              <label htmlFor={id}>{field.label}</label>
              {field.options ? (
                <select {...common}>
                  {field.options.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  {...common}
                  type={field.secret ? 'password' : 'text'}
                  inputMode={field.inputMode}
                  maxLength={2048}
                  spellCheck={false}
                  autoCapitalize="none"
                  autoComplete={field.secret ? 'new-password' : 'off'}
                  required={!field.optional && !saved && !fromFile}
                  placeholder={saved ? SECRET_SAVED : fromFile ? 'kommt aus /config/ntfy.env' : field.placeholder}
                />
              )}
            </div>
          );
        })}
        <div className="set-actions">
          <Button type="submit" variant="primary" disabled={busy !== ''} loading={busy === 'save'}>
            Speichern
          </Button>
          <Button type="button" disabled={busy !== '' || (!view.configured && !dirty)} loading={busy === 'test'} onClick={test}>
            <Icon name="send" />
            Test senden
          </Button>
          {channelStored(view) && (
            <Button type="button" variant="danger" disabled={busy !== ''} onClick={() => setConfirm(true)}>
              Entfernen
            </Button>
          )}
        </div>
      </form>
      <ConfirmDialog
        open={confirm}
        title={`${view.name} entfernen?`}
        cancelLabel="Behalten"
        confirmLabel="Entfernen bestätigen"
        danger
        busy={busy === 'remove'}
        onCancel={() => setConfirm(false)}
        onConfirm={remove}
      >
        <p>Der Kanal wird ausgeschaltet; seine Angaben und Zugangsdaten werden gelöscht.</p>
        {error && <Notice error>{error}</Notice>}
      </ConfirmDialog>
    </>
  );
}

/**
 * Benachrichtigungen (0.9.0): one tab per built-in channel, like Key-Shops. Several channels can be active at once; an alert
 * goes to every active one. Secrets are write-only (GET /alerts/channels only says whether one is stored).
 */
export default function Notifications() {
  const [channels, setChannels] = useState<ChannelView[] | null>(null);
  const [failed, setFailed] = useState('');
  const [open, setOpen] = useState('');
  const [revision, setRevision] = useState(0);
  usePolled<{ channels: ChannelView[] }>('/alerts/channels', {
    restart: [revision],
    onData: data => {
      setChannels(data.channels);
      setFailed('');
    },
    onError: error => {
      if (!sessionEnded(error)) setFailed(error instanceof Error ? error.message : 'Kanäle konnten nicht geladen werden.');
    },
  });
  const replace = useCallback((next: ChannelView) => setChannels(current => current?.map(c => (c.kind === next.kind ? next : c)) ?? null), []);
  const active = channels?.filter(c => c.active).map(c => c.name) ?? [];
  const current = channels?.some(c => c.kind === open) ? open : ((channels?.find(c => c.active) ?? channels?.[0])?.kind ?? '');
  const aside = (
    <>
      {channels && (
        <Pill tone={active.length ? 'ok' : 'dim'} icon={active.length ? 'check' : 'minus'}>
          {active.length ? `Aktiv: ${active.join(', ')}` : 'Kein Kanal aktiv'}
        </Pill>
      )}
      <Help label="Hilfe zu Benachrichtigungen">
        <span>Ein Preisalarm geht an jeden aktiven Kanal, höchstens einmal je Spiel und 24 Stunden. Der Preis wird vor dem Versand erneut geprüft.</span>
        <span>„Test senden“ schickt sofort eine Testnachricht über diesen einen Kanal. Alarmregeln legst du im Detail eines Spiels an.</span>
      </Help>
    </>
  );
  return (
    <SettingsPanel
      title="Kanäle"
      titleId="channels-title"
      aside={aside}
      tools={
        channels && (
          <Seg
            tabs="channels"
            label="Benachrichtigungskanäle"
            wrap
            value={current}
            onChange={setOpen}
            options={channels.map(c => ({ value: c.kind, label: c.active ? c.name : `${c.name} · aus` }))}
          />
        )
      }
    >
      {failed && (
        <Notice error>
          {failed}{' '}
          <Button size="sm" onClick={() => setRevision(n => n + 1)}>
            Erneut laden
          </Button>
        </Notice>
      )}
      {!channels
        ? !failed && (
            <p className="hint" role="status">
              Kanäle werden geladen …
            </p>
          )
        : channels.map(c => (
            <TabPanel key={c.kind} id="channels" tab={c.kind} value={current}>
              <ChannelForm view={c} onChange={replace} />
            </TabPanel>
          ))}
    </SettingsPanel>
  );
}
