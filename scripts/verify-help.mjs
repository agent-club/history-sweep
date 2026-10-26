import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';
import { releaseNotes } from '../extension/release-notes.mjs';

const { chromium } = dependency('playwright');
const output = process.env.HISTORY_SWEEP_HELP_OUTPUT || new URL('../output/help/', import.meta.url).pathname;
const server = createServer();
let browser;
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const records = Array.from({ length: 4 }, (_, index) => ({ id: `${index}`, url: `https://example.org/page-${index}`, title: `Example ${index}`, lastVisitTime: Date.now() - index * 60000, visitCount: index + 1 }));

async function fits(locator, label) {
  const size = await locator.evaluate(node => ({ width: node.clientWidth, content: node.scrollWidth, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, viewport: innerWidth }));
  check(size.content <= size.width + 1 && size.left >= 0 && size.right <= size.viewport + 1, `${label}: no horizontal overflow`);
}

try {
  await mkdir(output, { recursive: true });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
  for (const [layout, width, height] of [['manager', 1200, 860], ['popup', 360, 590], ['modal', 800, 650]]) {
    for (const language of ['en', 'zh-CN']) {
      const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await installMock(page, records);
      await page.addInitScript(language => {
        localStorage.setItem('language', language);
        localStorage.setItem('theme', language === 'en' ? 'dark' : 'light');
        chrome.runtime.getManifest = () => ({ version: '0.6.0' });
      }, language);
      if (layout === 'modal') await page.route('**/extension/manager.html', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
      });
      await page.goto(`${origin}/extension/${layout === 'popup' ? 'popup' : 'manager'}.html`);
      await page.locator('#selectAll:not(:disabled)').waitFor();
      check(await page.locator('dialog[open]').count() === 0, `${layout}/${language}: help never opens automatically`);
      check(await page.locator('#quickStartHint').isVisible(), 'first-use hint is optional and visible');
      await page.locator('#query').fill('example.org');
      await page.locator('#query').press('Enter');
      await page.locator('#selectAll:not(:disabled)').waitFor();
      await page.locator('#selectAll').click();
      const selection = await page.locator('#deleteLabel').textContent();
      await page.locator('#openQuickStartHint').click();
      check(await page.locator('#quickStartDialog').isVisible(), 'hint opens the guide');
      check(await page.locator('.quick-start-steps > li').count() === 3, 'guide explains three actions');
      await fits(page.locator('#quickStartDialog'), `${layout}/${language} guide`);
      await page.screenshot({ path: `${output}/${layout}-${language}-guide.png` });
      await page.locator('#closeQuickStart').focus();
      await page.keyboard.press('Shift+Tab');
      check(await page.locator('#finishQuickStart').evaluate(node => node === document.activeElement), 'backward Tab stays in guide');
      await page.keyboard.press('Tab');
      check(await page.locator('#closeQuickStart').evaluate(node => node === document.activeElement), 'forward Tab stays in guide');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.id === 'query');
      check(await page.locator('#query').evaluate(node => node === document.activeElement), 'closing returns focus to search');
      check(await page.locator('#query').inputValue() === 'example.org' && await page.locator('#deleteLabel').textContent() === selection, 'guide preserves search and selection');
      await page.locator('#searchHelpToggle').click();
      await page.locator('#openQuickStartSearch').click();
      await page.locator('#finishQuickStart').click();
      await page.waitForFunction(() => document.activeElement?.id === 'openQuickStartSearch');
      check(await page.locator('#openQuickStartSearch').evaluate(node => node === document.activeElement), 'search help entry regains focus');
      await page.locator('#searchHelpClose').click();
      await page.locator('#openPreferences').click();
      await page.waitForFunction(() => !document.querySelector('#savePreferences').disabled);
      await page.locator('#defaultRange').selectOption('today');
      await page.locator('#openQuickStartSettings').click();
      await page.keyboard.press('Escape');
      check(await page.locator('#preferencesDialog').isVisible() && await page.locator('#defaultRange').inputValue() === 'today', 'nested guide preserves the settings draft');
      await page.waitForFunction(() => document.activeElement?.id === 'openQuickStartSettings');
      check(await page.locator('#openQuickStartSettings').evaluate(node => node === document.activeElement), 'settings entry regains focus');
      await context.setOffline(true);
      await page.locator('#openUpdateSettings').click();
      check(await page.locator('#installedVersion').textContent() === 'v0.6.0', 'installed version remains separate from release status');
      check(await page.locator('#updateDialog .release-record').count() === releaseNotes.length, 'all package records are available offline');
      const published = page.locator('#updateDialog [data-release="0.6.0"]');
      check(await published.getAttribute('open') !== null && await published.locator('[data-status="published"]').count() === 1, 'installed release presets Published and starts expanded');
      const previous = page.locator('#updateDialog [data-release="0.5.0"]');
      check(await previous.locator('[data-status="published"]').count() === 1 && await previous.getAttribute('open') === null, 'previous published release starts collapsed');
      await previous.locator('summary').click();
      check(await previous.locator('.release-changes').isVisible(), 'previous changes can be expanded');
      await fits(page.locator('#updateDialog'), `${layout}/${language} release notes`);
      await page.locator('#updateDialog').evaluate(node => { node.scrollTop = 0; });
      await page.screenshot({ path: `${output}/${layout}-${language}-notes.png` });
      const lastSummary = page.locator('#updateDialog .release-record > summary').last();
      await lastSummary.focus();
      await page.keyboard.press('Tab');
      check(await page.locator('#closeUpdateDetails').evaluate(node => node === document.activeElement), 'release accordion summaries participate in the focus loop');
      await page.keyboard.press('Escape');
      check(await page.locator('#preferencesDialog').isVisible() && await page.locator('#defaultRange').inputValue() === 'today', 'closing notes keeps parent settings and draft');
      await context.setOffline(false);
      await page.reload();
      await page.locator('#selectAll:not(:disabled)').waitFor();
      check(await page.locator('#quickStartHint').isHidden(), 'opened guide dismisses the first-use hint across reloads');
      check(errors.length === 0, `${layout}/${language}: ${errors.join('; ')}`);
      await context.close();
    }
  }
  {
    const context = await browser.newContext({ viewport: { width: 320, height: 700 } });
    const page = await context.newPage();
    await installMock(page, records);
    await page.goto(`${origin}/extension/manager.html`);
    await page.locator('#dismissQuickStartHint').click();
    await page.reload();
    check(await page.locator('#quickStartHint').isHidden(), 'explicit dismissal persists without opening help');
    await page.locator('#searchHelpToggle').click();
    await page.locator('#openQuickStartSearch').click();
    await fits(page.locator('#quickStartDialog'), '320px guide');
    await page.screenshot({ path: `${output}/narrow-guide.png` });
    await context.close();
  }
  for (const width of [1280, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 850 } });
    const page = await context.newPage();
    await page.goto(`${origin}/site/releases.html`);
    for (const language of ['en', 'zh-CN']) {
      await page.locator(`[data-language="${language}"]`).click();
      for (const record of releaseNotes) {
        const entry = page.locator(`[data-release="${record.version}"]`);
        check(await entry.locator('.release-title').textContent() === record.title[language], 'website uses the canonical bilingual title');
        check(await entry.locator('.release-changes > li').allTextContents().then(actual => JSON.stringify(actual) === JSON.stringify(record.changes.map(change => change[language]))), 'website uses the canonical changes');
      }
      check(await page.locator('[data-release="0.6.0"] [data-status="published"]').count() === 1, 'website presets v0.6.0 as Published too');
      check(await page.locator('[data-release="0.6.0"]').getAttribute('open') !== null, 'website expands v0.6.0');
      await fits(page.locator('body'), `${width}px website/${language}`);
      await page.screenshot({ path: `${output}/site-${width}-${language}.png`, fullPage: true });
    }
    await context.close();
  }
  const metadata = JSON.parse(await readFile(new URL('../site/extension-updates.json', import.meta.url), 'utf8'));
  check(metadata.version === '0.6.0', 'public update metadata targets v0.6.0');
  console.log(`${checks} help and release-note checks passed. Screenshots: ${output}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
