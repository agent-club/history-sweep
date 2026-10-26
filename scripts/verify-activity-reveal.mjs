import assert from 'node:assert/strict';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const records = Array.from({ length: 84 }, (_, index) => ({
  id: String(index), url: `https://example.com/item-${index}`, title: `Synthetic history ${index + 1}`,
  lastVisitTime: Date.UTC(2026, 9, 17, 12) - index * 3600000, visitCount: index % 4 + 1,
}));
let browser, checks = 0;
const errors = [];
const check = (condition, message) => { assert.ok(condition, message); checks++; };
async function ready(page) {
  await page.waitForFunction(() => document.querySelector('#search') && !document.querySelector('#search').disabled);
  await page.clock.runFor(700);
  await page.waitForFunction(() => !document.querySelector('#app').inert);
}
async function settled(page) {
  await page.clock.runFor(500);
  await page.waitForFunction(() => document.querySelector('#activityDock').dataset.settled === 'true');
}
async function open(page) {
  await page.locator('#activityEntry').click();
  await page.waitForFunction(() => document.querySelector('#activityPanel').getAttribute('aria-busy') === 'false');
  await settled(page);
}
async function hoverList(page) {
  const list = page.locator('#resultScroll');
  await list.evaluate(node => node.scrollIntoView({ block: 'nearest' }));
  const point = await list.evaluate(node => {
    const box = node.getBoundingClientRect(), footer = document.querySelector('.actionbar').getBoundingClientRect();
    const top = Math.max(box.top + 8, document.querySelector('.topbar').getBoundingClientRect().bottom + 8);
    const bottom = Math.min(box.bottom - 8, innerHeight - 8, footer.top - 8);
    return { x: box.x + box.width / 2, y: (top + bottom) / 2, visible: bottom > top };
  });
  assert.ok(point.visible, 'history has a visible scroll target above the fixed footer');
  await page.mouse.move(point.x, point.y);
}
async function swipe(page, selector, distance) {
  const box = await page.locator(selector).boundingBox();
  const point = { x: box.x + box.width - 8, y: Math.max(85, Math.min(450, box.y + Math.min(60, box.height / 2))) };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y + distance }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach(); await settled(page);
}

async function verify(page, layout, reducedMotion, coarse, viewport) {
  const dock = page.locator('#activityDock'), entry = page.locator('#activityEntry'), panel = page.locator('#activityPanel');
  const list = page.locator('#resultScroll');
  check(await panel.isHidden() && await entry.isVisible(), `${layout} starts with the permanent compact entry`);
  check((await dock.boundingBox()).height === (coarse ? 44 : 32), `${layout} compact entry respects desktop and touch target sizes`);
  check((await entry.textContent()).includes('展开分析'), `${layout} entry explains its click action`);
  await page.locator('#query').fill('example.com'); await page.locator('#search').click(); await ready(page);
  if (await page.locator('.date-toggle[aria-expanded=false], .group-toggle[aria-expanded=false]').count()) await page.locator('#expandGroups').click();
  if (await page.locator('.group-load-more').count()) await page.locator('.group-load-more').first().click();
  const geometry = await list.evaluate(node => ({ height: node.clientHeight, total: node.scrollHeight }));
  check(geometry.total > geometry.height, `${layout} fixture provides a real scrollable history list`);
  await list.evaluate(node => { node.scrollTop = 0; });
  await hoverList(page);
  await page.mouse.wheel(0, -600); await settled(page);
  check(await panel.isHidden(), `${layout} scrolling down at the top does not open analysis`);
  await page.waitForTimeout(200);
  await hoverList(page);
  await page.mouse.wheel(0, 260);
  await page.waitForFunction(() => document.querySelector('#resultScroll').scrollTop > 0);
  check(await panel.isHidden(), `${layout} normal history scrolling leaves analysis collapsed`);
  await list.evaluate(node => { node.scrollTop = 0; });
  await page.locator('.app-shell').evaluate(node => { node.scrollTop = 0; });
  await swipe(page, '#activityEntry', 60);
  check(await panel.isHidden(), `${layout} a swipe over the compact entry is not treated as activation`);
  await entry.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#activityPanel').getAttribute('aria-busy') === 'false');
  await settled(page);
  check(await panel.isVisible() && await entry.getAttribute('aria-expanded') === 'true', `${layout} keyboard activation opens the actual activity panel`);
  check(await page.locator('#activityCollapse').innerText() === '收起分析', `${layout} the close control has a visible text label`);
  const close = await page.locator('#activityCollapse').boundingBox();
  const scope = await page.locator('#activityScope').boundingBox();
  check(close.height >= (coarse ? 44 : 28), `${layout} collapse control has an adequate target`);
  check(!scope || scope.y + scope.height <= close.y + 1, `${layout} the close control does not overlap the activity explanation`);
  check(await page.locator('.activity-day').count() > 0, `${layout} disclosure loads the real calendar`);
  const day = page.locator('.activity-day[aria-pressed=true]').first();
  if (await day.count()) await day.evaluate(node => { node.dataset.keptNode = 'true'; });
  const navigation = (await page.locator('.topbar').boundingBox()).y;
  await page.mouse.move((await panel.boundingBox()).x + 10, 150);
  for (const delta of [400, -600, 180]) { await page.mouse.wheel(0, delta); await settled(page); }
  check(await panel.isVisible() && await entry.getAttribute('aria-expanded') === 'true', `${layout} scrolling in either direction keeps explicitly opened analysis open`);
  check(Math.abs((await page.locator('.topbar').boundingBox()).y - navigation) < 1, `${layout} top navigation stays fixed while content scrolls`);
  await page.locator('.app-shell').evaluate(node => { node.scrollTop = 0; });
  await swipe(page, '#activityPanel', -60); await swipe(page, '#activityPanel', 60);
  check(await panel.isVisible(), `${layout} vertical touch scrolling does not collapse analysis`);
  await page.locator('.app-shell').evaluate(node => { node.scrollTop = 0; });
  await list.evaluate(node => { node.scrollTop = 120; });
  const position = await list.evaluate(node => node.scrollTop);
  await page.locator('#activityCollapse').click(); await settled(page);
  check(await panel.isHidden() && await entry.isVisible(), `${layout} clicking the visible close control collapses analysis`);
  check(await page.evaluate(() => localStorage.getItem('activityOpen')) === 'false', `${layout} explicit close is persisted`);
  await open(page);
  check(Math.abs(await list.evaluate(node => node.scrollTop) - position) < 1, `${layout} toggling analysis retains the history list position`);
  check(await page.locator('#query').inputValue() === 'example.com' && await page.locator('#groupByDate').getAttribute('aria-pressed') === 'true', `${layout} query and grouping are retained`);
  if (await day.count()) check(await page.locator('.activity-day[data-kept-node=true]').count() === 1, `${layout} reopen retains the cached calendar node`);
  await panel.evaluate(node => { const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); event.preventDefault(); node.dispatchEvent(event); });
  check(await panel.isVisible(), `${layout} an already-handled Escape is respected`);
  await page.locator('.activity-day:not([disabled])').first().focus(); await page.keyboard.press('Escape'); await settled(page);
  check(await panel.isHidden() && await entry.evaluate(node => node === document.activeElement), `${layout} Escape closes and returns focus to the entry`);
  await entry.focus(); await page.keyboard.press('Space'); await settled(page);
  check(await panel.isVisible(), `${layout} Space activates the compact entry`);
  check(await page.evaluate(() => localStorage.getItem('activityOpen')) === 'true', `${layout} explicit open is persisted`);
  await page.reload(); await ready(page);
  check(await panel.isVisible(), `${layout} reopening the view restores the explicit open state`);
  await page.locator('#activityCollapse').click(); await settled(page);
  await page.reload(); await ready(page);
  check(await panel.isHidden(), `${layout} reopening the view restores the explicit closed state`);
  await entry.focus(); await page.keyboard.press('ArrowDown'); await settled(page);
  check(await panel.isVisible(), `${layout} ArrowDown remains available as a keyboard shortcut`);
  if (reducedMotion === 'reduce') check(await dock.evaluate(node => getComputedStyle(node).transitionDuration.split(',').every(value => parseFloat(value) === 0)), `${layout} reduced motion disables the height animation`);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${layout} disclosure has no horizontal overflow`);
  check(await page.locator('#delete').evaluate(node => node.getBoundingClientRect().bottom <= innerHeight), `${layout} the primary action stays reachable`);
  if (coarse) {
    await page.locator('[data-language=en]').click(); await settled(page);
    check(await page.locator('#activityCollapse').innerText() === 'Collapse analysis', 'English disclosure controls are localized');
    const bounds = await page.locator('#activityCollapse').boundingBox();
    check(bounds.x >= 0 && bounds.x + bounds.width <= viewport.width, 'the English close label fits a narrow touch layout');
  }
  if (process.env.HISTORY_SWEEP_CAPTURE_DIR && reducedMotion === 'no-preference') {
    await page.locator('.app-shell').evaluate(node => { node.scrollTop = 0; });
    // The fixture clock advances JS timers; let native CSS opacity transitions finish for screenshots.
    await dock.evaluate(node => Promise.all(node.getAnimations({ subtree: true }).filter(animation => animation.transitionProperty === 'opacity').map(animation => animation.finished.catch(() => {}))));
    await page.screenshot({ path: `${process.env.HISTORY_SWEEP_CAPTURE_DIR}/${layout}-analysis-open.png` });
    await page.locator('#activityCollapse').click(); await settled(page);
    await dock.evaluate(node => Promise.all(node.getAnimations({ subtree: true }).filter(animation => animation.transitionProperty === 'opacity').map(animation => animation.finished.catch(() => {}))));
    await page.screenshot({ path: `${process.env.HISTORY_SWEEP_CAPTURE_DIR}/${layout}-analysis-closed.png` });
  }
}

try {
  browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
  for (const [layout, viewport] of [['manager', { width: 1120, height: 900 }], ['popup', { width: 440, height: 590 }], ['modal', { width: 1040, height: 720 }]]) {
    for (const reducedMotion of ['no-preference', 'reduce']) {
      const coarse = layout === 'popup' && reducedMotion === 'reduce';
      const context = await browser.newContext({ viewport, reducedMotion, hasTouch: coarse, timezoneId: 'Asia/Shanghai' });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.install({ time: new Date('2026-10-17T12:00:00+08:00') });
      await installMock(page, records);
      await page.addInitScript(() => {
        localStorage.setItem('language', 'zh-CN');
        localStorage.setItem('fixture-browsing-preferences', JSON.stringify({ view: 'date', range: 'all' }));
      });
      await page.route('**/*', async route => {
        if (!route.request().url().startsWith(origin)) return route.abort();
        if (layout === 'modal' && route.request().url().endsWith('/extension/manager.html')) {
          const response = await route.fetch();
          return route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
        }
        return route.continue();
      });
      await page.goto(`${origin}/extension/${layout === 'popup' ? 'popup' : 'manager'}.html`); await ready(page);
      await verify(page, layout, reducedMotion, coarse, viewport);
      check(errors.length === 0, `no page errors in ${layout}: ${errors.join('; ')}`);
      await context.close();
    }
  }
  console.log(`${checks} click-disclosure assertions passed. Manager, popup, modal, touch, keyboard and reduced motion; synthetic history only.`);
} catch (error) {
  if (errors.length) console.error(`Browser errors: ${errors.join('; ')}`);
  throw error;
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
