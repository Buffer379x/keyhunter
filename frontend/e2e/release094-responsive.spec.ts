import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { WISHES, clearWishlist, prepareLayout, settle } from './layout-mocks';

// Release 1.0 layout (design preview, RESP and DS findings of the audit): no table or page wider than its box, every row
// action in view, 44 px touch targets with a coarse pointer, tab bars that show the active tab, popovers inside the window.
// The measurements of the preview, kept as tests. Phones and the tablet emulate touch (pointer: coarse), desktops a mouse.

test.afterEach(async ({ page }) => clearWishlist(page));

/** Overflow, small touch targets and row actions outside the visible part of their table; runs in the page. */
function probe(page: Page, actions: string) {
  return page.evaluate(actions => {
    const visible = (el: Element) => (el as HTMLElement).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const main = document.getElementById('main-content')!;
    const wraps = [...document.querySelectorAll('#main-content .table-wrap')]
      .filter(visible)
      .filter(el => el.scrollWidth > el.clientWidth + 1)
      .map(el => `${el.className}: ${el.scrollWidth}/${el.clientWidth}`);
    // Interactive elements; a control inside a label box (.field, .switch) or the top search counts as that box, which is what a finger hits.
    // Left out: the skip link (only shown on keyboard focus), visually hidden text and decorative (aria-hidden) controls.
    const targets = new Map<Element, DOMRect>();
    for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, summary, [role=tab]')) {
      if (!visible(el) || el.closest('.sr-only, .skip-link, [aria-hidden="true"]')) continue;
      const box =
        el.closest('label.field, label.switch, .search-box') ?? (el.matches('input[type=checkbox], input[type=radio]') ? el.closest('label') : null) ?? el;
      const rect = box.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) targets.set(box, rect);
    }
    const small = [...targets]
      .filter(([, r]) => Math.min(r.width, r.height) < 43.5)
      .map(
        ([el, r]) =>
          `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`,
      );
    const out = [...document.querySelectorAll(actions)].filter(visible).filter(el => {
      const r = el.getBoundingClientRect();
      const w = el.closest('.table-wrap')!.getBoundingClientRect();
      return r.left < Math.max(0, w.left) - 0.5 || r.right > Math.min(innerWidth, w.right) + 0.5;
    });
    return {
      coarse: matchMedia('(pointer: coarse)').matches,
      page: `${document.documentElement.scrollWidth}/${innerWidth}`,
      main: `${main.scrollWidth}/${main.clientWidth}`,
      wraps,
      small,
      actions: document.querySelectorAll(actions).length,
      actionsOut: out.length,
    };
  }, actions);
}

/** Every layout check that holds at any width: nothing wider than its box, every action in view, touch targets on touch. */
function expectFits(m: Awaited<ReturnType<typeof probe>>, touch: boolean) {
  const [pageWidth, viewport] = m.page.split('/').map(Number);
  expect(pageWidth, 'page overflow').toBeLessThanOrEqual(viewport);
  const [mainScroll, mainBox] = m.main.split('/').map(Number);
  expect(mainScroll, 'main overflow').toBeLessThanOrEqual(mainBox);
  expect(m.wraps, 'tables wider than their box').toEqual([]);
  expect(m.actionsOut, 'row actions out of view').toBe(0);
  expect(m.coarse).toBe(touch);
  if (touch) expect(m.small, 'touch targets under 44 px').toEqual([]);
}

const viewports = [
  { name: '375', width: 375, height: 812, touch: true, cards: true, offerCards: true },
  { name: '430', width: 430, height: 932, touch: true, cards: true, offerCards: true },
  { name: '768', width: 768, height: 1024, touch: true, cards: true, offerCards: true },
  { name: '1024', width: 1024, height: 768, touch: false, cards: true, offerCards: true },
  { name: '1366', width: 1366, height: 768, touch: false, cards: false, offerCards: false },
];

for (const vp of viewports) {
  test.describe(`at ${vp.name} px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, isMobile: vp.touch && vp.width < 500 });

    test('RESP-01 / RESP-03 / RESP-09: the wishlist fits its box, every row opens, touch targets are 44 px', async ({ page }) => {
      await prepareLayout(page);
      await page.goto('/');
      const rows = page.locator('table.wl tbody tr');
      await expect(rows).toHaveCount(WISHES);
      await settle(page);
      const m = await probe(page, 'table.wl tbody tr :is(.row-open, .title-open, .cover-open)');
      expectFits(m, vp.touch);
      expect(m.actions).toBe(WISHES);
      // Cards where the full table does not fit (the list's own width decides, not the window's).
      expect(await rows.first().evaluate(row => getComputedStyle(row).display !== 'table-row')).toBe(vp.cards);
      if (!vp.cards) return;
      const cards = await page.evaluate(() => {
        const list = [...document.querySelectorAll('table.wl tbody tr')];
        let overlaps = 0;
        for (const row of list) {
          const boxes = [...row.querySelectorAll('td > *')].map(el => el.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
          for (let i = 0; i < boxes.length; i++)
            for (let j = i + 1; j < boxes.length; j++) {
              const a = boxes[i],
                b = boxes[j];
              if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) overlaps++;
            }
        }
        return { title: Math.min(...list.map(row => row.querySelector('.game-name')!.getBoundingClientRect().width)), overlaps };
      });
      expect(cards.title, 'the title keeps its room on the card').toBeGreaterThan(150);
      expect(cards.overlaps, 'overlapping texts on a card').toBe(0);
      // The prices carry their label on the card.
      await expect(rows.first().locator('td.c-world')).toHaveAttribute('data-label', 'Preis INT');
    });

    test('RESP-02 / RESP-09: the offers fit their box with every "Zum Shop" and cart button in view', async ({ page }) => {
      const id = await prepareLayout(page);
      await page.goto(`/?item=${id}&tab=angebote`);
      const rows = page.locator('table.offers tbody tr');
      await expect(rows).toHaveCount(12); // two sellers on one link: two rows
      await settle(page);
      const m = await probe(page, 'table.offers tbody :is(a.btn, .offer-cart)');
      expectFits(m, vp.touch);
      expect(m.actions).toBeGreaterThan(12);
      expect(await rows.first().evaluate(row => getComputedStyle(row).display !== 'table-row')).toBe(vp.offerCards);
    });
  });
}

test.describe('phone, 375 px', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('RESP-04 / RESP-05: detail tabs keep the page width and scroll the active tab into view', async ({ page }) => {
    const id = await prepareLayout(page);
    for (const tab of ['', 'verlauf', 'alarm', 'infos']) {
      await page.goto(`/?item=${id}${tab ? `&tab=${tab}` : ''}`);
      const list = page.getByRole('tablist', { name: 'Spieldetails', exact: true });
      await expect(list.locator('[aria-selected="true"]')).toBeVisible();
      await settle(page);
      const m = await list.evaluate(el => {
        const main = document.getElementById('main-content')!;
        const box = el.getBoundingClientRect(),
          on = el.querySelector('[aria-selected="true"]')!.getBoundingClientRect();
        return {
          main: main.scrollWidth - main.clientWidth,
          inView: on.left >= box.left - 0.5 && on.right <= box.right + 0.5,
          hints: [...document.querySelectorAll('.tabs-more')].filter(hint => (hint as HTMLElement).checkVisibility()).length,
        };
      });
      expect(m, `tab ${tab || 'preis'}`).toEqual({ main: 0, inView: true, hints: expect.any(Number) });
      expect(m.hints, 'a chevron marks the hidden tabs').toBeGreaterThan(0);
    }
  });

  test('RESP-05: settings tabs scroll the active tab into view', async ({ page }) => {
    await prepareLayout(page);
    for (const section of ['status', 'system']) {
      await page.goto(`/?view=settings&section=${section}`);
      const list = page.getByRole('tablist', { name: 'Einstellungen', exact: true });
      await expect(list.locator('[aria-selected="true"]')).toBeVisible();
      await settle(page);
      const inView = await list.evaluate(el => {
        const box = el.getBoundingClientRect(),
          on = el.querySelector('[aria-selected="true"]')!.getBoundingClientRect();
        return on.left >= box.left - 0.5 && on.right <= box.right + 0.5;
      });
      expect(inView, section).toBe(true);
    }
  });

  test('RESP-06: the pause menu stays inside the window', async ({ page }) => {
    const id = await prepareLayout(page);
    await page.goto(`/?item=${id}`);
    await page.getByRole('button', { name: 'Abfragen pausieren', exact: true }).click();
    const menu = page.locator('.pause-menu');
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(375 - 8);
  });

  test('RESP-07: the head of the search popup wraps instead of scrolling sideways', async ({ page }) => {
    await prepareLayout(page);
    await page.getByRole('searchbox', { name: 'Nach Spielen suchen', exact: true }).fill('forza');
    const pop = page.getByRole('region', { name: 'Suchergebnisse' });
    await expect(pop.getByRole('button', { name: /Forza Horizon 5 \(Xbox One\)/ })).toBeVisible();
    const m = await pop.evaluate(el => {
      const box = el.getBoundingClientRect(),
        close = el.querySelector('.search-pop-head .icon-btn')!.getBoundingClientRect();
      return { overflow: el.scrollWidth - el.clientWidth, closeTopRight: close.right >= box.right - 16 && close.top - box.top < 16 };
    });
    expect(m).toEqual({ overflow: 0, closeTopRight: true });
  });

  test('RESP-01: a tap anywhere on a wishlist card opens the game, keyboard focus rings the whole card', async ({ page }) => {
    await prepareLayout(page);
    await page.goto('/');
    const card = page.locator('table.wl tbody tr').first();
    await card.scrollIntoViewIfNeeded();
    const price = (await card.locator('td.c-world').boundingBox())!;
    // The opener is stretched over the card: it lies on top of the price label, far from the details button.
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className ?? '', [price.x + 10, price.y + 6])).toContain('row-open');
    await page.touchscreen.tap(price.x + 10, price.y + 6);
    await expect(page).toHaveURL(/[?&]item=/);
    await page.goBack();
    await expect(card).toBeVisible();
    await page.keyboard.press('Tab'); // keyboard modality, so the focus is :focus-visible
    await card.getByRole('button', { name: /^Details zu / }).focus();
    expect(await card.evaluate(row => getComputedStyle(row).outlineStyle)).toBe('solid');
  });
});

test.describe('desktop, 1366 px', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('RESP-02: the actions column sticks to the right edge of a table that still scrolls', async ({ page }) => {
    const id = await prepareLayout(page);
    await page.goto(`/?item=${id}&tab=angebote`);
    await expect(page.locator('table.offers tbody tr').first()).toBeVisible();
    // A custom column order with a very long seller can still make the table wider than its box.
    await page
      .locator('table.offers td.c-shop')
      .first()
      .evaluate(el => ((el as HTMLElement).style.minWidth = '700px'));
    expect(await page.locator('.offers-wrap').evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(100);
    const m = await probe(page, 'table.offers tbody :is(a.btn, .offer-cart)');
    expect(m.actionsOut).toBe(0);
  });

  test('RESP-01: on the desktop table only the opener opens the game, not the row', async ({ page }) => {
    await prepareLayout(page);
    await page.goto('/');
    const row = page.locator('table.wl tbody tr').first();
    await row.locator('td.c-world').click();
    await expect(page).not.toHaveURL(/[?&]item=/);
    await row.getByRole('button', { name: /^Details zu / }).click();
    await expect(page).toHaveURL(/[?&]item=/);
  });

  test('DS-02 / DS-03: contrast tokens, table heads in --muted and the focus ring of text fields', async ({ page }) => {
    await prepareLayout(page);
    await page.goto('/');
    const tokens = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return { muted: style.getPropertyValue('--muted').trim(), faint: style.getPropertyValue('--faint').trim() };
    });
    expect(tokens).toEqual({ muted: '#99938c', faint: '#7d7770' });
    // No text in --faint (decoration and disabled controls only): the table heads are --muted.
    expect(
      await page
        .locator('table.wl th')
        .first()
        .evaluate(th => getComputedStyle(th).color),
    ).toBe('rgb(153, 147, 140)');
    for (const name of ['Liste filtern', 'Nach Spielen suchen']) {
      const input = page.getByRole('searchbox', { name, exact: true });
      await input.focus();
      const ring = await input.evaluate(el => {
        const style = getComputedStyle(el.closest('.field, .search-box')!);
        return `${style.outlineStyle} ${style.outlineWidth}`;
      });
      expect(ring, name).toBe('solid 2px');
      await input.blur();
    }
  });
});

test('DS-01: the favicon links name the ICO and the optical 16 and 32 px PNGs, no SVG master', async ({ page }) => {
  await page.route(
    url => !['127.0.0.1', 'localhost'].includes(url.hostname),
    route => route.abort(),
  );
  await page.goto('/');
  const links = await page.locator('link[rel="icon"]').evaluateAll(list => list.map(link => `${link.getAttribute('href')} ${link.getAttribute('sizes')}`));
  expect(links).toEqual(['/favicon.ico 16x16 32x32', '/favicon-16.png 16x16', '/favicon-32.png 32x32']);
  for (const [path, type] of [
    ['/favicon.ico', 'image/'],
    ['/favicon-16.png', 'image/png'],
    ['/favicon-32.png', 'image/png'],
  ]) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()['content-type'], path).toContain(type);
  }
  // The 32 px frame is drawn from its own optical variant, not from the master drawing (render-brand-icons.mjs).
  const script = await readFile(new URL('../scripts/render-brand-icons.mjs', import.meta.url), 'utf8');
  expect(script).toContain("{ file: 'favicon-32.png', svg: await svg('favicon-32.svg')");
});
