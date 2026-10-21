import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';

const { chromium } = dependency('playwright');
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-shortcuts-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.HISTORY_SWEEP_CHROMIUM ? { executablePath: process.env.HISTORY_SWEEP_CHROMIUM } : { channel: 'chromium' }),
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/manager.html`);
  const binding = () => page.evaluate(async () => (await chrome.commands.getAll()).find(command => command.name === '_execute_action').shortcut);
  async function returnToPreferences() {
    await page.bringToFront();
    // Playwright forces tabs to stay focused, so deliver the return-focus signal explicitly.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  }
  const original = await binding();
  assert.equal(original, process.platform === 'darwin' ? '⌥H' : 'Alt+H', 'native platform default shortcut registered');
  await page.locator('#openPreferences').click();
  await page.waitForFunction(value => document.getElementById('launchShortcut').textContent === value, original);
  assert.equal(await page.locator('#launchShortcut').getAttribute('data-state'), original ? 'assigned' : 'unassigned');
  assert.deepEqual(await page.locator('#preferencesForm input[name=launchMode]').evaluateAll(inputs => inputs.map(input => input.value)), ['popup', 'modal', 'fullpage']);

  const settingsPromise = context.waitForEvent('page');
  await page.locator('#configureShortcut').click();
  const settings = await settingsPromise;
  await settings.waitForURL('chrome://extensions/shortcuts');
  // Chrome renamed this control; both selectors pierce its native shadow DOM.
  const control = settings.locator('cr-shortcut-input, extensions-shortcut-input').first();
  await control.locator('#edit').click();
  await control.locator('input').press('Alt+j');
  await page.waitForFunction(async value => (await chrome.commands.getAll()).find(command => command.name === '_execute_action').shortcut !== value, original);
  const custom = await binding();
  assert.ok(custom, 'Chrome accepts a user-selected shortcut');
  await returnToPreferences();
  await page.waitForFunction(value => document.getElementById('launchShortcut').textContent === value, custom);

  await settings.bringToFront();
  await control.locator('#clear').click();
  await returnToPreferences();
  await page.waitForFunction(() => document.getElementById('launchShortcut').textContent === 'Not set');
  assert.equal(await binding(), '', 'clearing a shortcut does not display the manifest default');
  await page.locator('#closePreferences').click();
  await page.locator('[data-language="zh-CN"]').click();
  await page.locator('#openPreferences').click();
  await page.waitForFunction(() => document.getElementById('launchShortcut').textContent === '未设置');
  assert.equal(await page.locator('#configureShortcut strong').textContent(), '修改快捷键');
  await page.locator('#closePreferences').click();

  await page.evaluate(() => {
    window.originalGetCommands = chrome.commands.getAll;
    chrome.commands.getAll = async () => { throw new Error('fixture'); };
    window.originalCreateTab = chrome.tabs.create;
    chrome.tabs.create = async () => { throw new Error('fixture'); };
  });
  await page.locator('#openPreferences').click();
  await page.waitForFunction(() => document.getElementById('launchShortcut').textContent === '无法读取快捷键');
  assert.equal(await page.locator('#launchShortcut').getAttribute('data-state'), 'unavailable', 'read failure is a plain status, not a keycap');
  assert.equal(await page.locator('#launchChoices').isEnabled(), true, 'shortcut read errors do not block launch preferences');
  await page.locator('#configureShortcut').click();
  await page.locator('#shortcutSettingsStatus').waitFor({ state: 'visible' });
  assert.match(await page.locator('#shortcutSettingsStatus').textContent(), /chrome:\/\/extensions\/shortcuts/);
  await page.evaluate(() => { chrome.commands.getAll = window.originalGetCommands; chrome.tabs.create = window.originalCreateTab; });
  await page.locator('#closePreferences').click();
  await page.locator('#openPreferences').click();
  await page.waitForFunction(() => document.getElementById('launchShortcut').textContent === '未设置');
  assert.equal(await page.locator('#shortcutSettingsStatus').isHidden(), true);
  await page.locator('input[value="fullpage"]').check();
  await page.locator('#savePreferences').click();
  await page.waitForFunction(() => !document.getElementById('preferencesDialog').open);
  assert.equal(await page.evaluate(async () => (await chrome.storage.local.get('launchMode')).launchMode), 'fullpage');
  assert.equal(await binding(), '', 'saving launch mode leaves the user shortcut unchanged');

  await page.setViewportSize({ width: 440, height: 590 });
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.locator('#openPreferences').click();
  await page.waitForFunction(() => document.getElementById('launchShortcut').textContent === '未设置');
  assert.equal(await page.locator('#preferencesDialog').evaluate(dialog => dialog.scrollHeight <= dialog.clientHeight || getComputedStyle(dialog).overflowY === 'auto'), true, 'compact preferences stay scrollable');
  await page.locator('#configureShortcut').scrollIntoViewIfNeeded();
  await page.locator('#savePreferences').scrollIntoViewIfNeeded();
  assert.deepEqual(errors, []);
  console.log('Shortcut checks passed: native default, settings navigation, remapping and clearing, refreshed binding, both languages, independent error handling, preserved user binding, and compact preferences. Disposable profile only.');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
