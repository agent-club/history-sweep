import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
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
const evidenceDir = resolve(import.meta.dirname, '../output/website-matte-qa-2026-10-17');
await mkdir(evidenceDir, {recursive: true});
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
      if (language === 'zh-CN') {
        await page.evaluate(() => document.fonts.ready);
        check(await page.locator('#hero-title').evaluate(title => document.fonts.check('400 48px "Sweep Display SC"', '记录')
          && [...document.fonts].some(font => font.family === 'Sweep Display SC' && font.status === 'loaded')
          && getComputedStyle(title).fontFamily.includes('Sweep Display SC')), `${width} Chinese display headings use the local serif font`);
      }
      check(await page.locator('#question-intro').isHidden(), `${width} ${language}: reduced motion skips automatic opening`);
      check(await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor === 'rgb(16, 17, 18)'), `${width} ${language}: matte black page surface`);
      await page.waitForFunction(() => document.querySelector('#pixel-sweep').dataset.motion === 'reduced');
      check(await page.locator('#pixel-sweep').evaluate(canvas => {
        const {width, height} = canvas;
        const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
        let left = false;
        let right = false;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          if (!pixels[(y * width + x) * 4 + 3]) continue;
          if (x < width / 2) left = true;
          else right = true;
        }
        return left && right;
      }), `${width} ${language}: particles render on both sides`);
      check(await page.locator('#ambient-toggle').isHidden(), `${width} ${language}: reduced motion hides background playback control`);
      check(await page.locator('#product-video').evaluate(video => video.paused && video.preload === 'none'), `${width} ${language}: reduced motion does not autoplay or preload video`);
      check((await page.locator('#product-video').getAttribute('poster')).endsWith(`product-demo-${language === 'en' ? 'en' : 'zh'}.png`), `${width} ${language}: localized poster`);
      check(await page.locator('#hero-delete-video').evaluate(video => video.paused && video.preload === 'none'), `${width} ${language}: hero respects reduced motion`);
      check((await page.locator('#hero-delete-video').getAttribute('poster')).endsWith(`single-delete-${language === 'en' ? 'en' : 'zh'}.png`), `${width} ${language}: localized single-delete poster`);
      check(await page.locator('.hero-demo').evaluate(demo => {
        const window = demo.querySelector('.hero-surface').getBoundingClientRect();
        const copy = document.querySelector('.hero-copy').getBoundingClientRect();
        return window.left >= 0 && window.right <= innerWidth && (innerWidth <= 900 ? window.top > copy.bottom : window.left > copy.right);
      }), `${width} ${language}: floating window fits without overlapping the copy`);

      check(await page.locator('.film-chapters button').count() === 5, `${width} ${language}: five feature chapters`);
      check(await page.locator('#features [role="tab"]').count() === 4, `${width} ${language}: four capability scenes`);
      for (const scene of ['match', 'keep', 'space', 'check']) {
        await page.locator(`[data-lab-tab="${scene}"]`).click();
        check(await page.locator(`[data-lab-panel="${scene}"]`).isVisible()
          && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} ${language}: ${scene} scene fits and is visible`);
      }
      await page.waitForFunction(() => { const image = document.querySelector('#lab-verified-image'); return image.complete && image.naturalWidth === 2560; });
      check((await page.locator('#lab-verified-image').getAttribute('src')).endsWith(`product-verified-${language === 'en' ? 'en' : 'zh'}.png`), `${width} ${language}: verified product image is sharp and localized`);
      await page.locator('[data-lab-tab="match"]').click();
      await page.locator('[data-match-mode="text"]').click();
      check(await page.locator('[data-match-row][data-excluded="false"]').count() === 3, `${width} ${language}: text example includes the mention`);
      await page.locator('[data-match-mode="exact"]').click();
      check(await page.locator('[data-match-row][data-excluded="false"]').count() === 1, `${width} ${language}: exact example excludes subdomains`);
      await page.locator('[data-match-mode="smart"]').click();
      check(await page.locator('[data-match-row][data-excluded="false"]').count() === 2, `${width} ${language}: smart example includes subdomains`);
      if ((width === 1440 && language === 'en') || (width === 375 && language === 'zh-CN')) {
        await page.waitForLoadState('networkidle');
        await page.evaluate(() => window.scrollTo({top: 0, behavior: 'instant'}));
        await page.screenshot({path: resolve(evidenceDir, `website-${width}-${language}.png`), fullPage: true});
        await page.locator('#features').screenshot({path: resolve(evidenceDir, `features-${width}-${language}.png`)});
      }
      await page.locator('.manager-frame').scrollIntoViewIfNeeded();
      await page.waitForFunction(() => { const image = document.querySelector('.manager-frame img'); return image.complete && image.naturalWidth === 1280; });
      check(true, `${width} ${language}: current product screenshot loads`);
      check((await page.locator('.manager-frame img').getAttribute('src')).endsWith(`product-still-${language === 'en' ? 'en' : 'zh'}.png`), `${width} ${language}: actual product preview matches locale`);
      const download = await page.locator('a[download]').getAttribute('href');
      check((await page.request.get(new URL(download, origin).href)).status() === 200, `${width} ${language}: download available`);
      await page.goto(new URL('privacy.html', origin).href);
      check(await page.locator('html').getAttribute('lang') === language, `${width} ${language}: privacy remembers locale`);
      check(await page.locator('html').evaluate(node => getComputedStyle(node).backgroundColor === 'rgb(16, 17, 18)'), `${width} ${language}: privacy uses the shared matte visual style`);
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} ${language}: privacy has no horizontal overflow`);
      await context.close();
    }
  }

  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  check(await page.locator('#question-intro').isVisible(), 'first root visit opens the animated three-question introduction');
  await page.waitForFunction(() => document.querySelector('#pixel-sweep').dataset.motion === 'paused');
  check(await page.locator('video').evaluateAll(videos => videos.every(video => video.paused)), 'opening suspends background particles and both demonstrations');
  for (const index of [0, 1, 2]) {
    await page.waitForFunction(index => !document.querySelector(`[data-intro-question="${index}"]`).hidden, index);
    check(await page.locator('[data-intro-question]:visible').count() === 1, `opening presents question ${index + 1} individually`);
    if (index === 0) {
      await page.waitForFunction(() => {
        const lines = document.querySelectorAll('[data-intro-question="0"] .intro-line > span');
        return getComputedStyle(lines[0]).clipPath === 'none'
          && !['none', 'inset(0px 100% 0px 0px)'].includes(getComputedStyle(lines[1]).clipPath);
      });
      check(await page.locator('[data-intro-question="0"] p').textContent() === 'History piling up.Still can’t find that page?',
        'typewriter reveals the second line after the first while preserving the complete accessible question');
      await page.screenshot({path: resolve(evidenceDir, 'typewriter-mid-question.png')});
      await page.waitForFunction(() => [...document.querySelectorAll('[data-intro-question="0"] .intro-line > span')]
        .every(line => getComputedStyle(line).clipPath === 'none'));
      await page.waitForTimeout(500);
      check(await page.locator('[data-intro-question="0"]').evaluate(question => !question.hidden
        && getComputedStyle(question).opacity === '1'), 'a completed question remains readable before the next scene');
    }
  }
  await page.waitForFunction(() => document.querySelector('#question-intro').dataset.phase === 'gather');
  check(await page.locator('[data-intro-question]:visible').count() === 3, 'all three questions gather together before dissolving');
  await page.screenshot({path: resolve(evidenceDir, 'kinetic-intro-gather.png')});
  await page.waitForFunction(() => document.querySelector('#question-intro').dataset.phase === 'handoff');
  check(await page.locator('#intro-pixels').evaluate(canvas => canvas.dataset.textSource === 'localized-glyphs'
    && Number(canvas.dataset.textParticles) > 500), 'dissolve particles originate from the rendered question glyphs');
  check(await page.locator('#intro-pixels').evaluate(canvas => Number(canvas.dataset.ribbonTargets) > 0), 'opening flow has destinations sampled from the homepage ribbon');
  check(await page.locator('#intro-ribbon').evaluate(ribbon => {
    const home = document.querySelector('.sweep-art');
    const target = home.getBoundingClientRect();
    const actual = ribbon.getBoundingClientRect();
    return ['left', 'top', 'width', 'height'].every(key => Math.abs(target[key] - actual[key]) < 1)
      && getComputedStyle(ribbon).objectPosition === getComputedStyle(home).objectPosition && ribbon.currentSrc === home.currentSrc;
  }), 'opening ribbon aligns exactly with the homepage before the reveal');
  const dissolveBefore = await page.locator('#intro-pixels').evaluate(canvas => canvas.toDataURL());
  await page.waitForTimeout(350);
  check(await page.locator('#intro-pixels').evaluate(canvas => canvas.toDataURL()) !== dissolveBefore, 'question fragments move during their transfer into the ribbon');
  await page.screenshot({path: resolve(evidenceDir, 'kinetic-intro-dissolve.png')});
  await page.waitForFunction(() => Number(document.querySelector('#intro-pixels').dataset.arrivedParticles) > 500);
  check(true, 'question fragments reach the actual ribbon before the opening closes');
  await page.locator('#question-intro').waitFor({state: 'hidden'});
  check(await page.locator('html').getAttribute('data-intro-active') === null, 'opening completes and releases the page scroll lock');
  check(await page.locator('.brand').first().evaluate(brand => brand !== document.activeElement
    && !brand.matches(':focus-visible')), 'automatic opening does not leave an unrelated focus outline around the logo');
  await page.locator('[data-intro-replay]').click();
  await page.keyboard.press('Escape');
  await page.locator('#question-intro').waitFor({state: 'hidden'});
  check(await page.locator('[data-intro-replay]').evaluate(button => button === document.activeElement), 'Escape dismisses replay and restores focus to its trigger');
  await page.locator('[data-intro-replay]').click();
  await page.locator('#intro-skip').click();
  await page.locator('#question-intro').waitFor({state: 'hidden'});
  check(true, 'opening can be skipped without waiting for the sequence');
  await page.waitForFunction(() => !document.querySelector('#hero-delete-video').paused);
  check(await page.locator('#hero-delete-video').evaluate(video => video.muted && video.loop && video.duration === 7
    && video.videoWidth === 2000 && video.videoHeight === 1360), 'hero loops the sharp, silent, seven-second native single-delete recording');
  await page.locator('#hero-delete-video').evaluate(video => { video.currentTime = 4.15; });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#hero-delete-particles');
    return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0);
  });
  check(true, 'native row fragments continue beyond the tilted window during deletion');
  await page.screenshot({path: resolve(evidenceDir, 'hero-single-delete-en.png')});
  await page.locator('#hero-delete-toggle').click();
  const heroPausedAt = await page.locator('#hero-delete-video').evaluate(video => video.currentTime);
  const heroPausedPixels = await page.locator('#hero-delete-particles').evaluate(canvas => canvas.toDataURL());
  await page.waitForTimeout(180);
  check(await page.locator('#hero-delete-video').evaluate((video, time) => video.paused && video.currentTime === time, heroPausedAt)
    && await page.locator('#hero-delete-particles').evaluate(canvas => canvas.toDataURL()) === heroPausedPixels, 'hero pause freezes both recording and exterior fragments');
  await page.locator('[data-intro-replay]').click();
  await page.locator('#intro-skip').click();
  await page.locator('#question-intro').waitFor({state: 'hidden'});
  check(await page.locator('#hero-delete-video').evaluate(video => video.paused), 'hero explicit pause survives opening replay');
  await page.locator('#hero-delete-toggle').click();
  await page.waitForFunction(() => !document.querySelector('#hero-delete-video').paused);
  await page.locator('#hero-delete-video').evaluate(video => { video.currentTime = 6.85; });
  await page.waitForFunction(() => { const video = document.querySelector('#hero-delete-video'); return video.currentTime < 1 && !video.paused; });
  check(true, 'single-delete recording loops automatically');

  await page.waitForFunction(() => document.querySelector('#pixel-sweep').dataset.motion === 'running');
  const pixelsBefore = await page.locator('#pixel-sweep').evaluate(canvas => canvas.toDataURL());
  await page.waitForTimeout(180);
  check(await page.locator('#pixel-sweep').evaluate(canvas => canvas.toDataURL()) !== pixelsBefore, 'background pixel dissolve produces changing rendered frames');
  await page.locator('#ambient-toggle').click();
  const pausedPixels = await page.locator('#pixel-sweep').evaluate(canvas => canvas.toDataURL());
  await page.waitForTimeout(180);
  check(await page.locator('#pixel-sweep').evaluate(canvas => canvas.toDataURL()) === pausedPixels, 'background pause stops rendered motion');
  await page.locator('#ambient-toggle').click();
  const installLinks = await page.locator('a[href*="chromewebstore.google.com"]').evaluateAll(links => links.map(link => link.href));
  check(installLinks.length === 3 && installLinks.every(url => url.endsWith('/bbccfejdhhcjmpfagjckiikgllpojhgm')), 'all three install actions retain the current store destination');
  await page.locator('[data-workflow="search"]').click();
  check(await page.locator('[data-workflow-panel="search"]').isVisible() && await page.locator('[data-workflow-panel="review"]').isHidden(), 'workflow selection switches the supporting explanation');
  await page.locator('[data-workflow="review"]').click();
  await page.locator('[data-lab-tab="keep"]').click();
  await page.waitForFunction(() => document.querySelector('.lab-stage').dataset.motion === 'entering');
  check(await page.locator('#lab-panel-keep').evaluate(panel => panel.getAnimations({subtree: true}).some(animation => animation.playState === 'running')), 'scene entrance renders staggered child animations');
  await page.waitForFunction(() => document.querySelector('.lab-stage').dataset.motion === 'idle');
  check(await page.locator('.lab-stage').evaluate(stage => stage.style.height === '' && stage.getAnimations({subtree: true}).length === 0), 'scene transition releases height and animation effects after settling');
  for (const scene of ['match', 'space', 'check', 'keep']) await page.locator(`[data-lab-tab="${scene}"]`).click();
  await page.waitForFunction(() => document.querySelector('.lab-stage').dataset.motion === 'idle');
  check(await page.locator('[data-lab-panel]:visible').count() === 1 && await page.locator('[data-lab-panel]:visible').getAttribute('data-lab-panel') === 'keep'
    && await page.locator('.lab-stage [inert]').count() === 0, 'rapid scene changes settle on the last requested scene without overlapping or inert content');
  await page.locator('[data-lab-tab="match"]').click();
  await page.locator('[data-lab-tab="match"]').press('End');
  check(await page.locator('[data-lab-tab="check"]').getAttribute('aria-selected') === 'true', 'scene tabs support keyboard End navigation');
  await page.locator('[data-lab-tab="check"]').press('ArrowRight');
  check(await page.locator('[data-lab-tab="match"]').getAttribute('aria-selected') === 'true', 'scene tabs wrap with arrow keys');
  await page.locator('[data-lab-tab="space"]').click();
  for (const space of ['popup', 'modal', 'full']) {
    await page.locator(`[data-space="${space}"]`).click();
    check(await page.locator('[data-space-view]').getAttribute('data-space-view') === space, `${space} workspace preview switches`);
  }
  await page.locator('[data-lab-tab="keep"]').click();
  await page.locator('#lab-select-all').click();
  check(await page.locator('#lab-selected-count').textContent() === '3', 'group selection selects all illustrative pages');
  await page.locator('[data-keep-example]').nth(1).uncheck();
  check(await page.locator('#lab-selected-count').textContent() === '2' && await page.locator('#lab-kept-count').textContent() === '1', 'keeping an exception updates both live counts');
  await page.locator('#demo').scrollIntoViewIfNeeded();
  const range = await page.request.get(new URL('assets/product-demo-en.mp4', origin).href, {headers: {Range: 'bytes=0-99'}});
  check(range.status() === 206 && (await range.body()).length === 100, 'local video byte ranges support chapter seeking');
  await page.waitForFunction(() => !document.querySelector('#product-video').paused);
  check(await page.locator('#product-video').evaluate(video => video.muted && video.loop && video.duration === 20 && video.videoWidth === 2560 && video.videoHeight === 1520), 'film is sharp, silent, twenty seconds, and loops');
  await page.locator('#film-toggle').click();
  check(await page.locator('#product-video').evaluate(video => video.paused), 'pause control');
  await page.locator('[data-intro-replay]').click();
  await page.locator('#intro-skip').click();
  await page.locator('#question-intro').waitFor({state: 'hidden'});
  check(await page.locator('#product-video').evaluate(video => video.paused), 'replaying the opening preserves an explicit product-video pause');
  await page.locator('[data-chapter="6"]').click();
  await page.waitForFunction(() => { const video = document.querySelector('#product-video'); return !video.paused && video.currentTime >= 6 && document.querySelector('[data-chapter="6"]').getAttribute('aria-pressed') === 'true'; });
  check(await page.locator('[data-chapter="6"]').getAttribute('aria-pressed') === 'true', 'chapter navigation seeks and highlights selection');
  await page.locator('#film-expand').click();
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  check(await page.locator('.film-window').evaluate(node => node === document.fullscreenElement), 'product film expands with playback controls');
  await page.locator('#film-expand').click();
  await page.waitForFunction(() => !document.fullscreenElement);
  const beforeLanguage = await page.locator('#product-video').evaluate(video => video.currentTime);
  await page.getByRole('button', {name: '简体中文', exact: true}).click();
  await page.locator('#demo').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => { const video = document.querySelector('#product-video'); return video.currentSrc.endsWith('product-demo-zh.mp4') && !video.paused && video.currentTime >= 6; });
  check(Math.abs(await page.locator('#product-video').evaluate(video => video.currentTime) - beforeLanguage) < 1, 'language switching preserves position and playback');
  check(await page.locator('[data-lab-tab="keep"]').getAttribute('aria-selected') === 'true' && await page.locator('#lab-kept-count').textContent() === '1', 'language switching preserves the active feature scene and example selection');
  await page.evaluate(() => window.scrollTo({top: document.documentElement.scrollHeight, behavior: 'instant'}));
  await page.waitForFunction(() => document.querySelector('#product-video').paused);
  check(true, 'offscreen playback pauses');
  await page.waitForFunction(() => document.querySelector('#pixel-sweep').dataset.motion === 'paused');
  check(true, 'offscreen pixel animation stops its animation loop');
  await page.locator('#demo').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => !document.querySelector('#product-video').paused);
  check(true, 'returning to the walkthrough resumes playback');
  await page.locator('#film-toggle').click();
  await page.evaluate(() => window.scrollTo({top: document.documentElement.scrollHeight, behavior: 'instant'}));
  await page.locator('#demo').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  check(await page.locator('#product-video').evaluate(video => video.paused), 'explicit pause survives scrolling');
  await page.locator('#film-toggle').click();
  await page.locator('#product-video').evaluate(video => { video.currentTime = 19.8; });
  await page.waitForFunction(() => { const video = document.querySelector('#product-video'); return video.currentTime < 1 && !video.paused
    && document.querySelector('[data-chapter="0"]').getAttribute('aria-pressed') === 'true'; });
  check(await page.locator('[data-chapter="0"]').getAttribute('aria-pressed') === 'true', 'film loops to the first chapter and keeps playing');
  await page.locator('#film-toggle').click();
  const pausedAt = await page.locator('#product-video').evaluate(video => video.currentTime);
  await page.getByRole('button', {name: 'English', exact: true}).click();
  await page.waitForFunction(() => { const video = document.querySelector('#product-video'); return video.currentSrc.endsWith('product-demo-en.mp4') && video.readyState >= 1; });
  check(await page.locator('#product-video').evaluate((video, time) => video.paused && Math.abs(video.currentTime - time) < 0.1, pausedAt), 'language switching preserves a paused loop position');
  await page.locator('#film-toggle').click();
  await page.waitForFunction(() => { const video = document.querySelector('#product-video'); return !video.paused && video.currentTime < 1; });
  check(true, 'paused loop resumes on request');
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.waitForFunction(() => document.querySelector('#product-video').paused);
  check(true, 'enabling reduced motion stops playback');
  await page.waitForFunction(() => document.querySelector('#pixel-sweep').dataset.motion === 'reduced');
  const reducedPixels = await page.locator('#pixel-sweep').evaluate(canvas => canvas.toDataURL());
  await page.waitForTimeout(180);
  check(await page.locator('#pixel-sweep').evaluate(canvas => canvas.toDataURL()) === reducedPixels, 'reduced motion keeps a static particle frame');
  await page.locator('[data-lab-tab="check"]').click();
  check(await page.locator('.lab-stage').getAttribute('data-motion') === 'reduced'
    && await page.locator('#lab-panel-check').isVisible()
    && await page.locator('.lab-stage').evaluate(stage => stage.getAnimations({subtree: true}).length === 0), 'reduced motion switches feature scenes immediately without animation');
  await page.locator('[data-intro-replay]').click();
  check(await page.locator('[data-intro-question]:visible').count() === 3
    && await page.locator('#question-intro').evaluate(dialog => dialog.getAnimations({subtree: true}).length === 0), 'explicit replay with reduced motion presents all three questions statically');
  await page.locator('#intro-skip').click();
  await page.locator('#question-intro').waitFor({state: 'hidden'});
  await context.close();

  const reduced = await browser.newContext({viewport: {width: 375, height: 812}, reducedMotion: 'reduce'});
  const reducedPage = await reduced.newPage();
  reducedPage.on('pageerror', error => errors.push(error.message));
  await reducedPage.goto(origin);
  await reducedPage.locator('[data-chapter="14"]').click();
  await reducedPage.waitForFunction(() => { const video = document.querySelector('#product-video'); return video.currentTime >= 14 && !video.paused; });
  check(true, 'reduced motion allows explicit chapter playback on mobile');
  await reducedPage.locator('#hero-delete-toggle').click();
  await reducedPage.waitForFunction(() => !document.querySelector('#hero-delete-video').paused);
  check(await reducedPage.locator('#hero-delete-video').evaluate(video => video.muted && video.loop), 'reduced motion allows explicitly requested single-delete playback on mobile');
  await reducedPage.locator('#hero-delete-toggle').click();
  check(await reducedPage.locator('#hero-delete-video').evaluate(video => video.paused), 'mobile hero playback can be paused');

  await reduced.close();
  const mobileMotion = await browser.newContext({viewport: {width: 375, height: 812}});
  const mobileMotionPage = await mobileMotion.newPage();
  mobileMotionPage.on('pageerror', error => errors.push(error.message));
  await mobileMotionPage.addInitScript(() => localStorage.setItem('language', 'zh-CN'));
  await mobileMotionPage.goto(`${origin}#features`);
  check(await mobileMotionPage.locator('#question-intro').isHidden(), 'direct section links bypass the opening');
  for (const scene of ['space', 'check', 'match', 'keep']) {
    await mobileMotionPage.locator(`[data-lab-tab="${scene}"]`).click();
    await mobileMotionPage.waitForFunction(() => document.querySelector('.lab-stage').dataset.motion === 'idle');
    check(await mobileMotionPage.locator(`[data-lab-panel="${scene}"]`).isVisible()
      && await mobileMotionPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `mobile ${scene} animation settles without overflow`);
  }
  check(await mobileMotionPage.locator('.lab-tab-indicator').evaluate(indicator => {
    const active = document.querySelector('[data-lab-tab][aria-selected="true"]').getBoundingClientRect();
    const line = indicator.getBoundingClientRect();
    return Math.abs(line.left - active.left) <= 2 && Math.abs(line.top - (active.bottom - 2)) <= 2;
  }), 'mobile scene indicator follows the two-row tab layout');
  await mobileMotionPage.locator('[data-intro-replay]').click();
  await mobileMotionPage.waitForFunction(() => !document.querySelector('[data-intro-question="0"]').hidden
    && [...document.querySelector('[data-intro-question="0"]').querySelectorAll('.intro-line > span')]
      .every(line => getComputedStyle(line).clipPath === 'none'));
  check(await mobileMotionPage.locator('[data-intro-question="0"]').evaluate(question => {
    const bounds = question.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom < innerHeight - 65;
  }), 'mobile Chinese opening question fits above its progress controls');
  await mobileMotionPage.screenshot({path: resolve(evidenceDir, 'question-intro-375-zh.png')});
  await mobileMotionPage.waitForFunction(() => document.querySelector('#question-intro').dataset.phase === 'gather');
  check(await mobileMotionPage.locator('[data-intro-question]').evaluateAll(questions => questions.every(question => {
    const bounds = question.getBoundingClientRect();
    return !question.hidden && bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom < innerHeight - 65;
  })), 'all three Chinese questions gather within the mobile viewport');
  await mobileMotionPage.screenshot({path: resolve(evidenceDir, 'kinetic-intro-gather-375-zh.png')});
  await mobileMotionPage.waitForFunction(() => document.querySelector('#question-intro').dataset.phase === 'handoff');
  check(await mobileMotionPage.locator('#intro-pixels').evaluate(canvas => Number(canvas.dataset.textParticles) > 500
    && canvas.dataset.textSource === 'localized-glyphs'), 'mobile Chinese question glyphs become ribbon-bound particles');
  await mobileMotionPage.emulateMedia({reducedMotion: 'reduce'});
  await mobileMotionPage.locator('#question-intro').waitFor({state: 'hidden'});
  check(await mobileMotionPage.locator('html').getAttribute('data-intro-active') === null, 'enabling reduced motion during the opening immediately restores the page');
  await mobileMotionPage.emulateMedia({reducedMotion: 'no-preference'});
  await mobileMotionPage.locator('[data-lab-tab="check"]').click();
  await mobileMotionPage.emulateMedia({reducedMotion: 'reduce'});
  await mobileMotionPage.waitForFunction(() => document.querySelector('.lab-stage').dataset.motion === 'reduced');
  check(await mobileMotionPage.locator('#lab-panel-check').isVisible()
    && await mobileMotionPage.locator('.lab-stage').evaluate(stage => !stage.style.height && stage.getAnimations({subtree: true}).length === 0), 'enabling reduced motion mid-transition cancels effects and reveals the requested scene');
  await mobileMotion.close();
  check(errors.length === 0, `no runtime errors: ${errors.join('; ')}`);
  console.log(`${checks} website assertions passed. Local static assets only; no browser history accessed.`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
