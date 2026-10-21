import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';

const { chromium } = dependency('playwright');
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-activity-native-'));
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const browserOptions = {
  executablePath: process.env.HISTORY_SWEEP_CHROMIUM,
  channel: process.env.HISTORY_SWEEP_CHROMIUM ? undefined : 'chromium', headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
};
let context;
const errors = [];
try {
  context = await chromium.launchPersistentContext(profile, browserOptions);
  let worker = context.serviceWorkers().find(worker => worker.url().endsWith('/background.mjs'));
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  // A delayed/missed storage event must not leave the initiating view on its cached totals.
  await page.addInitScript(() => {
    const addListener = chrome.storage.onChanged.addListener.bind(chrome.storage.onChanged);
    chrome.storage.onChanged.addListener = listener => addListener((changes, area) => {
      if (area === 'local' && Object.hasOwn(changes, 'localActivity')) return;
      listener(changes, area);
    });
  });
  await page.goto(`chrome-extension://${id}/manager.html`);
  await page.waitForFunction(() => document.querySelector('#search') && !document.querySelector('#search').disabled);
  const urls = [1, 2, 3].map(index => `https://activity-fixture.example.test/page-${index}`);
  await page.evaluate(async urls => { for (const url of urls) await chrome.history.addUrl({ url }); }, urls);
  await page.locator('#query').fill('activity-fixture.example.test'); await page.locator('#mode').selectOption('host-exact'); await page.locator('#search').click();
  await page.waitForFunction(() => document.querySelector('#count').textContent.startsWith('3 '));
  await page.locator('#selectAll').click(); await page.locator('#delete').click(); await page.locator('#confirmDialog [value=confirm]').click();
  await page.waitForFunction(() => document.querySelector('#status').dataset.kind === 'done');
  const log = await page.evaluate(async () => (await chrome.storage.local.get('localActivity')).localActivity);
  assert.ok(log, 'a native cleanup creates chrome.storage.local.localActivity even with the panel closed');
  assert.equal(Object.values(log.days)[0].operations, 1);
  assert.equal(Object.values(log.days)[0].pages, 3);
  assert.equal(Object.values(log.days)[0].websitesComplete, true);
  assert.equal(Object.values(log.days)[0].websites.length, 1);
  assert.equal(Object.values(log.days)[0].websites[0].domain, 'activity-fixture.example.test');
  assert.doesNotMatch(JSON.stringify(log), /https:|page-[123]/);
  await page.locator('#toggleActivity').click();
  await page.locator('[data-activity-mode=cleanup]').click();
  await page.waitForFunction(() => document.querySelector('#activityStats').textContent.includes('1 cleanups'));
  await page.locator('.activity-site img').waitFor({ state: 'visible' });
  const favicon = await page.locator('.activity-site img').evaluate(img => ({ source: img.src, width: img.naturalWidth }));
  assert.ok(favicon.source.startsWith(`chrome-extension://${id}/_favicon/`) && favicon.width > 0, 'native Chrome serves the deleted website icon through its own resource');
  await page.evaluate(async () => { await chrome.history.addUrl({ url: 'https://activity-fixture.example.test/page-4' }); });
  await page.locator('#search').click(); await page.waitForFunction(() => document.querySelector('#count').textContent.startsWith('1 '));
  await page.locator('#selectAll').click(); await page.locator('#delete').click(); await page.locator('#confirmDialog [value=confirm]').click();
  await page.waitForFunction(() => document.querySelector('#status').dataset.kind === 'done');
  const persisted = await page.evaluate(async () => (await chrome.storage.local.get('localActivity')).localActivity);
  assert.equal(Object.values(persisted.days)[0].operations, 2);
  assert.equal(Object.values(persisted.days)[0].pages, 4);
  assert.match(await page.locator('#activityStats').textContent(), /2 cleanups/, 'the initiating UI reads the new persisted total before reporting cleanup complete, without a storage event');
  assert.match(await page.locator('#activityDetail').textContent(), /4 pages · 1 websites/);
  await page.reload();
  await page.locator('#toggleActivity').waitFor({ state: 'visible' });
  if (await page.locator('#toggleActivity').getAttribute('aria-expanded') !== 'true') await page.locator('#toggleActivity').click();
  await page.locator('[data-activity-mode=cleanup]').click();
  await page.waitForFunction(() => document.querySelector('#activityStats')?.textContent.includes('2 cleanups'));
  await context.close();
  context = await chromium.launchPersistentContext(profile, browserOptions);
  const reopened = await context.newPage(); reopened.on('pageerror', error => errors.push(error.message));
  await reopened.goto(`chrome-extension://${id}/manager.html`);
  await reopened.locator('#toggleActivity').waitFor({ state: 'visible' });
  if (await reopened.locator('#toggleActivity').getAttribute('aria-expanded') !== 'true') await reopened.locator('#toggleActivity').click();
  await reopened.locator('[data-activity-mode=cleanup]').click();
  await reopened.waitForFunction(() => document.querySelector('#activityStats')?.textContent.includes('2 cleanups'));
  const restored = await reopened.evaluate(async () => (await chrome.storage.local.get('localActivity')).localActivity);
  assert.deepEqual(restored, persisted, 'a new browser process and service worker read the same durable activity log');
  await reopened.locator('.activity-site img').waitFor({ state: 'visible' });
  assert.equal(await reopened.locator('.activity-site').getAttribute('data-domain'), 'activity-fixture.example.test');
  assert.deepEqual(errors, []);
  console.log('Native activity check passed: 2 cleanup tasks / 4 synthetic URLs and one domain summary persist, refresh before completion without storage notifications, and survive a new browser/worker. Chrome favicon resource loads before and after restart. Disposable profile only.');
} finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
