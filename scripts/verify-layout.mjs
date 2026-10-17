import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
const directory = '/private/tmp/history-sweep-ui';
await mkdir(directory, { recursive: true });
let checks = 0;
const metrics = [];
const errors = [];
const check = (ok, message) => { assert.ok(ok, message); checks++; };
const ready = page => page.waitForFunction(() => ['scanned', 'limit'].includes(document.querySelector('#status')?.dataset.kind) && !document.querySelector('#search').disabled);
const records = Array.from({ length: 547 }, (_, i) => ({ url: `https://site-${i % 49}.example.test/page-${i}`, title: `Illustrative research note ${i + 1}`, lastVisitTime: Date.parse('2026-10-16T23:00:00+08:00') - i * 180000, visitCount: 2 }));
records[1] = { ...records[1], url: `https://${'long-domain-'.repeat(8)}example.test/${'path/'.repeat(30)}`, title: 'An intentionally long illustrative page title '.repeat(10) };
const geometry = page => page.evaluate(() => {
  const box = selector => { const { x, y, width, height, bottom, right } = document.querySelector(selector).getBoundingClientRect(); return { x, y, width, height, bottom, right }; };
  return { viewport: { width: innerWidth, height: innerHeight }, overflow: document.documentElement.scrollWidth > innerWidth, panel: box('.results-panel'), scroll: box('#resultScroll'), scope: box('#resultScope'), heading: box('.results-heading'), footer: box('.actionbar'), group: box('.grouping-toolbar'), select: box('.selection-actions') };
});
try {
  for (const surface of [
    { name: 'popup', file: 'popup', width: 440, height: 590 },
    { name: 'manager', file: 'manager', width: 1280, height: 850 },
    { name: 'modal', file: 'manager', width: 960, height: 720 },
    { name: 'narrow', file: 'manager', width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce', viewport: { width: surface.width, height: surface.height } });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.clock.setFixedTime(new Date('2026-10-17T09:00:00+08:00'));
    await installMock(page, records);
    if (surface.name === 'modal') await page.route('**/extension/manager.html', async route => {
      const response = await route.fetch(); await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
    });
    await page.goto(`${origin}/extension/${surface.file}.html`); await ready(page);
    for (const lang of ['en', 'zh-CN']) {
      if (lang !== 'en') { await page.locator(`[data-language="${lang}"]`).click(); await ready(page); }
      const m = await geometry(page);
      check(!m.overflow, `${surface.name}/${lang}: no horizontal page overflow`);
      check(m.scope.x === m.heading.x, `${surface.name}/${lang}: date context aligns with heading`);
      check(m.group.right <= m.select.x || m.group.bottom <= m.select.y, `${surface.name}/${lang}: grouping and selection do not overlap`);
      check(m.footer.bottom <= m.viewport.height + 1, `${surface.name}/${lang}: footer remains within the viewport`);
      check(m.scroll.height >= (surface.name === 'popup' ? 210 : 220), `${surface.name}/${lang}: results retain useful reading space`);
      check(await page.locator('#selected').evaluate(node => node.hidden || node.classList.contains('sr-only')), `${surface.name}/${lang}: redundant zero selection is quiet`);
      check((await page.locator('#expandGroups').getAttribute('aria-label'))?.length, 'icon action has an accessible name');
      await page.screenshot({ path: `${directory}/after-${surface.name}-${lang}.png` });
      metrics.push({ surface: surface.name, lang, resultViewport: Math.round(m.scroll.height), resultsChrome: Math.round(m.scroll.y - m.panel.y) });
      await page.locator('.date-select').first().check();
      check(!await page.locator('#delete').isDisabled(), 'day selection enables explicit deletion');
      const selected = await geometry(page);
      check(selected.group.right <= selected.select.x || selected.group.bottom <= selected.select.y, 'selected count does not overlap view controls');
      await page.locator('#groupBySite').click();
      check(await page.locator('.website-group').count() > 0, 'website view remains available');
      await page.screenshot({ path: `${directory}/after-${surface.name}-${lang}-selected.png` });
      await page.locator('#selectAll').click(); await page.locator('#selectAll').click(); await page.locator('#groupByDate').click();
    }
    await page.locator('#openPreferences').click();
    await page.locator('#preferencesDialog').evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
    const dialog = await page.locator('#preferencesDialog').boundingBox();
    check(dialog.x >= 0 && dialog.y >= 0 && dialog.x + dialog.width <= surface.width && dialog.y + dialog.height <= surface.height, 'preferences fit the surface');
    await page.screenshot({ path: `${directory}/after-${surface.name}-preferences.png` });
    await page.locator('#closePreferences').click();
    await page.locator('#query').fill('no-matching-illustrative-record'); await page.locator('#search').click(); await ready(page);
    check(await page.locator('#empty').isVisible(), 'no-match state remains visible');
    check(await page.locator('#delete').isDisabled(), 'empty results never enable deletion');
    await page.screenshot({ path: `${directory}/after-${surface.name}-empty.png` });
    await context.close();
  }
  check(errors.length === 0, `no browser runtime errors: ${errors.join(', ')}`);
  console.log(JSON.stringify({ checks, metrics, screenshots: directory }, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
