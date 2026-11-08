import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';
import { enterWorkspace } from './native-workspace.mjs';

const { chromium } = dependency('playwright');
const output = process.env.HISTORY_SWEEP_UI_OUTPUT || await mkdtemp(join(tmpdir(), 'history-sweep-recommended-cleanup-'));
await mkdir(output, { recursive: true });
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROMIUM ? { executablePath: process.env.HISTORY_SWEEP_CHROMIUM } : {}) });
const errors = [];
const contexts = [];
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const now = Date.now();
const candidates = Array.from({ length: 6 }, (_, index) => ({ id: String(index), url: `chrome-extension://abcdefghijklmnopabcdefghijklmnop/page-${index}.html`, title: `推荐记录 ${index + 1}`, lastVisitTime: now - index * 1000, visitCount: index + 1 }));
const ordinary = ['https://reading.example/one', 'https://reading.example/two', 'https://retained.example/keep'].map((url, index) => ({ id: `ordinary-${index}`, url, title: `保留记录 ${index + 1}`, lastVisitTime: now - index * 1000, visitCount: 2 }));
async function open({ layout = 'manager', lang = 'zh-CN', theme = 'light', reducedMotion = 'reduce', extra = [] } = {}) {
  const context = await browser.newContext({ viewport: layout === 'popup' ? { width: 440, height: 700 } : { width: 1280, height: 900 }, reducedMotion, deviceScaleFactor: 1 });
  contexts.push(context);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await installMock(page, [...candidates, ...ordinary, ...extra]);
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('language', lang); localStorage.setItem('theme', theme);
    localStorage.setItem('fixture-browsing-preferences', JSON.stringify({ view: 'website', range: '7days', viewOrder: ['date', 'website', 'frequency'], hiddenViews: [] }));
    localStorage.setItem('fixture-kept-sites', '[]');
    localStorage.setItem('fixture-cleanupRecommendationSettings', JSON.stringify({ version: 1, habit: { enabled: false, lookbackDays: 7, minimumDays: 2 }, types: { extension: true, application: true }, sites: [], cue: 'new' }));
    window.__cleanupCues = 0;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) { if (this.id === 'cleanupHintCount') window.__cleanupCues++; return animate.apply(this, args); };
  }, { lang, theme });
  await page.goto(`${origin}/extension/${layout}.html`); await enterWorkspace(page);
  await page.locator('#cleanupHintClean').waitFor();
  return page;
}
async function confirm(page, count) {
  await page.locator('#cleanupHintClean').click();
  await page.locator('#confirmDialog').waitFor();
  check((await page.locator('#confirmBody').textContent()).includes(` ${count} `), 'confirmation describes only this cleanup scope');
  await page.locator('#confirmDialog [value=confirm]').click();
}
async function idle(page, removed) {
  await page.waitForFunction(removed => window.__deleted.length === removed && !document.querySelector('#search').disabled, removed);
}
try {
  const page = await open({ reducedMotion: 'no-preference' });
  check(await page.evaluate(() => window.__cleanupCues > 0), 'discovery animates the count badge');
  await page.locator('.website-group[data-hostname="reading.example"] .group-select').check();
  await page.locator('#cleanupHintToggle').click();
  check(await page.locator('#cleanupHintClean').isDisabled(), 'entering selection with zero recommendations selected disables cleanup');
  check(await page.locator('.cleanup-candidate').count() === 6 && await page.locator('.row-select').count() === 5, 'recommendations include the unrendered sixth record');
  await page.locator('.cleanup-candidate').first().check();
  await page.locator('.cleanup-candidate').nth(5).check();
  check(await page.locator('.row-select:checked').count() === 1, 'recommendation selection synchronizes the rendered main row');
  await page.screenshot({ path: join(output, 'manager-selection.png') });
  await page.locator('#cleanupHintClean').click(); await page.locator('#confirmDialog [value=cancel]').click();
  await page.waitForFunction(() => !document.querySelector('#cleanupHintClean').disabled);
  check(await page.locator('#cleanupHintClean').evaluate(element => element === document.activeElement), 'cancel returns keyboard focus');
  check(await page.evaluate(() => window.__deleted.length) === 0 && await page.locator('.cleanup-candidate:checked').count() === 2, 'cancel preserves selection without deleting');
  await confirm(page, 2); await idle(page, 2);
  await page.waitForFunction(() => document.querySelector('#cleanupHintCount').textContent === '4');
  await page.waitForTimeout(850);
  check(await page.locator('#cleanupHintSlot').isVisible() && !await page.locator('#cleanupHintSuccess').isVisible(), 'partial success keeps the remaining recommendations');
  check(await page.locator('.website-group[data-hostname="reading.example"] .group-select').isChecked(), 'unrelated main-list selection is retained');
  check(await page.locator('#cleanupHintClean').isDisabled(), 'cleared recommendation selection never silently switches to all');
  await page.locator('#ratingDialog').waitFor();
  await page.locator('#skipRating').click();
  await page.locator('#cleanupHintToggle').click(); await page.locator('#cleanupHintSelectAll').check();
  await confirm(page, 4); await idle(page, 6);
  await page.locator('#cleanupHintSuccess').waitFor();
  const top = await page.locator('#groups').evaluate(element => element.getBoundingClientRect().top);
  await page.screenshot({ path: join(output, 'manager-success.png') });
  await page.waitForFunction(() => document.querySelector('#cleanupHintSlot').hidden);
  await page.waitForTimeout(250);
  check(top - await page.locator('#groups').evaluate(element => element.getBoundingClientRect().top) >= 60, 'success releases its space and the list closes the gap');
  check(await page.locator('.cleanup-success-ghost').count() === 0, 'completed exit removes its decorative copy');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  check(!await page.locator('#cleanupHintSlot').isVisible(), 'focus refresh does not revive completed recommendations');
  check(await page.evaluate(() => window.__deleted.every(url => url.startsWith('chrome-extension://'))), 'cleanup never deletes unrelated selected URLs');
  await page.screenshot({ path: join(output, 'manager-dismissed.png') });

  const failure = await open();
  await failure.locator('#cleanupHintToggle').click();
  await failure.locator('.cleanup-candidate').nth(0).check(); await failure.locator('.cleanup-candidate').nth(1).check();
  await failure.evaluate(url => { window.__failDelete = url; }, candidates[0].url);
  await confirm(failure, 2); await idle(failure, 1);
  await failure.locator('#cleanupHintNotice').waitFor();
  check(await failure.locator('#cleanupHintCount').textContent() === '5', 'failed and unattempted recommendations remain together');
  check(await failure.locator('.cleanup-candidate:checked').count() === 1, 'verified failed record remains selected');
  check(await failure.locator('[data-reason=remaining]').evaluate(element => element.open), 'verified failed record is visible without reopening its group');
  check((await failure.locator('#cleanupHintDetail').textContent()).includes('扩展记录'), 'mixed remaining recommendations retain their source description');
  check(!await failure.locator('#cleanupHintSuccess').isVisible(), 'partial failure does not claim full completion');
  await failure.screenshot({ path: join(output, 'manager-partial-failure.png') });
  await failure.evaluate(() => { delete window.__failDelete; });
  await confirm(failure, 1); await idle(failure, 2);
  check(!await failure.locator('#cleanupHintNotice').isVisible(), 'successful retry clears failure feedback');

  const unknown = await open();
  await unknown.evaluate(() => { window.__failVerify = true; });
  await confirm(unknown, 6); await idle(unknown, 6);
  await unknown.locator('#cleanupHintNotice').waitFor();
  check((await unknown.locator('#cleanupHintNotice').textContent()).includes('无法确认'), 'verification failure is reported as unknown');
  check(!await unknown.locator('#cleanupHintSuccess').isVisible(), 'unknown result never reports success');

  for (const [lang, theme] of [['zh-CN', 'light'], ['en', 'dark']]) {
    const popup = await open({ layout: 'popup', lang, theme });
    check(await popup.evaluate(() => window.__cleanupCues === 0), 'reduced motion skips the badge flip');
    await popup.locator('#cleanupHintToggle').click();
    await popup.locator('#cleanupHintSelectAll').check(); await popup.locator('#cleanupHintSelectAll').uncheck();
    check(await popup.locator('#cleanupHintClean').isDisabled(), 'unchecking all keeps selective cleanup disabled');
    await popup.locator('.cleanup-candidate').nth(5).check();
    check(await popup.locator('#cleanupHintClean').evaluate(element => {
      const rect = element.getBoundingClientRect(), container = document.querySelector('#resultScroll').getBoundingClientRect();
      return rect.top >= container.top && rect.bottom <= container.bottom;
    }), 'narrow selection keeps the cleanup action visible');
    check(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'popup has no horizontal overflow');
    check(await popup.locator('#cleanupHintCleanCount').textContent() === (lang === 'en' ? '1 item' : '1 项'), 'localized cleanup count appears exactly once');
    await popup.screenshot({ path: join(output, `popup-${lang}-${theme}.png`) });
    await popup.locator('#cleanupHintToggle').press('Escape');
    check(await popup.locator('#cleanupHintToggle').evaluate(element => element === document.activeElement), 'Escape returns focus to the selection entry');
    await popup.locator('#cleanupHintToggle').click(); await popup.locator('#cleanupHintBack').click();
    await confirm(popup, 6); await idle(popup, 6);
    await popup.locator('#cleanupHintSuccess').waitFor();
    await popup.waitForFunction(() => document.querySelector('#cleanupHintSlot').hidden);
    check(await popup.locator('.cleanup-success-ghost').count() === 0, 'reduced-motion completion collapses directly');
  }
  const stale = await open();
  await stale.locator('#query').fill('changed');
  check(!await stale.locator('#cleanupHintSlot').isVisible(), 'editing search hides stale cleanup recommendations');
  check(await stale.evaluate(() => window.__deleted.length) === 0, 'stale search never starts a cleanup');
  const incompleteScan = await open();
  await incompleteScan.locator('#cleanupHintToggle').click();
  await incompleteScan.locator('.cleanup-candidate').nth(0).check(); await incompleteScan.locator('.cleanup-candidate').nth(1).check();
  await incompleteScan.evaluate(url => {
    window.__failDelete = url;
    const search = chrome.history.search;
    // Model a fresh scan that omits a URL which per-URL verification still finds.
    chrome.history.search = args => window.__deleted.length ? Promise.resolve([]) : search(args);
  }, candidates[0].url);
  await confirm(incompleteScan, 2); await idle(incompleteScan, 1);
  check(await incompleteScan.locator('#status').getAttribute('data-kind') === 'partial' && !await incompleteScan.locator('#cleanupHintSuccess').isVisible(), 'an incomplete scan cannot turn a verified partial failure into full success');
  const interrupted = await open({ reducedMotion: 'no-preference' });
  await confirm(interrupted, 6); await idle(interrupted, 6);
  await interrupted.waitForFunction(() => document.querySelector('.cleanup-success-ghost'));
  await interrupted.emulateMedia({ reducedMotion: 'reduce' });
  await interrupted.waitForFunction(() => !document.querySelector('.cleanup-success-ghost'));
  check(await interrupted.locator('#groups').evaluate(element => element.getAnimations().length === 0), 'enabling reduced motion during exit cancels list travel');
  const nextSearch = await open();
  await confirm(nextSearch, 6); await idle(nextSearch, 6);
  await nextSearch.locator('#cleanupHintSuccess').waitFor();
  await nextSearch.evaluate(item => { chrome.history.search = async () => [item]; }, { ...candidates[0], url: candidates[0].url + '?new-search' });
  await nextSearch.locator('#search').click();
  await nextSearch.waitForFunction(() => document.querySelector('#cleanupHintCount').textContent === '1' && !document.querySelector('#search').disabled);
  await nextSearch.waitForTimeout(1100);
  check(await nextSearch.locator('#cleanupHintSlot').isVisible(), 'an old completion timer cannot dismiss recommendations from a new search');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', checks, pageErrors: errors, screenshots: output, syntheticHistoryOnly: true }));
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
