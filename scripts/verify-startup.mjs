import assert from 'node:assert/strict';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [];
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const records = [{ url: 'https://example.test/notebook', title: 'Design notebook', lastVisitTime: Date.now(), visitCount: 1 }];
const dismissed = page => page.waitForFunction(() => !document.querySelector('#startup') && !document.querySelector('#app').inert);
const scanned = page => page.waitForFunction(() => document.querySelector('#status')?.dataset.kind === 'scanned');

async function open({ layout = 'popup', theme = 'light', reduced = false } = {}) {
  const context = await browser.newContext({ colorScheme: theme === 'dark' ? 'light' : 'dark', reducedMotion: reduced ? 'reduce' : 'no-preference', deviceScaleFactor: 2, viewport: layout === 'popup' ? { width: 440, height: 590 } : { width: 1120, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await installMock(page, records);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/extension/app.mjs', async route => { await gate; await route.continue(); });
  await page.addInitScript(value => localStorage.setItem('theme', value), theme);
  await page.goto(`${origin}/extension/${layout}.html`, { waitUntil: 'commit' });
  await page.locator('#startup').waitFor();
  await page.waitForFunction(() => document.querySelector('.startup-mark').complete);
  return { context, page, release };
}

try {
  browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
  for (const layout of ['popup', 'manager']) for (const theme of ['light', 'dark']) {
    const { context, page, release } = await open({ layout, theme });
    const first = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, background: getComputedStyle(document.querySelector('#startup')).backgroundColor, app: getComputedStyle(document.querySelector('#app')).visibility, inert: document.querySelector('#app').inert, logo: document.querySelector('.startup-mark').naturalWidth }));
    check(first.theme === theme && first.background === (theme === 'dark' ? 'rgb(22, 22, 22)' : 'rgb(242, 242, 242)'), `${layout}: saved ${theme} is applied before application modules load`);
    check(first.app === 'hidden' && first.inert && first.logo > 0, `${layout}: startup covers the uninitialized app with a loaded brand mark`);
    check(await page.locator('.startup-mark').evaluate(node => node.src.endsWith('.svg') && getComputedStyle(node).transform === 'none'), `${layout}: vector logo stays crisp without scaling at 2x pixel density`);
    await page.screenshot({ path: `/private/tmp/history-sweep-startup-${layout}-${theme}.png` });
    release(); await scanned(page); await dismissed(page);
    check(await page.locator('#query').isVisible() && !await page.locator('#search').isDisabled(), `${layout}: initial results reveal an interactive workspace`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${layout}: no horizontal overflow`);
    await page.getByRole('button', { name: '简体中文', exact: true }).click();
    check(await page.locator('#startup').count() === 0, 'language remount does not replay startup');
    check(await page.evaluate(() => window.__deleted.length === 0), 'startup never deletes history');
    await context.close();
  }

  // Keep each real asynchronous startup dependency pending until the test releases it.
  for (const stage of ['protection', 'preferences', 'history']) {
    const { context, page, release } = await open();
    await page.evaluate(stage => {
      let resolve;
      const gate = new Promise(done => { resolve = done; });
      window.__releaseStartup = resolve;
      if (stage === 'protection') {
        const send = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = async message => { if (message.type === 'get-protection') { window.__startupPending = true; await gate; } return send(message); };
      } else if (stage === 'preferences') {
        const get = chrome.storage.local.get;
        chrome.storage.local.get = async key => { if (key === 'browsingPreferences') { window.__startupPending = true; await gate; } return get(key); };
      } else {
        const search = chrome.history.search;
        chrome.history.search = async query => { window.__startupPending = true; await gate; return search(query); };
      }
    }, stage);
    release(); await page.waitForFunction(() => window.__startupPending);
    await page.waitForTimeout(650);
    check(await page.locator('#startup').isVisible() && await page.locator('#app').evaluate(node => node.inert && getComputedStyle(node).visibility === 'hidden'), `slow ${stage}: intermediate workspace stays covered`);
    await page.evaluate(() => window.__releaseStartup()); await scanned(page); await dismissed(page);
    check(await page.locator('.page-title').textContent() === 'Design notebook', `${stage}: loaded history is preserved`);
    await context.close();
  }

  for (const failure of ['background', 'preferences', 'history']) {
    const { context, page, release } = await open({ reduced: true });
    await page.evaluate(failure => {
      if (failure === 'background') window.__backgroundUnavailable = true;
      if (failure === 'preferences') localStorage.setItem('fixture-browsing-preferences', JSON.stringify({ view: 'invalid', range: '7days' }));
      if (failure === 'history') window.__failSearch = true;
    }, failure);
    release(); await dismissed(page);
    const expected = { background: 'reloadExtension', preferences: 'preferencesLoadFailed', history: 'scanFailed' }[failure];
    check(await page.locator('#status').getAttribute('data-kind') === expected, `${failure}: error remains visible after startup`);
    await context.close();
  }

  const reduced = await open({ reduced: true });
  check(await reduced.page.locator('#startup').evaluate(node => node.getAnimations({ subtree: true }).length === 0), 'reduced motion has no decorative animations');
  await reduced.page.evaluate(() => {
    document.addEventListener('history-sweep:startup-ready', () => { window.__startupReadyAt = performance.now(); });
    document.addEventListener('history-sweep:startup-dismissed', () => { window.__startupDismissedAt = performance.now(); });
  });
  reduced.release(); await scanned(reduced.page); await dismissed(reduced.page);
  check(await reduced.page.evaluate(() => window.__startupDismissedAt - window.__startupReadyAt < 250), 'reduced motion skips minimum display time and fade');
  await reduced.context.close();

  const stalled = await open();
  await dismissed(stalled.page);
  check(await stalled.page.locator('#app').evaluate(node => !node.hasAttribute('aria-busy')), 'stalled module cannot leave an inert workspace behind the splash forever');
  stalled.release(); await scanned(stalled.page);
  check(await stalled.page.locator('#startup').count() === 0, 'late application readiness does not replay the dismissed splash');
  await stalled.context.close();

  const denied = await browser.newPage(); await installMock(denied, records);
  await denied.goto(`${origin}/extension/modal.html`); await dismissed(denied);
  check(await denied.locator('.modal-unavailable').isVisible(), 'rejected modal reveals its launch error');
  check(await denied.evaluate(() => !window.__messages.some(message => message.type === 'get-protection')), 'rejected modal never initializes history access');
  await denied.close();
  check(errors.length === 0, `no browser errors: ${errors.join(', ')}`);
  console.log(`Startup checks passed: ${checks}; theme before modules, real loading dependencies, error recovery, reduced motion, language remount and rejected modal.`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
