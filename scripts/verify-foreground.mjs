import assert from 'node:assert/strict';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
const now = Date.parse('2026-10-23T12:00:00+08:00');
const records = Array.from({ length: 60 }, (_, index) => ({
  url: `https://site${index % 12}.example/page${index}`, title: `Page ${index}`,
  lastVisitTime: now - index * 3600000, visitCount: index % 5 + 1,
}));
const idle = page => page.waitForFunction(() => !document.querySelector('#search').disabled && document.querySelector('#status').dataset.kind === 'scanned');
const results = [];
const errors = [];
async function resume(page) {
  const before = await page.evaluate(() => window.__reads);
  await page.evaluate(() => {
    window.__hidden = true; document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
    window.__hidden = false; document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  await page.waitForFunction(before => window.__reads > before, before);
  await page.waitForTimeout(450);
}
try {
  for (const layout of ['manager', 'popup', 'embedded']) {
    const context = await browser.newContext({ viewport: layout === 'popup' ? { width: 440, height: 600 } : { width: 1200, height: 900 }, timezoneId: 'Asia/Shanghai' });
    try {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.setFixedTime(new Date(now));
      await installMock(page, records);
      await page.addInitScript(() => {
        Object.defineProperty(document, 'hidden', { get: () => window.__hidden || false });
        const search = chrome.history.search;
        window.__reads = 0;
        chrome.history.search = async options => {
          window.__reads++;
          await new Promise(resolve => setTimeout(resolve, 60));
          const items = await search(options);
          return items.map(item => ({ ...item,
            title: item.title + (window.__titleSuffix || ''),
            visitCount: item.visitCount + (window.__extraVisits || 0),
          }));
        };
      });
      if (layout === 'embedded') await page.route('**/extension/manager.html', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
      });
      await page.goto(`${origin}/extension/${layout === 'popup' ? 'popup' : 'manager'}.html`);
      await idle(page);
      for (const view of ['Site', 'Date', 'Frequency']) {
        await page.locator(`#groupBy${view}`).dispatchEvent('click'); await idle(page);
        await page.waitForTimeout(350);
        await page.evaluate(() => {
          window.__textMutations = [];
          window.__observer?.disconnect();
          window.__observer = new MutationObserver(records => {
            for (const record of records) window.__textMutations.push(record.target.id || record.target.className);
          });
          for (const selector of ['.results-overview', '.actionbar', '#groups', '#rows', '#status', '#search > span']) {
            window.__observer.observe(document.querySelector(selector), { childList: true, subtree: true, characterData: true });
          }
        });
        for (let cycle = 0; cycle < 3; cycle++) await resume(page);
        const mutations = await page.evaluate(() => window.__textMutations);
        results.push({ layout, view, unchangedMutations: mutations.length });
        assert.equal(mutations.length, 0, `${layout}/${view}: an unchanged foreground refresh must retain visible text nodes: ${mutations}`);
        if (view === 'Frequency') {
          // A lifetime count can change outside the selected period; the ranking is unchanged.
          await page.evaluate(() => { window.__extraVisits = 1; });
          await resume(page);
          assert.equal(await page.evaluate(() => window.__textMutations.length), 0, 'unrendered lifetime counts must not rebuild the frequency results');
        }
        await page.evaluate(() => { window.__observer.disconnect(); window.__titleSuffix = ' updated'; });
        await resume(page);
        const title = await page.locator('#resultScroll .page-title:visible').first().textContent();
        assert.ok(title.endsWith(' updated'), `${layout}/${view}: foreground refresh must still apply changed history (${title})`);
        await page.evaluate(() => { window.__titleSuffix = ''; window.__extraVisits = 0; });
        await resume(page);
      }
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ results, pageErrors: errors.length }));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
