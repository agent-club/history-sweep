import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { enterWorkspace } from './native-workspace.mjs';
import { agentDanceAtlasUrl } from '../extension/agent-dance-asset.mjs';
import { injectModal } from '../extension/modal-host.mjs';

const { chromium } = dependency('playwright');
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-modal-focus-'));
const server = createServer();
const autofocusWarnings = [];
const errors = [];
let context;

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.HISTORY_SWEEP_CHROMIUM,
    channel: process.env.HISTORY_SWEEP_CHROMIUM ? undefined : 'chromium', headless: true,
    viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionOrigin = `chrome-extension://${new URL(worker.url()).hostname}`;
  const page = await context.newPage();
  let danceDownloads = 0;
  const { promise: allowDanceDownload, resolve: finishDanceDownload } = Promise.withResolvers();
  await context.route(agentDanceAtlasUrl, async route => {
    danceDownloads++;
    const headers = { 'access-control-allow-origin': '*' };
    if (danceDownloads === 1) return route.fulfill({ status: 503, headers });
    await allowDanceDownload;
    if (process.env.HISTORY_SWEEP_LIVE_DANCE_ATLAS === '1') return route.continue();
    await route.fulfill({ path: join(extension, 'icons/agent-dance-motion.webp'), contentType: 'image/webp', headers });
  });
  page.on('pageerror', error => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  // Browser policy warnings are Log entries, rather than JavaScript exceptions.
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (/Blocked autofocusing/i.test(entry.text)) autofocusWarnings.push(entry.text);
  });
  await cdp.send('Log.enable');
  page.setDefaultTimeout(6000);
  await page.addInitScript(() => { localStorage.setItem('language', 'en'); });
  const localUrl = `http://127.0.0.1:${server.address().port}/site/`;
  await page.route(localUrl, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': "img-src 'none'" } });
  });
  await page.goto(localUrl);
  await page.bringToFront();
  // This launch identifier and history entry exist only in the disposable test profile.
  const syntheticLaunchId = crypto.randomUUID();
  await worker.evaluate(async ({ syntheticLaunchId, localUrl }) => {
    await chrome.history.addUrl({ url: localUrl });
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.storage.session.set({ modalLaunchSessions: { [syntheticLaunchId]: { tabId: tab.id, expires: Date.now() + 60000 } } });
  }, { syntheticLaunchId, localUrl });
  const navigation = page.waitForEvent('framenavigated', { predicate: frame => frame.url().startsWith(`${extensionOrigin}/modal.html`) });
  await page.evaluate(() => {
    // Inspect the closed shadow root in this fixture without changing its production mode.
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      Element.prototype.attachShadow = attachShadow;
      window.modalTestRoot = attachShadow.call(this, options);
      return window.modalTestRoot;
    };
  });
  await page.evaluate(injectModal, `${extensionOrigin}/modal.html#launch=${syntheticLaunchId}`);
  await navigation;
  const frame = page.frames().find(frame => frame.url().startsWith(`${extensionOrigin}/modal.html`));
  const frameCdp = await context.newCDPSession(frame);
  frameCdp.on('Log.entryAdded', ({ entry }) => {
    if (/Blocked autofocusing/i.test(entry.text)) autofocusWarnings.push(entry.text);
  });
  await frameCdp.send('Log.enable');
  await frame.waitForFunction(() => document.querySelector('#search') && !document.querySelector('#search').disabled);
  await enterWorkspace(frame);
  assert.deepEqual(autofocusWarnings, [], 'mount must not queue blocked autofocus');

  await page.waitForFunction(() => window.modalTestRoot.querySelector('.agent-peek:not([hidden])'));
  await frame.locator('#agentAccess').waitFor({ state: 'hidden' });
  assert.equal(await frame.locator('#agentAccess').isVisible(), false, 'wide modal has only the edge entry');
  const peek = await page.evaluate(() => {
    const button = window.modalTestRoot.querySelector('.agent-peek');
    const frames = button.querySelector('canvas');
    const art = frames.getContext('2d');
    const alpha = x => art.getImageData(x, 100, 1, 1).data[3];
    const style = getComputedStyle(button);
    const edge = window.modalTestRoot.querySelector('dialog').getBoundingClientRect().right;
    const box = button.getBoundingClientRect();
    return {
      x: box.x + box.width / 2, y: box.y + box.height / 2, edge, right: box.right,
      animations: button.getAnimations({ subtree: true }).length, surface: [style.backgroundColor, style.borderRightWidth],
      artwork: [frames.width, frames.height, alpha(0), alpha(80), alpha(236)],
    };
  });
  assert.deepEqual(peek.artwork.slice(0, 3), [312, 208, 0], 'the sheet has the expected size and transparent margin');
  assert.ok(peek.artwork.slice(3).every(alpha => alpha > 245), 'both sprite frames load even when the site blocks images');
  assert.ok(peek.x > peek.edge && peek.right < 1440, 'edge entry protrudes and fits within the viewport');
  assert.deepEqual(peek.surface, ['rgba(0, 0, 0, 0)', '0px'], 'the mascot has no visible button tile');
  assert.equal(peek.animations, 0, 'edge entry respects reduced motion');
  await frame.locator('#openVersion').focus();
  await page.keyboard.press('Shift+Tab');
  await page.waitForFunction(() => window.modalTestRoot.activeElement?.classList.contains('agent-peek'));
  await page.mouse.click(peek.x, peek.y);
  await frame.locator('#preferencesDialog[open] #settings-panel-agent').waitFor();
  assert.equal(await page.evaluate(() => window.modalTestRoot.querySelector('.agent-peek').hidden), true);
  const dock = frame.locator('#agentDanceDock');
  await dock.waitFor();
  const back = await frame.locator('#backPreferences').boundingBox();
  const agentDock = await dock.boundingBox();
  assert.ok(agentDock.x >= back.x + back.width && agentDock.x - back.x - back.width <= 12, 'the mascot docks beside the Back button');
  assert.equal(danceDownloads, 0, 'opening the workspace and Agent settings does not download the dance');
  await page.mouse.move(agentDock.x + agentDock.width / 2, agentDock.y + agentDock.height / 2);
  await page.mouse.down();
  await page.mouse.move(560, 440, { steps: 8 });
  await page.waitForFunction(() => {
    const pose = window.modalTestRoot.querySelector('.agent-dance-stage:not([hidden]):not([data-dancing]) .agent-dancer:not([hidden])');
    if (!pose) return false;
    const box = pose.getBoundingClientRect();
    return Math.abs(box.x + box.width / 2 - 560) < 3 && Math.abs(box.y + box.height / 2 - 440) < 3;
  });
  assert.equal(danceDownloads, 0, 'the bundled drag pose is visible before downloading the atlas');
  await page.mouse.up();
  await frame.waitForFunction(() => document.querySelector('#agentDanceDock').title.includes('download failed'));
  assert.equal(await dock.getAttribute('aria-busy'), 'false');
  assert.equal(await page.evaluate(() => window.modalTestRoot.querySelector('.agent-dance-stop').hidden), true);
  assert.equal(await page.evaluate(() => window.modalTestRoot.querySelector('.agent-dance-stage').hidden), true);
  assert.match(await page.evaluate(() => window.modalTestRoot.querySelector('.agent-dance-load-status').textContent), /download failed/);
  assert.equal(danceDownloads, 1);

  await dock.press('Enter');
  await frame.locator('#agentDanceDock[aria-busy=true]').waitFor();
  assert.match(await page.evaluate(() => window.modalTestRoot.querySelector('.agent-dance-load-status').textContent), /Downloading dance artwork/);
  await page.keyboard.press('Escape');
  await frame.locator('#agentDanceDock[aria-busy=false]').waitFor();
  assert.ok(await dock.isVisible(), 'Escape cancels pending playback and keeps Agent settings open');
  finishDanceDownload();
  await page.waitForFunction(() => window.modalTestRoot.querySelector('.agent-dance-frames').height === 330);
  assert.equal(await page.evaluate(() => window.modalTestRoot.querySelector('.agent-dance-stop').hidden), true, 'a late download does not restart a canceled dance');
  const danceArt = await page.evaluate(() => {
    const canvas = window.modalTestRoot.querySelector('.agent-dance-frames');
    return [canvas.width, canvas.height, canvas.getContext('2d').getImageData(150, 125, 1, 1).data[3]];
  });
  assert.deepEqual(danceArt.slice(0, 2), [300, 330], 'the canvas uses the full-resolution dance frames');
  assert.ok(danceArt[2] > 200, 'the downloaded dance sprite includes the robot head');
  const cachedDanceArt = await worker.evaluate(async url => {
    const cached = await caches.match(url);
    const bitmap = await createImageBitmap(await cached.blob());
    const dimensions = [bitmap.width, bitmap.height];
    bitmap.close();
    return dimensions;
  }, agentDanceAtlasUrl);
  assert.deepEqual(cachedDanceArt, [4096, 5760], 'the asset cache is shared with the extension origin');
  assert.equal(danceDownloads, 2, 'the cached atlas needs no further download');
  await context.setOffline(true);
  const offlineAtlas = await frame.evaluate(async () => {
    const { loadAgentDanceAtlas } = await import(chrome.runtime.getURL('agent-dance-asset.mjs'));
    const bitmap = await loadAgentDanceAtlas();
    const dimensions = [bitmap.width, bitmap.height];
    bitmap.close();
    return dimensions;
  });
  assert.deepEqual(offlineAtlas, [4096, 5760], 'a fresh atlas load works from persistent cache while offline');
  await dock.press('Enter');
  await page.waitForFunction(() => !window.modalTestRoot.querySelector('.agent-dance-stop').hidden);
  assert.equal(danceDownloads, 2, 'offline playback makes no atlas request');
  await context.setOffline(false);
  assert.equal(await page.evaluate(() => window.modalTestRoot.querySelector('.agent-dance-stage').getAnimations({ subtree: true }).length), 0, 'reduced motion shows a stationary pose');
  await page.keyboard.press('Escape');
  await frame.waitForFunction(() => document.querySelector('#preferencesDialog').open && document.activeElement.id === 'agentDanceDock');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.modalTestRoot.activeElement?.classList.contains('agent-peek'));
  await page.keyboard.press('Enter');
  await frame.locator('#preferencesDialog[open] #settings-panel-agent').waitFor();
  await page.setViewportSize({ width: 900, height: 750 });
  await page.keyboard.press('Escape');
  await frame.waitForFunction(() => document.activeElement.id === 'agentAccess' && !document.activeElement.hidden);
  await frame.locator('#agentAccess').click();
  await frame.locator('#preferencesDialog[open] #settings-panel-agent').waitFor();
  await dock.waitFor();
  await page.keyboard.press('Escape');
  await frame.waitForFunction(() => !document.querySelector('#preferencesDialog').open);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => window.modalTestRoot.activeElement?.classList.contains('agent-peek'));

  await frame.locator('#openPreferences').focus();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.mouse.move(peek.x, peek.y);
  await page.waitForFunction(() => {
    const frames = window.modalTestRoot.querySelector('.peek-frames');
    const transform = getComputedStyle(frames).transform;
    return new DOMMatrixReadOnly(transform === 'none' ? undefined : transform).m41 === -frames.parentElement.offsetWidth;
  });
  await page.mouse.move(20, 20);
  await page.waitForFunction(() => window.modalTestRoot.querySelector('.peek-frames').getAnimations().some(animation => animation.animationName === 'peek-blink'));
  await worker.evaluate(() => chrome.storage.session.set({ agentMcpWorking: true }));
  await page.waitForFunction(() => window.modalTestRoot.querySelector('.agent-peek[data-busy] .peek-signal')?.getAnimations().length > 0);
  await worker.evaluate(() => chrome.storage.session.remove('agentMcpWorking'));
  await page.waitForFunction(() => !window.modalTestRoot.querySelector('.agent-peek').hasAttribute('data-busy'));

  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.waitForFunction(() => window.modalTestRoot.querySelector('.agent-dance-stage:not([hidden]):not([data-dancing]) .agent-dancer:not([hidden])'));
    await page.mouse.up();
    await page.waitForFunction(() => window.modalTestRoot.querySelector('.agent-dance-stage[data-dancing]:not([hidden])'));
  };
  await drag(peek, { x: 850, y: 430 });
  assert.equal(await frame.locator('#preferencesDialog').evaluate(dialog => dialog.open), false, 'dragging does not activate the settings click');
  const stop = await page.evaluate(() => {
    const box = window.modalTestRoot.querySelector('.agent-dance-stop').getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  await page.mouse.click(stop.x, stop.y);
  await page.waitForFunction(() => window.modalTestRoot.querySelector('.agent-dance-stage').hidden);
  assert.equal(await page.evaluate(() => window.modalTestRoot.querySelector('.agent-peek').hasAttribute('data-performing')), false);

  await drag(peek, { x: 850, y: 430 });
  await page.waitForFunction(() => window.modalTestRoot.querySelector('.agent-dancer').getAnimations()[0]?.currentTime >= 10000, null, { timeout: 15000 });
  await page.waitForFunction(() => window.modalTestRoot.querySelector('.agent-dance-stage').hidden);
  assert.equal(await page.evaluate(() => {
    const button = window.modalTestRoot.querySelector('.agent-peek');
    return !button.hidden && !button.hasAttribute('data-performing') && window.modalTestRoot.activeElement === button;
  }), true, 'the outer mascot peeks out again after hopping behind the rim');

  await page.mouse.click(peek.x, peek.y);
  await dock.waitFor();
  await dock.press('Enter');
  await page.waitForFunction(() => !window.modalTestRoot.querySelector('.agent-dance-stop').hidden);
  await frame.locator('#agentDanceDock[data-performing]').waitFor();
  await page.waitForFunction(() => getComputedStyle(window.modalTestRoot.querySelector('.agent-dance-lighting')).opacity === '1');
  const lightingAnimations = await page.evaluate(() => window.modalTestRoot
    .querySelector('.agent-dance-lighting').getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length);
  assert.equal(lightingAnimations, 0, 'the stage lighting stays steady after its entrance');
  await frame.locator('#backPreferences').focus();
  const lighting = await page.evaluate(async () => {
    const root = window.modalTestRoot;
    const light = root.querySelector('.agent-dance-lighting');
    const style = getComputedStyle(light);
    await Promise.allSettled(light.getAnimations().map(animation => animation.finished));
    return [root.activeElement?.tagName, style.opacity, style.visibility, style.pointerEvents];
  });
  assert.deepEqual(lighting, ['IFRAME', '1', 'visible', 'none'], 'moving focus into the iframe keeps the stage visible and the controls reachable');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.modalTestRoot.querySelector('.agent-dance-stage').hidden);
  await page.waitForFunction(() => getComputedStyle(window.modalTestRoot.querySelector('.agent-dance-lighting')).visibility === 'hidden');
  assert.equal(await frame.locator('#preferencesDialog').evaluate(dialog => dialog.open), true, 'Escape in the iframe ends the dance before closing Agent settings');
  const from = await dock.boundingBox();
  await drag({ x: from.x + 7, y: from.y + from.height / 2 }, { x: 560, y: 440 });
  const choreography = await page.evaluate(() => {
    const movement = window.modalTestRoot.querySelector('.agent-dancer').getAnimations()[0];
    const canvas = window.modalTestRoot.querySelector('.agent-dance-frames');
    const keyframes = movement.effect.getKeyframes();
    const panel = window.modalTestRoot.querySelector('dialog').getBoundingClientRect();
    const dancer = canvas.closest('.agent-dancer');
    const duration = movement.effect.getTiming().duration;
    const departure = new DOMMatrixReadOnly(keyframes[300].transform);
    const airborne = new DOMMatrixReadOnly(keyframes[309].transform);
    const endpoint = new DOMMatrixReadOnly(keyframes.at(-1).transform);
    const flight = (airborne.e - departure.e) / (endpoint.e - departure.e);
    const jumpHeight = departure.f + (endpoint.f - departure.f) * flight - airborne.f;
    return {
      duration, danceEnd: keyframes[300].offset * duration, poses: keyframes.length, sprite: canvas.toDataURL(), jumpHeight,
      returnX: panel.left + endpoint.e + dancer.offsetWidth / 2, danceClip: getComputedStyle(dancer).clipPath,
    };
  });
  assert.ok(Math.abs(choreography.danceEnd - 10000) < 1, 'the hideaway hop starts after ten seconds of dancing');
  assert.ok(choreography.duration > 10600 && choreography.duration <= 10800);
  assert.equal(choreography.poses, 320, 'the atlas has 300 dance poses followed by 20 hideaway poses');
  assert.ok(choreography.jumpHeight > 25, 'the robot rises above the straight return path');
  assert.equal(choreography.danceClip, 'none', 'the robot stays unclipped during the main dance');
  assert.ok(Math.abs(choreography.returnX - from.x - from.width / 2) < 2, 'off-center grabs return to the center of the settings dock');
  await page.waitForFunction(first => window.modalTestRoot.querySelector('.agent-dance-frames').toDataURL() !== first, choreography.sprite);
  const grip = await page.evaluate(() => {
    const bounds = window.modalTestRoot.querySelector('.agent-dance-grip').getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  });
  const destination = { x: grip.x + 142, y: grip.y + 82 };
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  await page.mouse.move(destination.x, destination.y, { steps: 8 });
  await page.waitForFunction(({ x, y }) => {
    const root = window.modalTestRoot;
    const bounds = root.querySelector('.agent-dance-grip').getBoundingClientRect();
    return root.querySelector('.agent-dance-stage').hasAttribute('data-capture')
      && Math.abs(bounds.x + bounds.width / 2 - x) < 12 && Math.abs(bounds.y + bounds.height / 2 - y) < 12;
  }, destination);
  const grabbedTime = await page.evaluate(() => window.modalTestRoot.querySelector('.agent-dancer').getAnimations()[0].currentTime);
  await page.waitForFunction(time => window.modalTestRoot.querySelector('.agent-dancer').getAnimations()[0].currentTime > time + 100, grabbedTime);
  await page.mouse.up();
  await page.waitForFunction(() => {
    const root = window.modalTestRoot;
    return !root.querySelector('.agent-dance-stage').hasAttribute('data-capture') && root.querySelector('.agent-dancer').style.translate;
  });
  await page.waitForFunction(() => {
    const dancer = window.modalTestRoot.querySelector('.agent-dancer');
    return /^inset\(0px 0px [\d.]+%\)/.test(getComputedStyle(dancer).clipPath);
  }, null, { timeout: 15000 });
  await page.waitForFunction(() => window.modalTestRoot.querySelector('.agent-dance-stage').hidden, null, { timeout: 15000 });
  await frame.waitForFunction(() => document.querySelector('#preferencesDialog').open && document.activeElement.id === 'agentDanceDock');
  await page.keyboard.press('Escape');
  await frame.waitForFunction(() => !document.querySelector('#preferencesDialog').open);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  for (const language of ['zh-CN', 'en']) {
    await frame.locator(`#language [data-language="${language}"]`).click();
    await frame.waitForFunction(language => document.documentElement.lang === language, language);
    const agentLabel = await frame.locator('#agentAccess').getAttribute('aria-label');
    await page.waitForFunction(label => window.modalTestRoot.querySelector('.agent-peek').ariaLabel === label, agentLabel);
    await frame.locator('#openPreferences').click();
    await frame.waitForFunction(() => !document.querySelector('#savePreferences').disabled);
    assert.equal(await frame.evaluate(() => document.activeElement.id), 'backPreferences');
    await frame.locator('[data-settings-section=privacy]').click();
    await frame.locator('#privateCleanup').check();
    await frame.locator('#dismissPreferences').click();
    await frame.waitForFunction(() => document.querySelector('#unsavedPreferencesDialog').open);
    assert.equal(await frame.evaluate(() => document.activeElement.id), 'keepEditingPreferences');
    await frame.locator('#discardPreferences').click();
    await frame.waitForFunction(() => !document.querySelector('#preferencesDialog').open);
  }

  await frame.locator('#query').fill('127.0.0.1');
  await frame.locator('#search').click();
  await frame.waitForFunction(() => !document.querySelector('#selectAll').disabled);
  await frame.locator('#selectAll').click();
  await frame.locator('#openFull').click();
  await frame.waitForFunction(() => document.querySelector('#openFullDialog').open);
  assert.equal(await frame.evaluate(() => document.activeElement.value), 'cancel');
  await frame.locator('#openFullDialog [value=cancel]').click();
  await frame.locator('#delete').click();
  await frame.waitForFunction(() => document.querySelector('#confirmDialog').open);
  assert.ok(await frame.locator('#confirmDialog [value=cancel]').evaluate(node => node === document.activeElement), 'deletion initially focuses the safe action');
  await frame.locator('#confirmDialog [value=cancel]').click();

  await frame.locator('#delete').click();
  await frame.locator('#confirmDialog [value=confirm]').click();
  await frame.locator('#completionFeedback').waitFor();
  assert.equal(await frame.locator('#ratingDialog').isVisible(), false, 'rating waits for the cleanup result to retire');
  await frame.locator('#ratingDialog').waitFor();
  assert.equal(await frame.locator('#completionFeedback').isVisible(), false);
  assert.equal(await frame.evaluate(() => document.activeElement.id), 'skipRating');
  await page.keyboard.press('Tab');
  assert.equal(await frame.evaluate(() => document.activeElement.id), 'rateInStore');
  await page.keyboard.press('Escape');
  await frame.locator('#ratingDialog').waitFor({ state: 'hidden' });
  assert.equal(await frame.locator('#query').isVisible(), true, 'Escape dismisses only the rating dialog');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    const dialog = window.modalTestRoot.querySelector('dialog');
    window.modalExitOpacity = new Promise(resolve => {
      const samples = [];
      function sample() {
        if (!dialog.open) { resolve(samples); return; }
        samples.push(Number(getComputedStyle(dialog, '::backdrop').opacity));
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
  });
  const detached = page.waitForEvent('framedetached', { predicate: item => item === frame });
  await frame.locator('#closeModalWorkspace').click();
  await detached;
  const exitOpacity = await page.evaluate(() => window.modalExitOpacity);
  assert.ok(exitOpacity.some(opacity => opacity > 0 && opacity < 1), 'the backdrop fades before the modal leaves the top layer');

  assert.deepEqual(autofocusWarnings, [], 'mount, language remounts and dialogs must not log blocked autofocus');
  assert.deepEqual(errors, []);
  console.log('Native modal checks passed: Agent docks, drag, ten-second dance, manual stop, reduced motion, keyboard focus, both languages and workspace actions. Disposable profile only.');
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
