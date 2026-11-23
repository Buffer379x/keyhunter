import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clearWishlist, prepareLayout, settle } from './layout-mocks';
import { navTo, signInToFixture } from './helpers';
import { backToList, wishlistHeading, wishlistRows } from './detail-helpers';

// Release 1.1: the warning triangle after a title (unreviewed mappings) leads straight to the Zuordnungen tab (PROD-03).
// The layout mocks give the real Forza Horizon 5 wish one mapping to review.

test.afterEach(async ({ page }) => clearWishlist(page));

const REVIEW = '1 ungeprüfte Zuordnung von Forza Horizon 5 prüfen';
const forzaRow = (page: Page) => wishlistRows(page).filter({ hasText: 'Forza Horizon 5' }).first();

/** The game page shows the Zuordnungen tab, and the URL names it like a tab opened by hand. */
async function expectReviewTab(page: Page, id: string) {
  await expect(page).toHaveURL(new RegExp(`[?&]item=${id}&tab=zuordnungen$`));
  await expect(page.getByRole('tab', { name: /^Zuordnungen/ })).toHaveAttribute('aria-selected', 'true');
}

test.describe('desktop, 1366 px', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('PROD-03: a click on the warning triangle opens the Zuordnungen tab, back returns to the list', async ({ page }) => {
    const id = await prepareLayout(page);
    await page.goto('/');
    const triangle = forzaRow(page).getByRole('button', { name: REVIEW, exact: true });
    await expect(triangle).toHaveAttribute('title', /unter Zuordnungen$/);
    await triangle.click();
    await expectReviewTab(page, id);
    await page.goBack();
    await expect(page).not.toHaveURL(/[?&]item=/);
    await expect(wishlistHeading(page)).toBeVisible();
    // Keyboard: Enter on the focused triangle does the same.
    await forzaRow(page).getByRole('button', { name: REVIEW, exact: true }).focus();
    await page.keyboard.press('Enter');
    await expectReviewTab(page, id);
    await backToList(page);
    await expect(page).not.toHaveURL(/[?&]item=/);
  });

  test('PROD-03: the triangle in the cart opens the Zuordnungen tab too', async ({ page }) => {
    const id = await prepareLayout(page);
    await page.route('**/api/v1/cart', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const entries = await response.json();
      await route.fulfill({ response, json: entries.map((entry: object) => ({ ...entry, review_count: 1 })) });
    });
    await page.goto('/');
    const { csrf_token: csrf } = await (await page.request.get('/api/v1/me')).json();
    const added = await page.request.post('/api/v1/cart', { data: { wish_id: id }, headers: { 'X-CSRF-Token': csrf, Origin: new URL(page.url()).origin } });
    expect(added.status()).toBe(201);
    await navTo(page, 'Warenkorb');
    const table = page.getByRole('table', { name: 'Spiele im Warenkorb', exact: true });
    await table.getByRole('button', { name: REVIEW, exact: true }).click();
    await expectReviewTab(page, id);
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Warenkorb', level: 1 })).toBeVisible();
  });
});

test.describe('phone, 375 px', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('PROD-03: a tap on the triangle of a card opens the Zuordnungen tab, not the plain card, and keeps the card layout', async ({ page }) => {
    const id = await prepareLayout(page);
    await page.goto('/');
    const card = forzaRow(page);
    await card.scrollIntoViewIfNeeded();
    await settle(page);
    const triangle = card.getByRole('button', { name: REVIEW, exact: true });
    const box = (await triangle.boundingBox())!;
    // 44 px to hit with a finger, while the title line keeps the height of its text (the hit area does not push the layout).
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    expect((await card.locator('.game-title').boundingBox())!.height).toBeLessThan(30);
    // The triangle lies above the opener that covers the card, even a little beside the symbol.
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') ?? '',
      [box.x + box.width / 2 + 14, box.y + box.height / 2 + 14],
    );
    expect(hit).toBe(REVIEW);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expectReviewTab(page, id);
    await page.goBack(); // the phone has no breadcrumb: the back gesture of the browser
    await expect(page).not.toHaveURL(/[?&]item=/);
    await expect(card).toBeVisible();
    // A tap elsewhere on the card still opens the game on its first tab.
    const price = (await card.locator('td.c-world').boundingBox())!;
    await page.touchscreen.tap(price.x + 10, price.y + 6);
    await expect(page).toHaveURL(new RegExp(`[?&]item=${id}$`));
  });
});

// 1.1: on the phone card of "Letzte Zustellungen" the long channel line made the status column so wide that the title
// slid under the "Zugestellt" pill. Title and pill must never overlap.
for (const width of [390, 320]) {
  test.describe(`alerts, ${width} px`, () => {
    test.use({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });

    test('the title of a delivery card never lies under its status pill', async ({ page }) => {
      await signInToFixture(page);
      await page.route('**/api/v1/alerts', route =>
        route.request().method() !== 'GET'
          ? route.continue()
          : route.fulfill({
              json: {
                configured: true,
                channels: ['Telegram', 'E-Mail'],
                rules: [],
                events: [
                  {
                    id: 1,
                    wish_id: null,
                    state: 'sent',
                    observed_at: 1795107000,
                    sent_at: 1795107060,
                    cents: 1290,
                    attempts: 3,
                    deliveries: [
                      { channel: 'telegram', name: 'Telegram', state: 'sent', attempts: 1, error: null },
                      { channel: 'email', name: 'E-Mail', state: 'failed', attempts: 3, error: 'SMTP: permanent error (535)' },
                    ],
                  },
                ],
              },
            }),
      );
      await page.goto('/?view=alerts');
      const card = page.getByRole('table', { name: 'Letzte Zustellungen' }).locator('tbody tr').first();
      await expect(card.locator('.delivery-channels')).toBeVisible();
      const boxes = await card.evaluate(row => {
        // The rendered text of the title, not its cell: the cell can shrink to nothing while the text overflows it.
        const range = document.createRange();
        range.selectNodeContents(row.querySelector('.c-game')!);
        const box = (r: DOMRect) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
        return {
          title: box(range.getBoundingClientRect()),
          pill: box(row.querySelector('.c-status .pill')!.getBoundingClientRect()),
          card: box(row.getBoundingClientRect()),
        };
      });
      const { title, pill, card: frame } = boxes;
      const overlap =
        Math.min(title.right, pill.right) > Math.max(title.left, pill.left) && Math.min(title.bottom, pill.bottom) > Math.max(title.top, pill.top);
      expect(overlap, `title ${JSON.stringify(title)} / pill ${JSON.stringify(pill)}`).toBe(false);
      expect(title.right).toBeLessThanOrEqual(frame.right);
    });
  });
}
