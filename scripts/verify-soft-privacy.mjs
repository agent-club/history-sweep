import { enterWorkspace } from './native-workspace.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';

const { chromium } = dependency('playwright');
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-soft-privacy-'));
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const errors = [];
let context;
const ready = page => page.waitForFunction(() => document.querySelector('#search') && !document.querySelector('#search').disabled);
const hidden = page => page.waitForFunction(() => document.querySelector('#activityContent').hidden && document.querySelector('#toggleCleanupVisibility').textContent === 'Show cleanup activity');
const shown = page => page.waitForFunction(() => !document.querySelector('#activityContent').hidden && document.querySelector('#activityStats').textContent.includes('1 cleanups'));

try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.HISTORY_SWEEP_CHROMIUM,
    channel: process.env.HISTORY_SWEEP_CHROMIUM ? undefined : 'chromium', headless: true,
    timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let worker = context.serviceWorkers().find(worker => worker.url().endsWith('/background.mjs'));
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
  async function open(layout = 'manager', viewport = { width: 1280, height: 900 }) {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/${layout}.html`); await enterWorkspace(page); await ready(page);
    return page;
  }
  async function cleanup(page) {
    if (await page.locator('#activityEntry').getAttribute('aria-expanded') !== 'true') await page.locator('#activityDock[data-open="false"] #activityEntry, #activityDock[data-open="true"] #activityCollapse').click();
    await page.locator('[data-activity-mode=cleanup]').click();
  }
  const first = await open();
  const log = await first.evaluate(async () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const log = { version: 1, startedOn: today, days: { [today]: { operations: 1, pages: 2, websitesComplete: true, websites: [{ domain: 'privacy-fixture.example.test', title: 'Synthetic cleanup title', lastVisitTime: Date.now() }] } } };
    await chrome.storage.local.set({ localActivity: log });
    await chrome.history.addUrl({ url: 'https://privacy-fixture.example.test/kept-page' });
    return log;
  });
  await cleanup(first); await shown(first);
  assert.equal(await first.locator('.activity-day').count() > 0, true, 'existing installs keep visible cleanup by default');
  await first.locator('#toggleCleanupVisibility').click(); await hidden(first);
  assert.equal(await first.locator('#activityGrid').textContent(), '');
  assert.equal(await first.locator('#activityStats').textContent(), '');
  assert.equal(await first.locator('.activity-site').count(), 0);
  assert.equal(await first.locator('#activityTooltip').textContent(), '');
  assert.deepEqual(await first.evaluate(async () => (await chrome.storage.local.get('localActivity')).localActivity), log, 'hiding keeps every stored record');
  await first.locator('#openPreferences').click();
  await first.locator('#savePreferences').waitFor({ state: 'visible' });
  await first.waitForFunction(() => !document.querySelector('#savePreferences').disabled);
  assert.equal(await first.locator('#softPrivacy').isChecked(), true);
  assert.equal(await first.locator('#privateCleanup').isChecked(), false);
  await first.locator('[data-settings-section=privacy]').click();
  await first.locator('#softPrivacy').uncheck(); await first.locator('#closePreferences').click();
  await first.locator('#discardPreferences').click();
  await hidden(first);

  const popup = await open('popup', { width: 440, height: 590 });
  await cleanup(popup); await hidden(popup);
  await popup.locator('#openPreferences').click();
  await popup.waitForFunction(() => !document.querySelector('#savePreferences').disabled);
  await popup.locator('[data-settings-section=privacy]').click();
  await popup.locator('#softPrivacy').uncheck(); await popup.locator('#savePreferences').click();
  await shown(first); await shown(popup);
  await first.locator('#toggleCleanupVisibility').click(); await hidden(first); await hidden(popup);
  await first.reload(); await ready(first); await cleanup(first); await hidden(first);
  await first.locator('[data-activity-mode=browsing]').click();
  await first.waitForFunction(() => !document.querySelector('#activityContent').hidden && Number(document.querySelector('#activityStats strong')?.textContent) >= 1);
  assert.equal(await first.locator('#toggleCleanupVisibility').isHidden(), true, 'browsing activity stays visible');

  // A cleanup under soft privacy must still be recorded; hard privacy remains independent.
  const job = await first.evaluate(async () => {
    const url = 'https://privacy-fixture.example.test/kept-page';
    return (await chrome.runtime.sendMessage({ type: 'start-delete', urls: [url], details: [{ url, title: 'Synthetic new cleanup' }] })).data;
  });
  assert.equal(job.privateCleanup, false);
  await first.waitForFunction(async id => (await chrome.runtime.sendMessage({ type: 'delete-status', id })).data?.phase === 'done', job.id);
  assert.equal(await first.evaluate(async () => Object.values((await chrome.storage.local.get('localActivity')).localActivity.days)[0].operations), 2);
  await first.locator('[data-activity-mode=cleanup]').click(); await hidden(first);
  await first.locator('#toggleCleanupVisibility').click();
  await first.waitForFunction(() => document.querySelector('#activityStats').textContent.includes('2 cleanups'));
  await popup.waitForFunction(() => document.querySelector('#activityStats').textContent.includes('2 cleanups'));

  // Failed writes preserve visibility and storage; retry remains available.
  await first.evaluate(() => {
    const set = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = data => Object.hasOwn(data, 'softPrivacy') && window.failPrivacyWrite ? Promise.reject(Error('synthetic write failure')) : set(data);
    window.failPrivacyWrite = true;
  });
  await first.locator('#toggleCleanupVisibility').click();
  await first.waitForFunction(() => document.querySelector('#activityNotice').textContent.includes('Could not save'));
  assert.equal(await first.locator('#activityContent').isVisible(), true);
  assert.equal(await first.evaluate(async () => (await chrome.storage.local.get('softPrivacy')).softPrivacy), false);
  await first.evaluate(() => { window.failPrivacyWrite = false; });
  await first.locator('#toggleCleanupVisibility').click(); await hidden(first);

  // A delayed startup read cannot flash hidden cleanup or overwrite a newer storage notification.
  const delayed = await context.newPage();
  await delayed.addInitScript(() => {
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = async key => {
      if (key !== 'softPrivacy') return get(key);
      return new Promise(resolve => { window.finishPrivacyRead = () => resolve({ softPrivacy: false }); });
    };
  });
  await delayed.goto(`${origin}/manager.html`); await ready(delayed); await cleanup(delayed);
  await hidden(delayed);
  assert.equal(await delayed.locator('#toggleCleanupVisibility').isDisabled(), true);
  await first.evaluate(async () => { await chrome.storage.local.set({ softPrivacy: false }); await chrome.storage.local.set({ softPrivacy: true }); });
  await delayed.waitForFunction(() => !document.querySelector('#toggleCleanupVisibility').disabled);
  await delayed.evaluate(() => window.finishPrivacyRead()); await hidden(delayed);
  assert.equal(await delayed.locator('.activity-site').count(), 0);
  await delayed.close();

  // Invalid or unavailable preferences never reveal records.
  for (const failure of ['invalid', 'read']) {
    const page = await context.newPage();
    if (failure === 'invalid') await first.evaluate(() => chrome.storage.local.set({ softPrivacy: 'invalid' }));
    else await page.addInitScript(() => {
      const get = chrome.storage.local.get.bind(chrome.storage.local);
      chrome.storage.local.get = key => key === 'softPrivacy' ? Promise.reject(Error('synthetic read failure')) : get(key);
    });
    await page.goto(`${origin}/manager.html`); await ready(page); await cleanup(page); await hidden(page);
    assert.equal(await page.locator('#toggleCleanupVisibility').isDisabled(), true);
    assert.equal(await page.locator('#activityStats').textContent(), '');
    await page.close();
  }
  await first.evaluate(() => chrome.storage.local.set({ softPrivacy: true }));
  await first.locator('#language [data-language="zh-CN"]').click();
  await first.locator('#openPreferences').click();
  await first.waitForFunction(() => !document.querySelector('#savePreferences').disabled);
  assert.match(await first.locator('#softPrivacyHint').textContent(), /保留已有记录/);
  assert.equal(await first.locator('#softPrivacy').isChecked(), true);
  await first.locator('#closePreferences').click();
  assert.deepEqual(errors, []);
  console.log('Soft privacy passed: native settings, cancellation, cross-window display, reload, continued recording, browsing isolation, write/read failures, invalid values, startup race, and Chinese copy. Disposable profile only.');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
