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
      if (!localStorage.getItem('fixture-activity-scroll-hint')) localStorage.setItem('fixture-activity-scroll-hint', JSON.stringify({ installedAt: Date.now(), lastShownOn: null }));
      window.__hintEvents = [];
      new MutationObserver(changes => changes.forEach(change => {
        if (change.target.id === 'activityScrollHint' && change.attributeName === 'hidden') window.__hintEvents.push({ visible: !change.target.hidden, time: performance.now() });
      })).observe(document, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
    }, scenario);
    await page.goto(`http://127.0.0.1:${server.address().port}/extension/${scenario.name.startsWith('popup') ? 'popup' : 'manager'}.html`);
    await page.waitForFunction(() => document.querySelector('#search') && !document.querySelector('#search').disabled);
    const hint = page.locator('#activityScrollHint');
    const installedAt = await page.evaluate(() => JSON.parse(localStorage.getItem('fixture-activity-scroll-hint')).installedAt);
    await page.locator('#toggleActivity').click();
    await hint.waitFor({ state: 'visible' });
    const geometry = await hint.evaluate(node => {
      const box = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      const copy = node.querySelector('.activity-scroll-hint-copy');
      return { hint: box(node), copy: box(copy), mouse: box(node.querySelector('.activity-scroll-hint-mouse')), legend: box(node.nextElementSibling), parent: box(node.parentElement), text: copy.textContent, clipped: copy.scrollWidth > copy.clientWidth + 1, animations: node.getAnimations({ subtree: true }).length, panelHeight: document.querySelector('#activityPanel').getBoundingClientRect().height };
    });
    check(geometry.hint.left >= geometry.parent.left - 1 && geometry.hint.right <= geometry.legend.left - 10, `${scenario.name}: hint stays inside the row and clear of the legend`);
    check(geometry.copy.right <= geometry.mouse.left - 4 && !geometry.clipped, `${scenario.name}: translated text remains readable beside the mouse`);
    check(geometry.text === (scenario.language === 'en' ? 'Scroll up to collapse' : '向上滚动，自动折叠'), `${scenario.name}: hint uses the active language`);
    if (scenario.motion === 'reduce') check(geometry.animations === 0, `${scenario.name}: reduced motion keeps a static cue`);
    if (output) {
      await page.waitForTimeout(250);
      check(await hint.locator('.activity-scroll-hint-body').evaluate(node => Number(getComputedStyle(node).opacity) > .95), `${scenario.name}: screenshot captures the fully visible cue`);
      await page.screenshot({ path: join(output, `${scenario.name}.png`) });
    }
    await hint.waitFor({ state: 'hidden' });
    const lifetime = await page.evaluate(() => { const events = window.__hintEvents; const show = events.find(e => e.visible); const hide = events.find(e => !e.visible && e.time > show.time); return hide.time - show.time; });
    check(lifetime >= 1150 && lifetime < 1600, `${scenario.name}: cue expires after 1.2 seconds (${Math.round(lifetime)} ms)`);
    check(await page.locator('#activityPanel').isVisible(), `${scenario.name}: expiration leaves the analytics panel open`);
    check(Math.abs(await page.locator('#activityPanel').evaluate(node => node.getBoundingClientRect().height) - geometry.panelHeight) < 1, `${scenario.name}: cue appearance and expiration do not shift layout`);
    const reopen = async () => {
      if (await page.locator('#toggleActivity').getAttribute('aria-expanded') === 'true') {
        await page.locator('#toggleActivity').click();
        await page.waitForFunction(() => document.querySelector('#activityPanel').hidden);
      }
      await page.locator('#toggleActivity').click();
    };
    await reopen(); await page.waitForTimeout(450);
    check(await hint.evaluate(node => node.hidden), `${scenario.name}: reopening on the same day does not replay the cue`);
    await page.reload(); await page.waitForTimeout(650);
    check(await hint.evaluate(node => node.hidden), `${scenario.name}: reload preserves today's reminder claim`);
    await page.clock.setFixedTime(new Date(installedAt + 86400000));
    await reopen(); await hint.waitFor({ state: 'visible' });
    check(true, `${scenario.name}: the second local day permits one reminder`);
    if (scenario.name === 'modal') {
      await page.locator('#activityTitle').hover(); await page.mouse.wheel(0, -80);
      await hint.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.querySelector('#activityPanel').hidden);
      check(true, 'modal: upward scrolling immediately cancels the cue and collapses the panel');
      await page.clock.setFixedTime(new Date(installedAt + 2 * 86400000));
      await page.locator('#toggleActivity').click();
      await page.waitForFunction(() => document.querySelector('#toggleActivity').getAttribute('aria-expanded') === 'true');
      await page.locator('#toggleActivity').click();
      await page.waitForFunction(() => document.querySelector('#activityPanel').hidden);
      await page.waitForTimeout(450);
      check(await hint.evaluate(node => node.hidden), 'modal: closing before the entrance cancels the pending cue');
      await page.locator('#toggleActivity').click(); await hint.waitFor({ state: 'visible' });
      check(true, 'modal: closing before the entrance does not consume day three');
      await page.reload(); await page.waitForTimeout(650);
      check(await hint.evaluate(node => node.hidden), 'modal: day three remains once-only after reload');
      await page.clock.setFixedTime(new Date(installedAt + 3 * 86400000));
      await reopen(); await page.waitForTimeout(450);
      check(await hint.evaluate(node => node.hidden), 'modal: day four never shows the hint');
    }
    await context.close();
  }
  check(errors.length === 0, `No runtime errors: ${errors.join('; ')}`);
  console.log(`${checks} analytics hint checks passed across modal, manager, popup, narrow English, dark and reduced-motion views. Synthetic history only.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
