import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {dependency} from './runtime.mjs';
import {createServer} from './serve.mjs';

const {chromium} = dependency('playwright');
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}/site/`;
const chrome = process.env.HISTORY_SWEEP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let browser;
let checks = 0;
const errors = [];
const check = (condition, message) => { assert.ok(condition, message); checks++; };

try {
  browser = await chromium.launch({headless: true, ...(existsSync(chrome) ? {executablePath: chrome} : {})});
  for (const width of [320, 375, 768, 1024, 1440]) {
    for (const language of ['en', 'zh-CN']) {
      const context = await browser.newContext({viewport: {width, height: 1000}, reducedMotion: 'reduce'});
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(lang => localStorage.setItem('language', lang), language);
      check((await page.goto(origin)).status() === 200, `${width} ${language}: site serves`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} ${language}: no horizontal overflow`);
      check(await page.locator('html').getAttribute('lang') === language, `${width} ${language}: locale`);
      check(await page.locator('#opening-video').evaluate(video => video.paused && video.preload === 'none'), `${width} ${language}: reduced motion does not autoplay or preload video`);
      check((await page.locator('#opening-video').getAttribute('poster')).endsWith(`opening-${language === 'en' ? 'en' : 'zh'}.png`), `${width} ${language}: localized poster`);
      check(await page.locator('.film-chapters button').count() === 4, `${width} ${language}: four feature chapters`);
      await page.locator('.manager-frame').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => { const image = document.querySelector('.manager-frame img'); return image.complete && image.naturalWidth === 1280; });
      check(true, `${width} ${language}: current product screenshot loads`);
      const download = await page.locator('a[download]').getAttribute('href');
      check((await page.request.get(new URL(download, origin).href)).status() === 200, `${width} ${language}: download available`);
      await page.goto(new URL('privacy.html', origin).href);
      check(await page.locator('html').getAttribute('lang') === language, `${width} ${language}: privacy remembers locale`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} ${language}: privacy has no horizontal overflow`);
      await context.close();
    }
  }

  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  const range = await page.request.get(new URL('assets/opening-en.mp4', origin).href, {headers: {Range: 'bytes=0-99'}});
  check(range.status() === 206 && (await range.body()).length === 100, 'local video byte ranges support chapter seeking');
  await page.waitForFunction(() => !document.querySelector('#opening-video').paused);
  check(await page.locator('#opening-video').evaluate(video => video.muted && !video.loop && video.duration === 9), 'film is silent, nine seconds, and finite');
  await page.locator('#opening-toggle').click();
  check(await page.locator('#opening-video').evaluate(video => video.paused), 'pause control');
  await page.locator('[data-opening-time="3.6"]').click();
  await page.waitForFunction(() => { const video = document.querySelector('#opening-video'); return !video.paused && video.currentTime >= 3.6 && document.querySelector('[data-opening-time="3.6"]').getAttribute('aria-pressed') === 'true'; });
  check(await page.locator('[data-opening-time="3.6"]').getAttribute('aria-pressed') === 'true', 'chapter navigation seeks and highlights selection');
  const beforeLanguage = await page.locator('#opening-video').evaluate(video => video.currentTime);
  await page.getByRole('button', {name: '简体中文', exact: true}).click();
  await page.waitForFunction(() => { const video = document.querySelector('#opening-video'); return video.currentSrc.endsWith('opening-zh.mp4') && !video.paused && video.currentTime >= 3.6; });
  check(Math.abs(await page.locator('#opening-video').evaluate(video => video.currentTime) - beforeLanguage) < 1, 'language switching preserves position and playback');
  await page.locator('#get').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('#opening-video').paused);
  check(true, 'offscreen playback pauses');
  await page.evaluate(() => window.scrollTo({top: 0, behavior: 'instant'}));
  await page.waitForFunction(() => !document.querySelector('#opening-video').paused);
  check(true, 'returning to the hero resumes playback');
  await page.locator('#opening-toggle').click();
  await page.locator('#get').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo({top: 0, behavior: 'instant'}));
  await page.waitForTimeout(250);
  check(await page.locator('#opening-video').evaluate(video => video.paused), 'explicit pause survives scrolling');
  await page.locator('#opening-toggle').click();
  await page.locator('#opening-video').evaluate(video => { video.currentTime = 8.8; });
  await page.waitForFunction(() => document.querySelector('#opening-video').ended);
  check((await page.locator('#opening-toggle').textContent()).includes('再看一次'), 'ending offers replay');
  await page.getByRole('button', {name: 'English', exact: true}).click();
  await page.waitForFunction(() => { const video = document.querySelector('#opening-video'); return video.currentSrc.endsWith('opening-en.mp4') && video.currentTime > 8.9; });
  check(await page.locator('#opening-video').evaluate(video => video.paused), 'language switching after the end stays on the final shot');
  await page.locator('#opening-toggle').click();
  await page.waitForFunction(() => { const video = document.querySelector('#opening-video'); return !video.paused && video.currentTime < 1; });
  check(true, 'replay restarts the film');
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.waitForFunction(() => document.querySelector('#opening-video').paused);
  check(true, 'enabling reduced motion stops playback');
  await context.close();

  const reduced = await browser.newContext({viewport: {width: 375, height: 812}, reducedMotion: 'reduce'});
  const reducedPage = await reduced.newPage();
  reducedPage.on('pageerror', error => errors.push(error.message));
  await reducedPage.goto(origin);
  await reducedPage.locator('[data-opening-time="5.5"]').click();
  await reducedPage.waitForFunction(() => { const video = document.querySelector('#opening-video'); return video.currentTime >= 5.5 && !video.paused; });
  check(true, 'reduced motion allows explicit chapter playback on mobile');
  await reduced.close();
  check(errors.length === 0, `no runtime errors: ${errors.join('; ')}`);
  console.log(`${checks} website assertions passed. Local static assets only; no browser history accessed.`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
