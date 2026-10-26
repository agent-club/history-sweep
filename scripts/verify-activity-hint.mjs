import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.HISTORY_SWEEP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const output = process.env.HISTORY_SWEEP_HINT_OUTPUT;
const errors = [];
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const records = Array.from({ length: 84 }, (_, index) => ({ url: `https://notes.example.com/page-${index}`, title: `Synthetic note ${index}`, lastVisitTime: Date.parse('2026-10-22T12:00:00+08:00') - index * 86400000, visitCount: 1 }));
const scenarios = [
  { name: 'modal', width: 1280, height: 850, language: 'zh-CN', motion: 'no-preference' },
  { name: 'manager-dark', width: 1280, height: 900, language: 'en', motion: 'no-preference', dark: true },
  { name: 'popup-reduced', width: 440, height: 590, language: 'zh-CN', motion: 'reduce', dark: true },
  { name: 'narrow-english', width: 375, height: 812, language: 'en', motion: 'no-preference' },
];
try {
  if (output) await mkdir(output, { recursive: true });
  for (const scenario of scenarios) {
    const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, timezoneId: 'Asia/Shanghai', reducedMotion: scenario.motion });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    if (scenario.name === 'modal') await page.route('**/manager.html', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
    });
    await installMock(page, records);
    await page.addInitScript(({ language, dark }) => {
      localStorage.setItem('language', language); localStorage.setItem('theme', dark ? 'dark' : 'light');
      localStorage.setItem('fixture-browsing-preferences', JSON.stringify({ view: 'date', range: 'all' }));
    }, scenario);
    await page.goto(`http://127.0.0.1:${server.address().port}/extension/${scenario.name.startsWith('popup') ? 'popup' : 'manager'}.html`);
    await page.locator('#activityEntry').click();
    await page.waitForFunction(() => document.querySelector('#activityPanel').getAttribute('aria-busy') === 'false' && document.querySelector('#activityDock').dataset.settled === 'true');
    await page.waitForTimeout(500);
    check(await page.locator('#activityScrollHint').count() === 0, `${scenario.name}: the retired gesture cue is absent`);
    check(await page.evaluate(() => !window.__messages.some(message => message.type === 'claim-activity-scroll-hint')), `${scenario.name}: opening does not claim a retired gesture reminder`);
    const label = scenario.language === 'en' ? 'Collapse analysis' : '收起分析';
    check(await page.locator('#activityCollapse').innerText() === label, `${scenario.name}: the explicit close action uses the active language`);
    if (output) await page.screenshot({ path: join(output, `${scenario.name}.png`) });
    await page.locator('#activityCollapse').click();
    await page.waitForFunction(() => document.querySelector('#activityPanel').hidden);
    const expand = scenario.language === 'en' ? 'Expand analysis' : '展开分析';
    check((await page.locator('#activityEntry').innerText()).includes(expand), `${scenario.name}: the permanent entry describes the explicit open action`);
    await page.locator('#activityEntry').click();
    await page.waitForFunction(() => document.querySelector('#activityDock').dataset.settled === 'true');
    check(await page.locator('#activityPanel').isVisible(), `${scenario.name}: repeated explicit disclosure works`);
    await context.close();
  }
  check(errors.length === 0, `no page errors: ${errors.join('; ')}`);
  console.log(`${checks} explicit-analysis guidance checks passed across modal, manager, popup, narrow English, dark and reduced-motion views. Synthetic history only.`);
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
