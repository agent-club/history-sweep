import assert from 'node:assert/strict';
import { createServer } from './serve.mjs';
import { dependency } from './runtime.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const records = Array.from({ length: 24 }, (_, i) => ({ url: `https://site${i}.example.com/page`, title: `History notes ${i}`, lastVisitTime: 1700000000000 + i, visitCount: i + 1 })).concat([
  { url: 'https://chinese.example.com/1', title: '繁體網頁與歷史記錄', lastVisitTime: 1700000001000 },
  { url: 'https://chinese.example.com/2', title: '简体网页与历史记录', lastVisitTime: 1700000002000 },
  { url: 'https://safe.example.com/', title: '<img src=x onerror=alert(1)> History', lastVisitTime: 1700000003000 },
  { url: 'https://empty-title.example.com/history', visitCount: 0 },
]);
const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
server.on('request', (request, response) => {
  if (request.url.startsWith('/extension/')) response.setHeader('Content-Security-Policy', "script-src 'self'; object-src 'none'; connect-src 'none'");
});
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
let checks = 0; const errors = [];
function check(value, message) { assert.ok(value, message); checks++; }
async function visible(page, count) {
  await page.waitForFunction(n => document.querySelector('#suggestionsPanel').dataset.open === 'true' && document.querySelector('#suggestionsList').children.length === n, count);
}
try {
  for (const layout of ['manager', 'popup']) {
    const page = await browser.newPage({ viewport: layout === 'popup' ? { width: 440, height: 590 } : { width: 1280, height: 800 } });
    page.on('pageerror', error => errors.push(error.message)); await installMock(page, records);
    await page.goto(`${origin}/extension/${layout}.html`);
    check(await page.getByRole('combobox', { name: 'Find in your history', exact: true }).count() === 1, 'autocomplete has an accessible name');
    for (const mode of ['smart', 'host-exact', 'host-subdomains']) {
      await page.locator('#mode').selectOption(mode); await page.locator('#query').fill('site'); await visible(page, 10);
      check(await page.locator('#suggestionsList mark').count() >= 10, 'domain prefix highlights every suggestion');
      check(await page.locator('#query').getAttribute('aria-expanded') === 'true', 'expanded state is accessible');
      await page.locator('#query').press('ArrowDown');
      check(await page.locator('#query').getAttribute('aria-activedescendant') === 'suggestion-0', 'keyboard selects first completion');
      await page.locator('#query').press('Enter');
      check((await page.locator('#query').inputValue()).startsWith('site23.'), 'recency ranks equivalent domain prefixes');
      check(await page.locator('#count').textContent() === '0 results', 'completion alone does not scan or change selection');
      check(await page.locator('#query').getAttribute('aria-expanded') === 'false', 'completion closes the panel');
    }
    await page.locator('#mode').selectOption('contains'); await page.locator('#query').fill('history'); await visible(page, 10);
    check(await page.locator('#suggestionsList img, #suggestionsList script').count() === 0, 'history text cannot inject markup');
    await page.locator('#query').press('Escape');
    check(await page.locator('#query').getAttribute('aria-expanded') === 'false', 'Escape closes suggestions');
    await page.locator('#query').fill('网页'); await visible(page, 2);
    check((await page.locator('#suggestionsList mark').allTextContents()).includes('網頁'), 'simplified query highlights original traditional characters');
    await page.locator('#suggestionsList [role=option]').first().click();
    await page.locator('#search').click();
    await page.waitForFunction(() => document.querySelector('#count').textContent === '1 results');
    check(await page.locator('.page-title mark').count() > 0, 'scan results highlight the committed query');
    await page.locator('#selectAll').click();
    await page.locator('#query').fill('歷史'); await visible(page, 2);
    check(await page.locator('#delete').isDisabled() && (await page.locator('#selected').textContent()).startsWith('1'), 'suggestions preserve the stale-result deletion guard and selection');
    await page.locator('#clearQuery').click();
    check(await page.locator('#query').getAttribute('aria-expanded') === 'false' && await page.locator('#query').inputValue() === '', 'clearing closes the panel');
    await page.locator('#query').dispatchEvent('compositionstart');
    await page.locator('#query').fill('历史');
    await page.waitForTimeout(150);
    check(await page.locator('#query').getAttribute('aria-expanded') === 'false', 'IME composition does not open partial suggestions');
    await page.locator('#query').dispatchEvent('compositionend'); await visible(page, 2);
    await page.locator('#query').fill('History'); await page.locator('#query').fill('not-present');
    await page.waitForTimeout(200);
    check(await page.locator('#query').getAttribute('aria-expanded') === 'false', 'rapid input rejects obsolete results');
    await page.locator('#mode').selectOption('smart'); await page.locator('#query').fill('site'); await visible(page, 10);
    await page.locator('#query').press('ArrowUp');
    check(await page.locator('#query').getAttribute('aria-activedescendant') === 'suggestion-9', 'ArrowUp wraps to the final option');
    await page.locator('#query').press('Tab');
    check(await page.locator('#query').getAttribute('aria-expanded') === 'false', 'Tab closes the list when focus leaves the input');
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.locator('#query').focus(); await visible(page, 10);
    check(await page.locator('#suggestionsPanel').evaluate(node => getComputedStyle(node).transitionDuration === '0s'), 'reduced motion disables animation');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'suggestions do not overflow the viewport');
    await page.close();
  }
  const delayed = await browser.newPage(); await installMock(delayed, records); await delayed.goto(`${origin}/extension/manager.html`);
  await delayed.evaluate(() => { const search = chrome.history.search; chrome.history.search = async options => { window.__reads = (window.__reads || 0) + 1; await new Promise(resolve => setTimeout(resolve, 200)); return search(options); }; });
  await delayed.locator('#query').fill('site'); await delayed.waitForFunction(() => window.__reads === 1);
  await delayed.locator('#query').fill('chinese'); await visible(delayed, 1);
  check((await delayed.locator('#suggestionsList').textContent()).includes('chinese.example.com') && await delayed.evaluate(() => window.__reads) === 1, 'in-flight snapshot is reused and only current query is displayed');
  await delayed.locator('#query').fill('site'); await visible(delayed, 10);
  check(await delayed.evaluate(() => window.__reads) === 1, 'typing reuses history and its index');
  await delayed.close();
  check(errors.length === 0, `no runtime errors: ${errors.join('; ')}`);
  console.log(`${checks} autocomplete browser assertions passed; synthetic history only.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
