import { enterWorkspace } from './native-workspace.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { injectModal } from '../extension/modal-host.mjs';

const { chromium } = dependency('playwright');
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-embedded-sync-'));
const server = createServer();
const errors = [];
let context;
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const screenshotDirectory = process.env.HISTORY_SWEEP_SCREENSHOTS;

async function openSettings(frame) {
  await frame.locator('#openPreferences').click();
  await frame.waitForFunction(() => !document.querySelector('#savePreferences').disabled);
}
const settingsClosed = frame => frame.waitForFunction(() => !document.querySelector('#preferencesDialog').open);

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

  for (const layout of ['manager', 'popup', 'modal']) {
    await worker.evaluate(() => chrome.storage.local.set({
      launchMode: 'modal', browsingPreferences: { view: 'website', range: '7days' }, privateCleanup: false, softPrivacy: false,
    }));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(6000);
    await page.addInitScript(() => { localStorage.setItem('theme', 'light'); localStorage.setItem('language', 'en'); });
    await page.setViewportSize(layout === 'popup' ? { width: 440, height: 590 } : { width: 1440, height: 900 });
    let frame = page;
    if (layout === 'modal') {
      await page.goto(`http://127.0.0.1:${server.address().port}/site/`);
      await page.bringToFront();
      // This identifier belongs only to the disposable local test profile.
      const syntheticLaunchId = crypto.randomUUID();
      const navigation = page.waitForEvent('framenavigated', { predicate: frame => frame.url().startsWith(`${extensionOrigin}/modal.html`) });
      await worker.evaluate(async syntheticLaunchId => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        await chrome.storage.session.set({ modalLaunchSessions: { [syntheticLaunchId]: { tabId: tab.id, expires: Date.now() + 60000 } } });
      }, syntheticLaunchId);
      await page.evaluate(injectModal, `${extensionOrigin}/modal.html#launch=${syntheticLaunchId}`);
      await navigation;
      frame = page.frames().find(frame => frame.url().startsWith(`${extensionOrigin}/modal.html`));
    } else await page.goto(`${extensionOrigin}/${layout}.html`);
    await enterWorkspace(frame);
    await frame.waitForFunction(() => document.querySelector('#search') && !document.querySelector('#search').disabled);
    frame.setDefaultTimeout?.(6000);

    await openSettings(frame);
    const pageCount = context.pages().length;
    await frame.locator('[data-settings-section=sync]').click();
    await frame.waitForFunction(() => !document.querySelector('#connectionFields').disabled);
    check(context.pages().length === pageCount, `${layout}: sync opens without a new tab`);
    check(await frame.locator('#syncSettingsContent').isVisible() && !await frame.locator('#preferencesForm').isVisible(), `${layout}: sync uses the settings content area`);
    check(await frame.locator('#connectionForm').evaluate(node => !node.parentElement.closest('form')), `${layout}: sync has its own form`);
    check(await frame.locator('#syncSettingsContent').evaluate(node => node.scrollWidth <= node.clientWidth), `${layout}: sync content fits the settings window`);
    if (layout === 'popup') check(await frame.locator('.settings-nav').evaluate(node => [...node.querySelectorAll('button')].every(button => button.offsetWidth < node.clientWidth / 2)), 'popup: settings navigation keeps neighboring sections visible');
    await frame.locator('#davUrl').fill('https://dav.example.test/draft.json');
    await frame.locator('[data-settings-section=tasks]').click();
    await frame.locator('[data-settings-section=sync]').click();
    check(await frame.locator('#davUrl').inputValue() === 'https://dav.example.test/draft.json', `${layout}: navigation retains the connection draft`);
    if (screenshotDirectory) {
      await mkdir(screenshotDirectory, { recursive: true });
      await page.screenshot({ path: join(screenshotDirectory, `embedded-sync-${layout}-en.png`) });
      await frame.locator('#exportBackup').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(screenshotDirectory, `embedded-sync-${layout}-backup.png`) });
    }
    await page.keyboard.press('Escape'); await settingsClosed(frame);
    await openSettings(frame);
    await frame.locator('[data-settings-section=sync]').click();
    check(await frame.locator('#davUrl').inputValue() === 'https://dav.example.test/draft.json', `${layout}: reopening retains the connection draft`);
    await frame.locator('[data-settings-section=general]').click();
    await frame.locator('#dismissPreferences').click(); await settingsClosed(frame);
    check(await frame.locator('#openPreferences').evaluate(node => node === document.activeElement), `${layout}: close restores focus`);
    await frame.getByRole('button', { name: '简体中文', exact: true }).click();
    await frame.evaluate(() => document.dispatchEvent(new CustomEvent('history-sweep:set-theme', { detail: 'dark' })));
    await openSettings(frame);
    await frame.locator('[data-settings-section=sync]').click();
    await frame.waitForFunction(() => !document.querySelector('#connectionFields').disabled);
    check(await frame.locator('#syncSettingsContent h1').textContent() === '配置同步', `${layout}: sync follows the settings language`);
    if (screenshotDirectory) {
      await page.screenshot({ path: join(screenshotDirectory, `embedded-sync-${layout}-zh-dark.png`) });
    }
    await frame.locator('#dismissPreferences').click(); await settingsClosed(frame);
    if (layout === 'modal') check(await page.evaluate(() => globalThis.__historySweepModalHost?.isConnected()), 'settings close preserves the outer modal');
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(`${checks} embedded sync checks passed across full page, popup and webpage modal. Disposable profile only.`);
} finally {
  await context?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
