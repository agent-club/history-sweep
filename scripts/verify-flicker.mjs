import assert from 'node:assert/strict';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
const records = Array.from({ length: 32 }, (_, index) => ({ url: `https://site-${index % 3}.example.test/page-${index}`, title: `Synthetic page ${index}`, lastVisitTime: Date.now() - index * 3600000, visitCount: index % 4 + 1 })).concat({ url: 'https://archive.example.test/older', title: 'Older synthetic entry', lastVisitTime: new Date().setFullYear(new Date().getFullYear() - 1), visitCount: 1 });
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const ready = page => page.waitForFunction(() => !document.getElementById('startup') && document.getElementById('status').dataset.kind === 'scanned' && !document.getElementById('search').disabled);

async function armRefresh(page, eventName = 'focus') {
  await page.evaluate(eventName => {
    window.pauseNextRead = true; window.refreshStarted = false;
    window.beforeGroup = document.querySelector('.date-group, .website-group, #rows .history-row');
    window.beforeScroll = document.getElementById('resultScroll').scrollTop;
    window.disabledDuringRefresh = [];
    window.refreshObserver?.disconnect();
    window.refreshObserver = new MutationObserver(changes => {
      for (const { target } of changes) if (target.matches('#query, #search, #language button, .group-view') && target.disabled) window.disabledDuringRefresh.push(target.id || target.dataset.language);
    });
    window.refreshObserver.observe(document.getElementById('app'), { subtree: true, attributes: true, attributeFilter: ['disabled'] });
    (eventName === 'visibilitychange' ? document : window).dispatchEvent(new Event(eventName));
  }, eventName);
  await page.waitForFunction(() => window.refreshStarted);
}

async function releaseRefresh(page) {
  await page.evaluate(() => window.releaseRead());
  await page.waitForFunction(() => window.readFinished);
  await page.waitForTimeout(80);
}

try {
  for (const layout of ['popup', 'manager', 'modal']) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ colorScheme: theme, reducedMotion: theme === 'dark' ? 'reduce' : 'no-preference', viewport: layout === 'popup' ? { width: 440, height: 590 } : { width: 1120, height: 800 } });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await installMock(page, records);
    if (layout === 'modal') await page.route('**/extension/manager.html', async route => {
      const response = await route.fetch(); await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
    });
    await page.goto(`${origin}/extension/${layout === 'popup' ? 'popup' : 'manager'}.html`); await ready(page);
    await page.evaluate(() => {
      const search = chrome.history.search;
      chrome.history.search = async options => {
        const result = await search(options);
        if (!window.pauseNextRead) return result;
        window.pauseNextRead = false; window.readFinished = false; window.refreshStarted = true;
        await new Promise(resolve => { window.releaseRead = resolve; });
        window.readFinished = true;
        if (window.failPausedRead) { window.failPausedRead = false; throw new Error('synthetic refresh failure'); }
        return window.refreshResult || result;
      };
    });
    const label = `${layout}/${theme}`;
    check(await page.evaluate(() => document.activeElement.id !== 'query'), `${label}: initial workspace does not focus query`);
    for (const lang of ['zh-CN', 'en', 'zh-CN', 'en']) {
      await page.evaluate(() => {
        window.languageTransitions = []; window.languageFrames = [];
        document.addEventListener('transitionrun', event => { if (event.target.matches('#language button, .group-view')) window.languageTransitions.push(event.target); }, { signal: (window.languageEvents ||= new AbortController()).signal });
        document.addEventListener('click', function sample(event) {
          if (!event.target.closest('[data-language]')) return;
          document.removeEventListener('click', sample, true);
          let frames = 0;
          const frame = () => {
            window.languageFrames.push({
              disabled: document.getElementById('search').disabled,
              missingIcons: [...document.querySelectorAll('.topbar img, #search img')].filter(node => !node.complete || !node.naturalWidth).map(node => node.getAttribute('src')),
            });
            if (++frames < 4) requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        }, true);
      });
      await page.locator(`[data-language="${lang}"]`).click();
      await page.waitForFunction(() => window.languageFrames.length === 4);
      check(await page.evaluate(lang => document.documentElement.lang === lang && document.querySelector(`[data-language="${lang}"]`).getAttribute('aria-pressed') === 'true', lang), `${label}: language changes immediately`);
      check(await page.evaluate(() => window.languageFrames.every(frame => !frame.disabled && frame.missingIcons.length === 0)), `${label}: first language frames have enabled controls and decoded icons`);
      check(await page.evaluate(() => window.languageTransitions.every(node => !node.isConnected)), `${label}: remounted controls do not animate from defaults`);
      await page.evaluate(() => { window.languageEvents.abort(); window.languageEvents = null; });
    }
    await page.evaluate(() => {
      for (const lang of ['zh-CN', 'en', 'zh-CN', 'en']) document.querySelector(`[data-language="${lang}"]`).click();
    });
    await page.waitForFunction(() => !document.getElementById('app').hasAttribute('data-mounting'));
    check(await page.locator('html').getAttribute('lang') === 'en' && await page.locator('[data-language=en]').getAttribute('aria-pressed') === 'true', `${label}: rapid language changes settle on the final selection`);
    await page.locator('#selectAll').click();
    await page.locator('#query').fill('unsubmitted draft');
    for (const lang of ['zh-CN', 'en']) {
      await page.locator(`[data-language="${lang}"]`).click();
      check(await page.locator('#query').inputValue() === 'unsubmitted draft' && await page.locator('#selectAll').getAttribute('aria-pressed') === 'true', `${label}: language changes preserve draft and selected results`);
    }
    await page.locator('#query').fill(''); await page.locator('#selectAll').click();
    for (const grouping of ['groupByDate', 'groupBySite', 'groupByFrequency']) {
      await page.locator(`#${grouping}`).click(); await ready(page);
      await page.locator('#resultScroll').evaluate(node => { node.scrollTop = 100; });
      await armRefresh(page, grouping === 'groupBySite' ? 'visibilitychange' : 'focus');
      check(await page.locator('#query').isEnabled() && await page.locator('#language button').first().isEnabled(), `${label}/${grouping}: slow automatic refresh keeps controls enabled`);
      await releaseRefresh(page);
      check(await page.evaluate(() => window.disabledDuringRefresh.length === 0), `${label}/${grouping}: focus refresh never disables controls`);
      check(await page.evaluate(() => window.beforeGroup === document.querySelector('.date-group, .website-group, #rows .history-row') && window.beforeScroll === document.getElementById('resultScroll').scrollTop), `${label}/${grouping}: unchanged data keeps rows and scroll position`);
    }
    await page.locator('#groupBySite').click(); await ready(page);
    await armRefresh(page);
    await page.locator('#query').fill('draft-in-progress');
    await page.locator('#query').evaluate(node => { window.draftInput = node; });
    await releaseRefresh(page);
    check(await page.evaluate(() => document.activeElement === window.draftInput && window.draftInput.value === 'draft-in-progress' && window.beforeGroup === document.querySelector('.website-group')), `${label}: pending refresh preserves a newly edited query and focus`);
    await page.locator('#query').fill('');
    await ready(page); await page.waitForTimeout(350);
    await armRefresh(page);
    await page.locator('#query').fill('page-1'); await page.locator('#query').press('Enter'); await ready(page);
    const queryCount = await page.locator('#count').textContent();
    await releaseRefresh(page);
    check(await page.locator('#query').inputValue() === 'page-1' && await page.locator('#count').textContent() === queryCount, `${label}: older refresh cannot overwrite a newer search`);
    await page.locator('#query').fill(''); await page.locator('#query').press('Enter'); await ready(page);
    await armRefresh(page);
    await page.locator('#selectAll').click();
    await releaseRefresh(page);
    check(await page.locator('#selectAll').getAttribute('aria-pressed') === 'true', `${label}: selection made during refresh stays selected`);
    await page.locator('#selectAll').click(); await page.waitForTimeout(350);
    await armRefresh(page);
    await page.locator('#openPreferences').click();
    await releaseRefresh(page);
    check(await page.evaluate(() => window.beforeGroup === document.querySelector('.website-group')), `${label}: opening preferences during a refresh defers result changes`);
    await page.locator('#closePreferences').click(); await page.waitForTimeout(350);
    await armRefresh(page);
    await page.evaluate(() => { window.failPausedRead = true; });
    await releaseRefresh(page);
    check(await page.locator('#status').getAttribute('data-kind') === 'scanFailed' && await page.locator('#query').isEnabled(), `${label}: background read failure remains visible without disabling input`);
    check(await page.evaluate(() => window.beforeGroup === document.querySelector('.website-group')), `${label}: failed automatic read retains existing rows`);
    await armRefresh(page); await releaseRefresh(page); await ready(page);
    await page.locator('#toggleActivity').click();
    await page.waitForFunction(() => document.getElementById('activityPanel').getAttribute('aria-busy') === 'false');
    await page.evaluate(() => { window.beforeDay = document.querySelector('.activity-day[aria-pressed=true]'); });
    await armRefresh(page);
    check(await page.locator('#activityPreviousYear').isEnabled(), `${label}: cached activity refresh leaves year navigation enabled`);
    await releaseRefresh(page);
    await page.waitForFunction(() => document.getElementById('activityPanel').getAttribute('aria-busy') === 'false');
    check(await page.evaluate(() => window.beforeDay === document.querySelector('.activity-day[aria-pressed=true]')), `${label}: unchanged activity refresh retains selected calendar cell`);
    await page.locator('#toggleActivity').click();
    await page.waitForFunction(() => document.getElementById('activityPanel').hidden);
    await page.locator('#toggleActivity').click();
    check(await page.evaluate(() => window.beforeDay === document.querySelector('.activity-day[aria-pressed=true]')), `${label}: collapse and reopen retain the cached calendar`);
    await page.locator('#toggleActivity').click();
    await page.waitForFunction(() => document.getElementById('activityPanel').hidden);
    for (const toggle of ['themeToggle', 'filterToggle']) {
      await page.locator(`#${toggle}`).click(); await page.keyboard.press('Escape');
      check(await page.locator('#query').isEnabled() && await page.locator('#language button').first().isEnabled(), `${label}: closing ${toggle} leaves main controls stable`);
    }
    await armRefresh(page);
    await page.evaluate(() => { window.refreshResult = [{ url: 'https://new.example.test/added', title: 'New synthetic entry', lastVisitTime: Date.now(), visitCount: 1 }]; });
    await releaseRefresh(page);
    check(await page.locator('.group-header').textContent().then(text => text.includes('new.example.test')), `${label}: changed history still reaches the visible result list`);
    check(await page.evaluate(() => window.disabledDuringRefresh.length === 0), `${label}: applying changed history does not flash disabled buttons`);
    check(errors.length === 0, `${label}: no runtime errors: ${errors.join(', ')}`);
    check(await page.evaluate(() => window.__deleted.length === 0), `${label}: stability checks never delete history`);
    await context.close();
  }
  console.log(`${checks} flicker assertions passed: first language switches, focus restoration, three grouping modes, slow refresh, unchanged/changed data, drafts, selection and overlapping search. Synthetic history only.`);
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
