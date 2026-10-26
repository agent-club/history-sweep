import assert from 'node:assert/strict';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const now = Date.parse('2026-10-23T12:00:00+08:00');
const records = Array.from({ length: 72 }, (_, index) => ({
  url: `https://site${index % 12}.example/page${index}`, title: `Page ${index}`,
  lastVisitTime: now - index * 3600000, visitCount: index % 5 + 1,
}));
const browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
const baseline = process.argv.includes('--baseline');
const results = [];
const errors = [];
const idle = page => page.waitForFunction(() => !document.querySelector('#search').disabled && document.querySelector('#status').dataset.kind !== 'rulesLoading');

try {
  for (const [layout, width, height] of [['manager', 1200, 900], ['manager', 375, 812], ['popup', 440, 600], ['embedded', 1200, 900]]) for (const language of ['en', 'zh-CN']) {
    const context = await browser.newContext({ viewport: { width, height }, timezoneId: 'Asia/Shanghai' });
    try {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.setFixedTime(new Date(now));
      await installMock(page, records);
      await page.addInitScript(language => {
        localStorage.setItem('language', language);
        const search = chrome.history.search;
        const visits = chrome.history.getVisits;
        const listeners = [];
        const extraVisits = new Map();
        chrome.history.onVisited = { addListener: listener => listeners.push(listener) };
        window.__addVisit = url => {
          extraVisits.set(url, [{ visitId: 'added-visit', visitTime: Date.now() }]);
          listeners.forEach(listener => listener({ url }));
        };
        window.__reads = { search: 0, visits: 0 };
        chrome.history.search = async options => {
          window.__reads.search++;
          await new Promise(resolve => setTimeout(resolve, 120));
          return search(options);
        };
        chrome.history.getVisits = async options => {
          window.__reads.visits++;
          await new Promise(resolve => setTimeout(resolve, 20));
          return [...await visits(options), ...extraVisits.get(options.url) || []];
        };
        const getURL = chrome.runtime.getURL;
        chrome.runtime.getURL = path => path === '_favicon/' ? `${location.origin}/fixture-favicon` : getURL(path);
      }, language);
      await page.route('**/fixture-favicon?*', async route => {
        await new Promise(resolve => setTimeout(resolve, 100));
        await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="gray"/></svg>' });
      });
      if (layout === 'embedded') await page.route('**/extension/manager.html', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
      });
      await page.goto(`${origin}/extension/${layout === 'popup' ? 'popup' : 'manager'}.html`);
      await idle(page);
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        window.__frames = [];
        window.__sampling = true;
        const sample = () => {
          const scroll = document.getElementById('resultScroll').getBoundingClientRect();
          window.__frames.push({ empty: !document.getElementById('empty').hidden, top: scroll.top, height: scroll.height });
          if (window.__sampling) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      // Direct activation measures the cold path without a preceding intent prefetch.
      await page.locator('#groupByFrequency').dispatchEvent('click'); await idle(page);
      await page.locator('#groupByDate').dispatchEvent('click'); await idle(page);
      await page.locator('#groupBySite').dispatchEvent('click'); await idle(page);
      const before = await page.evaluate(() => ({ ...window.__reads }));
      await page.locator('#groupByFrequency').dispatchEvent('click'); await idle(page);
      const after = await page.evaluate(() => ({ ...window.__reads }));
      await page.waitForTimeout(200);
      const frames = await page.evaluate(() => { window.__sampling = false; return window.__frames; });
      const measurement = { layout, width, language, emptyFrames: frames.filter(frame => frame.empty).length, topShift: Math.max(...frames.map(frame => frame.top)) - Math.min(...frames.map(frame => frame.top)), repeatVisitReads: after.visits - before.visits };
      results.push(measurement);
      if (!baseline) {
        assert.equal(measurement.emptyFrames, 0, 'switching populated views must never paint a loading empty state');
        assert.ok(measurement.topShift <= 1, `switching must keep the result viewport anchored: ${JSON.stringify(measurement)}`);
        assert.equal(measurement.repeatVisitReads, 0, 'returning to a current frequency ranking must reuse its scan');
        const target = await page.locator('#rows .row-select').first().getAttribute('data-url');
        const count = Number(await page.locator('#rows .visit-column').first().textContent());
        await page.locator('#rows .row-select').first().check();
        await page.evaluate(url => window.__addVisit(url), target);
        await page.locator('#groupBySite').dispatchEvent('click'); await idle(page);
        await page.locator('#groupByFrequency').dispatchEvent('click'); await idle(page);
        const updated = await page.locator('#rows .history-row').evaluateAll((rows, url) => rows.find(row => row.querySelector('.row-select').dataset.url === url)?.querySelector('.visit-column').textContent, target);
        assert.equal(Number(updated), count + 1, 'new history events invalidate the cached ranking even while a selection defers refresh');
        assert.equal(await page.locator('#rows .row-select:checked').count(), 1, 'switching retains only the explicit selection');

        await page.locator('#groupBySite').dispatchEvent('click'); await idle(page);
        await page.evaluate(() => { window.__siteNode = document.querySelector('#groups > .website-group'); });
        await page.locator('#groupByDate').dispatchEvent('click'); await idle(page);
        const iconPosition = await page.locator('.date-group .group-host').first().evaluate(node => node.getBoundingClientRect().x);
        await page.waitForTimeout(180);
        assert.equal(await page.locator('.date-group .group-host').first().evaluate(node => node.getBoundingClientRect().x), iconPosition, 'late favicons do not shift group labels');
        await page.locator('#groupBySite').dispatchEvent('click'); await idle(page);
        assert.ok(await page.evaluate(() => window.__siteNode === document.querySelector('#groups > .website-group')), 'date/site switching reuses existing group nodes');
        await page.locator('#expandGroups').dispatchEvent('click');
        await page.locator('#groupByDate').dispatchEvent('click'); await idle(page);
        assert.equal(await page.locator('.date-group .group-toggle[aria-expanded=true]').count(), 0, 'restored cached groups reflect expansion state changed in the other view');

        await page.locator('#groupBySite').dispatchEvent('click'); await idle(page);
        await page.locator('#search').click(); await idle(page);
        const cold = await page.evaluate(() => window.__reads.visits);
        await page.locator('#groupByFrequency').dispatchEvent('pointerenter');
        await page.waitForFunction(n => window.__reads.visits === n + 72, cold);
        await page.waitForTimeout(40);
        assert.equal(await page.locator('#groupBySite').getAttribute('aria-pressed'), 'true', 'prefetch keeps the current view active');
        await page.locator('#groupByFrequency').dispatchEvent('click'); await idle(page);
        assert.equal(await page.evaluate(() => window.__reads.visits), cold + 72, 'opening a prefetched view shares the prepared visit scan');
        assert.deepEqual(await page.evaluate(() => window.__deleted), [], 'prefetching and switching never delete history');
      }
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ results, pageErrors: errors.length }));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
