import { enterWorkspace } from './native-workspace.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { dependency } from './runtime.mjs';

const { chromium } = dependency('playwright');
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'history-sweep-config-sync-'));
const profile = join(temporary, 'profile');
let context; let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const ready = page => page.waitForFunction(() => document.querySelector('#connectionFields') && !document.querySelector('#connectionFields').disabled);
const openEmbedded = async page => {
  await page.waitForFunction(() => document.querySelector('#search') && !document.querySelector('#search').disabled);
  await page.locator('#openPreferences').click();
  await page.locator('[data-settings-section=sync]').click();
  await ready(page);
};
const idle = page => page.waitForFunction(() => !document.querySelector('#exportBackup').disabled);
const expected = { format: 'history-sweep-config', version: 1,
  preferences: { language: 'zh-CN', theme: 'dark', launchMode: 'fullpage' },
  historyTags: { planned: ['Read later'] }, domainLabels: { 'example.test': ['Reference'] } };
const passphrase = randomBytes(20).toString('hex');
const fixtureValue = randomBytes(20).toString('hex');
const errors = []; const requests = []; const permissionRequests = [];
let remote = null; let revision = 0; let forceConflict = false;
const launch = async () => {
  const result = await chromium.launchPersistentContext(profile, {
    ...(process.env.HISTORY_SWEEP_CHROMIUM ? { executablePath: process.env.HISTORY_SWEEP_CHROMIUM } : { channel: 'chromium' }),
    headless: true, viewport: { width: 1040, height: 900 }, acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  // Only permission dialogs and provider responses are mocked. Storage, CSP,
  // launcher, downloads, crypto and restore UI use the real unpacked extension.
  await result.addInitScript(() => {
    if (!location.protocol.startsWith('chrome-extension')) return;
    window.__allowSyncHost = true; window.__permissionRequests = [];
    chrome.permissions.request = async details => { window.__permissionRequests.push(details); return window.__allowSyncHost; };
    chrome.permissions.contains = async () => window.__allowSyncHost;
  });
  await result.route('https://dav.example.test/**', async route => {
    const request = route.request();
    requests.push({ method: request.method(), body: request.postData(), headers: request.headers() });
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, PUT, OPTIONS', 'access-control-expose-headers': 'ETag', etag: `"${revision}"` };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (request.method() === 'GET') return route.fulfill({ status: remote === null ? 404 : 200, body: remote === null ? '' : JSON.stringify(remote), headers });
    if (forceConflict) return route.fulfill({ status: 412, headers });
    remote = JSON.parse(request.postData()); revision++;
    return route.fulfill({ status: 201, headers });
  });
  return result;
};
try {
  context = await launch();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
  const manager = await context.newPage(); manager.on('pageerror', error => errors.push(error.message));
  await manager.goto(`${origin}/manager.html`); await enterWorkspace(manager);
  const page = manager;
  const pageCount = context.pages().length;
  await openEmbedded(page);
  check(context.pages().length === pageCount, 'WebDAV opens inside Preferences without creating a tab');
  check(await page.locator('#syncSettingsContent').isVisible(), 'sync surface is embedded in the settings window');
  check(await page.locator('#syncSettingsContent').evaluate(node => node.closest('dialog')?.id) === 'preferencesDialog', 'WebDAV shares the settings dialog');
  check(await page.locator('.sync-root h1').textContent() === 'Configuration sync', 'embedded settings render localized title');
  check(await page.locator('#uploadConfig').isDisabled(), 'remote controls disabled until a connection is saved');
  check(requests.length === 0, 'opening settings makes no remote requests');
  await page.locator('#davUrl').fill('https://dav.example.test/backup/config.json');
  await page.locator('#davUser').fill('synthetic-user'); await page.locator('#davPassword').fill(fixtureValue);
  await page.locator('#connectionForm button[type=submit]').click(); await idle(page);
  check(!(await page.locator('#uploadConfig').isDisabled()), 'save enables transfer controls');
  check(requests.length === 0, 'saving credentials makes no remote requests');
  await page.reload(); await openEmbedded(page);
  check(await page.locator('#davPassword').inputValue() === fixtureValue, 'saved credentials survive page reopening');
  await page.evaluate(() => { window.__allowSyncHost = false; });
  await page.locator('#testConnection').click(); await idle(page);
  check((await page.locator('#syncStatus').textContent()).includes('not granted'), `permission denial is actionable: ${await page.locator('#syncStatus').textContent()}`);
  check(requests.length === 0, 'denied access never contacts the provider');
  await page.evaluate(() => { window.__allowSyncHost = true; });
  await page.locator('#testConnection').click(); await idle(page);
  check((await page.locator('#syncStatus').textContent()).includes('no configuration'), 'missing remote file reported without claiming write access');
  page.on('dialog', dialog => dialog.accept());
  await page.locator('#uploadConfig').click(); await idle(page);
  check(remote?.format === 'history-sweep-config', 'upload creates valid configuration');
  const put = requests.find(item => item.method === 'PUT');
  check(put.headers['if-none-match'] === '*', 'new upload uses create-only condition');
  check(!put.body.includes(fixtureValue) && !put.body.includes('synthetic-user'), 'credentials excluded from remote JSON');
  forceConflict = true;
  await page.locator('#uploadConfig').click(); await idle(page);
  check((await page.locator('#syncStatus').textContent()).includes('remote file changed'), 'write conflicts shown without replacement'); forceConflict = false;
  remote = structuredClone(expected); revision++;
  await page.locator('#downloadConfig').click(); await page.locator('#restoreDialog').waitFor({ state: 'visible' });
  check((await page.locator('#restoreSummary').textContent()).includes('zh-CN'), 'download previews preferences before application');
  await page.locator('#restoreDialog [value=cancel]').click(); await idle(page);
  check(await page.evaluate(() => localStorage.getItem('language')) === null, 'cancelled download leaves preferences unchanged');
  await page.locator('#downloadConfig').click(); await page.locator('#restoreDialog [value=confirm]').click(); await idle(page);
  check(await page.evaluate(() => localStorage.getItem('theme')) === 'dark', 'confirmed restore applies appearance');
  check(await manager.evaluate(() => chrome.action.getPopup({})).then(value => value === ''), 'fullpage preference reaches real launcher');
  await page.locator('#backupPassword').fill(passphrase);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#exportBackup').click()]); await idle(page);
  const backupPath = join(temporary, 'backup.json'); await download.saveAs(backupPath);
  const backup = await readFile(backupPath, 'utf8');
  check(!backup.includes(fixtureValue) && !backup.includes('dav.example.test'), 'disk backup encrypts connection data');
  // Clear only this disposable profile's settings to model reinstall recovery.
  await page.evaluate(async () => { await chrome.storage.local.remove(['syncConnection', 'syncMetadata', 'launchMode']); localStorage.clear(); });
  await page.reload(); await openEmbedded(page);
  await page.locator('#backupFile').setInputFiles(backupPath);
  check(await page.locator('#backupFileName').textContent() === 'backup.json', 'custom picker displays the selected filename');
  check(await page.locator('#backupFilePicker').getAttribute('data-selected') === 'true', 'selected file receives a visible state');
  check(await page.locator('#backupFile').evaluate(input => getComputedStyle(input).opacity === '0'), 'native file input is visually replaced');
  await page.locator('#backupFile').focus();
  check(await page.locator('#backupFilePicker').evaluate(node => node.matches(':focus-within')), 'native file input remains keyboard focusable');
  await page.locator('#backupPassword').fill(passphrase + 'wrong');
  await page.locator('#importBackup').click(); await idle(page);
  check((await page.locator('#syncStatus').textContent()).includes('Could not decrypt'), 'wrong password rejected before preview');
  await page.locator('#backupPassword').fill(passphrase); await page.locator('#importBackup').click();
  await page.locator('#restoreDialog [value=confirm]').click(); await idle(page);
  check(await page.locator('#davPassword').inputValue() === fixtureValue, 'disk import restores credentials');
  check(await page.evaluate(() => localStorage.getItem('language')) === 'zh-CN', 'disk import restores preferences after data removal');
  permissionRequests.push(...await page.evaluate(() => window.__permissionRequests));
  await page.reload(); await openEmbedded(page);
  check(await page.locator('.sync-root h1').textContent() === '配置同步', 'Chinese locale applies on reopening');
  await page.setViewportSize({ width: 390, height: 844 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow settings have no horizontal overflow');
  check(await page.locator('#syncSettingsContent').evaluate(node => node.scrollWidth <= node.clientWidth), 'embedded content has no horizontal overflow');
  check(await page.locator('html').getAttribute('data-theme') === 'dark', 'settings honor restored dark mode');
  await page.locator('#davPassword').fill(''); await page.locator('#davUser').fill(''); await page.locator('#davUrl').fill('');
  await page.screenshot({ path: join(temporary, 'settings-preview.png'), fullPage: true });
  check(await page.locator('#provider').count() === 0 && await page.locator('#r2Fields').count() === 0, 'settings expose only WebDAV with no provider selector');
  check(permissionRequests.every(value => JSON.stringify(value.origins) === '["https://dav.example.test/*"]'), 'permissions use only selected origin');
  check(errors.length === 0, `no page errors: ${errors.join(', ')}`);
  await context.close(); context = await launch();
  const reopened = await context.newPage(); await reopened.goto(`${origin}/sync.html`); await ready(reopened);
  check(await reopened.locator('#davPassword').inputValue() === fixtureValue, 'connection survives real browser restart');
  await reopened.evaluate(() => chrome.storage.local.set({ syncConnection: { provider: 'unsupported-fixture' } }));
  await reopened.reload(); await ready(reopened);
  check(await reopened.locator('#syncStatus').getAttribute('data-error') === 'true' && !await reopened.locator('#importBackup').isDisabled(), 'corrupt stored connection still allows disk recovery');
  await reopened.locator('#backupFile').setInputFiles(backupPath); await reopened.locator('#backupPassword').fill(passphrase);
  await reopened.locator('#importBackup').click(); await reopened.locator('#restoreDialog [value=confirm]').click(); await idle(reopened);
  check(await reopened.locator('#davPassword').inputValue() === fixtureValue, 'disk backup recovers a corrupt connection');
  console.log(`Passed ${checks} native-extension configuration checks. Provider responses and permission dialogs were mocked; no real credentials or endpoints used.`);
} finally { await context?.close(); await rm(temporary, { recursive: true, force: true }); }
