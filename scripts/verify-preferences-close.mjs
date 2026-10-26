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
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-preferences-close-'));
const server = createServer();
const errors = [];
let context;
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const screenshotDirectory = process.env.HISTORY_SWEEP_SCREENSHOTS;

async function openSettings(frame, section = 'general') {
  await frame.locator('#openPreferences').click();
  await frame.waitForFunction(() => !document.querySelector('#savePreferences').disabled);
  await frame.locator(`[data-settings-section="${section}"]`).click();
}
const confirmed = frame => frame.waitForFunction(() => document.querySelector('#unsavedPreferencesDialog')?.open);
const settingsClosed = frame => frame.waitForFunction(() => !document.querySelector('#preferencesDialog').open);
const confirmationClosed = frame => frame.waitForFunction(() => !document.querySelector('#unsavedPreferencesDialog').open);

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
    await frame.waitForFunction(() => document.querySelector('#search') && !document.querySelector('#search').disabled);
    await enterWorkspace(frame);
    frame.setDefaultTimeout?.(6000);

    await openSettings(frame);
    const structure = await frame.evaluate(() => ({
      formCount: document.querySelectorAll('#preferencesDialog #preferencesForm').length,
      fields: ['defaultView', 'defaultRange', 'privateCleanup', 'softPrivacy'].map(id => document.getElementById(id)?.closest('form')?.id),
      modes: [...document.querySelectorAll('#preferencesForm input[name=launchMode]')].map(input => input.value),
    }));
    assert.deepEqual(structure, { formCount: 1, fields: Array(4).fill('preferencesForm'), modes: ['popup', 'modal', 'fullpage'] });
    await frame.locator('#dismissPreferences').click(); await settingsClosed(frame);
    check(await frame.locator('#openPreferences').evaluate(node => node === document.activeElement), `${layout}: unchanged close restores focus`);

    await openSettings(frame, 'privacy');
    await frame.locator('#privateCleanup').check();
    const scrollTop = await frame.locator('.preferences-content').evaluate(node => { node.scrollTop = 120; return node.scrollTop; });
    await frame.locator('#dismissPreferences').click();
    await confirmed(frame);
    check(await frame.locator('#preferencesDialog').evaluate(node => node.open), `${layout}: dirty close keeps preferences open`);
    check(await frame.locator('#keepEditingPreferences').evaluate(node => node === document.activeElement), `${layout}: safe initial focus`);
    await page.keyboard.press('Shift+Tab');
    check(await frame.locator('#unsavedPreferencesDialog').evaluate(node => node.contains(document.activeElement)), `${layout}: keyboard focus stays inside confirmation`);
    await frame.locator('#keepEditingPreferences').click(); await confirmationClosed(frame);
    check(await frame.locator('#privateCleanup').isChecked(), `${layout}: continue editing preserves draft`);
    check(await frame.locator('.preferences-content').evaluate(node => node.scrollTop) === scrollTop, `${layout}: continue editing preserves scroll position`);

    // Restoring the original value removes the need to confirm.
    await frame.locator('#privateCleanup').uncheck();
    await frame.locator('#closePreferences').click(); await settingsClosed(frame);
    check(!await frame.locator('#unsavedPreferencesDialog').evaluate(node => node.open), `${layout}: reverted draft closes directly`);

    for (const change of ['defaultView', 'defaultRange', 'softPrivacy', 'launchMode']) {
      await openSettings(frame, change === 'softPrivacy' ? 'privacy' : 'general');
      if (change === 'defaultView') await frame.locator('#defaultView').selectOption('date');
      if (change === 'defaultRange') await frame.locator('#defaultRange').selectOption('today');
      if (change === 'softPrivacy') await frame.locator('#softPrivacy').check();
      if (change === 'launchMode') await frame.locator('input[name=launchMode][value=fullpage]').check();
      await frame.locator('#closePreferences').click(); await confirmed(frame);
      await frame.locator('#discardPreferences').click(); await settingsClosed(frame);
      const stored = await worker.evaluate(() => chrome.storage.local.get(['launchMode', 'browsingPreferences', 'privateCleanup', 'softPrivacy']));
      assert.deepEqual(stored, { launchMode: 'modal', browsingPreferences: { view: 'website', range: '7days' }, privateCleanup: false, softPrivacy: false });
      checks++;
    }

    await openSettings(frame, 'privacy');
    await frame.locator('#privateCleanup').check();
    // A nested picker absorbs Escape before any settings close attempt.
    if (layout === 'modal') {
      const toggle = await page.evaluate(injectModal, `${extensionOrigin}/modal.html`);
      check(toggle.opened === false, 'toolbar toggle reuses the existing modal');
      await confirmed(frame);
      await frame.locator('#keepEditingPreferences').click(); await confirmationClosed(frame);
      check(await frame.locator('#privateCleanup').isChecked(), 'toolbar toggle cannot discard the draft');
    }
    await frame.locator('[data-settings-section=general]').click();
    await frame.locator('#defaultViewToggle').click();
    await page.keyboard.press('Escape');
    check(await frame.locator('#preferencesDialog').evaluate(node => node.open) && !await frame.locator('#unsavedPreferencesDialog').evaluate(node => node.open), `${layout}: Escape first closes picker`);
    await page.keyboard.press('Escape'); await confirmed(frame);
    await page.keyboard.press('Escape'); await confirmationClosed(frame);
    check(await frame.locator('#preferencesDialog').evaluate(node => node.open) && await frame.locator('#privateCleanup').isChecked(), `${layout}: Escape in confirmation keeps draft`);
    await frame.locator('#closePreferences').click(); await confirmed(frame);
    const viewport = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const outside = await frame.locator('#unsavedPreferencesDialog').boundingBox();
    await page.mouse.click(outside.x + outside.width / 2, outside.y - 12); await confirmationClosed(frame);
    check(await frame.locator('#preferencesDialog').evaluate(node => node.open), `${layout}: confirmation backdrop only returns to editing`);

    // The same settings-backdrop gesture is also forwarded by the outer modal host.
    if (layout === 'modal') await page.mouse.click(8, 450);
    else await frame.locator('#preferencesDialog').evaluate(node => node.dispatchEvent(new Event('cancel', { cancelable: true })));
    await confirmed(frame);
    const geometry = await frame.evaluate(() => {
      const dialog = document.querySelector('#unsavedPreferencesDialog');
      const box = dialog.getBoundingClientRect();
      const drawer = document.querySelector('#preferencesDialog').getBoundingClientRect();
      const buttons = [...dialog.querySelectorAll('button')].map(button => { const r = button.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
      return { x: box.x, right: box.right, y: box.y, bottom: box.bottom, drawerX: drawer.x, drawerRight: drawer.right, width: innerWidth, height: innerHeight, buttons, overflow: dialog.scrollWidth > dialog.clientWidth };
    });
    check(geometry.x >= geometry.drawerX && geometry.right <= geometry.drawerRight && geometry.y >= 0 && geometry.bottom <= viewport.height && !geometry.overflow, `${layout}: confirmation fits inside drawer`);
    check(geometry.buttons.every(button => button.height >= 42), `${layout}: button hit areas`);
    if (layout === 'popup') check(new Set(geometry.buttons.map(button => Math.round(button.x))).size === 1, 'popup: actions stack vertically');
    else check(new Set(geometry.buttons.map(button => Math.round(button.y))).size === 1, `${layout}: desktop actions form one row`);
    if (screenshotDirectory) {
      await mkdir(screenshotDirectory, { recursive: true });
      await page.screenshot({ path: join(screenshotDirectory, `preferences-close-${layout}-en.png`) });
    }

    // A failed save must leave both dialogs and every draft value available for retry.
    await frame.evaluate(() => {
      const original = chrome.storage.local.set.bind(chrome.storage.local);
      window.restorePreferenceWrite = () => { chrome.storage.local.set = original; };
      chrome.storage.local.set = data => Object.hasOwn(data, 'privateCleanup') ? Promise.reject(new Error('Synthetic preference write failure')) : original(data);
    });
    await frame.locator('#saveUnsavedPreferences').click();
    await frame.waitForFunction(() => !document.querySelector('#saveUnsavedPreferences').disabled && !document.querySelector('#unsavedPreferencesStatus').hidden);
    check(await frame.locator('#unsavedPreferencesDialog').evaluate(node => node.open) && await frame.locator('#privateCleanup').isChecked(), `${layout}: failed save retains draft`);
    await frame.evaluate(() => window.restorePreferenceWrite());

    // Keep a save pending to verify double-click, Escape and backdrop cannot dismiss it.
    await frame.evaluate(() => {
      const original = chrome.storage.local.set.bind(chrome.storage.local);
      const gate = new Promise(resolve => { window.finishPreferenceWrite = resolve; });
      chrome.storage.local.set = async data => {
        if (Object.hasOwn(data, 'privateCleanup')) await gate;
        return original(data);
      };
    });
    await frame.locator('#saveUnsavedPreferences').click();
    check(await frame.locator('#saveUnsavedPreferences').isDisabled() && await frame.locator('#discardPreferences').isDisabled(), `${layout}: prevent duplicate saves or discard while saving`);
    await page.keyboard.press('Escape');
    if (layout === 'modal') await page.mouse.click(8, 450);
    check(await frame.locator('#unsavedPreferencesDialog').evaluate(node => node.open), `${layout}: pending save cannot be dismissed`);
    await frame.evaluate(() => window.finishPreferenceWrite()); await settingsClosed(frame);
    check(!await frame.locator('#unsavedPreferencesDialog').evaluate(node => node.open), `${layout}: successful save closes both dialogs`);
    check(await worker.evaluate(async () => (await chrome.storage.local.get('privateCleanup')).privateCleanup), `${layout}: native storage contains saved choice`);
    await openSettings(frame);
    check(await frame.locator('#privateCleanup').isChecked(), `${layout}: reopening reads saved preference`);
    await frame.locator('#closePreferences').click(); await settingsClosed(frame);

    // Capture Chinese and dark theme without mutating any real browser profile.
    await frame.getByRole('button', { name: '简体中文', exact: true }).click();
    await openSettings(frame, 'privacy'); await frame.locator('#privateCleanup').uncheck();
    await frame.locator('#closePreferences').click(); await confirmed(frame);
    check(await frame.locator('#unsavedPreferencesTitle').textContent() === '保存对设置的更改？', `${layout}: Chinese confirmation copy`);
    if (screenshotDirectory) {
      await page.screenshot({ path: join(screenshotDirectory, `preferences-close-${layout}-zh.png`) });
      await frame.evaluate(() => document.dispatchEvent(new CustomEvent('history-sweep:set-theme', { detail: 'dark' })));
      await page.screenshot({ path: join(screenshotDirectory, `preferences-close-${layout}-dark.png`) });
    }
    await frame.locator('#discardPreferences').click(); await settingsClosed(frame);
    if (layout === 'manager') {
      await frame.evaluate(() => {
        const original = chrome.storage.local.get.bind(chrome.storage.local);
        chrome.storage.local.get = key => key === 'privateCleanup' ? Promise.reject(new Error('Synthetic preference read failure')) : original(key);
      });
      await frame.locator('#openPreferences').click();
      await frame.waitForFunction(() => document.querySelector('#preferencesStatus').textContent === '无法读取偏好，请关闭后重试。');
      await frame.locator('#closePreferences').click(); await settingsClosed(frame);
      check(!await frame.locator('#unsavedPreferencesDialog').evaluate(node => node.open), 'failed read does not create a false dirty state');
    }
    if (layout === 'modal') {
      check(await page.evaluate(() => globalThis.__historySweepModalHost?.isConnected()), 'closing settings preserves outer modal');
      await page.mouse.click(8, 450);
      await page.waitForFunction(() => !globalThis.__historySweepModalHost);
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(`${checks} native preference-close checks passed: unchanged/reverted, all fields, close routes, focus, retry, persistence, layouts and languages. Disposable profile only.`);
} finally {
  await context?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
