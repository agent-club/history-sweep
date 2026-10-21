import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  assert.equal(await page.locator('a[href="sync.html"]').count(), 1, 'the v0.5.0 package includes configuration sync');
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
      else {
        const lang = language === 'en' ? 'en' : 'zh';
        const website = await sharp(image).flatten({ background: '#fcfcfc' }).removeAlpha().png().toBuffer();
        await writeFile(output + `screenshot-workspace-${lang}-1280x800.png`, website);
        await writeFile(root + `site/assets/candidate-manager-website-${lang}.png`, website);
        await page.locator('#groupByFrequency').click(); await ready(page);
        assert.equal(await page.locator('#rows .history-row').count(), 12);
        const frequency = await sharp(await page.screenshot()).flatten({ background: '#fcfcfc' }).removeAlpha().png().toBuffer();
        await writeFile(output + `screenshot-frequency-${lang}-1280x800.png`, frequency);
        await writeFile(root + `site/assets/candidate-manager-frequency-${lang}.png`, frequency);
        const sync = await context.newPage();
        await sync.goto(`${origin}/sync.html`);
        await sync.waitForFunction(() => document.querySelector('#connectionFields') && !document.querySelector('#connectionFields').disabled);
        assert.equal(await sync.locator('#davUrl').inputValue(), '');
        assert.equal(await sync.locator('#davPassword').inputValue(), '');
        const settings = await sharp(await sync.screenshot()).flatten({ background: '#fcfcfc' }).removeAlpha().png().toBuffer();
        await writeFile(output + `screenshot-sync-${lang}-1280x800.png`, settings);
        await writeFile(root + `site/assets/candidate-manager-sync-${lang}.png`, settings);
        await sync.close();
      }
    }
  }
  const ribbon = (await readFile(root + 'site/assets/hero-ribbon.webp')).toString('base64');
  const mark = (await readFile(root + 'site/assets/product-mark.png')).toString('base64');
  const artwork = `<img class="art" src="data:image/webp;base64,${ribbon}" alt="">`;
  const brand = `<div class="brand"><img src="data:image/png;base64,${mark}" alt="">History Sweep</div>`;
  // Render store artwork separately from the product page: the embedded popup
  // remains an unmodified capture of the release ZIP, while the frame matches the site.
  const artworkPage = await context.newPage();
  for (const [name, width, height, body, styles] of [
    ['screenshot-popup-1280x800.png', 1280, 800,
      `${artwork}${brand}<main><h1>Your history.<br>Your call.</h1><p class="lead">Find. Review. Sweep.</p><p>Keep the pages that matter.<br>Clear the ones you choose.</p></main><img class="popup" src="data:image/png;base64,${popup.toString('base64')}" alt="Actual toolbar popup"><footer>Actual extension · Illustrative browsing data</footer>`,
      `.brand{left:76px;top:66px;font-size:25px;gap:13px}.brand img{width:35px;height:35px}main{left:76px;top:238px}h1{font-size:76px;line-height:1.04;letter-spacing:-4px}.lead{font-size:25px;margin-top:38px;color:#f0f1f2}p{font-size:20px;line-height:1.6;margin:15px 0 0;color:#b6bdc3}.popup{position:absolute;left:764px;top:88px;width:440px;height:590px;border:1px solid #454a4f;border-radius:18px;box-shadow:0 24px 80px #0009}footer{position:absolute;left:76px;bottom:38px;color:#9aa2aa;font-size:13px}.art{opacity:.58}`],
    ['promo-small-440x280.png', 440, 280,
      `${artwork}${brand}<main><h1>Make room for<br>your next search.</h1></main><footer>YOUR HISTORY. YOUR CALL.</footer>`,
      `.brand{left:28px;top:25px;font-size:16px;gap:9px}.brand img{width:24px;height:24px}main{left:28px;top:83px}h1{font-size:37px;line-height:1.12;letter-spacing:-1.7px}footer{position:absolute;left:29px;bottom:27px;font-size:10px;letter-spacing:1.3px;color:#d3d8dd}.art{opacity:.55}`],
    ['promo-marquee-1400x560.png', 1400, 560,
      `${artwork}${brand}<main><h1>Make room for<br>your next search.</h1><p>Find. Review. Sweep. All on your device.</p></main>`,
      `.brand{left:76px;top:49px;font-size:25px;gap:13px}.brand img{width:35px;height:35px}main{left:76px;top:148px}h1{font-size:91px;line-height:1.03;letter-spacing:-4px}p{margin:37px 0 0;font-size:23px;color:#b6bdc3}.art{opacity:.72;object-position:center 28%}`],
  ]) {
    await artworkPage.setViewportSize({ width, height });
    await artworkPage.setContent(`<!doctype html><html><head><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#090b0d;color:#fafbfc;font-family:Arial,sans-serif}.art{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.brand{position:absolute;display:flex;align-items:center;font-weight:600;letter-spacing:-.5px}.brand img{object-fit:contain}main{position:absolute}h1{font-weight:500;margin:0}${styles}</style></head><body>${body}</body></html>`);
    await artworkPage.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    await artworkPage.evaluate(() => document.fonts.ready);
    await sharp(await artworkPage.screenshot()).flatten({ background: '#090b0d' }).removeAlpha().png().toFile(output + name);
  }
  await artworkPage.close();
  for (const name of ['screenshot-workspace-en', 'screenshot-workspace-zh', 'screenshot-popup']) {
    const metadata = await sharp(output + `${name}-1280x800.png`).metadata();
    assert.equal(metadata.width, 1280); assert.equal(metadata.height, 800); assert.equal(metadata.hasAlpha, false);
  }
  for (const [name, width, height] of [['promo-small-440x280.png', 440, 280], ['promo-marquee-1400x560.png', 1400, 560]]) {
    const metadata = await sharp(output + name).metadata();
    assert.equal(metadata.width, width); assert.equal(metadata.height, height); assert.equal(metadata.hasAlpha, false);
  }
  assert.deepEqual(errors, []);
  console.log(`Refreshed seven localized store screenshots, six website previews and both promotional tiles from the v${version} ZIP, using an isolated browser and 12 synthetic pages. Choose at most five screenshots per store language.`);
} finally { await context?.close(); await rm(temporary, { recursive: true, force: true }); }
