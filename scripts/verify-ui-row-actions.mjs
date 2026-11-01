import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { dependency } from './runtime.mjs';
import { enterWorkspace } from './native-workspace.mjs';

const { values } = parseArgs({ options: {
  output: { type: 'string' }, browser: { type: 'string' },
  extension: { type: 'string' }, 'touch-only': { type: 'boolean', default: false },
} });
const root = fileURLToPath(new URL('../', import.meta.url));
const extension = values.extension ? resolve(values.extension) : join(root, 'extension');
const parent = resolve(values.output || tmpdir());
await mkdir(parent, { recursive: true });
const output = await mkdtemp(join(parent, 'row-actions-'));
const resultPath = join(output, 'result.json');
const contract = 'history-row-actions-v1';
const syntheticUrls = ['https://reading.example/article/1', 'https://reading.example/article/2'];
const started = Date.now();
const result = { contract, status: 'failed', startedAt: new Date(started).toISOString(), checks: [], samples: [], screenshots: [], sourceSnapshot: {}, error: null };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(join(root, '.ui-acceptance.json'), 'utf8'));
const scope = manifest.scopes.find(item => item.checks?.some(check => check.id === contract));
assert.ok(scope, 'row action contract is declared in .ui-acceptance.json');
const sourceFiles = [...new Set(['.ui-acceptance.json', ...scope.source_files])].sort();
const snapshot = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async name => {
  const path = name.startsWith('extension/') ? join(extension, name.slice('extension/'.length)) : join(root, name);
  return [name, sha256(await readFile(path))];
})));
const check = (condition, id, label, observed = null) => {
  result.checks.push({ id, label, passed: Boolean(condition), observed });
  assert.ok(condition, label);
};
const frames = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
const bounds = locator => locator.evaluate(element => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
});
const stableRect = (a, b) => ['x', 'y', 'width', 'height'].every(key => Math.abs(a[key] - b[key]) < 0.5);
const actionState = locator => locator.evaluate(element => {
  const style = getComputedStyle(element);
  return { opacity: Number(style.opacity), pointer: style.pointerEvents, focus: element === document.activeElement,
    focusVisible: element.matches(':focus-visible'), outlineWidth: parseFloat(style.outlineWidth),
    outlineStyle: style.outlineStyle, outlineColor: style.outlineColor, hover: element.closest('.history-row')?.matches(':hover') || false };
});
const shown = state => state.opacity === 1 && state.pointer !== 'none';
const hidden = state => state.opacity === 0 && state.pointer === 'none';
const capture = async (page, name) => {
  const path = join(output, `${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  result.screenshots.push(path);
};
const sampleGeometry = row => row.evaluate(element => {
  const measure = target => {
    const { x, y, width, height } = target.getBoundingClientRect();
    return { x, y, width, height, centerY: y + height / 2 };
  };
  const more = element.querySelector('.wt-row-more'), remove = element.querySelector('.row-delete');
  return { more: measure(more), remove: measure(remove), moreIcon: measure(more.querySelector('img')), removeIcon: measure(remove.querySelector('img')) };
});
const keyboardTo = async (page, row, action) => {
  // Focus starts on the row's checkbox; only actual Tab input reaches the action.
  // Moving the pointer out is necessary: hover must not mask a broken focus rule.
  await page.mouse.move(0, 0);
  await row.locator('.row-select').focus();
  for (let count = 0; count < 20; count++) {
    await page.keyboard.press('Tab');
    if (await action.evaluate(element => element === document.activeElement)) return;
  }
  throw new Error('Action is not reachable with Tab from its row');
};
const inspect = async (page, layout, touch) => {
  const input = await page.evaluate(() => ({ hover: matchMedia('(hover: hover)').matches, coarse: matchMedia('(pointer: coarse)').matches, touchPoints: navigator.maxTouchPoints }));
  check(touch ? input.coarse && !input.hover : !input.coarse && input.hover, 'input-modality', `${layout}: browser actually uses the requested input mode`, input);
  const rows = page.locator('.history-row');
  check(await rows.count() === 2, 'fixture-records', `${layout}: both synthetic records rendered`, await rows.count());
  const rowUrls = await rows.locator('.row-select').evaluateAll(elements => elements.map(element => element.dataset.url).sort());
  check(JSON.stringify(rowUrls) === JSON.stringify(syntheticUrls), 'fixture-distinct-records', `${layout}: both distinct fixture URLs are rendered exactly once`, rowUrls);
  for (let index = 0; index < 2; index++) {
    const label = `${layout}/row-${index + 1}`;
    const row = rows.nth(index), more = row.locator('.wt-row-more'), remove = row.locator('.row-delete');
    const group = page.locator('.website-group').filter({ has: row });
    const task = group.locator('.group-auto-cleanup');
    const url = await row.locator('.row-select').getAttribute('data-url');
    check(syntheticUrls.includes(url), 'fixture-record-url', `${label}: expected record identity`, url);
    await row.scrollIntoViewIfNeeded();
    await page.locator('#search').focus();
    await page.mouse.move(0, 0);
    await frames(page);
    const before = await bounds(row);
    const idle = { more: await actionState(more), remove: await actionState(remove), task: await actionState(task) };
    result.samples.push({ layout, row: index + 1, url, state: 'idle', observed: idle });
    check(touch ? Object.values(idle).every(shown) : Object.values(idle).every(hidden), touch ? 'touch-visible' : 'idle-hidden', `${label}: ${touch ? 'touch actions remain visible' : 'inactive actions are hidden'}`, idle);
    await capture(page, `${layout}-${index + 1}-idle`);
    if (!touch) {
      await row.locator('.page-url').hover();
      await frames(page);
      const hover = { more: await actionState(more), remove: await actionState(remove), task: await actionState(task) };
      check(Object.values(hover).every(shown), 'child-hover-visible', `${label}: hovering child content reveals row actions and group task`, hover);
    }
    const geometry = await sampleGeometry(row);
    result.samples.push({ layout, row: index + 1, url, state: touch ? 'touch' : 'hover', observed: geometry });
    const target = touch ? { width: 44, height: 44 } : { width: 28, height: 34 };
    const sameSize = geometry.more.width === geometry.remove.width && geometry.more.height === geometry.remove.height;
    check(sameSize && [geometry.more, geometry.remove].every(item => item.width >= target.width && item.height >= target.height), 'button-target', `${label}: action targets match and meet the current layout minimum`, { target, geometry });
    check(Math.abs(geometry.more.centerY - geometry.remove.centerY) < 1, 'button-vertical-center', `${label}: button centers align`, geometry);
    check(Math.abs(geometry.moreIcon.centerY - geometry.removeIcon.centerY) < 1, 'icon-vertical-center', `${label}: icon boxes align`, geometry);
    const iconsCentered = [[geometry.more, geometry.moreIcon], [geometry.remove, geometry.removeIcon]].every(([button, icon]) => Math.abs(button.centerY - icon.centerY) < 1);
    check(iconsCentered, 'icon-in-button', `${label}: icon boxes are centered within their buttons`, geometry);
    const ordered = [geometry.more, geometry.remove].sort((a, b) => a.x - b.x);
    check(ordered[1].x - ordered[0].x - ordered[0].width >= 2, 'button-gap', `${label}: action targets do not overlap`, geometry);
    check(stableRect(before, await bounds(row)), 'stable-row', `${label}: revealing actions does not move the row`, { before, after: await bounds(row) });
    await capture(page, `${layout}-${index + 1}-revealed`);
    if (!touch) {
      for (const [name, action] of [['remove', remove], ['more', more]]) {
        await keyboardTo(page, row, action);
        await frames(page);
        const state = await actionState(action), sibling = await actionState(name === 'more' ? remove : more);
        const taskState = await actionState(task);
        result.samples.push({ layout, row: index + 1, url, state: `keyboard-${name}`, observed: { action: state, sibling, task: taskState } });
        check(!state.hover && state.focus && state.focusVisible && shown(state) && shown(sibling) && shown(taskState), 'keyboard-visible', `${label}: ${name} is revealed by Tab without hover`, { state, sibling, task: taskState });
        check(state.outlineWidth >= 1 && state.outlineStyle !== 'none' && !['transparent', 'rgba(0, 0, 0, 0)'].includes(state.outlineColor), 'keyboard-indicator', `${label}: ${name} has a visible focus outline`, state);
        check(stableRect(before, await bounds(row)), 'stable-row', `${label}: keyboard focus does not move the row`, { before, after: await bounds(row) });
        await capture(page, `${layout}-${index + 1}-keyboard-${name}`);
      }
      await more.press('Enter');
    } else await more.tap();
    const menu = page.locator('#workspaceDialog');
    await menu.waitFor({ state: 'visible' });
    const observedUrl = await menu.locator('.wt-url').textContent();
    check(observedUrl === url, 'menu-record', `${label}: opened menu belongs to the clicked record`, { expected: url, actual: observedUrl });
    check(await menu.locator('.wt-menu-list button').count() > 0, 'menu-actions', `${label}: record menu contains actions`);
    await capture(page, `${layout}-${index + 1}-menu`);
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    if (!touch) await keyboardTo(page, row, remove);
    else await remove.tap();
    if (!touch) await remove.press('Enter');
    await page.locator('#confirmDialog').waitFor({ state: 'visible' });
    await page.locator('#deletePreview .preview-site > summary').click();
    await page.locator('#deletePreview small').first().waitFor({ state: 'visible' });
    const previewUrls = await page.locator('#deletePreview small').allTextContents();
    check(previewUrls.length === 1 && previewUrls[0] === url, 'delete-record', `${label}: confirmation targets only this record`, previewUrls);
    await page.locator('#confirmDialog [value=cancel]').click();
    await page.locator('#confirmDialog').waitFor({ state: 'hidden' });
  }
  const task = page.locator('.group-auto-cleanup').first();
  if (!touch) await page.locator('.group-toggle').first().hover();
  check(shown(await actionState(task)), 'heading-hover-visible', `${layout}: group task remains reachable from heading`);
  await task.click();
  await page.locator('#cleanupSettingsContent [data-auto-id=ruleEditor]').waitFor({ state: 'visible' });
  check(await page.locator('#cleanupSettingsContent [data-auto-id=ruleDomain]').inputValue() === 'reading.example', 'group-record', `${layout}: group task opens the matching website editor`);
  await page.locator('#dismissPreferences').click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  check(!overflow, 'horizontal-overflow', `${layout}: no horizontal overflow`, overflow);
};

const { chromium } = dependency('playwright');
const executable = values.browser || process.env.HISTORY_SWEEP_CHROMIUM;
let context;
const errors = [];
try {
  result.sourceSnapshot.before = await snapshot();
  const modes = values['touch-only'] ? [true] : [false, true];
  for (const touch of modes) {
    context = await chromium.launchPersistentContext(join(output, touch ? 'touch-profile' : 'desktop-profile'), {
      ...(executable ? { executablePath: executable } : { channel: 'chromium' }), headless: true,
      reducedMotion: 'reduce', hasTouch: touch, isMobile: touch, timezoneId: 'Asia/Shanghai',
      viewport: { width: touch ? 390 : 1280, height: 850 },
      args: ['--disable-background-networking', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    context.setDefaultTimeout(8000);
    await context.route(/^https?:\/\//, route => route.abort());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 8000 });
    const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
    result.environment = { browser: context.browser().version(), nativeExtension: true, data: 'isolated synthetic history', network: 'HTTP(S) blocked' };
    await worker.evaluate(async urls => {
      await chrome.storage.local.set({ browsingPreferences: { view: 'website', range: 'all' } });
      for (const url of urls) await chrome.history.addUrl({ url });
    }, syntheticUrls);
    const layouts = touch ? [{ name: 'touch', path: 'manager', width: 390 }] : [{ name: 'wide', path: 'manager', width: 1280 }, { name: 'popup', path: 'popup', width: 440 }];
    for (const layout of layouts) {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewportSize({ width: layout.width, height: 850 });
      await page.goto(`${origin}/${layout.path}.html`);
      if (touch) {
        // Extension-page navigation can reset context-level touch emulation.
        // Set it on the final target and verify the actual media queries below.
        const session = await context.newCDPSession(page);
        await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      }
      await enterWorkspace(page);
      await page.locator('#query').fill('reading.example');
      await page.locator('#search').click();
      await page.waitForFunction(() => !document.querySelector('#search').disabled);
      await page.evaluate(() => document.fonts.ready);
      await inspect(page, layout.name, touch);
      const historyUrls = await worker.evaluate(async () => (await chrome.history.search({ text: 'reading.example', startTime: 0 })).map(item => item.url).sort());
      check(historyUrls.length === 2, 'cancel-preserves-history', `${layout.name}: cancelling deletion preserves both synthetic records`, historyUrls);
      await page.close();
    }
    await context.close(); context = null;
  }
  check(errors.length === 0, 'runtime-errors', 'no browser exceptions', errors);
  result.status = 'passed';
} catch (error) {
  result.error = { message: error.message };
  process.exitCode = 1;
} finally {
  await context?.close();
  for (const name of ['desktop-profile', 'touch-profile']) await rm(join(output, name), { recursive: true, force: true });
  result.sourceSnapshot.after = await snapshot();
  const stable = JSON.stringify(result.sourceSnapshot.before) === JSON.stringify(result.sourceSnapshot.after);
  result.checks.push({ id: 'source-stability', label: 'declared source bytes unchanged through browser cleanup', passed: stable, observed: null });
  if (!stable) {
    result.status = 'failed'; result.error = { message: 'Declared source changed during verification' }; process.exitCode = 1;
  }
  result.durationMs = Date.now() - started;
  await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ contract, status: result.status, checks: result.checks.length, result: resultPath }));
}
