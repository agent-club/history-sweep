import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const versionUrl = 'https://sweep.agentclub.dev/extension-updates.json';
const extensionId = 'bbccfejdhhcjmpfagjckiikgllpojhgm';
const metadata = { extensionId, version: '0.3.2' };
const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
const server = createServer();
const corsServer = http.createServer((request, response) => {
  response.writeHead(200, headers);
  response.end(JSON.stringify(metadata));
});
const temporary = await mkdtemp(join(tmpdir(), 'history-sweep-updates-'));
let browser, native;
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  await new Promise((resolve, reject) => { corsServer.once('error', reject); corsServer.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const corsOrigin = `http://127.0.0.1:${corsServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
  for (const layout of ['popup', 'manager', 'modal']) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let releaseHint;
    const hintGate = new Promise(resolve => { releaseHint = resolve; });
    await context.route(versionUrl, async route => { await hintGate; await route.fulfill({ headers, body: JSON.stringify(metadata) }); });
    await installMock(page, [{ url: 'https://example.test/remove', title: 'Synthetic page', lastVisitTime: Date.now(), visitCount: 1 }]);
    await page.addInitScript(({ extensionId }) => {
      chrome.management.getSelf = async () => ({ id: extensionId, installType: 'normal', updateUrl: 'https://clients2.google.com/service/update2/crx' });
      chrome.runtime.requestUpdateCheck = async () => { window.__storeChecks = (window.__storeChecks || 0) + 1; return { status: 'update_available', version: '0.3.2' }; };
      const deleteUrl = chrome.history.deleteUrl, getVisits = chrome.history.getVisits;
      const deleting = new Promise(resolve => { window.__finishDelete = resolve; });
      const verifying = new Promise(resolve => { window.__finishVerify = resolve; });
      chrome.history.deleteUrl = async args => { await deleting; return deleteUrl(args); };
      chrome.history.getVisits = async args => { window.__verifying = true; await verifying; return getVisits(args); };
    }, { extensionId });
    if (layout === 'modal') await page.route('**/extension/manager.html', async route => {
      const response = await route.fetch(); await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
    });
    await page.goto(`${origin}/extension/${layout === 'modal' ? 'manager' : layout}.html`);
    await page.waitForFunction(() => document.querySelector('#status')?.dataset.kind === 'scanned');
    assert.equal(await page.locator('#updateSlot').isVisible(), false);
    assert.equal(await page.evaluate(() => window.__messages.filter(message => message.type === 'check-for-update').length), 1, `${layout}: opening triggers exactly one check`);
    await page.locator('#selectAll').click();
    await page.locator('#delete').click();
    await page.locator('#confirmDialog [value=confirm]').click();
    releaseHint();
    await page.locator('#updateSlot').waitFor({ state: 'visible' });
    assert.match(await page.locator('#updateCopy').textContent(), /0\.3\.2/);
    assert.equal(await page.locator('#applyUpdate').isDisabled(), true, `${layout}: deletion blocks reload`);
    await page.evaluate(() => window.__finishDelete());
    await page.waitForFunction(() => window.__verifying);
    assert.equal(await page.locator('#applyUpdate').isDisabled(), true, `${layout}: verification blocks reload`);
    assert.equal(await page.evaluate(() => window.__reloads || 0), 0);
    await page.evaluate(() => window.__finishVerify());
    await page.waitForFunction(() => !document.querySelector('#applyUpdate').disabled);
    await page.locator('#applyUpdate').click();
    await page.waitForFunction(() => window.__reloads === 1);
    assert.equal(await page.evaluate(() => window.__storeChecks), 1);
    assert.deepEqual(errors, []);
    await context.close();
  }
  await browser.close(); browser = undefined;

  // Exercise real Chrome CORS without granting a host permission. Only this disposable
  // manifest adds the HTTP fixture origin; the release allows HTTPS for WebDAV.
  // Store identity/download responses are synthetic; a signed store upgrade is a separate release check.
  const extension = join(temporary, 'extension');
  await cp(fileURLToPath(new URL('../extension/', import.meta.url)), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.content_security_policy.extension_pages += ` ${corsOrigin}`;
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  native = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    headless: true, ...(process.env.HISTORY_SWEEP_CHROMIUM ? { executablePath: process.env.HISTORY_SWEEP_CHROMIUM } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let nativeRequests = 0;
  await native.route(versionUrl, async route => {
    nativeRequests++;
    assert.equal(route.request().postData(), null);
    assert.equal(route.request().headers().cookie, undefined);
    await route.fulfill({ headers, body: JSON.stringify(metadata) });
  });
  const worker = native.serviceWorkers()[0] || await native.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await native.newPage();
  await page.goto(`chrome-extension://${id}/manager.html`);
  const result = await page.evaluate(async metadata => {
    const { createUpdateChecker } = await import('./update-check.mjs');
    const self = await chrome.management.getSelf();
    const realCheck = await chrome.runtime.sendMessage({ type: 'check-for-update', clientId: crypto.randomUUID() });
    const synthetic = await createUpdateChecker({
      management: { getSelf: async () => ({ ...self, id: metadata.extensionId, installType: 'normal', updateUrl: 'https://clients2.google.com/service/update2/crx' }) },
      runtime: { getManifest: () => ({ version: '0.3.1' }), requestUpdateCheck: async () => ({ status: 'update_available', version: metadata.version }) },
      storage: chrome.storage,
    })();
    return { type: self.installType, skipped: realCheck.data.update, synthetic, permissions: chrome.runtime.getManifest().permissions };
  }, metadata);
  assert.equal(result.type, 'development'); assert.equal(result.skipped, null);
  assert.equal(result.synthetic, '0.3.2'); assert.equal(nativeRequests, 1);
  assert.equal(result.permissions.includes('management'), false);
  const realNetwork = await page.evaluate(async corsOrigin => {
    const response = await fetch(`${corsOrigin}/extension-updates.json`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
    return { metadata: await response.json(), cors: response.headers.get('Access-Control-Allow-Origin') };
  }, corsOrigin);
  assert.deepEqual(realNetwork.metadata, metadata, 'native extension reads version metadata over a real cross-origin connection');
  const blocked = await page.evaluate(async () => {
    try { await fetch('http://blocked.invalid/extension-updates.json'); return false; } catch { return true; }
  });
  assert.equal(blocked, true, 'release CSP rejects non-HTTPS origins outside the local fixture');
  console.log('Update checks passed: popup/manager/modal opening, deletion and verification guards, native no-permission CORS, release CSP, and unpacked skip. Store download/install remains synthetic.');
} finally {
  await browser?.close(); await native?.close();
  await Promise.all([server, corsServer].map(instance => new Promise(resolve => instance.close(resolve))));
  await rm(temporary, { recursive: true, force: true });
}
