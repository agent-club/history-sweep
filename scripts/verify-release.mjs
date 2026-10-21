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
let checks = 0;
const errors = [];
const check = (value, message) => { assert.ok(value, message); checks++; };
const ready = page => page.waitForFunction(() => ['scanned', 'limit'].includes(document.querySelector('#status')?.dataset.kind) && !document.querySelector('#search').disabled);
const filters = async page => { if (!await page.locator('#filters').evaluate(node => node.open)) await page.locator('#filterToggle').click(); };
const outside = page => page.mouse.click(3, 3);
const snapshot = page => page.evaluate(() => ({ messages: window.__messages.length, deleted: window.__deleted.length }));

try {
  await mkdir(new URL('../test-results/', import.meta.url), { recursive: true });
  for (const layout of ['manager', 'popup', 'modal']) {
    const context = await browser.newContext({ timezoneId: 'Asia/Shanghai', viewport: layout === 'popup' ? { width: 440, height: 590 } : { width: 1280, height: 850 } });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    // Fixed local dates make midnight boundaries reproducible without real browsing history.
    await page.clock.setFixedTime(new Date('2026-10-16T12:00:00+08:00'));
    const record = (url, day, time = '12:00:00') => ({ url: `https://${url}`, title: url, lastVisitTime: Date.parse(`2026-10-${day}T${time}+08:00`), visitCount: 99 });
    const records = [record('a.test/today', '16'), record('b.test/today', '16'), record('a.test/yesterday', '15'), record('c.test/boundary', '14', '00:00:00'), record('old.test/older', '13', '23:59:59'), record('future.test/next', '17', '00:00:00')];
    await installMock(page, records);
    // Exercise the same app presentation used by the authenticated iframe; host messaging is tested separately.
    if (layout === 'modal') await page.route('**/extension/manager.html', async route => {
      const response = await route.fetch(); await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
    });
    await page.goto(`${origin}/extension/${layout === 'modal' ? 'manager' : layout}.html`); await ready(page);
    check(await page.locator('#count').textContent() === '5 results', `${layout}: first open includes the past week`);
    check(await page.locator('#timeRange').inputValue() === '7days', 'default week range is visible and accurate');
    check(await page.locator('#groupBySite').getAttribute('aria-pressed') === 'true', 'website view is the first-use default');
    // Keep the existing three-day grouping regression explicit, independent of defaults.
    await filters(page); await page.locator('#timeRange').selectOption('3days');
    await outside(page); await page.locator('#search').click(); await ready(page);
    await page.locator('#groupByDate').click();
    check(await page.locator('.date-group').count() === 3, 'three date summaries');
    check(await page.locator('.date-group').first().locator('.date-toggle').getAttribute('aria-expanded') === 'true', 'today expanded');
    check((await page.locator('.date-group').first().locator('.date-summary').textContent()) === '2 pages · 2 websites', 'counts are pages and distinct websites, not visit events');
    check((await page.locator('#selected').textContent()).startsWith('0') && await page.locator('#delete').isDisabled(), 'default results select and delete nothing');
    check(!await page.locator('#query').evaluate(node => node.required), 'empty query has no browser required-field error');
    await page.locator('#query').fill('   '); await page.locator('#query').press('Enter'); await ready(page);
    check(await page.locator('#count').textContent() === '4 results', 'whitespace search preserves the explicit three-day window');
    await page.locator('.date-group').first().locator('.date-select').check();
    check((await page.locator('#selected').textContent()).startsWith('2'), 'date selection includes collapsed website rows');
    await page.locator('#groupBySite').click();
    check(await page.locator('.website-group').count() === 3, 'website view aggregates across the same dates');
    check((await page.locator('#selected').textContent()).startsWith('2'), 'website switch preserves URL selection');
    const a = page.locator('.website-group[data-hostname="a.test"]');
    check(await a.locator('.group-select').evaluate(node => node.indeterminate), 'same host on different dates has accurate mixed selection');
    await a.locator('.group-select').check();
    check((await page.locator('#selected').textContent()).startsWith('3'), 'website selection includes URLs across dates');
    await page.locator('#groupByDate').click();
    check(await page.locator('.date-group').first().locator('.date-select').isChecked(), 'returning to date view preserves the day selection');
    await page.locator('#selectAll').click(); await page.locator('#selectAll').click();
    await page.screenshot({ path: new URL(`../test-results/release-${layout}-dates.png`, import.meta.url).pathname });

    await filters(page); await page.locator('#timeRange').selectOption('custom');
    await page.locator('#startDate').fill('2026-10-13'); await page.locator('#endDate').fill('2026-10-13');
    await outside(page); await page.locator('#search').click(); await ready(page);
    check(await page.locator('#count').textContent() === '1 results', 'explicit date-only search never falls back to recent history');
    await filters(page); await page.locator('#timeRange').selectOption('all'); await outside(page); await page.locator('#search').click(); await ready(page);
    check(await page.locator('#count').textContent() === '6 results', 'explicit all-time date-only search is honored');

    await filters(page); await page.locator('#timeRange').selectOption('custom');
    await page.locator('#startDate').fill('2026-10-14'); await page.locator('#endDate').fill('2026-10-16');
    await page.locator('[data-calendar-for="endDate"]').click();
    check(await page.locator('#datePicker').isVisible(), 'nested calendar is open');
    await page.locator('.calendar-next').click();
    check(await page.locator('#datePicker').isVisible() && await page.locator('#filters').evaluate(node => node.open), 'calendar controls keep both layers open');
    await outside(page);
    check(!await page.locator('#datePicker').isVisible() && await page.locator('#filters').evaluate(node => node.open), 'first outside click closes only the calendar');
    await outside(page);
    check(!await page.locator('#filters').evaluate(node => node.open), 'second outside click closes the filter');
    check(await page.locator('#startDate').inputValue() === '2026-10-14', 'dismissal keeps chosen filter conditions');
    await filters(page); await page.locator('[data-calendar-for="endDate"]').click(); await page.keyboard.press('Escape');
    check(!await page.locator('#datePicker').isVisible() && await page.locator('#filters').evaluate(node => node.open), 'Escape dismisses one calendar layer');
    await page.keyboard.press('Escape'); check(!await page.locator('#filters').evaluate(node => node.open), 'second Escape closes the filter');
    await page.locator('.search-help > summary').click();
    await page.locator('.search-hint').click(); check(await page.locator('.search-help').evaluate(node => node.open), 'help internal click stays open');
    await outside(page); check(!await page.locator('.search-help').evaluate(node => node.open), 'help outside click closes');
    await page.locator('#openPreferences').click();
    await page.locator('#launchChoices').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#launchChoices').disabled);
    const saved = await page.locator('[name=launchMode]:checked').inputValue();
    await page.locator('[name=launchMode][value="fullpage"]').check();
    // Padding inside the dialog is not the backdrop.
    const box = await page.locator('#preferencesDialog').boundingBox();
    await page.mouse.click(box.x + 5, box.y + 5);
    check(await page.locator('#preferencesDialog').evaluate(node => node.open), 'dialog padding is an internal click');
    const before = await snapshot(page);
    if (layout === 'popup') await page.locator('#dismissPreferences').click();
    else await page.mouse.click(3, 3);
    check(!await page.locator('#preferencesDialog').evaluate(node => node.open), 'Preferences close control or backdrop cancels');
    check((await snapshot(page)).messages === before.messages && (await snapshot(page)).deleted === 0, 'backdrop does not save preferences or delete history');
    await page.locator('#openPreferences').click(); await page.waitForFunction(() => !document.querySelector('#launchChoices').disabled);
    check(await page.locator('[name=launchMode]:checked').inputValue() === saved, 'reopen restores the saved preference');
    await page.locator('#closePreferences').click();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    await context.close();
  }

  const hostContext = await browser.newContext({ timezoneId: 'Asia/Shanghai', viewport: { width: 1280, height: 900 } });
  const host = await hostContext.newPage(); host.on('pageerror', error => errors.push(error.message));
  await installMock(host, []);
  await host.route('**/release-host', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><button id="prior">Host page</button>' }));
  await host.route('**/extension/manager.html', async route => {
    const response = await route.fetch(); await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
  });
  await host.goto(`${origin}/release-host`);
  await host.evaluate(async () => {
    const { injectModal } = await import('/extension/modal-host.mjs');
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(options) { const root = attach.call(this, options); window.__releaseModalRoot = root; return root; };
    try { injectModal(location.origin + '/extension/manager.html'); }
    finally { Element.prototype.attachShadow = attach; }
  });
  await host.waitForFunction(() => window.__historySweepModalHost?.isConnected());
  await host.waitForFunction(() => !!document.querySelector('div'));
  const frame = host.frames().find(frame => frame.url().includes('/extension/manager.html')) || await host.waitForEvent('framenavigated', { predicate: frame => frame.url().includes('/extension/manager.html') });
  await frame.waitForFunction(() => document.querySelector('#status')?.dataset.kind === 'scanned');
  await frame.locator('#filterToggle').click(); await frame.locator('#timeRange').selectOption('custom');
  await frame.locator('[data-calendar-for="endDate"]').click();
  await host.mouse.click(3, 3);
  await frame.waitForFunction(() => !document.querySelector('#datePicker').open);
  check(await frame.locator('#filters').evaluate(node => node.open) && await host.evaluate(() => window.__historySweepModalHost.isConnected()), 'host backdrop first closes calendar, preserving filter and main modal');
  await host.mouse.click(3, 3); await frame.waitForFunction(() => !document.querySelector('#filters').open);
  check(await host.evaluate(() => window.__historySweepModalHost.isConnected()), 'host backdrop second closes filter, preserving main modal');
  await frame.locator('#openPreferences').click(); await frame.waitForFunction(() => !document.querySelector('#launchChoices').disabled);
  await host.waitForFunction(() => window.__releaseModalRoot.querySelector('button').hidden);
  check(await host.evaluate(() => getComputedStyle(window.__releaseModalRoot.querySelector('button')).display === 'none'), 'outer close is absent while preferences are open');
  await host.evaluate(() => window.postMessage({ type: 'history-sweep:preferences', open: false }, location.origin));
  check(await host.evaluate(() => window.__releaseModalRoot.querySelector('button').hidden), 'host page cannot spoof drawer visibility');
  await frame.locator('#defaultViewToggle').click();
  await host.mouse.click(3, 3);
  await frame.waitForFunction(() => document.querySelector('#defaultViewToggle').getAttribute('aria-expanded') === 'false');
  check(await frame.locator('#preferencesDialog').evaluate(node => node.open) && await host.evaluate(() => window.__releaseModalRoot.querySelector('button').hidden), 'host backdrop first closes the custom menu while retaining the drawer and hiding outer close');

  await host.mouse.click(3, 3); await frame.waitForFunction(() => !document.querySelector('#preferencesDialog').open);
  check(await host.evaluate(() => window.__historySweepModalHost.isConnected()), 'host backdrop cancels Preferences without closing main modal');
  await host.waitForFunction(() => !window.__releaseModalRoot.querySelector('button').hidden);
  check(await host.evaluate(() => getComputedStyle(window.__releaseModalRoot.querySelector('button')).display !== 'none'), 'outer close returns after drawer exit');
  await host.evaluate(() => window.postMessage({ type: 'history-sweep:layer-dismissed', requestId: 3, handled: false }, location.origin));
  check(await host.evaluate(() => window.__historySweepModalHost.isConnected()), 'a host-page message cannot spoof the extension-frame dismissal response');
  await host.mouse.click(3, 3); await host.waitForFunction(() => !window.__historySweepModalHost);
  check(await host.locator('#prior').isVisible(), 'backdrop closes main modal after nested layers are gone');
  await hostContext.close();

  const loading = await browser.newPage(); await installMock(loading, []);
  await loading.addInitScript(() => {
    const search = chrome.history.search;
    const gate = new Promise(resolve => { window.__releaseHistory = resolve; });
    chrome.history.search = async options => { await gate; return search(options); };
  });
  await loading.goto(`${origin}/extension/manager.html`); await loading.waitForFunction(() => document.querySelector('#status')?.dataset.kind === 'scanning');
  check(!(await loading.locator('#count').textContent()).startsWith('0') && await loading.locator('#empty h3').textContent() === 'Loading history…', 'initial loading does not claim zero results');
  await loading.evaluate(() => window.__releaseHistory()); await ready(loading); await loading.close();

  const context = await browser.newContext({ timezoneId: 'Asia/Shanghai', viewport: { width: 375, height: 812 } });
  const empty = await context.newPage(); await empty.clock.setFixedTime(new Date('2026-10-16T12:00:00+08:00'));
  await installMock(empty, [{ url: 'https://old.test/older', lastVisitTime: Date.parse('2026-10-01T12:00:00+08:00') }]);
  await empty.goto(`${origin}/extension/manager.html`); await ready(empty);
  check(await empty.locator('#count').textContent() === '0 results' && (await empty.locator('#empty h3').textContent()).includes('past week'), 'no recent history does not look further back');
  await empty.locator('#query').fill('nothing-matches'); await empty.locator('#search').click(); await ready(empty);
  check(await empty.locator('#empty h3').textContent() === 'No matching pages.', 'successful no-match differs from recent-history empty state');
  await empty.locator('#query').fill('old.test'); await empty.locator('#search').click(); await ready(empty);
  check(await empty.locator('#count').textContent() === '1 results', 'keyword search keeps existing all-time default');
  await empty.locator('#clearQuery').click(); await ready(empty);
  check(await empty.locator('#timeRange').inputValue() === '7days' && await empty.locator('#count').textContent() === '0 results', 'clearing keyword restores default recent browsing');
  check(await empty.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '375px layout does not overflow');
  await empty.screenshot({ path: new URL('../test-results/release-mobile-empty.png', import.meta.url).pathname });
  await context.close();
  assert.deepEqual(errors, []);
  console.log(`${checks} release assertions passed. Synthetic history only.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
