import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const cases = [
  ['https://example.test/protocol', null],
  ['http://example.test/protocol', 'HTTP · High risk'],
  ['HtTp://example.test/protocol-case', 'HTTP · High risk'],
  ['file:///synthetic/protocol.txt', 'FILE'],
  ['ftp://example.test/protocol', 'FTP'],
  ['chrome://history/protocol', 'CHROME'],
  ['chrome-extension://synthetic/options.html?protocol', 'EXTENSION'],
  ['about:protocol', 'ABOUT'],
  ['custom-app:protocol', 'CUSTOM-APP'],
  ['blob:https://example.test/protocol', 'BLOB'],
  ['data:text/plain,protocol', 'DATA'],
  ['malformed protocol', null],
];
const records = cases.map(([url], index) => ({
  url, ...(index === 3 ? {} : { title: index === 2 ? 'Synthetic protocol example with a long title to verify that the address label never takes space from the title' : `Synthetic protocol example ${index}` }),
  lastVisitTime: Date.now() - index * 1000, visitCount: 1,
}));
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
try {
  browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
  await mkdir('test-results', { recursive: true });
  for (const layout of ['manager', 'popup', 'modal']) {
    const context = await browser.newContext({ viewport: layout === 'manager' ? { width: 1080, height: 900 } : { width: 440, height: 690 } });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await installMock(page, records);
    if (layout === 'modal') await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.body.dataset.presentation = 'modal'; }));
    await page.goto(`${origin}/extension/${layout === 'modal' ? 'manager' : layout}.html`);
    await page.locator('#query').fill('protocol');
    await page.locator('#mode').selectOption('contains');
    await page.locator('#search').click();
    await page.waitForFunction(() => !document.querySelector('#search').disabled);
    for (const view of ['groupByDate', 'groupBySite', 'groupByFrequency']) {
      await page.locator(`#${view}`).click();
      await page.waitForFunction(() => !document.querySelector('#search').disabled);
      if (view !== 'groupByFrequency' && await page.locator('#expandGroups').getAttribute('data-expanded') !== 'true') await page.locator('#expandGroups').click();
      for (const [url, label] of cases) {
        const row = page.locator('.history-row:visible').filter({ has: page.locator(`.row-select[data-url=${JSON.stringify(url)}]`) });
        check(await row.count() === 1, `${layout}/${view}: record remains available: ${url}`);
        check(await row.locator('.page-url').textContent() === url, `${layout}/${view}: URL is unchanged`);
        check(label ? await row.locator('.protocol-badge').textContent() === label : await row.locator('.protocol-badge').count() === 0, `${layout}/${view}: protocol label: ${url}`);
        check(await row.locator('.protocol-badge-risk').count() === (label?.startsWith('HTTP ·') ? 1 : 0), `${layout}/${view}: only HTTP has risk styling`);
        if (label) check(await row.locator('.page-address').evaluate(el => {
          const badge = el.querySelector('.protocol-badge').getBoundingClientRect();
          const url = el.querySelector('.page-url').getBoundingClientRect();
          return el.firstElementChild.classList.contains('protocol-badge') && Math.abs(url.left - badge.right - 7) < 1 && badge.height === 18 && getComputedStyle(el.firstElementChild).borderTopWidth === '0px';
        }), `${layout}/${view}: A places a borderless 18px label before the URL with a 7px gap`);
      }
    }
    await page.locator('.row-select:visible').first().check();
    await page.getByRole('button', { name: '简体中文', exact: true }).click();
    check(await page.locator('.protocol-badge-risk:visible').first().textContent() === 'HTTP · 高风险', `${layout}: Chinese risk label`);
    check((await page.locator('.protocol-badge-risk:visible').first().getAttribute('title')).includes('未加密'), `${layout}: risk explanation`);
    check(await page.locator('.row-select:checked:visible').count() === 1, `${layout}: language switch preserves selection`);
    await page.screenshot({ path: `test-results/protocol-labels-${layout}.png`, animations: 'disabled' });
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await page.locator('#themeToggle').click(); await page.locator('[data-theme-choice=dark]').click();
    check(await page.locator('.protocol-badge-risk:visible').first().evaluate(el => {
      const style = getComputedStyle(el);
      return style.color === 'rgb(242, 161, 142)' && style.backgroundColor === 'rgb(67, 45, 39)';
    }), `${layout}: A uses its muted terracotta palette in dark theme`);
    await page.screenshot({ path: `test-results/protocol-labels-${layout}-dark.png`, animations: 'disabled' });
    if (layout === 'manager') await page.setViewportSize({ width: 320, height: 800 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${layout}: no horizontal overflow`);
    check(await page.locator('.protocol-badge:visible').evaluateAll(nodes => nodes.every(el => { const badge = el.getBoundingClientRect(); const cell = el.closest('td').getBoundingClientRect(); return badge.left >= cell.left && badge.right <= cell.right; })), `${layout}: badges stay within page cells`);
    check(await page.locator('.protocol-badge-risk:visible').evaluateAll(nodes => nodes.every(el => el.scrollWidth <= el.clientWidth)), `${layout}: the full risk label remains readable`);
    check(await page.evaluate(() => window.__deleted.length === 0 && window.__opened.length === 0), `${layout}: labels do not navigate or delete history`);
    check(errors.length === 0, `${layout}: no runtime errors`);
    await context.close();
  }
  console.log(`${checks} protocol label assertions passed. Synthetic history only.`);
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
