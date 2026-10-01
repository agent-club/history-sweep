import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const day = Date.parse('2026-10-01T00:00:00+08:00');
const records = Array.from({ length: 80 }, (_, i) => ({ url: `https://x.com/page-${i}`, title: i === 0 ? '<em>Fixture title</em>' : `Fixture page ${i}`, lastVisitTime: day + i * 60000, visitCount: 2 })).concat([
  { url: 'https://x.com/older', title: 'Older visit', lastVisitTime: day - 1 },
  { url: 'https://x.com/last', title: 'Last moment', lastVisitTime: day + 86400000 - 1 },
  { url: 'https://x.com/next', title: 'Next day', lastVisitTime: day + 86400000 },
  { url: 'https://x.com/unknown', title: 'No last visit time' },
  { url: 'https://sub.x.com/keep', title: 'Subdomain', lastVisitTime: day + 1 },
  { url: 'https://example.org/keep', title: 'Kept site', lastVisitTime: day + 1 },
]);
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
let checks = 0;
const errors = [];
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const search = async page => { await page.locator('#search').click(); await page.waitForFunction(() => !document.querySelector('#search').disabled); };
const openFilters = async page => { if (!await page.locator('#filters').evaluate(node => node.open)) await page.locator('#filters > summary').click(); };
const closeFilters = async page => { if (await page.locator('#filters').evaluate(node => node.open)) await page.locator('#filters > summary').click(); };
const saveRules = async (page, input) => {
  await openFilters(page); await page.locator('#editProtection').click(); await page.locator('#protectionInput').fill(input);
  await page.locator('#saveProtection').click(); await page.waitForFunction(() => !document.querySelector('#protectionDialog').open && !document.querySelector('#search').disabled);
  await closeFilters(page);
};

try {
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  for (const layout of ['manager', 'popup']) {
    const context = await browser.newContext({ viewport: layout === 'popup' ? { width: 440, height: 590 } : { width: 1280, height: 850 }, timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await installMock(page, records);
    await page.goto(`${origin}/extension/${layout}.html`);
    await page.getByRole('button', { name: '简体中文', exact: true }).click();
    await page.locator('#query').fill('X'); await search(page);
    check((await page.locator('#count').textContent()).startsWith('85'), 'all-time search includes unknown visit times');
    await page.locator('#selectAll').click(); await openFilters(page);
    await page.locator('#timeRange').selectOption('custom');
    check(await page.locator('#delete').isDisabled(), 'changing time conditions disables deletion of old selection');
    await page.locator('#startDate').fill('2026-10-01'); await page.locator('#endDate').fill('2026-10-01');
    await page.getByRole('button', { name: 'English', exact: true }).click();
    check(await page.locator('#startDate').inputValue() === '2026-10-01' && await page.locator('#filters').evaluate(node => node.open), 'language switch preserves draft dates and filter state');
    await closeFilters(page); await search(page);
    check((await page.locator('#count').textContent()).startsWith('82'), 'custom range includes its complete final day and excludes missing timestamps');
    check((await page.locator('#selected').textContent()).startsWith('0'), 'new search clears old selection');
    await page.locator('#selectAll').click(); await page.locator('#delete').click();
    check((await page.locator('#previewSummary').textContent()).includes('82 URLs across 2 websites'), 'preview includes every selected URL across folded and unrendered groups');
    check(await page.locator('#previewTimeWarning').isVisible(), 'time-filtered deletion warns that all visits will be removed');
    check(await page.locator('#confirmTitle').evaluate(node => { const bounds = node.getBoundingClientRect(); return bounds.top >= 0 && bounds.bottom <= innerHeight; }), 'confirmation heading stays fully visible');
    check(await page.locator('#confirmDialog [value=confirm]').evaluate(node => { const bounds = node.getBoundingClientRect(); return bounds.top >= 0 && bounds.bottom <= innerHeight; }), 'confirmation action stays in the viewport');
    await page.locator('.preview-site').first().locator('summary').click();
    await page.waitForFunction(() => document.querySelector('.preview-site').querySelectorAll('li').length === 20);
    check(await page.locator('.preview-site').first().locator('li').count() === 20, 'page preview starts with a bounded render');
    await page.locator('.preview-site').first().locator('.preview-more').click();
    check(await page.locator('.preview-site').first().locator('li').count() === 40, 'hidden preview pages remain inspectable');
    check(await page.locator('#deletePreview em').count() === 0, 'history titles are rendered as text');
    await page.screenshot({ path: new URL(`../test-results/features-${layout}-preview.png`, import.meta.url).pathname });
    await page.locator('#confirmDialog [value=cancel]').click();
    check(await page.evaluate(() => window.__deleted.length) === 0, 'cancel never deletes');
    await saveRules(page, 'x.com');
    check((await page.locator('#selected').textContent()).startsWith('0') && await page.locator('#delete').isDisabled(), 'saving protection invalidates the old selection');
    await search(page);
    check((await page.locator('#count').textContent()).startsWith('0') && (await page.locator('#protectedCount').textContent()).includes('82'), 'a kept domain excludes itself and its subdomains');
    await page.reload(); await page.locator('#query').fill('X'); await search(page);
    check((await page.locator('#count').textContent()).startsWith('0'), 'kept rules survive reopening');
    await saveRules(page, 'sub.x.com');
    await page.locator('#query').fill(''); await openFilters(page); await page.locator('#timeRange').selectOption('custom');
    await page.locator('#startDate').fill('2026-10-01'); await page.locator('#endDate').fill('2026-10-01'); await closeFilters(page); await search(page);
    check((await page.locator('#count').textContent()).startsWith('82'), 'time-only search works without a keyword and honors kept rules');
    await openFilters(page); await page.locator('#startDate').fill('2026-10-02'); await closeFilters(page); await search(page);
    check(await page.locator('#status').getAttribute('data-kind') === 'invalidTimeRange', 'reversed dates produce an explicit error');
    await openFilters(page); await page.locator('#startDate').fill('2026-10-01'); await closeFilters(page); await search(page);
    await page.locator('#selectAll').click(); await page.locator('#delete').click(); await page.locator('#confirmDialog [value=confirm]').click();
    await page.waitForFunction(() => document.querySelector('#status').dataset.kind === 'done');
    check(await page.evaluate(() => window.__deleted.length) === 82, 'confirmed deletion submits exactly the filtered and unprotected URLs');
    check(await page.evaluate(() => !window.__deleted.includes('https://sub.x.com/keep') && !window.__deleted.includes('https://x.com/older') && !window.__deleted.includes('https://x.com/next')), 'kept, earlier and later URLs remain untouched');
    if (layout === 'popup') {
      await page.reload(); await page.locator('#currentSite').click(); await page.waitForFunction(() => !document.querySelector('#search').disabled);
      check(await page.locator('#query').inputValue() === 'x.com' && await page.locator('#mode').inputValue() === 'host-exact', 'popup current website starts an exact-host search');
      check((await page.locator('#selected').textContent()).startsWith('0'), 'current website selects nothing');
      await page.evaluate(() => { window.__activeUrl = 'chrome://settings/'; }); await page.locator('#currentSite').click();
      await page.waitForFunction(() => document.querySelector('#status').dataset.kind === 'currentSiteUnavailable');
      check(await page.locator('#query').inputValue() === 'x.com', 'restricted current page cannot broaden a search');
      await openFilters(page); await page.locator('#timeRange').selectOption('custom'); await page.locator('#startDate').fill('2026-10-01'); await page.locator('#endDate').fill('2026-10-01'); await closeFilters(page);
      await page.locator('#openFull').click(); await page.waitForFunction(() => window.__opened.length === 1);
      const message = await page.evaluate(() => window.__messages.findLast(message => message.type === 'open-workspace'));
      check(message.filters.startDate === '2026-10-01' && message.filters.range === 'custom', 'popup handoff carries date filters');
      check(await page.evaluate(() => !window.__opened[0].includes('2026') && !window.__opened[0].includes('x.com')), 'handoff URL contains no filters or domain');
    }
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    await page.screenshot({ path: new URL(`../test-results/features-${layout}.png`, import.meta.url).pathname });
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Shanghai' });
  const first = await context.newPage(); const second = await context.newPage();
  for (const page of [first, second]) { page.on('pageerror', error => errors.push(error.message)); await installMock(page, records); await page.goto(`${origin}/extension/manager.html`); await page.locator('#query').fill('X'); await search(page); }
  await first.locator('#selectAll').click(); await first.locator('#delete').click();
  await saveRules(second, 'x.com');
  await first.waitForFunction(() => !document.querySelector('#confirmDialog').open && !document.querySelector('#search').disabled);
  check(await first.locator('#delete').isDisabled() && await first.evaluate(() => window.__deleted.length) === 0, 'another window updating rules closes a stale confirmation without deleting');
  await openFilters(second); await second.locator('#editProtection').click(); await second.locator('#protectionInput').fill('*.x.com'); await second.locator('#saveProtection').click();
  check((await second.locator('#protectionStatus').textContent()).includes('domain names only'), 'invalid kept rules are not saved');
  await second.locator('#protectionInput').fill('example.org'); await second.evaluate(() => { window.__failRulesSave = true; }); await second.locator('#saveProtection').click();
  await second.waitForFunction(() => document.querySelector('#protectionStatus').textContent.includes('Could not save'));
  check(await second.evaluate(() => JSON.parse(localStorage.getItem('fixture-kept-sites'))[0]) === 'x.com', 'failed rule save preserves previous protection');
  await second.locator('#closeProtection').click(); await closeFilters(second);
  check(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow layout has no horizontal overflow');
  await second.screenshot({ path: new URL('../test-results/features-mobile.png', import.meta.url).pathname, fullPage: true });
  await context.close();

  const failed = await browser.newPage(); await installMock(failed, records); await failed.addInitScript(() => { window.__failRulesRead = true; }); await failed.goto(`${origin}/extension/manager.html`);
  await failed.waitForFunction(() => document.querySelector('#status').dataset.kind === 'rulesUnavailable');
  check(await failed.locator('#search').isDisabled() && await failed.locator('#delete').isDisabled(), 'rules read failure blocks destructive work');
  await failed.close();
  assert.deepEqual(errors, []);
  console.log(`${checks} feature assertions passed. Temporary profiles and synthetic history only.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
