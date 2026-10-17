import assert from 'node:assert/strict';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';
const { chromium } = dependency('playwright');
const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
let checks = 0;
const check = (ok, message) => { assert.ok(ok, message); checks++; };
const ready = page => page.waitForFunction(() => !document.querySelector('#search').disabled && document.querySelector('#status').dataset.kind === 'scanned');
const idle = page => page.locator('#search').evaluate(button => { const style = getComputedStyle(button, '::before'); return { name: style.animationName, duration: style.animationDuration, iterations: style.animationIterationCount, state: style.animationPlayState, visibility: style.visibility, display: style.display }; });
const errors = [];
try {
  for (const layout of ['popup', 'manager', 'modal']) {
    const context = await browser.newContext({ viewport: layout === 'popup' ? { width: 440, height: 590 } : { width: 1120, height: 800 } });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await installMock(page, [{ url: 'https://motion.test/illustrative', title: 'Illustrative motion test', lastVisitTime: Date.now(), visitCount: 1 }]);
    if (layout === 'modal') await page.route('**/extension/manager.html', async route => {
      const response = await route.fetch(); await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
    });
    await page.goto(`${origin}/extension/${layout === 'popup' ? 'popup' : 'manager'}.html`); await ready(page);
    const initial = await idle(page);
    check(initial.name === 'search-idle-sweep' && initial.duration === '7.2s' && initial.iterations === 'infinite' && initial.state === 'running', `${layout}: idle sweep runs slowly without input`);
    const before = await page.locator('#search').boundingBox();
    await page.evaluate(() => {
      const original = chrome.history.search;
      chrome.history.search = options => { window.motionSearchStarted = true; return new Promise(resolve => { window.finishMotionSearch = () => resolve(original(options)); }); };
    });
    await page.locator('#search').click({ position: { x: 24, y: 16 } });
    check(await page.evaluate(() => window.motionSearchStarted), 'query starts immediately while ripple is still running');
    check(await page.locator('#search .search-ripple').count() === 1, 'pointer activation creates one ripple');
    check(await page.locator('#search .search-ripple').evaluate(node => node.getAttribute('aria-hidden') === 'true' && getComputedStyle(node).pointerEvents === 'none'), 'decorative ripple cannot intercept input or add an accessible label');
    const busy = await idle(page);
    check(busy.state === 'paused' && busy.visibility === 'hidden', 'busy search pauses and hides idle motion');
    await page.evaluate(() => window.finishMotionSearch()); await ready(page);
    await page.waitForTimeout(600);
    check(await page.locator('#search .search-ripple').count() === 0, 'finished ripple removes its temporary node');
    check((await idle(page)).state === 'running', 'idle motion resumes after search');
    const after = await page.locator('#search').boundingBox();
    check(before.width === after.width && before.height === after.height, 'motion does not change button dimensions');
    await page.locator('#search').focus(); await page.locator('#search').press('Enter');
    check(await page.locator('#search .search-ripple').count() === 1, 'keyboard activation also produces a ripple');
    await page.evaluate(() => window.finishMotionSearch()); await ready(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.querySelector('#search').dataset.motionActive === 'false');
    check((await idle(page)).display === 'none' && await page.locator('#search .search-ripple').count() === 0, 'reduced motion suppresses both effects');
    await page.locator('#search').press('Enter');
    check(await page.locator('#search .search-ripple').count() === 0, 'reduced-motion keyboard search remains static');
    await page.evaluate(() => window.finishMotionSearch()); await ready(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(() => document.querySelector('#search').dataset.motionActive === 'true');
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    check((await idle(page)).state === 'paused' && (await idle(page)).visibility === 'hidden', 'inactive page pauses idle motion');
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    check((await idle(page)).state === 'running', 'returning page resumes idle motion');
    await page.getByRole('button', { name: '简体中文', exact: true }).click();
    check(await page.locator('#search > span:not(.search-ripple)').textContent() === '搜索历史', 'language remount keeps the search label intact');
    await page.locator('#search').click();
    check(await page.locator('#search .search-ripple').count() === 1, 'remounted search has one feedback handler');
    await page.evaluate(() => window.finishMotionSearch()); await ready(page);
    check(await page.evaluate(() => window.__deleted.length) === 0, 'motion never deletes history');
    await context.close();
  }
  check(errors.length === 0, `no runtime errors: ${errors.join(', ')}`);
  console.log(`${checks} search-motion assertions passed. Synthetic records only.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
