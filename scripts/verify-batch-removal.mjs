import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const output = await mkdtemp(join(tmpdir(), 'history-sweep-batch-wind-'));
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const records = Array.from({ length: 6 }, (_, index) => ({
  url: `https://wind.test/notes/${index}`, title: `Particle wind study ${index + 1}`,
  lastVisitTime: Date.now() - index * 60000, visitCount: index + 1,
}));
const selected = [1, 2, 4];
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const ready = page => page.waitForFunction(() => !document.querySelector('#search').disabled);
const finished = (page, phase = 'done') => page.waitForFunction(expected => document.querySelector('#status').dataset.kind === expected && !document.querySelector('#search').disabled, phase);
const confirm = async page => { await page.locator('#delete').click(); await page.locator('#confirmDialog [value=confirm]').click(); };
let checks = 0, browser, context;

async function search(page, query) {
  await page.locator('#query').fill(query); await page.locator('#mode').selectOption('contains'); await page.locator('#search').click(); await ready(page);
  if (await page.locator('.group-load-more').count()) await page.locator('.group-load-more').first().click();
}
async function observe(page) {
  await page.evaluate(() => {
    window.__windStarts = 0;
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof Element && node.matches('.batch-removal-wind')) {
        window.__windStarts++; window.__windStarted = performance.now();
      }
      if (!window.__windReflowStarted && document.querySelector('.batch-removal-wind') && [...document.querySelectorAll('.history-row')].some(row => row.getAnimations().some(animation => animation.id === 'batch-removal-reflow'))) {
        window.__windReflowStarted = performance.now();
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
}
async function verifyWind(page, name, expectedRows = 3) {
  await page.locator('.batch-removal-wind').waitFor({ state: 'attached' });
  check(await page.locator('.batch-removal-wind').evaluate(node => Number(node.dataset.rows) > 0 && Number(node.dataset.rows) <= 3 && Number(node.dataset.fragments) > 30), `${name}: visible selected rows produce textured particles`);
  const rows = page.locator('.history-row');
  const previous = await rows.nth(0).boundingBox(), following = await rows.nth(3).boundingBox(), target = await rows.nth(1).boundingBox();
  check(await rows.evaluateAll(nodes => nodes.some(node => node.style.visibility === 'hidden')), `${name}: visible selected originals reserve their slots`);
  check(!(await page.locator('#completionFeedback').isVisible()), `${name}: completion never overlaps the wind`);
  await page.waitForTimeout(900);
  check(Math.abs((await rows.nth(0).boundingBox()).y - previous.y) < 1 && Math.abs((await rows.nth(3).boundingBox()).y - following.y) < 1, `${name}: retained rows stay still during release`);
  await page.screenshot({ path: join(output, `${name}-wind.png`) });
  await page.waitForFunction(() => [...document.querySelectorAll('.history-row')].some(row => row.getAnimations().some(animation => animation.id === 'batch-removal-reflow')));
  const reflowTime = await page.evaluate(() => window.__windReflowStarted - window.__windStarted);
  check(reflowTime >= 1990 && reflowTime < 2450, `${name}: reflow starts near 80% of the 2.55-second wind`);
  check(await page.locator('.batch-removal-wind').count() === 1, `${name}: particle tail overlaps reflow`);
  check(await page.locator('.batch-removal-wind').evaluate((canvas, target) => {
    const ratio = canvas.width / innerWidth;
    return canvas.getContext('2d').getImageData(Math.floor((target.x + 10) * ratio), Math.floor((target.y + target.height / 2) * ratio), 1, 1).data[3] === 0;
  }, target), `${name}: old row backgrounds no longer cover the moving list`);
  await finished(page);
  check(await page.locator('.batch-removal-wind').count() === 0, `${name}: particle tail is released after completion`);
  check(await rows.count() === expectedRows, `${name}: remaining records are rendered`);
  check(await page.locator('#completionCount').textContent() === '3', `${name}: completion count matches the verified batch`);
  check(await rows.evaluateAll(nodes => nodes.every(node => node.style.visibility !== 'hidden' && node.getAnimations().every(animation => animation.id !== 'batch-removal-reflow'))), `${name}: visibility and reflow animations are released`);
  await page.waitForTimeout(260);
  await page.screenshot({ path: join(output, `${name}-complete.png`) });
}

try {
  if (process.argv.includes('--native')) {
    const extension = fileURLToPath(new URL('../extension/', import.meta.url));
    context = await chromium.launchPersistentContext(join(output, 'profile'), { executablePath: process.env.HISTORY_SWEEP_CHROMIUM, channel: process.env.HISTORY_SWEEP_CHROMIUM ? undefined : 'chromium', headless: true, viewport: { width: 1280, height: 900 }, recordVideo: { dir: output, size: { width: 1280, height: 900 } }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).hostname;
    const page = await context.newPage(), errors = [], violations = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (/Refused|Content Security Policy/i.test(message.text())) violations.push(message.text()); });
    await page.goto(`chrome-extension://${id}/manager.html`); await ready(page);
    await page.evaluate(async ({ records, origin }) => { for (const item of records) await chrome.history.addUrl({ url: `${origin}/wind-native/${item.visitCount}` }); }, { records, origin });
    await search(page, '/wind-native/'); await observe(page);
    const urls = [];
    for (const index of selected) { urls.push(await page.locator('.history-row').nth(index).locator('.row-select').getAttribute('data-url')); await page.locator('.history-row').nth(index).locator('.row-select').check(); }
    await confirm(page); await verifyWind(page, 'native');
    check(await page.evaluate(async urls => (await Promise.all(urls.map(url => chrome.history.getVisits({ url })))).every(visits => visits.length === 0), urls), 'native: all three selected URLs are verified absent');
    check(errors.length === 0 && violations.length === 0, 'native: shared snapshots and pixel reads work under extension CSP');
    await context.close(); context = null; await rm(join(output, 'profile'), { recursive: true, force: true });
  } else {
    browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
    const run = async (name, options, exercise) => {
      const popup = name.startsWith('popup');
      context = await browser.newContext({ viewport: options.viewport || (popup || name.startsWith('modal') ? { width: 440, height: 740 } : { width: 1280, height: 900 }), reducedMotion: options.reduced ? 'reduce' : 'no-preference' });
      try {
        const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
        await installMock(page, options.records || records);
        if (name.startsWith('modal')) await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.body.dataset.presentation = 'modal'; }));
        await page.goto(`${origin}/extension/${popup ? 'popup' : 'manager'}.html`); await search(page, 'wind');
        if (name.includes('website')) { await page.locator('#groupBySite').click(); if (await page.locator('.group-load-more').count()) await page.locator('.group-load-more').first().click(); }
        if (name.includes('dark')) { await page.locator('#themeToggle').click(); await page.locator('[data-theme-choice=dark]').click(); }
        await observe(page);
        for (const index of options.selected || selected) await page.locator('.history-row').nth(index).locator('.row-select').check();
        await exercise(page);
        check(errors.length === 0, `${name}: no runtime errors`);
      } finally { await context.close(); context = null; }
    };
    for (const name of ['manager-date', 'manager-website', 'popup-website', 'modal-dark']) await run(name, {}, async page => {
      await confirm(page); await verifyWind(page, name);
      check(JSON.stringify(await page.evaluate(() => window.__deleted)) === JSON.stringify(selected.map(index => records[index].url)), `${name}: only selected URLs are deleted`);
    });
    const many = Array.from({ length: 10 }, (_, index) => ({ ...records[0], url: `https://wind.test/many/${index}`, title: `Visible batch record ${index + 1}`, lastVisitTime: Date.now() - index * 60000 }));
    await run('large-visible-batch', { records: many, selected: [1, 2, 3, 4, 5, 6, 7, 8], viewport: { width: 1280, height: 1400 } }, async page => {
      await confirm(page); await page.locator('.batch-removal-wind').waitFor({ state: 'attached' });
      check(await page.locator('.batch-removal-wind').getAttribute('data-rows') === '8', 'all eight visible selected rows animate, beyond the former six-row limit');
      await finished(page);
      check(await page.locator('.history-row').count() === 2 && await page.locator('#completionCount').textContent() === '8', 'larger batch keeps exactly the two unselected records');
    });
    for (const name of ['cancel', 'partial', 'verifyFailed', 'reduced', 'snapshot-failed', 'snapshot-timeout']) await run(name, { reduced: name === 'reduced' }, async page => {
      if (name === 'cancel') { await page.locator('#delete').click(); await page.locator('#confirmDialog [value=cancel]').click(); check(await page.evaluate(() => window.__deleted.length) === 0, 'cancel: no data removed'); }
      else {
        if (name === 'partial') await page.evaluate(url => { window.__failDelete = url; }, records[2].url);
        if (name === 'verifyFailed') await page.evaluate(() => { window.__failVerify = true; });
        if (name === 'snapshot-failed') await page.evaluate(() => { Image.prototype.decode = async () => { throw new Error('Synthetic decode failure'); }; });
        if (name === 'snapshot-timeout') await page.evaluate(() => { Image.prototype.decode = () => new Promise(() => {}); });
        await confirm(page); await finished(page, name === 'partial' || name === 'verifyFailed' ? name : 'done');
        if (name !== 'partial' && name !== 'verifyFailed') check(await page.evaluate(() => window.__deleted.length) === 3, `${name}: verified deletion still completes`);
        if (name === 'partial') check((await page.locator('#selected').textContent()).startsWith('1'), 'partial: failed URL remains selected');
      }
      check(await page.evaluate(() => window.__windStarts) === 0, `${name}: no unsupported success wind`);
      check(await page.locator('.batch-removal-wind').count() === 0, `${name}: no canvas remains`);
    });
    for (const name of ['resize', 'scroll', 'motion-change', 'theme-change', 'visibility', 'reflow-resize', 'reflow-scroll', 'reflow-motion-change']) await run(name, {}, async page => {
      await confirm(page); await page.locator('.batch-removal-wind').waitFor({ state: 'attached' });
      if (name.startsWith('reflow-')) await page.waitForFunction(() => [...document.querySelectorAll('.history-row')].some(row => row.getAnimations().some(animation => animation.id === 'batch-removal-reflow')));
      if (name.endsWith('resize')) await page.setViewportSize({ width: 1200, height: 820 });
      if (name.endsWith('scroll')) await page.locator('#resultScroll').evaluate(node => { node.scrollTop += 1; node.dispatchEvent(new Event('scroll')); });
      if (name.endsWith('motion-change')) await page.emulateMedia({ reducedMotion: 'reduce' });
      if (name === 'theme-change') await page.evaluate(() => document.dispatchEvent(new CustomEvent('history-sweep:theme-changed')));
      if (name === 'visibility') await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
      await finished(page);
      check(await page.locator('.batch-removal-wind').count() === 0, `${name}: interrupted canvas released`);
      check(await page.locator('.history-row').count() === 3, `${name}: verified result renders after interruption`);
      check(await page.locator('.history-row').evaluateAll(nodes => nodes.every(node => node.style.visibility !== 'hidden')), `${name}: retained rows stay visible`);
    });
  }
  console.log(JSON.stringify({ result: 'PASS', checks, screenshots: output, syntheticHistoryOnly: true }, null, 2));
} finally { await context?.close(); await browser?.close(); await new Promise(resolve => server.close(resolve)); }
