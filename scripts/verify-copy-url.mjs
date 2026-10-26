import { enterWorkspace } from './native-workspace.mjs';
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
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-copy-'));
const server = createServer();
const urls = [
  'https://copy.example.test/plain',
  'http://copy.example.test/notes?source=copy&label=%E8%AE%BE%E8%AE%A1#section',
  'file:///synthetic/copy-brief.pdf',
  `https://copy.example.test/${'long-address-'.repeat(18)}?full=value#copy`,
];
let context;
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.HISTORY_SWEEP_CHROME || process.env.HISTORY_SWEEP_CHROMIUM;
  context = await chromium.launchPersistentContext(profile, {
    ...(executablePath ? { executablePath } : { channel: 'chromium' }), headless: true,
    viewport: { width: 1080, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionOrigin = `chrome-extension://${new URL(worker.url()).hostname}`;
  await worker.evaluate(async urls => {
    await chrome.storage.local.set({ protectedSites: [], browsingPreferences: { view: 'frequency', range: '7days' } });
    for (const url of urls) await chrome.history.addUrl({ url });
  }, urls);
  // Only this isolated localhost reader can read the clipboard, after a successful synthetic write.
  await context.grantPermissions(['clipboard-read'], { origin });
  const reader = await context.newPage();
  await reader.goto(`${origin}/extension/icons/ui/check.svg`);
  for (const layout of ['manager', 'popup', 'modal']) {
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(8000);
    await page.setViewportSize(layout === 'popup' ? { width: 440, height: 690 } : { width: 1080, height: 900 });
    await page.addInitScript(() => localStorage.setItem('language', 'en'));
    let target = page;
    if (layout === 'modal') {
      await page.goto(`${origin}/site/privacy.html`);
      const launchId = crypto.randomUUID();
      await page.bringToFront();
      await worker.evaluate(async launchId => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        await chrome.storage.session.set({ modalLaunchSessions: { [launchId]: { tabId: tab.id, expires: Date.now() + 60000 } } });
      }, launchId);
      const navigation = page.waitForEvent('framenavigated', { predicate: frame => frame.url().startsWith(`${extensionOrigin}/modal.html`) });
      await page.evaluate(injectModal, `${extensionOrigin}/modal.html#launch=${launchId}`);
      await navigation;
      target = page.frames().find(frame => frame.url().startsWith(`${extensionOrigin}/modal.html`));
    } else await page.goto(`${extensionOrigin}/${layout}.html`);
    await enterWorkspace(target);
    await target.locator('#query').fill('copy');
    await target.locator('#mode').selectOption('contains');
    await target.locator('#search').click();
    await target.waitForFunction(() => !document.querySelector('#search').disabled);
    for (const grouping of ['groupByDate', 'groupBySite', 'groupByFrequency']) {
      await target.locator(`#${grouping}`).click();
      await target.waitForFunction(() => !document.querySelector('#search').disabled);
      if (grouping !== 'groupByFrequency' && await target.locator('#expandGroups').getAttribute('data-expanded') !== 'true') await target.locator('#expandGroups').click();
      const rows = target.locator('.history-row:visible');
      const visibleCount = await rows.count();
      check(visibleCount === urls.length, `${layout}/${grouping}: expected ${urls.length} synthetic records, found ${visibleCount}`);
      for (const url of urls) {
        const row = rows.filter({ has: target.locator(`.row-select[data-url=${JSON.stringify(url)}]`) });
        check(await row.locator('.page-address > .row-copy').count() === 1, `${layout}/${grouping}: A places copy beside the URL`);
      }
    }
    const row = target.locator('.history-row:visible').filter({ has: target.locator(`.row-select[data-url=${JSON.stringify(urls[1])}]`) });
    const copy = row.locator('.row-copy');
    await page.mouse.move(1, 1);
    await target.locator('#groupByFrequency').focus();
    await target.waitForFunction(() => [...document.querySelectorAll('.history-row .row-copy')].every(el => getComputedStyle(el).opacity === '0'));
    checks++;
    await row.hover();
    await target.waitForFunction(() => {
      const row = document.querySelector('.history-row:hover');
      return row && ['.row-copy', '.row-delete'].every(selector => getComputedStyle(row.querySelector(selector)).opacity === '1');
    });
    checks++;
    await target.locator('.row-select:visible').first().check();
    await row.hover();
    await copy.click();
    await target.waitForFunction(() => document.querySelector('.row-copy[data-state=success]'));
    await reader.bringToFront();
    check(await reader.evaluate(() => navigator.clipboard.readText()) === urls[1], `${layout}: native clipboard preserves query, encoding and fragment`);
    check(await target.locator('.row-select:checked:visible').count() === 1, `${layout}: copy preserves the batch selection`);
    await page.bringToFront();
    await copy.focus();
    await page.keyboard.press('Enter');
    await target.waitForFunction(() => document.querySelector('.row-copy[data-state=success]'));
    check(await copy.evaluate(el => document.activeElement === el), `${layout}: keyboard copy retains focus`);
    await target.waitForFunction(() => !document.querySelector('.row-copy[data-state]'));
    check(await copy.locator('.row-copy-hint').textContent() === 'Copy URL', `${layout}: feedback restores its idle label`);
    await target.getByRole('button', { name: '简体中文', exact: true }).click();
    check(await row.locator('.row-copy-hint').textContent() === '复制网址', `${layout}: Chinese copy label`);
    await target.locator('#themeToggle').click(); await target.locator('[data-theme-choice=dark]').click();
    await row.hover();
    check(await copy.evaluate(el => el.querySelector('.ui-icon').getBoundingClientRect().width === 14), `${layout}: icon has its intended frame`);
    await target.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Synthetic clipboard rejection'); } } }));
    await copy.click();
    await target.locator('#copyDialog[open]').waitFor();
    check(await target.locator('#copyUrlValue').inputValue() === urls[1], `${layout}: failure exposes the original full URL`);
    check(await target.locator('#copyUrlValue').evaluate(el => document.activeElement === el && el.selectionStart === 0 && el.selectionEnd === el.value.length), `${layout}: manual recovery is focused and selected`);
    check(await target.locator('#copyDialogTitle').textContent() === '复制网址失败', `${layout}: recovery is localized`);
    await page.keyboard.press('Escape');
    check(await target.locator('#copyDialog').evaluate(el => !el.open), `${layout}: Escape dismisses recovery`);
    check(await copy.evaluate(el => document.activeElement === el), `${layout}: recovery restores copy-button focus`);
    if (layout === 'manager') await page.setViewportSize({ width: 320, height: 800 });
    check(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${layout}: no horizontal page overflow`);
    check(await target.locator('.row-copy:visible').evaluateAll(nodes => nodes.every(el => { const button = el.getBoundingClientRect(); const cell = el.closest('.page-cell').getBoundingClientRect(); return button.left >= cell.left && button.right <= cell.right; })), `${layout}: copy stays inside its page cell`);
    check(await target.locator('.protocol-badge-risk:visible').evaluateAll(nodes => nodes.every(el => el.scrollWidth <= el.clientWidth)), `${layout}: HTTP label remains readable`);
    check(errors.length === 0, `${layout}: no page exceptions`);
    await page.close();
  }
  check(await worker.evaluate(async () => (await chrome.history.search({ text: 'copy', startTime: 0, maxResults: 100 })).length) === urls.length, 'Copy leaves synthetic native history intact');
  console.log(`${checks} URL-copy checks passed, including native clipboard writes in manager, popup and injected modal. Only a disposable browser profile and synthetic history were used.`);
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
