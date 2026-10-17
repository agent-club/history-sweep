import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dependency} from './runtime.mjs';
import {createServer} from './serve.mjs';
import {installMock} from './fixtures.mjs';

const {chromium} = dependency('playwright');
const output = await mkdtemp(join(tmpdir(), 'history-sweep-row-removal-'));
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const records = Array.from({length: 6}, (_, index) => ({url: `https://snow.test/note-${index}`, title: `Snow note ${index + 1}`, lastVisitTime: Date.now() - index * 60000, visitCount: index + 1}));
let browser, context;
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const ready = page => page.waitForFunction(() => !document.querySelector('#search').disabled);
const done = (page, count) => page.waitForFunction(expected => document.querySelector('#status').dataset.kind === 'done' && !document.querySelector('#search').disabled && document.querySelectorAll('.history-row').length === expected, count);
const confirm = async page => { await page.locator('.history-row').nth(1).hover(); await page.locator('.history-row').nth(1).locator('.row-delete').click(); await page.locator('#confirmDialog [value=confirm]').click(); };

async function observe(page) {
  await page.evaluate(() => {
    window.__pixelStarts = 0;
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof Element && node.matches('.row-removal-pixels')) { window.__pixelStarts++; window.__pixelStart = performance.now(); }
    }).observe(document.body, {childList: true});
  });
}
async function search(page, query) {
  await page.locator('#query').fill(query); await page.locator('#mode').selectOption('contains'); await page.locator('#search').focus(); await page.locator('#search').click(); await ready(page);
  if (await page.locator('.group-load-more').count()) await page.locator('.group-load-more').first().click();
}

try {
  if (process.argv.includes('--native')) {
    const extension = fileURLToPath(new URL('../extension/', import.meta.url));
    context = await chromium.launchPersistentContext(join(output, 'profile'), {executablePath: process.env.HISTORY_SWEEP_CHROMIUM, channel: process.env.HISTORY_SWEEP_CHROMIUM ? undefined : 'chromium', headless: true, viewport: {width: 1280, height: 820}, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]});
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).hostname;
    const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    const violations = []; page.on('console', message => { if (/Refused|Content Security Policy/i.test(message.text())) violations.push(message.text()); });
    await page.goto(`chrome-extension://${id}/manager.html`); await ready(page);
    await page.evaluate(async origin => { for (let i = 0; i < 6; i++) await chrome.history.addUrl({url: `${origin}/snow-native/${i}`}); }, origin);
    await search(page, '/snow-native/'); await observe(page);
    const target = await page.locator('.history-row').nth(1).locator('.row-select').getAttribute('data-url');
    await confirm(page);
    await page.waitForSelector('.row-removal-pixels', {state: 'attached'});
    await page.waitForTimeout(500); await page.screenshot({path: join(output, 'native-scatter.png')});
    await done(page, 5);
    check(await page.evaluate(async url => (await chrome.history.getVisits({url})).length === 0, target), 'native: target deletion verified in isolated history');
    check(await page.locator('.history-row').count() === 5, 'native: only one record removed');
    check(await page.evaluate(() => window.__pixelStarts) === 1, 'native: live canvas starts under extension CSP');
    check(violations.length === 0, 'native: no CSP violations');
    check(errors.length === 0, 'native: no runtime errors');
    await context.close(); context = null;
    await rm(join(output, 'profile'), {recursive: true, force: true});
  } else {
    browser = await chromium.launch({headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? {executablePath: process.env.HISTORY_SWEEP_CHROME} : {})});
    for (const layout of ['manager', 'popup', 'modal']) {
      context = await browser.newContext({viewport: layout === 'manager' ? {width: 1280, height: 820} : {width: 440, height: 690}});
      const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
      await installMock(page, records);
      if (layout === 'modal') await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.body.dataset.presentation = 'modal'; }));
      await page.goto(`${origin}/extension/${layout === 'popup' ? 'popup' : 'manager'}.html`);
      await search(page, 'snow');
      if (layout === 'popup') { await page.locator('#groupBySite').click(); if (await page.locator('.group-load-more').count()) await page.locator('.group-load-more').first().click(); }
      if (layout === 'modal') { await page.locator('#themeToggle').click(); await page.locator('[data-theme-choice=dark]').click(); }
      await observe(page);
      const rows = page.locator('.history-row');
      await rows.first().locator('.row-select').check();
      await rows.nth(1).hover(); await rows.nth(1).locator('.row-delete').click(); await page.locator('#confirmDialog [value=cancel]').click();
      check(await page.evaluate(() => window.__deleted.length === 0 && window.__pixelStarts === 0), `${layout}: cancellation never deletes or animates`);
      await confirm(page); await page.waitForSelector('.row-removal-pixels', {state: 'attached'});
      // Dialog focus may scroll the results before verification. Measure the actual effect's slot.
      const previous = await rows.first().boundingBox(), target = await rows.nth(1).boundingBox(), following = await rows.nth(2).boundingBox();
      await page.waitForTimeout(450);
      check(await rows.nth(1).evaluate(node => getComputedStyle(node).visibility === 'hidden'), `${layout}: original reserves the gap during scatter`);
      check(Math.abs((await rows.first().boundingBox()).y - previous.y) < 1, `${layout}: preceding record stays fixed`);
      check(Math.abs((await rows.nth(2).boundingBox()).y - following.y) < 1, `${layout}: following record waits for particle exit`);
      await page.screenshot({path: join(output, `${layout}-scatter.png`)});
      await page.waitForFunction(() => document.querySelectorAll('.history-row').length === 5);
      check(await page.evaluate(() => performance.now() - window.__pixelStart) >= 1650, `${layout}: outward scatter and fade retain the 1.72-second slot`);
      check(await rows.nth(1).evaluate(node => node.getAnimations().length > 0), `${layout}: remaining records animate upward`);
      await done(page, 5);
      const scrollShift = (await rows.first().boundingBox()).y - previous.y;
      check(Math.abs((await rows.nth(1).boundingBox()).y - target.y - scrollShift) < 1, `${layout}: following record fills the removed slot after scroll clamping`);
      check(await rows.first().locator('.row-select').isChecked(), `${layout}: earlier batch selection survives`);
      check(JSON.stringify(await page.evaluate(() => window.__deleted)) === JSON.stringify([records[1].url]), `${layout}: only clicked URL deleted`);
      check(await page.locator('.row-removal-pixels').count() === 0, `${layout}: canvas released`);
      await page.emulateMedia({reducedMotion: 'reduce'});
      await confirm(page); await done(page, 4);
      check(await page.evaluate(() => window.__pixelStarts) === 1, `${layout}: reduced motion skips particles`);
      check(await rows.count() === 4, `${layout}: reduced motion still removes the target`);
      await page.emulateMedia({reducedMotion: 'no-preference'});
      if (layout === 'manager') {
        const failed = await rows.nth(1).locator('.row-select').getAttribute('data-url');
        await page.evaluate(url => { window.__failDelete = url; }, failed);
        await confirm(page); await page.waitForFunction(() => document.querySelector('#status').dataset.kind === 'partial' && !document.querySelector('#search').disabled);
        check(await rows.count() === 4 && await page.evaluate(() => window.__pixelStarts) === 1, 'failed target remains and never shatters');
        await page.evaluate(() => { window.__failDelete = null; });
        await confirm(page); await page.waitForSelector('.row-removal-pixels', {state: 'attached'});
        await page.setViewportSize({width: 1240, height: 800}); await done(page, 3);
        check(await page.locator('.row-removal-pixels').count() === 0 && await rows.count() === 3, 'resize interrupts the visual without losing the verified removal');
        const count = await page.evaluate(() => window.__pixelStarts);
        await page.locator('#selectAll').click(); await page.locator('#delete').click(); await page.locator('#confirmDialog [value=confirm]').click(); await done(page, 0);
        check(await page.evaluate(() => window.__pixelStarts) === count, 'batch deletion keeps its existing transition');
      }
      check(errors.length === 0, `${layout}: no runtime errors`);
      await context.close(); context = null;
    }
  }
  console.log(JSON.stringify({checks, result: 'PASS', screenshots: output, syntheticHistoryOnly: true}, null, 2));
} finally {
  await context?.close(); await browser?.close(); await new Promise(resolve => server.close(resolve));
}
