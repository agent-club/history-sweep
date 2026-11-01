import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { enterWorkspace } from './native-workspace.mjs';

const { chromium } = dependency('playwright');
const directory = await mkdtemp(join(tmpdir(), 'history-sweep-hint-click-'));
let context, page;
let checks = 0;
const verify = (value, message) => { assert.ok(value, message); checks++; };
try {
  context = await chromium.launchPersistentContext(join(directory, 'profile'), {
    ...(process.env.HISTORY_SWEEP_CHROMIUM ? { executablePath: process.env.HISTORY_SWEEP_CHROMIUM } : { channel: 'chromium' }),
    headless: true, reducedMotion: 'reduce', viewport: { width: 1280, height: 850 },
    args: ['--disable-background-networking', `--disable-extensions-except=${fileURLToPath(new URL('../extension/', import.meta.url))}`, `--load-extension=${fileURLToPath(new URL('../extension/', import.meta.url))}`],
  });
  await context.route(/^https?:\/\//, route => route.abort());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
  const target = 'https://old-recommended.example.test/synthetic';
  await worker.evaluate(async target => {
    await chrome.history.addUrl({ url: target });
    for (let i = 1; i < 25; i++) await chrome.history.addUrl({ url: `${target}?entry=${i}` });
    for (let i = 0; i < 110; i++) await chrome.history.addUrl({ url: `https://ordinary-${i}.example.test/synthetic` });
    const day = offset => { const date = new Date(); date.setDate(date.getDate() - offset); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
    await chrome.storage.local.set({ softPrivacy: false, localActivity: { version: 1, startedOn: day(1), days: Object.fromEntries([0, 1].map(offset => [day(offset), {
      operations: 1, pages: 1, websitesComplete: true, websites: [{ domain: 'old-recommended.example.test' }],
    }])) } });
    await chrome.storage.local.set({ cleanupRecommendationSettings: {
      version: 1, habit: { enabled: true, lookbackDays: 7, minimumDays: 2 },
      types: { extension: true, application: false }, cue: 'never',
      sites: [{ domain: 'old-recommended.example.test', includeSubdomains: false, condition: 'always', days: null, enabled: true }],
    } });
  }, target);
  const errors = [];
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/manager.html`); await enterWorkspace(page);
  await page.locator('#cleanupHint').waitFor({ state: 'visible' });
  verify(await page.locator('.website-group').count() === 100, 'fixture exceeds the initial website rendering limit');
  verify(!await page.locator('.website-group[data-hostname="old-recommended.example.test"]').count(), 'recommended website is outside the rendered groups');
  const selection = await page.locator('#footerSelected').textContent();
  await page.locator('#cleanupHintToggle').click({ position: { x: 250, y: 20 } });
  verify(await page.locator('#cleanupHintToggle').getAttribute('aria-expanded') === 'true', 'whole recommendation bar responds to a click');
  const details = page.locator('#cleanupHintReasons');
  verify(await details.isVisible(), 'clicking opens a preview even for unrendered history');
  verify(await details.evaluate(element => element.tagName !== 'DIALOG' && Boolean(element.closest('#resultScroll'))), 'recommendations expand inline inside the normal result list');
  verify(await page.locator('dialog[open]').count() === 0, 'viewing recommendations opens no modal');
  verify(await details.locator('.cleanup-preview-group[data-reason=site]').count() === 1 && await details.locator('.cleanup-preview-group[data-reason=extension]').count() === 1, 'actual history matches are grouped by recommendation reason');
  verify((await details.textContent()).includes(target), 'visible explanation identifies the recommended synthetic URL');
  verify((await details.textContent()).includes('Your website rule'), 'explanation includes the actual recommendation reason');
  const siteGroup = details.locator('[data-reason=site]');
  await siteGroup.locator('summary').click();
  verify(await siteGroup.locator('.cleanup-hint-item').count() === 20, 'large reason groups initially render a bounded preview');
  await siteGroup.getByRole('button', { name: 'Show more', exact: true }).click();
  verify(await siteGroup.locator('.cleanup-hint-item').count() === 25, 'load more exposes the rest of the actual group');
  const currentUrls = new Set(await page.evaluate(async () => (await chrome.history.search({ text: '', startTime: 0, maxResults: 1000 })).map(item => item.url)));
  verify((await details.locator('.cleanup-hint-url').allTextContents()).every(url => currentUrls.has(url)), 'every preview URL comes from this profile’s actual history');
  await siteGroup.locator('summary').click();
  verify(!await siteGroup.locator('ul').isVisible(), 'reason groups can be collapsed');
  await siteGroup.locator('summary').press('Enter');
  verify(await siteGroup.locator('ul').isVisible(), 'reason groups reopen by keyboard');
  verify(await page.locator('#footerSelected').textContent() === selection, 'viewing reasons preserves selection');
  const bounds = await details.boundingBox();
  verify(bounds && bounds.y < 850 && bounds.y + bounds.height > 0, 'expanded explanation is visible in the current viewport');
  await details.evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: join(directory, 'manager-expanded.png'), animations: 'disabled' });
  await page.locator('#cleanupHintToggle').press('Escape');
  await page.waitForFunction(() => document.querySelector('#cleanupHintToggle').getAttribute('aria-expanded') === 'false');
  verify(!await details.isVisible(), 'Escape collapses the explanation');
  await page.locator('#cleanupHintToggle').press('Enter');
  verify(await details.isVisible(), 'keyboard activation expands the explanation');
  await page.locator('#cleanupHintToggle').click();
  verify(!await details.isVisible(), 'the normal list toggle collapses recommendations');
  await page.locator('#cleanupHintToggle').press('Space');
  verify(await details.isVisible(), 'Space opens the preview');
  await page.locator('#cleanupHintToggle').press('Escape');
  await page.setViewportSize({ width: 440, height: 700 });
  await page.goto(`${origin}/popup.html`); await enterWorkspace(page);
  await page.locator('#cleanupHint').waitFor({ state: 'visible' });
  await page.locator('#themeToggle').click(); await page.locator('[data-theme-choice=dark]').click();
  await page.locator('#cleanupHintToggle').click();
  verify(await page.locator('#cleanupHintReasons').isVisible(), 'popup opens the same explanation');
  await page.locator('#cleanupHintReasons [data-reason=extension] > summary').click();
  verify(await page.locator('#cleanupHintReasons').evaluate(element => element.scrollWidth <= element.clientWidth), 'long URL stays inside the narrow explanation');
  await page.screenshot({ path: join(directory, 'popup-dark-expanded.png'), animations: 'disabled' });
  verify(await page.locator('#cleanupHintReasons [data-reason=frequent]').count() === 1, 'local cleanup evidence has its own reason group');
  await worker.evaluate(() => chrome.storage.local.set({ softPrivacy: true }));
  await page.waitForFunction(() => !document.querySelector('#cleanupHintReasons [data-reason=frequent]'));
  verify((await page.locator('#cleanupHintReasons').textContent()).includes('Your website rule') && !(await page.locator('#cleanupHintReasons').textContent()).includes('Cleared on'), 'an open preview removes newly private cleanup details while retaining independent website rules');
  verify(errors.length === 0, `no browser exceptions: ${errors.join('; ')}`);
  console.log(JSON.stringify({ result: 'passed', checks, screenshots: directory, syntheticHistoryOnly: true }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(directory, 'failure.png') }).catch(() => {});
  console.error('Synthetic-only verification artifacts:', directory);
  throw error;
} finally {
  await context?.close(); await rm(join(directory, 'profile'), { recursive: true, force: true });
}
