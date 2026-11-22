import test from 'node:test';
import assert from 'node:assert/strict';
import { channelBody, channelDirty, channelFields, channelLine, channelStored, channelValues } from '../src/features/settings/channels.ts';
import type { ChannelView } from '../src/api.ts';

const view = (patch: Partial<ChannelView> = {}): ChannelView => ({
  kind: 'telegram', name: 'Telegram', enabled: false, configured: false, active: false, from_file: false,
  settings: { chat_id: '' }, secrets: { bot_token: false }, ...patch,
});

test('secret fields start empty and only typed secrets are sent', () => {
  const saved = view({ configured: true, enabled: true, settings: { chat_id: '4711' }, secrets: { bot_token: true } });
  assert.deepEqual(channelValues(saved), { bot_token: '', chat_id: '4711' });
  assert.equal(channelDirty(saved, channelValues(saved)), false);
  assert.deepEqual(channelBody(saved, { bot_token: '', chat_id: ' 4712 ' }, false), { enabled: false, settings: { chat_id: '4712' }, secrets: {} });
  assert.equal(channelDirty(saved, { bot_token: '1:abc', chat_id: '4711' }), true);
  assert.deepEqual(channelBody(saved, { bot_token: ' 1:abc ', chat_id: '4711' }, true).secrets, { bot_token: '1:abc' });
});

test('a channel saved for the first time is switched on', () => {
  assert.equal(channelBody(view(), { bot_token: 'x', chat_id: '1' }, false).enabled, true);
});

test('e-mail starts with port 587 and STARTTLS', () => {
  const email = view({ kind: 'email', name: 'E-Mail', settings: { host: '', port: '', security: '', username: '', from: '', to: '' }, secrets: { password: false } });
  const values = channelValues(email);
  assert.equal(values.port, '587');
  assert.equal(values.security, 'starttls');
  assert.equal(channelFields.email.find(f => f.key === 'password')?.secret, true);
});

test('stored values and the channel line', () => {
  assert.equal(channelStored(view()), false);
  assert.equal(channelStored(view({ secrets: { bot_token: true } })), true);
  assert.equal(channelLine(['Telegram', 'E-Mail']), 'Kanal: Telegram, E-Mail');
  assert.equal(channelLine([]), 'Kein Kanal eingerichtet');
});
