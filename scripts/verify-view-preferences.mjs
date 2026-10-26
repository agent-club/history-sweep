import { enterWorkspace } from './native-workspace.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { injectModal } from '../extension/modal-host.mjs';

const { chromium } = dependency('playwright');
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-view-preferences-'));
const server = createServer();
const errors = [];
let context;
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const order = frame => frame.locator('#viewChoices').evaluate(node => [...node.children].map(row => row.dataset.viewChoice));
const tabs = frame => frame.locator('.group-view-switch').evaluate(node => [...node.children].filter(button => !button.hidden).map(button => button.id));
const open = async frame => {
  await frame.locator('#openPreferences').click();
  await frame.waitForFunction(() => !document.querySelector('#savePreferences').disabled);
};
const close = frame => frame.waitForFunction(() => !document.querySelector('#preferencesDialog').open);
async function dragView(page, frame, source, target, position, cancel = false) {
  const handle = frame.locator(`[data-view-choice=${source}] [data-view-drag]`);
  const row = frame.locator(`[data-view-choice=${target}]`);
  await handle.scrollIntoViewIfNeeded();
  const start = await handle.boundingBox();
  const end = await row.boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 8, start.y + start.height / 2, { steps: 3 });
  await page.mouse.move(end.x + end.width / 2, end.y + (position === 'before' ? 5 : end.height - 5), { steps: 12 });
  check(await row.getAttribute('data-drop-position') === position, `Drag ${source}: ${position} ${target} has a drop indicator`);
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
  check(await frame.locator('.is-dragging, [data-drop-position]').count() === 0, 'Drag feedback clears after drop or cancel');
}
async function openModal(page, worker, origin) {
  await page.goto(`http://127.0.0.1:${server.address().port}/site/`);
  await page.bringToFront();
  const launchId = crypto.randomUUID();
  const navigation = page.waitForEvent('framenavigated', { predicate: frame => frame.url().startsWith(`${origin}/modal.html`) });
  await worker.evaluate(async launchId => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.storage.session.set({ modalLaunchSessions: { [launchId]: { tabId: tab.id, expires: Date.now() + 60000 } } });
  }, launchId);
  await page.evaluate(injectModal, `${origin}/modal.html#launch=${launchId}`);
  await navigation;
  return page.frames().find(frame => frame.url().startsWith(`${origin}/modal.html`));
}

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.HISTORY_SWEEP_CHROMIUM,
    channel: process.env.HISTORY_SWEEP_CHROMIUM ? undefined : 'chromium', headless: true,
    viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
  for (const layout of ['manager', 'popup', 'modal']) {
    await worker.evaluate(() => chrome.storage.local.set({ launchMode: 'modal', browsingPreferences: { view: 'website', range: '7days' } }));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(6000);
    await page.addInitScript(() => { localStorage.setItem('theme', 'light'); localStorage.setItem('language', 'en'); });
    await page.setViewportSize(layout === 'popup' ? { width: 440, height: 590 } : { width: 1440, height: 900 });
    let frame = page;
    if (layout === 'modal') {
      frame = await openModal(page, worker, origin);
    } else await page.goto(`${origin}/${layout}.html`);
    await enterWorkspace(frame);
    await frame.waitForFunction(() => document.querySelector('#search') && !document.querySelector('#search').disabled);
    assert.deepEqual(await tabs(frame), ['groupByDate', 'groupBySite', 'groupByFrequency']);
    await open(frame);
    const frequency = frame.locator('[data-view-choice=frequency]');
    await dragView(page, frame, 'frequency', 'date', 'before');
    assert.deepEqual(await order(frame), ['frequency', 'date', 'website']);
    check(await frequency.locator('[data-view-move=up]').isDisabled(), `${layout}: dragging updates arrow boundaries`);
    await dragView(page, frame, 'frequency', 'website', 'after');
    assert.deepEqual(await order(frame), ['date', 'website', 'frequency']);
    await dragView(page, frame, 'date', 'frequency', 'after', true);
    assert.deepEqual(await order(frame), ['date', 'website', 'frequency']);
    await frequency.locator('[data-view-move=up]').click();
    await frequency.locator('[data-view-move=down]').click();
    await frame.locator('#dismissPreferences').click(); await close(frame);
    check(!await frame.locator('#unsavedPreferencesDialog').evaluate(node => node.open), `${layout}: restoring tab order closes without a dirty prompt`);

    await open(frame);
    await frequency.locator('[data-view-move=up]').click();
    await page.keyboard.press('Enter');
    assert.deepEqual(await order(frame), ['frequency', 'date', 'website']);
    check(await frequency.locator('[data-view-move=up]').isDisabled(), `${layout}: keyboard reorder reaches first position`);
    await frame.locator('[data-view-visible=website]').uncheck();
    check(await frame.locator('#defaultView').inputValue() === 'frequency', `${layout}: hiding the default selects the first visible view`);
    await frame.locator('[data-view-visible=date]').uncheck();
    check(await frame.locator('[data-view-visible=frequency]').isDisabled(), `${layout}: final visible view cannot be hidden`);
    await frame.locator('#defaultView').selectOption('website');
    check(await frame.locator('[data-view-visible=website]').isChecked(), `${layout}: choosing a hidden default shows it`);
    await frame.locator('[data-view-visible=date]').check();
    await frame.locator('[data-view-visible=website]').uncheck();

    await frame.locator('#dismissPreferences').click();
    await frame.waitForFunction(() => document.querySelector('#unsavedPreferencesDialog').open);
    await frame.locator('#keepEditingPreferences').click();
    assert.deepEqual(await order(frame), ['frequency', 'date', 'website']);
    check(!await frame.locator('[data-view-visible=website]').isChecked(), `${layout}: keep editing retains visibility draft`);
    await frame.locator('#dismissPreferences').click();
    await frame.locator('#discardPreferences').click(); await close(frame);
    await open(frame);
    assert.deepEqual(await order(frame), ['date', 'website', 'frequency']);
    check(await frame.locator('[data-view-visible=website]').isChecked(), `${layout}: discard restores saved configuration`);

    await dragView(page, frame, 'frequency', 'date', 'before');
    await frame.locator('[data-view-visible=website]').uncheck();
    if (process.env.HISTORY_SWEEP_SCREENSHOTS) {
      await mkdir(process.env.HISTORY_SWEEP_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.HISTORY_SWEEP_SCREENSHOTS, `view-preferences-${layout}-en.png`) });
    }
    await frame.locator('#savePreferences').click(); await close(frame);
    assert.deepEqual(await tabs(frame), ['groupByDate', 'groupBySite', 'groupByFrequency']);
    check(await frame.locator('#groupBySite').getAttribute('aria-pressed') === 'true', `${layout}: save preserves the current browsing view`);
    const stored = await worker.evaluate(async () => (await chrome.storage.local.get('browsingPreferences')).browsingPreferences);
    assert.deepEqual(stored, { view: 'frequency', range: '7days', viewOrder: ['frequency', 'date', 'website'], hiddenViews: ['website'] });
    // Modal launches use one-time authorization; reopen through the host with a fresh launch token.
    if (layout === 'modal') frame = await openModal(page, worker, origin);
    else await page.reload();
    await frame.waitForFunction(() => document.querySelector('#search') && !document.querySelector('#search').disabled);
    assert.deepEqual(await tabs(frame), ['groupByFrequency', 'groupByDate']);
    check(await frame.locator('#groupByFrequency').getAttribute('aria-pressed') === 'true', `${layout}: reopening applies saved visibility, order and default`);
    await frame.locator('[data-language="zh-CN"]').click();
    assert.deepEqual(await tabs(frame), ['groupByFrequency', 'groupByDate']);
    await open(frame);
    check(await frame.locator('#viewChoicesLabel').textContent() === '视图顺序与展示', `${layout}: localized setting survives language remount`);
    const geometry = await frame.locator('#viewChoices').evaluate(node => ({ right: node.getBoundingClientRect().right, width: innerWidth, overflow: node.scrollWidth > node.clientWidth }));
    check(geometry.right <= geometry.width && !geometry.overflow, `${layout}: settings fit the drawer`);
    if (process.env.HISTORY_SWEEP_SCREENSHOTS) await page.screenshot({ path: join(process.env.HISTORY_SWEEP_SCREENSHOTS, `view-preferences-${layout}-zh.png`) });
    await frame.locator('#dismissPreferences').click(); await close(frame);
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(`View preferences: ${checks} checks passed across manager, popup and modal.`);
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
