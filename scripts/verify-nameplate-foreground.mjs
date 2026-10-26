import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';

const { chromium } = dependency('playwright');
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-nameplate-foreground-'));
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
let context, checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  // Exercise visibility events in the real extension UI, with background state simulated
  // as in verify-foreground.mjs. Keep the browser's real clock and rendering loop.
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.HISTORY_SWEEP_CHROMIUM,
    channel: process.env.HISTORY_SWEEP_CHROMIUM ? undefined : 'chromium', headless: true,
    viewport: { width: 1200, height: 900 }, reducedMotion: 'no-preference',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--disable-features=DisableLoadExtensionCommandLineSwitch'],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(document, 'hidden', { get: () => window.__nameplateHidden || false });
  });
  await page.goto(`chrome-extension://${new URL(worker.url()).hostname}/manager.html`);
  const phase = () => page.locator('.np-preview').getAttribute('data-phase');
  const snapshot = () => page.locator('.np-object').evaluate(node => ({
    transform: node.style.transform, opacity: node.style.opacity,
    background: document.querySelector('#nameplateDialog').style.getPropertyValue('--np-background-opacity'),
  }));
  async function background(duration) {
    await page.evaluate(() => {
      window.__nameplateHidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
    });
    const before = await snapshot();
    await pause(duration);
    assert.deepEqual(await snapshot(), before, 'hidden animation retains its rendered frame'); checks++;
    await page.evaluate(() => {
      window.dispatchEvent(new Event('pageshow'));
      window.__nameplateHidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pageshow'));
    });
    await pause(80);
  }
  await page.locator('.np-preview[data-phase=revealing]').waitFor();
  await pause(550);
  for (let i = 0; i < 2; i++) {
    await background(2500);
    check(await phase() === 'revealing', 'opening resumes after a background interval longer than the entire reveal');
    check(await page.locator('.np-orbit-particle').count() === 64, 'opening particles survive foreground return');
  }
  await page.locator('.np-preview[data-phase=settled]').waitFor();
  const rotation = await snapshot(); await pause(150);
  check(rotation.transform !== (await snapshot()).transform, 'rotation continues after opening completes');
  await page.locator('.np-motion').click();
  await pause(80);
  const stopped = await snapshot();
  await background(250);
  assert.deepEqual(await snapshot(), stopped, 'foreground return preserves user-paused rotation'); checks++;
  await page.locator('.np-collect').click();
  await page.locator('.np-preview[data-phase=collecting]').waitFor();
  await pause(200);
  for (let i = 0; i < 2; i++) {
    await background(1400);
    check(await phase() === 'collecting', 'collection resumes instead of immediately closing');
    check(await page.locator('#nameplateDialog').evaluate(node => node.open), 'dialog remains open during resumed collection');
    const alpha = +(await snapshot()).background;
    check(alpha > 0 && alpha < 1, 'resumed collection retains gradual background fade');
  }
  await page.waitForFunction(() => !document.querySelector('#nameplateDialog').open);
  await page.waitForFunction(() => !document.body.dataset.startup);
  check(await page.locator('#app').evaluate(node => !node.inert), 'completed collection restores workspace interaction');
  assert.deepEqual(errors, []);
  console.log(`Nameplate foreground verification passed: ${checks} checks; simulated visibility/page lifecycle, repeated opening/collection suspension, rotation and background fade.`);
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
