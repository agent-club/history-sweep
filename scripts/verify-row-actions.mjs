import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const records = Array.from({ length: 4 }, (_, index) => ({
  url: `https://x.test/design/${index}`, title: `Design notes ${index} / Synthetic history`,
  lastVisitTime: Date.UTC(2026, 8, 30, 12), visitCount: index + 1,
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
    const context = await browser.newContext({ viewport: layout === 'manager' ? { width: 1080, height: 800 } : { width: 440, height: 690 } });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await installMock(page, records);
    // Exercise the shared modal layout without changing the authenticated launch protocol.
    if (layout === 'modal') await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.body.dataset.presentation = 'modal'; }));
    await page.goto(`${origin}/extension/${layout === 'modal' ? 'manager' : layout}.html`);
    await page.locator('#query').fill('design'); await page.locator('#mode').selectOption('contains'); await page.locator('#search').click();
    await page.waitForFunction(() => !document.querySelector('#search').disabled);
    const rows = page.locator('.history-row');
    const target = rows.nth(1);
    await page.locator('.topbar').hover();
    check(await target.locator('.row-delete').evaluate(el => getComputedStyle(el).opacity === '0'), `${layout}: actions hidden without hover`);
    const bounds = await target.boundingBox();
    await target.hover(); await page.waitForTimeout(400);
    const animation = await target.locator('.row-hover-trail').evaluate(el => ({
      opacity: getComputedStyle(el).opacity,
      duration: getComputedStyle(el, '::before').animationDuration,
      playState: getComputedStyle(el, '::before').animationPlayState,
      width: el.getBoundingClientRect().width,
      left: el.getBoundingClientRect().left,
      right: el.getBoundingClientRect().right,
    }));
    check(animation.opacity === '1' && animation.duration === '4.5s' && animation.playState === 'running', `${layout}: accepted hover animation`);
    check(Math.abs(animation.left - bounds.x) < 1 && Math.abs(animation.right - bounds.x - bounds.width) < 1, `${layout}: trail covers the full row independently of content indentation`);
    check(await target.evaluate(el => Math.abs(el.getBoundingClientRect().left - el.closest('.group-results').getBoundingClientRect().left) < 1), `${layout}: row background and separator reach the group edge`);
    check(await target.locator('.row-delete').evaluate(el => getComputedStyle(el).opacity === '1'), `${layout}: deletion revealed`);
    check(JSON.stringify(bounds) === JSON.stringify(await target.boundingBox()), `${layout}: hover does not move the row`);
    check(await rows.first().locator('.row-hover-trail').evaluate(el => getComputedStyle(el, '::before').animationPlayState === 'paused'), `${layout}: inactive animation paused`);
    await page.screenshot({ path: `test-results/row-hover-${layout}.png` });
    await target.screenshot({ path: `test-results/row-hover-${layout}-detail.png` });

    await rows.first().locator('.row-select').check();
    await target.hover(); await target.locator('.row-delete').click();
    check((await page.locator('#previewSummary').textContent()).includes('1'), `${layout}: confirmation targets one item`);
    check(await page.locator('.preview-site').count() === 1, `${layout}: confirmation has one target site`);
    await page.locator('#confirmDialog [value=cancel]').click();
    check(await page.evaluate(() => window.__deleted.length) === 0, `${layout}: cancel preserves history`);
    check(await rows.first().locator('.row-select').isChecked() && !(await target.locator('.row-select').isChecked()), `${layout}: opening and cancelling keeps batch choices`);
    await target.hover(); await target.locator('.row-delete').click();
    await page.locator('#confirmDialog [value=confirm]').click();
    await page.waitForFunction(() => document.querySelector('#status').dataset.kind === 'done');
    check(JSON.stringify(await page.evaluate(() => window.__deleted)) === JSON.stringify([records[1].url]), `${layout}: only clicked URL is deleted`);
    check((await page.locator('#count').textContent()).startsWith('3'), `${layout}: result count rebuilt`);
    check(await rows.first().locator('.row-select').isChecked(), `${layout}: other batch choice survives`);
    check((await page.locator('#selected').textContent()).startsWith('1'), `${layout}: preserved selection count`);

    await page.locator('#query').fill('changed');
    check(await rows.first().locator('.row-delete').isDisabled(), `${layout}: stale results cannot be deleted`);
    await page.locator('#query').fill('design');
    await page.locator('#groupBySite').click();
    check(await page.locator('#table .row-delete').count() === 3, `${layout}: flat view has per-row actions`);
    await rows.nth(1).locator('.row-delete').focus();
    check(await rows.nth(1).locator('.row-delete').evaluate(el => getComputedStyle(el).pointerEvents !== 'none'), `${layout}: keyboard focus reveals action`);
    await page.getByRole('button', { name: '简体中文', exact: true }).click();
    check(await rows.first().locator('.row-delete').getAttribute('title') === '删除这一条', `${layout}: Chinese action label`);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await rows.first().hover();
    check(await rows.first().locator('.row-hover-trail').evaluate(el => getComputedStyle(el, '::before').animationName === 'none'), `${layout}: reduced motion stops the loop`);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    if (layout === 'manager') {
      await page.setViewportSize({ width: 320, height: 800 });
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${layout}: narrow layout has no overflow`);
      await rows.nth(1).hover();
      check(await rows.nth(1).locator('.row-delete').isVisible(), `${layout}: narrow action remains accessible`);
    }

    // A failed single target remains selected alongside earlier batch choices.
    const failedUrl = records[2].url;
    await page.evaluate(url => { window.__failDelete = url; }, failedUrl);
    const failedRow = rows.filter({ has: page.locator(`.row-select[data-url="${failedUrl}"]`) });
    await failedRow.hover(); await failedRow.locator('.row-delete').click();
    await page.locator('#confirmDialog [value=confirm]').click();
    await page.waitForFunction(() => document.querySelector('#status').dataset.kind === 'partial' && !document.querySelector('#search').disabled);
    check((await page.locator('#selected').textContent()).startsWith('2'), `${layout}: partial deletion retains failed target and other choices`);
    check(await page.evaluate(() => window.__messages.filter(message => message.type === 'start-delete').every(message => message.urls.length === 1)), `${layout}: worker receives one URL per row action`);
    check(errors.length === 0, `${layout}: no runtime errors`);
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true });
  const page = await context.newPage(); await installMock(page, records);
  await page.goto(`${origin}/extension/manager.html`);
  await page.locator('#query').fill('design'); await page.locator('#mode').selectOption('contains'); await page.locator('#search').click();
  await page.waitForFunction(() => !document.querySelector('#search').disabled);
  check(await page.locator('.row-delete').first().evaluate(el => getComputedStyle(el).opacity === '1' && el.getBoundingClientRect().width === 44), 'touch: action visible with 44px target');
  await context.close();
  console.log(`${checks} row hover and deletion assertions passed. Synthetic history only.`);
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
