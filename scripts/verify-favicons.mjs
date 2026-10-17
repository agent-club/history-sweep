import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-favicons-'));
const server = createServer();
let context;
let checks = 0;
const check = (ok, message) => { assert.ok(ok, message); checks++; };
const ready = page => page.waitForFunction(() => !document.querySelector('#search').disabled && document.querySelector('#status').dataset.kind === 'scanned');
const output = '/private/tmp/history-sweep-favicons';
try {
  await mkdir(output, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...(process.env.HISTORY_SWEEP_CHROMIUM ? { executablePath: process.env.HISTORY_SWEEP_CHROMIUM } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    reducedMotion: 'reduce', viewport: { width: 440, height: 590 },
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Only localhost pages are visited in this disposable profile.
  await page.route(`${origin}/favicon-visit`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Illustrative local page</title><link rel="icon" href="/extension/icons/icon-32.png"><h1>Local favicon fixture</h1>' }));
  await page.goto(`${origin}/favicon-visit`);
  await page.goto(`chrome-extension://${id}/popup.html`); await ready(page);
  check(await page.evaluate(() => chrome.runtime.getManifest().permissions.includes('favicon')), 'real extension has the required favicon permission');
  await page.locator('.group-favicon').first().waitFor({ state: 'visible' });
  const native = await page.locator('.group-favicon').first().evaluate(img => ({ source: img.src, width: img.naturalWidth, rect: { width: img.getBoundingClientRect().width, height: img.getBoundingClientRect().height } }));
  check(native.source.startsWith(`chrome-extension://${id}/_favicon/`) && native.width > 0, 'Chrome serves the favicon under the extension origin and CSP');
  check(native.rect.width === 16 && native.rect.height === 16, 'native favicon is displayed at 16 pixels');
  check(await page.locator('.history-row .group-favicon, .date-header .group-favicon').count() === 0, 'favicons appear only on website headers');
  await page.screenshot({ path: `${output}/native-popup.png` });

  // Controlled image success/failure and unusual URLs use synthetic history in the same isolated browser.
  const records = [
    { url: 'https://recognizable.test/a?test=1&other=2', title: 'An illustrative saved page' },
    { url: 'https://recognizable.test/b', title: 'Another illustrative saved page' },
    { url: 'https://missing-icon.test/a', title: 'An illustrative page without an icon' },
    { url: 'file:///illustrative-only/offline.html', title: 'An illustrative offline page' },
    { url: 'not-a-valid-url', title: 'An illustrative invalid URL' },
  ].map(record => ({ ...record, lastVisitTime: Date.now(), visitCount: 1 }));
  const png = await readFile(join(extension, 'icons/icon-32.png'));
  for (const layout of ['popup', 'manager', 'modal']) {
    const fixture = await context.newPage();
    fixture.on('pageerror', error => errors.push(error.message));
    await fixture.setViewportSize(layout === 'popup' ? { width: 440, height: 590 } : { width: 1120, height: 800 });
    await installMock(fixture, records);
    await fixture.addInitScript(() => {
      const original = chrome.runtime.getURL;
      chrome.runtime.getURL = path => path === '_favicon/' ? `${location.origin}/fixture-favicon/` : original(path);
    });
    const requests = [];
    await fixture.route('**/fixture-favicon/**', route => {
      const request = new URL(route.request().url()); requests.push(request.searchParams.get('pageUrl'));
      return request.searchParams.get('pageUrl').startsWith('https://missing-icon.test/') ? route.abort() : route.fulfill({ contentType: 'image/png', body: png });
    });
    if (layout === 'modal') await fixture.route('**/extension/manager.html', async route => {
      const response = await route.fetch(); await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
    });
    await fixture.goto(`${origin}/extension/${layout === 'popup' ? 'popup' : 'manager'}.html`); await ready(fixture);
    const group = fixture.locator('.website-group[data-hostname="recognizable.test"]');
    await group.locator('.group-favicon').waitFor({ state: 'visible' });
    await fixture.waitForFunction(() => !document.querySelector('.website-group[data-hostname="missing-icon.test"] .group-favicon'));
    for (const grouping of ['date', 'website']) {
      await fixture.locator(grouping === 'date' ? '#groupByDate' : '#groupBySite').click();
      await group.locator('.group-favicon').waitFor({ state: 'visible' });
      await fixture.waitForFunction(() => !document.querySelector('.website-group[data-hostname="missing-icon.test"] .group-favicon'));
      check(await group.locator('.group-favicon').count() === 1, `${layout}/${grouping}: one icon per website header`);
      check(await fixture.locator('.history-row img.group-favicon, .date-header img.group-favicon').count() === 0, 'rows and date headings do not repeat website icons');
      check(await fixture.locator('.website-group[data-hostname="file:"] .group-favicon, .website-group[data-hostname="not-a-valid-url"] .group-favicon').count() === 0, 'unsupported URLs do not request icons');
      check(await fixture.locator('.website-group[data-hostname="missing-icon.test"] .group-host').isVisible(), 'failed icon preserves the website label');
      check(await group.locator('.group-favicon').getAttribute('alt') === '' && await group.locator('.group-favicon').getAttribute('aria-hidden') === 'true', 'decorative icon does not duplicate the accessible label');
      const request = new URL(await group.locator('.group-favicon').getAttribute('src'));
      check(request.searchParams.get('pageUrl') === records[0].url && request.searchParams.get('size') === '32', 'page URL query is encoded intact and a high-resolution local icon is requested');
      await group.locator('.group-select').check();
      check((await fixture.locator('#selected').textContent()).startsWith('2'), 'selection still covers both pages');
      const geometry = await group.locator('.group-toggle').evaluate(toggle => {
        const img = toggle.querySelector('.group-favicon').getBoundingClientRect(); const label = toggle.querySelector('.group-host').getBoundingClientRect();
        return img.width === 16 && img.height === 16 && img.right <= label.left && document.documentElement.scrollWidth <= innerWidth;
      });
      check(geometry, 'icon precedes the domain without overflow');
      await fixture.screenshot({ path: `${output}/${layout}-${grouping}.png` });
      await fixture.locator('#selectAll').click(); await fixture.locator('#selectAll').click();
    }
    check(requests.every(url => /^https:\/\/(recognizable|missing-icon)\.test\//.test(url)), 'no favicon request for unsupported or unrelated URLs');
    check((await fixture.evaluate(() => window.__deleted.length)) === 0, 'icon interactions delete nothing');
    await fixture.close();
  }
  check(errors.length === 0, `no runtime errors: ${errors.join(', ')}`);
  console.log(`${checks} favicon assertions passed, including the real Chrome extension endpoint. Disposable profile and synthetic data only. Screenshots: ${output}`);
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
