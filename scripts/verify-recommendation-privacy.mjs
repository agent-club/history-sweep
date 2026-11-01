import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { enterWorkspace } from './native-workspace.mjs';

const { chromium } = dependency('playwright');
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-recommendation-privacy-'));
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const failures = [], errors = [];
let context;
let checks = 0;
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.HISTORY_SWEEP_CHROMIUM ? { executablePath: process.env.HISTORY_SWEEP_CHROMIUM } : { channel: 'chromium' }),
    headless: true, timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
  await worker.evaluate(async () => {
    const date = offset => {
      const d = new Date(); d.setDate(d.getDate() - offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    await chrome.history.addUrl({ url: 'https://privacy-boundary.example.test/synthetic' });
    await chrome.storage.local.set({ localActivity: { version: 1, startedOn: date(1), days: Object.fromEntries([0, 1].map(offset => [date(offset), {
      operations: 1, pages: 1, websitesComplete: true, websites: [{ domain: 'privacy-boundary.example.test' }],
    }])) } });
  });
  const privacy = value => worker.evaluate(value => value === undefined ? chrome.storage.local.remove('softPrivacy') : chrome.storage.local.set({ softPrivacy: value }), value);
  const open = async () => {
    const page = await context.newPage(); page.setDefaultTimeout(4000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/manager.html`); await enterWorkspace(page);
    await page.waitForFunction(() => !document.querySelector('#search').disabled);
    return page;
  };
  const preview = async page => {
    await page.locator('#openPreferences').click();
    await page.locator('[data-settings-section=recommendations]').click();
    await page.locator('#recommendation-preview').click();
    await page.waitForFunction(() => {
      const text = document.querySelector('#recommendation-previewCount').textContent;
      return text && text !== 'Loading recommendation settings…';
    });
  };
  const test = async (name, run) => {
    try { await run(); checks++; console.log(`PASS ${name}`); }
    catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n')[0]}`); }
  };
  for (const value of [undefined, false, true, 'invalid', null]) await test(`stored privacy ${JSON.stringify(value)}`, async () => {
    await privacy(value);
    const page = await open();
    try {
      const hidden = value !== undefined && value !== false;
      await preview(page);
      assert.equal((await page.locator('#recommendation-previewRows').textContent()).includes('Cleared on'), !hidden, 'preview respects the same privacy setting');
      assert.equal((await page.locator('#resultScroll .cleanup-reason').allTextContents()).join().includes('Cleared on'), !hidden, 'hint respects privacy while retaining independent recommendations');
    } finally { await page.close(); }
  });
  await test('open preview responds to privacy changed in another view', async () => {
    await privacy(false); const page = await open();
    try {
      await preview(page);
      assert.match(await page.locator('#recommendation-previewRows').textContent(), /Cleared on/);
      await privacy(true);
      await page.waitForFunction(() => !document.querySelector('#recommendation-previewRows').textContent.includes('Cleared on'));
      await privacy(false);
      await page.waitForFunction(() => document.querySelector('#recommendation-previewRows').textContent.includes('Cleared on'));
    } finally { await page.close(); }
  });
  await test('hint hides cleanup reasons before a pending activity request finishes', async () => {
    await privacy(false); const page = await open();
    try {
      await page.evaluate(() => {
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = message => message.type === 'get-activity' ? new Promise(() => {}) : send(message);
      });
      await privacy(true);
      await page.waitForFunction(() => ![...document.querySelectorAll('#resultScroll .cleanup-reason')].some(node => node.textContent.includes('Cleared on')));
    } finally { await page.close(); }
  });
  await test('late preview privacy read cannot restore hidden cleanup reasons', async () => {
    await privacy(false); const page = await open();
    try {
      await page.evaluate(() => {
        const get = chrome.storage.local.get.bind(chrome.storage.local);
        const pending = [];
        window.releasePreviewPrivacy = () => pending.forEach(resolve => resolve({ softPrivacy: false }));
        chrome.storage.local.get = key => key === 'softPrivacy' ? new Promise(resolve => pending.push(resolve)) : get(key);
      });
      await page.locator('#openPreferences').click();
      await page.locator('[data-settings-section=recommendations]').click();
      await page.locator('#recommendation-preview').click();
      await privacy(true);
      await page.evaluate(() => window.releasePreviewPrivacy());
      await page.waitForFunction(() => document.querySelector('#recommendation-previewNotice').textContent.length > 0);
      assert.equal((await page.locator('#recommendation-previewRows').textContent()).includes('Cleared on'), false);
    } finally { await page.close(); }
  });
  for (const target of ['softPrivacy', 'cleanupRecommendationSettings', 'get-activity']) await test(`startup does not wait for ${target}`, async () => {
    await privacy(false); const page = await context.newPage(); page.setDefaultTimeout(4000);
    try {
      await page.addInitScript(target => {
        const pending = [];
        window.releaseRecommendationReads = () => pending.forEach(resolve => resolve());
        if (target === 'get-activity') {
          const send = chrome.runtime.sendMessage.bind(chrome.runtime);
          chrome.runtime.sendMessage = message => message.type === target ? new Promise(resolve => pending.push(() => resolve(send(message)))) : send(message);
        } else {
          const get = chrome.storage.local.get.bind(chrome.storage.local);
          chrome.storage.local.get = key => key === target ? new Promise(resolve => pending.push(() => resolve({ [key]: target === 'softPrivacy' ? false : undefined }))) : get(key);
        }
      }, target);
      await page.goto(`${origin}/manager.html`);
      await page.waitForFunction(() => !document.querySelector('#search').disabled, undefined, { timeout: 4000 });
      await enterWorkspace(page);
      await privacy(true);
      await page.evaluate(() => window.releaseRecommendationReads());
      await page.waitForTimeout(100);
      assert.equal((await page.locator('#resultScroll .cleanup-reason').allTextContents()).join().includes('Cleared on'), false, 'a late startup read cannot override a newer privacy event');
    } finally { await page.close(); }
  });
  await test('soft privacy preserves independent website recommendations', async () => {
    await worker.evaluate(() => chrome.storage.local.set({ cleanupRecommendationSettings: {
      version: 1, habit: { enabled: true, lookbackDays: 7, minimumDays: 2 }, types: { extension: true, application: true }, cue: 'never',
      sites: [{ domain: 'privacy-boundary.example.test', includeSubdomains: false, condition: 'always', days: null, enabled: true }],
    } }));
    await privacy(true); const page = await open();
    try {
      await preview(page);
      const rows = await page.locator('#recommendation-previewRows').textContent();
      assert.ok(rows.includes('privacy-boundary.example.test') && !rows.includes('Cleared on'));
    } finally { await page.close(); }
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, failures, pageErrors: errors.length, syntheticHistoryOnly: true }));
  if (failures.length) process.exitCode = 1;
} finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
