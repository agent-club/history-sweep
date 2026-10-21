import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';

const { chromium } = dependency('playwright');
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-frequency-native-'));
let context;
const server = createServer();
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.HISTORY_SWEEP_CHROMIUM ? { executablePath: process.env.HISTORY_SWEEP_CHROMIUM } : { channel: 'chromium' }),
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/manager.html`);
  const evidence = await page.evaluate(async () => {
    // addUrl records fictional URLs without navigating to or fetching a site.
    const a = 'https://revisited.frequency.example/page';
    const b = 'https://once.frequency.example/page';
    const pause = () => new Promise(resolve => setTimeout(resolve, 30));
    await chrome.history.addUrl({ url: a }); await pause();
    await chrome.history.addUrl({ url: a }); await pause();
    await chrome.history.addUrl({ url: b });
    const inside = await chrome.history.getVisits({ url: b });
    const first = await chrome.history.getVisits({ url: a });
    const range = { startTime: Math.min(...first.map(v => v.visitTime)) - 1, endTime: Math.max(...inside.map(v => v.visitTime)) + 1 };
    await pause(); await chrome.history.addUrl({ url: a });
    const latest = await chrome.history.getVisits({ url: a });
    const bounded = await chrome.history.search({ text: '', ...range, maxResults: 100 });
    const { readFrequencyHistory } = await import(chrome.runtime.getURL('history-frequency.mjs'));
    const result = await readFrequencyHistory(chrome.history, { range, include: item => item.url === a || item.url === b });
    return { a, b, firstCount: first.length, latestCount: latest.length, latestBeyondEnd: latest.some(v => v.visitTime >= range.endTime), boundedIncludesRevisited: bounded.some(item => item.url === a), result: result.map(item => ({ url: item.url, count: item.periodVisitCount })) };
  });
  assert.equal(evidence.firstCount, 2);
  assert.equal(evidence.latestCount, 3);
  assert.equal(evidence.latestBeyondEnd, true);
  assert.equal(evidence.boundedIncludesRevisited, true, 'bounded native search includes a URL visited again afterward');
  assert.deepEqual(evidence.result, [{ url: evidence.a, count: 2 }, { url: evidence.b, count: 1 }]);
  await page.locator('#openPreferences').click();
  await page.waitForFunction(() => !document.querySelector('#launchChoices').disabled);

  await page.locator('#defaultView').selectOption('frequency'); await page.locator('#defaultRange').selectOption('today');
  await page.locator('#savePreferences').click();
  await page.waitForFunction(() => !document.querySelector('#preferencesDialog').open);
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.waitForFunction(() => !document.querySelector('#search').disabled && document.querySelector('#groupByFrequency').getAttribute('aria-pressed') === 'true');
  assert.equal(await page.locator('#timeRange').inputValue(), 'today');
  await page.locator('#query').fill('frequency.example'); await page.locator('#search').click();
  await page.waitForFunction(() => !document.querySelector('#search').disabled && document.querySelectorAll('#rows .history-row').length === 2);
  assert.deepEqual(await page.locator('#rows .visit-column').allTextContents(), ['3', '1']);
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${origin}/site/`);
  // Generated test-only identifier; no personal session or browser profile is used.
  const syntheticLaunchId = crypto.randomUUID();
  await page.bringToFront();
  await worker.evaluate(async ({ syntheticLaunchId }) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.storage.session.set({ modalLaunchSessions: { [syntheticLaunchId]: { tabId: tab.id, expires: Date.now() + 60_000 } } });
  }, { origin, syntheticLaunchId });
  await page.evaluate(src => {
    const frame = document.createElement('iframe'); frame.src = src;
    frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:99999';
    document.body.append(frame);
  }, `chrome-extension://${id}/modal.html#launch=${syntheticLaunchId}`);
  const modal = page.frameLocator('iframe').last();
  await modal.locator('#groupByFrequency[aria-pressed=true]').waitFor();
  await modal.locator('#query').fill('frequency.example'); await modal.locator('#search').click();
  await modal.locator('#rows .history-row').nth(1).waitFor();
  assert.deepEqual(await modal.locator('#rows .visit-column').allTextContents(), ['3', '1']);
  assert.equal(await modal.locator('body').getAttribute('data-presentation'), 'modal');
  console.log(JSON.stringify({ nativeFrequency: 'passed', boundedSearchIncludesRevisited: evidence.boundedIncludesRevisited, expectedPeriodCounts: [2, 1], savedDefaults: 'frequency/today', profile: 'disposable; fictional URLs only' }));
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
