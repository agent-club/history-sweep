import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';

const { chromium } = dependency('playwright');
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-native-'));
const browserOptions = process.env.HISTORY_SWEEP_CHROMIUM
  ? { executablePath: process.env.HISTORY_SWEEP_CHROMIUM }
  : { channel: 'chromium' };
const server = createServer();
let context;

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(profile, {
    ...browserOptions,
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });

  const page = await context.newPage();
  await page.goto('chrome://extensions/');
  const id = await page.evaluate(() => {
    const list = document.querySelector('extensions-manager')?.shadowRoot
      ?.querySelector('extensions-item-list')?.shadowRoot;
    return [...(list?.querySelectorAll('extensions-item') || [])]
      .find(item => item.shadowRoot?.querySelector('#name')?.textContent?.trim() === 'History Sweep')?.id;
  });
  assert.ok(id, 'unpacked extension loaded');

  // Only this disposable browser profile receives and deletes the local test visits.
  await page.goto(`${origin}/site/`);
  await page.goto(`${origin}/site/privacy.html`);
  await page.goto(`chrome-extension://${id}/manager.html`);
  const localVisits = await page.evaluate(async origin =>
    (await chrome.history.search({ text: '', startTime: 0, maxResults: 100 }))
      .filter(item => item.url.startsWith(origin)).length, origin);
  assert.ok(localVisits >= 2, 'test pages recorded in isolated history');

  await page.locator('#query').fill('127.0.0.1');
  await page.locator('#mode').selectOption('host-exact');
  await page.locator('#search').click();
  await page.waitForFunction(count => document.querySelector('#count').textContent.startsWith(`${count} `), localVisits);
  await page.locator('#selectAll').click();
  assert.match(await page.locator('#selected').textContent(), new RegExp(`^${localVisits} selected`));
  await page.locator('#selectAll').click();
  assert.match(await page.locator('#selected').textContent(), /^0 selected/);
  await page.locator('#rows tr').first().locator('.page-cell').click();
  assert.match(await page.locator('#selected').textContent(), /^1 selected/);
  await page.locator('#delete').click();
  await page.locator('#confirmDialog [value=confirm]').click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Removed 1 URLs'));
  const remaining = await page.evaluate(async origin =>
    (await chrome.history.search({ text: '', startTime: 0, maxResults: 100 }))
      .filter(item => item.url.startsWith(origin)).length, origin);
  assert.equal(remaining, localVisits - 1);
  const backgroundVisit = `${origin}/site/?background-test`;
  await page.goto(backgroundVisit);
  await page.goto(`chrome-extension://${id}/popup.html`);
  assert.equal(await page.getByRole('textbox', { name: 'Find in your history', exact: true }).count(), 1);
  await page.locator('#query').fill('127.0.0.1');
  await page.locator('#mode').selectOption('host-exact');
  await page.locator('#search').click();
  await page.waitForFunction(() => document.querySelector('#rows tr'));
  await page.getByRole('checkbox', { name: `Select ${backgroundVisit}`, exact: true }).check();
  const worker = context.serviceWorkers().find(item => item.url().endsWith('/background.mjs'));
  assert.ok(worker, 'extension service worker is active');
  await worker.evaluate(() => {
    const nativeDelete = chrome.history.deleteUrl.bind(chrome.history);
    const gate = new Promise(resolve => { globalThis.finishTestDeletion = resolve; });
    chrome.history.deleteUrl = async details => { globalThis.testDeletionStarted = true; await gate; return nativeDelete(details); };
  });
  await page.locator('#delete').click();
  await page.locator('#confirmDialog [value=confirm]').click();
  await page.waitForFunction(() => document.querySelector('#query').disabled);
  assert.equal(await worker.evaluate(() => globalThis.testDeletionStarted), true);
  await page.close();
  await worker.evaluate(() => globalThis.finishTestDeletion());
  const review = await context.newPage();
  await review.goto(`chrome-extension://${id}/manager.html`);
  await review.waitForFunction(async url => (await chrome.history.getVisits({ url })).length === 0, backgroundVisit);
  const afterClose = await review.evaluate(async origin =>
    (await chrome.history.search({ text: '', startTime: 0, maxResults: 100 }))
      .filter(item => item.url.startsWith(origin)).length, origin);
  assert.equal(afterClose, localVisits - 1, 'closing the UI does not stop deletion or remove unselected visits');

  await review.goto(`chrome-extension://${id}/popup.html`);
  await review.locator('#query').fill('127.0.0.1');
  await review.locator('#mode').selectOption('host-exact');
  const fullPagePromise = context.waitForEvent('page');
  await review.locator('#openFull').click();
  const fullPage = await fullPagePromise;
  await fullPage.waitForFunction(() => document.querySelector('#query')?.value === '127.0.0.1' && !document.querySelector('#query').disabled);
  assert.equal(new URL(fullPage.url()).search, '');
  assert.equal(new URL(fullPage.url()).hash, '');
  assert.equal(await fullPage.locator('#mode').inputValue(), 'host-exact');
  console.log('Native extension smoke passed: real history deletion survives a closed UI; search handoff leaves a clean URL. Disposable profile only.');

  const staleRoot = await mkdtemp(join(tmpdir(), 'history-sweep-stale-manifest-'));
  let staleContext;
  try {
    const staleExtension = join(staleRoot, 'extension');
    await cp(extension, staleExtension, { recursive: true });
    const manifestPath = join(staleExtension, 'manifest.json');
    const staleManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    // Reproduce updated UI code running before Chrome reloads the new background entry.
    delete staleManifest.background;
    await writeFile(manifestPath, JSON.stringify(staleManifest));
    staleContext = await chromium.launchPersistentContext(join(staleRoot, 'profile'), {
      ...browserOptions, headless: true,
      args: [`--disable-extensions-except=${staleExtension}`, `--load-extension=${staleExtension}`],
    });
    const stalePage = await staleContext.newPage();
    await stalePage.goto('chrome://extensions/');
    const staleId = await stalePage.evaluate(() => {
      const list = document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-item-list').shadowRoot;
      return [...list.querySelectorAll('extensions-item')].find(item => item.shadowRoot.querySelector('#name').textContent.trim() === 'History Sweep').id;
    });
    await stalePage.goto(`${origin}/site/?stale-manifest-test`);
    await stalePage.goto(`chrome-extension://${staleId}/popup.html`);
    await stalePage.locator('#query').fill('127.0.0.1');
    await stalePage.locator('#mode').selectOption('host-exact');
    await stalePage.locator('#search').click();
    await stalePage.waitForFunction(() => document.querySelector('#rows tr'));
    await stalePage.locator('#selectAll').click();
    await stalePage.locator('#delete').click();
    await stalePage.locator('#confirmDialog [value=confirm]').click();
    await stalePage.waitForFunction(() => document.querySelector('#status').dataset.kind === 'reloadExtension');
    assert.match(await stalePage.locator('#status').textContent(), /chrome:\/\/extensions/);
    assert.equal(await stalePage.locator('#delete').isEnabled(), true);
    const unchanged = await stalePage.evaluate(async origin =>
      (await chrome.history.search({ text: '', startTime: 0, maxResults: 100 })).filter(item => item.url.startsWith(origin)).length, origin);
    assert.equal(unchanged, 1, 'missing background does not delete or falsely claim success');
    console.log('Stale manifest reproduced: confirmed deletion preserves history and displays reload instructions.');
  } finally {
    if (staleContext) await staleContext.close();
    await rm(staleRoot, { recursive: true, force: true });
  }
} finally {
  if (context) await context.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
