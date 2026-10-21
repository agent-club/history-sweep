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

// Hold a module dependency too: loading home.mjs alone is insufficient to start the intro.
async function delayIntro(page) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/question-intro.mjs', async route => { await gate; await route.continue(); });
  return release;
}

try {
  browser = await chromium.launch({headless: true, ...(existsSync(chrome) ? {executablePath: chrome} : {})});
  for (const width of [375, 1440]) {
    for (const language of ['en', 'zh-CN']) {
      const page = await browser.newPage({viewport: {width, height: 1000}});
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(lang => {
        localStorage.setItem('language', lang);
        window.introFrames = [];
        function sample() {
          const hero = document.querySelector('#hero-title');
          const dialog = document.querySelector('#question-intro');
          if (hero) window.introFrames.push({visible: getComputedStyle(hero).visibility === 'visible', open: dialog.open});
          if (!dialog?.open) requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      }, language);
      const release = await delayIntro(page);
      await page.goto(origin, {waitUntil: 'commit'});
      await page.waitForFunction(() => document.querySelector('#hero-title'));
      await page.waitForTimeout(250);
      check(await page.locator('#hero-title').isHidden(), `${width} ${language}: deferred modules cannot expose the homepage`);
      check(await page.evaluate(() => {
        const cover = getComputedStyle(document.body, '::before');
        return cover.position === 'fixed' && cover.visibility === 'visible' && cover.backgroundColor === 'rgb(16, 17, 18)'
          && cover.top === '0px' && cover.bottom === '0px';
      }), `${width} ${language}: first paint uses the opening's full-screen matte surface`);
      release();
      await page.waitForFunction(() => document.querySelector('#question-intro').open);
      check(await page.evaluate(() => window.introFrames.length > 0 && window.introFrames.every(frame => !frame.visible || frame.open)),
        `${width} ${language}: no rendered homepage frame precedes the modal`);
      check(await page.locator('html').getAttribute('data-intro-pending') === null, `${width} ${language}: initialization releases the loading cover`);
      await page.waitForFunction(() => document.querySelector('#question-intro').dataset.phase === 'questions');
      check(await page.locator('html').getAttribute('lang') === language, `${width} ${language}: opening initializes in the saved language`);
      if ((width === 1440 && language === 'en') || (width === 375 && language === 'zh-CN')) {
        await page.waitForFunction(() => document.querySelector('#question-intro').dataset.phase === 'handoff');
        check(await page.locator('#intro-pixels').evaluate(canvas => Number(canvas.dataset.textParticles) > 500
          && Number(canvas.dataset.ribbonTargets) > 0), `${width} ${language}: questions dissolve into the homepage ribbon`);
        await page.locator('#question-intro').waitFor({state: 'hidden'});
        check(await page.locator('#hero-title').isVisible() && await page.locator('html').getAttribute('data-intro-active') === null,
          `${width} ${language}: natural completion reveals the homepage and restores scrolling`);
        await page.waitForFunction(() => !document.querySelector('#hero-delete-video').paused);
        check(true, `${width} ${language}: hero demonstration resumes after the opening`);
        await page.locator('[data-intro-replay]').click();
      }
      await page.locator('#intro-skip').click();
      await page.locator('#question-intro').waitFor({state: 'hidden'});
      check(await page.locator('#hero-title').isVisible() && await page.locator('html').getAttribute('data-intro-active') === null,
        `${width} ${language}: skip reveals the homepage and restores scrolling`);
      await page.locator('[data-intro-replay]').click();
      await page.keyboard.press('Escape');
      await page.locator('#question-intro').waitFor({state: 'hidden'});
      check(await page.locator('[data-intro-replay]').evaluate(button => button === document.activeElement),
        `${width} ${language}: replay and Escape restore focus`);
      await page.close();
    }
  }

  for (const scenario of [
    {name: 'anchor visit', suffix: '#features', options: {}},
    {name: 'reduced motion', suffix: '', options: {reducedMotion: 'reduce'}},
    {name: 'JavaScript disabled', suffix: '', options: {javaScriptEnabled: false}},
  ]) {
    const page = await browser.newPage(scenario.options);
    const release = await delayIntro(page);
    await page.goto(origin + scenario.suffix, {waitUntil: 'commit'});
    await page.waitForFunction(() => document.querySelector('#hero-title'));
    check(await page.locator('#hero-title').isVisible() && await page.locator('#question-intro').isHidden(),
      `${scenario.name}: homepage is available without waiting for animation modules`);
    release();
    await page.waitForLoadState('load');
    check(await page.locator('#question-intro').isHidden(), `${scenario.name}: no automatic opening`);
    await page.close();
  }

  const timeoutPage = await browser.newPage();
  timeoutPage.on('pageerror', error => errors.push(error.message));
  await timeoutPage.clock.install();
  const release = await delayIntro(timeoutPage);
  await timeoutPage.goto(origin, {waitUntil: 'commit'});
  await timeoutPage.waitForFunction(() => document.querySelector('#hero-title'));
  check(await timeoutPage.locator('#hero-title').isHidden(), 'slow initialization reserves the intro');
  await timeoutPage.clock.runFor(8100);
  check(await timeoutPage.locator('#hero-title').isVisible(), 'initialization timeout makes the homepage usable');
  release();
  await timeoutPage.waitForLoadState('load');
  check(await timeoutPage.locator('#question-intro').isHidden()
    && await timeoutPage.locator('html').getAttribute('data-intro-pending') === null,
  'a module arriving after timeout does not interrupt the revealed homepage');
  await timeoutPage.locator('[data-intro-replay]').click();
  check(await timeoutPage.locator('#question-intro').isVisible(), 'manual replay remains available after initialization timeout');
  await timeoutPage.close();

  const failedPage = await browser.newPage();
  await failedPage.clock.install();
  await failedPage.route('**/home.mjs', route => route.abort());
  await failedPage.goto(origin);
  await failedPage.clock.runFor(8100);
  check(await failedPage.locator('#hero-title').isVisible(), 'failed script loading cannot leave the homepage hidden');
  await failedPage.close();

  check(errors.length === 0, errors.join('\n'));
  console.log(`Website opening startup: ${checks} checks passed.`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
