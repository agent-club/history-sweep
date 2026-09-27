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
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'delete-status', id: 'missing-test-job' }));
  const worker = context.serviceWorkers().find(item => item.url().endsWith('/background.mjs'));
  await worker.evaluate(() => {
    const nativeDelete = chrome.history.deleteUrl.bind(chrome.history);
    const gate = new Promise(resolve => { globalThis.finishToolbarDeletion = resolve; });
    chrome.history.deleteUrl = async details => { await gate; return nativeDelete(details); };
  });
  const cdp = await context.browser().newBrowserCDPSession();
  let sequence = 0;
  async function popupSession() {
    await page.bringToFront();
    await page.evaluate(() => chrome.action.openPopup());
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
  const popup = await popupSession();
  await waitFor(popup, 'Boolean(document.getElementById("query"))');
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
  await waitFor(nextPopup, 'Boolean(document.getElementById("query"))');
  const fullPagePromise = context.waitForEvent('page');
  await evaluate(nextPopup, 'document.getElementById("query").value="127.0.0.1";document.getElementById("mode").value="host-exact";document.getElementById("openFull").click();true');
  const fullPage = await fullPagePromise;
  await fullPage.waitForFunction(() => document.getElementById('query')?.value === '127.0.0.1' && !document.getElementById('query').disabled);
  assert.equal(new URL(fullPage.url()).search, '');
  assert.equal(new URL(fullPage.url()).hash, '');
  assert.equal(await fullPage.locator('#mode').inputValue(), 'host-exact');
  console.log('Real toolbar popup passed: cancel preserves history; confirmed deletion survives popup close; unselected visit stays; workspace handoff succeeds. Disposable profile only.');
} finally {
  if (context) await context.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
