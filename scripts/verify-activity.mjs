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
const results = new URL('../test-results/', import.meta.url);
const errors = [];
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const today = new Date(2026, 9, 17, 12).getTime();
const items = Array.from({ length: 15 }, (_, index) => ({ url: `https://${['example.org', 'docs.example.net', 'news.example.com'][index % 3]}/page-${index}`, title: `Project notes ${index + 1}`, lastVisitTime: today - (index % 3) * 86400000, visitCount: index % 4 + 1 }));
const days = { '2026-10-17': { operations: 3, pages: 126 } };
for (let index = 0; index < 31; index++) {
  const date = new Date(2026, 0, 5 + index * 9);
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  days[key] = { operations: index === 0 ? 15 : 1, pages: index === 0 ? 60 : 54 };
}
const log = { version: 1, startedOn: '2024-01-01', days };
async function ready(page) {
  await page.waitForFunction(() => document.querySelector('#search') && !document.querySelector('#search').disabled);
}
async function openActivity(page) {
  await page.locator('#toggleActivity').click();
  await page.waitForFunction(() => document.querySelector('#activityPanel').getAttribute('aria-busy') === 'false' && !document.querySelector('#activityContent').hidden);
}
try {
  await mkdir(results, { recursive: true });
  for (const [layout, viewport] of [['manager', { width: 1536, height: 1024 }], ['popup', { width: 440, height: 590 }]]) {
    const context = await browser.newContext({ viewport, timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: new Date('2026-10-17T12:00:00+08:00') });
    await installMock(page, items);
    await page.addInitScript(log => { localStorage.setItem('language', 'zh-CN'); localStorage.setItem('fixture-activity', JSON.stringify(log)); }, log);
    await page.goto(`${origin}/extension/${layout}.html`); await ready(page);
    check(await page.locator('#activityPanel').isHidden(), 'activity is initially collapsed');
    check(await page.evaluate(() => !window.__messages.some(message => message.type === 'get-activity')), 'collapsed panel does not read activity');
    await openActivity(page);
    check((await page.locator('#activityStats').textContent()).includes(layout === 'manager' ? '48 次清理' : '10 次清理'), 'yearly or quarterly summary uses its actual range');
    check(await page.locator('.activity-day').count() === (layout === 'manager' ? 365 : 92), 'real calendar days rendered for selected period');
    if (layout === 'popup') await page.locator('[data-activity-range=year]').click();
    check((await page.locator('#activityStats').textContent()).includes('1,806'), 'all verified pages appear in annual totals');
    await page.locator('.activity-day[data-date="2026-10-17"]').focus();
    check((await page.locator('#activityDetail').textContent()).includes('3 次清理 · 126 个页面'), 'focused date exposes exact counts');
    await page.keyboard.press('ArrowUp');
    check(await page.locator('.activity-day[data-date="2026-10-16"]').evaluate(node => node === document.activeElement), 'arrow navigation moves a single date');
    check(await page.locator('.activity-day[data-date="2026-10-18"]').isDisabled(), 'future dates cannot be selected');
    await page.locator('#activityPreviousYear').click(); await page.locator('#activityPreviousYear').click();
    check(await page.locator('.activity-day[data-date="2024-02-29"]').count() === 1, 'past leap year contains February 29');
    check(await page.locator('#activityPreviousYear').isDisabled(), 'navigation stops at tracking start');
    await page.locator('#activityNextYear').click(); await page.locator('#activityNextYear').click();
    await page.getByRole('button', { name: 'English', exact: true }).click();
    check(await page.locator('#activityPanel').isVisible() && (await page.locator('#activityTitle').textContent()) === 'Local activity', 'language switch preserves open panel and translates controls');
    await page.getByRole('button', { name: '简体中文', exact: true }).click();
    await page.locator('#themeToggle').click();
    await page.screenshot({ path: new URL(`activity-${layout}-dark.png`, results).pathname });
    await page.locator('#themeToggle').click();
    await page.locator('[data-activity-mode=browsing]').click();
    await page.waitForFunction(() => document.querySelector('#activityPanel').getAttribute('aria-busy') === 'false');
    check((await page.locator('#activityStats').textContent()).includes('15 个网页'), 'browsing mode counts retained distinct pages, not visit counts');
    check((await page.locator('#activitySubtitle').textContent()).includes('不代表每日访问次数'), 'browsing semantics stay explicit');
    await page.locator('[data-activity-mode=cleanup]').click();
    if (layout === 'popup') await page.locator('[data-activity-range=quarter]').click();
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'activity causes no page-level horizontal overflow');
    if (layout === 'popup') check(await page.locator('.app-shell').evaluate(node => node.scrollHeight > node.clientHeight) && await page.locator('#resultScroll').evaluate(node => node.clientHeight >= 170), 'expanded popup scrolls to a usable history list');
    check(await page.locator('#delete').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight), 'deletion action stays visible');
    await page.locator('.activity-day[data-date="2026-10-17"]').focus();
    await page.screenshot({ path: new URL(`activity-${layout}.png`, results).pathname });
    await page.locator('#toggleActivity').click();
    check(await page.locator('#activityPanel').isHidden(), 'analysis button collapses panel');
    await page.reload(); await ready(page);
    check(await page.locator('#activityPanel').isHidden(), 'collapsed preference survives reload');
    await openActivity(page); await page.reload(); await ready(page);
    check(await page.locator('#activityPanel').isVisible(), 'open preference survives reload');
    await page.waitForFunction(() => document.querySelector('#activityPanel').getAttribute('aria-busy') === 'false');
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem('fixture-activity')));
    await page.locator('#selectAll').click(); await page.locator('#delete').click();
    await page.locator('#confirmDialog [value=confirm]').click();
    await page.waitForFunction(() => document.querySelector('#status').dataset.kind === 'done');
    check(await page.evaluate(() => window.__deleted.length) === 15, 'real production worker completes the synthetic cleanup');
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('fixture-activity')));
    check(after.days['2026-10-17'].operations === before.days['2026-10-17'].operations + 1 && after.days['2026-10-17'].pages === before.days['2026-10-17'].pages + 15, 'cleanup records one operation and verified pages');
    check(!JSON.stringify(after).includes('https:') && !JSON.stringify(after).includes('/page-'), 'activity storage contains no complete URLs');
    await context.close();
  }

  const narrow = await browser.newContext({ viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Shanghai' });
  const page = await narrow.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-10-17T12:00:00+08:00') });
  await installMock(page, items); await page.goto(`${origin}/extension/manager.html`); await ready(page); await openActivity(page);
  check(await page.locator('#activityEmpty').isVisible(), 'fresh installations show an honest empty state');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '375px page has no horizontal overflow');
  await page.screenshot({ path: new URL('activity-narrow.png', results).pathname, fullPage: true });
  await page.locator('#toggleActivity').click();
  await page.reload(); await ready(page);
  await page.evaluate(() => { window.__failActivityRead = true; });
  await page.locator('#toggleActivity').click();
  await page.waitForFunction(() => !document.querySelector('#activityRetry').hidden);
  check(await page.locator('#search').isEnabled(), 'statistics read failure leaves search available');
  await page.evaluate(() => { window.__failActivityRead = false; }); await page.locator('#activityRetry').click();
  await page.waitForFunction(() => !document.querySelector('#activityContent').hidden);
  check(await page.locator('#activityRetry').isHidden(), 'retry recovers activity independently');
  await narrow.close();

  for (const failure of ['write', 'read-after-cleanup']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await installMock(page, items.slice(0, 1)); await page.goto(`${origin}/extension/manager.html`); await ready(page); await openActivity(page);
    await page.evaluate(failure => {
      if (failure === 'write') window.__failActivitySave = true;
      else {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = message => message.type === 'get-activity' && window.__failActivityUIRead
          ? Promise.reject(new Error('fixture activity read unavailable')) : send(message);
        window.__failActivityUIRead = true;
      }
    }, failure);
    await page.locator('#query').fill('example.org'); await page.locator('#search').click(); await ready(page);
    await page.locator('#selectAll').click(); await page.locator('#delete').click(); await page.locator('#confirmDialog [value=confirm]').click();
    await page.waitForFunction(() => document.querySelector('#status').dataset.kind === 'doneActivityUnavailable');
    check(await page.evaluate(() => window.__deleted.length) === 1, 'statistics failure does not undo or repeat successful deletion');
    check((await page.locator('#status').textContent()).includes('local cleanup activity could not be confirmed'), 'cleanup explicitly reports unconfirmed local activity');
    check(await page.locator('#search').isEnabled(), 'statistics failure leaves history search usable');
    const recorded = await page.evaluate(() => JSON.parse(localStorage.getItem('fixture-activity')));
    check(Object.keys(recorded.days).length === (failure === 'write' ? 0 : 1), 'write failure preserves old counts; UI read failure preserves the successfully written count');
    if (failure === 'read-after-cleanup') {
      await page.evaluate(() => { window.__failActivityUIRead = false; });
      await page.locator('#activityRetry').click();
      await page.waitForFunction(() => document.querySelector('#activityStats').textContent.includes('1 cleanups'));
      check(await page.locator('#activityRetry').isHidden(), 'retry reads the persisted cleanup without another deletion');
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(`${checks} activity assertions passed. Isolated profiles and synthetic history only.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
