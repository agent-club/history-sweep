import assert from 'node:assert/strict';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const baseline = process.argv.includes('--baseline');
const records = Array.from({ length: 6000 }, (_, index) => ({
  url: `https://site-${index % 243}.example.test/page-${index}`,
  title: `Synthetic page ${index}`, lastVisitTime: Date.now() - Math.floor(index / 243) * 86400000,
  visitCount: index % 10 + 1,
}));
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let checks = 0;
const check = (ok, message) => { if (!baseline) assert.ok(ok, message); checks++; };
try {
  browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
  for (const layout of ['manager', 'popup', 'modal']) {
    const page = await browser.newPage({ viewport: layout === 'popup' ? { width: 440, height: 590 } : { width: 1280, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await installMock(page, records);
    await page.addInitScript(() => {
      localStorage.setItem('fixture-browsing-preferences', JSON.stringify({ range: 'all', view: 'website' }));
      const getURL = chrome.runtime.getURL;
      chrome.runtime.getURL = path => path === '_favicon/' ? `${location.origin}/extension/icons/icon-32.png` : getURL(path);
    });
    if (layout === 'modal') await page.route('**/extension/manager.html', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
    });
    await page.goto(`${origin}/extension/${layout === 'popup' ? 'popup' : 'manager'}.html`);
    await page.waitForFunction(() => document.querySelector('#status')?.dataset.kind === 'scanned' && !document.querySelector('#search').disabled);
    // The first default-open group is a different path from a warmed expand-all list.
    // Use trusted mouse input and keep the surrounding text nodes as repaint evidence.
    await page.evaluate(() => {
      const group = document.querySelector('.website-group');
      const selectors = ['#count', '#siteCount', '#resultScope', '#filterSummary', '#selectAllLabel', '#selected', '#deleteLabel', '#search span', '#footerSelected', '#selectedSites', '.website-group:nth-child(2) .group-host'];
      const texts = selectors.map(selector => document.querySelector(selector)).filter(Boolean).map(element => ({ element, node: element.firstChild }));
      let mutations = 0;
      const observer = new MutationObserver(entries => { mutations += entries.filter(entry => !group.contains(entry.target)).length; });
      observer.observe(document.querySelector('.app-shell'), { childList: true, subtree: true });
      const bounds = () => ['.app-shell', '.search-panel', '.results-panel', '.results-header', '#resultScroll', '.actionbar'].map(selector => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect(); return [x, y, width, height];
      });
      window.__firstCollapse = { texts, observer, bounds, before: bounds(), frames: [], get mutations() { return mutations; } };
      const probe = window.__firstCollapse;
      const frame = () => { if (probe.observer) { probe.frames.push(bounds()); requestAnimationFrame(frame); } }; requestAnimationFrame(frame);
    });
    await page.locator('.group-toggle').first().click();
    await page.evaluate(() => new Promise(resolve => { let frames = 12; const step = () => --frames ? requestAnimationFrame(step) : resolve(); requestAnimationFrame(step); }));
    const first = await page.evaluate(() => {
      const probe = window.__firstCollapse; probe.observer.disconnect(); probe.observer = null;
      return {
        retainedText: probe.texts.every(({ element, node }) => element.firstChild === node), mutations: probe.mutations,
        stableBounds: probe.frames.every(frame => frame.every((bounds, index) => bounds.every((value, axis) => Math.abs(value - probe.before[index][axis]) < 1))),
        closed: document.querySelector('.group-toggle').getAttribute('aria-expanded') === 'false',
      };
    });
    console.log(`${layout} first collapse: ${JSON.stringify(first)}`);
    check(first.closed && first.retainedText && first.mutations === 0, `${layout}: first collapse does not replace surrounding text or icons`);
    check(first.stableBounds, `${layout}: first collapse keeps the surrounding panel bounds stable across frames`);
    // Expanding locally must still apply stale-query restrictions to newly created rows.
    await page.locator('#query').fill('unsubmitted draft');
    await page.locator('.group-toggle').first().click();
    const stale = await page.locator('.website-group').first().evaluate(group => [...group.querySelectorAll('.row-select, .row-delete')].every(control => control.disabled));
    check(stale, `${layout}: newly expanded rows remain blocked while search criteria are stale`);
    await page.locator('#query').fill('');
    await page.locator('#groupBySite').click();
    await page.locator('#expandGroups').click();
    await page.evaluate(() => document.fonts.ready);
    const result = await page.evaluate(async () => {
      const scroll = document.getElementById('resultScroll');
      const groups = document.getElementById('groups');
      const target = groups.children[1];
      const toggle = target.querySelector('.group-toggle');
      scroll.scrollTop = target.offsetTop - groups.offsetTop;
      toggle.focus({ preventScroll: true });
      const sibling = groups.children[2];
      const row = sibling.querySelector('.history-row');
      const favicon = sibling.querySelector('.group-favicon');
      const top = scroll.scrollTop;
      let added = 0, removed = 0;
      const observer = new MutationObserver(entries => { for (const entry of entries) { added += entry.addedNodes.length; removed += entry.removedNodes.length; } });
      observer.observe(groups, { childList: true, subtree: true });
      const start = performance.now();
      toggle.click();
      const elapsed = performance.now() - start;
      await new Promise(requestAnimationFrame);
      const retained = sibling.isConnected && row.isConnected && favicon.isConnected;
      const focused = document.activeElement === toggle;
      const scrollDelta = scroll.scrollTop - top;
      const heightAnimations = groups.getAnimations({ subtree: true }).filter(animation => animation.effect.getKeyframes().some(frame => 'height' in frame)).length;
      observer.disconnect();
      return { elapsed: Math.round(elapsed * 100) / 100, added, removed, retained, focused, scrollDelta, heightAnimations };
    });
    console.log(`${layout}: ${JSON.stringify(result)}`);
    check(result.retained, `${layout}: toggling retains other groups, rows and favicons`);
    check(result.focused, `${layout}: toggle retains keyboard focus`);
    check(Math.abs(result.scrollDelta) <= 1, `${layout}: toggle retains scroll position away from the bottom`);
    check(!result.heightAnimations, `${layout}: no layout animation on accordion height`);
    const selection = await page.evaluate(() => {
      const row = document.querySelector('.history-row');
      const group = document.querySelector('.website-group');
      document.getElementById('selectAll').click();
      const selected = document.querySelectorAll('.row-select:checked').length;
      document.getElementById('clear').click();
      return { retained: row.isConnected && group.isConnected, selected, remaining: document.querySelectorAll('.row-select:checked').length };
    });
    check(selection.retained && selection.selected > 0 && selection.remaining === 0, `${layout}: bulk selection updates existing rows`);
    await page.locator('#expandGroups').click();
    const more = await page.evaluate(() => {
      const row = document.querySelector('.history-row');
      const group = document.querySelector('.website-group');
      document.getElementById('loadMore').click();
      return group.isConnected && row.isConnected;
    });
    check(more, `${layout}: loading more sites retains existing groups`);
    await page.locator('#groupByDate').click();
    await page.locator('#expandGroups').click();
    const date = await page.evaluate(() => {
      const days = document.querySelectorAll('.date-group');
      const toggle = days[0].querySelector('.date-toggle');
      const sibling = days[1];
      const site = sibling.querySelector('.website-group');
      toggle.focus({ preventScroll: true }); toggle.click(); toggle.click();
      return sibling.isConnected && site.isConnected && document.activeElement === toggle;
    });
    check(date, `${layout}: date toggles retain other days and focus`);
    const pagination = await page.evaluate(() => {
      const day = document.querySelector('.date-group');
      const site = day.querySelector('.website-group');
      day.querySelector(':scope > .date-results > .group-load-more').click();
      const retained = site.isConnected;
      const group = day.querySelector('.website-group');
      const row = group.querySelector('.history-row');
      group.querySelector('.group-load-more')?.click();
      return retained && (!row || row.isConnected);
    });
    check(pagination, `${layout}: nested pagination appends without replacing existing groups and rows`);
    if (layout === 'manager') {
      const activity = await page.evaluate(async () => {
        const { browsingActivityAsync } = await import('./activity-calendar.mjs');
        const records = Array.from({ length: 100000 }, (_, index) => ({ url: `https://site-${index % 243}.example.test/page-${index}`, lastVisitTime: Date.now() - index * 1000 }));
        let responsive = false;
        // scheduler.yield prioritizes continuations over ordinary timers. Probe
        // an input-priority task, which must run before aggregation completes.
        const input = scheduler.postTask(() => { responsive = true; }, { priority: 'user-blocking' });
        const days = await browsingActivityAsync(records);
        const yielded = responsive;
        await input;
        return { yielded, pages: Object.values(days).reduce((sum, day) => sum + day.pages, 0) };
      });
      check(activity.pages === 100000 && activity.yielded, '100k activity aggregation yields to browser input without losing pages');
    }
    check(!errors.length, `${layout}: no runtime errors: ${errors.join('; ')}`);
    await page.close();
  }
  console.log(`${checks} performance regression assertions${baseline ? ' observed (baseline)' : ' passed'}. Synthetic history only.`);
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
