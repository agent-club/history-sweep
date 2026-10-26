import assert from 'node:assert/strict';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const server = createServer(), frameServer = createServer();
await Promise.all([server, frameServer].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
const origin = `http://127.0.0.1:${server.address().port}`;
const frameOrigin = `http://127.0.0.1:${frameServer.address().port}`;
const records = Array.from({ length: 120 }, (_, index) => ({
  url: `https://example.test/page-${index}`, title: `Synthetic history ${index}`, lastVisitTime: Date.now(), visitCount: 1,
}));
let browser, checks = 0;
const errors = [];
const check = (condition, message) => { assert.ok(condition, message); checks++; };
try {
  browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await installMock(page, records);
  await page.addInitScript(() => localStorage.setItem('fixture-browsing-preferences', JSON.stringify({ view: 'date', range: 'all' })));
  await page.route(`${origin}/extension/modal-host.mjs`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace("if (!hadInlineStyle && page.style.length === 0) page.removeAttribute('style');", "globalThis.__scrollDebug = { hadInlineStyle, length: page.style.length }; if (!hadInlineStyle && page.style.length === 0) page.removeAttribute('style'); globalThis.__scrollDebug.after = page.getAttribute('style');") });
  });
  await page.route(`${origin}/scroll-host`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html style="overflow-x: clip !important; overflow-y: scroll; overscroll-behavior-y: contain !important; color: rgb(10, 20, 30)"><body style="margin:0;height:5000px"><button id="previous">Previous focus</button><h1>Synthetic scroll host</h1></body></html>' }));
  await page.route(`${frameOrigin}/extension/manager.html`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
  });
  await page.goto(`${origin}/scroll-host`);
  await page.locator('#previous').focus();
  await page.evaluate(() => window.scrollTo(0, 600));
  const before = await page.evaluate(() => ({ x: scrollX, y: scrollY, css: document.documentElement.style.cssText }));
  async function openModal() {
    const navigation = page.waitForEvent('framenavigated', { predicate: frame => frame.url().startsWith(`${frameOrigin}/extension/manager.html`) });
    await page.evaluate(async ({ origin, url }) => {
      const { injectModal } = await import(`${origin}/extension/modal-host.mjs`); injectModal(url);
    }, { origin, url: `${frameOrigin}/extension/manager.html` });
    await page.waitForFunction(() => globalThis.__historySweepModalHost?.isConnected());
    const frame = await navigation;
    await frame.waitForSelector('.date-header');
    return frame;
  }
  async function wheelStable(x, y, deltaY, label) {
    await page.mouse.move(x, y); await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(180);
    check(await page.evaluate(() => scrollY) === before.y, label);
  }
  let frame = await openModal();
  check(await page.evaluate(() => scrollY) === before.y, 'opening preserves the background position');
  await wheelStable(20, 450, 500, 'backdrop wheel cannot scroll the background down');
  await wheelStable(20, 450, -500, 'backdrop wheel cannot scroll the background up');
  if (await frame.locator('.date-toggle[aria-expanded=false], .group-toggle[aria-expanded=false]').count()) await frame.locator('#expandGroups').click();
  await frame.locator('.group-load-more').first().click();
  const list = frame.locator('#resultScroll');
  const box = await list.boundingBox();
  await list.evaluate(node => { node.scrollTop = 0; });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, 200);
  await page.waitForTimeout(180);
  check(await list.evaluate(node => node.scrollTop > 0), 'the iframe history list still scrolls normally');
  await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await wheelStable(box.x + box.width / 2, box.y + box.height / 2, 600, 'iframe lower boundary cannot chain scroll to the background');
  await list.evaluate(node => { node.scrollTop = 0; });
  await wheelStable(box.x + box.width / 2, box.y + box.height / 2, -600, 'iframe upper boundary cannot chain scroll to the background');
  check(await frame.locator('#activityPanel').isHidden(), 'top-boundary wheel does not open analysis');
  await frame.locator('#activityEntry').click();
  await frame.waitForFunction(() => document.querySelector('#activityPanel').getAttribute('aria-busy') === 'false');
  await frame.locator('#activityTitle').hover(); await page.mouse.wheel(0, 200);
  check(await frame.locator('#activityPanel').isVisible(), 'wheel keeps explicitly opened analysis open');
  await frame.locator('#activityCollapse').click();
  await frame.waitForFunction(() => document.querySelector('#activityPanel').hidden);
  check(await page.evaluate(() => scrollY) === before.y, 'collapsing activity by button does not move the background');
  const prevented = await page.evaluate(() => {
    const event = new Event('touchmove', { bubbles: true, cancelable: true });
    document.documentElement.dispatchEvent(event); return event.defaultPrevented;
  });
  check(prevented, 'host touch scrolling is blocked while the modal is open');
  await page.evaluate(() => { document.documentElement.style.setProperty('outline-color', 'rgb(30, 40, 50)'); globalThis.__historySweepModalHost.close(); });
  await page.waitForFunction(() => !globalThis.__historySweepModalHost);
  const after = await page.evaluate(() => ({ y: scrollY, css: document.documentElement.style.cssText, focused: document.activeElement.id }));
  check(after.y === before.y && after.focused === 'previous', 'closing preserves background position and restores focus');
  await page.evaluate(() => document.documentElement.style.removeProperty('outline-color'));
  check(await page.evaluate(() => document.documentElement.style.cssText) === before.css, 'original inline overflow values and priorities are restored');
  check(after.css.includes('outline-color'), 'unrelated host style edits are preserved');
  await page.mouse.move(20, 450); await page.mouse.wheel(0, 300); await page.waitForTimeout(180);
  check(await page.evaluate(() => scrollY > 600), 'background scrolling works again after closing');
  await page.evaluate(() => window.scrollTo(0, 600));
  frame = await openModal();
  await page.evaluate(async ({ origin, url }) => {
    const { injectModal } = await import(`${origin}/extension/modal-host.mjs`); injectModal(url);
  }, { origin, url: `${frameOrigin}/extension/manager.html` });
  await page.waitForFunction(() => !globalThis.__historySweepModalHost);
  check(await page.evaluate(() => document.documentElement.style.cssText) === before.css, 'launcher toggle also releases the scroll lock');
  frame = await openModal();
  await frame.locator('#openPreferences').click();
  await page.mouse.click(20, 450);
  await frame.waitForFunction(() => !document.querySelector('#preferencesDialog').open);
  check(await page.evaluate(() => globalThis.__historySweepModalHost?.isConnected()), 'first backdrop click dismisses the child dialog and keeps the outer modal');
  await wheelStable(20, 450, 300, 'scroll lock remains after dismissing a child dialog');
  await page.mouse.click(20, 450);
  await page.waitForFunction(() => !globalThis.__historySweepModalHost);
  check(await page.evaluate(() => document.documentElement.style.cssText) === before.css, 'normal backdrop dismissal restores the original scrolling styles');
  await page.evaluate(() => document.documentElement.removeAttribute('style'));
  await openModal(); await page.evaluate(() => globalThis.__historySweepModalHost.close());
  await page.waitForFunction(() => !globalThis.__historySweepModalHost);
  const remainingStyle = await page.evaluate(() => document.documentElement.getAttribute('style'));
  check(remainingStyle === null, `a host with no inline styles retains no style attribute after closing: ${remainingStyle}; ${JSON.stringify(await page.evaluate(() => globalThis.__scrollDebug))}`);
  check(errors.length === 0, `no runtime errors: ${errors.join('; ')}`);
  console.log(`${checks} modal scroll assertions passed. Cross-origin local iframe and synthetic history only.`);
} finally {
  await browser?.close(); await Promise.all([server, frameServer].map(server => new Promise(resolve => server.close(resolve))));
}
