import assert from 'node:assert/strict';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const records = Array.from({ length: 300 }, (_, index) => ({
  url: `https://site-${index}.example.test/page`, title: `Synthetic page ${index}`,
  lastVisitTime: Date.parse('2026-10-22T10:00:00+08:00') - index * 60000, visitCount: 2,
}));
let browser, checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };
const errors = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
  for (const surface of [
    { name: 'manager', width: 1280, height: 850 },
    { name: 'popup', width: 440, height: 590 },
    { name: 'modal', width: 960, height: 720 },
  ]) {
    const context = await browser.newContext({ viewport: { width: surface.width, height: surface.height }, timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await installMock(page, records);
    await page.addInitScript(() => localStorage.setItem('fixture-browsing-preferences', JSON.stringify({ view: 'website', range: 'all' })));
    if (surface.name === 'modal') await page.route('**/extension/manager.html', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
    });
    await page.goto(`${origin}/extension/${surface.name === 'popup' ? 'popup' : 'manager'}.html`);
    await page.waitForFunction(() => document.querySelector('.group-select') && !document.getElementById('search').disabled);
    const button = page.locator('#backToTop');
    check(await button.isHidden() && await button.evaluate(node => node.inert), `${surface.name}: hidden and inaccessible at top`);
    await page.locator('.group-select').first().check();
    const selected = await page.locator('#selected').textContent();
    for (const motion of ['no-preference', 'reduce']) {
      await page.emulateMedia({ reducedMotion: motion });
      await page.locator('#resultScroll').evaluate(node => { node.scrollTop = 1800; });
      await page.waitForFunction(() => document.getElementById('backToTop').dataset.visible === 'true');
      const bounds = await page.evaluate(() => {
        const list = document.getElementById('resultScroll').getBoundingClientRect();
        const control = document.getElementById('backToTop').getBoundingClientRect();
        return control.left >= list.left && control.right <= list.right && control.top >= list.top && control.bottom <= list.bottom;
      });
      check(bounds, `${surface.name}/${motion}: control stays inside the result viewport`);
      const shellTop = await page.locator('.app-shell').evaluate(node => node.scrollTop);
      if (motion === 'no-preference') {
        await page.evaluate(() => {
          const scroll = document.getElementById('resultScroll');
          window.__backToTopSamples = [];
          const sample = () => {
            window.__backToTopSamples.push(scroll.scrollTop);
            if (scroll.scrollTop > 0 && window.__backToTopSamples.length < 180) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        await button.click();
        await button.evaluate(node => node.click());
        await page.waitForFunction(() => document.getElementById('resultScroll').scrollTop === 0);
        const samples = await page.evaluate(() => window.__backToTopSamples);
        check(samples.some(value => value > 0 && value < 1700), `${surface.name}: smooth scroll has intermediate frames after repeated clicks`);
      } else {
        await button.focus();
        await button.press('Enter');
        check(await page.locator('#resultScroll').evaluate(node => node.scrollTop === 0), `${surface.name}: reduced motion returns immediately from keyboard`);
      }
      await page.waitForFunction(() => getComputedStyle(document.getElementById('backToTop')).visibility === 'hidden');
      check(await button.evaluate(node => node.inert), `${surface.name}/${motion}: hidden control leaves keyboard navigation`);
      check(await page.locator('#selected').textContent() === selected, `${surface.name}/${motion}: selection is preserved`);
      check(await page.locator('.app-shell').evaluate(node => node.scrollTop) === shellTop, `${surface.name}/${motion}: outer scroll is preserved`);
      check(await page.locator('#resultScroll').evaluate(node => document.activeElement === node), `${surface.name}/${motion}: focus returns to the list`);
    }
    await page.locator('#resultScroll').evaluate(node => { node.scrollTop = 1800; });
    await page.waitForFunction(() => document.getElementById('backToTop').dataset.visible === 'true');
    await page.locator('[data-language="zh-CN"]').click();
    await page.waitForFunction(() => document.getElementById('backToTop').dataset.visible === 'true');
    check(await button.getAttribute('aria-label') === '返回顶部', `${surface.name}: language remount restores localized control`);
    if (process.env.HISTORY_SWEEP_SCREENSHOTS) await page.screenshot({ path: `${process.env.HISTORY_SWEEP_SCREENSHOTS}/${surface.name}.png` });
    await button.click();
    await page.waitForFunction(() => document.getElementById('resultScroll').scrollTop === 0);
    await page.locator('#groupByFrequency').click();
    await page.waitForFunction(() => !document.getElementById('table').hidden && !document.getElementById('search').disabled);
    await page.locator('#resultScroll').evaluate(node => { node.scrollTop = 1800; });
    await page.waitForFunction(() => document.getElementById('backToTop').dataset.visible === 'true');
    await button.click();
    await page.waitForFunction(() => document.getElementById('resultScroll').scrollTop === 0);
    check(true, `${surface.name}: frequency table scrolls back to top`);
    await page.locator('#query').fill('no-matching-synthetic-page');
    await page.locator('#search').click();
    await page.waitForFunction(() => !document.getElementById('search').disabled && !document.getElementById('empty').hidden);
    check(await button.isHidden(), `${surface.name}: empty results do not show control`);
    await context.close();
  }
  check(errors.length === 0, `no runtime errors: ${errors.join('; ')}`);
  console.log(`${checks} back-to-top assertions passed across manager, popup and modal. Synthetic history only.`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
