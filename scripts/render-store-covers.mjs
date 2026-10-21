import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { chromium } = dependency('playwright');
const sharp = dependency('sharp');
const image = async (path, type) => `data:image/${type};base64,${(await readFile(root + path)).toString('base64')}`;
const ribbon = await image('site/assets/hero-ribbon.webp', 'webp');
const mark = await image('extension/icons/mark-premium.svg', 'svg+xml');
const { version } = JSON.parse(await readFile(root + 'extension/manifest.json', 'utf8'));
const temporary = await mkdtemp(join(tmpdir(), 'history-sweep-cover-'));
const extension = join(temporary, 'extension');
await mkdir(extension);
execFileSync('unzip', ['-q', root + `dist/history-sweep-${version}.zip`, '-d', extension]);
let native;
const browser = await chromium.launch({ headless: true, ...(process.env.HISTORY_SWEEP_CHROME ? { executablePath: process.env.HISTORY_SWEEP_CHROME } : {}) });
try {
  native = await chromium.launchPersistentContext(join(temporary, 'profile'), {
    ...(process.env.HISTORY_SWEEP_CHROMIUM ? { executablePath: process.env.HISTORY_SWEEP_CHROMIUM } : { channel: 'chromium' }),
    headless: true, viewport: { width: 960, height: 600 }, deviceScaleFactor: 3,
    colorScheme: 'light', reducedMotion: 'reduce', timezoneId: 'Asia/Shanghai',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await native.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:' || url.protocol === 'data:') return route.continue();
    if (!url.hostname.endsWith('.example.test')) return route.abort();
    const title = decodeURIComponent(url.pathname.slice(1)).replaceAll('-', ' ');
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>${title}</title><p>Illustrative browsing data</p>` });
  });
  const worker = native.serviceWorkers()[0] || await native.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).hostname}`;
  const product = await native.newPage();
  for (const [host, titles] of [
    ['docs', ['Design-system-handbook', 'Component-library', 'Accessibility-checklist', 'Release-guide']],
    ['notes', ['Project-notes', 'Weekly-reading', 'Research-bookmarks', 'Ideas-to-keep']],
    ['reference', ['Browser-APIs', 'CSS-layout-guide', 'JavaScript-modules', 'Web-platform-notes']],
  ]) for (const title of titles) await product.goto(`https://${host}.example.test/${title}`);
  await mkdir(root + 'store/assets/', { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 3 });
  for (const [language, heading, description, privacy, note] of [
    ['en', 'Make room for<br>your next search.', 'Search, review and clear selected Chrome history.<br>Your history stays on your device.', 'No account · No analytics · History stays local', 'Actual extension · Illustrative browsing data'],
    ['zh', '为下一次探索，<br>扫出一片空间。', '找到、核对，再清理选中的浏览历史。<br>浏览记录始终留在本机。', '无需账号 · 无统计追踪 · 浏览历史留在本机', '真实插件界面 · 虚构演示数据'],
  ]) {
    await product.goto(`${origin}/manager.html`);
    await product.evaluate(language => { localStorage.setItem('language', language); localStorage.setItem('theme', 'light'); }, language === 'zh' ? 'zh-CN' : 'en');
    await product.reload();
    await product.waitForFunction(() => document.querySelector('#status')?.dataset.kind === 'scanned' && !document.querySelector('#search').disabled);
    await product.locator('#query').fill('example.test');
    await product.locator('#mode').selectOption('host-subdomains');
    await product.locator('#search').click();
    await product.waitForFunction(() => document.querySelector('#status')?.dataset.kind === 'scanned' && !document.querySelector('#search').disabled);
    assert.match(await product.locator('#count').textContent(), /^12 /);
    await product.locator('#selectAll').click();
    await product.locator('.row-select').first().uncheck();
    await product.evaluate(() => { document.activeElement?.blur(); return document.fonts.ready; });
    await product.mouse.move(0, 0);
    const workspace = `data:image/png;base64,${(await product.screenshot()).toString('base64')}`;
    // Compose a store cover around the native capture. Keep product pixels intact;
    // website navigation and nonfunctional install buttons do not belong here.
    await page.setContent(`<!doctype html><html lang="${language === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}html,body{width:1280px;height:800px;margin:0;overflow:hidden;background:#090b0d;color:#f5f5f3;font-family:Arial,"PingFang SC",sans-serif}
      .ribbon{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.58;object-position:center 58%}
      .shade{position:absolute;inset:0;background:linear-gradient(180deg,#090b0d90 0%,#090b0d40 62%,transparent 100%)}
      .brand{position:absolute;left:64px;top:58px;display:flex;gap:12px;align-items:center;font-size:25px;font-weight:700;letter-spacing:-.6px}.brand img{width:34px;height:34px;object-fit:contain}
      main{position:absolute;left:64px;top:229px;width:510px}h1{margin:0;font-size:67px;line-height:1.04;letter-spacing:-3px;font-weight:700}p{margin:29px 0 0;max-width:480px;font-size:21px;line-height:1.55;color:#c5c9cc}
      .product{position:absolute;left:590px;top:180px;width:650px;height:406.25px;transform:rotate(-2deg);transform-origin:center;border:2px solid #777b7d;border-radius:16px;overflow:hidden;box-shadow:0 30px 100px #000a;background:#fcfcfc}.product img{display:block;width:100%;height:100%}
      .privacy{position:absolute;left:65px;bottom:109px;font-size:14px;letter-spacing:.1px;color:#c8ccce}.note{position:absolute;left:65px;bottom:43px;font-size:12px;letter-spacing:.25px;color:#90999f}
      html[lang=zh-CN] h1{font-size:57px;line-height:1.16;letter-spacing:-1.5px}html[lang=zh-CN] p{font-size:20px;line-height:1.7}
    </style></head><body><img class="ribbon" src="${ribbon}" alt=""><div class="shade"></div><div class="brand"><img src="${mark}" alt="">History Sweep</div><main><h1>${heading}</h1><p>${description}</p></main><div class="product"><img src="${workspace}" alt="History Sweep v0.5.0"></div><div class="privacy">${privacy}</div><div class="note">${note}</div></body></html>`);
    await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('main').evaluate(node => node.scrollWidth <= node.clientWidth), true, 'cover copy fits');
    const master = await sharp(await page.screenshot()).flatten({ background: '#090b0d' }).removeAlpha().png().toBuffer();
    await sharp(master).toFile(root + `store/assets/screenshot-cover-${language}-3840x2400.png`);
    const output = root + `store/assets/screenshot-cover-${language}-1280x800.png`;
    await sharp(master).resize(1280, 800, { kernel: 'lanczos3' }).png().toFile(output);
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.width, 1280); assert.equal(metadata.height, 800); assert.equal(metadata.hasAlpha, false);
  }
  console.log('Rendered 3840x2400 cover masters and 1280x800 store copies from native 3x captures of the final ZIP.');
} finally { await native?.close(); await browser.close(); await rm(temporary, { recursive: true, force: true }); }
