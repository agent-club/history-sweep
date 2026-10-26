import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const day = Date.parse('2026-10-22T00:00:00+08:00');
const weekStart = day - 6 * 86400000;
const visit = (visitTime, index) => ({ visitTime, visitId: String(index) });
const record = (url, title, times) => ({ url, title, lastVisitTime: Math.max(...times), visitCount: 999, visits: times.map(visit) });
const records = [
  record('https://docs.example.org/guide', 'Guide', [weekStart - 1, weekStart, day + 1, day + 2, day + 3, day + 86400000]),
  record('https://notes.example/entry', 'Notes', [day + 1, day + 2, day + 3]),
  record('https://reading.example/list', 'Reading', [day + 1, day + 2, day + 4]),
  record('https://old.example/page', 'Older', [weekStart - 1]),
  record('https://docs.example.org/end', 'End boundary', [day + 86400000 - .25]),
];
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const output = process.env.HISTORY_SWEEP_FREQUENCY_OUTPUT || await mkdtemp(join(tmpdir(), 'history-sweep-frequency-ui-'));
const browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
const errors = [];
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const idle = page => page.waitForFunction(() => !document.querySelector('#search')?.disabled && document.querySelector('#status').dataset.kind !== 'rulesLoading');
const scan = async page => { await page.locator('#query').press('Enter'); await idle(page); };
// Measure the rendered custom list itself, including its clipped scroll viewport.
const pickerBounds = (page, id) => page.locator(`#${id}Toggle`).evaluate(trigger => {
  const rect = trigger.getBoundingClientRect();
  const menu = document.getElementById(trigger.getAttribute('aria-controls'));
  const box = menu.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, menuTop: box.top, menuBottom: box.bottom, hits: menu.clientHeight, height: innerHeight, open: trigger.getAttribute('aria-expanded') === 'true' };
});

const range = async (page, value) => {
  await page.locator('#filterToggle').click(); await page.locator(`.time-range-radio[value="${value}"]`).check();
  if (value !== 'custom') { await idle(page); check(!await page.locator('#filters').evaluate(node => node.open), 'preset applies and closes without confirmation'); }
};

try {
  for (const layout of ['manager', 'popup', 'embedded']) for (const language of ['en', 'zh-CN']) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: layout === 'popup' ? { width: 440, height: 600 } : { width: 1200, height: 900 }, timezoneId: 'Asia/Shanghai', colorScheme: theme, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      // A fixed Date preserves real timers used by scan/deletion completion.
      await page.clock.setFixedTime(new Date(day + 12 * 3600000));
      await installMock(page, records);
      await page.addInitScript(({ language, theme, embedded }) => {
        localStorage.setItem('language', language);
        localStorage.setItem('theme', theme);
      }, { language, theme, embedded: layout === 'embedded' });
      if (layout === 'embedded') await page.route('**/extension/manager.html', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace('<body', '<body data-presentation="modal"') });
      });
      await page.goto(`${origin}/extension/${layout === 'popup' ? 'popup' : 'manager'}.html`);
      if (language === 'zh-CN') { await idle(page); await page.locator('[data-language="zh-CN"]').click(); }
      await idle(page);
      check(await page.locator('#groupBySite').getAttribute('aria-pressed') === 'true', 'first use defaults to websites');
      check(await page.locator('#timeRange').inputValue() === '7days', 'first use defaults to a week');
      if (language === 'zh-CN') check(await page.locator('#filterSummary').textContent() === '近一个星期', 'exact Chinese label');
      const expectedDateSite = 2; // URL latest times govern the two existing views.
      check((await page.locator('#count').textContent()).startsWith(String(expectedDateSite)), 'website membership keeps existing latest-visit semantics');
      await page.locator('#groupByFrequency').click(); await idle(page);
      const urls = await page.locator('#rows .row-select').evaluateAll(nodes => nodes.map(node => node.dataset.url));
      assert.deepEqual(urls, [records[0].url, records[2].url, records[1].url, records[4].url]); checks++;
      assert.deepEqual(await page.locator('#rows .visit-column').allTextContents(), ['4', '3', '3', '1']); checks++;
      check(await page.locator('#rows .visit-column').first().isVisible(), 'frequency count visible on every surface');
      check(await page.locator('#expandGroups').isHidden(), 'flat frequency list has no group-expansion action');
      await page.locator('#rows .row-select').first().check();
      await page.locator('#groupByDate').click(); await idle(page);
      check(await page.locator('#timeRange').inputValue() === '7days', 'view switch preserves current range');
      check((await page.locator('#selected').textContent()).startsWith('0'), 'a URL absent from the destination view is no longer selected');
      check(await page.evaluate(() => window.__deleted.length) === 0, 'view switches never delete');
      await page.locator('#groupByFrequency').click(); await idle(page);
      await page.screenshot({ path: join(output, `${layout}-${language}-${theme}.png`) });
      await page.locator('#filterToggle').click();
      await page.screenshot({ path: join(output, `${layout}-${language}-${theme}-range.png`) });
      const menuBounds = await page.locator('.filters-body').evaluate(node => { const rect = node.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: innerWidth, height: innerHeight }; });
      check(menuBounds.top >= 0 && menuBounds.bottom <= menuBounds.height && menuBounds.left >= 0 && menuBounds.right <= menuBounds.width, `${layout}/${language}/${theme}: time menu fits ${JSON.stringify(menuBounds)}`);
      const menuHit = await page.locator('.filters-body').evaluate(node => {
        const rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + 24, rect.bottom - 24);
        return { inside: node.contains(hit), covering: hit?.outerHTML.slice(0, 240) };
      });
      check(menuHit.inside, `${layout}/${language}/${theme}: time menu lower edge is not clipped or covered: ${JSON.stringify(menuHit)}`);
      check(await page.locator('.time-range-radio').count() === 6, 'all six time choices are available');
      check(await page.locator('.results-browse-controls #filters').count() === 1 && await page.locator('.results-overview #filters').count() === 0, 'time and view controls share their own group outside result metadata');
      if (layout === 'manager' && language === 'en' && theme === 'light') {
        await page.locator('.time-range-radio[value="7days"]').focus();
        await page.locator('.time-range-radio[value="7days"]').press('ArrowDown');
        await idle(page);
        check(await page.locator('#timeRange').inputValue() === '30days' && !await page.locator('#filters').evaluate(node => node.open), 'radio arrow key applies the range and closes');
        await page.locator('#filterToggle').click();
        await page.locator('.time-range-radio[value="30days"]').press('Escape');
        check(await page.locator('#filterToggle').evaluate(node => node === document.activeElement) && !await page.locator('#filters').evaluate(node => node.open), 'Escape closes the time panel and returns focus');
        await range(page, '7days');
        await page.locator('#filterToggle').click();
      }

      await page.locator('#filterToggle').click();
      check(await page.locator('#preferencesDialog #defaultView').count() === 1 && await page.locator('#preferencesDialog #defaultRange').count() === 1 && await page.locator('#browsingDefaultsDialog').count() === 0, 'default view and time are directly in settings with no second dialog');
      await page.locator('#openPreferences').click();
      await page.waitForFunction(() => !document.querySelector('#launchChoices').disabled);
      await page.screenshot({ path: join(output, `${layout}-${language}-${theme}-settings.png`) });
      for (const id of ['defaultView', 'defaultRange']) {
        await page.locator(`#${id}Toggle`).click();
        const bounds = await pickerBounds(page, id);
        check(bounds.open && bounds.hits > 30, `${id}: visible custom picker opens`);
        const alignment = await page.locator(`#${id}Toggle`).evaluate(trigger => {
          const box = trigger.getBoundingClientRect(); const value = trigger.querySelector('.settings-select-value').getBoundingClientRect(); const arrow = trigger.querySelector('.ui-icon').getBoundingClientRect();
          return Math.max(Math.abs(value.top + value.height / 2 - box.top - box.height / 2), Math.abs(arrow.top + arrow.height / 2 - box.top - box.height / 2));
        });
        check(alignment <= .5, `${id}: text and arrow share the vertical center`);

        check(bounds.menuBottom <= bounds.top - 6 || bounds.menuTop >= bounds.bottom + 6, `${id}: menu stays entirely above or below the input ${JSON.stringify(bounds)}`);
        await page.screenshot({ path: join(output, `${layout}-${language}-${theme}-${id}-picker.png`) });
        await page.locator(`#${id}Toggle`).press('Escape');
        check(await page.locator('#preferencesDialog').evaluate(node => node.open) && await page.locator(`#${id}Toggle`).getAttribute('aria-expanded') === 'false', 'Escape closes the picker before the drawer');
      }
      if (layout === 'manager' && language === 'en' && theme === 'light') {
        await page.locator('#defaultViewToggle').click(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
        check(await page.locator('#defaultView').inputValue() === 'frequency', 'arrow and Enter select an option in the custom picker');
        await page.locator('#defaultViewToggle').click(); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
        check(await page.locator('#defaultView').inputValue() === 'date', 'Home selects the first custom option');
        await page.locator('#defaultViewToggle').click(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
        check(await page.locator('#defaultView').inputValue() === 'frequency', 'End selects the last custom option');
        await page.locator('#defaultViewToggle').click(); await page.keyboard.press('b'); await page.keyboard.press('Enter');
        check(await page.locator('#defaultView').inputValue() === 'date', 'typing jumps to the next matching option');
        await page.locator('#defaultViewToggle').click(); await page.keyboard.press('Tab');
        check(await page.locator('#defaultViewToggle').getAttribute('aria-expanded') === 'false' && await page.locator('#defaultRangeToggle').evaluate(node => node === document.activeElement), 'Tab closes the menu and moves to the next control');
        await page.locator('#defaultView').selectOption('website');
      }

      const drawer = await page.locator('#preferencesDialog').evaluate(node => {
        const box = node.getBoundingClientRect(); const content = node.querySelector('.preferences-content');
        const header = node.querySelector('.settings-window-header').getBoundingClientRect(); const footer = node.querySelector('.preferences-actions').getBoundingClientRect();
        content.scrollTop = content.scrollHeight;
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, viewportWidth: innerWidth, viewportHeight: innerHeight, headerTop: header.top, footerBottom: footer.bottom, headerAfter: node.querySelector('.settings-window-header').getBoundingClientRect().top, footerAfter: node.querySelector('.preferences-actions').getBoundingClientRect().bottom, scrollTop: content.scrollTop };
      });
      check(drawer.left >= 0 && drawer.right <= drawer.viewportWidth && drawer.top >= 0 && drawer.bottom <= drawer.viewportHeight, 'settings window stays within the viewport');
      check(Math.abs(drawer.width - (layout === 'manager' ? Math.min(1080, drawer.viewportWidth - 48) : drawer.viewportWidth)) < 1, 'manager settings are centered; popup and embedded settings fill their container');
      check(drawer.headerTop === drawer.headerAfter && drawer.footerBottom === drawer.footerAfter, 'content scroll keeps title and save actions fixed');
      await page.locator('.preferences-content').evaluate(node => { node.scrollTop = 0; });


      check(await page.locator('#defaultView').inputValue() === 'website', 'dialog describes saved default, not current frequency view');
      check(await page.locator('#defaultRange option[value=custom]').count() === 0, 'custom dates cannot become a fixed-date default');
      await page.locator('#defaultView').selectOption('date'); await page.locator('#defaultRange').selectOption('30days');
      await page.screenshot({ path: join(output, `${layout}-${language}-${theme}-defaults.png`) });
      await page.locator('#savePreferences').click();
      await page.waitForFunction(() => !document.querySelector('#preferencesDialog').open);
      check(await page.locator('#groupByFrequency').getAttribute('aria-pressed') === 'true' && await page.locator('#timeRange').inputValue() === '7days', 'saving defaults leaves current view and range untouched');
      check(await page.locator('#openPreferences').evaluate(node => node === document.activeElement), 'saving closes settings and restores gear focus');
      await page.reload(); await idle(page);
      check(await page.locator('#groupByDate').getAttribute('aria-pressed') === 'true' && await page.locator('#timeRange').inputValue() === '30days', 'saved defaults apply after reopening');
      await page.locator('#query').fill('docs.example.org'); await scan(page);
      check(await page.locator('#timeRange').inputValue() === 'all', 'keyword search keeps its all-time default');
      await range(page, '7days');
      await page.locator('#groupByFrequency').click(); await idle(page);
      check(await page.locator('#query').inputValue() === 'docs.example.org' && await page.locator('#timeRange').inputValue() === '7days', 'keyword and explicit range survive view switch');
      check(await page.locator('#rows .history-row').count() === 2, 'query narrows frequency candidates');
      await page.locator('#rows .row-select').first().check();
      await page.locator('#delete').click();
      check(await page.locator('#previewTimeWarning').isVisible(), 'confirmation warns about deleting visits outside the range');
      await page.locator('#confirmDialog [value=cancel]').click();
      check(await page.evaluate(() => window.__deleted.length) === 0, 'cancel keeps every visit');
      await page.locator('#delete').click(); await page.locator('#confirmDialog [value=confirm]').click();
      await page.waitForFunction(() => document.querySelector('#status').dataset.kind === 'done');
      assert.deepEqual(await page.evaluate(() => window.__deleted), [records[0].url]); checks++;
      check(await page.locator('#rows .history-row').count() === 1, 'post-deletion frequency ranking is refreshed');
      await page.evaluate(url => { window.__failVisits = url; }, records[4].url); await scan(page);
      check(await page.locator('#status').getAttribute('data-kind') === 'frequencyFailed', 'visit read failure is explicit');
      check(await page.locator('#rows .history-row').count() === 0 && await page.locator('#delete').isDisabled(), 'read failure does not leave a partial or stale ranking');
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page horizontal overflow');
    } finally { await context.close(); }
  }
  const edgeContext = await browser.newContext({ viewport: { width: 375, height: 812 }, timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' });
  try {
    const edge = await edgeContext.newPage();
    edge.on('pageerror', error => errors.push(error.message));
    await edge.clock.setFixedTime(new Date(day + 12 * 3600000));
    await installMock(edge, records);
    await edge.goto(`${origin}/extension/manager.html`); await idle(edge);
    await edge.locator('#groupByFrequency').click(); await idle(edge);
    await edge.locator('#rows .row-select').first().check();
    await range(edge, 'custom');
    check(await edge.locator('#applyTimeRange').count() === 0, 'time menu has no confirmation button');
    await edge.locator('#startDate').fill('2026-02-30');
    await edge.locator('#endDate').fill('2026-10-16');
    await edge.locator('#endDate').press('Tab');
    check((await edge.locator('#selected').textContent()).startsWith('1') && await edge.locator('#delete').isDisabled(), 'invalid custom dates do not launch a new scan or permit stale deletion');
    await edge.locator('#startDate').fill('2026-10-16'); await edge.locator('#endDate').fill('2026-10-16');
    await edge.locator('#endDate').press('Tab'); await idle(edge);
    check(await edge.locator('#filters').evaluate(node => node.open), 'complete custom dates apply while panel remains open');
    await edge.locator('#startDate').dispatchEvent('change'); await idle(edge);
    assert.deepEqual(await edge.locator('#rows .visit-column').allTextContents(), ['1']); checks++;
    check(await edge.locator('#rows .row-select').getAttribute('data-url') === records[0].url, 'custom past date includes a page visited again afterward');
    await edge.locator('#filterToggle').press('Escape');
    await edge.locator('#groupBySite').click(); await idle(edge);
    check(await edge.locator('#timeRange').inputValue() === 'custom' && await edge.locator('#startDate').inputValue() === '2026-10-16', 'custom dates survive view switch');
    check(await edge.locator('#groupByFrequency').isVisible(), 'empty result keeps all peer views available');
    await edge.locator('#groupByFrequency').click(); await idle(edge);
    await edge.locator('#openPreferences').click();
    await edge.waitForFunction(() => !document.querySelector('#launchChoices').disabled);

    await edge.setViewportSize({ width: 375, height: 260 });
    await edge.locator('#defaultRangeToggle').click();
    const shortPicker = await pickerBounds(edge, 'defaultRange');
    check(shortPicker.hits > 30 && shortPicker.menuBottom <= shortPicker.top - 6 && shortPicker.menuTop >= 0, 'short window flips the long menu above the input and clips its own scroll content');
    await edge.screenshot({ path: join(output, 'short-window-picker-above.png') });
    await edge.locator('#defaultRangeOptions').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await edge.locator('#defaultRangeOptions [data-value="30days"]').click();
    check(await edge.locator('#defaultRange').inputValue() === '30days' && await edge.locator('#defaultRangeToggle').getAttribute('aria-expanded') === 'false', 'short-menu scrolling exposes and selects its last option');
    check(await edge.evaluate(() => localStorage.getItem('fixture-browsing-preferences')) === null, 'custom menu selections remain drafts until Save');
    await edge.locator('#defaultRange').selectOption('7days');
    await edge.setViewportSize({ width: 375, height: 812 });
    await edge.locator('#defaultView').selectOption('frequency');
    await edge.evaluate(() => { window.__failBrowsingSave = true; });
    await edge.locator('#savePreferences').click();
    await edge.waitForFunction(() => !document.querySelector('#savePreferences').disabled);
    check(await edge.locator('#preferencesDialog').evaluate(node => node.open), 'failed save keeps defaults dialog open');
    check(await edge.evaluate(() => localStorage.getItem('fixture-browsing-preferences')) === null, 'failed save does not alter saved defaults');
    await edge.locator('#closePreferences').click();
    await edge.locator('#discardPreferences').click();
    check(await edge.locator('#openPreferences').evaluate(node => node === document.activeElement), 'cancel closes settings and restores gear focus');
    await range(edge, '7days');
    await edge.locator('#filterToggle').click(); await edge.locator('#editProtection').click();
    await edge.locator('#protectionInput').fill('docs.example.org'); await edge.locator('#saveProtection').click();
    await edge.waitForFunction(() => !document.querySelector('#protectionDialog').open && !document.querySelector('#search').disabled);
    await scan(edge);
    assert.deepEqual(await edge.locator('#rows .row-select').evaluateAll(nodes => nodes.map(node => node.dataset.url)), [records[2].url, records[1].url]); checks++;
    check((await edge.locator('#protectedCount').textContent()).includes('2'), 'kept rules exclude both matching pages from frequency');
    await edge.locator('#rows .row-select').first().check();
    await edge.evaluate(url => { window.__failVisits = url; }, records[1].url);
    await edge.locator('#delete').click(); await edge.locator('#confirmDialog [value=confirm]').click();
    await edge.waitForFunction(() => document.querySelector('#status').dataset.kind === 'deletionStatusFailed');
    check(await edge.locator('#rows .history-row').count() === 0 && await edge.locator('#delete').isDisabled(), 'failed ranking refresh after verified deletion clears stale counts');
    check(await edge.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '375px layout fits');
  } finally { await edgeContext.close(); }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, matrix: 'manager, popup, embedded presentation × en/zh-CN × light/dark', screenshots: output, pageErrors: errors.length }));
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  // Persist screenshots only when the caller explicitly requests a review folder.
  if (!process.env.HISTORY_SWEEP_FREQUENCY_OUTPUT) await rm(output, { recursive: true, force: true });
}
