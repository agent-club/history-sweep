import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { enterWorkspace } from './native-workspace.mjs';

const output = await mkdtemp(join(tmpdir(), 'history-sweep-labels-'));
const profile = join(output, 'profile');
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const executablePath = process.env.HISTORY_SWEEP_CHROMIUM;
const context = await dependency('playwright').chromium.launchPersistentContext(profile, {
  ...(executablePath ? { executablePath } : { channel: 'chromium' }), headless: true,
  viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce',
  args: ['--disable-background-networking', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const errors = [], screenshots = [];
let checks = 0;
const check = (result, message) => { assert.ok(result, message); checks++; };
try {
  // Reserved domains and a disposable profile keep real history and personal images out of evidence.
  await context.route(/^https?:\/\//, route => route.fulfill({ contentType: 'text/html', body: '<title>Synthetic reading notes</title>' }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://reading.example/article');
  const manager = `chrome-extension://${new URL(worker.url()).host}/manager.html`;
  await page.goto(manager); await enterWorkspace(page);
  await page.getByRole('button', { name: '简体中文', exact: true }).click();
  const search = async () => {
    await page.locator('#query').fill('reading.example'); await page.locator('#query').press('Escape');
    await page.locator('#search').click();
    await page.waitForFunction(() => !document.querySelector('#search').disabled);
  };
  const open = async () => {
    await page.getByRole('button', { name: '编辑网站标签 · reading.example', exact: true }).click();
    await page.locator('#workspaceDialog').waitFor({ state: 'visible' });
  };
  const dialog = page.locator('#workspaceDialog');
  const save = async () => { await dialog.locator('[type=submit]').click(); await dialog.waitFor({ state: 'hidden' }); };
  const labels = () => page.evaluate(async () => (await chrome.storage.local.get('workspaceTools')).workspaceTools.labels['reading.example']);
  const capture = async name => {
    const path = join(output, `${name}.png`); await page.screenshot({ path, animations: 'disabled' }); screenshots.push(path);
    check(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${name}: dialog has no horizontal overflow`);
    check(await dialog.locator('.wt-label-editor').evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${name}: editor has no horizontal overflow`);
  };
  await search(); await open();
  check(await dialog.locator('.wt-label-editor').isHidden(), 'empty labels hide appearance controls');
  await dialog.getByLabel('我的标签', { exact: true }).fill('工作\n阅读');
  await dialog.getByRole('button', { name: '鼠尾草', exact: true }).click();
  await dialog.getByRole('button', { name: '轻波纹', exact: true }).click();
  await dialog.locator('.wt-label-preview-item').filter({ hasText: /^阅读$/ }).focus();
  await page.keyboard.press('Enter');
  check(await dialog.locator('.wt-label-preview-item').filter({ hasText: /^阅读$/ }).evaluate(element => document.activeElement === element), 'keyboard selection keeps focus on the selected label');
  await dialog.getByRole('button', { name: '薰衣草', exact: true }).click();
  await capture('01-labels-desktop'); await save();
  const stored = await labels();
  check(stored.styles['工作'].image === 'waves' && stored.styles['阅读'].background === '#efe9f6', 'worker persists independent label styles');
  check(await page.locator('.wt-group-labels .wt-label').first().evaluate(element => element.style.backgroundImage.includes('svg+xml') && element.style.color === 'rgb(49, 91, 73)'), 'real website heading renders the selected color and built-in image');
  const resultPath = join(output, '00-labels-in-results.png');
  await page.locator('.wt-group-labels').screenshot({ path: resultPath, animations: 'disabled' }); screenshots.push(resultPath);
  await open(); await dialog.getByRole('button', { name: '柔雾粉', exact: true }).click();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  check(JSON.stringify(await labels()) === JSON.stringify(stored), 'cancel leaves persisted styles unchanged');
  await page.reload(); await enterWorkspace(page); await search(); await open();
  check(await dialog.getByRole('button', { name: '鼠尾草', exact: true }).getAttribute('aria-pressed') === 'true', 'reopening after reload restores the selected palette');
  await dialog.getByLabel('文字颜色', { exact: true }).fill('#183c32');
  await dialog.getByLabel('背景颜色', { exact: true }).fill('#dcebe0');
  const image = await dependency('sharp')({ create: { width: 600, height: 300, channels: 3, background: '#788ca2' } }).png().toBuffer();
  await dialog.locator('input[type=file]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: image });
  await page.waitForFunction(() => document.querySelector('.wt-label-upload-row button')?.getAttribute('aria-pressed') === 'true');
  await save();
  const custom = await labels();
  check(custom.styles['工作'].foreground === '#183c32' && custom.styles['工作'].background === '#dcebe0', 'custom text and background colors persist');
  check(custom.styles['工作'].image.startsWith('data:image/webp;base64,') && custom.styles['工作'].image.length < 80000, 'local image is reduced to an inline raster before persistence');
  check(await page.locator('.wt-group-labels .wt-label').first().evaluate(element => element.style.backgroundImage.includes('data:image/webp')), 'uploaded image reaches the actual result label');
  await open();
  await dialog.locator('input[type=file]').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('synthetic invalid image') });
  await dialog.locator('.wt-label-editor .wt-status[data-error=true]').waitFor({ state: 'visible' });
  check(await dialog.getByRole('button', { name: '选择本地图片', exact: true }).getAttribute('aria-pressed') === 'true', 'failed image keeps the previously chosen background');
  await dialog.getByRole('button', { name: '无背景图', exact: true }).click();
  check(await dialog.locator('.wt-label-editor .wt-status').textContent() === '', 'choosing another background clears the previous image error');
  await save();
  check(!Object.hasOwn((await labels()).styles['工作'], 'image'), 'removing an image keeps the custom colors');
  await open(); await dialog.getByRole('button', { name: '恢复默认外观', exact: true }).click(); await save();
  check(!Object.hasOwn((await labels()).styles, '工作') && (await labels()).styles['阅读'].background === '#efe9f6', 'reset only changes the selected label');
  await open(); await dialog.getByLabel('我的标签', { exact: true }).fill('工作'); await save();
  check(!Object.hasOwn(await labels(), 'styles'), 'removed labels do not leave orphan styles');
  await open(); await dialog.getByLabel('我的标签', { exact: true }).fill('工作\n阅读资料与长标签的显示效果');
  await dialog.getByRole('button', { name: '晴空蓝', exact: true }).click();
  await dialog.getByRole('button', { name: '远山', exact: true }).click();
  await page.setViewportSize({ width: 360, height: 800 }); await capture('02-labels-narrow');
  await dialog.getByRole('button', { name: '选择本地图片', exact: true }).scrollIntoViewIfNeeded();
  const uploadPosition = await dialog.getByRole('button', { name: '选择本地图片', exact: true }).evaluate(element => {
    const bounds = element.getBoundingClientRect(), dialog = element.closest('dialog');
    return { top: bounds.top, bottom: bounds.bottom, dialogTop: dialog.getBoundingClientRect().top, footerTop: dialog.querySelector('footer').getBoundingClientRect().top };
  });
  check(uploadPosition.top >= uploadPosition.dialogTop && uploadPosition.bottom <= uploadPosition.footerTop,
    `narrow window can scroll to the image chooser above the sticky actions: ${JSON.stringify(uploadPosition)}`);
  await capture('02-labels-narrow-bottom');
  await dialog.evaluate(element => { element.scrollTop = 0; });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('history-sweep:set-theme', { detail: 'dark' })));
  await capture('03-labels-narrow-dark'); await save();
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await page.getByRole('button', { name: 'Edit website labels · reading.example', exact: true }).click();
  await capture('04-labels-english-dark');
  check(await dialog.getByLabel('Text color', { exact: true }).count() === 1, 'English appearance controls have accessible names');
  await page.keyboard.press('Escape');
  check(await page.getByRole('button', { name: 'Edit website labels · reading.example', exact: true }).evaluate(element => document.activeElement === element), 'Escape returns focus to the label editor trigger');
  check(errors.length === 0, 'no browser page errors');
  console.log(JSON.stringify({ checks, screenshots }, null, 2));
} finally {
  await context.close(); await rm(profile, { recursive: true, force: true });
}
