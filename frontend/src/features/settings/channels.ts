import type { ChannelKind, ChannelView } from '../../api.ts';

/** One input of a channel form; `secret` fields are write-only (password input, never prefilled). */
export interface ChannelField {
  key: string; label: string; secret?: boolean; optional?: boolean; placeholder?: string;
  /** Prefilled while nothing is saved. */
  initial?: string;
  options?: { value: string; label: string }[];
  inputMode?: 'numeric' | 'email' | 'url';
}

const url = (key: string, label: string, placeholder: string, secret = true): ChannelField => ({ key, label, secret, placeholder, inputMode: 'url' });

/** Fields per channel, in form order (backend: notify::Kind::keys). */
export const channelFields: Record<ChannelKind, ChannelField[]> = {
  ntfy: [url('url', 'Topic-URL', 'https://ntfy.sh/mein-geheimes-topic'), { key: 'token', label: 'Zugangstoken (optional)', secret: true, optional: true }],
  telegram: [{ key: 'bot_token', label: 'Bot-Token', secret: true, placeholder: '123456789:AAE…' }, { key: 'chat_id', label: 'Chat-ID', placeholder: '123456789' }],
  discord: [url('webhook_url', 'Webhook-URL', 'https://discord.com/api/webhooks/…')],
  email: [
    { key: 'host', label: 'SMTP-Server', placeholder: 'smtp.example.org' },
    { key: 'port', label: 'Port', initial: '587', inputMode: 'numeric' },
    { key: 'security', label: 'Verschlüsselung', initial: 'starttls', options: [
      { value: 'starttls', label: 'STARTTLS (meist Port 587)' }, { value: 'tls', label: 'TLS (meist Port 465)' }, { value: 'none', label: 'Unverschlüsselt (nur lokales Netz)' },
    ] },
    { key: 'username', label: 'Benutzername (optional)', optional: true },
    { key: 'password', label: 'Passwort (optional)', secret: true, optional: true },
    { key: 'from', label: 'Absender', placeholder: 'KeyHunter <keyhunter@example.org>', inputMode: 'email' },
    { key: 'to', label: 'Empfänger', placeholder: 'du@example.org', inputMode: 'email' },
  ],
  gotify: [url('url', 'Server-Adresse', 'https://gotify.example.org', false), { key: 'token', label: 'App-Token', secret: true }],
  pushover: [{ key: 'user', label: 'User Key', secret: true }, { key: 'token', label: 'API-Token', secret: true }],
  webhook: [url('url', 'Webhook-URL', 'https://example.org/keyhunter'), { key: 'token', label: 'Bearer-Token (optional)', secret: true, optional: true }],
};

/** Setup in two or three sentences, behind the help symbol of each channel. */
export const channelHelp: Record<ChannelKind, string[]> = {
  ntfy: ['Installiere die ntfy-App, abonniere ein schwer zu erratendes Topic und trage hier seine volle Adresse ein, z. B. https://ntfy.sh/keyhunter-x7f3.',
    'Ein Zugangstoken brauchst du nur für geschützte Topics. Eine vorhandene /config/ntfy.env gilt weiter, bis du hier eine Adresse speicherst.'],
  telegram: ['Lege im Chat mit @BotFather über /newbot einen Bot an und kopiere den Token. Schreibe deinem Bot einmal eine Nachricht.',
    'Deine Chat-ID nennt dir z. B. @userinfobot; Gruppen haben eine negative ID. Die Nachricht kommt als Chat vom Bot, mit Link zum Angebot.'],
  discord: ['Öffne in Discord die Kanaleinstellungen › Integrationen › Webhooks, lege einen Webhook an und kopiere die Webhook-URL.',
    'Die Nachricht erscheint im Kanal als Karte mit anklickbarem Titel.'],
  email: ['Trage den SMTP-Server deines Mail-Anbieters ein: meist Port 587 mit STARTTLS oder 465 mit TLS. Bei Gmail, GMX, Web.de & Co. brauchst du oft ein App-Passwort.',
    'Unverschlüsselt geht nur an einen Mailserver im lokalen Netz und ohne Passwort.'],
  gotify: ['Lege in deinem Gotify-Server unter „Apps“ eine Anwendung an und kopiere ihren Token. Die Server-Adresse ist die Basis-URL, z. B. http://192.168.1.10:8080.',
    'Die Gotify-App zeigt die Nachricht als Push; ein Tipp öffnet das Angebot.'],
  pushover: ['Den User Key siehst du nach der Anmeldung auf pushover.net; den API-Token bekommst du, wenn du dort eine Anwendung anlegst.',
    'Pushover kostet nach der Testphase einmalig je Plattform.'],
  webhook: ['KeyHunter schickt jeden Alarm als JSON-POST an diese Adresse, z. B. an Home Assistant, n8n oder Node-RED. Ein Token geht als „Authorization: Bearer“ mit.',
    'Die Felder stehen in docs/notifications.md.'],
};

export const SECRET_SAVED = 'gespeichert · zum Ändern neu eingeben';

/** Form values of a saved channel: visible settings (or their initial value), secrets always empty. */
export function channelValues(view: ChannelView): Record<string, string> {
  return Object.fromEntries(channelFields[view.kind].map(field => [field.key, field.secret ? '' : view.settings[field.key] || field.initial || '']));
}

/** True when the form differs from the saved channel. */
export function channelDirty(view: ChannelView, values: Record<string, string>): boolean {
  const saved = channelValues(view);
  return channelFields[view.kind].some(field => (values[field.key] ?? '').trim() !== (field.secret ? '' : (saved[field.key] ?? '').trim()));
}

/**
 * Body of PUT /alerts/channels/{kind}: every visible setting, and only the secrets that were typed (an empty secret keeps
 * the stored one). A channel saved for the first time is switched on.
 */
export function channelBody(view: ChannelView, values: Record<string, string>, enabled: boolean) {
  const fields = channelFields[view.kind];
  return {
    enabled: view.configured ? enabled : true,
    settings: Object.fromEntries(fields.filter(f => !f.secret).map(f => [f.key, (values[f.key] ?? '').trim()])),
    secrets: Object.fromEntries(fields.filter(f => f.secret && (values[f.key] ?? '').trim() !== '').map(f => [f.key, values[f.key].trim()])),
  };
}

/** Something is stored that "Entfernen" would forget. */
export const channelStored = (view: ChannelView) => Object.values(view.secrets).some(Boolean) || Object.values(view.settings).some(v => v !== '');

/** "Kanal: Telegram, E-Mail" or the hint that none is set up. */
export const channelLine = (names: string[]) => names.length ? `Kanal: ${names.join(', ')}` : 'Kein Kanal eingerichtet';
