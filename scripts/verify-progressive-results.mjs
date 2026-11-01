import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';
import { MANUAL_CLEANUP_KEY } from '../extension/workspace-tools.mjs';

const { chromium } = dependency('playwright');
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const output = await mkdtemp(join(tmpdir(), 'history-sweep-progressive-ui-'));
const now = Date.parse('2026-11-01T12:00:00+08:00');
const item = (host, index, time = now) => ({ url: `https://${host}/result-${index}`, title: `Synthetic result ${index}`, lastVisitTime: time, visitCount: 1 });
const errors = [];
let browser, checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const idle = page => page.waitForFunction(() => !document.querySelector('#search').disabled && document.querySelector('#status').dataset.kind !== 'rulesLoading');
const count = (page, selector) => page.locator(selector).count();
async function nearEnd(page, button, selector, expected) {
  await button.evaluate(node => {
    const scroll = document.getElementById('resultScroll');
    scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().bottom + 80;
    window.__appendScrollTop = scroll.scrollTop;
    window.__existingResult = document.querySelector('.history-row, .website-group');
  });
  await page.waitForFunction(({ selector, expected }) => document.querySelectorAll(selector).length === expected, { selector, expected });
  check(await page.locator('#resultScroll').evaluate(node => Math.abs(node.scrollTop - window.__appendScrollTop) <= 1), 'append preserves scroll position');
  check(await page.evaluate(() => window.__existingResult.isConnected), 'append retains existing result nodes');
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
  for (const surface of [
    { name: 'manager', file: 'manager', viewport: { width: 1280, height: 850 }, batch: 100 },
    { name: 'popup', file: 'popup', viewport: { width: 440, height: 590 }, batch: 40 },
    { name: 'modal', file: 'manager', viewport: { width: 960, height: 720 }, batch: 100 },
  ]) {
    const context = await browser.newContext({ viewport: surface.viewport, timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' });
    async function open(records) {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      // The legacy mock embeds the worker without its new workspace imports.
      // Use the production module for the reads needed by result selection.
      await page.addInitScript(({ origin, marker }) => {
        globalThis.MANUAL_CLEANUP_KEY = marker;
        for (const name of ['readProtectedUrls', 'readWorkspaceTools']) {
          globalThis[name] = (...args) => import(`${origin}/extension/workspace-tools.mjs`).then(module => module[name](...args));
        }
      }, { origin, marker: MANUAL_CLEANUP_KEY });
      await installMock(page, records);
      if (surface.name === 'modal') await page.route('**/extension/manager.html', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
      });
      await page.goto(`${origin}/extension/${surface.file}.html`); await idle(page);
      await page.locator('#query').fill('Synthetic'); await page.locator('#mode').selectOption('contains');
      await page.locator('#search').click(); await idle(page);
      return page;
    }
    const sites = Array.from({ length: 230 }, (_, index) => item(`site-${String(index).padStart(3, '0')}.example.test`, index));
    let page = await open(sites);
    check(await count(page, '#groups > .website-group') === surface.batch, 'outer list starts bounded');
    await page.locator('#selectAll').click();
    await nearEnd(page, page.locator('#loadMore'), '#groups > .website-group', surface.batch * 2);
    check(await count(page, '.group-select:checked') === surface.batch * 2, 'auto-appended sites inherit all-match selection');
    check((await page.locator('#selected').textContent()).startsWith('230'), 'selection total stays unchanged');
    // The append must not steal focus from a control the user was operating.
    check(await page.locator('#selectAll').evaluate(node => node === document.activeElement), 'automatic append preserves keyboard focus');
    await page.locator('#groupByFrequency').click(); await idle(page);
    await page.locator('#rows .row-select').first().uncheck();
    await nearEnd(page, page.locator('#loadMore'), '#rows > .history-row', surface.batch * 2);
    check(await count(page, '#rows .row-select:checked') === surface.batch * 2 - 1 && !await page.locator('#rows .row-select').first().isChecked(), 'frequency append preserves an individual exclusion and selects new matching rows');
    while (await page.locator('#loadMore').isVisible()) {
      const before = await count(page, '#rows > .history-row');
      await nearEnd(page, page.locator('#loadMore'), '#rows > .history-row', Math.min(230, before + surface.batch));
    }
    check(await count(page, '#rows > .history-row') === 230, 'frequency loading stops at the final result without duplicates');
    await page.close();

    page = await open(Array.from({ length: 66 }, (_, index) => item('large.example.test', index)).concat([item('other.example.test', 0)]));
    const group = page.locator('.website-group[data-hostname="large.example.test"]');
    check(await count(page, '.website-group[data-hostname="large.example.test"] .history-row') === 5, 'site preview remains five rows');
    await group.locator('.group-select').check(); await group.locator('.row-select').first().uncheck();
    const more = group.locator('.group-load-more');
    await more.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    check(await group.locator('.history-row').count() === 5, 'scrolling does not expand website records');
    check((await more.textContent()).includes('20'), 'site button announces twenty additional rows');
    await page.screenshot({ path: join(output, `${surface.name}-site-more.png`) });
    const scrollTop = await page.locator('#resultScroll').evaluate(node => node.scrollTop);
    await more.click();
    check(await group.locator('.history-row').count() === 25, 'site click adds exactly twenty rows');
    check(Math.abs(await page.locator('#resultScroll').evaluate(node => node.scrollTop) - scrollTop) <= 1, 'manual append preserves scroll position');
    check(await group.locator('.row-select:checked').count() === 24 && await group.locator('.group-select').evaluate(node => node.indeterminate), 'manual append preserves a partial selection');
    await group.locator('.group-toggle').click(); await group.locator('.group-toggle').click();
    check(await group.locator('.history-row').count() === 25, 'collapse and reopen preserves shown count');
    await page.locator('[data-language="zh-CN"]').click();
    check((await more.textContent()).includes('20') && await group.locator('.history-row').count() === 25, 'language remount keeps the batch and shown count');
    await more.click(); await more.click();
    check(await group.locator('.history-row').count() === 65 && (await more.textContent()).includes('1'), 'last short batch announces only the remaining row');
    await more.click();
    check(await group.locator('.history-row').count() === 66 && await more.count() === 0, 'site button disappears when complete');
    check(await group.locator('.group-toggle').evaluate(node => node === document.activeElement), 'final manual batch restores focus within the group');
    await page.screenshot({ path: join(output, `${surface.name}-site-complete.png`) });
    await page.close();

    const dated = sites.concat(Array.from({ length: 110 }, (_, index) => item('older.example.test', index, now - (index + 1) * 86400000)));
    page = await open(dated);
    await page.locator('#groupByDate').click(); await idle(page);
    const firstDay = page.locator('.date-group').first();
    if (await firstDay.locator('.date-toggle').getAttribute('aria-expanded') === 'false') await firstDay.locator('.date-toggle').click();
    const dayMore = firstDay.locator(':scope > .date-results > .group-load-more');
    check(await dayMore.count() === 1, 'DOM structure distinguishes a date website list from site record lists');
    await nearEnd(page, dayMore, '.date-group:first-child > .date-results > .website-group', surface.batch * 2);
    check(await page.locator('#groupByDate').evaluate(node => node === document.activeElement), 'date website append does not steal focus');
    await page.locator('#selectAll').click();
    await nearEnd(page, page.locator('#loadMore'), '#groups > .date-group', Math.min(111, surface.batch * 2));
    check(await count(page, '.date-select:checked') === Math.min(111, surface.batch * 2), 'new date groups inherit all-match selection');
    await page.screenshot({ path: join(output, `${surface.name}-dates.png`) });
    await page.close(); await context.close();
  }
  check(errors.length === 0, `no browser errors: ${errors.join('; ')}`);
  console.log(`${checks} progressive-results assertions passed. Synthetic history only. Screenshots: ${output}`);
} finally {
  if (errors.length) console.error('Browser errors:', errors);
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  if (!checks) await rm(output, { recursive: true, force: true });
}
