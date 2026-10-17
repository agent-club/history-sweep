import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(root + 'extension/manifest.json', 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'history-sweep-store-'));
const extension = join(temporary, 'extension');
const { chromium } = dependency('playwright');
const sharp = dependency('sharp');
let context;
const ready = page => page.waitForFunction(() => document.querySelector('#status')?.dataset.kind === 'scanned' && !document.querySelector('#search').disabled);
try {
  await mkdir(extension);
  execFileSync('unzip', ['-q', root + `dist/history-sweep-${version}.zip`, '-d', extension]);
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    ...(process.env.HISTORY_SWEEP_CHROMIUM ? { executablePath: process.env.HISTORY_SWEEP_CHROMIUM } : { channel: 'chromium' }),
    headless: true, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
    colorScheme: 'light', reducedMotion: 'reduce', timezoneId: 'Asia/Shanghai',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  // Serve synthetic pages in memory. No browsing data or website requests come from
  // the user's browser profile, and no test hostname is contacted on the network.
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:' || url.protocol === 'data:') return route.continue();
    if (url.hostname.endsWith('.example.test')) {
      const title = decodeURIComponent(url.pathname.slice(1)).replaceAll('-', ' ');
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>${title}</title><p>Illustrative browsing data</p>` });
    }
    return route.abort();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  for (const [host, titles] of [
    ['docs', ['Design-system-handbook', 'Component-library', 'Accessibility-checklist', 'Release-guide']],
    ['notes', ['Project-notes', 'Weekly-reading', 'Research-bookmarks', 'Ideas-to-keep']],
    ['reference', ['Browser-APIs', 'CSS-layout-guide', 'JavaScript-modules', 'Web-platform-notes']],
  ]) for (const title of titles) await page.goto(`https://${host}.example.test/${title}`);
  await page.goto(`${origin}/manager.html`); await ready(page);
  const saved = await page.evaluate(async () => chrome.history.search({ text: 'example.test', startTime: 0, maxResults: 100 }));
  assert.equal(saved.length, 12);
  assert.ok(saved.every(item => item.title && new URL(item.url).hostname.endsWith('.example.test')));
  assert.equal(await page.locator('a[href="sync.html"]').count(), 0, 'screenshots use the release scope');
  const output = root + 'store/assets/'; await mkdir(output, { recursive: true });
  let popup;
  for (const language of ['en', 'zh-CN']) {
    await page.evaluate(language => { localStorage.setItem('language', language); localStorage.setItem('theme', 'light'); }, language);
    for (const layout of language === 'en' ? ['manager', 'popup'] : ['manager']) {
      await page.setViewportSize(layout === 'popup' ? { width: 440, height: 590 } : { width: 1280, height: 800 });
      await page.goto(`${origin}/${layout}.html`); await ready(page);
      await page.locator('#query').fill('example.test');
      await page.locator('#mode').selectOption('host-subdomains');
      await page.locator('#search').click(); await ready(page);
      assert.match(await page.locator('#count').textContent(), /^12 /);
      if (layout === 'popup' || language === 'zh-CN') await page.locator('#groupBySite').click();
      await page.locator('#selectAll').click();
      await page.locator('.row-select').first().uncheck();
      await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(0, 0);
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const image = await page.screenshot();
      if (layout === 'popup') popup = image;
      else await sharp(image).flatten({ background: '#fcfcfc' }).removeAlpha().png()
        .toFile(output + `screenshot-workspace-${language === 'en' ? 'en' : 'zh'}-1280x800.png`);
    }
  }
  // Retain the existing store composition and replace only its actual popup image.
  const composition = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="100%" height="100%" fill="#f7f5ef"/><circle cx="990" cy="395" r="290" fill="#e7e9df"/><text x="70" y="145" fill="#b95332" font-family="sans-serif" font-size="17" letter-spacing="3">HISTORY SWEEP</text><text x="70" y="265" fill="#292e26" font-family="Georgia" font-size="74">A little less</text><text x="70" y="350" fill="#b95332" font-family="Georgia" font-style="italic" font-size="74">history.</text><text x="74" y="430" fill="#73766b" font-family="sans-serif" font-size="22">Find. Select all. Clear in batches.</text><text x="74" y="474" fill="#73766b" font-family="sans-serif" font-size="19">Right from your toolbar.</text><text x="74" y="730" fill="#73766b" font-family="sans-serif" font-size="13">Actual product interface · Illustrative browsing data</text></svg>`);
  await sharp(composition).composite([{ input: popup, left: 780, top: 86 }]).flatten({ background: '#f7f5ef' }).removeAlpha().png()
    .toFile(output + 'screenshot-popup-1280x800.png');
  for (const name of ['screenshot-workspace-en', 'screenshot-workspace-zh', 'screenshot-popup']) {
    const metadata = await sharp(output + `${name}-1280x800.png`).metadata();
    assert.equal(metadata.width, 1280); assert.equal(metadata.height, 800); assert.equal(metadata.hasAlpha, false);
  }
  assert.deepEqual(errors, []);
  console.log(`Refreshed three 1280×800 store screenshots from the v${version} ZIP, using an isolated browser and 12 synthetic pages.`);
} finally { await context?.close(); await rm(temporary, { recursive: true, force: true }); }
