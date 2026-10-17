import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const output = await mkdtemp(join(tmpdir(), 'history-sweep-collapsed-live-'));
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const items = [['first', 2], ['target', 3], ['next', 2], ['last', 2]].flatMap(([host, count], day) => Array.from({ length: count }, (_, index) => {
  const date = new Date(); date.setDate(date.getDate() - day); date.setHours(12, 0, 0, 0);
  return { url: `https://${host}.collapse.test/item/${index}`, title: `Synthetic ${host} ${index + 1}`, lastVisitTime: date.getTime() - index * 60000, visitCount: index + 1 };
}));
let checks = 0, browser, context;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const ready = page => page.waitForFunction(() => !document.querySelector('#search').disabled);
const done = (page, phase = 'done') => page.waitForFunction(expected => document.querySelector('#status').dataset.kind === expected && !document.querySelector('#search').disabled, phase);
const confirm = async page => { await page.locator('#delete').click(); await page.locator('#confirmDialog [value=confirm]').click(); };
async function observe(page) {
  await page.evaluate(() => {
    window.__scrollStarts = 0;
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof Element && node.matches('.batch-removal-wind')) { window.__scrollStarts++; window.__scrollStart = performance.now(); }
      if (!window.__scrollReflow && document.querySelector('.batch-removal-wind') && [...document.querySelectorAll('.group-header,.date-header,.history-row')].some(node => node.getAnimations().some(animation => animation.id === 'batch-removal-reflow'))) window.__scrollReflow = performance.now();
    }).observe(document.body, { childList: true, subtree: true });
  });
}
async function verifyScroll(page, name, expected = 1, mixed = false) {
  const canvas = page.locator('.batch-removal-wind'); await canvas.waitFor({ state: 'attached' });
  check(Number(await canvas.getAttribute('data-scrolls')) === expected, `${name}: collapsed targets use scroll particles`);
  check(Number(await canvas.getAttribute('data-rows')) === (mixed ? 1 : 0), `${name}: expanded rows keep the wind treatment`);
  check(Number(await canvas.getAttribute('data-fragments')) > 5, `${name}: live text and controls produce fragments`);
  await page.waitForTimeout(800); await page.screenshot({ path: join(output, `${name}-scroll.png`) });
  await page.waitForFunction(() => [...document.querySelectorAll('.group-header,.date-header,.history-row')].some(node => node.getAnimations().some(animation => animation.id === 'batch-removal-reflow')));
  const elapsed = await page.evaluate(() => window.__scrollReflow - window.__scrollStart);
  check(elapsed >= (mixed ? 1990 : 1510) && elapsed < (mixed ? 2450 : 1900), `${name}: reflow begins near 80 percent`);
  check(await canvas.count() === 1, `${name}: particle tail continues over reflow`);
  await done(page);
  check(await canvas.count() === 0, `${name}: canvas cleaned up`);
  check(await page.locator('.group-header,.date-header,.group-selected').evaluateAll(nodes => nodes.every(node => node.style.visibility !== 'hidden')), `${name}: no stale hidden header or label`);
  await page.waitForTimeout(260); await page.screenshot({ path: join(output, `${name}-done.png`) });
}

try {
  if (process.argv.includes('--native')) {
    const extension = fileURLToPath(new URL('../extension/', import.meta.url));
    context = await chromium.launchPersistentContext(join(output, 'profile'), { executablePath: process.env.HISTORY_SWEEP_CHROMIUM, channel: process.env.HISTORY_SWEEP_CHROMIUM ? undefined : 'chromium', headless: true, viewport: { width: 1280, height: 900 }, recordVideo: { dir: output, size: { width: 1280, height: 900 } }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'), id = new URL(worker.url()).hostname;
    const page = await context.newPage(), errors = [], violations = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (/Refused|Content Security Policy/i.test(message.text())) violations.push(message.text()); });
    await page.goto(`chrome-extension://${id}/manager.html`); await ready(page);
    await page.evaluate(async origin => {
      const keepOrigin = origin.replace('127.0.0.1', 'localhost');
      for (let i = 0; i < 2; i++) await chrome.history.addUrl({ url: `${keepOrigin}/collapse-native/keep-${i}` });
      for (let i = 0; i < 4; i++) await chrome.history.addUrl({ url: `${origin}/collapse-native/remove-${i}` });
    }, origin);
    await page.locator('#query').fill('/collapse-native/'); await page.locator('#mode').selectOption('contains'); await page.locator('#search').click(); await ready(page); await page.locator('#groupBySite').click();
    const target = page.locator('.website-group[data-hostname="127.0.0.1"]');
    if (await target.locator('.group-toggle').getAttribute('aria-expanded') === 'true') await target.locator('.group-toggle').click();
    const keep = page.locator('.website-group[data-hostname="localhost"]'); if (await keep.locator('.group-toggle').getAttribute('aria-expanded') === 'false') await keep.locator('.group-toggle').click();
    await target.locator('.group-select').check(); await observe(page); await confirm(page); await verifyScroll(page, 'native');
    check(await page.evaluate(async origin => (await chrome.history.search({ text: '', startTime: 0, maxResults: 100 })).filter(item => item.url.startsWith(`${origin}/collapse-native/remove-`)).length === 0, origin), 'native: selected synthetic history removed');
    check(errors.length === 0 && violations.length === 0, 'native: headers, favicon snapshots and pixel reads work under extension CSP');
    await context.close(); context = null; await rm(join(output, 'profile'), { recursive: true, force: true });
  } else {
    browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
    const run = async (name, exercise, { date = false, reduced = false, records = items } = {}) => {
      const compact = name.includes('popup') || name.includes('modal');
      context = await browser.newContext({ viewport: compact ? { width: 440, height: 740 } : { width: 1280, height: 900 }, reducedMotion: reduced ? 'reduce' : 'no-preference' });
      try {
        const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()); await installMock(page, records);
        if (name.includes('modal')) await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => { document.body.dataset.presentation = 'modal'; }));
        await page.goto(`${origin}/extension/${name.includes('popup') ? 'popup' : 'manager'}.html`);
        await page.locator('#query').fill('collapse.test'); await page.locator('#filterToggle').click(); await page.locator('#timeRange').selectOption('all'); await page.locator('#filterToggle').click(); await page.locator('#search').click(); await ready(page);
        await page.locator(date ? '#groupByDate' : '#groupBySite').click();
        const groups = page.locator(date ? '.date-group' : '.website-group');
        for (let i = 0; i < await groups.count(); i++) {
          const toggle = groups.nth(i).locator(date ? ':scope > .date-header .date-toggle' : ':scope > .group-header .group-toggle');
          if (await toggle.getAttribute('aria-expanded') !== String(i === 2)) await toggle.click();
        }
        if (date) { const next = groups.nth(2).locator('.group-toggle').first(); if (await next.getAttribute('aria-expanded') === 'false') await next.click(); }
        if (name.includes('dark')) { await page.locator('#themeToggle').click(); await page.locator('[data-theme-choice=dark]').click(); }
        await observe(page);
        const target = groups.nth(1), select = target.locator(date ? ':scope > .date-header .date-select' : ':scope > .group-header .group-select');
        await exercise({ page, groups, target, select, date }); check(errors.length === 0, `${name}: no runtime errors`);
      } finally { await context.close(); context = null; }
    };
    for (const name of ['website', 'date', 'popup-website', 'modal-dark']) await run(name, async ({ page, groups, select }) => {
      await select.check(); await confirm(page); await verifyScroll(page, name);
      check(await page.evaluate(() => window.__deleted.length) === 3 && await groups.count() === 3, `${name}: only selected group removed`);
    }, { date: name === 'date' });
    await run('mixed', async ({ page, groups, select }) => {
      await select.check(); await groups.nth(2).locator('.row-select').first().check(); await confirm(page); await verifyScroll(page, 'mixed', 1, true);
      check(await page.evaluate(() => window.__deleted.length) === 4, 'mixed: collapsed and expanded selections share one verified job');
    });
    for (const date of [false, true]) await run(`partial-${date ? 'date' : 'website'}`, async ({ page, target, date }) => {
      const toggle = target.locator(date ? ':scope > .date-header .date-toggle' : '.group-toggle').first(); await toggle.click();
      if (date) { const site = target.locator('.group-toggle').first(); if (await site.getAttribute('aria-expanded') === 'false') await site.click(); }
      await target.locator('.row-select').first().check(); await toggle.click(); await confirm(page); await page.locator('.batch-removal-wind').waitFor({ state: 'attached' });
      check(await page.locator('.batch-removal-wind').getAttribute('data-scrolls') === '1', 'partial single-URL selection uses collapsed count-label scroll');
      check(await target.locator(date ? ':scope > .date-header' : ':scope > .group-header').evaluate(node => node.style.visibility !== 'hidden' && node.querySelector('.group-selected').style.visibility === 'hidden'), 'partial cleanup keeps the title visible');
      await done(page); check(await target.count() === 1 && await page.evaluate(() => window.__deleted.length) === 1, 'partial cleanup retains the group and its other URLs');
    }, { date });
    const one = items.filter(item => !item.url.startsWith('https://target.')).concat([{ ...items.find(item => item.url.startsWith('https://target.')) }]);
    await run('single-url-group', async ({ page, groups, select }) => {
      await select.check(); await confirm(page); await verifyScroll(page, 'single-url-group');
      check(await groups.count() === 3 && await page.evaluate(() => window.__deleted.length) === 1, 'single-URL collapsed group uses header scroll without altering visible single-row deletion');
    }, { records: one });
    for (const name of ['cancel', 'partial-failure', 'reduced', 'snapshot-failed', 'resize', 'overlap-motion']) await run(name, async ({ page, select }) => {
      await select.check();
      if (name === 'cancel') { await page.locator('#delete').click(); await page.locator('#confirmDialog [value=cancel]').click(); check(await page.evaluate(() => window.__deleted.length) === 0, 'cancel: no data removed'); }
      else {
        if (name === 'partial-failure') await page.evaluate(url => { window.__failDelete = url; }, items.find(item => item.url.startsWith('https://target.')).url);
        if (name === 'snapshot-failed') await page.evaluate(() => { Image.prototype.decode = async () => { throw new Error('Synthetic failure'); }; });
        await confirm(page);
        if (name === 'resize' || name === 'overlap-motion') {
          await page.locator('.batch-removal-wind').waitFor({ state: 'attached' });
          if (name === 'resize') await page.setViewportSize({ width: 1200, height: 820 });
          else { await page.waitForFunction(() => [...document.querySelectorAll('.group-header')].some(node => node.getAnimations().some(animation => animation.id === 'batch-removal-reflow'))); await page.emulateMedia({ reducedMotion: 'reduce' }); }
        }
        await done(page, name === 'partial-failure' ? 'partial' : 'done');
      }
      if (!['resize', 'overlap-motion'].includes(name)) check(await page.evaluate(() => window.__scrollStarts) === 0, `${name}: unsupported scroll never starts`);
      check(await page.locator('.batch-removal-wind').count() === 0, `${name}: resources cleaned up`);
    }, { reduced: name === 'reduced' });
  }
  console.log(JSON.stringify({ result: 'PASS', checks, output, syntheticHistoryOnly: true }, null, 2));
} finally { await context?.close(); await browser?.close(); await new Promise(resolve => server.close(resolve)); }
