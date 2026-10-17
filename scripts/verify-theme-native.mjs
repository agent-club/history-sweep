import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';

const { chromium } = dependency('playwright');
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-theme-native-'));
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const server = createServer(); let context;
const ready = page => page.waitForFunction(() => document.querySelector('#search') && !document.querySelector('#search').disabled);
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.HISTORY_SWEEP_CHROMIUM,
    channel: process.env.HISTORY_SWEEP_CHROMIUM ? undefined : 'chromium', headless: true, colorScheme: 'light',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const control = await context.newPage();
  await control.goto(`chrome-extension://${id}/manager.html`); await ready(control);
  const host = await context.newPage();
  await host.route('**/theme-native-host', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Illustrative host page</p>' }));
  await host.goto(`${origin}/theme-native-host`);
  // Explicitly synthetic one-use fixture; no real profile or authentication data.
  const fixtureLaunch = 'theme-fixture-only';
  await host.bringToFront();
  await control.evaluate(async ({ fixtureLaunch }) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.storage.session.set({ modalLaunchSessions: { [fixtureLaunch]: { tabId: tab.id, expires: Date.now() + 60000 } } });
  }, { fixtureLaunch });
  const modalUrl = new URL(`chrome-extension://${id}/modal.html`);
  modalUrl.hash = new URLSearchParams({ launch: fixtureLaunch }).toString();
  // Exercise the real modal.html entry point, claim and extension service worker.
  await host.evaluate(async ({ origin, modalUrl }) => { const { injectModal } = await import(`${origin}/extension/modal-host.mjs`); injectModal(modalUrl); }, { origin, modalUrl: modalUrl.href });
  let frame = host.frames().find(frame => frame.url().includes('/modal.html'));
  if (!frame) frame = await host.waitForEvent('framenavigated', { predicate: frame => frame.url().includes('/modal.html') });
  await ready(frame);
  const errors = []; frame.page().on('pageerror', error => errors.push(error.message));
  assert.equal(await frame.locator('html').getAttribute('data-theme'), 'light', 'real modal bootstraps theme under extension CSP');
  await frame.locator('#themeToggle').click(); await host.mouse.click(3, 3);
  await frame.waitForFunction(() => !document.querySelector('#themeMenu').open);
  assert.ok(await frame.locator('#query').isVisible(), 'outer backdrop dismisses appearance menu without closing modal');
  const choose = async (target, mode) => { await target.locator('#themeToggle').click(); await target.locator(`[data-theme-choice="${mode}"]`).click(); };
  const before = await frame.locator('html').getAttribute('data-theme');
  await choose(frame, 'dark');
  const after = await frame.locator('html').getAttribute('data-theme');
  assert.notEqual(after, before, `real modal must react to the theme icon (before=${before}, after=${after})`);
  assert.equal(after, 'dark');
  await control.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await choose(frame, 'light');
  await control.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await choose(frame, 'system');
  await frame.page().emulateMedia({ colorScheme: 'dark' });
  await frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  assert.equal(await frame.locator('html').getAttribute('data-theme-preference'), 'system');
  await control.reload(); await ready(control);
  assert.equal(await control.locator('html').getAttribute('data-theme-preference'), 'system', 'native extension saves automatic preference');
  await control.emulateMedia({ colorScheme: 'dark' });
  await control.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`); await ready(popup);
  await choose(popup, 'light');
  await frame.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.deepEqual(errors, []);
  console.log('Native theme check passed: real modal, popup and manager; dark/light/automatic; persistence and cross-view synchronization. Disposable profile only.');
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve)); await rm(profile, { recursive: true, force: true });
}
