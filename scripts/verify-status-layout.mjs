import assert from 'node:assert/strict';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const records = Array.from({ length: 180 }, (_, i) => ({
  url: `https://site-${i % 12}.example.test/page-${i}`,
  title: `Chrome history note ${i}`,
  lastVisitTime: Date.parse('2026-10-21T12:00:00+08:00') - i * 60000,
  visitCount: 2,
}));
const server = createServer();
let browser, checks = 0;
const errors = [];
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const ready = page => page.waitForFunction(() => !document.querySelector('#search').disabled && document.querySelector('#status').dataset.kind === 'scanned');
const search = async page => { await page.locator('#search').click(); await ready(page); };

async function layout(page, label, modal) {
  const geometry = await page.evaluate(() => {
    const box = selector => {
      const node = document.querySelector(selector), rect = node.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height, visible: getComputedStyle(node).display !== 'none' };
    };
    return {
      panel: box('.results-panel'), header: box('.results-header'), list: box('#resultScroll'),
      status: box('.status-area'), footer: box('.actionbar'),
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  const { panel, header, list, status, footer } = geometry;
  check(header.bottom <= panel.bottom + 1, `${label}: results contain their entire header`);
  check(list.top >= header.bottom - 1 && list.bottom <= panel.bottom + 1, `${label}: list stays inside the card below its header`);
  check(list.height >= (modal ? 120 : 60), `${label}: results keep usable reading space: ${JSON.stringify(geometry)}`);
  check(!status.visible || status.top >= panel.bottom - 1, `${label}: status does not overlap results`);
  check(!status.visible || footer.top >= status.bottom - 1, `${label}: status does not overlap the footer`);
  check(!geometry.overflow, `${label}: no horizontal overflow`);
}

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
  for (const surface of [
    { name: 'manager', file: 'manager', width: 1280, height: 800 },
    { name: 'popup', file: 'popup', width: 440, height: 590 },
    { name: 'modal', file: 'manager', width: 960, height: 720, modal: true },
    { name: 'short-modal', file: 'manager', width: 960, height: 360, modal: true },
    { name: 'narrow-modal', file: 'manager', width: 720, height: 500, modal: true },
    { name: 'small-modal', file: 'manager', width: 390, height: 560, modal: true },
  ]) {
    for (const lang of ['en', 'zh-CN']) {
      const context = await browser.newContext({ viewport: { width: surface.width, height: surface.height }, timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.setFixedTime(new Date('2026-10-22T10:00:00+08:00'));
      await installMock(page, records);
      if (surface.modal) await page.route('**/extension/manager.html', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
      });
      await page.goto(`${origin}/extension/${surface.file}.html`); await ready(page);
      if (lang !== 'en') await page.locator(`[data-language="${lang}"]`).click();
      const label = `${surface.name}/${lang}`;
      await layout(page, `${label}/initial`, surface.modal);

      await page.locator('#query').fill('c');
      check(await page.locator('#status').getAttribute('data-kind') === 'queryChanged', `${label}: editing search marks previous results stale`);
      await layout(page, `${label}/draft`, surface.modal);
      await page.locator('#query').fill('example');
      await page.locator('#query').press('Escape'); await search(page);
      check(await page.locator('#count').textContent() === (lang === 'en' ? '180 results' : '180 条结果'), `${label}: searching refreshes the result count`);
      await page.locator('#selectAll').click();
      await page.locator('#query').fill('example.test');
      check(await page.locator('#status').getAttribute('data-kind') === 'queryChangedSelected', `${label}: stale selected results explain the pending reset`);
      check(await page.locator('#delete').isDisabled(), `${label}: stale selection cannot be deleted`);
      await layout(page, `${label}/selected-draft`, surface.modal);
      await page.locator('#query').press('Escape'); await search(page);
      check((await page.locator('#selected').textContent()).startsWith('0'), `${label}: new search clears old selection`);

      await page.locator('#filterToggle').click();
      await page.locator('.time-range-radio[value="custom"]').check();
      await page.locator('#startDate').fill('2026-10-22');
      await page.locator('#endDate').fill('2026-10-21');
      await page.locator('#filterToggle').click();
      await page.locator('#search').click();
      await page.waitForFunction(() => document.querySelector('#status').dataset.kind === 'invalidTimeRange');
      await layout(page, `${label}/invalid-date`, surface.modal);
      await page.locator('#filterToggle').click();
      await page.locator('.time-range-radio[value="7days"]').check();
      await page.locator('#filterToggle').click(); await search(page);

      for (const rules of ['site-0.example.test', '']) {
        await page.locator('#filterToggle').click();
        await page.locator('#editProtection').click();
        await page.locator('#protectionInput').fill(rules);
        await page.locator('#saveProtection').click();
        await page.waitForFunction(() => !document.querySelector('#protectionDialog').open && !document.querySelector('#search').disabled);
        check(await page.locator('#filters').evaluate(node => {
          const trigger = node.querySelector('summary').getBoundingClientRect();
          const menu = node.querySelector('.filters-body').getBoundingClientRect();
          return menu.bottom <= trigger.top || menu.top >= trigger.bottom;
        }), `${label}: saving kept websites keeps the time menu clear of its trigger`);
        await page.locator('#filterToggle').click();
        check(!await page.locator('#filters').evaluate(node => node.open), `${label}: the time menu remains dismissible by its trigger`);
        await search(page);
      }

      await page.locator('#activityDock[data-open="false"] #activityEntry, #activityDock[data-open="true"] #activityCollapse').click();
      await page.waitForFunction(() => document.querySelector('#activityPanel').getAttribute('aria-busy') === 'false');
      await page.locator('#query').fill('c');
      await page.locator('#query').press('Escape');
      // Popup keeps a fixed footer while its expanded workspace scrolls behind it.
      if (surface.name !== 'popup') await layout(page, `${label}/activity-draft`, surface.modal);
      await page.locator('#activityDock[data-open="false"] #activityEntry, #activityDock[data-open="true"] #activityCollapse').click();
      await page.locator('#query').fill('example');
      await search(page);

      for (const view of ['#groupBySite', '#groupByFrequency', '#groupByDate']) {
        await page.locator(view).click(); await ready(page);
        await layout(page, `${label}/${view.slice(1)}`, surface.modal);
      }
      await page.locator('#selectAll').click(); await page.locator('#delete').click();
      check(await page.locator('#confirmDialog').isVisible(), `${label}: deletion confirmation opens`);
      await page.locator('#confirmDialog [value="cancel"]').click();
      check(await page.evaluate(() => window.__deleted.length) === 0, `${label}: cancel preserves all records`);
      await page.locator('#delete').click(); await page.locator('#confirmDialog [value="confirm"]').click();
      await page.waitForFunction(() => document.querySelector('#status').dataset.kind === 'done');
      await layout(page, `${label}/deleted`, surface.modal);
      check(await page.locator('#empty').isVisible() && await page.locator('#delete').isDisabled(), `${label}: confirmed deletion reaches the empty state`);
      check(await page.evaluate(() => window.__deleted.length) === records.length, `${label}: only selected synthetic records were deleted`);
      await context.close();
    }
  }
  check(errors.length === 0, `no browser runtime errors: ${errors.join('; ')}`);
  console.log(`${checks} status-layout and full-flow assertions passed across six surfaces in English and Chinese. Synthetic history only.`);
} finally {
  await browser?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
