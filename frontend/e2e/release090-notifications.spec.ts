import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { navItem, navTo, signInToFixture } from './helpers';

/** A write to the API as the page would send it (origin and CSRF token). */
async function write(page: Page, method: 'DELETE', path: string) {
  const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
  return page.request.fetch(path, { method, headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } });
}

type Hit = { path: string; auth: string; body: Record<string, unknown> };
/** Local webhook receiver on 127.0.0.1 (the backend runs on the same host); never a real service. */
async function receiver(status: () => number) {
  const hits: Hit[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      hits.push({ path: request.url ?? '', auth: request.headers.authorization ?? '', body: JSON.parse(body || '{}') });
      response.statusCode = status();
      response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/keyhunter`, hits, close: () => new Promise(resolve => server.close(resolve)) };
}

const TOKEN = 'e2e-hook-token-4711';
const channels = (page: Page) => page.getByRole('region', { name: 'Kanäle', exact: true });
const channelTabs = (page: Page) => channels(page).getByRole('tablist', { name: 'Benachrichtigungskanäle', exact: true });

test.afterEach(async ({ page }) => {
  await write(page, 'DELETE', '/api/v1/alerts/channels/webhook');
});

test('a webhook channel is saved, tested against a local receiver and never shows its secrets again', async ({ page }) => {
  let status = 204;
  const hook = await receiver(() => status);
  try {
    await signInToFixture(page);
    await navTo(page, 'Benachrichtigungen');
    const panel = channels(page);
    await expect(channelTabs(page).getByRole('tab')).toHaveText(['ntfy · aus', 'Telegram · aus', 'Discord · aus', 'E-Mail · aus', 'Gotify · aus', 'Pushover · aus', 'Webhook · aus']);
    await expect(panel.getByText('Kein Kanal aktiv', { exact: true })).toBeVisible();
    await channelTabs(page).getByRole('tab', { name: 'Webhook · aus', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Hilfe zu Webhook', exact: true })).toBeVisible();
    const url = panel.getByLabel('Webhook-URL', { exact: true });
    const token = panel.getByLabel('Bearer-Token (optional)', { exact: true });
    await expect(url).toHaveAttribute('type', 'password');
    await expect(panel.getByRole('button', { name: 'Test senden' })).toBeDisabled();
    await url.fill(hook.url);
    await token.fill(TOKEN);
    const saved = page.waitForResponse(r => r.url().endsWith('/api/v1/alerts/channels/webhook') && r.request().method() === 'PUT');
    await panel.getByRole('button', { name: 'Speichern', exact: true }).click();
    const answer = await (await saved).text();
    expect(answer).not.toContain(TOKEN);
    expect(answer).not.toContain(hook.url);
    // 0.9.1: results are popups at the bottom right.
    await expect(page.locator('.toast-pop').filter({ hasText: 'Webhook ist gespeichert und aktiv.' })).toBeVisible();
    // The secret fields stay empty and only say that something is stored.
    for (const field of [url, token]) {
      await expect(field).toHaveValue('');
      await expect(field).toHaveAttribute('placeholder', 'gespeichert · zum Ändern neu eingeben');
    }
    await expect(panel.getByText('Aktiv: Webhook', { exact: true })).toBeVisible();
    await expect(channelTabs(page).getByRole('tab', { name: 'Webhook', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(panel.getByRole('switch', { name: 'Webhook Aktiv' })).toBeChecked();

    await panel.getByRole('button', { name: 'Test senden' }).click();
    await expect(page.locator('.toast-pop').filter({ hasText: 'Testnachricht über Webhook gesendet.' })).toBeVisible();
    expect(hook.hits).toHaveLength(1);
    expect(hook.hits[0]).toMatchObject({ path: '/keyhunter', auth: `Bearer ${TOKEN}`, body: { event: 'test', title: 'KeyHunter: Testnachricht' } });
    status = 500;
    await panel.getByRole('button', { name: 'Test senden' }).click();
    await expect(page.locator('.toast-pop.error')).toHaveText('Testnachricht über Webhook fehlgeschlagen: HTTP 500 · Internal Server Error');

    // After a reload the page knows the channel but not its secrets.
    const listed = await (await page.request.get('/api/v1/alerts/channels')).text();
    expect(listed).not.toContain(TOKEN);
    expect(listed).not.toContain(hook.url);
    await page.reload();
    await channelTabs(page).getByRole('tab', { name: 'Webhook', exact: true }).click();
    await expect(channels(page).getByLabel('Webhook-URL', { exact: true })).toHaveValue('');
    await expect(channels(page).getByLabel('Webhook-URL', { exact: true })).toHaveAttribute('placeholder', 'gespeichert · zum Ändern neu eingeben');

    // Preisalarme names the active channel.
    await navTo(page, 'Preisalarme');
    await expect(page.getByText('Kanal: Webhook', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Testnachricht senden' })).toBeEnabled();

    // Switching off keeps the settings; removing forgets them.
    await navTo(page, 'Benachrichtigungen');
    await channelTabs(page).getByRole('tab', { name: 'Webhook', exact: true }).click();
    // The switch saves at once and follows the confirmed state.
    await channels(page).getByRole('switch', { name: 'Webhook Aktiv' }).click();
    await expect(page.locator('.toast-pop').filter({ hasText: 'Webhook ist ausgeschaltet.' })).toBeVisible();
    await expect(channels(page).getByRole('switch', { name: 'Webhook Aktiv' })).not.toBeChecked();
    await expect(channelTabs(page).getByRole('tab', { name: 'Webhook · aus', exact: true })).toBeVisible();
    await channels(page).getByRole('button', { name: 'Entfernen', exact: true }).click();
    await page.getByRole('dialog', { name: 'Webhook entfernen?' }).getByRole('button', { name: 'Entfernen bestätigen' }).click();
    await expect(page.locator('.toast-pop').filter({ hasText: 'Webhook ist entfernt.' })).toBeVisible();
    await expect(channels(page).getByLabel('Webhook-URL', { exact: true })).toHaveAttribute('placeholder', 'https://example.org/keyhunter');
  } finally {
    await hook.close();
  }
});

test('invalid addresses are refused with a reason and nothing is stored', async ({ page }) => {
  await signInToFixture(page);
  await navTo(page, 'Benachrichtigungen');
  await channelTabs(page).getByRole('tab', { name: 'Webhook · aus', exact: true }).click();
  const panel = channels(page);
  await panel.getByLabel('Webhook-URL', { exact: true }).fill('http://hooks.example.org/kh');
  await panel.getByLabel('Bearer-Token (optional)', { exact: true }).fill(TOKEN);
  await panel.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(page.locator('.toast-pop.error')).toHaveText('Über http gehen Zugangsdaten nur an Server im lokalen Netz. Verwende eine https-Adresse.');
  expect(await (await page.request.get('/api/v1/alerts/channels')).text()).not.toContain(TOKEN);
});

test('without a channel the alarm page says so and leads to the notification settings', async ({ page }) => {
  await signInToFixture(page);
  await navTo(page, 'Preisalarme');
  await expect(page.getByText('Kein Kanal eingerichtet', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Testnachricht senden' })).toBeDisabled();
  await page.getByRole('link', { name: 'Kanal einrichten' }).click();
  await expect(page).toHaveURL(/view=settings&section=notifications/);
  await expect(navItem(page, 'Benachrichtigungen')).toHaveAttribute('aria-selected', 'true');
  await expect(channels(page)).toBeVisible();
});

test('the delivery log names every channel and the reason of a failure', async ({ page }) => {
  await signInToFixture(page);
  await page.route('**/api/v1/alerts', route => route.request().method() !== 'GET' ? route.continue() : route.fulfill({ json: {
    configured: true, channels: ['Telegram', 'E-Mail'], rules: [],
    events: [{ id: 1, wish_id: null, state: 'sent', observed_at: 1795107000, sent_at: 1795107060, cents: null, attempts: 3, deliveries: [
      { channel: 'telegram', name: 'Telegram', state: 'sent', attempts: 1, error: null },
      { channel: 'email', name: 'E-Mail', state: 'failed', attempts: 3, error: 'SMTP: permanent error (535)' },
    ] }],
  } }));
  await navTo(page, 'Preisalarme');
  await expect(page.getByText('Kanal: Telegram, E-Mail', { exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Letzte Zustellungen' }).locator('.delivery-channels'))
    .toHaveText('Telegram zugestellt · E-Mail fehlgeschlagen (SMTP: permanent error (535))');
});
