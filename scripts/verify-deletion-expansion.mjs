import assert from 'node:assert/strict';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const { chromium } = dependency('playwright');
const server = createServer();
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const records = [['a', 'b', 'c', 'd'], ['e', 'f'], ['g']].flatMap((hosts, offset) => {
  const day = new Date(); day.setDate(day.getDate() - offset); day.setHours(0, 0, 0, 0);
  return hosts.map((host, index) => ({
    url: `https://${host}.test/expansion/1`, title: `Synthetic ${host}`,
    lastVisitTime: day.getTime() + (hosts.length - index) * 1000, visitCount: 1,
  }));
});
let browser;
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };

try {
  browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
  for (const layout of ['manager', 'popup']) {
    const run = async (name, exercise, items = records) => {
      const context = await browser.newContext({ reducedMotion: 'reduce', viewport: layout === 'popup' ? { width: 440, height: 690 } : { width: 1280, height: 820 } });
      try {
        const page = await context.newPage();
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await installMock(page, items);
        await page.goto(`${origin}/extension/${layout}.html`);
        await page.locator('#query').fill('/expansion/');
        await page.locator('#mode').selectOption('contains');
        await page.locator('#search').click();
        await page.waitForFunction(() => !document.querySelector('#search').disabled);
        await page.locator('#groupByDate').click();
        const group = host => page.locator(`.website-group[data-hostname="${host}.test"]`);
        const open = locator => locator.getAttribute('aria-expanded').then(value => value === 'true');
        const remove = async (start = () => page.locator('#delete').click(), phase = 'done') => {
          const jobs = await page.evaluate(() => window.__messages.filter(message => message.type === 'start-delete').length);
          await start();
          await page.locator('#confirmDialog [value=confirm]').click();
          await page.waitForFunction(previous => window.__messages.filter(message => message.type === 'start-delete').length > previous, jobs);
          await page.waitForFunction(expected => document.querySelector('#status').dataset.kind === expected && !document.querySelector('#search').disabled, phase);
        };
        await exercise({ page, group, open, remove });
        check(errors.length === 0, `${layout}/${name}: no runtime errors`);
      } finally { await context.close(); }
    };

    await run('consecutive websites', async ({ page, group, open, remove }) => {
      await group('b').locator('.group-toggle').click();
      await group('a').locator('.group-select').check();
      await group('b').locator('.group-select').check();
      await remove();
      check(await open(group('c').locator('.group-toggle')), 'next nested website opens after multiple deletions');
      check(!await open(group('d').locator('.group-toggle')), 'later nested website stays collapsed');
      check(!await open(page.locator('.date-toggle').nth(1)), 'unrelated date stays collapsed');
    });

    await run('open website successor', async ({ group, open, remove }) => {
      await group('b').locator('.group-toggle').click();
      await group('d').locator('.group-toggle').click();
      await group('a').locator('.group-select').check();
      await remove();
      check(await open(group('b').locator('.group-toggle')), 'open successor stays open');
      check(!await open(group('c').locator('.group-toggle')), 'closed unrelated website stays closed');
      check(await open(group('d').locator('.group-toggle')), 'open unrelated website stays open');
    });

    await run('single last row', async ({ page, group, open, remove }) => {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await group('a').locator('.history-row').hover();
      await remove(() => group('a').locator('.row-delete').click());
      check(await open(group('b').locator('.group-toggle')), 'deleting final website row opens its successor');
    });

    await run('date successor', async ({ page, group, open, remove }) => {
      await page.locator('.date-select').first().check();
      await remove();
      check(await open(page.locator('.date-toggle').first()), 'next date opens after date deletion');
      check(await open(group('e').locator('.group-toggle')), 'newly opened date exposes its first website');
      check(!await open(group('f').locator('.group-toggle')), 'later website stays collapsed in new date');
      check(!await open(page.locator('.date-toggle').nth(1)), 'later date stays collapsed');
    });

    await run('consecutive dates', async ({ page, group, open, remove }) => {
      await page.locator('.date-select').nth(0).check();
      await page.locator('.date-select').nth(1).check();
      await remove();
      check(await open(page.locator('.date-toggle').first()) && await open(group('g').locator('.group-toggle')), 'multiple date deletions open the next surviving date and its first website');
    });

    await run('open date successor', async ({ page, group, open, remove }) => {
      await page.locator('.date-toggle').nth(1).click();
      await group('f').locator('.group-toggle').click();
      await page.locator('.date-select').first().check();
      await remove();
      check(await open(page.locator('.date-toggle').first()), 'already open date stays open');
      check(!await open(group('e').locator('.group-toggle')), 'already open date preserves first website collapse');
      check(await open(group('f').locator('.group-toggle')), 'already open date preserves later website expansion');
    });

    await run('single last date row', async ({ page, group, open, remove }) => {
      await group('a').locator('.history-row').hover();
      await remove(() => group('a').locator('.row-delete').click());
      check(await open(page.locator('.date-toggle').first()) && await open(group('e').locator('.group-toggle')), 'final row deletion opens next date and its first website');
    }, records.filter(item => !['b', 'c', 'd'].includes(new URL(item.url).hostname.split('.')[0])));

    await run('partial website', async ({ group, open, remove }) => {
      await group('a').locator('.history-row').first().hover();
      await remove(() => group('a').locator('.row-delete').first().click());
      check(await group('a').count() === 1, 'partially deleted website remains');
      check(!await open(group('b').locator('.group-toggle')), 'partial website deletion does not open next website');
    }, [...records, { ...records[0], url: 'https://a.test/expansion/2' }]);

    await run('flat nonadjacent websites', async ({ page, group, open, remove }) => {
      await page.locator('#groupBySite').click();
      await group('a').locator('.group-select').check();
      await group('c').locator('.group-select').check();
      await remove();
      check(await open(group('b').locator('.group-toggle')) && await open(group('d').locator('.group-toggle')), 'each nonadjacent removal opens its next website in flat view');
      check(!await open(group('e').locator('.group-toggle')), 'other flat websites stay collapsed');
    });

    await run('failed deletion', async ({ page, group, open, remove }) => {
      await page.evaluate(url => { window.__failDelete = url; }, records[0].url);
      await group('a').locator('.group-select').check();
      await remove(undefined, 'partial');
      check(await group('a').count() === 1 && !await open(group('b').locator('.group-toggle')), 'failed deletion keeps group and does not open successor');
    });

    await run('last date and empty results', async ({ page, open, remove }) => {
      await page.locator('.date-select').last().check();
      await remove();
      check(!await open(page.locator('.date-toggle').nth(1)), 'last date deletion does not open preceding date');
      await page.locator('#selectAll').click();
      await remove();
      check(await page.locator('.date-group').count() === 0 && await page.locator('#empty').isVisible(), 'deleting all remaining groups leaves empty results');
    });
  }
  console.log(`${checks} deletion-expansion assertions passed. Synthetic history only.`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
