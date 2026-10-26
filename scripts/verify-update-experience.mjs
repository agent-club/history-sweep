import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const server = createServer();
let browser;
const output = process.env.HISTORY_SWEEP_UPDATE_OUTPUT || new URL('../output/update-experience/', import.meta.url).pathname;
const extensionId = 'bbccfejdhhcjmpfagjckiikgllpojhgm';
const versionUrl = 'https://sweep.agentclub.dev/extension-updates.json';
const settle = page => page.evaluate(async () => {
  await Promise.all(document.getAnimations().filter(animation => animation.effect.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
});
try {
  await mkdir(output, { recursive: true });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
  {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, locale: 'zh-CN' });
    const page = await context.newPage();
    await installMock(page);
    await context.route(versionUrl, route => route.abort('failed'));
    await page.addInitScript(extensionId => {
      chrome.management.getSelf = async () => ({ id: extensionId, installType: 'normal', updateUrl: 'https://clients2.google.com/service/update2/crx' });
      chrome.runtime.requestUpdateCheck = async () => ({ status: 'no_update' });
      const send = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = message => {
        const mode = window.__updateFailureMode;
        if (mode && message.type === 'get-update-state') {
          if (mode === 'read-hanging') return new Promise(() => {});
          const check = mode === 'hanging' ? { status: 'checking', channel: 'store' } : null;
          return Promise.resolve({ ok: true, data: mode === 'legacy' ? { update: null } : { update: null, check } });
        }
        if (mode && message.type === 'check-for-update') {
          if (mode === 'legacy') return Promise.resolve({ ok: true, data: { update: null } });
          if (mode === 'hanging') {
            void chrome.storage.local.set({ extensionUpdateCheck: { status: 'checking' } });
            return new Promise(() => {});
          }
          if (mode === 'rejected') return Promise.reject(new Error('unavailable'));
          return Promise.resolve({ ok: true, data: {} });
        }
        return send(message);
      };
    }, extensionId);
    await page.goto(`${origin}/extension/manager.html`);
    await page.waitForFunction(() => document.querySelector('#updateDialog')?.dataset.state === 'error');
    await page.locator('#openVersion').click();
    await settle(page);
    await page.evaluate(() => { window.__updateFailureMode = 'legacy'; });
    await page.locator('#checkUpdate').click();
    await page.waitForFunction(() => document.querySelector('#updateDialog').dataset.state === 'error' && document.querySelector('#updateChannel').textContent.includes('Chrome'));
    assert.match(await page.locator('#updateChannel').textContent(), /Chrome/);
    await context.unroute(versionUrl);
    await context.route(versionUrl, route => route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ extensionId, version: '0.3.1' }) }));
    await page.locator('#checkUpdate').click();
    await page.waitForFunction(() => document.querySelector('#updateDialog').dataset.state === 'current');
    assert.match(await page.locator('#updateChannel').textContent(), /Chrome/);
    for (const mode of ['empty', 'rejected', 'hanging', 'read-hanging']) {
      await page.evaluate(mode => { window.__updateFailureMode = mode; }, mode);
      await page.locator('#checkUpdate').click();
      await page.waitForTimeout(100);
      assert.equal(await page.locator('#updateDialog').getAttribute('data-state'), 'checking', `${mode}: progress stays visible even for a fast response`);
      assert.equal(await page.locator('#checkUpdate').isDisabled(), true);
      await page.waitForFunction(() => document.querySelector('#updateDialog').dataset.state === 'error');
      assert.equal(await page.locator('#checkUpdate').isEnabled(), true, `${mode}: retry is available`);
      assert.ok(await page.locator('#updateStatusBody').textContent());
    }
    await page.screenshot({ path: `${output}missing-result-error.png` });
    await context.close();
  }
  for (const [lang, width, layout, theme] of [['zh-CN', 1100, 'manager', 'light'], ['en', 320, 'manager', 'dark'], ['zh-CN', 360, 'popup', 'light'], ['en', 800, 'modal', 'light']]) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, locale: lang });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let mode = 'offline', releaseResponse;
    await context.route(versionUrl, async route => {
      if (mode === 'offline') return route.abort('failed');
      if (mode === 'gated') await new Promise(resolve => { releaseResponse = resolve; });
      await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ extensionId, version: mode === 'current' ? '0.3.1' : '0.3.2' }) });
    });
    await installMock(page);
    await page.addInitScript(({ extensionId, theme }) => {
      localStorage.setItem('theme', theme);
      chrome.management.getSelf = async () => ({ id: extensionId, installType: 'normal', updateUrl: 'https://clients2.google.com/service/update2/crx' });
      chrome.runtime.requestUpdateCheck = async () => ({ status: 'no_update' });
    }, { extensionId, theme });
    if (layout === 'modal') await page.route('**/extension/manager.html', async route => {
      const response = await route.fetch(); await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
    });
    await page.goto(`${origin}/extension/${layout === 'popup' ? 'popup' : 'manager'}.html`);
    await page.locator(`[data-language="${lang}"]`).click();
    await page.waitForFunction(() => document.querySelector('#updateDialog')?.dataset.state === 'error');
    await page.locator('#openPreferences').click();
    await page.locator('#savePreferences').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#savePreferences').disabled);
    await page.locator('#openUpdateSettings').click();
    await settle(page);
    const capture = async name => { await settle(page); await page.screenshot({ path: `${output}${layout}-${width}-${lang}-${name}.png` }); };
    assert.equal(await page.locator('#checkUpdate').isEnabled(), true);
    await capture('error');
    mode = 'gated';
    await page.locator('#checkUpdate').click();
    await page.waitForFunction(() => document.querySelector('#updateDialog').dataset.state === 'checking');
    assert.equal(await page.locator('#checkUpdate').isDisabled(), true);
    assert.equal(await page.locator('#checkUpdate').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#updateStatusTitle').evaluate(node => getComputedStyle(node, '::before').animationName), 'update-check-spin');
    const manualChecks = await page.evaluate(() => window.__messages.filter(message => message.type === 'check-for-update' && message.manual).length);
    await page.locator('#checkUpdate').dispatchEvent('click');
    assert.equal(await page.evaluate(() => window.__messages.filter(message => message.type === 'check-for-update' && message.manual).length), manualChecks, 'repeated clicks do not start another check');
    if (width === 320) {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await page.locator('#updateStatusTitle').evaluate(node => getComputedStyle(node, '::before').animationName), 'none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
    await page.waitForFunction(() => document.querySelector('#updateStatusBody').textContent.length > 0);
    await capture('checking');
    for (let attempt = 0; !releaseResponse && attempt < 100; attempt++) await page.waitForTimeout(10);
    assert.ok(releaseResponse, 'the manual check requests release metadata');
    releaseResponse(); mode = 'published';
    await page.waitForFunction(() => document.querySelector('#updateDialog').dataset.state === 'published');
    assert.equal(await page.locator('#reloadUpdate').isVisible(), false, 'a release hint does not enable reload');
    assert.match(await page.locator('#updateStatusBody').textContent(), /0\.3\.2/);
    await capture('published');
    assert.equal(await page.locator('#updateDialog').evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'dialog has no horizontal overflow');
    const bounds = await page.locator('#updateDialog').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y >= 0 && bounds.y + bounds.height <= 801, 'dialog fits the viewport');
    for (let index = 0; index < 6; index++) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.querySelector('#updateDialog').contains(document.activeElement)), true, 'keyboard focus stays in the modal');
    }
    mode = 'current';
    await page.locator('#checkUpdate').click();
    await page.waitForFunction(() => document.querySelector('#updateDialog').dataset.state === 'current');
    await capture('current');
    await page.evaluate(async () => {
      const { extensionUpdateCheck } = await chrome.storage.local.get('extensionUpdateCheck');
      await chrome.storage.local.set({ extensionUpdateCheck: { ...extensionUpdateCheck, status: 'throttled' } });
    });
    await page.waitForFunction(() => document.querySelector('#updateDialog').dataset.state === 'throttled');
    await capture('throttled');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#preferencesDialog').evaluate(element => element.open), true, 'Escape keeps the underlying preferences open');
    assert.equal(await page.locator('#openUpdateSettings').evaluate(element => element === document.activeElement), true, 'focus returns to the update entry');
    await page.locator('#privateCleanup').check();
    await page.evaluate(() => window.__updateAvailable('0.3.2'));
    await page.locator('#openUpdateSettings').click();
    await page.waitForFunction(() => document.querySelector('#updateDialog').dataset.state === 'ready');
    assert.equal(await page.locator('#reloadUpdate').isDisabled(), true, 'unsaved preferences block reload');
    await capture('ready-unsaved');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#privateCleanup').isChecked(), true, 'opening update details preserves the draft');
    await page.locator('#privateCleanup').uncheck();
    await page.locator('#openUpdateSettings').click();
    assert.equal(await page.locator('#reloadUpdate').isEnabled(), true);
    await capture('ready');
    await page.locator('#reloadUpdate').click();
    await page.waitForFunction(() => window.__reloads === 1);
    assert.deepEqual(errors, []);
    await context.close();
  }
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const page = await context.newPage();
  await installMock(page);
  await page.goto(`${origin}/extension/manager.html`);
  await page.locator('#openVersion').click();
  await page.waitForFunction(() => document.querySelector('#updateDialog').dataset.state === 'manual');
  assert.equal(await page.locator('#checkUpdate').isVisible(), false);
  assert.equal(await page.locator('#reloadUpdate').isVisible(), false);
  assert.match(await page.locator('#updateStatusBody').textContent(), /Unpacked|解压/);
  await settle(page);
  await page.screenshot({ path: `${output}unpacked.png` });
  assert.equal(await page.evaluate(() => window.__messages.filter(message => message.type === 'check-for-update').length), 1);
  console.log('Update experience passed: immediate progress, missing/legacy results, rejected and timed-out requests, retry/checking/current/published/throttled/ready, duplicate clicks, reduced motion, unpacked guidance, unsaved settings, keyboard/focus, zh/en and 320/360/800/1100 px layouts.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
