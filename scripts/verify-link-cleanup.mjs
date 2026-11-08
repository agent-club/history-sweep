import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { enterWorkspace } from './native-workspace.mjs';

const { chromium } = dependency('playwright');
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const executable = args.get('--browser') || process.env.HISTORY_SWEEP_CHROMIUM;
const manualOnly = args.get('--manual-only') === 'true';
const host = 'reading.example', subHost = `sub.${host}`;
const workspaceKey = 'workspaceTools', automaticKey = 'linkCleanupAutomatic';
const tempRoot = await mkdtemp(join(tmpdir(), 'history-sweep-link-cleanup-'));
const artifacts = await mkdtemp(join(tmpdir(), 'history-sweep-link-cleanup-artifacts-'));
const profile = join(tempRoot, 'profile'), extension = join(tempRoot, 'extension');
const cert = join(tempRoot, 'fixture-cert.pem'), key = join(tempRoot, 'fixture-key.pem');
const sourceExtension = fileURLToPath(new URL('../extension/', import.meta.url));
const screenshots = [], checks = [];
const requests = [];
const errors = [];
const manualDiagnostics = {};
let context, page, worker, server, stage = 'setup', browserVersion = 'unknown';
const check = (condition, message) => { assert.ok(condition, message); checks.push(message); };
const waitFor = async (read, message, timeout = 12000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for: ${message}`);
};
const capture = async (name, target = page.locator('#linkCleanupSettingsContent')) => {
  const path = join(artifacts, `${name}.png`);
  await target.screenshot({ path, animations: 'disabled' });
  screenshots.push(path);
};
const storage = async keys => worker.evaluate(keys => chrome.storage.local.get(keys), keys);
const navigate = async url => {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.locator('body').waitFor({ state: 'visible', timeout: 8000 });
  return page.url();
};
const installedRules = () => worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
const visits = url => worker.evaluate(url => chrome.history.getVisits({ url }), url);
const openPreferences = async section => {
  await page.locator('#openPreferences').click();
  await page.locator('[data-settings-section="links"]').click();
  await page.locator('#link-cleanup-add').waitFor({ state: 'visible' });
  if (section === 'list') await waitFor(async () => page.locator('#link-cleanup-add').isEnabled(), 'link settings list ready');
};
const openSavedRule = async () => {
  await page.locator('.link-rule-row button').first().click();
  await page.locator('#link-cleanup-save').waitFor({ state: 'visible' });
};
const closeLinkEditor = () => page.locator('#link-cleanup-editor .auto-footer-actions').last().locator('button').nth(1).click();
const checkNavigation = async (input, expectedFinal, expectedRequest, message) => {
  const previous = requests.length;
  const final = await navigate(input);
  const observed = requests.slice(previous).findLast(request => request.method === 'GET' && request.path === new URL(expectedRequest).pathname);
  check(final === expectedFinal, `${message}: final address ${final}`);
  check(Boolean(observed), `${message}: local TLS server received ${expectedRequest}`);
  check(observed.host === new URL(expectedRequest).host, `${message}: request reached the intended fixture host`);
  check(observed.url === new URL(expectedRequest).pathname + new URL(expectedRequest).search,
    `${message}: server observed exact query bytes ${observed.url}`);
};
const searchFor = async (targetPage, query) => {
  await targetPage.locator('#query').fill(query);
  await targetPage.locator('#query').press('Escape');
  await targetPage.locator('#search').click();
  await targetPage.waitForFunction(() => !document.querySelector('#search').disabled);
};
const openCleanedFromSelectedHistory = async ({ targetPage, extensionOrigin, scenario, url, expected, background }) => {
  await targetPage.goto(`${extensionOrigin}/${scenario === 'popup' ? 'popup' : 'manager'}.html`);
  await enterWorkspace(targetPage);
  await targetPage.bringToFront();
  manualDiagnostics[`${scenario}SenderUrl`] = targetPage.url();
  await searchFor(targetPage, host);
  manualDiagnostics[`${scenario}Search`] = {
    query: await targetPage.locator('#query').inputValue(),
    status: await targetPage.locator('#status').textContent().catch(() => ''),
    rows: await targetPage.locator('.history-row').allInnerTexts(),
    history: await worker.evaluate(query => chrome.history.search({ text: query, startTime: 0, maxResults: 20 }), host)
  };
  const row = targetPage.locator('.history-row').filter({
    has: targetPage.locator(`.row-select[data-url=${JSON.stringify(url)}]`)
  });
  await waitFor(async () => await row.count() === 1, `${scenario}: synthetic history row appears exactly once`);
  await row.locator('.row-select').check();
  check(await row.locator('.row-select').isChecked(), `${scenario}: row is explicitly selected before link action`);
  await row.locator('.wt-row-more').click();
  await targetPage.getByRole('button', { name: '净化链接', exact: true }).click();
  const dialog = targetPage.locator('#workspaceDialog');
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByLabel('要移除的参数名', { exact: true }).fill('utm_source');
  await waitFor(async () => await dialog.getByLabel('净化后', { exact: true }).inputValue() === expected,
    `${scenario}: cleaned URL preview matches synthetic expected value`);
  const previousRequests = requests.length;
  await dialog.getByRole('button', { name: '打开净化链接', exact: true }).click();
  await waitFor(async () => requests.slice(previousRequests).some(request => request.url === new URL(expected).pathname + new URL(expected).search),
    `${scenario}: opened cleaned URL reached local TLS server`);
  await waitFor(async () => (await worker.evaluate(() => chrome.tabs.query({}))).some(tab => tab.url === expected),
    `${scenario}: new Chrome tab has cleaned URL`);
  const tabs = await worker.evaluate(() => chrome.tabs.query({}));
  const opened = tabs.find(tab => tab.url === expected);
  check(opened?.url === expected, `${scenario}: Chrome tab URL is the cleaned URL`);
  check(opened?.active === !background, `${scenario}: Chrome tab active state is ${background ? 'background' : 'foreground'}`);
  check(await row.locator('.row-select').isChecked(), `${scenario}: source page selection remains checked after open`);
  const feedback = await dialog.locator('#workspaceDialogStatus').textContent();
  check(background ? feedback.includes('后台标签页') : feedback.includes('已在新标签页打开'),
    `${scenario}: UI feedback reflects the background response`);
  await dialog.locator('.wt-close').click();
};

try {
  stage = 'fixture';
  await cp(sourceExtension, extension, { recursive: true });
  const manifestPath = join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), `https://${host}/*`])];
  // The installed product retains optional host access; this fixture grants one exact host only to avoid a native browser permission dialog.
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host},DNS:${subHost}`], { stdio: 'ignore', timeout: 15000 });
  server = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ method: request.method, path: request.url.split('?')[0], url: request.url,
        host: request.headers.host, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end('<!doctype html><meta charset="utf-8"><title>Synthetic reading page</title><form id="post" method="post"></form><p>Fixture only</p>');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;

  stage = 'browser-start';
  context = await chromium.launchPersistentContext(profile, {
    ...(executable ? { executablePath: executable } : { channel: 'chromium' }),
    headless: true, viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce',
    ignoreHTTPSErrors: true,
    args: [
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      `--host-resolver-rules=MAP ${host} 127.0.0.1, MAP ${subHost} 127.0.0.1, EXCLUDE localhost, MAP * ~NOTFOUND`,
      '--ignore-certificate-errors', '--disable-background-networking'
    ]
  });
  context.setDefaultTimeout(8000);
  context.setDefaultNavigationTimeout(15000);
  context.on('page', current => current.on('pageerror', error => errors.push(error.message)));
  // All external HTTP(S) traffic is blocked. The two reserved .example fixture hosts continue to the local TLS server.
  await context.route(/^https?:\/\/(?!(?:reading\.example|sub\.reading\.example)(?::\d+)?(?:[/?#]|$))/i,
    route => route.abort('blockedbyclient'));
  worker = context.serviceWorkers().find(item => item.url().endsWith('/background.mjs')) || await context.waitForEvent('serviceworker');
  browserVersion = context.browser()?.version() || 'unknown';
  const extensionId = new URL(worker.url()).host;
  const origin = `chrome-extension://${extensionId}`;
  check(manifest.host_permissions.includes(`https://${host}/*`), 'isolated fixture alone has exact site host permission');
  check(manifest.optional_host_permissions.includes('https://*/*'), 'product optional host access remains in fixture manifest');
  check(!JSON.parse(await readFile(join(sourceExtension, 'manifest.json'), 'utf8')).host_permissions?.includes(`https://${host}/*`),
    'product manifest remains optional-host only');

  stage = 'workspace-entry';
  page = await context.newPage();
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => { localStorage.setItem('language', 'zh-CN'); localStorage.setItem('theme', 'light'); });
  await page.goto(`${origin}/manager.html`);
  await enterWorkspace(page);
  await page.locator('#openPreferences').waitFor({ state: 'visible' });
  if (manualOnly) {
    stage = 'manual-open-manager';
    const managerUrl = `https://${host}:${port}/manual-manager?utm_source=synthetic&keep=%20+%2f#manager-fragment`;
    const managerExpected = `https://${host}:${port}/manual-manager?keep=%20+%2f#manager-fragment`;
    const managerSeed = await context.newPage();
    await managerSeed.goto(managerUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await managerSeed.close();
    manualDiagnostics.managerVisits = await visits(managerUrl);
    await openCleanedFromSelectedHistory({ targetPage: page, extensionOrigin: origin, scenario: 'manager', url: managerUrl,
      expected: managerExpected, background: false });

    stage = 'manual-open-popup-page';
    const popupUrl = `https://${host}:${port}/manual-popup?utm_source=synthetic&keep=%20+%2f#popup-fragment`;
    const popupExpected = `https://${host}:${port}/manual-popup?keep=%20+%2f#popup-fragment`;
    const popupSeed = await context.newPage();
    await popupSeed.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await popupSeed.close();
    const popupPage = await context.newPage();
    await popupPage.addInitScript(() => { localStorage.setItem('language', 'zh-CN'); localStorage.setItem('theme', 'light'); });
    await openCleanedFromSelectedHistory({ targetPage: popupPage, extensionOrigin: origin, scenario: 'popup', url: popupUrl,
      expected: popupExpected, background: true });
  } else {
  await openPreferences('list');
  check(await page.locator('#linkCleanupSettingsContent').isVisible(), 'preferences opens the links settings section');
  check((await page.locator('#link-cleanup-add').textContent()).trim().length > 0, 'add-rule control uses rendered localized copy');

  stage = 'rule-create-and-preview';
  await page.locator('#link-cleanup-add').click();
  await page.locator('#link-cleanup-hostname').fill(host);
  await page.locator('#link-cleanup-parameters').fill('utm_source\nutm_campaign');
  await page.locator('#link-cleanup-preserve').fill('ref');
  await page.locator('#link-cleanup-paths').fill('/checkout');
  const previewInput = `https://${host}/article?q=%20+%2f&utm_source=one&ref=keep&utm_campaign=two#section`;
  await page.locator('#link-cleanup-sample').fill(previewInput);
  const expectedPreview = `https://${host}/article?q=%20+%2f&ref=keep#section`;
  await waitFor(async () => (await page.locator('#link-cleanup-preview-url').textContent()) === expectedPreview,
    'preview preserves untouched raw query bytes and fragment');
  check(await page.locator('#link-cleanup-preview-note').textContent().then(text => text.length > 0), 'preview reports its current result');
  await page.locator('#link-cleanup-sample').fill(`https://${host}/checkout/order?utm_source=one`);
  await waitFor(async () => (await page.locator('#link-cleanup-preview-url').textContent()).includes('/checkout/order?utm_source=one'), 'path exception preview');
  check((await page.locator('#link-cleanup-preview-note').textContent()).length > 0, 'path exception preview has an explanatory note');
  await page.locator('#link-cleanup-sample').fill(`https://${host}/checkout-v2?utm_source=one`);
  await waitFor(async () => (await page.locator('#link-cleanup-preview-url').textContent()).endsWith('/checkout-v2'), 'path segment boundary preview');
  check(!(await page.locator('#link-cleanup-preview-url').textContent()).includes('utm_source'), 'checkout-v2 remains outside the /checkout exception');
  await page.locator('#link-cleanup-save').click();
  await waitFor(async () => (await storage([workspaceKey]))[workspaceKey]?.linkRules?.length === 1, 'saved rule persisted');
  let saved = (await storage([workspaceKey]))[workspaceKey].linkRules[0];
  check(saved.hostname === host && saved.enabled === true, 'saved rule stores the requested exact hostname and enabled state');
  check(JSON.stringify(saved.parameters) === JSON.stringify(['utm_source', 'utm_campaign']), 'saved removal names round-trip');
  check(JSON.stringify(saved.preserveParameters) === JSON.stringify(['ref']) && JSON.stringify(saved.excludedPaths) === JSON.stringify(['/checkout']),
    'saved parameter and path exceptions round-trip');
  await closeLinkEditor();
  await page.locator('#link-cleanup-add').waitFor({ state: 'visible' });
  await capture('link-rules-list');

  stage = 'reload-persistence';
  await page.reload();
  await enterWorkspace(page);
  await openPreferences('list');
  saved = (await storage([workspaceKey]))[workspaceKey].linkRules[0];
  check(saved.hostname === host && saved.preserveParameters[0] === 'ref' && saved.excludedPaths[0] === '/checkout', 'saved rule survives extension-page reload');

  stage = 'discard-and-duplicate';
  await page.locator('#link-cleanup-add').click();
  await page.locator('#link-cleanup-hostname').fill('discard.example');
  await page.locator('#link-cleanup-parameters').fill('utm_source');
  await closeLinkEditor();
  await page.locator('#link-cleanup-confirm').waitFor({ state: 'visible' });
  const confirmButtons = page.locator('#link-cleanup-confirm .dialog-actions button');
  await confirmButtons.first().click();
  await page.locator('#link-cleanup-confirm').waitFor({ state: 'hidden' });
  check(await page.locator('#link-cleanup-hostname').inputValue() === 'discard.example', 'canceling discard keeps the dirty draft');
  await closeLinkEditor();
  await page.locator('#link-cleanup-confirm').waitFor({ state: 'visible' });
  await page.locator('#link-cleanup-confirm .dialog-actions button').last().click();
  await page.locator('#link-cleanup-add').waitFor({ state: 'visible' });
  check((await storage([workspaceKey]))[workspaceKey].linkRules.length === 1, 'discarding dirty draft leaves saved rules unchanged');
  await page.locator('#link-cleanup-add').click();
  await page.locator('#link-cleanup-hostname').fill(host);
  await page.locator('#link-cleanup-parameters').fill('utm_source');
  await waitFor(async () => await page.locator('#link-cleanup-save').isDisabled(), 'duplicate host disables save');
  check((await page.locator('#link-cleanup-error').textContent()).length > 0, 'duplicate host shows a validation message');
  await closeLinkEditor();
  await page.locator('#link-cleanup-confirm .dialog-actions button').last().click();
  await page.locator('#link-cleanup-add').waitFor({ state: 'visible' });

  stage = 'screenshots';
  await openSavedRule();
  check(await page.locator('#link-cleanup-paths').inputValue() === '/checkout', 'editor reopens saved exception fields');
  await capture('link-rule-editor-exceptions');
  await closeLinkEditor();
  await page.locator('#link-cleanup-add').waitFor({ state: 'visible' });
  for (const width of [320, 360]) {
    await page.setViewportSize({ width, height: 850 });
    const layout = await page.evaluate(() => {
      const heading = document.querySelector('#link-cleanup-list .auto-section-heading');
      const title = heading?.querySelector('h1');
      const titleBlock = title?.parentElement;
      const button = heading?.querySelector('#link-cleanup-add');
      if (!heading || !title || !titleBlock || !button) return null;
      const rect = element => {
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
      };
      const titleBox = rect(titleBlock), buttonBox = rect(button);
      const text = document.createRange(); text.selectNodeContents(title);
      const lines = [...text.getClientRects()].filter(box => box.width > 0 && box.height > 0).length;
      const overlaps = titleBox.left < buttonBox.right && titleBox.right > buttonBox.left &&
        titleBox.top < buttonBox.bottom && titleBox.bottom > buttonBox.top;
      return { titleBox, buttonBox, lines, overlaps };
    });
    assert.ok(layout, `${width}px: heading geometry is measurable`);
    check(!layout.overlaps, `${width}px: add button does not overlap the title block`);
    check(layout.titleBox.width >= 100 || layout.lines <= 2,
      `${width}px: title keeps at least 100px or wraps to at most two lines (width=${layout.titleBox.width}, lines=${layout.lines})`);
    await capture(`link-rules-narrow-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  stage = 'explicit-automatic-enable';
  await openSavedRule();
  check(await page.locator('#link-cleanup-enable-auto').isVisible(), 'automatic enable action is available for a saved enabled rule');
  // This test fixture adds a single required host permission to avoid the native permission dialog; the packaged product still declares optional host access.
  await page.locator('#link-cleanup-enable-auto').click();
  await waitFor(async () => (await storage([automaticKey]))[automaticKey]?.hosts?.includes(host), 'explicit automatic authorization persisted');
  await waitFor(async () => (await installedRules()).some(rule => rule.action.type === 'redirect' && rule.condition.requestDomains?.includes(host)),
    'real extension worker installed DNR redirect rule');
  let installed = await installedRules();
  check(installed.some(rule => rule.condition.requestMethods?.includes('get') && rule.condition.resourceTypes?.includes('main_frame')),
    'installed DNR rule is constrained to GET top-level navigation');
  await closeLinkEditor();
  await page.locator('#link-cleanup-pause').waitFor({ state: 'visible' });

  stage = 'synthetic-history-baseline';
  const priorHistoryUrl = `https://${host}/existing-history?utm_source=stored`;
  await worker.evaluate(url => chrome.history.addUrl({ url }), priorHistoryUrl);
  const priorVisits = await visits(priorHistoryUrl);
  check(priorVisits.length === 1, 'synthetic baseline history visit is present before network checks');

  stage = 'network-cleanup';
  const cleanQuery = 'utm_source=one&utm_source=&utm_campaign=&ref=keep&space=%20&plus=+&slash=%2f';
  const cleanInputWithoutFragment = `https://${host}:${port}/clean?${cleanQuery}`;
  const cleanExpectedWithoutFragment = `https://${host}:${port}/clean?ref=keep&space=%20&plus=+&slash=%2f`;
  await checkNavigation(cleanInputWithoutFragment, cleanExpectedWithoutFragment, cleanExpectedWithoutFragment,
    'fragment-free GET strips duplicate/empty targets and preserves untouched encoded values');
  const cleanInput = `${cleanInputWithoutFragment}#section`;
  const cleanExpected = `${cleanExpectedWithoutFragment}#section`;
  await checkNavigation(cleanInput, cleanExpected, cleanExpected, 'fragment GET strips targets and preserves fragment plus untouched encoded values');
  const encodedInput = `https://${host}:${port}/encoded?utm%5Fsource=one&utm_source=two#frag`;
  await checkNavigation(encodedInput, encodedInput, encodedInput, 'encoded parameter key skips the entire navigation');
  const checkout = `https://${host}:${port}/checkout?utm_source=one`;
  await checkNavigation(checkout, checkout, checkout, 'excluded exact path is unchanged');
  const checkoutChild = `https://${host}:${port}/checkout/order?utm_source=one`;
  await checkNavigation(checkoutChild, checkoutChild, checkoutChild, 'excluded child path is unchanged');
  const checkoutSibling = `https://${host}:${port}/checkout-v2?utm_source=one`;
  await checkNavigation(checkoutSibling, `https://${host}:${port}/checkout-v2`, `https://${host}:${port}/checkout-v2`, 'segment sibling is cleaned');
  const queryValue = `https://${host}:${port}/article?note=%2Fcheckout&utm_source=one`;
  await checkNavigation(queryValue, `https://${host}:${port}/article?note=%2Fcheckout`, `https://${host}:${port}/article?note=%2Fcheckout`, 'query value resembling excluded path does not exclude');
  const subUrl = `https://${subHost}:${port}/subdomain?utm_source=one`;
  await checkNavigation(subUrl, subUrl, subUrl, 'subdomain is outside exact-host rule');
  const requestCount = requests.length;
  const fetchResult = await page.evaluate(async () => (await fetch('/fetch?utm_source=one')).status);
  check(fetchResult === 200, 'same-origin fetch subrequest receives local server response');
  const fetchRequest = requests.slice(requestCount).findLast(request => request.path === '/fetch');
  check(fetchRequest?.url === '/fetch?utm_source=one', 'fetch subrequest is not rewritten');
  const postTarget = `https://${host}:${port}/post?utm_source=one`;
  const postNavigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.evaluate(url => {
    const form = document.createElement('form'); form.method = 'POST'; form.action = url; document.body.append(form); form.submit();
  }, postTarget);
  await postNavigation;
  check(page.url() === postTarget, 'top-level POST keeps its query unchanged');
  check(requests.findLast(request => request.path === '/post')?.method === 'POST', 'local server observed top-level POST');
  check((await visits(priorHistoryUrl)).length === priorVisits.length, 'automatic cleanup leaves prior synthetic history intact');

  stage = 'pause-disable';
  await page.goto(`${origin}/manager.html`);
  await enterWorkspace(page);
  await openPreferences('list');
  await page.locator('#link-cleanup-pause').check();
  await waitFor(async () => !(await installedRules()).some(rule => rule.action.type === 'redirect'), 'pause removes DNR rules');
  const pausedUrl = `https://${host}:${port}/paused?utm_source=one`;
  await checkNavigation(pausedUrl, pausedUrl, pausedUrl, 'global pause stops automatic rewriting');
  await page.goto(`${origin}/manager.html`);
  await enterWorkspace(page);
  await openPreferences('list');
  await page.locator('#link-cleanup-pause').uncheck();
  await waitFor(async () => (await installedRules()).some(rule => rule.action.type === 'redirect'), 'resume reinstalls authorized rule');
  let toggle = page.locator('.link-rule-row input[type=checkbox]');
  await toggle.uncheck();
  await waitFor(async () => !(await installedRules()).some(rule => rule.action.type === 'redirect'), 'disabling rule removes DNR rules');
  const disabledUrl = `https://${host}:${port}/disabled?utm_source=one`;
  await checkNavigation(disabledUrl, disabledUrl, disabledUrl, 'disabled rule leaves navigation unchanged');
  await page.goto(`${origin}/manager.html`);
  await enterWorkspace(page);
  await openPreferences('list');
  toggle = page.locator('.link-rule-row input[type=checkbox]');
  await toggle.check();
  await waitFor(async () => !(await installedRules()).some(rule => rule.action.type === 'redirect'), 'reenabling a rule does not silently restore canceled automatic intent');

  stage = 'english-dark-popup-screenshot';
  const popup = await context.newPage();
  await popup.addInitScript(() => { localStorage.setItem('language', 'en'); localStorage.setItem('theme', 'dark'); });
  await popup.setViewportSize({ width: 440, height: 700 });
  await popup.goto(`${origin}/popup.html`);
  await enterWorkspace(popup);
  await popup.locator('#openPreferences').click();
  await popup.locator('[data-settings-section="links"]').click();
  await popup.locator('#link-cleanup-add').waitFor({ state: 'visible' });
  await capture('link-cleanup-popup-english-dark', popup.locator('#linkCleanupSettingsContent'));
  check(await popup.locator('#linkCleanupSettingsContent').isVisible(), 'English dark popup reaches the link-cleanup target region');

  stage = 'remove-rule';
  await page.goto(`${origin}/manager.html`);
  await enterWorkspace(page);
  await openPreferences('list');
  await openSavedRule();
  await page.locator('#link-cleanup-remove').click();
  await page.locator('#link-cleanup-confirm').waitFor({ state: 'visible' });
  await page.locator('#link-cleanup-confirm .dialog-actions button').last().click();
  await page.locator('#link-cleanup-add').waitFor({ state: 'visible' });
  await waitFor(async () => (await storage([workspaceKey]))[workspaceKey].linkRules.length === 0, 'confirmed delete removes saved rule');
  check((await installedRules()).every(rule => !rule.condition.requestDomains?.includes(host)), 'removing the rule leaves no owned DNR rule for its host');
  }

  stage = 'finish';
  const final = { status: 'passed', stage, checks: checks.length, browserVersion, artifacts, screenshots, failures: [],
    fixtureNote: 'The copied test manifest required only https://reading.example/* to bypass Chrome’s native permission dialog; the source manifest remained optional-host-only.' };
  await writeFile(join(artifacts, 'results.json'), JSON.stringify(final, null, 2) + '\n');
  console.log(JSON.stringify(final, null, 2));
} catch (error) {
  let diagnostic = null;
  if (worker) {
    try {
      diagnostic = {
        automatic: (await storage([automaticKey]))[automaticKey],
        permission: await worker.evaluate(host => chrome.permissions.contains({ origins: [`https://${host}/*`] }), host),
        dynamicRules: await installedRules(), requests: requests.slice(-12)
      };
    } catch (diagnosticError) { diagnostic = { error: diagnosticError?.message || String(diagnosticError) }; }
  }
  const result = { status: 'failed', stage, checks: checks.length, browserVersion, artifacts, screenshots,
    failure: { name: error?.name || 'Error', message: error?.message || String(error) }, errors, diagnostic, manualDiagnostics };
  await writeFile(join(artifacts, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.error(JSON.stringify(result, null, 2));
  throw error;
} finally {
  await context?.close().catch(() => {});
  if (server) {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
  await rm(tempRoot, { recursive: true, force: true });
}
