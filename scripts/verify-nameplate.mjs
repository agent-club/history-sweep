import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { injectModal } from '../extension/modal-host.mjs';

const { chromium } = dependency('playwright');
const sharp = dependency('sharp');
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-nameplate-browser-'));
const server = createServer();
const screenshots = process.env.HISTORY_SWEEP_SCREENSHOTS;
const errors = [];
let context, page, checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const closeCard = frame => frame.locator('.nameplate-close').click();
async function openCard(frame) {
  await frame.locator('#openNameplate').click();
  await frame.locator('.np-preview[data-phase=settled]').waitFor({ state: 'visible' });
}
const transform = frame => frame.locator('.np-object').evaluate(node => node.style.transform);
async function capture(name) {
  if (screenshots) await page.screenshot({ path: join(screenshots, `${name}.png`) });
}
async function stableCard(frame, name) {
  const box = await frame.locator('.np-object').boundingBox();
  const clip = { x: Math.ceil(box.x + box.width * .12), y: Math.ceil(box.y + box.height * .14), width: Math.floor(box.width * .7), height: Math.floor(box.height * .7) };
  const first = await sharp(await page.screenshot({ clip })).removeAlpha().raw().toBuffer();
  let largest = 0;
  for (let i = 0; i < 12; i++) {
    await pause(80);
    const pixels = await sharp(await page.screenshot({ clip })).removeAlpha().raw().toBuffer();
    let change = 0;
    for (let j = 0; j < pixels.length; j++) change += Math.abs(pixels[j] - first[j]);
    largest = Math.max(largest, change / pixels.length);
  }
  check(largest < 2, `${name}: settled card pixels remain stable (${largest.toFixed(3)}/255)`);
}
async function geometry(frame, name) {
  const result = await frame.evaluate(() => {
    const dialog = document.querySelector('#nameplateDialog'), box = dialog.getBoundingClientRect();
    const front = dialog.querySelector('.np-front');
    const fits = selector => { const node = front.querySelector(selector); return node.offsetLeft + node.offsetWidth <= front.clientWidth; };
    const subtitle = front.querySelector('.np-subtitle'), number = front.querySelector('.np-number');
    return { fits: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
      overflow: dialog.scrollWidth > dialog.clientWidth, title: fits('.np-title'), subtitle: fits('.np-subtitle'),
      separated: subtitle.offsetTop + subtitle.offsetHeight < number.offsetTop };
  });
  check(result.fits && !result.overflow && result.title && result.subtitle && result.separated, `${name}: geometry ${JSON.stringify(result)}`);
}

try {
  if (screenshots) await mkdir(screenshots, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.HISTORY_SWEEP_CHROMIUM,
    channel: process.env.HISTORY_SWEEP_CHROMIUM ? undefined : 'chromium', headless: true,
    viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-features=DisableLoadExtensionCommandLineSwitch'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(6000);
  await page.addInitScript(() => { localStorage.setItem('language', 'zh-CN'); localStorage.setItem('theme', 'light'); });
  await page.addInitScript(() => {
    window.startupSamples = [];
    const sample = () => {
      const app = document.querySelector('#app'), dialog = document.querySelector('#nameplateDialog');
      window.startupSamples.push({ phase: document.body?.dataset.startup, visible: app && getComputedStyle(app).visibility !== 'hidden', open: !!dialog?.open });
      if (document.body?.dataset.startup || !app) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto(`${origin}/manager.html`);
  await page.locator('.np-preview[data-phase=settled]').waitFor();
  check(await page.locator('body').getAttribute('data-startup') === 'nameplate', 'fresh installation transitions directly from loading to nameplate');
  check(await page.locator('#app').evaluate(node => node.inert && getComputedStyle(node).visibility === 'hidden'), 'workspace remains hidden and inert until collection');
  check(await page.evaluate(() => startupSamples.every(sample => !sample.visible)), 'no sampled frame exposes the homepage before the first card');
  await capture('first-install');
  await page.locator('.np-collect').click();
  await page.locator('.np-preview[data-phase=collecting]').waitFor();
  await pause(250);
  const firstCollection = await page.evaluate(() => ({
    alpha: +document.querySelector('#nameplateDialog').style.getPropertyValue('--np-background-opacity'),
    visible: getComputedStyle(document.querySelector('#app')).visibility === 'visible',
    inert: document.querySelector('#app').inert,
    particles: document.querySelectorAll('.np-orbit-particle').length,
  }));
  check(firstCollection.alpha > 0 && firstCollection.alpha < 1 && firstCollection.visible && firstCollection.inert && firstCollection.particles === 64, 'first collection fades its background over the visible, still inert workspace with particles');
  await capture('collect-early'); await pause(280);
  check(await page.locator('#nameplateDialog').evaluate(node => +node.style.getPropertyValue('--np-background-opacity')) < firstCollection.alpha, 'collection background becomes progressively transparent before close');
  await capture('collect-late');
  await page.waitForFunction(() => !document.body.dataset.startup);
  check(await page.locator('#app').evaluate(node => !node.inert && getComputedStyle(node).visibility === 'visible'), 'collection reveals the workspace');
  await page.locator('#openNameplateHeader').click();
  await page.locator('.np-preview[data-phase=settled]').waitFor();
  check(await page.locator('.np-collect').textContent() === '收好铭牌', 'header replays the reveal with the regular collect action');
  await closeCard(page);
  await page.locator('#openVersion').click();
  check(await page.locator('#updateDialog').evaluate(node => node.open), 'brand version opens existing update details');
  await page.locator('#closeUpdateDetails').click();
  await page.locator('#openPreferences').click(); await openCard(page);
  const issued = await worker.evaluate(async () => (await chrome.storage.local.get('nameplate')).nameplate);
  check(['obsidian', 'ivory', 'aurora', 'gold'].includes(issued.variant), 'native worker issued a material');
  check((await page.locator('.np-front .np-number').textContent()).replaceAll(' · ', '') === issued.number, 'display uses persisted decorative number');
  const initial = await transform(page); await pause(350);
  check(initial !== await transform(page), 'slow rotation starts by default');
  await page.locator('.np-motion').click(); await pause(150);
  const stopped = await transform(page); await pause(250);
  check(stopped === await transform(page), 'pause stops rotation');
  const object = await page.locator('.np-object').boundingBox();
  await page.mouse.move(object.x + object.width * .7, object.y + object.height * .4); await pause(400);
  check(await page.locator('.np-object').evaluate(node => +node.style.getPropertyValue('--np-hover') > .8), 'hover eases in over card');
  const angleBeforeGrab = await page.locator('.np-object').evaluate(node => Number(node.style.transform.match(/rotateY\(([-\d.]+)deg\)/)[1]));
  await page.locator('.np-stage').evaluate(node => node.addEventListener('pointerdown', event => {
    window.nameplateDragPointer = event.pointerId;
  }, { once: true }));
  await page.mouse.down(); await pause(30);
  const angleAfterGrab = await page.locator('.np-object').evaluate(node => Number(node.style.transform.match(/rotateY\(([-\d.]+)deg\)/)[1]));
  check(Math.abs(angleAfterGrab - angleBeforeGrab) < .2, 'grabbing a hovered card preserves its displayed angle');
  check(await page.locator('.np-object').evaluate(node => +node.style.getPropertyValue('--np-hover') > .4), 'hover lift fades instead of snapping off on grab');
  const batched = await page.evaluate(({ x, y }) => {
    const stage = document.querySelector('.np-stage'), object = document.querySelector('.np-object');
    const before = object.style.transform;
    for (let i = 1; i <= 30; i++) stage.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: window.nameplateDragPointer, pointerType: 'mouse', isPrimary: true, buttons: 1,
      clientX: x + i, clientY: y, bubbles: true,
    }));
    return before === object.style.transform;
  }, { x: object.x + object.width * .7, y: object.y + object.height * .4 });
  check(batched, 'high-frequency drag input waits for the next animation frame');
  await pause(120);
  check(angleAfterGrab !== await page.locator('.np-object').evaluate(node => Number(node.style.transform.match(/rotateY\(([-\d.]+)deg\)/)[1])), 'batched drag input paints on the next frame');
  await page.mouse.up();
  const labelMutations = await page.locator('.np-flip').evaluate(async node => {
    let count = 0;
    const observer = new MutationObserver(records => { count += records.length; });
    observer.observe(node, { childList: true });
    await new Promise(resolve => setTimeout(resolve, 100)); observer.disconnect();
    return count;
  });
  check(labelMutations === 0, 'motion does not replace the unchanged flip label every frame');
  await page.locator('.nameplate-heading').hover(); await pause(900);
  check(await page.locator('.np-object').evaluate(node => +node.style.getPropertyValue('--np-hover') < .001), 'hover settles after leaving card');
  await page.locator('.np-flip').click(); await pause(1500);
  check(await page.locator('.np-front').getAttribute('aria-hidden') === 'true', 'flip reveals back');
  await page.locator('.np-stage').focus(); await page.keyboard.press('Enter'); await pause(1500);
  check(await page.locator('.np-front').getAttribute('aria-hidden') === 'false', 'Enter flips to front');
  const stage = await page.locator('.np-stage').boundingBox(), beforeDrag = await transform(page);
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down(); await page.mouse.move(stage.x + stage.width / 2 + 70, stage.y + stage.height / 2 - 25, { steps: 8 }); await page.mouse.up();
  check(beforeDrag !== await transform(page), 'pointer drag rotates in 3D');
  await closeCard(page);
  check(await page.locator('#openNameplate').evaluate(node => node === document.activeElement), 'close restores settings focus');
  await page.reload(); await page.waitForFunction(() => !document.body.dataset.startup);
  check(await page.locator('#nameplateDialog').evaluate(node => !node.open), 'reload does not replay first-install reveal');
  await page.locator('#openPreferences').click(); await openCard(page);
  assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get('nameplate')).nameplate), issued); checks++;
  await closeCard(page); await page.locator('#closePreferences').click();
  // Exercise each real material's animated startup, not just static reduced-motion cards.
  const energies = [];
  for (const variant of ['obsidian', 'ivory', 'aurora', 'gold']) {
    await worker.evaluate(nameplate => chrome.storage.local.set({ nameplate, nameplateRevealPending: true }), { ...issued, variant });
    await page.reload();
    await page.locator('.np-preview[data-phase=revealing]').waitFor();
    check(await page.locator('#app').evaluate(node => node.inert && getComputedStyle(node).visibility === 'hidden'), `${variant}: startup remains covered during opening`);
    check(await page.locator('.np-orbit-particle').count() === 64, `${variant}: orbital entrance is active`);
    check(await page.locator('.np-window-spark').count() === 28, `${variant}: entrance reaches the whole popup perimeter`);
    energies.push(await page.locator('#nameplateDialog').evaluate(node => node.style.getPropertyValue('--np-energy')));
    await pause(820); await capture(`opening-${variant}`);
    await page.locator('.np-preview[data-phase=settled]').waitFor();
    check(await page.locator('.np-window-effects').evaluate(node => +node.style.opacity > 0 && [...node.querySelectorAll('.np-window-spark')].every(spark => +spark.style.opacity === 0)), `${variant}: static perimeter glow remains after entrance particles finish`);
    await geometry(page, `animated-${variant}`); await capture(`settled-${variant}`);
    check(await page.evaluate(() => startupSamples.every(sample => !sample.visible)), `${variant}: no homepage frame before collection`);
    await page.locator('.np-collect').click();
    await page.locator('.np-preview[data-phase=collecting]').waitFor();
    check(await page.locator('.np-window-effects').count() === 1, `${variant}: collection reuses one perimeter layer`);
    await pause(350); await capture(`collect-${variant}`);
    check(await page.locator('.np-window-rim').evaluate(node => getComputedStyle(node).display === 'none'), `${variant}: collection has no shrinking perimeter line`);
    await page.waitForFunction(() => !document.body.dataset.startup);
  }
  check(new Set(energies).size === 4, 'all finishes use their own entrance light');
  await capture('header-page');
  await page.locator('#openNameplateHeader').click();
  await page.locator('.np-preview[data-phase=revealing]').waitFor();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('.np-preview[data-phase=settled]').waitFor();
  check(await page.locator('.np-orbit-scene').count() === 0, 'enabling reduced motion during opening immediately removes the entrance');
  check(await page.locator('.np-window-effects').evaluate(node => +node.style.opacity > 0 && [...node.querySelectorAll('.np-window-spark')].every(spark => +spark.style.opacity === 0)), 'reduced motion keeps the static glow without particles');
  check(await page.locator('.np-motion').getAttribute('aria-pressed') === 'false', 'changing reduced motion pauses rotation');
  await closeCard(page);
  for (const language of ['zh-CN', 'en']) {
    if (language === 'en') await page.locator('#language [data-language=en]').click();
    await page.locator('#openPreferences').click();
    for (const variant of ['obsidian', 'ivory', 'aurora', 'gold']) {
      await worker.evaluate(nameplate => chrome.storage.local.set({ nameplate }), { ...issued, variant });
      await openCard(page); await geometry(page, `${language}-${variant}`);
      check(await page.locator('.np-motion').getAttribute('aria-pressed') === 'false', 'reduced motion starts paused');
      const still = await transform(page); await pause(100);
      check(still === await transform(page), 'reduced motion has no automatic transform');
      check(await page.locator('.np-halo').first().evaluate(node => getComputedStyle(node).animationName) === 'none', 'reduced motion disables drifting halo');
      await capture(`${language}-${variant}`);
      await page.locator('.np-collect').click();
      await page.waitForFunction(() => !document.querySelector('#nameplateDialog').open);
      check(await page.locator('.np-orbit-scene').count() === 0, 'reduced motion collects immediately without leaving particles');
    }
    await page.locator('#closePreferences').click();
  }
  await page.close();
  for (const layout of ['popup', 'modal', 'narrow']) {
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(6000);
    await page.addInitScript(() => { localStorage.setItem('language', 'en'); localStorage.setItem('theme', 'light'); });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(layout === 'popup' ? { width: 440, height: 590 } : layout === 'narrow' ? { width: 320, height: 640 } : { width: 900, height: 700 });
    let frame = page;
    if (layout === 'modal') {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      // Inspect the host's closed root only in this disposable verification page.
      await page.addInitScript(() => {
        const attach = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(options) { const root = attach.call(this, options); window.testModalRoot = root; return root; };
      });
      await worker.evaluate(nameplate => chrome.storage.local.set({ nameplate, nameplateRevealPending: true }), { ...issued, variant: 'gold' });
      await page.goto(`http://127.0.0.1:${server.address().port}/site/`); await page.bringToFront();
      // This identifier belongs only to the disposable local test profile.
      const syntheticLaunchId = crypto.randomUUID();
      const navigation = page.waitForEvent('framenavigated', { predicate: frame => frame.url().startsWith(`${origin}/modal.html`) });
      await worker.evaluate(async syntheticLaunchId => {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        await chrome.storage.session.set({ modalLaunchSessions: { [syntheticLaunchId]: { tabId: tab.id, expires: Date.now() + 60000 } } });
      }, syntheticLaunchId);
      await page.evaluate(injectModal, `${origin}/modal.html#launch=${syntheticLaunchId}`); await navigation;
      frame = page.frames().find(frame => frame.url().startsWith(`${origin}/modal.html`));
    } else await page.goto(`${origin}/${layout === 'popup' ? 'popup' : 'manager'}.html`);
    if (layout === 'modal') {
      const hostHidden = () => page.evaluate(() => window.testModalRoot.querySelector('button').hidden);
      await frame.locator('.np-preview[data-phase=revealing]').waitFor();
      await pause(820);
      check(await page.evaluate(() => {
        const dialog = window.testModalRoot.querySelector('dialog');
        return dialog.dataset.nameplatePhase === 'revealing' && getComputedStyle(dialog).animationName === 'nameplate-arrive' && dialog.style.getPropertyValue('--np-energy') === '235 193 112';
      }), 'modal: trusted card phase animates the material-colored outer halo');
      await capture('modal-perimeter-opening');
      await frame.locator('.np-preview[data-phase=settled]').waitFor();
      check(await page.evaluate(() => window.testModalRoot.querySelector('dialog').dataset.nameplatePhase) === 'settled', 'modal: outer halo settles with the card');
      const settledShadow = await page.evaluate(() => getComputedStyle(window.testModalRoot.querySelector('dialog')).boxShadow);
      await pause(350);
      check(await page.evaluate(() => getComputedStyle(window.testModalRoot.querySelector('dialog')).boxShadow) === settledShadow && settledShadow.includes('235, 193, 112'), 'modal: material glow remains stable while the card is open');
      check(await hostHidden(), 'modal: first-install nameplate hides the host close button');
      await capture('modal-first-install');
      await closeCard(frame); await pause(80);
      check(!await hostHidden(), 'modal: leaving first-install nameplate restores host close');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await frame.locator('#openNameplateHeader').click();
      await frame.locator('.np-preview[data-phase=settled]').waitFor();
      check(await hostHidden(), 'modal: header nameplate has one close button');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      // Resume, exercise real 3D motion, then pause before comparing card pixels.
      await frame.locator('.np-motion').click(); await pause(350);
      await frame.locator('.np-motion').click(); await page.mouse.move(0, 0); await pause(500);
      await stableCard(frame, 'modal-front');
      await frame.locator('.np-flip').click(); await pause(1800);
      await stableCard(frame, 'modal-back'); await capture('modal-gold-back');
      await frame.locator('.np-collect').click();
      await frame.locator('.np-preview[data-phase=collecting]').waitFor();
      check(await hostHidden(), 'modal: host close remains hidden throughout collection');
      await pause(400); await capture('modal-collect');
      check(await page.evaluate(() => window.testModalRoot.querySelector('dialog').dataset.nameplatePhase) === 'collecting', 'modal: perimeter glow contracts during collection');
      await frame.waitForFunction(() => !document.querySelector('#nameplateDialog').open);
      await page.waitForFunction(() => !window.testModalRoot.querySelector('button').hidden);
      check(!await hostHidden(), 'modal: collection restores host close after the particles finish');
      check(await page.evaluate(() => !window.testModalRoot.querySelector('dialog').hasAttribute('data-nameplate-phase')), 'modal: closing clears the outer effect state');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await frame.locator('#openPreferences').click(); await openCard(frame); await closeCard(frame); await pause(80);
      check(await hostHidden(), 'modal: closing nameplate keeps host close hidden while settings remain open');
      await frame.locator('#closePreferences').click();
      await page.waitForFunction(() => !window.testModalRoot.querySelector('button').hidden);
      check(!await hostHidden(), 'modal: closing settings finally restores host close');
    }
    await frame.waitForFunction(() => !document.body.dataset.startup);
    await capture(`header-${layout}`);
    await frame.locator('#openPreferences').click();
    for (const variant of ['obsidian', 'ivory', 'aurora', 'gold']) {
      await worker.evaluate(nameplate => chrome.storage.local.set({ nameplate }), { ...issued, variant });
      await openCard(frame); await geometry(frame, `${layout}-${variant}`);
      if (variant === 'obsidian' || layout === 'narrow') await capture(`${layout}-${variant}`);
      await closeCard(frame);
    }
    // Invalid saved data is recoverable without fabricating or overwriting a card.
    await worker.evaluate(() => chrome.storage.local.set({ nameplate: { version: 99 } }));
    await frame.locator('#openNameplate').click(); await frame.locator('.nameplate-retry').waitFor({ state: 'visible' });
    await capture(`error-${layout}`);
    check(await frame.locator('.nameplate-content').isHidden(), `${layout}: failed read does not display a fabricated card`);
    await worker.evaluate(nameplate => chrome.storage.local.set({ nameplate }), issued);
    await frame.locator('.nameplate-retry').click(); await frame.locator('.np-stage').waitFor({ state: 'visible' });
    check(await frame.locator('.nameplate-feedback').isHidden(), `${layout}: retry recovers`);
    const beforeKey = await transform(frame); await frame.locator('.np-stage').focus(); await page.keyboard.press('ArrowRight');
    check(beforeKey !== await transform(frame), `${layout}: keyboard rotates while reduced motion is enabled`);
    await page.keyboard.press('Escape');
    await frame.waitForFunction(() => !document.querySelector('#nameplateDialog').open);
    check(await frame.locator('#preferencesDialog').evaluate(node => node.open), `${layout}: Escape returns to settings`);
    if (layout === 'narrow') {
      await frame.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      await openCard(frame); await capture('narrow-dark');
    }
    await page.close();
  }
  const build = await readFile(new URL('./build.mjs', import.meta.url), 'utf8');
  check(['nameplate.mjs', 'nameplate-reveal.mjs', 'nameplate-store.mjs', 'nameplate.css'].every(file => build.includes(`'${file}'`)), 'package includes new modules and stylesheet');
  assert.deepEqual(errors, []);
  console.log(`Nameplate native browser verification passed: ${checks} checks; four materials, persistence, interactions, reduced motion, English/Chinese, popup/modal/narrow, error/retry.`);
} catch (error) {
  if (screenshots && page && !page.isClosed()) await capture('failure').catch(() => {});
  throw error;
} finally {
  await context?.close(); await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
