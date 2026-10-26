import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const output = process.env.HISTORY_SWEEP_TIME_OUTPUT || await mkdtemp(join(tmpdir(), 'history-sweep-time-'));
await mkdir(output, { recursive: true });
const server = createServer();
const errors = [];
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.HISTORY_SWEEP_CHROME, headless: true });
  for (const [surface, language, theme, width, height] of [
    ['standalone', 'en', 'light', 1200, 900],
    ['manager', 'zh-CN', 'light', 1200, 900],
    ['manager', 'en', 'dark', 1200, 900],
    ['popup', 'en', 'light', 440, 600],
    ['popup', 'zh-CN', 'dark', 360, 600],
    ['manager', 'en', 'light', 800, 600],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await installMock(page, []);
    await page.addInitScript(({ language, theme }) => {
      localStorage.setItem('language', language); localStorage.setItem('theme', theme);
    }, { language, theme });
    const standalone = surface === 'standalone';
    const file = standalone ? 'auto-cleanup' : surface === 'popup' ? 'popup' : 'manager';
    await page.goto(`http://127.0.0.1:${server.address().port}/extension/${file}.html`);
    // The shared visual fixture has no cleanup storage; preserve real save/read behavior here.
    await page.evaluate(() => {
      const storage = chrome.storage.local;
      const get = storage.get, set = storage.set;
      const saved = {};
      storage.get = async key => ({ ...await get(key), ...saved });
      storage.set = async data => { Object.assign(saved, structuredClone(data)); await set(data); };
    });
    const prefix = standalone ? '' : 'cleanup-';
    const field = id => page.locator(`#${prefix}${id}`);
    if (!standalone) {
      await page.locator('#openPreferences').click();
      await page.locator('[data-settings-section=tasks]').click();
    }
    await field('createFirst').click();
    await field('ruleDomain').fill('picker.example.test');
    const input = field('scheduleTime');
    const panel = page.locator(`#${prefix}scheduleTimePicker`);
    const lists = panel.getByRole('listbox');
    await input.click({ position: { x: 12, y: 20 } });
    assert.equal(await input.getAttribute('aria-expanded'), 'true', `${surface}: whole input opens`);
    assert.equal(await lists.count(), 2);
    assert.equal(await lists.nth(0).getByRole('option').count(), 24);
    assert.equal(await lists.nth(1).getByRole('option').count(), 60);
    const rect = await panel.boundingBox();
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height, `${surface}: viewport bounds`);
    assert.ok(await panel.evaluate(node => {
      const r = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(r.x + r.width / 2, r.bottom - 12));
    }), `${surface}: panel is not clipped`);
    await page.screenshot({ path: join(output, `${surface}-${language}-${theme}-open.png`) });
    await lists.nth(0).locator('[data-value="18"]').click();
    await lists.nth(1).locator('[data-value="37"]').click();
    assert.equal(await input.inputValue(), '18:37');
    assert.match(await field('ruleSummary').textContent(), /18:37/);
    await panel.locator('.auto-time-footer button').click();
    assert.equal(await input.getAttribute('aria-expanded'), 'false');
    assert.ok(await input.evaluate(node => node === document.activeElement));
    await page.keyboard.press('Enter');
    assert.equal(await lists.nth(0).locator('[aria-selected=true]').textContent(), '18');
    assert.ok(await lists.nth(0).evaluate(list => {
      const a = list.getBoundingClientRect(), b = list.querySelector('[aria-selected=true]').getBoundingClientRect();
      return b.top >= a.top && b.bottom <= a.bottom;
    }), `${surface}: selected hour is visible after reopening`);
    await page.keyboard.press('End'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('End');
    assert.equal(await input.inputValue(), '23:59');
    await page.keyboard.press('Home'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Home');
    assert.equal(await input.inputValue(), '00:00');
    await page.keyboard.type('09'); await page.keyboard.press('Tab'); await page.keyboard.type('08');
    assert.equal(await input.inputValue(), '09:08');
    await page.keyboard.press('Tab');
    assert.ok(await panel.locator('.auto-time-footer button').evaluate(node => node === document.activeElement));
    await page.keyboard.press('Escape');
    assert.equal(await input.getAttribute('aria-expanded'), 'false');
    assert.ok(await field('ruleEditor').isVisible(), `${surface}: Escape keeps editor open`);
    await input.click(); await field('ruleDomain').click();
    assert.equal(await input.getAttribute('aria-expanded'), 'false', `${surface}: outside click closes`);
    await input.click(); await page.keyboard.press('Shift+Tab');
    assert.equal(await input.getAttribute('aria-expanded'), 'false', `${surface}: Tab can leave picker`);
    await field('scheduleType').selectOption('weekly');
    assert.equal(await input.inputValue(), '09:08');
    await field('saveDisabled').click();
    await page.waitForFunction(prefix => document.querySelector('.auto-rule-card') || !document.getElementById(`${prefix}ruleError`).hidden, prefix);
    assert.ok(await field('ruleError').isHidden(), await field('ruleError').textContent());
    await page.locator('.auto-rule-card').waitFor();
    await page.locator('.auto-rule-actions button').filter({ hasText: language === 'zh-CN' ? '编辑' : 'Edit' }).click();
    assert.equal(await input.inputValue(), '09:08', `${surface}: persisted time round trip`);
    await input.click();
    await page.screenshot({ path: join(output, `${surface}-${language}-${theme}-selected.png`) });
    await context.close();
    console.log(`Passed: ${surface}, ${language}, ${theme}, ${width}×${height}`);
  }
  assert.deepEqual(errors, []);
  console.log(`Time picker interaction checks passed. Screenshots: ${output}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  if (!process.env.HISTORY_SWEEP_TIME_OUTPUT) await rm(output, { recursive: true, force: true });
}
