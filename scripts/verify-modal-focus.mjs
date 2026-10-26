import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { injectModal } from '../extension/modal-host.mjs';

const { chromium } = dependency('playwright');
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-modal-focus-'));
const server = createServer();
const autofocusWarnings = [];
const errors = [];
let context;

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.HISTORY_SWEEP_CHROMIUM,
    channel: process.env.HISTORY_SWEEP_CHROMIUM ? undefined : 'chromium', headless: true,
    viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionOrigin = `chrome-extension://${new URL(worker.url()).hostname}`;
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  // Browser policy warnings are Log entries, rather than JavaScript exceptions.
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (/Blocked autofocusing/i.test(entry.text)) autofocusWarnings.push(entry.text);
  });
  await cdp.send('Log.enable');
  page.setDefaultTimeout(6000);
  await page.addInitScript(() => { localStorage.setItem('language', 'en'); });
  const localUrl = `http://127.0.0.1:${server.address().port}/site/`;
  await page.goto(localUrl);
  await page.bringToFront();
  // This launch identifier and history entry exist only in the disposable test profile.
  const syntheticLaunchId = crypto.randomUUID();
  await worker.evaluate(async ({ syntheticLaunchId, localUrl }) => {
    await chrome.history.addUrl({ url: localUrl });
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.storage.session.set({ modalLaunchSessions: { [syntheticLaunchId]: { tabId: tab.id, expires: Date.now() + 60000 } } });
  }, { syntheticLaunchId, localUrl });
  const navigation = page.waitForEvent('framenavigated', { predicate: frame => frame.url().startsWith(`${extensionOrigin}/modal.html`) });
  await page.evaluate(injectModal, `${extensionOrigin}/modal.html#launch=${syntheticLaunchId}`);
  await navigation;
  const frame = page.frames().find(frame => frame.url().startsWith(`${extensionOrigin}/modal.html`));
  const frameCdp = await context.newCDPSession(frame);
  frameCdp.on('Log.entryAdded', ({ entry }) => {
    if (/Blocked autofocusing/i.test(entry.text)) autofocusWarnings.push(entry.text);
  });
  await frameCdp.send('Log.enable');
  await frame.waitForFunction(() => document.querySelector('#search') && !document.querySelector('#search').disabled);
  assert.deepEqual(autofocusWarnings, [], 'mount must not queue blocked autofocus');

  for (const language of ['zh-CN', 'en']) {
    await frame.locator(`#language [data-language="${language}"]`).click();
    await frame.waitForFunction(language => document.documentElement.lang === language, language);
    await frame.locator('#openPreferences').click();
    await frame.waitForFunction(() => !document.querySelector('#savePreferences').disabled);
    assert.equal(await frame.evaluate(() => document.activeElement.id), 'dismissPreferences');
    await frame.locator('#privateCleanup').check();
    await frame.locator('#dismissPreferences').click();
    await frame.waitForFunction(() => document.querySelector('#unsavedPreferencesDialog').open);
    assert.equal(await frame.evaluate(() => document.activeElement.id), 'keepEditingPreferences');
    await frame.locator('#discardPreferences').click();
    await frame.waitForFunction(() => !document.querySelector('#preferencesDialog').open);
  }

  await frame.locator('#query').fill('127.0.0.1');
  await frame.locator('#search').click();
  await frame.waitForFunction(() => !document.querySelector('#selectAll').disabled);
  await frame.locator('#selectAll').click();
  await frame.locator('#openFull').click();
  await frame.waitForFunction(() => document.querySelector('#openFullDialog').open);
  assert.equal(await frame.evaluate(() => document.activeElement.value), 'cancel');
  await frame.locator('#openFullDialog [value=cancel]').click();
  await frame.locator('#delete').click();
  await frame.waitForFunction(() => document.querySelector('#confirmDialog').open);
  assert.ok(await frame.locator('#confirmDialog [value=cancel]').evaluate(node => node === document.activeElement), 'deletion initially focuses the safe action');
  await frame.locator('#confirmDialog [value=cancel]').click();

  assert.deepEqual(autofocusWarnings, [], 'mount, language remounts and dialogs must not log blocked autofocus');
  assert.deepEqual(errors, []);
  console.log('Native modal focus checks passed: mount, both languages, settings, unsaved changes, full view and deletion. No blocked autofocus warnings. Disposable profile only.');
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
