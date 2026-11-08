import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { enterWorkspace } from './native-workspace.mjs';
import { injectModal } from '../extension/modal-host.mjs';

const argumentsMap = new Map();
for (let i = 2; i < process.argv.length; i += 2) argumentsMap.set(process.argv[i], process.argv[i + 1]);
const outputRoot = argumentsMap.get('--output') || tmpdir();
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(join(outputRoot, 'workspace-tools-'));
const profile = join(output, 'profile');
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const { chromium } = dependency('playwright');
const executable = argumentsMap.get('--browser') || process.env.HISTORY_SWEEP_CHROMIUM;
const errors = [], receipts = [];
let context, page, checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const screenshot = async name => {
  const path = join(output, name + '.png'); await page.screenshot({ path, animations: 'disabled' }); receipts.push(path);
};
const dialog = () => page.locator('#workspaceDialog');
const ensureAdvancedOpen = async () => {
  const panel = page.locator('.wt-advanced');
  if (!await panel.evaluate(element => element.open)) await panel.locator('summary').click();
};
const closeDialog = async () => { await dialog().locator('.wt-close').click(); };
const search = async query => {
  await page.locator('#query').fill(query);
  await page.locator('#query').press('Escape');
  await page.locator('#search').click();
  await page.waitForFunction(() => !document.querySelector('#search').disabled);
};
const rowFor = url => page.locator('.history-row').filter({ has: page.locator('input.row-select[data-url=' + JSON.stringify(url) + ']') });
const more = async url => { await rowFor(url).hover(); await rowFor(url).locator('.wt-row-more').click(); await dialog().waitFor({ state: 'visible' }); };

// Only these reserved-domain synthetic pages enter the disposable browser profile.
const tracked = 'https://reading.example/article/42?item=synthetic&utm_source=synthetic-mail&utm_campaign=synthetic-weekly#intro';
const second = 'https://reading.example/article/43';
const notes = 'https://notes.example/project/review';
const docs = 'https://docs.example/reference';
const titles = new Map([[tracked.split('#')[0], 'Web 平台阅读笔记'], [second, '阅读方法清单'], [notes, '项目资料回顾'], [docs, '=SUM(1,2)']]);

try {
  context = await chromium.launchPersistentContext(profile, {
    ...(executable ? { executablePath: executable } : { channel: 'chromium' }), headless: true,
    viewport: { width: 1280, height: 850 }, timezoneId: 'Asia/Shanghai',
    args: ['--disable-background-networking', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await context.route(/^https?:\/\//, route => {
    const title = titles.get(route.request().url());
    return title === undefined ? route.abort() : route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><title>${title}</title><p>Synthetic local test page</p>` });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host, workspace = `chrome-extension://${id}/manager.html`;
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  for (const url of [tracked, second, notes, docs, tracked]) await page.goto(url);
  await page.goto(workspace); await enterWorkspace(page);
  await page.getByRole('button', { name: '简体中文', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#savedSearches').disabled);
  await search('reading.example');
  check(await page.locator('.history-row').count() === 2, 'native hostname search reads the two synthetic reading pages');

  await page.locator('#savedSearches').click();
  await dialog().getByLabel('检索名称', { exact: true }).fill('每周阅读整理');
  await dialog().locator('[type=submit]').click();
  await dialog().waitFor({ state: 'hidden' });
  await page.locator('#savedSearches').click();
  await dialog().getByRole('button', { name: '重命名', exact: true }).click();
  await dialog().getByLabel('检索名称', { exact: true }).fill('每周阅读复查');
  await dialog().locator('[type=submit]').click(); await dialog().waitFor({ state: 'hidden' });
  check((await page.evaluate(async () => (await chrome.storage.local.get('workspaceTools')).workspaceTools.searches[0])).query === 'reading.example', 'renaming preserves the saved criteria');
  await search('notes.example');
  await page.locator('#savedSearches').click();
  await dialog().getByRole('button', { name: '应用此检索', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
  check(await page.locator('#query').inputValue() === 'reading.example', 'saved search restores the actual query');
  check((await page.locator('#selected').textContent()).startsWith('0'), 'saved search restores no selection');
  await page.locator('#savedSearches').click(); await screenshot('01-saved-searches'); await closeDialog();

  await ensureAdvancedOpen();
  await page.getByRole('button', { name: '添加条件', exact: true }).click();
  await page.locator('.wt-condition input').fill('/article/42');
  await page.getByRole('button', { name: '应用筛选', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#search').disabled);
  check(await page.locator('.history-row').count() === 1, 'explicit path condition narrows the current search');
  await page.locator('.row-select').first().check();
  await ensureAdvancedOpen();
  await page.locator('.wt-condition input').fill('/article/43');
  check(await page.locator('#delete').isDisabled(), 'editing a condition blocks deletion of the previous selection');
  await page.getByRole('button', { name: '应用筛选', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#search').disabled);
  check((await page.locator('#selected').textContent()).startsWith('0'), 'new conditions clear old selection');
  await ensureAdvancedOpen();
  await page.getByRole('button', { name: '清空条件', exact: true }).click();
  await ensureAdvancedOpen();
  await page.getByRole('button', { name: '应用筛选', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#search').disabled);

  await more(tracked); await dialog().getByRole('button', { name: '保留这个 URL', exact: true }).click();
  await dialog().waitFor({ state: 'hidden' });
  await page.waitForFunction(url => document.querySelector('.wt-protected-row .row-select')?.dataset.url === url, tracked);
  await page.locator('#selectAll').click();
  check(await rowFor(tracked).locator('.row-select').isDisabled(), 'kept URL cannot be selected');
  check(!await rowFor(tracked).locator('.row-select').isChecked(), 'select all excludes the kept URL');
  const denied = await page.evaluate(url => chrome.runtime.sendMessage({ type: 'start-delete', urls: [url] }), tracked);
  check(denied.code === 'PROTECTED_URL', 'worker independently rejects protected URL deletion');
  await page.locator('#selectAll').click(); await screenshot('05-compound-filters-protection');

  await page.getByRole('button', { name: '编辑网站标签 · reading.example', exact: true }).click();
  await dialog().getByLabel('我的标签', { exact: true }).fill('阅读资料\n工作');
  await dialog().locator('[type=submit]').click(); await dialog().waitFor({ state: 'hidden' });
  check(await page.locator('.wt-group-labels .wt-label').count() === 2, 'manual labels decorate the exact website group');
  await page.getByRole('button', { name: '编辑网站标签 · reading.example', exact: true }).click(); await screenshot('08-manual-labels'); await closeDialog();

  await more(tracked); await dialog().getByRole('button', { name: '访问明细', exact: true }).click();
  await page.waitForSelector('.wt-visit-detail .wt-visit');
  check(await page.locator('.wt-visit-detail input').count() === 0, 'visit details do not offer per-visit selection or deletion');
  await screenshot('06-visit-timeline');

  await more(tracked); await dialog().getByRole('button', { name: '净化链接', exact: true }).click();
  await dialog().getByLabel('要移除的参数名', { exact: true }).fill('utm_source\nutm_campaign');
  const cleaned = await dialog().getByLabel('净化后', { exact: true }).inputValue();
  check(cleaned === 'https://reading.example/article/42?item=synthetic#intro', 'clean-copy preview removes configured names and keeps business query and fragment');
  await dialog().getByRole('button', { name: '保存此网站规则', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#workspaceDialogStatus')?.textContent.includes('已保存在本机'));
  check((await page.evaluate(async () => (await chrome.storage.local.get('workspaceTools')).workspaceTools.linkRules)).length === 1, 'link rule saved only after explicit action');
  await screenshot('07-clean-link-copy');
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('synthetic clipboard denial'); } } }); });
  await dialog().getByRole('button', { name: '复制净化链接', exact: true }).click();
  check((await dialog().locator('#workspaceDialogStatus').textContent()).includes('手动复制'), 'clipboard denial leaves a manual-copy path');
  check(await page.evaluate(async url => (await chrome.history.getVisits({ url })).length > 0, tracked), 'clean copying leaves browser history intact');
  await closeDialog();

  await search('example'); await page.locator('#selectAll').click();
  const selectedCount = Number((await page.locator('#footerSelected').textContent()).match(/\d+/)[0]);
  check(selectedCount === 3, 'selection excludes the one kept synthetic page');
  await page.locator('#exportSelection').click();
  await dialog().locator('select').selectOption('csv');
  const exportPreview = await dialog().locator('textarea').inputValue();
  check(!exportPreview.includes(tracked), 'export preview excludes the unselected kept URL');
  check(exportPreview.includes("'=SUM"), 'CSV export neutralizes formula-like history titles');
  await screenshot('10-selected-export');
  const selectedDownload = page.waitForEvent('download');
  await dialog().getByRole('button', { name: '导出文件', exact: true }).click();
  const downloadedSelection = await selectedDownload;
  const exportedPath = join(output, 'synthetic-selected.csv'); await downloadedSelection.saveAs(exportedPath);
  check((await readFile(exportedPath, 'utf8')).replace(/\r\n/g, '\n') === exportPreview, 'download contains the previewed CSV (textarea normalizes CRLF)');

  await page.locator('#selectAll').click();
  await rowFor(second).locator('.row-select').check(); await page.locator('#delete').click();
  await page.getByRole('button', { name: '查看访问影响', exact: true }).click();
  await page.waitForSelector('.wt-impact-results strong');
  check((await page.locator('.wt-impact-results strong').textContent()).includes('1 个 URL'), 'visit impact describes the actual pending target');
  await screenshot('04-deletion-impact');
  await page.locator('#confirmDialog [value=cancel]').click();
  check(await page.evaluate(async url => (await chrome.history.getVisits({ url })).length > 0, second), 'canceling impact review never deletes');
  await page.locator('#delete').click(); await page.locator('#confirmDialog [value=confirm]').click();
  await page.waitForFunction(() => !document.querySelector('#query').disabled);
  await page.waitForFunction(async url => (await chrome.history.getVisits({ url })).length === 0, second);
  check(await page.evaluate(async url => (await chrome.history.getVisits({ url })).length > 0, tracked), 'confirmed deletion keeps protected URLs');
  check(await page.evaluate(async url => (await chrome.history.getVisits({ url })).length > 0, notes), 'confirmed deletion keeps unselected URLs');

  await page.locator('#openPreferences').click(); await page.locator('[data-settings-section=privacy]').click();
  await page.locator('#clearLocalActivity').click(); await screenshot('02-local-activity-control');
  await dialog().locator('[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#workspaceDialogStatus')?.textContent.includes('已清除'));
  const clearedState = await page.evaluate(async () => chrome.storage.local.get(['localActivity', 'workspaceTools']));
  check(Object.keys(clearedState.localActivity.days).length === 0, 'activity clearing removes counts and website summaries');
  check(clearedState.workspaceTools.protectedUrls.includes(tracked), 'activity clearing preserves protection');
  await closeDialog();

  await page.evaluate(async () => {
    await chrome.storage.local.set({ protectedSites: ['retained.example'], autoCleanup: { version: 2, paused: true, revision: 3, nextRunAt: null,
      rules: [{ id: 'synthetic-task', domain: 'reading.example', includeSubdomains: false, days: 7,
        enabled: false, nextRunAt: null, completed: false, schedule: { type: 'daily', time: '22:00' } }] } });
  });
  await page.locator('[data-settings-section=sync]').click();
  await page.waitForFunction(() => !document.querySelector('#exportBackup')?.disabled);
  for (const section of ['protection', 'browsing', 'tasks']) await page.locator(`[data-backup-section=${section}]`).check();
  const syntheticPassphrase = crypto.randomUUID();
  await page.locator('#backupPassword').fill(syntheticPassphrase);
  const backupDownload = page.waitForEvent('download'); await page.locator('#exportBackup').click();
  const backupPath = join(output, 'synthetic-backup.json'); await (await backupDownload).saveAs(backupPath);
  check(JSON.parse(await readFile(backupPath, 'utf8')).version === 2, 'selected local sections use the encrypted version-two disk format');
  await page.evaluate(async () => { await chrome.storage.local.set({ protectedSites: ['different.example'] }); });
  await page.locator('#backupFile').setInputFiles(backupPath); await page.locator('#backupPassword').fill(syntheticPassphrase);
  await page.locator('#backupPassword').fill(crypto.randomUUID());
  await page.locator('#importBackup').click();
  await page.waitForFunction(() => !document.querySelector('#importBackup').disabled && document.querySelector('#syncStatus').dataset.error === 'true');
  check(await page.evaluate(async () => (await chrome.storage.local.get('protectedSites')).protectedSites[0]) === 'different.example', 'wrong passphrase does not change existing settings');
  await page.locator('#backupPassword').fill(syntheticPassphrase);
  await page.locator('#importBackup').click(); await page.locator('#localRestoreDialog').waitFor({ state: 'visible' });
  await page.locator('#localRestoreDialog [value=cancel]').click();
  await page.waitForFunction(() => !document.querySelector('#importBackup').disabled);
  check(await page.evaluate(async () => (await chrome.storage.local.get('protectedSites')).protectedSites[0]) === 'different.example', 'canceling restore keeps the existing policy');
  await page.locator('#backupPassword').fill(syntheticPassphrase); await page.locator('#importBackup').click();
  await page.locator('#localRestoreDialog').waitFor({ state: 'visible' });
  check((await page.locator('#localRestoreDialog').textContent()).includes('保持暂停'), 'restore preview explicitly keeps imported tasks paused');
  await page.locator('#localRestoreDialog details').click(); await screenshot('03-selective-restore');
  await page.locator('#localRestoreDialog [value=confirm]').click();
  await page.waitForFunction(() => document.querySelector('#syncStatus')?.textContent.includes('恢复'));
  const restored = await page.evaluate(async () => chrome.storage.local.get(['autoCleanup', 'protectedSites', 'workspaceTools']));
  check(restored.protectedSites.includes('retained.example') && !restored.protectedSites.includes('different.example'), 'explicit restore applies the previewed protection replacement');
  check(restored.autoCleanup.paused && restored.autoCleanup.rules.every(rule => !rule.enabled && rule.nextRunAt === null), 'restored task scopes never resume automatically');
  check(restored.workspaceTools.searches.length === 1 && restored.workspaceTools.labels['reading.example'].values.length === 2, 'selective protection restore preserves searches and manual labels');
  await page.locator('#dismissPreferences').click();

  await page.evaluate(() => chrome.storage.local.set({ manualCleanupState: { id: 'synthetic-interruption', pending: true } }));
  await page.locator('.wt-interrupted').waitFor({ state: 'visible' });
  await page.locator('#query').fill(''); await screenshot('09-interrupted-cleanup');
  check(await page.evaluate(async url => (await chrome.history.getVisits({ url })).length > 0, tracked), 'interruption notice does not replay any deletion');
  await page.getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.locator('.wt-interrupted').waitFor({ state: 'hidden' });

  await page.goto(`chrome-extension://${id}/popup.html`); await enterWorkspace(page);
  await page.setViewportSize({ width: 440, height: 700 });
  await page.waitForFunction(() => !document.querySelector('#savedSearches').disabled);
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#savedSearches').disabled);
  await page.locator('#savedSearches').click();
  check(await dialog().evaluate(element => { const bounds = element.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight; }), 'saved-search dialog fits the narrow popup');
  await screenshot('popup-saved-searches-en');
  await page.keyboard.press('Tab');
  check(await dialog().evaluate(element => element.contains(document.activeElement)), 'Tab reaches a keyboard control in the anchored saved-search surface');
  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
  await page.locator('#themeToggle').click(); await page.locator('[data-theme-choice=dark]').click();
  await page.locator('#savedSearches').click(); await screenshot('popup-saved-searches-dark');
  check(await page.evaluate(() => document.documentElement.dataset.theme === 'dark'), 'new controls use the active dark theme');

  await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
  const controllerPage = page;
  const host = await context.newPage(); host.on('pageerror', error => errors.push(error.message));
  await host.route('https://modal.example/synthetic-host', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><title>Synthetic modal host</title><p>Local fixture only</p>' }));
  await host.goto('https://modal.example/synthetic-host'); await host.bringToFront();
  const syntheticLaunchId = crypto.randomUUID();
  await controllerPage.evaluate(async syntheticLaunchId => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.storage.session.set({ modalLaunchSessions: { [syntheticLaunchId]: { tabId: tab.id, expires: Date.now() + 60_000 } } });
  }, syntheticLaunchId);
  const navigation = host.waitForEvent('framenavigated', { predicate: frame => frame.url().startsWith(`chrome-extension://${id}/modal.html`) });
  await host.evaluate(injectModal, `chrome-extension://${id}/modal.html#launch=${syntheticLaunchId}`);
  const frame = await navigation; await frame.waitForLoadState('domcontentloaded'); await enterWorkspace(frame);
  await frame.waitForFunction(() => !document.querySelector('#savedSearches').disabled);
  await frame.locator('#savedSearches').click();
  check(await frame.locator('#workspaceDialog').isVisible(), 'saved searches work inside an authenticated webpage modal');
  await frame.locator('#workspaceDialog').evaluate(async element => {
    await Promise.all(element.getAnimations().filter(animation => Number.isFinite(animation.effect.getTiming().iterations)).map(animation => animation.finished));
  });
  check(await frame.locator('#workspaceDialog').evaluate(element => Number(getComputedStyle(element).opacity) === 1), 'nested feature dialog finishes its visible entry animation');
  page = host; await screenshot('modal-saved-searches-en');
  await host.keyboard.press('Escape'); await frame.locator('#workspaceDialog').waitFor({ state: 'hidden' });
  check(!frame.isDetached() && await frame.locator('#app').isVisible(), 'Escape closes the feature dialog while preserving the webpage modal');

  check(errors.length === 0, `no browser exceptions: ${errors.join('; ')}`);
  console.log(JSON.stringify({ checks, output, screenshots: receipts, result: 'passed' }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  console.error('Workspace tools verification failed. Synthetic-only artifacts:', output);
  throw error;
} finally {
  await context?.close(); await rm(profile, { recursive: true, force: true });
}
