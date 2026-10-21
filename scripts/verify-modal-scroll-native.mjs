import assert from 'node:assert/strict';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';

const { chromium } = dependency('playwright');
const temporary = await mkdtemp(join(tmpdir(), 'history-sweep-scroll-native-'));
const extension = join(temporary, 'extension');
const server = createServer();
let context, checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
try {
  await cp(fileURLToPath(new URL('../extension/', import.meta.url)), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  // Grant localhost only in this disposable fixture copy, without changing the repository manifest.
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    executablePath: process.env.HISTORY_SWEEP_CHROMIUM,
    channel: process.env.HISTORY_SWEEP_CHROMIUM ? undefined : 'chromium',
    headless: true, viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await context.addInitScript(() => {
    window.startupQueryFocuses = 0;
    window.startupDisabledControls = [];
    document.addEventListener('focusin', event => { if (event.target.id === 'query') window.startupQueryFocuses++; });
    document.addEventListener('history-sweep:startup-dismissed', () => {
      // A startup focus used to schedule a second scan after the workspace was visible.
      new MutationObserver(changes => {
        for (const { target } of changes) if (target.matches('#search, #language button, .group-view') && target.disabled) window.startupDisabledControls.push(target.id || target.dataset.language);
      }).observe(document.getElementById('app'), { subtree: true, attributes: true, attributeFilter: ['disabled'] });
    }, { once: true });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const control = await context.newPage();
  await control.goto(`chrome-extension://${id}/manager.html`);
  await control.waitForFunction(() => document.querySelector('#search') && !document.querySelector('#search').disabled);
  await control.evaluate(async () => {
    for (let i = 0; i < 120; i++) await chrome.history.addUrl({ url: `https://native-scroll.example.test/page-${i}` });
  });
  const host = await context.newPage();
  await host.route('**/native-scroll-host*', route => {
    const nested = new URL(route.request().url()).searchParams.has('nested');
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><style>html,body{margin:0;${nested ? 'height:100%;overflow:hidden' : ''}}#content{${nested ? 'height:100%;overflow:auto' : ''}}.long{height:6000px}</style></head><body><main id="content"><div class="long">Synthetic host</div></main></body></html>` });
  });
  const position = () => host.evaluate(() => ({ root: scrollY, nested: document.getElementById('content').scrollTop }));
  async function wheel(x, y, dy) {
    await host.mouse.move(x, y); await host.mouse.wheel(0, dy); await host.waitForTimeout(180);
  }
  for (const nested of [false, true]) {
    await host.emulateMedia({ reducedMotion: nested ? 'reduce' : 'no-preference' });
    await host.goto(`${origin}/native-scroll-host${nested ? '?nested' : ''}`);
    await host.evaluate(nested => { if (nested) document.getElementById('content').scrollTop = 700; else window.scrollTo(0, 700); }, nested);
    const before = await position();
    await host.bringToFront();
    const navigation = host.waitForEvent('framenavigated', { predicate: frame => frame.url().startsWith(`chrome-extension://${id}/modal.html`) });
    await control.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const fixtureLaunch = crypto.randomUUID();
      await chrome.storage.session.set({ modalLaunchSessions: { [fixtureLaunch]: { tabId: tab.id, expires: Date.now() + 60000 } } });
      const { injectModal } = await import('./modal-host.mjs');
      const url = new URL(chrome.runtime.getURL('modal.html')); url.hash = new URLSearchParams({ launch: fixtureLaunch });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: injectModal, args: [url.href] });
    });
    const frame = await navigation;
    await frame.waitForSelector('.date-header, .group-header');
    await frame.waitForFunction(() => !document.getElementById('startup'));
    await host.waitForTimeout(400);
    check(await frame.evaluate(() => window.startupQueryFocuses === 0), 'modal startup never focuses the search input');
    check(await frame.evaluate(() => window.startupDisabledControls.length === 0), 'revealed startup controls stay enabled without a redundant focus refresh');
    // The native dialog's close button participates in the same tab order as the iframe.
    for (let tab = 0; tab < 4 && await frame.evaluate(() => !document.hasFocus() || document.activeElement === document.body); tab++) await host.keyboard.press('Tab');
    check(await frame.evaluate(() => document.hasFocus() && document.activeElement !== document.body), 'modal controls remain reachable by keyboard');
    await frame.locator('#query').fill('native-scroll.example.test');
    await frame.locator('#query').press('Enter');
    await frame.waitForFunction(() => document.getElementById('status').dataset.kind === 'scanned' && !document.getElementById('search').disabled);
    check(await frame.locator('.date-header, .group-header').count() > 0, 'manual input and keyboard search still find history');
    await wheel(20, 450, 400);
    check(JSON.stringify(await position()) === JSON.stringify(before), `${nested ? 'nested' : 'root'} host: backdrop wheel stays isolated`);
    const list = frame.locator('#resultScroll'), box = await list.boundingBox();
    for (const [edge, delta] of [['top', -800], ['bottom', 800]]) {
      await list.evaluate((node, edge) => { node.scrollTop = edge === 'top' ? 0 : node.scrollHeight; }, edge);
      await wheel(box.x + box.width / 2, box.y + box.height / 2, delta);
      check(JSON.stringify(await position()) === JSON.stringify(before), `${nested ? 'nested' : 'root'} host: iframe ${edge} boundary stays isolated`);
    }
    await frame.locator('#toggleActivity').click();
    await frame.waitForFunction(() => document.querySelector('#activityPanel').getAttribute('aria-busy') === 'false');
    await frame.locator('#activityTitle').hover(); await host.mouse.wheel(0, 800);
    await frame.waitForFunction(() => document.querySelector('#activityPanel').hidden);
    check(JSON.stringify(await position()) === JSON.stringify(before), `${nested ? 'nested' : 'root'} host: activity collapse stays isolated`);
    const detached = host.waitForEvent('framedetached', { predicate: item => item === frame });
    await host.mouse.click(20, 450); await detached;
    await wheel(20, 450, 300);
    const after = await position();
    check(nested ? after.nested > before.nested : after.root > before.root, `${nested ? 'nested' : 'root'} host: scrolling resumes after closing`);
  }
  console.log(`${checks} real-extension scroll assertions passed with isolated-world injection. Disposable profile only.`);
} finally {
  await context?.close(); if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
