import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';
import { releaseNotes } from '../extension/release-notes.mjs';

const { chromium } = dependency('playwright');
const { version: packageVersion } = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const previousVersion = releaseNotes.find(record => record.status === 'published' && record.version !== packageVersion).version;
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
      await page.addInitScript(({ language, packageVersion }) => {
        localStorage.setItem('language', language);
        localStorage.setItem('theme', language === 'en' ? 'dark' : 'light');
        chrome.runtime.getManifest = () => ({ version: packageVersion });
      }, { language, packageVersion });
      if (layout === 'modal') await page.route('**/extension/manager.html', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
      });
      await page.goto(`${origin}/extension/${layout === 'popup' ? 'popup' : 'manager'}.html`);
      await page.locator('#selectAll:not(:disabled)').waitFor();
      check(await page.locator('dialog[open]').count() === 0, `${layout}/${language}: help never opens automatically`);
      check(await page.locator('#quickStartDialog').isHidden(), 'tour remains opt-in on page load');
      check(await page.locator('#quickStartHint').isVisible(), 'first-use hint is optional and visible');
      await page.locator('#query').fill('example.org');
      await page.locator('#query').press('Enter');
      await page.locator('#selectAll:not(:disabled)').waitFor();
      check(await page.locator('#quickStartHint').isHidden(), 'first successful search dismisses the first-use hint');
      await page.locator('#selectAll').click();
      const selection = await page.locator('#deleteLabel').textContent();
      await page.locator('#searchHelpToggle').click();
      await page.locator('#openQuickStartSearch').click();
      check(await page.locator('#quickStartDialog').isVisible(), 'search help opens the guide after the hint is gone');
      check(await page.locator('#quickStartDialog').getAttribute('data-step') === '1', 'guide starts at search');
      check(await page.locator('#previousQuickStart').isDisabled(), 'first step has no back action');
      await page.locator('#query').fill('example.org');
      for (let step = 1; step <= 3; step++) {
        check(await page.locator('#quickStartDialog').getAttribute('data-step') === String(step), 'guide advances one step at a time');
        await fits(page.locator('#quickStartCard'), `${layout}/${language} step ${step}`);
        const geometry = await page.locator('#quickStartCard').evaluate(node => {
          const card = node.getBoundingClientRect();
          const spot = document.querySelector('#quickStartSpotlight').getBoundingClientRect();
          return { fits: card.top >= 0 && card.bottom <= innerHeight + 1,
            separate: card.bottom <= spot.top || card.top >= spot.bottom || card.right <= spot.left || card.left >= spot.right };
        });
        check(geometry.fits && geometry.separate, `${layout}/${language} step ${step}: guide stays in the viewport without covering its target ${JSON.stringify(geometry)}`);
        await page.screenshot({ path: `${output}/${layout}-${language}-step-${step}.png` });
        if (step === 2) {
          await page.locator('#previousQuickStart').click();
          check(await page.locator('#quickStartDialog').getAttribute('data-step') === '1', 'Back returns to the previous control');
          await page.locator('#finishQuickStart').click();
          await page.locator('#selectAll').click();
          await page.locator('#selectAll').click();
        }
        if (step < 3) await page.locator('#finishQuickStart').click();
      }
      check(await page.locator('#quickStartWarning').isVisible(), 'final step keeps deletion consequences visible');
      check(await page.locator('#confirmDialog').isHidden(), 'tour never opens or confirms deletion itself');
      await page.locator('#closeQuickStart').focus();
      await page.keyboard.press('Shift+Tab');
      check(await page.locator('#delete').evaluate(node => node === document.activeElement), 'keyboard navigation reaches the highlighted control');
      await page.keyboard.press('Tab');
      check(await page.locator('#closeQuickStart').evaluate(node => node === document.activeElement), 'forward Tab stays in guide');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.id === 'openQuickStartSearch');
      check(await page.locator('#openQuickStartSearch').evaluate(node => node === document.activeElement), 'closing returns focus to the search help entry');
      check(await page.locator('#query').inputValue() === 'example.org' && await page.locator('#deleteLabel').textContent() === selection, 'guide preserves search and selection');
      await page.locator('#openQuickStartSearch').click();
      await page.locator('#skipQuickStart').click();
      await page.waitForFunction(() => document.activeElement?.id === 'openQuickStartSearch');
      check(await page.locator('#openQuickStartSearch').evaluate(node => node === document.activeElement), 'search help entry regains focus');
      await page.locator('#openQuickStartSearch').click();
      await page.locator('#finishQuickStart').click();
      await page.locator('#finishQuickStart').click();
      await page.locator('#delete').click();
      await page.locator('#confirmDialog').waitFor();
      check(await page.locator('#quickStartDialog').isHidden(), 'opening the real preview ends the tour');
      check(await page.evaluate(() => window.__deleted.length) === 0, 'preview still requires independent deletion confirmation');
      await page.locator('#confirmDialog [value="cancel"]').click();
      await page.locator('#searchHelpClose').click();
      await page.locator('#openPreferences').click();
      await page.waitForFunction(() => !document.querySelector('#savePreferences').disabled);
      await page.locator('#defaultRange').selectOption('today');
      await page.locator('#openQuickStartSettings').click();
      check(await page.locator('#preferencesDialog').isHidden(), 'settings yield to the main-screen tour without discarding draft');
      await page.keyboard.press('Escape');
      check(await page.locator('#preferencesDialog').isVisible() && await page.locator('#defaultRange').inputValue() === 'today', 'nested guide preserves the settings draft');
      await page.waitForFunction(() => document.activeElement?.id === 'openQuickStartSettings');
      check(await page.locator('#openQuickStartSettings').evaluate(node => node === document.activeElement), 'settings entry regains focus');
      await context.setOffline(true);
      await page.locator('#openUpdateSettings').click();
      check(await page.locator('#installedVersion').textContent() === `v${packageVersion}`, 'installed version remains separate from release status');
      check(await page.locator('#updateDialog .release-record').count() === releaseNotes.length, 'all package records are available offline');
      const published = page.locator(`#updateDialog [data-release="${packageVersion}"]`);
      check(await published.getAttribute('open') !== null && await published.locator('[data-status="published"]').count() === 1, 'installed release presets Published and starts expanded');
      check(await published.locator('[data-status="candidate"]').count() === 0, 'the offline package is Published independently of store review');
      const previous = page.locator(`#updateDialog [data-release="${previousVersion}"]`);
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
      check(await page.locator('#quickStartHint').isHidden(), 'first-use hint stays dismissed across reloads');
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
    await fits(page.locator('#searchHelpPanel'), '320px search help');
    await page.locator('#openQuickStartSearch').click();
    for (let step = 1; step <= 3; step++) {
      await fits(page.locator('#quickStartCard'), `320px guide step ${step}`);
      await page.screenshot({ path: `${output}/narrow-step-${step}.png` });
      await page.locator('#finishQuickStart').click();
    }
    check(await page.locator('#quickStartDialog').isHidden(), 'finishing exits the tour');
    await page.locator('#openQuickStartSearch').click();
    check(await page.locator('#quickStartDialog').getAttribute('data-step') === '1', 'reopening restarts the tour');
    await page.locator('#query').fill('no-matching-history.invalid');
    await page.locator('#query').press('Enter');
    await page.locator('#empty').waitFor();
    await page.locator('#finishQuickStart').click();
    check(await page.locator('#selectAll').isDisabled(), 'empty results keep the original selection restriction');
    await page.locator('#finishQuickStart').click();
    check(await page.locator('#delete').isDisabled(), 'tour never enables deletion without a selection');
    await page.locator('#finishQuickStart').click();
    check(await page.locator('#quickStartDialog').isHidden(), 'an empty result does not trap users in the tour');
    check(await page.evaluate(() => window.__deleted.length) === 0, 'tour completion never deletes history');
    await context.close();
  }
  for (const width of [1280, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 850 } });
    const page = await context.newPage();
    const response = await page.goto(`${origin}/site/releases.html`);
    assert.ok(response?.ok(), 'The browser fixture must include site/releases.html');
    for (const language of ['en', 'zh-CN']) {
      await page.locator(`[data-language="${language}"]`).click();
      for (const record of releaseNotes) {
        const entry = page.locator(`[data-release="${record.version}"]`);
        check(await entry.locator('.release-title').textContent() === record.title[language], 'website uses the canonical bilingual title');
        check(await entry.locator('.release-changes > li').allTextContents().then(actual => JSON.stringify(actual) === JSON.stringify(record.changes.map(change => change[language]))), 'website uses the canonical changes');
      }
      check(await page.locator('[data-release="0.6.0"] [data-status="published"]').count() === 1, 'website presets v0.6.0 as Published too');
      check(await page.locator('[data-release="0.6.0"]').getAttribute('open') === null, 'website keeps the previous published release collapsed');
      check(await page.locator(`[data-release="${packageVersion}"] [data-status="published"]`).count() === 1, 'website marks the current package Published independently of store review');
      check(await page.locator(`[data-release="${packageVersion}"]`).getAttribute('open') !== null, 'website expands the current published package');
      await fits(page.locator('body'), `${width}px website/${language}`);
      await page.screenshot({ path: `${output}/site-${width}-${language}.png`, fullPage: true });
    }
    await context.close();
  }
  const metadata = JSON.parse(await readFile(new URL('../site/extension-updates.json', import.meta.url), 'utf8'));
  check(metadata.version === '0.7.0', 'public update metadata targets the verified Chrome Web Store version');
  console.log(`${checks} help and release-note checks passed. Screenshots: ${output}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
