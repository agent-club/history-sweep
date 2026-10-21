import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';

const { chromium } = dependency('playwright');
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-toolbar-'));
const server = createServer();
let context;
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  // A real browser window is required: a popup.html tab supplies different sender metadata.
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.HISTORY_SWEEP_CHROMIUM ? { executablePath: process.env.HISTORY_SWEEP_CHROMIUM } : { channel: 'chromium' }),
    headless: false,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const page = await context.newPage();
  await page.goto('chrome://extensions/');
  const id = await page.evaluate(() => {
    const list = document.querySelector('extensions-manager').shadowRoot.querySelector('extensions-item-list').shadowRoot;
    return [...list.querySelectorAll('extensions-item')].find(item => item.shadowRoot.querySelector('#name').textContent.trim() === 'History Sweep').id;
  });
  assert.ok(id, 'extension loaded');
  const removedUrl = `${origin}/site/?toolbar-remove`;
  const keptUrl = `${origin}/site/?toolbar-keep`;
  await page.goto(removedUrl);
  await page.goto(keptUrl);
  await page.goto(`chrome-extension://${id}/manager.html`);
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'set-launch-preference', launchMode: 'popup' }));
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'delete-status', id: 'missing-test-job' }));
  const worker = context.serviceWorkers().find(item => item.url().endsWith('/background.mjs'));
  await worker.evaluate(() => {
    const nativeDelete = chrome.history.deleteUrl.bind(chrome.history);
    const gate = new Promise(resolve => { globalThis.finishToolbarDeletion = resolve; });
    chrome.history.deleteUrl = async details => { await gate; return nativeDelete(details); };
  });
  const cdp = await context.browser().newBrowserCDPSession();
  let sequence = 0;
  async function popupSession(fromWorker = false) {
    await page.bringToFront();
    if (fromWorker) await worker.evaluate(() => chrome.action.openPopup());
    else await page.evaluate(() => chrome.action.openPopup());
    for (let attempt = 0; attempt < 100; attempt++) {
      const target = (await cdp.send('Target.getTargets')).targetInfos.find(item => item.url === `chrome-extension://${id}/popup.html`);
      if (target) return (await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false })).sessionId;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Real toolbar popup target was not created');
  }
  async function evaluate(sessionId, expression) {
    const commandId = ++sequence;
    let listener;
    let timeout;
    try {
      const reply = new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Toolbar evaluation timed out')), 5000);
        listener = event => {
          if (event.sessionId !== sessionId) return;
          const message = JSON.parse(event.message);
          if (message.id === commandId) resolve(message);
        };
        cdp.on('Target.receivedMessageFromTarget', listener);
      });
      await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: commandId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }) });
      const response = await reply;
      assert.ok(!response.error && !response.result.exceptionDetails, 'toolbar JavaScript evaluation succeeded');
      return response.result.result.value;
    } finally { clearTimeout(timeout); if (listener) cdp.off('Target.receivedMessageFromTarget', listener); }
  }
  async function waitFor(sessionId, expression) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(sessionId, expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Toolbar condition did not complete');
  }
  async function clickPopup(sessionId, selector) {
    const point = await evaluate(sessionId, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: ++sequence, method: 'Input.dispatchMouseEvent', params: { type, ...point, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) } }) });
    }
  }
  const popup = await popupSession();
  await waitFor(popup, 'Boolean(document.getElementById("query")) && !document.getElementById("query").disabled');
  // Test actual pointer input in the browser action popup, rather than only programmatic clicks.
  await evaluate(popup, `(() => {
    window.testNativeSearch = chrome.history.search;
    const today = new Date(); const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    chrome.history.search = async () => [
      { url: 'http://127.0.0.1/illustrative-today', title: 'Illustrative today', lastVisitTime: today.getTime() },
      { url: 'http://127.0.0.2/illustrative-other-site', title: 'Illustrative second website', lastVisitTime: today.getTime() },
      { url: 'http://127.0.0.1/illustrative-yesterday', title: 'Illustrative yesterday', lastVisitTime: yesterday.getTime() }
    ];
    document.getElementById('searchForm').requestSubmit(); return true;
  })()`);
  await waitFor(popup, 'document.querySelectorAll(".date-group").length === 2 && !document.getElementById("search").disabled');
  await clickPopup(popup, '#groupBySite');
  await waitFor(popup, 'document.getElementById("groupBySite").getAttribute("aria-pressed") === "true" && document.querySelectorAll(".date-group").length === 0 && document.querySelectorAll(".website-group").length === 2');
  await clickPopup(popup, '#groupByDate');
  await waitFor(popup, 'document.querySelectorAll(".date-group").length === 2');
  await clickPopup(popup, '#expandGroups');
  await waitFor(popup, 'document.getElementById("expandGroups").textContent === "Collapse all" && document.querySelectorAll(".date-toggle[aria-expanded=false], .group-toggle[aria-expanded=false]").length === 0');
  assert.ok(await evaluate(popup, 'document.querySelector("#expandGroups span").getBoundingClientRect().width > 20'), 'real popup exposes a visible collapse label');
  await clickPopup(popup, '#expandGroups');
  await waitFor(popup, 'document.getElementById("expandGroups").textContent === "Expand all" && document.querySelectorAll(".date-toggle[aria-expanded=true]").length === 0');
  await clickPopup(popup, '[data-language="zh-CN"]');
  await clickPopup(popup, '#groupBySite');
  await waitFor(popup, 'document.getElementById("groupBySite").getAttribute("aria-pressed") === "true" && document.querySelectorAll(".website-group").length === 2');
  await clickPopup(popup, '[data-language="en"]');
  await evaluate(popup, 'chrome.history.search = window.testNativeSearch; delete window.testNativeSearch; true');

  await evaluate(popup, 'document.getElementById("query").value="127.0.0.1";document.getElementById("mode").value="host-exact";document.getElementById("searchForm").requestSubmit();true');
  await waitFor(popup, 'document.getElementById("count").textContent.startsWith("2 ")');
  await evaluate(popup, `[...document.querySelectorAll('input[type=checkbox]')].find(item => item.getAttribute('aria-label') === ${JSON.stringify('Select ' + removedUrl)}).click();document.getElementById('delete').click();true`);
  await evaluate(popup, 'document.querySelector("#confirmDialog [value=cancel]").click();true');
  assert.equal(await page.evaluate(async url => (await chrome.history.getVisits({ url })).length > 0, removedUrl), true, 'cancel keeps history');
  await evaluate(popup, 'document.getElementById("delete").click();document.querySelector("#confirmDialog [value=confirm]").click();true');
  await waitFor(popup, 'document.getElementById("status").dataset.kind === "deleting" && document.getElementById("query").disabled');
  // The worker continues after this native popup is destroyed, with no documentId supplied.
  await evaluate(popup, 'setTimeout(()=>window.close(),0);true');
  await worker.evaluate(() => globalThis.finishToolbarDeletion());
  await page.waitForFunction(async url => (await chrome.history.getVisits({ url })).length === 0, removedUrl);
  assert.equal(await page.evaluate(async url => (await chrome.history.getVisits({ url })).length > 0, keptUrl), true, 'unselected visit stays');
  const nextPopup = await popupSession();
  await waitFor(nextPopup, 'Boolean(document.getElementById("query")) && !document.getElementById("query").disabled');
  const fullPagePromise = context.waitForEvent('page');
  await evaluate(nextPopup, 'document.getElementById("query").value="127.0.0.1";document.getElementById("mode").value="host-exact";document.getElementById("openFull").click();true');
  const fullPage = await fullPagePromise;
  await fullPage.waitForFunction(() => document.getElementById('query')?.value === '127.0.0.1' && !document.getElementById('query').disabled);
  assert.equal(new URL(fullPage.url()).search, '');
  assert.equal(new URL(fullPage.url()).hash, '');
  assert.equal(await fullPage.locator('#mode').inputValue(), 'host-exact');
  await page.goto(keptUrl);
  const websitePopup = await popupSession(true);
  await waitFor(websitePopup, 'Boolean(document.getElementById("query")) && !document.getElementById("query").disabled');
  await evaluate(websitePopup, 'document.getElementById("currentSite").click();true');
  // Programmatic openPopup does not grant activeTab; the unavailable state must stay safe.
  await waitFor(websitePopup, 'document.getElementById("status").dataset.kind === "currentSiteUnavailable"');
  assert.match(await evaluate(websitePopup, 'document.getElementById("selected").textContent'), /^0 selected/);
  console.log('Real toolbar popup passed: trusted pointer grouping switches and visible expand/collapse in both languages; cancel preserves history; confirmed deletion survives popup close; unselected visit stays; workspace handoff succeeds; missing activeTab permission is handled. Disposable profile only.');
} finally {
  if (context) await context.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
