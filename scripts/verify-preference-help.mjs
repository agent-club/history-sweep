import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterWorkspace } from './native-workspace.mjs';
import { dependency } from './runtime.mjs';

const { chromium } = dependency('playwright');
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-preference-help-'));
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const screenshots = process.env.HISTORY_SWEEP_SCREENSHOTS;
let context;
let checks = 0;
const errors = [];

async function checkHelp(page, scope, label, minimum = 1) {
  const triggers = scope.locator('.preference-help-trigger:visible');
  await triggers.first().waitFor();
  const count = await triggers.count();
  assert.ok(count >= minimum, `${label}: expected at least ${minimum} help buttons, found ${count}`);
  for (let index = 0; index < count; index++) {
    const trigger = triggers.nth(index);
    const panel = page.locator(`#${await trigger.getAttribute('aria-controls')}`);
    assert.ok((await panel.textContent()).trim(), `${label}: each help button explains a setting`);
    assert.ok(await panel.isHidden(), `${label}: explanation starts collapsed`);
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    assert.ok(await panel.isVisible(), `${label}: click opens help`);
    const visible = await panel.evaluate(node => {
      const box = node.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight &&
        node.contains(document.elementFromPoint(x, y));
    });
    assert.ok(visible, `${label}: help is visible above the scrolling area`);
    if (screenshots && label.endsWith('/sync') && index === 2) {
      await scope.screenshot({ path: join(screenshots, `${label.split('/')[0]}-transfer.png`) });
    }
    await page.keyboard.press('Escape');
    assert.ok(await panel.isHidden(), `${label}: Escape closes help`);
    assert.ok(await trigger.evaluate(node => node === document.activeElement), `${label}: focus returns to the question mark`);
    checks++;
  }
}

try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.HISTORY_SWEEP_CHROMIUM,
    channel: process.env.HISTORY_SWEEP_CHROMIUM ? undefined : 'chromium',
    headless: true,
    reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
  for (const layout of ['manager', 'popup']) {
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(layout === 'manager' ? { width: 1440, height: 900 } : { width: 440, height: 590 });
    await page.addInitScript(({ language, theme }) => {
      localStorage.setItem('language', language);
      localStorage.setItem('theme', theme);
    }, layout === 'manager' ? { language: 'zh-CN', theme: 'light' } : { language: 'en', theme: 'dark' });
    await page.goto(`${origin}/${layout}.html`);
    await enterWorkspace(page);
    await page.locator('#openPreferences').click();
    await page.waitForFunction(() => !document.querySelector('#savePreferences').disabled);
    const dialog = page.locator('#preferencesDialog');
    const checkSection = (name, minimum) => checkHelp(page, dialog, `${layout}/${name}`, minimum);
    const navigate = name => dialog.locator(`[data-settings-section="${name}"]`).click();
    await checkSection('general', 5);
    await navigate('privacy');
    await checkSection('privacy', 2);
    await navigate('sync');
    await checkSection('sync', 5);
    await navigate('recommendations');
    await checkSection('recommendations', 4);
    await dialog.locator('#recommendation-editHabit').click();
    await checkSection('habit', 2);
    await navigate('recommendations');
    await dialog.locator('#recommendation-add').click();
    await checkSection('recommendation-site', 3);
    await navigate('recommendations');
    await dialog.locator('#recommendation-preview').click();
    await checkSection('recommendation-preview', 1);
    await navigate('links');
    await checkSection('links', 1);
    await dialog.locator('#link-cleanup-add').click();
    await checkSection('link-editor', 6);
    await navigate('tasks');
    await checkSection('tasks', 1);
    await dialog.locator('#cleanup-newRule:visible, #cleanup-createFirst:visible').first().click();
    await checkSection('task-editor', 1);
    await navigate('protection');
    await checkSection('protection', 1);
    await navigate('tasks');
    await dialog.locator('.auto-agent-entry').click();
    await checkSection('agent', 3);
    await navigate('general');
    await dialog.locator('#openUpdateSettings').click();
    await checkHelp(page, page.locator('#updateDialog'), `${layout}/updates`);
    await page.locator('#closeUpdateDetails').click();
    await navigate('tasks');
    await dialog.locator('#cleanup-newRule:visible, #cleanup-createFirst:visible').first().click();
    await dialog.locator('#cleanup-ruleDomain').fill('settings-help.example.test');
    await dialog.locator('#cleanup-previewRule').click();
    await checkSection('task-preview', 1);
    await page.close();
  }

  for (const [route, selector] of [['sync', '#syncApp'], ['auto-cleanup', '#cleanupSettings'], ['agent', 'main.agent-page']]) {
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/${route}.html`);
    await checkHelp(page, page.locator(selector), `standalone/${route}`);
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(`Passed ${checks} preference-help checks across desktop, popup and standalone settings pages.`);
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
