import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const records = Array.from({ length: 4 }, (_, i) => ({ url: `https://x.test/item/${i}`, title: `Synthetic x page ${i}`, lastVisitTime: i + 1 }));
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
try {
  browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
  await mkdir('test-results', { recursive: true });
  for (const layout of ['manager', 'popup']) {
    for (const scenario of ['done', 'partial', 'verifyFailed', 'deletionStatusFailed', 'reduced']) {
      const context = await browser.newContext({ viewport: layout === 'popup' ? { width: 440, height: 590 } : { width: 1014, height: 878 }, reducedMotion: scenario === 'reduced' ? 'reduce' : 'no-preference' });
      const page = await context.newPage();
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await installMock(page, records);
      await page.goto(`${origin}/extension/${layout}.html`);
      await page.locator('#query').fill('x'); await page.locator('#search').click();
      await page.waitForFunction(() => !document.querySelector('#search').disabled);
      await page.locator('#selectAll').click();
      if (scenario === 'done') check(await page.locator('.group-results').first().evaluate(el => el.getAnimations().length === 0), `${layout}: selection does not replay a list entrance animation`);
      await page.locator('#delete').click();
      await page.locator('#confirmDialog [value=cancel]').click();
      check(!(await page.locator('#completionFeedback').isVisible()) && await page.evaluate(() => window.__deleted.length) === 0, `${layout}: cancel has no success feedback or deletion`);
      if (scenario === 'partial') await page.evaluate(url => { window.__failDelete = url; }, records[0].url);
      if (scenario === 'verifyFailed') await page.evaluate(() => { window.__failVerify = true; });
      if (scenario === 'deletionStatusFailed') await page.evaluate(() => { window.__failMessage = true; });
      await page.locator('#delete').click(); await page.locator('#confirmDialog [value=confirm]').click();
      const expected = scenario === 'reduced' ? 'done' : scenario;
      await page.waitForFunction(kind => document.querySelector('#status').dataset.kind === kind && !document.querySelector('#search').disabled, expected);
      const success = scenario === 'done' || scenario === 'reduced';
      check(await page.locator('#completionFeedback').isVisible() === success, `${layout}: ${scenario} only verified success receives feedback`);
      if (success) {
        check(await page.locator('#completionCount').textContent() === '4', `${layout}: verified count is displayed immediately`);
        check(await page.evaluate(() => window.__deleted.length) === 4, `${layout}: displayed success count matches verified deleted URLs`);
        check(await page.locator('#delete').isEnabled() === false && (await page.locator('#count').textContent()).startsWith('0'), `${layout}: results and controls update before feedback finishes`);
        if (scenario === 'done') await page.screenshot({ path: `test-results/completion-${layout}.png` });
        else {
          check(await page.locator('#completionFeedback').evaluate(el => getComputedStyle(el).animationName === 'none'), `${layout}: reduced motion disables the entrance animation`);
          check(await page.locator('.completion-orbit').evaluate(el => getComputedStyle(el, '::before').display === 'none'), `${layout}: reduced motion suppresses expanding rings`);
          check(await page.locator('#completionFeedback').evaluate(el => el.getAnimations({ subtree: true }).length === 0), `${layout}: reduced motion suppresses both CSS and scripted animations`);
        }
        await page.locator('#completionFeedback').waitFor({ state: 'hidden', timeout: 5000 });
        check(await page.locator('.removal-ghost').count() === 0, `${layout}: departing row snapshots are cleaned up`);
        check(await page.locator('#search').isEnabled(), `${layout}: completion feedback dismisses without blocking the workflow`);
        // Reopening and deleting again checks that a fresh page starts a new feedback lifecycle.
        await page.reload(); await page.locator('#query').fill('x'); await page.locator('#search').click();
        await page.waitForFunction(() => !document.querySelector('#search').disabled);
        await page.locator('#selectAll').click(); await page.locator('#delete').click(); await page.locator('#confirmDialog [value=confirm]').click();
        await page.locator('#completionFeedback').waitFor({ state: 'visible' });
        await page.locator('#query').fill('changed');
        check(!(await page.locator('#completionFeedback').isVisible()), `${layout}: starting another task dismisses stale feedback`);
      }
      if (scenario === 'partial') check((await page.locator('#selected').textContent()).startsWith('1'), `${layout}: unverified URL remains selected`);
      check(errors.length === 0, `${layout}: ${scenario} has no runtime errors`);
      await context.close();
    }
  }
  console.log(`${checks} UI completion assertions passed. Synthetic history only.`);
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
