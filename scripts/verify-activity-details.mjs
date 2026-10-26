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
const output = new URL('../test-results/activity-details/', import.meta.url);
const time = new Date('2026-10-17T12:00:00+08:00').getTime();
const records = Array.from({ length: 40 }, (_, i) => ({ url: `https://site-${String(i).padStart(2, '0')}.example.test/page?synthetic=1`, title: `Illustrative project notes ${i}`, lastVisitTime: time - i * 1000, visitCount: 1 }));
records.push({ url: 'https://site-00.example.test/older', title: 'Older illustrative title', lastVisitTime: time - 60000, visitCount: 1 });
records.push({ url: 'https://yesterday.example.test/page', title: 'Yesterday illustrative title', lastVisitTime: time - 86400000, visitCount: 1 });
const websites = records.slice(0, 40).map(({ url, title, lastVisitTime }) => ({ domain: new URL(url).hostname, title, lastVisitTime }));
const log = { version: 1, startedOn: '2026-10-01', days: {
  '2026-10-16': { operations: 1, pages: 3 },
  '2026-10-17': { operations: 1, pages: 41, websites, websitesComplete: true },
} };
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const errors = [];
const ready = page => page.waitForFunction(() => document.querySelector('#search') && !document.querySelector('#search').disabled);
try {
  await mkdir(output, { recursive: true });
  for (const [layout, viewport] of [['manager', { width: 1536, height: 1024 }], ['popup', { width: 440, height: 590 }], ['modal', { width: 1120, height: 800 }], ['narrow', { width: 375, height: 812 }]]) {
    const context = await browser.newContext({ viewport, timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.clock.setFixedTime(new Date(time));
    await installMock(page, records);
    await page.addInitScript(log => {
      localStorage.setItem('fixture-activity', JSON.stringify(log)); localStorage.setItem('language', 'zh-CN');
      const getURL = chrome.runtime.getURL;
      chrome.runtime.getURL = path => path === '_favicon/' ? `${location.origin}/fixture-favicon/` : getURL(path);
    }, log);
    const requests = [];
    await page.route('**/fixture-favicon/**', route => {
      const url = new URL(route.request().url()); requests.push(url.searchParams.get('pageUrl'));
      const domain = new URL(url.searchParams.get('pageUrl')).hostname;
      const color = Number(domain.match(/site-(\d+)/)?.[1] || 0) * 37 % 360;
      return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="1" y="1" width="30" height="30" rx="7" fill="hsl(${color} 65% 42%)"/><text x="16" y="23" text-anchor="middle" font-family="sans-serif" font-size="21" fill="white">${domain.match(/site-(\d+)/)?.[1] || 'Y'}</text></svg>` });
    });
    if (layout === 'modal') await page.route('**/extension/manager.html', async route => {
      const response = await route.fetch(); await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
    });
    await page.goto(`${origin}/extension/${layout === 'popup' ? 'popup' : 'manager'}.html`); await ready(page);
    await page.locator('#activityDock[data-open="false"] #activityEntry, #activityDock[data-open="true"] #activityCollapse').click();
    await page.locator('[data-activity-mode=cleanup]').click();
    await page.waitForFunction(() => document.querySelectorAll('.activity-site img:not([hidden])').length === 40);
    check(await page.locator('.activity-day[aria-pressed=true]').count() === 1, `${layout}: opening activity selects exactly one available date`);
    check(await page.locator('.activity-day[data-today=true]').evaluate(node => getComputedStyle(node).outlineStyle === 'none'), `${layout}: today uses the normal idle appearance`);
    check((await page.locator('#activityDetail').textContent()).includes('41 个页面 · 40 个网站'), `${layout}: cleanup shows pages and unique website count`);
    check(await page.locator('.activity-site').count() === 40, `${layout}: exactly one icon per site`);
    const geometry = await page.locator('.activity-site').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, width: r.width, height: r.height }; }));
    check(new Set(geometry.map(r => r.top)).size > 1, `${layout}: icons wrap onto following rows`);
    check(geometry.every(r => r.width === 28 && r.height === 28 && r.left >= 0 && r.right <= viewport.width), `${layout}: stable icon frames stay inside viewport`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${layout}: no page horizontal overflow`);
    check(await page.locator('.activity-site').first().getAttribute('data-domain') === 'site-00.example.test', `${layout}: most recent website appears first`);
    await page.locator('.activity-site').first().focus();
    check((await page.locator('#activityTooltip').textContent()).includes('site-00.example.testIllustrative project notes 0'), `${layout}: focus exposes hostname and latest title`);
    const tooltip = await page.locator('#activityTooltip').boundingBox();
    check(tooltip.x >= 0 && tooltip.x + tooltip.width <= viewport.width, `${layout}: tooltip stays inside surface`);
    await page.keyboard.press('Escape'); check(await page.locator('#activityTooltip').isHidden(), `${layout}: Escape dismisses icon tooltip`);
    await page.locator('.activity-day[data-date="2026-10-16"]').click();
    check(await page.locator('.activity-day[data-date="2026-10-16"]').getAttribute('aria-pressed') === 'true', `${layout}: explicit date clicks still pin the date`);
    check(await page.locator('#activitySites').isHidden() && await page.locator('#activitySiteNotice').isVisible(), `${layout}: legacy cleanup has no fabricated website details`);
    await page.locator('[data-activity-mode=browsing]').click();
    await page.waitForFunction(() => document.querySelectorAll('.activity-site img:not([hidden])').length === 40);
    check((await page.locator('#activityDetail').textContent()).includes('41 个网页 · 40 个网站'), `${layout}: browsing deduplicates websites without losing pages`);
    await page.locator('.activity-day[data-date="2026-10-17"]').click();
    await page.locator('.activity-day[data-date="2026-10-16"]').hover();
    await page.waitForFunction(() => document.querySelector('#activityTooltip').dataset.open === 'true' && document.querySelector('#activityTooltip').textContent.includes('1 个网页 · 1 个网站'));
    check((await page.locator('#activityDetail').textContent()).includes('41 个网页 · 40 个网站'), `${layout}: hover leaves selected day details stable`);
    check(await page.locator('.activity-day[aria-pressed=true]').count() === 1, `${layout}: hover never adds a second selection`);
    await page.locator('#activityTitle').hover();
    check((await page.locator('#activityDetail').textContent()).includes('41 个网页 · 40 个网站'), `${layout}: leaving preview restores clicked date`);
    await page.locator('.activity-site').first().hover();
    await page.waitForFunction(() => document.querySelector('#activityTooltip').dataset.open === 'true' && document.querySelector('#activityTooltip').textContent.includes('Illustrative project notes 0'));
    check((await page.locator('#activityTooltip').textContent()).includes('Illustrative project notes 0'), `${layout}: hover exposes latest title`);
    await page.locator('#activityTitle').hover();
    await page.screenshot({ path: new URL(`${layout}-browsing.png`, output).pathname, fullPage: true });
    if (layout === 'popup') {
      await page.locator('.activity-site').nth(20).hover(); await page.mouse.wheel(0, 100);
      // Allow native compositor scrolling to settle before reading its geometry.
      await new Promise(resolve => setTimeout(resolve, 500));
      check(await page.locator('.app-shell').evaluate(node => node.scrollTop > 0), 'popup: wheel input scrolls to the following website rows');
      check(await page.locator('#activityPanel').isVisible(), 'popup: scrolling website rows preserves access to wrapped icons');
      await page.locator('.activity-site').last().focus();
      const last = await page.locator('.activity-site').last().boundingBox();
      const footer = await page.locator('#delete').boundingBox();
      check(last.y + last.height <= footer.y, 'popup: the final website row can be reached above the fixed action bar');
      await page.locator('#activityPanel').dispatchEvent('wheel', { deltaY: 100 });
      check(await page.locator('#activityPanel').isHidden(), 'popup: scrolling outside website rows still collapses activity');
      await page.locator('#activityDock[data-open="false"] #activityEntry, #activityDock[data-open="true"] #activityCollapse').click();
      await page.locator('#activitySites').evaluate(strip => {
        const touch = y => new Touch({ identifier: 1, target: strip, clientX: 100, clientY: y });
        strip.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(200)] }));
        strip.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [touch(170)] }));
        strip.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
      });
      check(await page.locator('#activityPanel').isVisible(), 'popup: touch exploration within website rows preserves the panel');
    }
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('history-sweep:set-theme', { detail: 'dark' })));
    await page.screenshot({ path: new URL(`${layout}-dark.png`, output).pathname, fullPage: true });
    await page.locator('[data-activity-mode=cleanup]').click();
    await page.locator('#selectAll').click(); await page.locator('#delete').click(); await page.locator('#confirmDialog [value=confirm]').click();
    await page.waitForFunction(() => document.querySelector('#status').dataset.kind === 'done');
    check(await page.locator('.activity-day[aria-pressed=true]').count() === 1, `${layout}: cleanup refresh keeps exactly one available date selected`);
    check((await page.locator('#activityDetail').textContent()).includes('2 次清理 · 83 个页面 · 41 个网站'), `${layout}: deletion immediately refreshes local details`);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('fixture-activity')));
    check(saved.days['2026-10-17'].websites.length === 41 && !JSON.stringify(saved).includes('synthetic=1') && !JSON.stringify(saved).includes('https:'), `${layout}: storage retains summaries without complete URLs`);
    const activitySources = await page.locator('.activity-site img').evaluateAll(nodes => nodes.map(node => new URL(node.src).searchParams.get('pageUrl')));
    check(activitySources.every(url => /^https:\/\/[^/]+\/$/.test(url)), `${layout}: activity favicon lookups contain only domain origins`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(`${checks} activity website-detail assertions passed across manager, popup, modal and 375px layout. Synthetic data only. Screenshots: ${output.pathname}`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
