import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const screenshots = await mkdtemp(join(tmpdir(), 'history-sweep-scroll-'));
const records = Array.from({ length: 300 }, (_, index) => ({
  url: `https://${index % 2 ? 'docs.example.test' : 'news.example.test'}/page-${index}`,
  title: `Synthetic history page ${index}`,
  lastVisitTime: Date.parse('2026-10-17T10:00:00+08:00') - Math.floor(index / 100) * 86400000,
  visitCount: 2,
}));
const errors = [];
let checks = 0, browser;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const ready = page => page.waitForFunction(() => document.querySelector('.date-header') && !document.querySelector('#search').disabled);
async function openActivity(page) {
  await page.locator('#toggleActivity').click();
  await page.waitForFunction(() => !document.querySelector('#activityPanel').hidden && document.querySelector('#activityPanel').getAttribute('aria-busy') === 'false');
}
async function touchMove(page, dx, dy) {
  await page.locator('.app-shell').evaluate((shell, { dx, dy }) => {
    const touch = (x, y) => new Touch({ identifier: 1, target: shell, clientX: x, clientY: y });
    shell.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [touch(120, 240)] }));
    shell.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [touch(120 + dx, 240 + dy)] }));
    shell.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [] }));
  }, { dx, dy });
}
async function stickyGroup(page, selector, headerSelector, label) {
  const first = page.locator(selector).first();
  const header = first.locator(`:scope > ${headerSelector}`);
  await page.locator('#resultScroll').evaluate(node => { node.scrollTop = 0; });
  await first.evaluate(group => {
    const scroll = document.getElementById('resultScroll');
    scroll.scrollTop += group.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 100;
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  let bounds = await header.evaluate(node => ({ top: node.getBoundingClientRect().top, scrollTop: document.getElementById('resultScroll').getBoundingClientRect().top }));
  check(Math.abs(bounds.top - bounds.scrollTop) <= 1, `${label}: heading sticks while records remain`);
  const onTop = await header.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
  });
  check(onTop, `${label}: records and table headings do not cover the sticky heading`);
  await page.screenshot({ path: join(screenshots, `${label}.png`) });
  await first.evaluate((group, headerSelector) => {
    const scroll = document.getElementById('resultScroll');
    const height = group.querySelector(`:scope > ${headerSelector}`).getBoundingClientRect().height;
    scroll.scrollTop += group.getBoundingClientRect().bottom - scroll.getBoundingClientRect().top - height / 2;
  }, headerSelector);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  bounds = await header.evaluate(node => ({ top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom, groupBottom: node.parentElement.getBoundingClientRect().bottom, scrollTop: document.getElementById('resultScroll').getBoundingClientRect().top }));
  check(bounds.top < bounds.scrollTop - 5 && bounds.bottom <= bounds.groupBottom + 1, `${label}: heading is pushed out at its own group boundary`);
  await page.locator(selector).nth(1).evaluate(group => {
    const scroll = document.getElementById('resultScroll');
    scroll.scrollTop += group.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 70;
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  check(await page.locator(selector).nth(1).locator(`:scope > ${headerSelector}`).evaluate(node => Math.abs(node.getBoundingClientRect().top - document.getElementById('resultScroll').getBoundingClientRect().top) <= 1), `${label}: next heading takes over`);
}
async function nestedSticky(page, label) {
  const day = page.locator('.date-group').first();
  await day.locator('.website-group').nth(1).locator('.group-load-more').click();
  const first = day.locator('.website-group').first();
  const header = first.locator(':scope > .group-header');
  async function scrollIntoGroup(group) {
    await group.evaluate(group => {
      const scroll = document.getElementById('resultScroll');
      scroll.scrollTop += group.getBoundingClientRect().top - scroll.getBoundingClientRect().top + 120;
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  async function stacked(siteHeader) {
    return siteHeader.evaluate(node => {
      const date = node.closest('.date-group').querySelector('.date-header').getBoundingClientRect();
      const site = node.getBoundingClientRect();
      return Math.abs(date.top - document.getElementById('resultScroll').getBoundingClientRect().top) <= 1 && Math.abs(site.top - date.bottom) <= 1
        && node.contains(document.elementFromPoint(site.left + site.width / 2, site.top + site.height / 2));
    });
  }
  await scrollIntoGroup(first);
  check(await stacked(header), `${label}: domain sticks directly below its date while records remain`);
  await day.locator(':scope > .date-header').evaluate(node => { node.style.paddingBlock = '9px'; });
  await page.waitForFunction(() => {
    const day = document.querySelector('.date-group'), header = day.querySelector('.date-header');
    return Math.abs(parseFloat(day.style.getPropertyValue('--date-header-height')) - header.getBoundingClientRect().height) <= 1;
  });
  check(await stacked(header), `${label}: nested offset follows date header height changes`);
  await day.locator(':scope > .date-header').evaluate(node => { node.style.paddingBlock = ''; });
  await page.waitForFunction(() => {
    const day = document.querySelector('.date-group');
    return Math.abs(parseFloat(day.style.getPropertyValue('--date-header-height')) - day.querySelector('.date-header').getBoundingClientRect().height) <= 1;
  });
  await first.evaluate(group => {
    const scroll = document.getElementById('resultScroll');
    const date = group.closest('.date-group').querySelector('.date-header').getBoundingClientRect();
    const header = group.querySelector('.group-header').getBoundingClientRect();
    scroll.scrollTop += group.getBoundingClientRect().bottom - date.bottom - header.height / 2;
  });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  check(await header.evaluate(node => node.getBoundingClientRect().top < node.closest('.date-group').querySelector('.date-header').getBoundingClientRect().bottom - 5 && node.getBoundingClientRect().bottom <= node.parentElement.getBoundingClientRect().bottom + 1), `${label}: domain heading leaves when its own records finish`);
  const second = day.locator('.website-group').nth(1);
  await scrollIntoGroup(second);
  check(await stacked(second.locator(':scope > .group-header')), `${label}: next domain takes over below the same date`);
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
  for (const surface of [
    { name: 'manager', file: 'manager', viewport: { width: 1280, height: 850 } },
    { name: 'popup', file: 'popup', viewport: { width: 440, height: 590 } },
    { name: 'modal', file: 'manager', viewport: { width: 960, height: 720 } },
  ]) {
    const context = await browser.newContext({ viewport: surface.viewport, timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.clock.setFixedTime(new Date('2026-10-17T12:00:00+08:00'));
    await installMock(page, records);
    // This scenario exercises nested date headings regardless of browsing defaults.
    await page.addInitScript(() => localStorage.setItem('fixture-browsing-preferences', JSON.stringify({ view: 'date', range: 'all' })));
    if (surface.name === 'modal') await page.route('**/extension/manager.html', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
    });
    await page.goto(`${origin}/extension/${surface.file}.html`); await ready(page);
    await page.locator('.date-select').first().check();
    const selected = await page.locator('#selected').textContent();
    const collapsedHeight = await page.locator('#resultScroll').evaluate(node => node.clientHeight);
    await openActivity(page);
    const activityLayout = await page.evaluate(() => {
      const bounds = selector => document.querySelector(selector).getBoundingClientRect();
      const panel = bounds('.results-panel'), header = bounds('.results-header');
      return {
        headerContained: header.bottom <= panel.bottom + 1,
        listHeight: bounds('#resultScroll').height,
        footerBelowResults: bounds('.actionbar').top >= panel.bottom - 1,
      };
    });
    check(activityLayout.headerContained, `${surface.name}: expanded activity keeps the entire selection header inside its result card`);
    check(activityLayout.listHeight >= 170, `${surface.name}: expanded activity preserves usable history space`);
    if (surface.name !== 'popup') check(activityLayout.footerBelowResults, `${surface.name}: expanded activity does not overlap the footer`);
    await page.locator('#selectAll').evaluate(node => node.scrollIntoView({ block: 'center' }));
    check(await page.locator('#selectAll').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    }), `${surface.name}: select all remains reachable and unobscured with activity open`);
    await page.locator('.app-shell').evaluate(node => { node.scrollTop = 0; });
    await page.locator('.activity-chart-scroll').dispatchEvent('wheel', { deltaX: 80, deltaY: 1 });
    check(await page.locator('#toggleActivity').getAttribute('aria-expanded') === 'true', `${surface.name}: horizontal wheel keeps activity open`);
    await touchMove(page, 80, 1);
    check(await page.locator('#toggleActivity').getAttribute('aria-expanded') === 'true', `${surface.name}: horizontal touch keeps activity open`);
    await touchMove(page, 1, 3);
    check(await page.locator('#toggleActivity').getAttribute('aria-expanded') === 'true', `${surface.name}: touch jitter does not close activity`);
    await page.locator('#activityTitle').hover(); await page.mouse.wheel(0, 80);
    await page.waitForFunction(() => document.querySelector('#toggleActivity').getAttribute('aria-expanded') === 'false');
    const shrinking = await page.locator('#activityPanel').evaluate(node => {
      const animation = node.getAnimations().find(animation => animation.effect.getTiming().duration === 220);
      if (!animation) return false;
      animation.pause(); animation.currentTime = 0;
      const fullHeight = node.getBoundingClientRect().height;
      animation.currentTime = 110;
      const middleHeight = node.getBoundingClientRect().height;
      animation.play();
      return middleHeight > 0 && middleHeight < fullHeight;
    });
    check(shrinking, `${surface.name}: a real vertical wheel animates the panel height down`);
    await page.waitForFunction(() => document.querySelector('#activityPanel').hidden);
    check(await page.locator('.app-shell').evaluate(node => node.scrollTop === 0), `${surface.name}: history workspace returns without outer scroll offset`);
    check(await page.locator('#resultScroll').evaluate((node, height) => node.clientHeight >= height - 1 && node.clientHeight > 0, collapsedHeight), `${surface.name}: history regains its original reading space`);
    check(await page.locator('#selected').textContent() === selected, `${surface.name}: collapse preserves history selection`);
    await page.reload(); await ready(page);
    check(await page.locator('#activityPanel').isHidden(), `${surface.name}: scroll collapse preference survives reload`);
    await openActivity(page);
    await page.locator('.app-shell').evaluate(shell => {
      shell.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -80 }));
      document.getElementById('toggleActivity').click();
    });
    await page.waitForTimeout(260);
    check(await page.locator('#toggleActivity').getAttribute('aria-expanded') === 'true' && await page.locator('#activityPanel').isVisible(), `${surface.name}: reopening interrupts an in-progress collapse`);
    await touchMove(page, 0, -50);
    await page.waitForFunction(() => document.querySelector('#activityPanel').hidden);
    check(await page.locator('#toggleActivity').getAttribute('aria-expanded') === 'false', `${surface.name}: upward touch gesture closes activity`);
    await openActivity(page); await touchMove(page, 0, 50);
    await page.waitForFunction(() => document.querySelector('#activityPanel').hidden);
    check(true, `${surface.name}: downward touch gesture closes activity`);
    await page.emulateMedia({ reducedMotion: 'reduce' }); await openActivity(page);
    await page.locator('.activity-day:not(:disabled)').last().focus();
    const immediate = await page.locator('.app-shell').evaluate(shell => {
      shell.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -40 }));
      return document.getElementById('activityPanel').hidden && document.activeElement.id === 'toggleActivity';
    });
    check(immediate, `${surface.name}: reduced motion closes immediately and restores focus`);
    await page.locator('#expandGroups').click();
    await page.locator('.date-group').first().locator('.group-load-more').first().click();
    await nestedSticky(page, surface.name);
    await stickyGroup(page, '.date-group', '.date-header', `${surface.name}-date`);
    await page.locator('#groupBySite').click();
    if (await page.locator('.group-toggle[aria-expanded=false]').count()) await page.locator('#expandGroups').click();
    await page.locator('#groups > .website-group').first().locator('.group-load-more').click();
    await page.locator('#groups > .website-group').nth(1).locator('.group-load-more').click();
    await stickyGroup(page, '#groups > .website-group', '.group-header', `${surface.name}-website`);
    await context.close();
  }
  check(errors.length === 0, `no runtime errors: ${errors.join('; ')}`);
  console.log(`${checks} scroll-interaction assertions passed across manager, popup and modal presentation. Synthetic history only.`);
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  await rm(screenshots, { recursive: true, force: true });
}
