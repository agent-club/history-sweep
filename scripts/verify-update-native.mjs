import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependency } from './runtime.mjs';

const { chromium } = dependency('playwright');
const temporary = await mkdtemp(join(tmpdir(), 'history-sweep-update-native-'));
let context;
try {
  for (const legacy of [false, true]) {
    const extension = join(temporary, legacy ? 'legacy' : 'current');
    await cp(new URL('../extension/', import.meta.url), extension, { recursive: true });
    const manifestPath = join(extension, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.host_permissions = ['http://127.0.0.1/*'];
    await writeFile(manifestPath, JSON.stringify(manifest));
    if (legacy) {
      // Reproduce the old worker contract and its timestamp-only cache, while
      // serving the current page files from the same unpacked installation.
      const path = join(extension, 'background.mjs');
      const source = await readFile(path, 'utf8');
      const patched = source
        .replace('const checkForUpdate = createUpdateChecker(chrome);', `const checkForUpdate = async () => {
          await chrome.storage.local.set({ extensionUpdateCheck: { installedVersion: chrome.runtime.getManifest().version, checkedAt: Date.now() } });
          return null;
        };`)
        .replace('return { update: null, check };', 'return { update: null };')
        .replace('busy: deletionRunning() }, check };', 'busy: deletionRunning() } };');
      assert.notEqual(source, patched);
      assert.ok(!patched.includes('return { update: null, check }'));
      await writeFile(path, patched);
    }
    context = await chromium.launchPersistentContext(join(temporary, legacy ? 'legacy-profile' : 'current-profile'), {
      ...(process.env.HISTORY_SWEEP_CHROMIUM ? { executablePath: process.env.HISTORY_SWEEP_CHROMIUM } : { channel: 'chromium' }),
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).hostname;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${id}/manager.html`);
    await manager.locator('#openVersion').click();
    const verify = async page => {
      await page.waitForFunction(() => document.querySelector('#updateDialog').dataset.state === 'manual');
      assert.equal(await page.locator('#updateChannel').textContent(), 'Unpacked');
      assert.equal(await page.locator('#checkUpdate').isHidden(), true);
      assert.ok(await page.locator('#updateStatusBody').textContent());
      const { extensionUpdateCheck: check } = await page.evaluate(() => chrome.storage.local.get('extensionUpdateCheck'));
      assert.equal(check.channel, 'development');
      assert.equal(check.status, 'manual');
    };
    await verify(manager);
    const host = await context.newPage();
    await host.route('http://127.0.0.1/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Update test</title>' }));
    await host.goto('http://127.0.0.1/update-test');
    await host.bringToFront();
    const navigation = host.waitForEvent('framenavigated', { predicate: frame => frame.url().startsWith(`chrome-extension://${id}/modal.html`) });
    await manager.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const fixtureLaunch = crypto.randomUUID();
      await chrome.storage.session.set({ modalLaunchSessions: { [fixtureLaunch]: { tabId: tab.id, expires: Date.now() + 60000 } } });
      const { injectModal } = await import('./modal-host.mjs');
      const url = new URL(chrome.runtime.getURL('modal.html'));
      url.hash = new URLSearchParams({ launch: fixtureLaunch });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: injectModal, args: [url.href] });
    });
    const modal = await navigation;
    await modal.locator('#openPreferences').click();
    await modal.locator('#openUpdateSettings').click();
    await verify(modal);
    await context.close();
    context = undefined;
    console.log(`${legacy ? 'Legacy' : 'Current'} worker: native manager and modal update checks passed`);
  }
} finally {
  await context?.close();
  await rm(temporary, { recursive: true, force: true });
}
